import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import { useTheme } from '../theme-context'
import type { HistoryPoint } from '../types'

interface LineChartProps {
  series: Array<{ label: string; points: HistoryPoint[]; color?: string }>
  height?: number
  compact?: boolean
  smoothing?: number
  fill?: boolean
}

function smooth(values: Array<number | null>, amount: number) {
  if (amount <= 0) return values
  let previous: number | null = null
  return values.map((value) => {
    if (value === null) return null
    previous = previous === null ? value : amount * previous + (1 - amount) * value
    return previous
  })
}

export function LineChart({ series, height = 280, compact = false, smoothing = 0, fill = false }: LineChartProps) {
  const host = useRef<HTMLDivElement>(null)
  const { theme } = useTheme()

  useEffect(() => {
    if (!host.current || series.length === 0) return
    const allSteps = Array.from(new Set(series.flatMap((item) => item.points.map((point, index) => point.step ?? index)))).sort((a, b) => a - b)
    const data: uPlot.AlignedData = [
      allSteps,
      ...series.map((item) => {
        const lookup = new Map(item.points.map((point, index) => [point.step ?? index, point.value]))
        return smooth(allSteps.map((step) => lookup.get(step) ?? null), smoothing)
      }),
    ]
    const styles = getComputedStyle(document.documentElement)
    const palette = ['--indigo', '--coral', '--mint', '--plum', '--amber'].map((name) => styles.getPropertyValue(name).trim())
    const axis = styles.getPropertyValue('--chart-axis').trim()
    const grid = styles.getPropertyValue('--chart-grid').trim()
    const tick = styles.getPropertyValue('--chart-tick').trim()
    const initialHeight = fill ? Math.max(220, host.current.clientHeight) : height
    const plot = new uPlot(
      {
        width: host.current.clientWidth,
        height: initialHeight,
        cursor: { drag: { x: true, y: false } },
        legend: { show: !compact },
        scales: { x: { time: false } },
        axes: [
          { stroke: axis, grid: { stroke: grid, width: 1 }, ticks: { stroke: tick }, font: '11px "Geist UI"' },
          { stroke: axis, grid: { stroke: grid, width: 1 }, ticks: { stroke: tick }, font: '11px "Geist UI"', size: 52 },
        ],
        series: [
          { label: 'Value' },
          ...series.map((item, index) => ({
            label: item.label,
            stroke: item.color?.startsWith('--') ? styles.getPropertyValue(item.color).trim() : item.color ?? palette[index % palette.length],
            width: compact ? 1.8 : 2.4,
            points: { show: item.points.length <= 1, size: 7, width: 2 },
            spanGaps: true,
          })),
        ],
      },
      data,
      host.current,
    )
    const observer = new ResizeObserver(([entry]) => plot.setSize({
      width: entry.contentRect.width,
      height: fill ? Math.max(220, entry.contentRect.height) : height,
    }))
    observer.observe(host.current)
    return () => {
      observer.disconnect()
      plot.destroy()
    }
  }, [compact, fill, height, series, smoothing, theme])

  if (series.length === 0 || series.every((item) => item.points.length === 0)) {
    return <div className="chart-empty">No numeric history has arrived yet.</div>
  }
  return <div className="chart" data-fill={fill || undefined} ref={host} />
}
