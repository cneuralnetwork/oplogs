import * as Dialog from '@radix-ui/react-dialog'
import { useDeferredValue, useMemo, useState } from 'react'
import type { History, HistoryPoint, RunRecord } from '../types'
import { LineChart } from './LineChart'
import { filterHistory, type HistoryWindow, metricPriority } from './metric-utils'

interface RunMetricsDashboardProps {
  run: RunRecord
  history: History
  autoRefresh: boolean
  refreshing: boolean
  lastSynced: Date | null
  onAutoRefreshChange: (enabled: boolean) => void
  onRefresh: () => void
}

interface MetricGridProps {
  entries: Array<[string, HistoryPoint[]]>
  historyWindow: HistoryWindow
  smoothing: number
  emptyMessage?: string
}

const integerFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
const metricNumberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 })

const descriptions: Array<[RegExp, string]> = [
  [/^(validation|val)[/._ -].*(accuracy|acc)$/i, 'Held-out evaluation accuracy'],
  [/^(validation|val)[/._ -].*loss$/i, 'Held-out evaluation objective'],
  [/batch_accuracy/i, 'Correct predictions in the latest batch'],
  [/(^|[/._ -])loss$/i, 'Training objective over optimizer steps'],
  [/learning_rate|(^|[/._ -])lr$/i, 'Optimizer schedule'],
  [/grad_norm/i, 'Gradient magnitude before the update'],
  [/updates_per_second|throughput/i, 'Optimizer updates per second'],
  [/gpu_utilization/i, 'Accelerator compute utilization'],
  [/gpu_memory_utilization/i, 'Accelerator memory-controller activity'],
  [/vram.*allocated/i, 'VRAM held by live tensors'],
  [/vram.*reserved/i, 'VRAM reserved by the allocator'],
  [/system.*memory.*percent/i, 'Host memory currently in use'],
  [/process.*rss/i, 'Resident memory used by this process'],
  [/latent_std/i, 'Spread of learned representations'],
  [/score_rms/i, 'Root-mean-square model score'],
  [/images_seen/i, 'Training examples processed'],
  [/elapsed/i, 'Wall time since training began'],
  [/eta/i, 'Estimated time remaining'],
  [/disk_free/i, 'Available local disk capacity'],
  [/cpu_utilization/i, 'Host processor utilization'],
  [/cpu_load/i, 'One-minute host load average'],
  [/dataloader_wait/i, 'Time waiting for the next training batch'],
  [/step_time/i, 'Wall time per optimizer step'],
  [/samples_per_second/i, 'Training examples processed per second'],
  [/temperature_gpu/i, 'Accelerator thermal reading'],
  [/power_draw/i, 'Accelerator power consumption'],
  [/fan_speed/i, 'Accelerator cooling fan speed'],
]

function humanMetricName(key: string) {
  const aliases: Record<string, string> = {
    cpu_load_1m: 'CPU load (1m)',
    dataloader_wait_seconds: 'Dataloader wait',
    elapsed_seconds: 'Elapsed time',
    eta_seconds: 'ETA',
    power_draw_watts: 'Power draw',
    samples_per_second: 'Samples per second',
    step_time_seconds: 'Step time',
    temperature_gpu_c: 'GPU temperature',
  }
  if (aliases[key.toLowerCase()]) return aliases[key.toLowerCase()]
  const words = key.replaceAll(/[./_-]+/g, ' ').trim().replace(/ (percent|gib|mib)$/i, '')
  const named = words.replace(/\b(gpu|vram|cpu|rss|eta|rms|lr)\b/gi, (word) => word.toUpperCase())
  return named.charAt(0).toUpperCase() + named.slice(1)
}

function metricDescription(key: string) {
  return descriptions.find(([pattern]) => pattern.test(key))?.[1] ?? 'Recorded numeric history'
}

function metricTone(key: string) {
  if (/loss|grad/i.test(key)) return '--coral'
  if (/accuracy|throughput|updates_per_second/i.test(key)) return '--mint'
  if (/gpu|vram/i.test(key)) return '--amber'
  if (/memory|rss|disk/i.test(key)) return '--plum'
  return '--indigo'
}

function latestPoint(points: HistoryPoint[]) {
  return points.at(-1)
}

function latestValue(history: History, patterns: RegExp[]) {
  for (const [key, points] of Object.entries(history)) {
    if (patterns.some((pattern) => pattern.test(key))) {
      const point = latestPoint(points)
      if (point) return point.value
    }
  }
  return null
}

function latestStep(history: History) {
  let maximum = 0
  for (const points of Object.values(history)) {
    const step = latestPoint(points)?.step
    if (typeof step === 'number') maximum = Math.max(maximum, step)
  }
  return maximum
}

function numericConfig(run: RunRecord, keys: string[]) {
  for (const key of keys) {
    const value = Number(run.config[key])
    if (Number.isFinite(value)) return value
  }
  return null
}

function duration(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return 'Not available'
  const rounded = Math.round(seconds)
  const hours = Math.floor(rounded / 3600)
  const minutes = Math.floor((rounded % 3600) / 60)
  const remainder = rounded % 60
  return [hours, minutes, remainder].map((value) => String(value).padStart(2, '0')).join(':')
}

function metricValue(key: string, value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return 'No value'
  if (/accuracy|(^|[/._ -])acc$/i.test(key)) {
    const percentage = Math.abs(value) <= 1 ? value * 100 : value
    return `${metricNumberFormat.format(percentage)}%`
  }
  if (/percent/i.test(key)) return `${metricNumberFormat.format(value)}%`
  if (/gib/i.test(key)) return `${metricNumberFormat.format(value)} GiB`
  if (/mib/i.test(key)) return `${metricNumberFormat.format(value)} MiB`
  if (/elapsed|eta|duration/i.test(key)) return duration(value)
  if (/learning_rate|(^|[/._ -])lr$/i.test(key) || (Math.abs(value) > 0 && Math.abs(value) < 0.0001)) {
    return value.toExponential(2)
  }
  return metricNumberFormat.format(value)
}

function ProgressHeader({ run, history }: { run: RunRecord; history: History }) {
  const step = latestStep(history)
  const total = numericConfig(run, ['max_steps', 'total_steps']) ?? 0
  const progress = total > 0 ? Math.min(100, Math.max(0, 100 * step / total)) : 0
  const elapsed = latestValue(history, [/^elapsed_seconds$/i, /elapsed.*seconds/i])
  const eta = latestValue(history, [/^eta_seconds$/i, /eta.*seconds/i])
  const images = latestValue(history, [/^images_seen$/i, /images.*seen/i])
  const batch = numericConfig(run, ['effective_batch_size', 'batch_size', 'physical_batch_size'])

  return (
    <section className="run-progress" aria-label="Training progress">
      <div className="progress-count">
        <span>Training progress</span>
        <strong>{integerFormat.format(step)} <b>/ {total > 0 ? integerFormat.format(total) : 'open'}</b></strong>
      </div>
      <div className="progress-rail" role="progressbar" aria-label="Training completion" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Number(progress.toFixed(1))}>
        <span style={{ width: `${progress}%` }} />
      </div>
      <dl className="progress-details">
        <div><dt>elapsed</dt><dd>{duration(elapsed)}</dd></div>
        <div><dt>ETA</dt><dd>{duration(eta)}</dd></div>
        <div><dt>effective batch</dt><dd>{batch === null ? 'Not available' : integerFormat.format(batch)}</dd></div>
        <div><dt>images seen</dt><dd>{images === null ? 'Not available' : integerFormat.format(images)}</dd></div>
      </dl>
    </section>
  )
}

function MetricControls({
  runId,
  historyWindow,
  smoothing,
  autoRefresh,
  refreshing,
  lastSynced,
  onWindowChange,
  onSmoothingChange,
  onAutoRefreshChange,
  onRefresh,
}: {
  runId: string
  historyWindow: HistoryWindow
  smoothing: number
  autoRefresh: boolean
  refreshing: boolean
  lastSynced: Date | null
  onWindowChange: (window: HistoryWindow) => void
  onSmoothingChange: (amount: number) => void
  onAutoRefreshChange: (enabled: boolean) => void
  onRefresh: () => void
}) {
  return (
    <section className="metric-controls" aria-label="Metric display controls">
      <label className="history-control">
        <span>History</span>
        <select value={historyWindow} onChange={(event) => onWindowChange(event.target.value as HistoryWindow)}>
          <option value="all">Full run</option>
          <option value="100">100 steps</option>
          <option value="500">500 steps</option>
          <option value="2000">2,000 steps</option>
        </select>
      </label>
      <label className="smoothing-control">
        <span>Smoothing <output>{smoothing.toFixed(2)}</output></span>
        <input type="range" min="0" max="0.9" step="0.05" value={smoothing} aria-label="Smoothing" aria-valuetext={smoothing.toFixed(2)} onChange={(event) => onSmoothingChange(Number(event.target.value))} />
      </label>
      <label className="refresh-control">
        <input type="checkbox" checked={autoRefresh} onChange={(event) => onAutoRefreshChange(event.target.checked)} />
        <span>Auto refresh</span>
      </label>
      <button type="button" className="metric-control-button" onClick={onRefresh} disabled={refreshing}>
        {refreshing ? 'Refreshing' : 'Refresh now'}
      </button>
      <a className="metric-control-button" href={`/api/runs/${encodeURIComponent(runId)}/history.jsonl`} download="metrics.jsonl">Metrics JSONL</a>
      <span className="last-sync">{lastSynced ? `Synced ${lastSynced.toLocaleTimeString()}` : 'Waiting for first sync'}</span>
    </section>
  )
}

function MetricCard({
  label,
  points,
  smoothing,
  expanded = false,
  onExpand,
  onClose,
}: {
  label: string
  points: HistoryPoint[]
  smoothing: number
  expanded?: boolean
  onExpand?: () => void
  onClose?: () => void
}) {
  const latest = latestPoint(points)?.value
  return (
    <article className="metric-chart-card" data-expanded={expanded || undefined}>
      <header>
        <div><h3>{humanMetricName(label)}</h3><p>{metricDescription(label)}</p></div>
        <div className="metric-card-actions">
          <strong>{metricValue(label, latest)}</strong>
          <button type="button" onClick={expanded ? onClose : onExpand} autoFocus={expanded || undefined}>
            {expanded ? 'Close' : 'Expand'}<span className="sr-only"> {humanMetricName(label)} chart</span>
          </button>
        </div>
      </header>
      <LineChart
        series={[{ label: humanMetricName(label), points, color: metricTone(label) }]}
        height={expanded ? 560 : 220}
        compact
        smoothing={smoothing}
        fill={expanded}
      />
    </article>
  )
}

export function MetricGrid({ entries, historyWindow, smoothing, emptyMessage = 'No numeric history has arrived yet.' }: MetricGridProps) {
  const [expandedMetric, setExpandedMetric] = useState<string | null>(null)
  const visibleEntries = useMemo(
    () => entries.map(([label, points]) => [label, filterHistory(points, historyWindow)] as [string, HistoryPoint[]]),
    [entries, historyWindow],
  )

  if (visibleEntries.length === 0) return <div className="tab-empty">{emptyMessage}</div>
  const expanded = visibleEntries.find(([label]) => label === expandedMetric)
  return (
    <>
      <section className="metric-chart-grid" aria-label="Metric charts">
        {visibleEntries.map(([label, points]) => (
          <MetricCard key={label} label={label} points={points} smoothing={smoothing} onExpand={() => setExpandedMetric(label)} />
        ))}
      </section>
      <Dialog.Root open={Boolean(expanded)} onOpenChange={(open) => { if (!open) setExpandedMetric(null) }}>
        {expanded && (
          <Dialog.Portal>
            <Dialog.Overlay className="chart-focus-overlay" />
            <Dialog.Content className="chart-focus-dialog" aria-describedby={undefined}>
              <Dialog.Title className="sr-only">{humanMetricName(expanded[0])} fullscreen chart</Dialog.Title>
              <MetricCard label={expanded[0]} points={expanded[1]} smoothing={smoothing} expanded onClose={() => setExpandedMetric(null)} />
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </Dialog.Root>
    </>
  )
}

export function RunMetricsDashboard({
  run,
  history,
  autoRefresh,
  refreshing,
  lastSynced,
  onAutoRefreshChange,
  onRefresh,
}: RunMetricsDashboardProps) {
  const [historyWindow, setHistoryWindow] = useState<HistoryWindow>('all')
  const [smoothing, setSmoothing] = useState(0.15)
  const deferredSmoothing = useDeferredValue(smoothing)
  const entries = useMemo(
    () => Object.entries(history).sort(([left], [right]) => metricPriority(left) - metricPriority(right) || left.localeCompare(right)),
    [history],
  )
  return (
    <div className="run-metrics-dashboard">
      <MetricControls
        runId={run.id}
        historyWindow={historyWindow}
        smoothing={smoothing}
        autoRefresh={autoRefresh}
        refreshing={refreshing}
        lastSynced={lastSynced}
        onWindowChange={setHistoryWindow}
        onSmoothingChange={setSmoothing}
        onAutoRefreshChange={onAutoRefreshChange}
        onRefresh={onRefresh}
      />
      <ProgressHeader run={run} history={history} />
      <MetricGrid entries={entries} historyWindow={historyWindow} smoothing={deferredSmoothing} />
    </div>
  )
}
