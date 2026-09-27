import { readFileSync } from 'node:fs'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()],
    define: { __APP_VERSION__: JSON.stringify(version) }
  }
})
