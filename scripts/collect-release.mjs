// Copies the Tauri bundles to dist/ under the release file names (burrowclient.dmg, .AppImage, .rpm) and writes
// latest-linux.yml next to the AppImage. The AppImage update checks its download against the SHA-512 in there.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const bundles = 'src-tauri/target/release/bundle'
const out = 'dist'
mkdirSync(out, { recursive: true })

const find = (dir, ext) =>
  existsSync(join(bundles, dir)) ? readdirSync(join(bundles, dir)).filter((f) => f.endsWith(ext)).map((f) => join(bundles, dir, f)) : []

for (const [dir, ext, name] of [
  ['dmg', '.dmg', 'burrowclient.dmg'],
  ['appimage', '.AppImage', 'burrowclient.AppImage'],
  ['rpm', '.rpm', 'burrowclient.rpm']
]) {
  const [file] = find(dir, ext)
  if (!file) continue
  copyFileSync(file, join(out, name))
  console.log(`${file} -> ${join(out, name)}`)
  if (ext === '.AppImage') {
    const target = join(out, name)
    const sha512 = createHash('sha512').update(readFileSync(target)).digest('base64')
    const yml = [
      `version: ${version}`,
      'files:',
      `  - url: ${name}`,
      `    sha512: ${sha512}`,
      `    size: ${statSync(target).size}`,
      `path: ${name}`,
      `sha512: ${sha512}`,
      `releaseDate: '${new Date().toISOString()}'`,
      ''
    ].join('\n')
    writeFileSync(join(out, 'latest-linux.yml'), yml)
    console.log(`wrote ${join(out, 'latest-linux.yml')}`)
  }
}
