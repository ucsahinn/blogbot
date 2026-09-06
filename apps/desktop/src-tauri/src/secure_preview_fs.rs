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
use std::time::{SystemTime, UNIX_EPOCH};

use windows::core::PWSTR;
use windows::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows::Wdk::Storage::FileSystem::{
    FileRenameInformation, NtCreateFile, NtSetInformationFile, FILE_DIRECTORY_FILE,
    FILE_NON_DIRECTORY_FILE, FILE_OPEN_IF, FILE_OPEN_REPARSE_POINT, FILE_RENAME_INFORMATION,
    FILE_RENAME_INFORMATION_0, FILE_SYNCHRONOUS_IO_NONALERT,
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
    if values.iter().any(|part| {
        part.is_empty()
            || *part == "."
            || *part == ".."
            || part.contains(':')
            || part.contains('\0')
    }) {
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
    // Take ownership immediately. Any validation error below now drops `file`
    // and closes the raw HANDLE instead of leaking one handle per rejected root.
    let file = unsafe { File::from_raw_handle(handle.0) };
    checked_directory(HANDLE(file.as_raw_handle()))?;
    Ok(file)
}

fn relative_open_with_access(
    parent: &File,
    name: &str,
    directory: bool,
    create: bool,
    writable: bool,
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
    let mut access_bits = FILE_GENERIC_READ.0;
    if writable {
        access_bits |= FILE_GENERIC_WRITE.0 | DELETE.0;
    }
    let access = windows::Win32::Storage::FileSystem::FILE_ACCESS_RIGHTS(access_bits);
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

fn relative_open(
    parent: &File,
    name: &str,
    directory: bool,
    create: bool,
) -> std::io::Result<(File, bool)> {
    relative_open_with_access(parent, name, directory, create, true)
}

fn relative_open_readonly(parent: &File, name: &str, directory: bool) -> std::io::Result<File> {
    relative_open_with_access(parent, name, directory, false, false).map(|(file, _)| file)
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

fn directory_for_readonly(root: &File, parts: &[&str]) -> std::io::Result<File> {
    let mut current = root.try_clone()?;
    for segment in parts {
        current = relative_open_readonly(&current, segment, true)?;
    }
    Ok(current)
}

fn open_file_readonly(root: &File, relative: &str) -> std::io::Result<File> {
    let parts = segments(relative)?;
    let (name, parents) = parts
        .split_last()
        .ok_or_else(|| invalid("read path missing filename"))?;
    let parent = directory_for_readonly(root, parents)?;
    relative_open_readonly(&parent, name, false)
}

pub fn directory_exists(root_path: &Path, relative: &str) -> bool {
    let Ok(parts) = segments(relative) else {
        return false;
    };
    root_handle(root_path)
        .and_then(|root| directory_for_readonly(&root, &parts))
        .is_ok()
}

pub fn regular_file_exists(root_path: &Path, relative: &str) -> bool {
    root_handle(root_path)
        .and_then(|root| open_file_readonly(&root, relative))
        .is_ok()
}

pub fn read_bounded(root_path: &Path, relative: &str, max_bytes: u64) -> std::io::Result<Vec<u8>> {
    let root = root_handle(root_path)?;
    let file = open_file_readonly(&root, relative)?;
    let metadata = file.metadata()?;
    if metadata.len() > max_bytes {
        return Err(invalid("read file too large"));
    }
    let capacity =
        usize::try_from(metadata.len()).map_err(|_| invalid("read file size unsupported"))?;
    let limit = max_bytes
        .checked_add(1)
        .ok_or_else(|| invalid("read limit unsupported"))?;
    let mut bytes = Vec::with_capacity(capacity);
    let mut limited = file.take(limit);
    limited.read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes {
        return Err(invalid("read file too large"));
    }
    Ok(bytes)
}

fn copy_handle_to(root: &File, source: &mut File, backup_relative: &str) -> std::io::Result<()> {
    let (mut backup, created) = open_file(root, backup_relative, true)?;
    if !created {
        // The backup prefix is derived from the preview hash, so re-materializing
        // the same preview reuses this exact path. Only the first copy holds the
        // user's original file; overwriting it on a re-run would replace the only
        // undo copy with content Blogbot itself generated.
        return Ok(());
    }
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
    materialize_new_directory_with_before_entry(parent_path, directory_name, files, |_| Ok(()))
}

fn restore_directories(files: &[(String, Vec<u8>)]) -> std::io::Result<Vec<String>> {
    let mut file_keys = std::collections::BTreeSet::<String>::new();
    let mut directories = std::collections::BTreeMap::<String, String>::new();
    for (relative, _) in files {
        let parts = segments(relative)?;
        let file_key = relative.to_lowercase();
        if !file_keys.insert(file_key) {
            return Err(invalid("duplicate restore output"));
        }
        for depth in 1..parts.len() {
            let directory = parts[..depth].join("/");
            directories
                .entry(directory.to_lowercase())
                .or_insert(directory);
        }
    }
    if file_keys.iter().any(|path| directories.contains_key(path)) {
        return Err(invalid("restore output conflicts with a directory"));
    }
    let mut values = directories.into_values().collect::<Vec<_>>();
    values.sort_by_key(|path| std::cmp::Reverse(path.matches('/').count()));
    Ok(values)
}

fn create_restore_staging(parent: &File) -> std::io::Result<(File, String)> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| invalid("restore staging clock unavailable"))?
        .as_nanos();
    for attempt in 0..32u8 {
        let name = format!(
            ".blogbot-restore-stage-{}-{nonce}-{attempt}",
            std::process::id()
        );
        let (directory, created) = relative_open(parent, &name, true, true)?;
        if created {
            return Ok((directory, name));
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "restore staging directory collision",
    ))
}

fn mark_for_deletion(file: &File) -> std::io::Result<()> {
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    unsafe {
        SetFileInformationByHandle(
            HANDLE(file.as_raw_handle()),
            FileDispositionInfo,
            &disposition as *const FILE_DISPOSITION_INFO as *const c_void,
            std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
        .map_err(|error| std::io::Error::other(error.message().to_string()))
    }
}

fn rename_directory_no_replace(
    directory: &File,
    parent: &File,
    destination_name: &str,
) -> std::io::Result<()> {
    let wide = OsStr::new(destination_name)
        .encode_wide()
        .collect::<Vec<_>>();
    let name_bytes = wide
        .len()
        .checked_mul(2)
        .ok_or_else(|| invalid("restore target name too long"))?;
    let header_bytes = std::mem::offset_of!(FILE_RENAME_INFORMATION, FileName);
    let total_bytes = header_bytes
        .checked_add(name_bytes)
        .filter(|size| *size <= u32::MAX as usize)
        .ok_or_else(|| invalid("restore target name too long"))?;
    let words = total_bytes.div_ceil(std::mem::size_of::<usize>());
    let mut buffer = vec![0usize; words];
    let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
    unsafe {
        (*info).Anonymous = FILE_RENAME_INFORMATION_0 {
            ReplaceIfExists: false,
        };
        (*info).RootDirectory = HANDLE(parent.as_raw_handle());
        (*info).FileNameLength = name_bytes as u32;
        std::ptr::copy_nonoverlapping(
            wide.as_ptr(),
            (info.cast::<u8>().add(header_bytes)).cast::<u16>(),
            wide.len(),
        );
        let mut status = IO_STATUS_BLOCK::default();
        let result = NtSetInformationFile(
            HANDLE(directory.as_raw_handle()),
            &mut status,
            info.cast::<c_void>(),
            total_bytes as u32,
            FileRenameInformation,
        );
        if result.0 < 0 {
            return Err(std::io::Error::other(format!(
                "NtSetInformationFile rename failed: 0x{:08x}",
                result.0 as u32
            )));
        }
        Ok(())
    }
}

fn cleanup_restore_staging(root: File, created_files: &[String], planned_directories: &[String]) {
    for relative in created_files.iter().rev() {
        if let Ok((file, _)) = open_file(&root, relative, false) {
            let _ = mark_for_deletion(&file);
        }
    }
    for relative in planned_directories {
        if let Ok(parts) = segments(relative) {
            if let Ok(directory) = directory_for(&root, &parts, false) {
                let _ = mark_for_deletion(&directory);
            }
        }
    }
    let _ = mark_for_deletion(&root);
}

fn materialize_new_directory_with_before_entry<F>(
    parent_path: &Path,
    directory_name: &str,
    files: &[(String, Vec<u8>)],
    mut before_entry: F,
) -> std::io::Result<usize>
where
    F: FnMut(usize) -> std::io::Result<()>,
{
    let target_segments = segments(directory_name)?;
    if target_segments.len() != 1 {
        return Err(invalid("restore target must be a single directory name"));
    }
    let planned_directories = restore_directories(files)?;
    let parent = root_handle(parent_path)?;
    let (root, _staging_name) = create_restore_staging(&parent)?;
    let mut created_files = Vec::<String>::new();
    let result = (|| {
        for (index, (relative, content)) in files.iter().enumerate() {
            before_entry(index)?;
            let (mut destination, destination_created) = open_file(&root, relative, true)?;
            if !destination_created {
                return Err(invalid("restore output already exists"));
            }
            created_files.push(relative.clone());
            destination.write_all(content)?;
            destination.sync_all()?;
        }
        // Every staged file is flushed above before commit. Windows rejects
        // FlushFileBuffers for this directory handle with ERROR_INVALID_PARAMETER,
        // so there must be no fallible operation between the atomic rename and
        // returning success.
        rename_directory_no_replace(&root, &parent, directory_name)?;
        Ok(files.len())
    })();
    if result.is_err() {
        cleanup_restore_staging(root, &created_files, &planned_directories);
    }
    result
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
    use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessHandleCount};

    fn process_handle_count() -> u32 {
        let mut count = 0u32;
        unsafe {
            GetProcessHandleCount(GetCurrentProcess(), &mut count).expect("process handle count");
        }
        count
    }

    #[test]
    fn rejecting_a_reparse_root_does_not_leak_the_opened_handle() {
        let nonce = format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let parent = std::env::temp_dir().join(format!("blogbot-root-handle-leak-{nonce}"));
        let target = parent.join("target");
        let junction = parent.join("junction");
        std::fs::create_dir_all(&target).unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&target)
            .status()
            .unwrap();
        assert!(status.success(), "junction fixture must be available");
        assert!(root_handle(&junction).is_err());

        let before = process_handle_count();
        // A broad native run executes unrelated tests in parallel. Use a leak
        // signal much larger than normal handle-count noise while keeping room
        // for those concurrent fixtures.
        for _ in 0..256 {
            assert!(root_handle(&junction).is_err());
        }
        let after = process_handle_count();
        assert!(
            after <= before.saturating_add(64),
            "rejected roots leaked process handles: before={before}, after={after}"
        );

        std::fs::remove_dir(&junction).unwrap();
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn re_materializing_a_preview_keeps_the_user_original_backup() {
        let nonce = format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root = std::env::temp_dir().join(format!("blogbot-preview-backup-{nonce}"));
        std::fs::create_dir_all(root.join("articles")).unwrap();
        let target = root.join("articles").join("story.md");
        std::fs::write(&target, b"kullanicinin ozgun dosyasi").unwrap();

        // The backup prefix is derived from the preview hash, so both passes of
        // the same preview share it.
        let prefix = ".blogbot/backups/abcdef123456";
        materialize(
            &root,
            &[("articles/story.md".to_owned(), b"ilk uretim".to_vec())],
            prefix,
        )
        .unwrap();
        materialize(
            &root,
            &[("articles/story.md".to_owned(), b"ikinci uretim".to_vec())],
            prefix,
        )
        .unwrap();

        let backup = root.join(".blogbot/backups/abcdef123456/articles/story.md");
        assert_eq!(
            std::fs::read(backup).unwrap(),
            b"kullanicinin ozgun dosyasi".to_vec(),
            "the backup must still hold the user's original file, not Blogbot output"
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"ikinci uretim".to_vec());

        let _ = std::fs::remove_dir_all(&root);
    }

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
        assert_eq!(
            std::fs::read(parent.join("restored/articles/example.md")).unwrap(),
            b"restored",
            "an existing restore target must never be replaced"
        );
        assert_eq!(
            std::fs::read_dir(&parent).unwrap().count(),
            1,
            "a failed no-replace rename must clean its sibling staging tree"
        );
        assert!(materialize_new_directory(&parent, "../outside", &files).is_err());
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn failed_restore_materialization_leaves_no_partial_target_and_can_retry() {
        let nonce = format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let parent = std::env::temp_dir().join(format!("blogbot-atomic-restore-{nonce}"));
        std::fs::create_dir_all(&parent).unwrap();
        let interrupted_bundle = vec![
            ("articles/example.md".to_owned(), b"partial".to_vec()),
            ("articles/second.md".to_owned(), b"never written".to_vec()),
        ];

        let result = materialize_new_directory_with_before_entry(
            &parent,
            "restored",
            &interrupted_bundle,
            |index| {
                if index == 1 {
                    return Err(std::io::Error::other("injected restore write failure"));
                }
                Ok(())
            },
        );
        assert!(result.is_err());
        assert!(!parent.join("restored").exists());
        assert_eq!(std::fs::read_dir(&parent).unwrap().count(), 0);

        let valid_bundle = vec![("articles/example.md".to_owned(), b"complete".to_vec())];
        assert_eq!(
            materialize_new_directory(&parent, "restored", &valid_bundle).unwrap(),
            1
        );
        assert_eq!(
            std::fs::read(parent.join("restored/articles/example.md")).unwrap(),
            b"complete"
        );
        let _ = std::fs::remove_dir_all(&parent);
    }
}
