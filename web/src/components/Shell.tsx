import type { ComponentType, ReactNode, SVGProps } from 'react'
import {
  ArtifactIcon,
  ProjectIcon,
  RegistryIcon,
  ReportIcon,
  RunsIcon,
  SettingsIcon,
  SweepIcon,
  TraceIcon,
} from './Icons'

type NavItem = {
  label: string
  path: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
}

const navigation: NavItem[] = [
  { label: 'Projects', path: '/projects', icon: ProjectIcon },
  { label: 'Runs', path: '/', icon: RunsIcon },
  { label: 'Artifacts', path: '/artifacts', icon: ArtifactIcon },
  { label: 'Sweeps', path: '/sweeps', icon: SweepIcon },
  { label: 'Registry', path: '/registry', icon: RegistryIcon },
  { label: 'Reports', path: '/reports', icon: ReportIcon },
  { label: 'Traces', path: '/traces', icon: TraceIcon },
]

interface ShellProps {
  currentPath: string
  navigate: (path: string) => void
  children: ReactNode
  footer?: ReactNode
}

export function Shell({ currentPath, navigate, children, footer }: ShellProps) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="wordmark" onClick={() => navigate('/')} aria-label="OPLOGS home">
          <svg className="wordmark-trace" viewBox="0 0 32 18" fill="none" aria-hidden="true">
            <path d="M1 13.5h5.2l3.1-9 4.2 12 3.8-8.1 3.2 5.1H31" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="wordmark-label">OPLOGS</span>
        </button>
        <nav aria-label="Primary navigation">
          {navigation.map((item) => {
            const active = item.path === '/' ? currentPath === '/' || currentPath.startsWith('/runs/') : currentPath.startsWith(item.path)
            return (
              <button key={item.path} className="nav-item" data-active={active} onClick={() => navigate(item.path)} aria-label={item.label} aria-current={active ? 'page' : undefined}>
                <item.icon />
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>
        <div className="sidebar-spacer" />
        <button className="nav-item" data-active={currentPath === '/settings'} onClick={() => navigate('/settings')} aria-label="Settings" aria-current={currentPath === '/settings' ? 'page' : undefined}>
          <SettingsIcon />
          <span>Settings</span>
        </button>
        {footer}
      </aside>
      <main className="main-content">{children}</main>
    </div>
  )
}
