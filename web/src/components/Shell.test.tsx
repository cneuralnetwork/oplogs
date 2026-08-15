// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Shell } from './Shell'

describe('Shell', () => {
  it('exposes accessible navigation and marks the current route', () => {
    const navigate = vi.fn()
    render(
      <Shell currentPath="/runs/example" navigate={navigate}>
        <p>Run content</p>
      </Shell>,
    )

    expect(screen.getByRole('button', { name: 'Runs' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: 'Settings' })).not.toHaveAttribute('aria-current')

    fireEvent.click(screen.getByRole('button', { name: 'Artifacts' }))
    expect(navigate).toHaveBeenCalledWith('/artifacts')
  })
})
