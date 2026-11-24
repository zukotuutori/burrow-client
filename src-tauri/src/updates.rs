//! Checks GitHub for a newer release. Only the AppImage downloads and installs updates itself; everywhere else
//! the window opens the download in the browser.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::error::{bail, Error, Result};
use crate::types::UpdateInfo;

const REPO: &str = "zukotuutori/burrow-client";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

fn latest_release_api() -> String {
    format!("https://api.github.com/repos/{REPO}/releases/latest")
}
fn release_pages() -> String {
    format!("https://github.com/{REPO}/releases/")
}
fn downloads() -> String {
    format!("{}download/", release_pages())
}

#[derive(Clone, Debug, PartialEq)]
pub struct ReleaseAsset {
    pub name: String,
    pub url: String,
    /// The lowercase hex SHA-256 GitHub computed when the file was uploaded (the API's `digest` field).
    pub sha256: Option<String>,
}

#[derive(Clone, Copy, Debug)]
pub struct System {
    /// `darwin` or `linux`, like Node's process.platform.
    pub platform: &'static str,
    /// `arm64` or `x64`, like Node's process.arch.
    pub arch: &'static str,
    /// Running from an AppImage, which is the only build that can replace itself.
    pub is_app_image: bool,
}

impl System {
    pub fn current() -> System {
        System {
            platform: match std::env::consts::OS {
                "macos" => "darwin",
                other => other,
            },
            arch: match std::env::consts::ARCH {
                "aarch64" => "arm64",
                "x86_64" => "x64",
                other => other,
            },
            is_app_image: app_image_path().is_some(),
        }
    }
}

/// The AppImage file this app runs from, if it does.
pub fn app_image_path() -> Option<PathBuf> {
    std::env::var_os("APPIMAGE").filter(|p| !p.is_empty()).map(PathBuf::from)
}

/// Compares x.y.z versions number by number. A leading "v" is ignored.
pub fn is_newer(latest: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.trim_start_matches('v').split('.').map(|n| n.chars().take_while(char::is_ascii_digit).collect::<String>().parse().unwrap_or(0)).collect()
    };
    let (a, b) = (parse(latest), parse(current));
    for i in 0..3 {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

static ARM64: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)arm64|aarch64").unwrap());
static X64: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)x64|x86_64|amd64").unwrap());
static UNIVERSAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)universal").unwrap());

/// The release file for this system: the dmg on macOS, the AppImage on Linux. A Linux build that does not run
/// from an AppImage (built from source) gets none and is sent to the release page. Files without an
/// architecture in the name count as the one we build on that platform: arm64 for the dmg, x64 on Linux.
pub fn pick_asset<'a>(assets: &'a [ReleaseAsset], system: &System) -> Option<&'a ReleaseAsset> {
    let ext = match (system.platform, system.is_app_image) {
        ("darwin", _) => ".dmg",
        ("linux", true) => ".appimage",
        _ => return None,
    };
    let (own, other): (&Regex, &Regex) = match system.arch {
        "arm64" => (&ARM64, &X64),
        "x64" => (&X64, &ARM64),
        _ => return None,
    };
    let prefix = downloads();
    let files: Vec<&ReleaseAsset> =
        assets.iter().filter(|a| a.name.to_lowercase().ends_with(ext) && a.url.starts_with(&prefix)).collect();
    let default_arch = if system.platform == "darwin" { "arm64" } else { "x64" };
    files
        .iter()
        .find(|a| own.is_match(&a.name))
        .or_else(|| files.iter().find(|a| UNIVERSAL.is_match(&a.name)))
        .or_else(|| if system.arch == default_arch { files.iter().find(|a| !other.is_match(&a.name)) } else { None })
        .copied()
}

struct Release {
    tag: String,
    page: String,
    assets: Vec<ReleaseAsset>,
}

/// Checks GitHub's answer and keeps only what we use.
fn parse_release(status: u16, body: Option<Value>) -> Result<Release> {
    match status {
        404 => bail!("No release has been published yet"),
        403 | 429 => bail!("GitHub's rate limit was reached. Try again in an hour."),
        200..=299 => {}
        s => bail!("GitHub answered with status {s}"),
    }
    let body = body.unwrap_or(Value::Null);
    let tag = body.get("tag_name").and_then(Value::as_str);
    let page = body.get("html_url").and_then(Value::as_str).filter(|p| p.starts_with(&release_pages()));
    let assets = body.get("assets").and_then(Value::as_array);
    let (Some(tag), Some(page), Some(assets)) = (tag, page, assets) else { bail!("GitHub sent an unexpected answer") };
    let assets = assets
        .iter()
        .filter_map(|a| {
            Some(ReleaseAsset {
                name: a.get("name")?.as_str()?.to_string(),
                url: a.get("browser_download_url")?.as_str()?.to_string(),
                sha256: a
                    .get("digest")
                    .and_then(Value::as_str)
                    .and_then(|d| d.strip_prefix("sha256:"))
                    .filter(|h| h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit()))
                    .map(str::to_ascii_lowercase),
            })
        })
        .collect();
    Ok(Release { tag: tag.into(), page: page.into(), assets })
}

fn info_for(current: &str, release: &Release, system: &System) -> UpdateInfo {
    let file = pick_asset(&release.assets, system);
    UpdateInfo {
        current: current.into(),
        latest: release.tag.trim_start_matches('v').into(),
        available: is_newer(&release.tag, current),
        download_url: file.map(|f| f.url.clone()).unwrap_or_else(|| release.page.clone()),
        can_install: system.is_app_image && file.is_some(),
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().timeout(REQUEST_TIMEOUT).user_agent("Burrow-Client").build().expect("valid HTTP client settings")
}

async fn fetch_release() -> Result<Release> {
    let res = client()
        .get(latest_release_api())
        .header("accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| Error::msg("Could not reach GitHub. Check your internet connection."))?;
    let status = res.status().as_u16();
    parse_release(status, res.json().await.ok())
}

/// Asks GitHub for the latest release and compares it with the running version.
pub async fn check_for_update(current: &str, system: &System) -> Result<UpdateInfo> {
    Ok(info_for(current, &fetch_release().await?, system))
}

/// Downloads the new AppImage next to the running one, checks it against the SHA-256 GitHub lists for that file,
/// and only then puts it in place. The running copy keeps working until the restart.
pub async fn download_update(system: &System) -> Result<()> {
    let Some(target) = app_image_path() else { bail!("Only the AppImage can install updates itself") };
    let release = fetch_release().await?;
    let not_found = || Error::msg("The update could not be found. Download it from GitHub instead.");
    let asset = pick_asset(&release.assets, system).ok_or_else(not_found)?;
    let expected = asset.sha256.clone().ok_or_else(not_found)?;

    let partial = partial_path(&target);
    let result = async {
        let mut res = client()
            .get(&asset.url)
            .timeout(Duration::from_secs(30 * 60))
            .send()
            .await
            .map_err(|_| Error::msg("Could not reach GitHub. Check your internet connection."))?;
        if !res.status().is_success() {
            bail!("GitHub answered with status {}", res.status().as_u16());
        }
        let mut file = tokio::fs::File::create(&partial).await?;
        let mut hash = Sha256::new();
        while let Some(chunk) = res.chunk().await.map_err(|e| Error::msg(e.to_string()))? {
            hash.update(&chunk);
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        drop(file);
        if to_hex(&hash.finalize()) != expected {
            bail!("The downloaded update does not match its checksum, so it was not installed");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&partial, std::fs::Permissions::from_mode(0o755)).await?;
        }
        tokio::fs::rename(&partial, &target).await?;
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&partial).await;
    }
    result
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn partial_path(target: &Path) -> PathBuf {
    let mut p = target.as_os_str().to_owned();
    p.push(".download");
    PathBuf::from(p)
}

/// Starts the (already replaced) AppImage again. The caller quits this copy afterwards.
pub fn start_new_version() -> Result<()> {
    let Some(target) = app_image_path() else { bail!("Only the AppImage can install updates itself") };
    std::process::Command::new(target).spawn()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const DL: &str = "https://github.com/zukotuutori/burrow-client/releases/download/v1.1.0/";

    fn asset(name: &str) -> ReleaseAsset {
        ReleaseAsset { name: name.into(), url: format!("{DL}{name}"), sha256: None }
    }

    fn assets() -> Vec<ReleaseAsset> {
        ["Burrow.Client-1.1.0-arm64.dmg", "Burrow.Client-1.1.0.AppImage", "Burrow.Client-1.1.0-arm64.AppImage", "notes.txt"]
            .map(asset)
            .to_vec()
    }

    fn sys(platform: &'static str, arch: &'static str, is_app_image: bool) -> System {
        System { platform, arch, is_app_image }
    }

    fn pick(list: &[ReleaseAsset], s: System) -> Option<String> {
        pick_asset(list, &s).map(|a| a.name.clone())
    }

    #[test]
    fn compares_versions() {
        assert!(is_newer("1.0.1", "1.0.0"));
        assert!(is_newer("1.10.0", "1.9.0"));
        assert!(is_newer("2.0.0", "1.99.99"));
        assert!(!is_newer("1.0.0", "1.0.0"));
        assert!(!is_newer("0.9.0", "1.0.0"));
        assert!(is_newer("v1.1.0", "1.0.0"));
        assert!(!is_newer("v1.0.0", "1.0.0"));
    }

    #[test]
    fn picks_the_file_for_this_system() {
        let a = assets();
        assert_eq!(pick(&a, sys("darwin", "arm64", false)).as_deref(), Some("Burrow.Client-1.1.0-arm64.dmg"));
        assert_eq!(pick(&a, sys("darwin", "x64", false)), None);
        assert_eq!(pick(&a, sys("linux", "x64", true)).as_deref(), Some("Burrow.Client-1.1.0.AppImage"));
        assert_eq!(pick(&a, sys("linux", "arm64", true)).as_deref(), Some("Burrow.Client-1.1.0-arm64.AppImage"));
        assert_eq!(pick(&a, sys("linux", "x64", false)), None);
    }

    #[test]
    fn accepts_plain_file_names_and_ignores_foreign_links() {
        let plain = ["burrowclient.dmg", "burrowclient.AppImage"].map(asset).to_vec();
        assert_eq!(pick(&plain, sys("darwin", "arm64", false)).as_deref(), Some("burrowclient.dmg"));
        assert_eq!(pick(&plain, sys("darwin", "x64", false)), None);
        assert_eq!(pick(&plain, sys("linux", "x64", true)).as_deref(), Some("burrowclient.AppImage"));
        assert_eq!(pick(&plain, sys("linux", "x64", false)), None);
        let evil = vec![ReleaseAsset { name: "Burrow.Client-1.1.0-arm64.dmg".into(), url: "https://example.com/Burrow.dmg".into(), sha256: None }];
        assert_eq!(pick(&evil, sys("darwin", "arm64", false)), None);
    }

    fn release_json() -> Value {
        let list: Vec<Value> = assets().iter().map(|a| json!({ "name": a.name, "browser_download_url": a.url })).collect();
        json!({ "tag_name": "v1.1.0", "html_url": "https://github.com/zukotuutori/burrow-client/releases/tag/v1.1.0", "assets": list })
    }

    #[test]
    fn reports_updates() {
        let r = parse_release(200, Some(release_json())).unwrap();
        let info = info_for("1.0.0", &r, &sys("darwin", "arm64", false));
        assert_eq!(
            info,
            UpdateInfo {
                current: "1.0.0".into(),
                latest: "1.1.0".into(),
                available: true,
                download_url: format!("{DL}Burrow.Client-1.1.0-arm64.dmg"),
                can_install: false
            }
        );
        assert!(!info_for("1.1.0", &r, &sys("darwin", "arm64", false)).available);
        let app = info_for("1.0.0", &r, &sys("linux", "x64", true));
        assert!(app.can_install);
        assert_eq!(info_for("1.0.0", &r, &sys("darwin", "x64", false)).download_url, "https://github.com/zukotuutori/burrow-client/releases/tag/v1.1.0");
    }

    #[test]
    fn explains_errors_and_rejects_odd_answers() {
        assert!(parse_release(404, None).err().unwrap().to_string().contains("No release"));
        assert!(parse_release(403, None).err().unwrap().to_string().contains("rate limit"));
        let mut bad = release_json();
        bad["html_url"] = json!("https://example.com/release");
        assert!(parse_release(200, Some(bad)).err().unwrap().to_string().contains("unexpected"));
    }

    #[test]
    fn reads_githubs_sha256_digest() {
        let hex = "93F3E384F13065042CE3B7802A0A0A6DA8BAFB2ECAAC7AAE7D283E746EDEC0C0";
        let body = json!({
            "tag_name": "v2.0.0",
            "html_url": "https://github.com/zukotuutori/burrow-client/releases/tag/v2.0.0",
            "assets": [
                { "name": "a.AppImage", "browser_download_url": format!("{DL}a.AppImage"), "digest": format!("sha256:{hex}") },
                { "name": "b.AppImage", "browser_download_url": format!("{DL}b.AppImage"), "digest": "sha512:abc" },
                { "name": "c.AppImage", "browser_download_url": format!("{DL}c.AppImage") }
            ]
        });
        let r = parse_release(200, Some(body)).unwrap();
        assert_eq!(r.assets[0].sha256.as_deref(), Some(hex.to_ascii_lowercase().as_str()));
        assert_eq!(r.assets[1].sha256, None);
        assert_eq!(r.assets[2].sha256, None);
        assert_eq!(to_hex(&Sha256::digest(b"abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
