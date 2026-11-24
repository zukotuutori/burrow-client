// Copies the Tauri bundles to dist/ under the release file names (burrowclient.dmg, burrowclient.AppImage).
// The AppImage update checks its download against the SHA-256 GitHub computes on upload, so nothing else is needed.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const bundles = 'src-tauri/target/release/bundle'
const out = 'dist'
mkdirSync(out, { recursive: true })

const find = (dir, ext) =>
  existsSync(join(bundles, dir)) ? readdirSync(join(bundles, dir)).filter((f) => f.endsWith(ext)).map((f) => join(bundles, dir, f)) : []

for (const [dir, ext, name] of [
  ['dmg', '.dmg', 'burrowclient.dmg'],
  ['appimage', '.AppImage', 'burrowclient.AppImage']
]) {
  const [file] = find(dir, ext)
  if (!file) continue
  copyFileSync(file, join(out, name))
  console.log(`${file} -> ${join(out, name)}`)
}

