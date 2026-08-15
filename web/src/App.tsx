import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { api, initializeSession } from './api'
import { EmptyState } from './components/EmptyState'
import { SearchIcon } from './components/Icons'
import { RunDetail } from './components/RunDetail'
import { RunsTable } from './components/RunsTable'
import { Shell } from './components/Shell'
import {
  ArtifactsView,
  ProjectsView,
  RegistryView,
  ReportsView,
  SettingsView,
  SweepsView,
  TracesView,
} from './components/Views'
import type {
  Artifact,
  Project,
  RegistryEntry,
  Report,
  RunRecord,
  StorageInfo,
  Sweep,
  Trace,
} from './types'

function App() {
  const [path, setPath] = useState(window.location.pathname)
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [reports, setReports] = useState<Report[]>([])
  const [sweeps, setSweeps] = useState<Sweep[]>([])
  const [registry, setRegistry] = useState<RegistryEntry[]>([])
  const [traces, setTraces] = useState<Trace[]>([])
  const [storage, setStorage] = useState<StorageInfo | null>(null)
  const [search, setSearch] = useState('')
  const [project, setProject] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const deferredSearch = useDeferredValue(search)

  const navigate = useCallback((nextPath: string) => {
    window.history.pushState({}, '', nextPath)
    setPath(nextPath)
    window.scrollTo({ top: 0, behavior: 'instant' })
  }, [])

  const loadCore = useCallback(async () => {
    try {
      const [nextRuns, nextProjects, nextStorage] = await Promise.all([
        api.runs(), api.projects(), api.storage(),
      ])
      setRuns(nextRuns)
      setProjects(nextProjects)
      setStorage(nextStorage)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to reach the local daemon')
    }
  }, [])

  const loadRoute = useCallback(async (currentPath: string) => {
    try {
      if (currentPath === '/artifacts') setArtifacts(await api.artifacts())
      else if (currentPath === '/reports') setReports(await api.reports())
      else if (currentPath === '/sweeps') setSweeps(await api.sweeps())
      else if (currentPath === '/registry') {
        const [nextRegistry, nextArtifacts] = await Promise.all([api.registry(), api.artifacts()])
        setRegistry(nextRegistry)
        setArtifacts(nextArtifacts)
      } else if (currentPath === '/traces') setTraces(await api.traces())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load this view')
    }
  }, [])

  useEffect(() => {
    const pop = () => setPath(window.location.pathname)
    window.addEventListener('popstate', pop)
    void initializeSession()
      .then(setStorage)
      .then(() => Promise.all([loadCore(), loadRoute(window.location.pathname)]))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Unable to initialize local session'))
      .finally(() => setLoading(false))
    const events = new EventSource('/api/stream')
    let refreshTimer = 0
    events.onmessage = () => {
      window.clearTimeout(refreshTimer)
      refreshTimer = window.setTimeout(() => {
        void loadCore()
        void loadRoute(window.location.pathname)
      }, 180)
    }
    const interval = window.setInterval(loadCore, 5000)
    return () => {
      window.removeEventListener('popstate', pop)
      events.close()
      window.clearTimeout(refreshTimer)
      window.clearInterval(interval)
    }
  }, [loadCore, loadRoute])

  useEffect(() => {
    void loadRoute(path)
  }, [loadRoute, path])

  const visibleRuns = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase()
    return runs.filter((run) => (!project || run.project === project) && (!needle || `${run.name} ${run.project} ${run.id}`.toLowerCase().includes(needle)))
  }, [deferredSearch, project, runs])

  const register = async (artifactId: string, collection: string) => {
    await api.register({ artifact_id: artifactId, collection, aliases: ['latest'] })
    await Promise.all([loadCore(), loadRoute(path)])
  }

  const createReport = async (title: string) => {
    await api.createReport({
      title,
      project: project || undefined,
      blocks: [
        { type: 'heading', text: 'Experiment summary' },
        { type: 'text', text: 'Add findings, charts, tables, and samples from the local report editor.' },
      ],
    })
    await Promise.all([loadCore(), loadRoute(path)])
  }

  const updateReport = async (id: string, title: string, blocks: Array<Record<string, unknown>>) => {
    await api.updateReport(id, { title, blocks })
    await loadRoute(path)
  }

  const runMatch = path.match(/^\/runs\/([^/]+)$/)
  let content: React.ReactNode
  if (runMatch) {
    content = <RunDetail runId={runMatch[1]} navigate={navigate} />
  } else if (path === '/projects') {
    content = <ProjectsView projects={projects} select={(name) => { setProject(name); navigate('/') }} />
  } else if (path === '/artifacts') {
    content = <ArtifactsView artifacts={artifacts} />
  } else if (path === '/sweeps') {
    content = <SweepsView sweeps={sweeps} />
  } else if (path === '/registry') {
    content = <RegistryView entries={registry} artifacts={artifacts} register={register} />
  } else if (path === '/reports') {
    content = <ReportsView reports={reports} create={createReport} update={updateReport} />
  } else if (path === '/traces') {
    content = <TracesView traces={traces} />
  } else if (path === '/settings') {
    content = <SettingsView storage={storage} />
  } else {
    content = (
      <div className="runs-page">
        <header className="page-header runs-heading">
          <div><h1>Runs</h1><p>Every experiment on this machine, live and retained.</p></div>
          {runs.length > 0 && <div className="run-count">{visibleRuns.length} of {runs.length}</div>}
        </header>
        {runs.length === 0 && !loading ? <EmptyState /> : <>
          <div className="table-tools">
            <label className="search-field"><SearchIcon /><span className="sr-only">Search runs</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search runs" /></label>
            <label className="select-field"><span className="sr-only">Filter project</span><select value={project} onChange={(event) => setProject(event.target.value)}><option value="">All projects</option>{projects.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
          </div>
          <RunsTable runs={visibleRuns} onSelect={(run) => navigate(`/runs/${run.id}`)} />
          {!visibleRuns.length && <div className="tab-empty">No runs match this filter.</div>}
        </>}
      </div>
    )
  }

  return (
    <Shell currentPath={path} navigate={navigate} footer={<div className="local-status">localhost<br /><span>{storage ? `${storage.runs} retained runs` : 'connecting'}</span></div>}>
      {error && <div className="global-error" role="alert">{error}</div>}
      {loading && <div className="page-loading">Connecting to the local store…</div>}
      {!loading && content}
    </Shell>
  )
}

export default App
