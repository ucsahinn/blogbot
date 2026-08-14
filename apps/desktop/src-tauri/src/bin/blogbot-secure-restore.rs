use std::io::{self, Read};
use std::path::Path;

use base64::Engine;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RestoreRequest {
    parent_directory: String,
    target_name: String,
    files: Vec<RestoreFile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RestoreFile {
    path: String,
    base64: String,
}

fn main() -> Result<(), String> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|_| "RESTORE_INPUT_UNAVAILABLE".to_string())?;
    let request: RestoreRequest = serde_json::from_str(&input)
        .map_err(|_| "RESTORE_INPUT_INVALID".to_string())?;
    if request.files.is_empty() || request.files.len() > 256 {
        return Err("RESTORE_INPUT_INVALID".into());
    }
    let files = request
        .files
        .into_iter()
        .map(|file| {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(file.base64)
                .map_err(|_| "RESTORE_INPUT_INVALID".to_string())?;
            Ok((file.path, bytes))
        })
        .collect::<Result<Vec<_>, String>>()?;
    blogbot_desktop_lib::secure_preview_fs::materialize_new_directory(
        Path::new(&request.parent_directory),
        &request.target_name,
        &files,
    )
    .map_err(|_| "RESTORE_WRITE_FAILED".to_string())?;
    Ok(())
}
