import type { BurrowApi } from '../../shared/api'

declare global {
  interface Window {
    burrow: BurrowApi
  }
  /** The version from package.json, filled in at build time. */
  const __APP_VERSION__: string
}

export {}
