use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::{Error, Result};

pub fn file_name(file: &Path) -> String {
    file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

pub fn corrupt(file: &Path, message: impl ToString) -> Error {
    Error::CorruptFile { file: file.display().to_string(), message: message.to_string() }
}

/// The file's text, or `None` if it does not exist.
pub fn read_text(file: &Path) -> Result<Option<String>> {
    match fs::read_to_string(file) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Parses the file, or returns `None` if it does not exist. Throws `CorruptFile` if it does not parse.
pub fn read_json<T: DeserializeOwned>(file: &Path) -> Result<Option<T>> {
    match read_text(file)? {
        None => Ok(None),
        Some(text) => serde_json::from_str(&text).map(Some).map_err(|e| corrupt(file, e)),
    }
}

fn create_private_dir(dir: &Path) -> Result<()> {
    let mut b = fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
    b.create(dir)?;
    Ok(())
}

/// Writes to a temporary file readable only by the user, then renames it over the target.
pub fn write_file_atomic(file: &Path, contents: &[u8]) -> Result<()> {
    if let Some(dir) = file.parent() {
        create_private_dir(dir)?;
    }
    let mut tmp = file.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    let mut f = opts.open(&tmp)?;
    f.write_all(contents)?;
    f.sync_all()?;
    drop(f);
    fs::rename(&tmp, file)?;
    Ok(())
}

/// Pretty JSON with a trailing newline, like `JSON.stringify(data, null, 2) + '\n'`.
pub fn write_json_atomic<T: Serialize + ?Sized>(file: &Path, data: &T) -> Result<()> {
    let mut text = serde_json::to_string_pretty(data).map_err(|e| Error::msg(e.to_string()))?;
    text.push('\n');
    write_file_atomic(file, text.as_bytes())
}

/// Copies the file to `<file>.broken-<time>`. Returns `None` if there was nothing to copy.
pub fn backup_file(file: &Path) -> Result<Option<PathBuf>> {
    let stamp = crate::types::now_iso().replace([':', '.'], "-");
    let mut target = file.as_os_str().to_owned();
    target.push(format!(".broken-{stamp}"));
    let target = PathBuf::from(target);
    match fs::copy(file, &target) {
        Ok(_) => Ok(Some(target)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_reads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_json::<serde_json::Value>(&dir.path().join("x.json")).unwrap(), None);
    }

    #[test]
    fn writes_atomically_and_reads_back() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("x.json");
        write_json_atomic(&file, &serde_json::json!({ "hello": "world" })).unwrap();
        assert_eq!(read_json::<serde_json::Value>(&file).unwrap(), Some(serde_json::json!({ "hello": "world" })));
        let names: Vec<_> = fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, vec!["x.json"]);
    }

    #[test]
    fn invalid_json_is_a_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("x.json");
        fs::write(&file, "{nope").unwrap();
        assert!(matches!(read_json::<serde_json::Value>(&file), Err(Error::CorruptFile { .. })));
    }

    #[cfg(unix)]
    #[test]
    fn folders_and_files_are_private_to_the_user() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("nested").join("deeper").join("x.json");
        write_json_atomic(&file, &1).unwrap();
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir.path().join("nested")), 0o700);
        assert_eq!(mode(&dir.path().join("nested").join("deeper")), 0o700);
        assert_eq!(mode(&file), 0o600);
    }
}
