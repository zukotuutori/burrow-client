use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;

use super::json_file::{backup_file, file_name, read_json, write_json_atomic};
use crate::error::{Error, Result};

/// One JSON file held in memory. A file that fails to parse is marked broken and never overwritten until reset.
///
/// Callers keep it behind a lock, so writes never overlap and memory always matches the last write.
pub struct JsonDoc<T> {
    file: PathBuf,
    fallback: T,
    data: T,
    broken: bool,
}

impl<T: Serialize + DeserializeOwned + Clone> JsonDoc<T> {
    pub fn new(file: PathBuf, fallback: T) -> Self {
        JsonDoc { file, data: fallback.clone(), fallback, broken: false }
    }

    pub fn file(&self) -> &Path {
        &self.file
    }

    pub fn load(&mut self) -> Result<()> {
        match read_json(&self.file) {
            Ok(v) => {
                self.data = v.unwrap_or_else(|| self.fallback.clone());
                self.broken = false;
                Ok(())
            }
            Err(e) => {
                if matches!(e, Error::CorruptFile { .. }) {
                    self.broken = true;
                    self.data = self.fallback.clone();
                }
                Err(e)
            }
        }
    }

    pub fn value(&self) -> &T {
        &self.data
    }

    pub fn is_broken(&self) -> bool {
        self.broken
    }

    pub fn set(&mut self, value: T) -> Result<()> {
        if self.broken {
            return Err(Error::msg(format!("{} could not be read. Reset it first.", file_name(&self.file))));
        }
        write_json_atomic(&self.file, &value)?;
        self.data = value;
        Ok(())
    }

    /// Copies the current file to a backup, then writes the fallback value.
    pub fn reset(&mut self) -> Result<Option<PathBuf>> {
        let backup = backup_file(&self.file)?;
        self.broken = false;
        self.set(self.fallback.clone())?;
        Ok(backup)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[derive(Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
    struct N {
        n: i32,
    }

    #[test]
    fn broken_file_blocks_writes_until_reset_and_keeps_a_backup() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        fs::write(&file, "{nope").unwrap();
        let mut doc = JsonDoc::new(file.clone(), N { n: 0 });
        assert!(matches!(doc.load(), Err(Error::CorruptFile { .. })));
        assert!(doc.is_broken());
        let err = doc.set(N { n: 1 }).unwrap_err().to_string();
        assert!(err.contains("Reset it first"), "{err}");
        assert_eq!(fs::read_to_string(&file).unwrap(), "{nope");

        let backup = doc.reset().unwrap().unwrap();
        assert!(backup.to_string_lossy().contains("settings.json.broken-"));
        assert_eq!(fs::read_to_string(&backup).unwrap(), "{nope");
        assert_eq!(read_json::<N>(&file).unwrap(), Some(N { n: 0 }));
        doc.set(N { n: 2 }).unwrap();
        assert_eq!(doc.value(), &N { n: 2 });
    }
}
