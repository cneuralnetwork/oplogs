import * as Dialog from '@radix-ui/react-dialog'
import { useState } from 'react'
import { formatDateTime, humanBytes } from '../format'
import type { Artifact, Project, RegistryEntry, Report, RunRecord, StorageInfo, Sweep, Trace } from '../types'
import { ExternalIcon } from './Icons'
import { RunsTable } from './RunsTable'

interface ProjectsViewProps {
  projects: Project[]
  runs: RunRecord[]
  selectProject: (project: string) => void
  selectRun: (run: RunRecord) => void
}

export function ProjectsView({ projects, runs, selectProject, selectRun }: ProjectsViewProps) {
  return (
    <Page title="Projects" note="Every run is retained locally and appears here automatically.">
      <div className="project-list">
        {projects.map((project) => (
          <button key={project.name} onClick={() => selectProject(project.name)}>
            <div>
              <strong>{project.name}</strong>
              <span>{project.run_count} {project.run_count === 1 ? 'run' : 'runs'}</span>
            </div>
            <time>{formatDateTime(project.updated_at)}</time>
          </button>
        ))}
      </div>
      <section className="data-card runs-ledger projects-runs-ledger">
        <header className="card-heading">
          <div>
            <h2>All runs</h2>
            <p>Running experiments update live; completed experiments stay here.</p>
          </div>
          <span>{runs.length} retained</span>
        </header>
        {runs.length
          ? <RunsTable runs={runs} onSelect={selectRun} />
          : <div className="tab-empty">Your local runs will appear here.</div>}
      </section>
    </Page>
  )
}

export function ArtifactsView({ artifacts }: { artifacts: Artifact[] }) {
  return <Page title="Artifacts" note="Content-addressed files are deduplicated locally and never uploaded."><div className="artifact-list">{artifacts.map((item) => <article key={item.id}>{item.mime_type.startsWith('image/') ? <img src={`/api/artifacts/${item.id}/content`} alt="" /> : <div className="file-type">{item.artifact_type}</div>}<div><strong>{item.name}</strong><span>{humanBytes(item.size)} · {item.digest.slice(0, 12)}</span></div><a href={`/api/artifacts/${item.id}/content`}><ExternalIcon /><span className="sr-only">Open {item.name}</span></a></article>)}</div>{artifacts.length === 0 && <div className="tab-empty">Files logged with run.log() will appear here.</div>}</Page>
}

export function SweepsView({ sweeps }: { sweeps: Sweep[] }) {
  return <Page title="Sweeps" note="Local agents launch isolated subprocess trials with explicit concurrency and GPU limits."><div className="command-hint"><code>oplogs sweep sweep.yaml python train.py</code></div><div className="record-list">{sweeps.map((sweep) => <article key={sweep.id}><div><strong>{sweep.name}</strong><span>{sweep.project}</span></div><span className="run-state" data-state={sweep.state}>{sweep.state.charAt(0).toUpperCase() + sweep.state.slice(1)}</span></article>)}</div></Page>
}

export function RegistryView({ entries, artifacts, register }: { entries: RegistryEntry[]; artifacts: Artifact[]; register: (artifactId: string, collection: string) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [artifactId, setArtifactId] = useState(artifacts[0]?.id ?? '')
  const [collection, setCollection] = useState('models')
  return <Page title="Registry" note="Promote immutable artifact versions with local aliases and lineage."><Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Trigger asChild><button className="primary-action" disabled={!artifacts.length}>Register artifact</button></Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog"><Dialog.Title>Register artifact</Dialog.Title><Dialog.Description>Create a new version in a local collection.</Dialog.Description><label>Artifact<select value={artifactId} onChange={(event) => setArtifactId(event.target.value)}>{artifacts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Collection<input value={collection} onChange={(event) => setCollection(event.target.value)} /></label><button className="primary-action" onClick={() => void register(artifactId, collection).then(() => setOpen(false))}>Create version</button><Dialog.Close className="dialog-close">Cancel</Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root><div className="registry-list">{entries.map((entry) => <article key={entry.id}><div><strong>{entry.collection}</strong><span>v{entry.version}</span></div><p>{entry.artifact_name}</p><div>{entry.aliases.map((alias) => <span key={alias} className="plain-alias">{alias}</span>)}</div></article>)}</div>{entries.length === 0 && <div className="tab-empty">Registered model and dataset versions will appear here.</div>}</Page>
}

export function ReportsView({ reports, create, update }: { reports: Report[]; create: (title: string) => Promise<void>; update: (id: string, title: string, blocks: Array<Record<string, unknown>>) => Promise<void> }) {
  const [title, setTitle] = useState('Experiment findings')
  const [editing, setEditing] = useState<Report | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [blocks, setBlocks] = useState('[]')
  const [editorError, setEditorError] = useState('')
  const openEditor = (report: Report) => { setEditing(report); setEditTitle(report.title); setBlocks(JSON.stringify(report.blocks, null, 2)); setEditorError('') }
  const save = async () => {
    if (!editing) return
    try {
      const parsed = JSON.parse(blocks)
      if (!Array.isArray(parsed)) throw new Error('Blocks must be a JSON array.')
      await update(editing.id, editTitle, parsed)
      setEditing(null)
    } catch (reason) {
      setEditorError(reason instanceof Error ? reason.message : 'Invalid report blocks.')
    }
  }
  return <Page title="Reports" note="Compose local narratives and export them as self-contained HTML or PDF."><div className="inline-create"><input aria-label="Report title" value={title} onChange={(event) => setTitle(event.target.value)} /><button className="primary-action" onClick={() => void create(title)}>New report</button></div><div className="record-list report-list">{reports.map((report) => <article key={report.id}><div><strong>{report.title}</strong><span>{report.blocks.length} blocks · Updated {formatDateTime(report.updated_at)}</span></div><div className="report-actions"><button onClick={() => openEditor(report)}>Edit</button><a href={`/api/reports/${report.id}/export.html`}><ExternalIcon />HTML</a><a href={`/api/reports/${report.id}/export.pdf`}><ExternalIcon />PDF</a></div></article>)}</div><Dialog.Root open={Boolean(editing)} onOpenChange={(open) => { if (!open) setEditing(null) }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog report-dialog"><Dialog.Title>Edit report</Dialog.Title><Dialog.Description>Blocks support heading, text, markdown, metric, table, and media types.</Dialog.Description><label>Title<input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} /></label><label>Blocks JSON<textarea value={blocks} onChange={(event) => setBlocks(event.target.value)} spellCheck={false} /></label>{editorError && <p className="form-error" role="alert">{editorError}</p>}<button className="primary-action" onClick={() => void save()}>Save report</button><Dialog.Close className="dialog-close">Cancel</Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root></Page>
}

export function TracesView({ traces }: { traces: Trace[] }) {
  return <Page title="Traces" note="Nested Python, LLM, and agent operations stay attached to the experiment that produced them."><div className="trace-list">{traces.map((trace) => <article key={trace.id}><div><strong>{trace.name}</strong><span className="trace-status" data-state={trace.status}>{trace.status.charAt(0).toUpperCase() + trace.status.slice(1)}</span></div><p>{trace.duration_ms ? `${trace.duration_ms.toFixed(1)} ms` : 'Running'} · {trace.run_id}</p>{trace.error && <pre>{trace.error}</pre>}</article>)}</div>{traces.length === 0 && <div className="tab-empty">Decorate a function with @oplogs.trace to see it here.</div>}</Page>
}

export function SettingsView({ storage }: { storage: StorageInfo | null }) {
  return <Page title="Settings" note="oplogs binds to localhost, works offline, and never deletes runs automatically."><div className="settings-grid"><section><h2>Storage</h2>{storage && <dl className="key-values"><div><dt>Location</dt><dd>{storage.root}</dd></div><div><dt>Used</dt><dd>{humanBytes(storage.bytes)}</dd></div><div><dt>Runs</dt><dd>{storage.runs}</dd></div><div><dt>Events</dt><dd>{storage.events.toLocaleString()}</dd></div></dl>}</section><section><h2>Commands</h2><pre><code>oplogs doctor{`\n`}oplogs storage{`\n`}oplogs rebuild{`\n`}oplogs alert --event exception{`\n`}oplogs stop</code></pre></section></div></Page>
}

function Page({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return <div className="standard-page"><header className="page-header"><h1>{title}</h1><p>{note}</p></header>{children}</div>
}
