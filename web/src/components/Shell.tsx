import { useEffect, useRef } from 'react'
import type { ComponentType, ReactNode, SVGProps } from 'react'
import { oplogsDocsUrl, oplogsMarkUrl } from '../brand'
import { useTheme } from '../theme-context'
import {
  ArtifactIcon,
  DocsIcon,
  ProjectIcon,
  RegistryIcon,
  ReportIcon,
  RunsIcon,
  SearchIcon,
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
  search?: string
  onSearch?: (value: string) => void
  runCount?: number
  footer?: ReactNode
}

function workspaceName(path: string) {
  if (path.startsWith('/runs/')) return 'Run detail'
  if (path === '/') return 'Runs'
  const segment = path.split('/').filter(Boolean)[0] ?? 'runs'
  return segment.charAt(0).toUpperCase() + segment.slice(1)
}

export function Shell({ currentPath, navigate, children, search = '', onSearch, runCount = 0, footer }: ShellProps) {
  const searchInput = useRef<HTMLInputElement>(null)
  const { theme, toggleTheme } = useTheme()
  const nextTheme = theme === 'dark' ? 'light' : 'dark'

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
          <img className="wordmark-mark" src={oplogsMarkUrl} alt="" aria-hidden="true" />
          <span className="wordmark-label">oplogs</span>
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
        <a className="nav-item" href={oplogsDocsUrl} target="_blank" rel="noopener noreferrer" aria-label="Docs (opens in a new tab)">
          <DocsIcon />
          <span>Docs</span>
        </a>
        {footer}
      </aside>
      <header className="topbar">
        <label className="command-search">
          <SearchIcon />
          <span className="sr-only">Search runs</span>
          <input
            ref={searchInput}
            value={search}
            onChange={(event) => onSearch?.(event.target.value)}
            placeholder="Search or jump to a run"
          />
          <kbd>⌘ k</kbd>
        </label>
        <div className="workspace-context" aria-label={`Current view: ${workspaceName(currentPath)}`}>
          <span>Local workspace</span>
          <strong>{workspaceName(currentPath)}</strong>
        </div>
        <div className="topbar-health" title="The local daemon is connected">
          <span className="status-dot" aria-hidden="true" />
          <strong>Local</strong>
          <span>{runCount} {runCount === 1 ? 'run' : 'runs'}</span>
        </div>
        <button
          className="theme-toggle"
          type="button"
          aria-label={`Use ${nextTheme} mode`}
          aria-pressed={theme === 'dark'}
          title={`Use ${nextTheme} mode`}
          onClick={toggleTheme}
        >
          {nextTheme.charAt(0).toUpperCase() + nextTheme.slice(1)}
        </button>
      </header>
      <main className="main-content">{children}</main>
    </div>
  )
}
