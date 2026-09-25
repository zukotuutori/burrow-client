# Burrow Client

A local-first SSH client for macOS and Linux. Without an account nothing leaves your machine. Optional sync to your own server is end-to-end encrypted (see `server/README.md`).

- Tabbed sessions with split panes
- Host profiles with groups and search
- Snippets you can send to any terminal
- Key management: generate Ed25519/RSA keys, import existing ones
- SFTP browser with drag and drop upload
- Known-hosts checks with a warning when a server key changes
- Passwords and private keys live in an encrypted vault (scrypt + AES-256-GCM) behind a master password

## Development

```bash
npm install
npm run dev          # start the app with hot reload
npm run dev:server   # local echo SSH + SFTP server on 127.0.0.1:2222 (user dev / password dev)
npm test             # unit and integration tests
npm run typecheck
```

## Building

macOS (unsigned `.dmg` in `dist/`):

```bash
npm run build:mac
```

The app is not signed. On first launch, right-click it in Finder and choose Open.

Fedora (`.rpm` and AppImage in `dist/`), run on the Fedora machine:

```bash
sudo dnf install rpm-build
npm install
npm run build:linux
```

## Where data is stored

- macOS: `~/Library/Application Support/Burrow Client/`
- Linux: `~/.config/Burrow Client/`

`profiles.json`, `snippets.json`, `keys.json` (public keys only), `known_hosts.json` and `settings.json` are plain JSON you can read and back up. `sync.json` holds the sync server address and user name. `vault.enc` holds passwords, private keys, passphrases and the sync keys, encrypted with your master password. A forgotten master password cannot be recovered.

## Keyboard shortcuts

| Action | macOS | Linux |
|---|---|---|
| Split right | Cmd+D | Ctrl+Shift+D |
| Split down | Cmd+Shift+D | Ctrl+Shift+E |
| Close pane | Cmd+W | Ctrl+Shift+W |
| Copy / paste in terminal | Cmd+C / Cmd+V | Ctrl+Shift+C / Ctrl+Shift+V |
