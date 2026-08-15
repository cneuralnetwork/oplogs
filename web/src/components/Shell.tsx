import { useEffect, useRef } from 'react'
import type { ComponentType, ReactNode, SVGProps } from 'react'
import {
  ArtifactIcon,
  ProjectIcon,
  RegistryIcon,
  ReportIcon,
  RunsIcon,
  SearchIcon,
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
  { label: 'projects', path: '/projects', icon: ProjectIcon },
  { label: 'runs', path: '/', icon: RunsIcon },
  { label: 'artifacts', path: '/artifacts', icon: ArtifactIcon },
  { label: 'sweeps', path: '/sweeps', icon: SweepIcon },
  { label: 'registry', path: '/registry', icon: RegistryIcon },
  { label: 'reports', path: '/reports', icon: ReportIcon },
  { label: 'traces', path: '/traces', icon: TraceIcon },
]

interface ShellProps {
  currentPath: string
  navigate: (path: string) => void
  children: ReactNode
  search?: string
  onSearch?: (value: string) => void
  runCount?: number
  footer?: ReactNode
}

function workspaceName(path: string) {
  if (path.startsWith('/runs/')) return 'run detail'
  if (path === '/') return 'runs'
  return path.split('/').filter(Boolean)[0] ?? 'runs'
}

export function Shell({ currentPath, navigate, children, search = '', onSearch, runCount = 0, footer }: ShellProps) {
  const searchInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchInput.current?.focus()
      }
    }
    window.addEventListener('keydown', focusSearch)
    return () => window.removeEventListener('keydown', focusSearch)
  }, [])

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="wordmark" onClick={() => navigate('/')} aria-label="oplogs home">
          <svg className="wordmark-trace" viewBox="0 0 32 18" fill="none" aria-hidden="true">
            <path d="M1 13.5h5.2l3.1-9 4.2 12 3.8-8.1 3.2 5.1H31" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="wordmark-label">oplogs</span>
        </button>
        <nav aria-label="primary navigation">
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
        <button className="nav-item" data-active={currentPath === '/settings'} onClick={() => navigate('/settings')} aria-label="settings" aria-current={currentPath === '/settings' ? 'page' : undefined}>
          <SettingsIcon />
          <span>settings</span>
        </button>
        {footer}
      </aside>
      <header className="topbar">
        <label className="command-search">
          <SearchIcon />
          <span className="sr-only">search runs</span>
          <input
            ref={searchInput}
            value={search}
            onChange={(event) => onSearch?.(event.target.value)}
            placeholder="search or jump to a run"
          />
          <kbd>⌘ k</kbd>
        </label>
        <div className="workspace-context" aria-label={`current view: ${workspaceName(currentPath)}`}>
          <span>local workspace</span>
          <strong>{workspaceName(currentPath)}</strong>
        </div>
        <div className="topbar-health" title="the local daemon is connected">
          <span className="status-dot" aria-hidden="true" />
          <strong>local</strong>
          <span>{runCount} {runCount === 1 ? 'run' : 'runs'}</span>
        </div>
      </header>
      <main className="main-content">{children}</main>
    </div>
  )
}
