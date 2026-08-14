//! Handle-relative materialization for local publication previews.
//!
//! The user-selected project can be modified concurrently (including with
//! Windows junctions).  Never resolve a validated path again: every descendant
//! is opened relative to an already verified directory handle.

use std::ffi::{c_void, OsStr};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::Path;

use windows::core::PWSTR;
use windows::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows::Wdk::Storage::FileSystem::{
    NtCreateFile, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN_IF,
    FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT,
};
use windows::Win32::Foundation::{HANDLE, OBJ_CASE_INSENSITIVE, UNICODE_STRING};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FileDispositionInfo, GetFileInformationByHandle, SetFileInformationByHandle,
    BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ATTRIBUTE_REPARSE_POINT, FILE_DISPOSITION_INFO,
    FILE_FLAGS_AND_ATTRIBUTES, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    OPEN_EXISTING,
};
use windows::Win32::System::IO::IO_STATUS_BLOCK;

const MAX_BACKUP_BYTES: u64 = 64 * 1024 * 1024;
const FILE_CREATED: usize = 2;

fn invalid(message: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidInput, message)
}

fn segments(relative: &str) -> std::io::Result<Vec<&str>> {
    if relative.is_empty() || relative.contains('\\') {
        return Err(invalid("unsafe preview path"));
    }
    let values = relative.split('/').collect::<Vec<_>>();
    if values
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == ".." || part.contains(':'))
    {
        return Err(invalid("unsafe preview path"));
    }
    Ok(values)
}

fn checked_not_reparse(handle: HANDLE) -> std::io::Result<BY_HANDLE_FILE_INFORMATION> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe {
        GetFileInformationByHandle(handle, &mut info)
            .map_err(|error| std::io::Error::other(error.message().to_string()))?;
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
        return Err(invalid("reparse point rejected"));
    }
    Ok(info)
}

fn checked_directory(handle: HANDLE) -> std::io::Result<()> {
    checked_not_reparse(handle).map(|_| ())
}

fn checked_file(handle: HANDLE) -> std::io::Result<()> {
    let info = checked_not_reparse(handle)?;
    if info.nNumberOfLinks != 1 {
        return Err(invalid("hard-linked preview file rejected"));
    }
    Ok(())
}

fn root_handle(root: &Path) -> std::io::Result<File> {
    let wide = root
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            windows::core::PCWSTR(wide.as_ptr()),
            FILE_GENERIC_READ.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            None,
        )
        .map_err(|error| std::io::Error::other(error.message().to_string()))?
    };
    checked_directory(handle)?;
    Ok(unsafe { File::from_raw_handle(handle.0) })
}

fn relative_open(
    parent: &File,
    name: &str,
    directory: bool,
    create: bool,
) -> std::io::Result<(File, bool)> {
    let mut wide = OsStr::new(name).encode_wide().collect::<Vec<_>>();
    let byte_len = wide
        .len()
        .checked_mul(2)
        .filter(|size| *size <= u16::MAX as usize)
        .ok_or_else(|| invalid("path segment too long"))?;
    let mut unicode = UNICODE_STRING {
        Length: byte_len as u16,
        MaximumLength: byte_len as u16,
        Buffer: PWSTR(wide.as_mut_ptr()),
    };
    let root = HANDLE(parent.as_raw_handle());
    let attributes = OBJECT_ATTRIBUTES {
        Length: std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: root,
        ObjectName: &mut unicode,
        Attributes: OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: std::ptr::null(),
        SecurityQualityOfService: std::ptr::null(),
    };
    let mut handle = HANDLE::default();
    let mut status = IO_STATUS_BLOCK::default();
    let access = windows::Win32::Storage::FileSystem::FILE_ACCESS_RIGHTS(
        FILE_GENERIC_READ.0 | FILE_GENERIC_WRITE.0 | DELETE.0,
    );
    let options = if directory {
        FILE_DIRECTORY_FILE
    } else {
        FILE_NON_DIRECTORY_FILE
    } | FILE_OPEN_REPARSE_POINT
        | FILE_SYNCHRONOUS_IO_NONALERT;
    let disposition = if create {
        FILE_OPEN_IF
    } else {
        windows::Wdk::Storage::FileSystem::FILE_OPEN
    };
    let result = unsafe {
        NtCreateFile(
            &mut handle,
            access,
            &attributes,
            &mut status,
            None,
            FILE_FLAGS_AND_ATTRIBUTES(0),
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            disposition,
            options,
            None,
            0,
        )
    };
    if result.0 < 0 {
        return Err(std::io::Error::other(format!(
            "NtCreateFile failed: 0x{:08x}",
            result.0 as u32
        )));
    }
    let created = status.Information == FILE_CREATED;
    let file = unsafe { File::from_raw_handle(handle.0) };
    if directory {
        checked_directory(handle)?;
    } else {
        checked_file(handle)?;
    }
    Ok((file, created))
}

fn directory_for(root: &File, segments: &[&str], create: bool) -> std::io::Result<File> {
    let mut current = root.try_clone()?;
    for segment in segments {
        current = relative_open(&current, segment, true, create)?.0;
    }
    Ok(current)
}

fn open_file(root: &File, relative: &str, create: bool) -> std::io::Result<(File, bool)> {
    let parts = segments(relative)?;
    let (name, parents) = parts
        .split_last()
        .ok_or_else(|| invalid("preview path missing filename"))?;
    let parent = directory_for(root, parents, create)?;
    relative_open(&parent, name, false, create)
}

fn copy_handle_to(root: &File, source: &mut File, backup_relative: &str) -> std::io::Result<()> {
    let mut backup = open_file(root, backup_relative, true)?.0;
    source.seek(SeekFrom::Start(0))?;
    backup.set_len(0)?;
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = source.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .ok_or_else(|| invalid("backup too large"))?;
        if total > MAX_BACKUP_BYTES {
            return Err(invalid("backup too large"));
        }
        backup.write_all(&buffer[..count])?;
    }
    backup.sync_all()
}

fn restore_from(root: &File, destination: &str, backup_relative: &str) -> std::io::Result<()> {
    let (mut destination_file, _) = open_file(root, destination, false)?;
    let (mut backup_file, _) = open_file(root, backup_relative, false)?;
    backup_file.seek(SeekFrom::Start(0))?;
    destination_file.set_len(0)?;
    std::io::copy(&mut backup_file, &mut destination_file)?;
    destination_file.sync_all()
}

/// Materializes an approved bundle without resolving descendant paths after
/// validation. Existing files are backed up under `.blogbot/backups/<hash>`.
pub fn materialize(
    root_path: &Path,
    files: &[(String, Vec<u8>)],
    backup_prefix: &str,
) -> std::io::Result<usize> {
    materialize_with_before_first(root_path, files, backup_prefix, || {})
}

/// Creates a brand-new restore root relative to a verified parent directory,
/// then writes every descendant through directory handles.  This is the
/// restore counterpart of `materialize`: no path is re-resolved after the
/// parent handle is trusted, so a junction swap cannot redirect restored data.
pub fn materialize_new_directory(
    parent_path: &Path,
    directory_name: &str,
    files: &[(String, Vec<u8>)],
) -> std::io::Result<usize> {
    let parent = root_handle(parent_path)?;
    if segments(directory_name)?.len() != 1 {
        return Err(invalid("restore target must be a single directory name"));
    }
    let (root, created) = relative_open(&parent, directory_name, true, true)?;
    if !created {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "restore target already exists",
        ));
    }
    let mut written = 0usize;
    for (relative, content) in files {
        let (mut destination, destination_created) = open_file(&root, relative, true)?;
        if !destination_created {
            return Err(invalid("restore output already exists"));
        }
        destination.write_all(content)?;
        destination.sync_all()?;
        written += 1;
    }
    Ok(written)
}

fn materialize_with_before_first<F: FnOnce()>(
    root_path: &Path,
    files: &[(String, Vec<u8>)],
    backup_prefix: &str,
    before_first: F,
) -> std::io::Result<usize> {
    let root = root_handle(root_path)?;
    before_first();
    let mut applied = Vec::<(String, Option<String>)>::new();
    for (relative, content) in files {
        let (mut destination, created) = match open_file(&root, relative, true) {
            Ok(value) => value,
            Err(error) => {
                rollback(&root, &applied);
                return Err(error);
            }
        };
        let backup = if created {
            None
        } else {
            let backup_relative = format!("{backup_prefix}/{relative}");
            if let Err(error) = copy_handle_to(&root, &mut destination, &backup_relative) {
                rollback(&root, &applied);
                return Err(error);
            }
            Some(backup_relative)
        };
        applied.push((relative.clone(), backup));
        let write = (|| {
            destination.set_len(0)?;
            destination.seek(SeekFrom::Start(0))?;
            destination.write_all(content)?;
            destination.sync_all()
        })();
        if let Err(error) = write {
            rollback(&root, &applied);
            return Err(error);
        }
    }
    Ok(applied.len())
}

fn rollback(root: &File, applied: &[(String, Option<String>)]) {
    for (relative, backup) in applied.iter().rev() {
        if let Some(backup) = backup {
            let _ = restore_from(root, relative, backup);
        } else if let Ok((file, _)) = open_file(root, relative, false) {
            let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
            let handle = HANDLE(file.as_raw_handle());
            // SAFETY: `file` remains open while the deletion disposition is
            // set, and it was opened relative to verified directory handles.
            let _ = unsafe {
                SetFileInformationByHandle(
                    handle,
                    FileDispositionInfo,
                    &disposition as *const FILE_DISPOSITION_INFO as *const c_void,
                    std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
                )
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn rejects_a_junction_replaced_after_the_root_handle_is_opened() {
        let nonce = format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root = std::env::temp_dir().join(format!("blogbot-secure-preview-root-{nonce}"));
        let external =
            std::env::temp_dir().join(format!("blogbot-secure-preview-external-{nonce}"));
        std::fs::create_dir_all(root.join("articles")).unwrap();
        std::fs::create_dir_all(&external).unwrap();
        let article_directory = root.join("articles");
        let external_clone = external.clone();

        let result = materialize_with_before_first(
            &root,
            &[(
                "articles/example.md".to_owned(),
                b"outside write forbidden".to_vec(),
            )],
            ".blogbot/backups/test",
            move || {
                std::fs::remove_dir_all(&article_directory).unwrap();
                let status = std::process::Command::new("cmd")
                    .args(["/C", "mklink", "/J"])
                    .arg(&article_directory)
                    .arg(&external_clone)
                    .status()
                    .unwrap();
                assert!(status.success(), "junction fixture must be available");
            },
        );

        assert!(result.is_err());
        assert!(!external.join("example.md").exists());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&external);
    }

    #[test]
    fn writes_a_nested_preview_and_preserves_the_prior_file_in_the_safe_backup_tree() {
        let nonce = format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root = std::env::temp_dir().join(format!("blogbot-secure-preview-normal-{nonce}"));
        std::fs::create_dir_all(root.join("articles")).unwrap();
        std::fs::write(root.join("articles/example.md"), b"old content").unwrap();

        let written = materialize(
            &root,
            &[("articles/example.md".to_owned(), b"new content".to_vec())],
            ".blogbot/backups/test",
        )
        .unwrap();

        assert_eq!(written, 1);
        assert_eq!(
            std::fs::read(root.join("articles/example.md")).unwrap(),
            b"new content"
        );
        assert_eq!(
            std::fs::read(root.join(".blogbot/backups/test/articles/example.md")).unwrap(),
            b"old content"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn restores_an_existing_file_when_a_later_bundle_entry_is_invalid() {
        let nonce = format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root = std::env::temp_dir().join(format!("blogbot-secure-preview-rollback-{nonce}"));
        std::fs::create_dir_all(root.join("articles")).unwrap();
        std::fs::write(root.join("articles/example.md"), b"old content").unwrap();

        let result = materialize(
            &root,
            &[
                ("articles/example.md".to_owned(), b"new content".to_vec()),
                ("articles".to_owned(), b"cannot replace directory".to_vec()),
            ],
            ".blogbot/backups/test",
        );

        assert!(result.is_err());
        assert_eq!(
            std::fs::read(root.join("articles/example.md")).unwrap(),
            b"old content"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_a_hard_link_destination_and_rolls_back_without_mutating_external_data() {
        let nonce = format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root = std::env::temp_dir().join(format!("blogbot-secure-preview-hard-link-{nonce}"));
        let external = std::env::temp_dir().join(format!(
            "blogbot-secure-preview-hard-link-external-{nonce}.md"
        ));
        std::fs::create_dir_all(root.join("articles")).unwrap();
        std::fs::write(root.join("articles/first.md"), b"first old content").unwrap();
        std::fs::write(&external, b"external content").unwrap();
        std::fs::hard_link(&external, root.join("articles/second.md")).unwrap();

        let result = materialize(
            &root,
            &[
                (
                    "articles/first.md".to_owned(),
                    b"first new content".to_vec(),
                ),
                (
                    "articles/second.md".to_owned(),
                    b"outside write forbidden".to_vec(),
                ),
            ],
            ".blogbot/backups/test",
        );

        assert!(result.is_err());
        assert_eq!(
            std::fs::read(root.join("articles/first.md")).unwrap(),
            b"first old content"
        );
        assert_eq!(std::fs::read(&external).unwrap(), b"external content");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_file(&external);
    }

    #[test]
    fn removes_a_new_preview_file_when_a_later_bundle_entry_is_invalid() {
        let nonce = format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root =
            std::env::temp_dir().join(format!("blogbot-secure-preview-new-rollback-{nonce}"));
        std::fs::create_dir_all(root.join("articles")).unwrap();

        let result = materialize(
            &root,
            &[
                ("articles/new.md".to_owned(), b"temporary content".to_vec()),
                ("articles".to_owned(), b"cannot replace directory".to_vec()),
            ],
            ".blogbot/backups/test",
        );

        assert!(result.is_err());
        assert!(!root.join("articles/new.md").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn restore_writer_creates_only_a_new_root_through_verified_parent_handles() {
        let nonce = format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let parent = std::env::temp_dir().join(format!("blogbot-secure-restore-{nonce}"));
        std::fs::create_dir_all(&parent).unwrap();
        let files = vec![("articles/example.md".to_owned(), b"restored".to_vec())];

        assert_eq!(
            materialize_new_directory(&parent, "restored", &files).unwrap(),
            1
        );
        assert_eq!(
            std::fs::read(parent.join("restored/articles/example.md")).unwrap(),
            b"restored"
        );
        assert!(materialize_new_directory(&parent, "restored", &files).is_err());
        assert!(materialize_new_directory(&parent, "../outside", &files).is_err());
        let _ = std::fs::remove_dir_all(&parent);
    }
}
