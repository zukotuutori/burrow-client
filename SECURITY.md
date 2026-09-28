# Security

Burrow Client holds SSH passwords and private keys, so security bugs matter more here than in most apps. Reports are very welcome.

## Reporting a vulnerability

Please don't open a public issue. Use the contact form at [zukotuutori.dev/contact](https://zukotuutori.dev/contact) instead.

It helps to include:

- the version or commit you tested
- your operating system
- steps to reproduce, or a proof of concept
- what an attacker could do with it

This is a one-person project, so a reply can take a few days. Once a fix is released, the report is published as a GitHub security advisory, with credit if you want it.

### Scope

In scope: the desktop app in `src/`, the sync server in `server/`, and the Docker and proxy setup described in [server/README.md](server/README.md).

Out of scope: problems that need malware already running as your user, a machine that's already compromised, or a sync server operator doing something the [known limitations](#known-limitations) below already describe.

## Supported versions

| Version | Security fixes |
|---|---|
| 1.x (latest release) | Yes |
| Anything older | No |

To see whether you're on the latest version, use **Settings → Updates**, or look at the [Releases page](https://github.com/zukotuutori/ssh-client/releases).

## How your data is protected

### On disk

Passwords, private keys, key passphrases and the sync keys live in `vault.enc`, encrypted with AES-256-GCM. The key is derived from your master password with scrypt (N=2^17, r=8, p=1, about 128 MB of memory per attempt), which makes guessing slow even with good hardware. The master password needs at least 12 characters, including a number and a special character.

- Every save uses a fresh random IV, and GCM detects any change to the file.
- The scrypt settings stored in the file are checked against upper limits, so a tampered vault can't make unlocking eat gigabytes of memory.
- Files are written atomically with `0600` permissions, so only your user account can read them.
- When the vault locks, the key in memory is overwritten with zeros.

Everything else is stored as plain JSON: host labels, addresses, user names, notes, snippets, public keys, known host fingerprints and settings. Anyone who can read your user folder can read those. See the file table in the [README](README.md#where-your-data-lives).

### Locking

The vault locks when you click Lock, close the window, put the computer to sleep, lock the screen, or leave the computer idle for the time set in Settings (15 minutes by default). Locking closes every SSH session and local shell.

### Inside the app

The app can open shells and SSH sessions, so code running in its window could do a lot of damage. The window is locked down to match:

- Chromium's sandbox and context isolation are on, and the UI has no Node.js access.
- A strict Content Security Policy only allows the app's own scripts. There is no inline script, `eval` or remote code.
- The main process only accepts messages from the app's own window and checks the type of every argument.
- Navigation and new windows are blocked. Only `http` and `https` links open, and they open in your normal browser.
- Camera, microphone, location, notifications and every other web permission are denied, except clipboard access for copy and paste.
- Packaged builds have no DevTools and refuse to start with remote debugging switches. Electron fuses turn off `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect`, and the app only loads from its integrity-checked `app.asar`.
- The spellchecker is off, so no dictionaries are downloaded and nothing you type is sent anywhere.

### SSH

- The first connection to a host shows its key fingerprint for you to confirm. If a known host's key changes, you get a warning, and the connection only goes ahead if you accept the new key.
- Key exchange, host key and MAC algorithms based on SHA-1 or MD5 are turned off. Servers that only support those are refused instead of being connected insecurely.
- Agent forwarding is not used.

### Sync (optional)

Your account password is turned into two separate keys with scrypt and HKDF:

- The **login key** is sent to the server to prove who you are. The server only stores its SHA-256 hash.
- The **encryption key** encrypts your data with AES-256-GCM before it leaves the device. It is never sent anywhere.

The app only talks to sync servers over HTTPS (plain HTTP only to `localhost`, for development), refuses redirects, and times out stuck requests. Data coming back from the server is decrypted, checked and validated field by field before anything is saved.

The server keeps registration closed unless an invite code is set, blocks an IP for 15 minutes after 10 failed attempts, and caps request size. The Docker setup runs it as a non-root user on a read-only file system with no Linux capabilities and no published port.

### Updates

Burrow only contacts GitHub when you click **Check for updates**, or once per start if you turned on the startup check (it's off by default). The request goes to `api.github.com` and carries nothing about you except your IP address. Download links from the answer are only used if they point to this repository's releases.

- **AppImage:** updates are downloaded and installed by [electron-updater](https://www.electron.build/auto-update). Every download is checked against the SHA-512 hash in the release's `latest-linux.yml` before it replaces the app.
- **macOS and rpm:** the app never downloads or installs anything itself. It opens the download in your browser.

The hash check catches broken or altered downloads. It does not protect against someone who takes over the GitHub account and publishes a bad release, but a manual download from the Releases page wouldn't protect you from that either.

## Verifying what you run

Release builds are not code signed or notarized. If you want to be sure the app matches this source code, build it yourself:

```bash
git clone https://github.com/zukotuutori/ssh-client.git
cd ssh-client
npm ci
npm run build:mac
```

Use `npm run build:linux` on Linux.

## Known limitations

- The code has not been audited by an independent security firm.
- Release builds are not signed or notarized (see above).
- Only the AppImage installs updates itself. On macOS and with the rpm, security fixes only reach you when you install the new version by hand. Update checks don't run on their own unless you turn that on.
- Since builds aren't signed, updates are only verified against the hash published in the same GitHub release, not against a signature.
- Plain JSON files (hosts, snippets, known hosts, settings) are not encrypted. Only secrets are.
- After the vault locks, the key is wiped, but decrypted secrets can stay in memory until JavaScript's garbage collector frees them.
- Malware running as your user account can read everything the app can see while the vault is unlocked. No app can fully protect against that.
- Hiding the window from screenshots and screen recordings works on macOS but not on Linux.
- Whoever runs a sync server can see user names, IP addresses, and when and how much data is uploaded. They can't read or change your data, but they can delete it or hand out an older copy.
- The sync salt is derived from the user name, so a new device can log in with just the user name and password. This means someone with a copy of the server database can try to guess account passwords offline. Every guess costs a full scrypt run and account passwords have the same rules as the master password, but a weak password is still a risk.
- A forgotten master password or sync account password cannot be recovered.
