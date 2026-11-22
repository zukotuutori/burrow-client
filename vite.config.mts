import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }

// The UI lives in src/renderer. Tauri loads it from the dev server, or from out/renderer in a build.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { outDir: '../../out/renderer', emptyOutDir: true, target: 'es2022' }
})
