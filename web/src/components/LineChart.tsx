import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import type { HistoryPoint } from '../types'

interface LineChartProps {
  series: Array<{ label: string; points: HistoryPoint[]; color?: string }>
  height?: number
  compact?: boolean
}

export function LineChart({ series, height = 280, compact = false }: LineChartProps) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!host.current || series.length === 0) return
    const allSteps = Array.from(new Set(series.flatMap((item) => item.points.map((point, index) => point.step ?? index)))).sort((a, b) => a - b)
    const data: uPlot.AlignedData = [
      allSteps,
      ...series.map((item) => {
        const lookup = new Map(item.points.map((point, index) => [point.step ?? index, point.value]))
        return allSteps.map((step) => lookup.get(step) ?? null)
      }),
    ]
    const palette = ['#315b42', '#6f8976', '#8b5c4e', '#566258', '#82704b']
    const plot = new uPlot(
      {
        width: host.current.clientWidth,
        height,
        cursor: { drag: { x: true, y: false } },
        legend: { show: !compact },
        scales: { x: { time: false } },
        axes: [
          { stroke: '#646d65', grid: { stroke: '#e7ece8', width: 1 }, ticks: { stroke: '#d3dbd5' }, font: '12px Oplogs Sans' },
          { stroke: '#646d65', grid: { stroke: '#e7ece8', width: 1 }, ticks: { stroke: '#d3dbd5' }, font: '12px Oplogs Sans', size: 52 },
        ],
        series: [
          {},
          ...series.map((item, index) => ({ label: item.label, stroke: item.color ?? palette[index % palette.length], width: 2, points: { show: false }, spanGaps: true })),
        ],
      },
      data,
      host.current,
    )
    const observer = new ResizeObserver(([entry]) => plot.setSize({ width: entry.contentRect.width, height }))
    observer.observe(host.current)
    return () => {
      observer.disconnect()
      plot.destroy()
    }
  }, [compact, height, series])

  if (series.length === 0 || series.every((item) => item.points.length === 0)) {
    return <div className="chart-empty">No numeric history has arrived yet.</div>
  }
  return <div className="chart" ref={host} />
}
