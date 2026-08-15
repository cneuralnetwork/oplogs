import type { HistoryPoint } from '../types'

export type HistoryWindow = 'all' | '100' | '500' | '2000'

const orderedMetricPatterns = [
  /^(train[/._ -])?loss$/i,
  /learning_rate|(^|[/._ -])lr$/i,
  /grad_norm/i,
  /updates_per_second|throughput/i,
  /gpu_utilization/i,
  /vram.*allocated/i,
  /vram.*reserved/i,
  /system.*memory.*percent/i,
  /latent_std/i,
  /score_rms/i,
  /^(validation|val)[/._ -].*loss$/i,
  /^(validation|val)[/._ -].*(accuracy|acc)$/i,
  /accuracy|(^|[/._ -])acc$/i,
]

export function metricPriority(key: string) {
  const priority = orderedMetricPatterns.findIndex((pattern) => pattern.test(key))
  return priority === -1 ? orderedMetricPatterns.length : priority
}

export function isSystemMetric(key: string) {
  return /^(system|process|gpu|vram)[/._ -]/i.test(key) || /gpu|vram|memory|disk|rss/i.test(key)
}

export function filterHistory(points: HistoryPoint[], window: HistoryWindow) {
  if (window === 'all' || points.length === 0) return points
  const count = Number(window)
  const steps = points.map((point) => point.step).filter((step): step is number => typeof step === 'number')
  if (steps.length === 0) return points.slice(-count)
  const cutoff = Math.max(...steps) - count + 1
  return points.filter((point) => point.step === null || point.step >= cutoff)
}
