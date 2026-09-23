# Burrow Client: Design

Date: 2026-09-23
Status: approved in brainstorming, pending spec review

## Goal

A local-first desktop SSH client in the style of Termius, for macOS and Fedora Linux.
Everything is stored on the local machine. No accounts, no sync, no telemetry.

## Scope

### In v1

- Tabbed SSH sessions, several open at once, each tab its own connection
- Split panes inside a session tab (each pane is its own connection to the same host)
- Host profiles: name, group, host, port, user, auth method (password or key)
- Snippets: saved commands sent to the focused terminal
- Key management: generate ed25519 and RSA keys, import (file or paste), copy public key, delete
- SFTP file browser per session: list, navigate, upload, download, rename, delete, mkdir
- Known-hosts verification with trust prompt for new hosts and a blocking warning for changed fingerprints
- Encrypted vault for all secrets, unlocked by a master password

### Out of scope for v1

Port forwarding, jump hosts, broadcast input, reading or writing `~/.ssh/config` or `~/.ssh/` keys,
sync between machines, a CLI, local shell tabs, code signing.

## Tech stack

- Electron + TypeScript, built with `electron-vite`, packaged with `electron-builder`
- Renderer: React
- Terminal: xterm.js with `@xterm/addon-fit` and `@xterm/addon-web-links`
- SSH and SFTP: `ssh2`
- Crypto: Node built-in `crypto` (scrypt, AES-256-GCM)
- Tests: Vitest

## Architecture

### Processes

- **Main process** owns everything sensitive: SSH connections, SFTP, vault, key generation, file I/O.
  Each open terminal pane is a session object in main, addressed by a session id.
- **Preload** exposes a small typed API (`window.burrow`) through `contextBridge`.
- **Renderer** is UI only. `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
  The renderer never receives private keys or stored passwords. It asks main to connect a profile by id,
  and main resolves secrets from the vault itself.

### Terminal data flow

```
xterm onData → ipc "session:write" (id, data) → ssh channel.write
ssh channel data → ipc "session:data" (id, data) → xterm.write
xterm resize → ipc "session:resize" (id, cols, rows) → channel.setWindow
channel close → ipc "session:closed" (id, reason)
```

### Code layout

```
src/main/
  index.ts           app lifecycle, window creation
  menu.ts            macOS menu (Linux gets none so no accelerators steal shell keys)
  ipc.ts             registers all IPC handlers, validates input
  core.ts            Core: storage, vault and sessions, no Electron imports (testable)
  validate.ts        input validation for profiles, snippets, settings
  store/             JSON file store with atomic writes (profiles, snippets, settings, known hosts)
  vault/             vault file format, unlock, lock, read/write secrets
  keys/              key generation, import, parsing, fingerprints
  ssh/session.ts     one SSH connection + shell channel
  ssh/sftp.ts        SFTP operations on an existing connection
  ssh/hostkeys.ts    known-hosts check logic
src/preload/
  index.ts           typed bridge (window.burrow)
src/renderer/src/
  views/             Hosts, Keychain, Snippets, KnownHosts, Settings
  session/           session tab, split layout, terminal hosts, snippets drawer, SFTP browser
  components/        SidePanel, Modal, Field, dialogs
src/shared/
  types.ts, api.ts   types shared by main, preload and renderer
```

## Storage

Directory: Electron `app.getPath('userData')`, which is
`~/Library/Application Support/Burrow Client/` on macOS and `~/.config/Burrow Client/` on Linux.

| File | Content | Encrypted |
|---|---|---|
| `profiles.json` | `{ id, name, group, host, port, user, authType: "password" \| "key", keyId? }[]` | no |
| `snippets.json` | `{ id, name, command, tags? }[]` | no |
| `settings.json` | font family, font size, theme | no |
| `known_hosts.json` | `{ "host:port": { algo, fingerprint (SHA256), addedAt } }` | no |
| `keys.json` | `{ id, name, type, publicKey, fingerprint, createdAt }[]` (public data only) | no |
| `vault.enc` | secrets JSON, see below | yes |

Plain files never contain passwords, passphrases, or private keys.

All writes go to `<file>.tmp` and then `rename` over the target, so a crash cannot leave a half-written file.

### Vault

Decrypted content:

```json
{
  "version": 1,
  "passwords": { "<profileId>": "..." },
  "keys": { "<keyId>": { "privateKey": "<PEM/OpenSSH>", "passphrase": "..." } }
}
```

File format (JSON):

```json
{ "version": 1, "kdf": "scrypt", "N": 131072, "r": 8, "p": 1,
  "salt": "<b64>", "iv": "<b64>", "tag": "<b64>", "ciphertext": "<b64>" }
```

- Key derivation: scrypt with a random 16-byte salt, 32-byte output
- Cipher: AES-256-GCM with a random 12-byte IV per write; the auth tag detects wrong password and tampering
- A new IV is generated on every save
- First launch: set master password (entered twice), empty vault is created. The UI states that a forgotten password cannot be recovered.
- Later launches: unlock once. Decrypted data lives only in main-process memory. A lock button clears it and returns to the unlock screen. Locking also disconnects open sessions.
- Wrong password: "Wrong password", no lockout.

## SSH behavior

- Connect: main loads the profile, pulls the password or the private key plus passphrase from the vault, opens an `ssh2` connection, then a PTY shell (`xterm-256color`).
- If the profile has no stored password, or the key's passphrase is missing, the renderer shows a prompt. The entered value is used for this connection only unless the user ticks "save to vault".
- Split pane: opens a new, independent connection to the same profile.
- SFTP: uses the connection of the session tab's first pane (`conn.sftp()`), opened lazily when the SFTP view is first shown.
- Keepalive: `keepaliveInterval` 15s.

### Host key verification

Implemented via `ssh2`'s `hostVerifier` callback, using SHA256 fingerprints.

| State | Behavior |
|---|---|
| unknown | Dialog shows host, algorithm, fingerprint. Trust saves it and connects. Cancel aborts. |
| matches | Connect silently. |
| changed | Red warning showing old and new fingerprint. Default action is abort. "Replace & connect" requires an explicit click. |

## UI (Termius style, dark theme by default)

- **Left sidebar** in the home tab: Hosts, Keychain, Snippets, Known Hosts, Settings. Lock button at the bottom.
- **Top tab bar**: first tab is always the home view. Each session is a tab with a status dot (connecting, connected, disconnected). Tabs can be reordered and closed.
- **Hosts**: grid of host cards (icon, name, `user@host`) grouped by group, search bar on top. Double-click connects. Create and edit in a slide-in panel from the right.
- **Keychain**: list of keys (name, type, fingerprint). Generate, import from file or paste, copy public key, delete (with confirm; blocked while a profile uses the key, listing those profiles).
- **Snippets**: list with name and command, edited in the same slide-in panel.
- **Known Hosts**: list of entries, deletable.
- **Settings**: font family, font size, theme (dark/light).
- **Session tab**:
  - Terminal panes in a split layout. Dividers are draggable. Shortcuts:
    - macOS: split right `Cmd+D`, split down `Cmd+Shift+D`, close pane `Cmd+W`
    - Linux: split right `Ctrl+Shift+D`, split down `Ctrl+Shift+E`, close pane `Ctrl+Shift+W`, copy/paste `Ctrl+Shift+C`/`Ctrl+Shift+V`. Plain `Ctrl+D`, `Ctrl+W` and `Ctrl+C` stay with the shell (EOF, delete word, interrupt).
  - Snippets drawer (toggle). Clicking a snippet writes its command plus newline to the focused pane.
  - SFTP view (toggle) as a split next to the terminal. Upload via dialog or drag and drop, download via save dialog, rename, delete (with confirm), mkdir.
  - On disconnect, an overlay in the pane shows the reason and a Reconnect button.

## Error handling

- Connection errors (DNS, refused, timeout, auth failure) show as a readable message inline in the pane with Retry.
- SFTP errors show as a toast, then the file list reloads.
- A corrupt or unreadable JSON file or `vault.enc` shows an error on start. The app never overwrites it automatically. It copies the file to `<file>.broken-<timestamp>` before the user can choose to reset it.
- IPC handlers validate their input in main and reject unknown session or profile ids.

## Testing

- **Unit (Vitest)**:
  - vault: roundtrip, wrong password fails, tampered ciphertext fails, new IV on every save
  - store: atomic write, load missing file returns default, corrupt file is reported and not overwritten
  - hostkeys: unknown, match, changed
  - keys: generate ed25519 and RSA, import OpenSSH and PEM, encrypted key with passphrase, fingerprint format
- **Integration (Vitest)**: an in-process `ssh2` server on a random local port. Tests password auth, key auth, shell data roundtrip, resize, SFTP list, upload, download, and host key change detection.
- **UI**: checked manually in the running app for v1.

## Packaging

- macOS: `.dmg`, unsigned. First open needs right-click > Open.
- Fedora: `.rpm` and AppImage via `npm run build:linux`. Built and tested by the user on Fedora; only the macOS build is verified during development.
