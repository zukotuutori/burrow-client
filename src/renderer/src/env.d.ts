import type { BurrowApi } from '../../shared/api'

declare global {
  interface Window {
    burrow: BurrowApi
  }
}

export {}
