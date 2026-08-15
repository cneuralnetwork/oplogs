// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Project, RunRecord } from '../types'
import { ProjectsView } from './Views'

const project: Project = {
  name: 'vision-lab',
  created_at: '2026-08-16T10:00:00Z',
  updated_at: '2026-08-16T10:02:00Z',
  run_count: 1,
}

const run: RunRecord = {
  id: 'run-123',
  project: project.name,
  name: 'tiny-cnn',
  state: 'finished',
  created_at: project.created_at,
  updated_at: project.updated_at,
  finished_at: project.updated_at,
  config: {},
  tags: [],
  source: {},
  summary: { 'validation/accuracy': 0.98 },
  last_sequence: 4,
}

describe('ProjectsView', () => {
  it('shows every retained run and opens projects or run details', () => {
    const selectProject = vi.fn()
    const selectRun = vi.fn()
    render(
      <ProjectsView
        projects={[project]}
        runs={[run]}
        selectProject={selectProject}
        selectRun={selectRun}
      />,
    )

    expect(screen.getByRole('heading', { name: 'All runs' })).toBeVisible()
    expect(screen.getByText('1 retained')).toBeVisible()
    expect(screen.getByText('tiny-cnn')).toBeVisible()
    expect(screen.getByText('Finished')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: /vision-lab/i }))
    expect(selectProject).toHaveBeenCalledWith(project.name)

    fireEvent.click(screen.getByText('tiny-cnn').closest('tr')!)
    expect(selectRun).toHaveBeenCalledWith(run)
  })
})
