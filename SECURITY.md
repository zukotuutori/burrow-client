# Security

Burrow Client stores SSH passwords and private keys, so security reports are very welcome.

## Reporting a vulnerability

Please don't open a public issue. Report it privately through the contact form at [zukotuutori.dev/contact](https://zukotuutori.dev/contact) instead.

Useful things to include:

- the version or commit you tested
- your operating system
- steps to reproduce, or a proof of concept
- what an attacker could do with it

This is a one-person project, so an answer can take a few days. Once a fix is out, the report will be published as a GitHub security advisory, with credit if you want it.

## Supported versions

Only the latest release gets security fixes.

## How your data is protected

**On your machine.** Passwords, private keys, key passphrases and the sync keys are kept in `vault.enc`, encrypted with AES-256-GCM. The key comes from your master password via scrypt (N=2^17, r=8, p=1). Everything else is plain JSON: host labels, addresses, user names, notes, snippets, public keys, known host fingerprints and settings. Anyone who can read your user folder can read those.

**In the app.** The window runs with Chromium's sandbox and context isolation, a strict Content Security Policy and no Node.js access. Only the app's own window can talk to the main process. DevTools and remote debugging are disabled in packaged builds.

**SSH.** The first connection to a host shows its key fingerprint for you to confirm. A changed key shows a warning and does not connect unless you say so. Algorithms based on SHA-1 are turned off, so servers that only support those are refused. Agent forwarding is not used.

**Sync (optional).** Your account password is turned into two separate keys. One logs in to the server. The other encrypts your data before it leaves the device and is never sent anywhere. The server only stores a hash of the login key and the encrypted data. The app only talks to sync servers over HTTPS, except for plain HTTP to `localhost` during development.

## Known limitations

- The code has not been audited by an independent security firm.
- Release builds are not code signed or notarized. If you want to be certain what you run, build it from source.
- The app does not update itself. Security fixes only reach you when you install a new version.
- Whoever runs a sync server can see user names, IP addresses and when and how much data is uploaded. They cannot read or change your data, but they can delete it or hand out an older copy.
- The sync salt is derived from the user name. Someone who gets a copy of the server database can try to guess account passwords offline. Each guess costs a full scrypt run, and account passwords must be at least 12 characters with a number and a special character, but a weak password is still a risk.
- After the vault locks, the encryption key is wiped, but decrypted secrets can stay in memory until JavaScript's garbage collector frees them.
- Malware running as your user account can read everything the app can see while the vault is unlocked. The app cannot protect against that.
- Hiding the window from screenshots and screen recordings works on macOS but not on Linux.
- A forgotten master password or sync account password cannot be recovered.
