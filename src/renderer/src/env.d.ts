/// <reference types="vite/client" />

declare global {
  /** The version from package.json, filled in at build time. */
  const __APP_VERSION__: string
}

export {}
