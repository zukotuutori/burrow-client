use std::path::PathBuf;

use serde::de::{DeserializeOwned, Error as _};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::json_doc::JsonDoc;
use crate::error::Result;
use crate::types::{now_ms, KeyMeta, Profile, Snippet};

/// Something stored in a list file and synced by id.
pub trait Item: Serialize + DeserializeOwned + Clone {
    fn id(&self) -> &str;
    fn updated_at(&self) -> Option<i64>;
    fn set_updated_at(&mut self, t: i64);
}

macro_rules! impl_item {
    ($($t:ty),*) => {$(
        impl Item for $t {
            fn id(&self) -> &str { &self.id }
            fn updated_at(&self) -> Option<i64> { self.updated_at }
            fn set_updated_at(&mut self, t: i64) { self.updated_at = Some(t) }
        }
    )*};
}
impl_item!(Profile, Snippet, KeyMeta);

/// A deleted item, kept so other devices learn about the delete. Only id and time are kept.
#[derive(Clone, Debug, PartialEq)]
pub struct Tombstone {
    pub id: String,
    pub updated_at: Option<i64>,
}

/// One element of a list file: an item or the tombstone of one.
#[derive(Clone, Debug, PartialEq)]
pub enum Entry<T> {
    Live(T),
    Deleted(Tombstone),
}

impl<T: Item> Entry<T> {
    pub fn id(&self) -> &str {
        match self {
            Entry::Live(x) => x.id(),
            Entry::Deleted(t) => &t.id,
        }
    }

    pub fn updated_at(&self) -> Option<i64> {
        match self {
            Entry::Live(x) => x.updated_at(),
            Entry::Deleted(t) => t.updated_at,
        }
    }

    pub fn live(&self) -> Option<&T> {
        match self {
            Entry::Live(x) => Some(x),
            Entry::Deleted(_) => None,
        }
    }

    pub fn tombstone_of(x: &T) -> Self {
        Entry::Deleted(Tombstone { id: x.id().to_string(), updated_at: x.updated_at() })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TombstoneJson<'a> {
    id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at: Option<i64>,
    deleted: bool,
}

impl<T: Serialize> Serialize for Entry<T> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Entry::Live(x) => x.serialize(s),
            Entry::Deleted(t) => TombstoneJson { id: &t.id, updated_at: t.updated_at, deleted: true }.serialize(s),
        }
    }
}

impl<'de, T: DeserializeOwned> Deserialize<'de> for Entry<T> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = serde_json::Value::deserialize(d)?;
        if v.get("deleted") == Some(&serde_json::Value::Bool(true)) {
            let id = v.get("id").and_then(|x| x.as_str()).ok_or_else(|| D::Error::custom("tombstone without id"))?;
            let updated_at = v.get("updatedAt").and_then(|n| n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)));
            return Ok(Entry::Deleted(Tombstone { id: id.to_string(), updated_at }));
        }
        T::deserialize(v).map(Entry::Live).map_err(D::Error::custom)
    }
}

/// A list file of items with ids, including tombstones.
pub struct Repo<T> {
    pub doc: JsonDoc<Vec<Entry<T>>>,
}

impl<T: Item> Repo<T> {
    pub fn new(file: PathBuf) -> Self {
        Repo { doc: JsonDoc::new(file, Vec::new()) }
    }

    /// Items that are not deleted.
    pub fn list(&self) -> Vec<T> {
        self.doc.value().iter().filter_map(|e| e.live().cloned()).collect()
    }

    /// Every item including tombstones, for sync.
    pub fn all(&self) -> &[Entry<T>] {
        self.doc.value()
    }

    pub fn get(&self, id: &str) -> Option<&T> {
        self.doc.value().iter().filter_map(Entry::live).find(|x| x.id() == id)
    }

    /// Saves the entry and stamps it with the current time, so sync knows it is the newest version.
    fn put(&mut self, mut entry: Entry<T>) -> Result<()> {
        let now = now_ms();
        match &mut entry {
            Entry::Live(x) => x.set_updated_at(now),
            Entry::Deleted(t) => t.updated_at = Some(now),
        }
        let mut next = self.doc.value().clone();
        match next.iter().position(|e| e.id() == entry.id()) {
            Some(i) => next[i] = entry,
            None => next.push(entry),
        }
        self.doc.set(next)
    }

    pub fn upsert(&mut self, item: T) -> Result<()> {
        self.put(Entry::Live(item))
    }

    /// Replaces the item with a tombstone, so the delete reaches other devices.
    pub fn remove(&mut self, id: &str) -> Result<()> {
        match self.get(id) {
            Some(item) => self.put(Entry::tombstone_of(item)),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct It {
        id: String,
        v: i32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        updated_at: Option<i64>,
    }
    impl Item for It {
        fn id(&self) -> &str {
            &self.id
        }
        fn updated_at(&self) -> Option<i64> {
            self.updated_at
        }
        fn set_updated_at(&mut self, t: i64) {
            self.updated_at = Some(t)
        }
    }
    fn it(id: &str, v: i32) -> It {
        It { id: id.into(), v, updated_at: None }
    }

    #[test]
    fn inserts_updates_in_place_removes_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("items.json");
        let mut repo = Repo::<It>::new(file.clone());
        repo.doc.load().unwrap();
        repo.upsert(it("a", 1)).unwrap();
        repo.upsert(it("b", 2)).unwrap();
        repo.upsert(it("a", 3)).unwrap();
        let list: Vec<_> = repo.list().into_iter().map(|x| (x.id, x.v, x.updated_at.is_some())).collect();
        assert_eq!(list, vec![("a".into(), 3, true), ("b".into(), 2, true)]);
        repo.remove("a").unwrap();

        let mut again = Repo::<It>::new(file);
        again.doc.load().unwrap();
        assert_eq!(again.list().iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), vec!["b"]);
        assert_eq!(again.get("b").map(|x| x.v), Some(2));
        assert!(again.get("a").is_none());
    }

    #[test]
    fn removed_item_becomes_a_tombstone_with_only_id_and_time() {
        let dir = tempfile::tempdir().unwrap();
        let mut repo = Repo::<It>::new(dir.path().join("items.json"));
        repo.upsert(it("a", 1)).unwrap();
        repo.remove("a").unwrap();
        let json = serde_json::to_value(repo.all()).unwrap();
        assert_eq!(json[0]["id"], "a");
        assert_eq!(json[0]["deleted"], true);
        assert!(json[0]["updatedAt"].is_i64());
        assert_eq!(json[0].as_object().unwrap().len(), 3);
        assert!(repo.list().is_empty());
    }

    #[test]
    fn reads_tombstones_written_by_the_electron_version() {
        let e: Vec<Entry<It>> =
            serde_json::from_str(r#"[{"id":"a","updatedAt":5,"deleted":true},{"id":"b","v":1}]"#).unwrap();
        assert_eq!(e[0], Entry::Deleted(Tombstone { id: "a".into(), updated_at: Some(5) }));
        assert_eq!(e[1], Entry::Live(it("b", 1)));
    }
}
