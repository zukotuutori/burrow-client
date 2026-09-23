import type { ReactNode } from 'react'

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export const ServerIcon = () => (
  <Svg>
    <rect x="3" y="4" width="18" height="7" rx="2" />
    <rect x="3" y="13" width="18" height="7" rx="2" />
    <path d="M7 7.5h.01M7 16.5h.01" />
  </Svg>
)
export const KeyIcon = () => (
  <Svg>
    <circle cx="8" cy="15" r="4" />
    <path d="M11 12l9-9M17 6l3 3M15 8l2 2" />
  </Svg>
)
export const CodeIcon = () => (
  <Svg>
    <path d="M9 7l-5 5 5 5M15 7l5 5-5 5" />
  </Svg>
)
export const ShieldIcon = () => (
  <Svg>
    <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
  </Svg>
)
export const SettingsIcon = () => (
  <Svg>
    <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" />
    <circle cx="16" cy="6" r="2" />
    <circle cx="10" cy="12" r="2" />
    <circle cx="18" cy="18" r="2" />
  </Svg>
)
export const LockIcon = () => (
  <Svg>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </Svg>
)
export const PlusIcon = () => (
  <Svg>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)
export const EditIcon = () => (
  <Svg>
    <path d="M4 20h4L19 9l-4-4L4 16z" />
  </Svg>
)
export const PlayIcon = () => (
  <Svg>
    <path d="M7 5l12 7-12 7z" />
  </Svg>
)
export const FolderIcon = () => (
  <Svg>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
)
export const FileIcon = () => (
  <Svg>
    <path d="M6 3h8l4 4v14H6z" />
    <path d="M14 3v4h4" />
  </Svg>
)
export const SplitRightIcon = () => (
  <Svg>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M12 4v16" />
  </Svg>
)
export const SplitDownIcon = () => (
  <Svg>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 12h18" />
  </Svg>
)
export const RefreshIcon = () => (
  <Svg>
    <path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" />
  </Svg>
)
export const UpIcon = () => (
  <Svg>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Svg>
)

/** The app mark: a hill with a burrow entrance. */
export const BurrowMark = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M2 20a10 10 0 0 1 20 0z" fill="var(--accent)" />
    <path d="M8 20a4 4 0 0 1 8 0z" fill="var(--bg)" />
  </svg>
)
