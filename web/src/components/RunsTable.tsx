import type { RunRecord } from '../types'
import { formatDateTime } from '../format'
import { ChevronIcon } from './Icons'

interface RunsTableProps {
  runs: RunRecord[]
  onSelect: (run: RunRecord) => void
}

function formatDuration(run: RunRecord) {
  const start = new Date(run.created_at).getTime()
  const end = run.finished_at ? new Date(run.finished_at).getTime() : Date.now()
  const seconds = Math.max(0, Math.floor((end - start) / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`
}

function primaryMetric(run: RunRecord) {
  const candidate = Object.entries(run.summary).find(([, value]) => typeof value === 'number')
  return candidate ? `${candidate[0]} ${Number(candidate[1]).toLocaleString(undefined, { maximumFractionDigits: 4 })}` : 'Waiting for metrics'
}

function formatState(state: string) {
  return state.charAt(0).toUpperCase() + state.slice(1)
}

export function RunsTable({ runs, onSelect }: RunsTableProps) {
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">State</th>
            <th scope="col">Run</th>
            <th scope="col">Project</th>
            <th scope="col">Updated</th>
            <th scope="col">Duration</th>
            <th scope="col">Latest metric</th>
            <th aria-label="Open" />
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id} onClick={() => onSelect(run)} tabIndex={0} onKeyDown={(event) => event.key === 'Enter' && onSelect(run)}>
              <td><span className="run-state" data-state={run.state}>{formatState(run.state)}</span></td>
              <td><strong>{run.name}</strong><small>{run.id}</small></td>
              <td>{run.project}</td>
              <td>{formatDateTime(run.updated_at)}</td>
              <td>{formatDuration(run)}</td>
              <td className="metric-cell">{primaryMetric(run)}</td>
              <td><ChevronIcon className="row-chevron" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
