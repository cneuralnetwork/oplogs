import * as Tabs from '@radix-ui/react-tabs'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { formatDateTime, formatTime, humanBytes } from '../format'
import type { Artifact, History, RunEvent, RunRecord, Trace } from '../types'
import { BackIcon, ExternalIcon } from './Icons'
import { LineChart } from './LineChart'

interface RunDetailProps {
  runId: string
  navigate: (path: string) => void
}

const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 })

function formatMetric(value: number) {
  const magnitude = Math.abs(value)
  if (magnitude !== 0 && (magnitude < 0.0001 || magnitude >= 1_000_000)) {
    return value.toExponential(3)
  }
  return numberFormat.format(value)
}

function metricPriority(key: string) {
  const normalized = key.toLowerCase()
  if (/^(validation|val)[/. _-].*(accuracy|acc)$/.test(normalized)) return 0
  if (/^(validation|val)[/. _-].*loss$/.test(normalized)) return 1
  if (/^train(ing)?[/. _-].*(accuracy|acc)$/.test(normalized)) return 2
  if (/^train(ing)?[/. _-].*loss$/.test(normalized)) return 3
  if (normalized.includes('accuracy') || normalized.endsWith('/acc')) return 10
  if (normalized.includes('loss')) return 11
  if (normalized.startsWith('gradients.')) return 40
  if (normalized.includes('.lr.') || normalized.endsWith('/lr')) return 41
  return 20
}

function compareMetrics([left]: [string, unknown], [right]: [string, unknown]) {
  return metricPriority(left) - metricPriority(right) || left.localeCompare(right)
}

function formatState(state: string) {
  return state.charAt(0).toUpperCase() + state.slice(1)
}

const runTabs = [
  { value: 'overview', label: 'Overview' },
  { value: 'samples', label: 'Samples' },
  { value: 'logs', label: 'Logs' },
  { value: 'system', label: 'System' },
  { value: 'traces', label: 'Traces' },
  { value: 'files', label: 'Files' },
  { value: 'source', label: 'Source' },
]

export function RunDetail({ runId, navigate }: RunDetailProps) {
  const [run, setRun] = useState<RunRecord | null>(null)
  const [history, setHistory] = useState<History>({})
  const [events, setEvents] = useState<RunEvent[]>([])
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [traces, setTraces] = useState<Trace[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    let timer = 0
    const load = async () => {
      try {
        const [nextRun, nextHistory, recentEvents, logEvents, sourceEvents, sampleEvents, nextArtifacts, nextTraces] = await Promise.all([
          api.run(runId),
          api.history(runId),
          api.events(runId, undefined, 60, true),
          api.events(runId, 'log', 2000),
          api.events(runId, 'source', 1),
          api.events(runId, 'text,json,table,histogram', 1000),
          api.runArtifacts(runId),
          api.traces(runId),
        ])
        if (active) {
          setRun(nextRun)
          setHistory(nextHistory)
          setEvents([...logEvents, ...sourceEvents, ...sampleEvents, ...recentEvents]
            .filter((event, index, all) => all.findIndex((candidate) => candidate.sequence === event.sequence) === index)
            .sort((left, right) => right.sequence - left.sequence))
          setArtifacts(nextArtifacts)
          setTraces(nextTraces)
          setError('')
          if (nextRun.state === 'running') timer = window.setTimeout(load, 2000)
        }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'Unable to load this run.')
      }
    }
    void load()
    return () => { active = false; window.clearTimeout(timer) }
  }, [runId])

  const metricEntries = useMemo(
    () => Object.entries(history)
      .filter(([key]) => !key.startsWith('system.') && !key.startsWith('process.') && !key.startsWith('gpu.'))
      .sort(compareMetrics),
    [history],
  )
  const systemEntries = useMemo(
    () => Object.entries(history).filter(([key]) => key.startsWith('system.') || key.startsWith('process.') || key.startsWith('gpu.')),
    [history],
  )
  const logs = events.filter((event) => event.kind === 'log')
  const source = events.find((event) => event.kind === 'source')
  const richSamples = events.filter((event) => ['text', 'json', 'table', 'histogram'].includes(event.kind))

  if (error) return <div className="load-error"><h1>Run unavailable</h1><p>{error}</p><button onClick={() => navigate('/')}>Back to runs</button></div>
  if (!run) return <div className="page-loading">Loading run…</div>

  const summary = Object.entries(run.summary)
    .filter(([, value]) => typeof value === 'number')
    .sort(compareMetrics)
    .slice(0, 4)

  return (
    <div className="run-page">
      <header className="run-header">
        <button className="back-button" onClick={() => navigate('/')}><BackIcon />Runs</button>
        <div className="run-title-row">
          <div><p className="page-context">{run.project}</p><h1>{run.name}</h1></div>
          <span className="run-state header-state" data-state={run.state}>{formatState(run.state)}</span>
        </div>
        <div className="run-meta"><span>{run.id}</span><span>Started {formatDateTime(run.created_at)}</span><span>{run.last_sequence + 1} events</span></div>
      </header>

      {summary.length > 0 && <section className="metric-strip" aria-label="Latest metrics">
        {summary.map(([key, value], index) => <article key={key} data-tone={['indigo', 'mint', 'coral', 'amber'][index]}><div><span>{key}</span><small>Latest recorded value</small></div><strong>{formatMetric(Number(value))}</strong></article>)}
      </section>}

      <Tabs.Root className="run-tabs" defaultValue="overview">
        <Tabs.List aria-label="Run details">
          {runTabs.map((tab) => <Tabs.Trigger key={tab.value} value={tab.value}>{tab.label}</Tabs.Trigger>)}
        </Tabs.List>
        <Tabs.Content value="overview">
          <section className="run-overview-grid">
            <div className="data-card chart-panel metrics-card">
              <div className="card-heading"><div><h2>Metric history</h2><p>Drag across the plot to inspect a range.</p></div><span>{metricEntries.length} series</span></div>
              <LineChart series={metricEntries.slice(0, 5).map(([label, points]) => ({ label, points }))} height={390} />
            </div>
            <div className="data-card configuration-card"><div className="card-heading"><div><h2>Configuration</h2><p>The exact inputs captured at start.</p></div></div><dl className="key-values">{Object.entries(run.config).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl></div>
            <div className="data-card activity-card"><div className="card-heading"><div><h2>Recent activity</h2><p>Newest journal records first.</p></div></div><ol className="activity-list">{events.slice(0, 8).map((event) => <li key={event.sequence}><span>{event.kind}</span><time>{formatTime(event.timestamp)}</time></li>)}</ol></div>
          </section>
        </Tabs.Content>
        <Tabs.Content value="samples">
          <section className="media-grid">{artifacts.filter((item) => item.artifact_type === 'image' || item.mime_type.startsWith('image/')).map((item) => <figure key={item.id}><img src={`/api/artifacts/${item.id}/content`} alt={String(item.metadata.caption ?? item.name)} /><figcaption><strong>{item.name}</strong><span>{humanBytes(item.size)}</span></figcaption></figure>)}</section>
          <section className="av-samples">{artifacts.filter((item) => item.mime_type.startsWith('audio/')).map((item) => <figure key={item.id}><figcaption>{String(item.metadata.caption ?? item.name)}</figcaption><audio controls preload="metadata" src={`/api/artifacts/${item.id}/content`} /></figure>)}{artifacts.filter((item) => item.mime_type.startsWith('video/')).map((item) => <figure key={item.id}><video controls preload="metadata" src={`/api/artifacts/${item.id}/content`} /><figcaption>{String(item.metadata.caption ?? item.name)}</figcaption></figure>)}</section>
          <section className="rich-samples">{richSamples.map((event) => <article key={event.sequence} data-kind={event.kind}><header><strong>{event.kind}</strong><time>{formatTime(event.timestamp)}</time></header>{Object.entries((event.payload.values as Record<string, unknown>) ?? {}).map(([key, value]) => <div key={key}><h3>{key}</h3>{event.kind === 'table' && typeof value === 'object' && value !== null ? <SampleTable value={value as Record<string, unknown>} /> : event.kind === 'histogram' && typeof value === 'object' && value !== null ? <SampleHistogram value={value as Record<string, unknown>} /> : <pre>{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>}</div>)}</article>)}</section>
          {artifacts.length === 0 && richSamples.length === 0 && <div className="tab-empty">No generated samples have been logged.</div>}
        </Tabs.Content>
        <Tabs.Content value="logs">
          <section className="console" aria-label="Captured console output">{logs.length ? logs.map((event) => <div key={event.sequence}><time>{formatTime(event.timestamp)}</time><span data-stream={String(event.payload.stream)}>{String(event.payload.stream)}</span><code>{String(event.payload.line)}</code></div>) : <p>No console output captured.</p>}</section>
        </Tabs.Content>
        <Tabs.Content value="system">
          <section className="data-card chart-panel"><div className="card-heading"><div><h2>System telemetry</h2><p>Process, host, and accelerator readings.</p></div></div><LineChart series={systemEntries.slice(0, 6).map(([label, points]) => ({ label, points }))} height={380} /></section>
        </Tabs.Content>
        <Tabs.Content value="traces">
          <section className="trace-list">{traces.map((trace) => <article key={trace.id}><div><strong>{trace.name}</strong><span className="trace-status" data-state={trace.status}>{formatState(trace.status)}</span></div><p>{trace.duration_ms ? `${trace.duration_ms.toFixed(1)} ms` : 'Running'}</p>{trace.error && <pre>{trace.error}</pre>}</article>)}</section>
          {traces.length === 0 && <div className="tab-empty">No spans have been recorded for this run.</div>}
        </Tabs.Content>
        <Tabs.Content value="files">
          <div className="table-wrap"><table className="data-table"><thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Digest</th><th /></tr></thead><tbody>{artifacts.map((item) => <tr key={item.id}><td><strong>{item.name}</strong></td><td>{item.artifact_type}</td><td>{humanBytes(item.size)}</td><td className="digest">{item.digest.slice(0, 14)}</td><td><a href={`/api/artifacts/${item.id}/content`}><ExternalIcon /><span className="sr-only">Open</span></a></td></tr>)}</tbody></table></div>
        </Tabs.Content>
        <Tabs.Content value="source">
          <section className="source-view"><h2>Captured workspace</h2>{source ? <pre>{JSON.stringify(source.payload, null, 2)}</pre> : <p>The source snapshot is still being prepared.</p>}</section>
        </Tabs.Content>
      </Tabs.Root>
    </div>
  )
}

function SampleTable({ value }: { value: Record<string, unknown> }) {
  const columns = Array.isArray(value.columns) ? value.columns.map(String) : []
  const rows = Array.isArray(value.rows) ? value.rows.slice(0, 50) as Array<Record<string, unknown>> : []
  return <div className="sample-table"><table><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{columns.map((column) => <td key={column}>{String(row[column] ?? '')}</td>)}</tr>)}</tbody></table>{Array.isArray(value.rows) && value.rows.length > 50 && <p>Showing 50 of {value.rows.length} rows.</p>}</div>
}

function SampleHistogram({ value }: { value: Record<string, unknown> }) {
  const counts = Array.isArray(value.counts) ? value.counts.map(Number) : []
  const maximum = Math.max(1, ...counts)
  return <div className="sample-histogram" aria-label="Histogram">{counts.map((count, index) => <span key={index} style={{ height: `${Math.max(2, count / maximum * 100)}%` }} title={String(count)} />)}</div>
}
