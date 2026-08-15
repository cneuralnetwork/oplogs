import * as Dialog from '@radix-ui/react-dialog'
import { useState } from 'react'
import { formatDateTime, humanBytes } from '../format'
import type { Artifact, Project, RegistryEntry, Report, StorageInfo, Sweep, Trace } from '../types'
import { ExternalIcon } from './Icons'

export function ProjectsView({ projects, select }: { projects: Project[]; select: (project: string) => void }) {
  return <Page title="projects" note="runs are grouped by the project name passed to oplogs.init()."><div className="project-list">{projects.map((project) => <button key={project.name} onClick={() => select(project.name)}><div><strong>{project.name}</strong><span>{project.run_count} runs</span></div><time>{formatDateTime(project.updated_at)}</time></button>)}</div></Page>
}

export function ArtifactsView({ artifacts }: { artifacts: Artifact[] }) {
  return <Page title="artifacts" note="content-addressed files are deduplicated locally and never uploaded."><div className="artifact-list">{artifacts.map((item) => <article key={item.id}>{item.mime_type.startsWith('image/') ? <img src={`/api/artifacts/${item.id}/content`} alt="" /> : <div className="file-type">{item.artifact_type}</div>}<div><strong>{item.name}</strong><span>{humanBytes(item.size)} · {item.digest.slice(0, 12)}</span></div><a href={`/api/artifacts/${item.id}/content`}><ExternalIcon /><span className="sr-only">open {item.name}</span></a></article>)}</div>{artifacts.length === 0 && <div className="tab-empty">files logged with run.log() will appear here.</div>}</Page>
}

export function SweepsView({ sweeps }: { sweeps: Sweep[] }) {
  return <Page title="sweeps" note="local agents launch isolated subprocess trials with explicit concurrency and gpu limits."><div className="command-hint"><code>oplogs sweep sweep.yaml python train.py</code></div><div className="record-list">{sweeps.map((sweep) => <article key={sweep.id}><div><strong>{sweep.name}</strong><span>{sweep.project}</span></div><span className="run-state" data-state={sweep.state}>{sweep.state}</span></article>)}</div></Page>
}

export function RegistryView({ entries, artifacts, register }: { entries: RegistryEntry[]; artifacts: Artifact[]; register: (artifactId: string, collection: string) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [artifactId, setArtifactId] = useState(artifacts[0]?.id ?? '')
  const [collection, setCollection] = useState('models')
  return <Page title="registry" note="promote immutable artifact versions with local aliases and lineage."><Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Trigger asChild><button className="primary-action" disabled={!artifacts.length}>register artifact</button></Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog"><Dialog.Title>register artifact</Dialog.Title><Dialog.Description>create a new version in a local collection.</Dialog.Description><label>artifact<select value={artifactId} onChange={(event) => setArtifactId(event.target.value)}>{artifacts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>collection<input value={collection} onChange={(event) => setCollection(event.target.value)} /></label><button className="primary-action" onClick={() => void register(artifactId, collection).then(() => setOpen(false))}>create version</button><Dialog.Close className="dialog-close">cancel</Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root><div className="registry-list">{entries.map((entry) => <article key={entry.id}><div><strong>{entry.collection}</strong><span>v{entry.version}</span></div><p>{entry.artifact_name}</p><div>{entry.aliases.map((alias) => <span key={alias} className="plain-alias">{alias}</span>)}</div></article>)}</div>{entries.length === 0 && <div className="tab-empty">registered model and dataset versions will appear here.</div>}</Page>
}

export function ReportsView({ reports, create, update }: { reports: Report[]; create: (title: string) => Promise<void>; update: (id: string, title: string, blocks: Array<Record<string, unknown>>) => Promise<void> }) {
  const [title, setTitle] = useState('experiment findings')
  const [editing, setEditing] = useState<Report | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [blocks, setBlocks] = useState('[]')
  const [editorError, setEditorError] = useState('')
  const openEditor = (report: Report) => { setEditing(report); setEditTitle(report.title); setBlocks(JSON.stringify(report.blocks, null, 2)); setEditorError('') }
  const save = async () => {
    if (!editing) return
    try {
      const parsed = JSON.parse(blocks)
      if (!Array.isArray(parsed)) throw new Error('blocks must be a json array.')
      await update(editing.id, editTitle, parsed)
      setEditing(null)
    } catch (reason) {
      setEditorError(reason instanceof Error ? reason.message : 'invalid report blocks')
    }
  }
  return <Page title="reports" note="compose local narratives and export them as self-contained html or pdf."><div className="inline-create"><input aria-label="report title" value={title} onChange={(event) => setTitle(event.target.value)} /><button className="primary-action" onClick={() => void create(title)}>new report</button></div><div className="record-list report-list">{reports.map((report) => <article key={report.id}><div><strong>{report.title}</strong><span>{report.blocks.length} blocks · updated {formatDateTime(report.updated_at)}</span></div><div className="report-actions"><button onClick={() => openEditor(report)}>edit</button><a href={`/api/reports/${report.id}/export.html`}><ExternalIcon />html</a><a href={`/api/reports/${report.id}/export.pdf`}><ExternalIcon />pdf</a></div></article>)}</div><Dialog.Root open={Boolean(editing)} onOpenChange={(open) => { if (!open) setEditing(null) }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog report-dialog"><Dialog.Title>edit report</Dialog.Title><Dialog.Description>blocks support heading, text, markdown, metric, table, and media types.</Dialog.Description><label>title<input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} /></label><label>blocks json<textarea value={blocks} onChange={(event) => setBlocks(event.target.value)} spellCheck={false} /></label>{editorError && <p className="form-error" role="alert">{editorError}</p>}<button className="primary-action" onClick={() => void save()}>save report</button><Dialog.Close className="dialog-close">cancel</Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root></Page>
}

export function TracesView({ traces }: { traces: Trace[] }) {
  return <Page title="traces" note="nested python, llm, and agent operations stay attached to the experiment that produced them."><div className="trace-list">{traces.map((trace) => <article key={trace.id}><div><strong>{trace.name}</strong><span className="trace-status" data-state={trace.status}>{trace.status}</span></div><p>{trace.duration_ms ? `${trace.duration_ms.toFixed(1)} ms` : 'running'} · {trace.run_id}</p>{trace.error && <pre>{trace.error}</pre>}</article>)}</div>{traces.length === 0 && <div className="tab-empty">decorate a function with @oplogs.trace to see it here.</div>}</Page>
}

export function SettingsView({ storage }: { storage: StorageInfo | null }) {
  return <Page title="settings" note="oplogs binds to localhost, works offline, and never deletes runs automatically."><div className="settings-grid"><section><h2>storage</h2>{storage && <dl className="key-values"><div><dt>location</dt><dd>{storage.root}</dd></div><div><dt>used</dt><dd>{humanBytes(storage.bytes)}</dd></div><div><dt>runs</dt><dd>{storage.runs}</dd></div><div><dt>events</dt><dd>{storage.events.toLocaleString()}</dd></div></dl>}</section><section><h2>commands</h2><pre><code>oplogs doctor{`\n`}oplogs storage{`\n`}oplogs rebuild{`\n`}oplogs alert --event exception{`\n`}oplogs stop</code></pre></section></div></Page>
}

function Page({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return <div className="standard-page"><header className="page-header"><h1>{title}</h1><p>{note}</p></header>{children}</div>
}
