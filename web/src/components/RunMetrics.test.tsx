// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { History, RunRecord } from '../types'
import { RunMetricsDashboard } from './RunMetrics'

vi.mock('./LineChart', () => ({
  LineChart: ({ series, smoothing }: { series: Array<{ label: string; points: unknown[] }>; smoothing: number }) => (
    <div data-testid={`chart-${series[0].label}`}>{series[0].label}: {series[0].points.length} points at {smoothing.toFixed(2)}</div>
  ),
}))

afterEach(cleanup)

const run: RunRecord = {
  id: 'run-coco-123',
  project: 'digit-detection',
  name: 'tiny-cnn',
  state: 'running',
  created_at: '2026-08-16T10:00:00Z',
  updated_at: '2026-08-16T10:03:00Z',
  config: { max_steps: 2000, effective_batch_size: 32 },
  tags: [],
  source: {},
  summary: {},
  last_sequence: 12,
}

function points(values: Array<[number, number]>) {
  return values.map(([step, value]) => ({ value, step, timestamp: `2026-08-16T10:${step}:00Z`, rank: 0 }))
}

const history: History = {
  score_rms: points([[1, 1.8], [2000, 1.4]]),
  gpu_utilization_percent: points([[1, 70], [2000, 96]]),
  loss: points([[1, 1.1], [950, 0.5], [1050, 0.3], [2000, 0.13]]),
  learning_rate: points([[1, 0.000001], [2000, 0.0000572]]),
  grad_norm: points([[1, 1.5], [2000, 0.08]]),
  updates_per_second: points([[1, 1.7], [2000, 0.86]]),
  vram_allocated_gib: points([[1, 0.3], [2000, 0.46]]),
  system_memory_percent: points([[1, 22], [2000, 62.64]]),
  elapsed_seconds: points([[2000, 18530]]),
  eta_seconds: points([[2000, 62702]]),
  images_seen: points([[2000, 990976]]),
}

describe('RunMetricsDashboard', () => {
  it('renders COCO-style run details and one ordered chart per metric', () => {
    render(
      <RunMetricsDashboard
        run={run}
        history={history}
        autoRefresh
        refreshing={false}
        lastSynced={new Date('2026-08-16T10:03:00Z')}
        onAutoRefreshChange={vi.fn()}
        onRefresh={vi.fn()}
      />,
    )

    const progress = screen.getByLabelText('Training progress')
    expect(within(progress).getByText('2,000')).toBeVisible()
    expect(within(progress).getByText('/ 2,000')).toBeVisible()
    expect(within(progress).getByText('05:08:50')).toBeVisible()
    expect(within(progress).getByText('17:25:02')).toBeVisible()
    expect(within(progress).getByText('990,976')).toBeVisible()
    expect(within(progress).getByText('32')).toBeVisible()

    const headings = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)
    expect(headings.slice(0, 8)).toEqual([
      'Loss',
      'Learning rate',
      'Grad norm',
      'Updates per second',
      'GPU utilization',
      'VRAM allocated',
      'System memory',
      'Score RMS',
    ])
    expect(screen.getAllByTestId(/^chart-/)).toHaveLength(Object.keys(history).length)
  })

  it('supports history, smoothing, refresh, JSONL export, and fullscreen controls', async () => {
    const onAutoRefreshChange = vi.fn()
    const onRefresh = vi.fn()
    render(
      <RunMetricsDashboard
        run={run}
        history={history}
        autoRefresh
        refreshing={false}
        lastSynced={null}
        onAutoRefreshChange={onAutoRefreshChange}
        onRefresh={onRefresh}
      />,
    )

    fireEvent.change(screen.getByRole('combobox', { name: 'History' }), { target: { value: '100' } })
    expect(screen.getByTestId('chart-Loss')).toHaveTextContent('Loss: 1 points')

    fireEvent.change(screen.getByRole('slider', { name: /Smoothing/i }), { target: { value: '0.3' } })
    expect(screen.getByText('0.30')).toBeVisible()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Auto refresh' }))
    expect(onAutoRefreshChange).toHaveBeenCalledWith(false)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }))
    expect(onRefresh).toHaveBeenCalledOnce()

    const exportLink = screen.getByRole('link', { name: 'Metrics JSONL' })
    expect(exportLink).toHaveAttribute('href', '/api/runs/run-coco-123/history.jsonl')
    expect(exportLink).toHaveAttribute('download', 'metrics.jsonl')

    fireEvent.click(screen.getByRole('button', { name: 'Expand Loss chart' }))
    expect(screen.getByRole('dialog', { name: 'Loss fullscreen chart' })).toBeVisible()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Loss fullscreen chart' })).not.toBeInTheDocument())
  })
})
