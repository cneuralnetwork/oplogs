// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { RunRecord } from '../types'
import { RunsTable } from './RunsTable'

const run: RunRecord = {
  id: 'run-123',
  project: 'vision-lab',
  name: 'tiny-cnn',
  state: 'finished',
  created_at: '2026-08-15T10:00:00Z',
  updated_at: '2026-08-15T10:02:00Z',
  finished_at: '2026-08-15T10:02:00Z',
  config: { epochs: 2 },
  tags: ['cnn'],
  source: {},
  summary: { 'validation/accuracy': 0.98 },
  last_sequence: 4,
}

describe('RunsTable', () => {
  it('renders retained run evidence and opens a row with pointer or keyboard input', () => {
    const onSelect = vi.fn()
    render(<RunsTable runs={[run]} onSelect={onSelect} />)

    expect(screen.getByText('tiny-cnn')).toBeVisible()
    expect(screen.getByText('run-123')).toBeVisible()
    expect(screen.getByText('validation/accuracy 0.98')).toBeVisible()
    expect(screen.getByRole('columnheader', { name: 'latest metric' })).toBeVisible()

    const row = screen.getByText('tiny-cnn').closest('tr')
    expect(row).not.toBeNull()
    fireEvent.click(row!)
    fireEvent.keyDown(row!, { key: 'Enter' })
    expect(onSelect).toHaveBeenNthCalledWith(1, run)
    expect(onSelect).toHaveBeenNthCalledWith(2, run)
  })
})
