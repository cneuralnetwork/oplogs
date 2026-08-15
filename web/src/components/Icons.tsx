import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

function Mark({ children, ...props }: IconProps) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" width="20" height="20" {...props}>
      {children}
    </svg>
  )
}

const stroke = { stroke: 'currentColor', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, strokeWidth: 1.8 }

export const ProjectIcon = (props: IconProps) => <Mark {...props}><path {...stroke} d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2" /></Mark>
export const RunsIcon = (props: IconProps) => <Mark {...props}><path {...stroke} d="M3 12h4.5L9 6l4 12 2-9 1.5 3H21" /></Mark>
export const ArtifactIcon = (props: IconProps) => <Mark {...props}><path {...stroke} d="m12 3 8 4.5v9L12 21l-8-4.5v-9Zm0 9 8-4.5M12 12v9m0-9L4 7.5m12-2.25-8 4.5" /></Mark>
export const DocsIcon = (props: IconProps) => <Mark {...props}><path {...stroke} d="M12 7v14M3 18a1 1 0 0 1-1-1V5a2 2 0 0 1 2-2h5a3 3 0 0 1 3 3v15a3 3 0 0 0-3-3H3Zm18 0a1 1 0 0 0 1-1V5a2 2 0 0 0-2-2h-5a3 3 0 0 0-3 3v15a3 3 0 0 1 3-3h6Z" /></Mark>
export const ReportIcon = (props: IconProps) => <Mark {...props}><path {...stroke} d="M7 3h8l4 4v14H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm8 0v5h4M9 17v-4m3 4V9m3 8v-2" /></Mark>
export const TraceIcon = (props: IconProps) => <Mark {...props}><path {...stroke} d="M6 4v16m0-11h6a3 3 0 0 0 3-3V4m-9 11h8a4 4 0 0 1 4 4v1M3 4h6M3 20h6m6-16h6m-3 16h3" /></Mark>
export const SweepIcon = (props: IconProps) => <Mark {...props}><path {...stroke} d="M4 6h6m4 0h6M4 12h10m4 0h2M4 18h2m4 0h10M10 3v6m4 0v6m-8 0v6" /></Mark>
export const RegistryIcon = (props: IconProps) => <Mark {...props}><ellipse {...stroke} cx="12" cy="6" rx="8" ry="3" /><path {...stroke} d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></Mark>
export const SearchIcon = (props: IconProps) => <Mark {...props}><circle {...stroke} cx="11" cy="11" r="6" /><path {...stroke} d="m16 16 4 4" /></Mark>
export const ChevronIcon = (props: IconProps) => <Mark {...props}><path {...stroke} d="m9 18 6-6-6-6" /></Mark>
export const BackIcon = (props: IconProps) => <Mark {...props}><path {...stroke} d="m15 18-6-6 6-6" /></Mark>
export const ExternalIcon = (props: IconProps) => <Mark {...props}><path {...stroke} d="M14 5h5v5m0-5-8 8M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /></Mark>
