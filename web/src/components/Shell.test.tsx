// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Shell } from './Shell'
import { ThemeProvider } from '../theme'

describe('Shell', () => {
  it('exposes accessible navigation and marks the current route', () => {
    const navigate = vi.fn()
    document.documentElement.dataset.theme = 'light'
    window.localStorage.clear()
    render(
      <ThemeProvider>
        <Shell currentPath="/runs/example" navigate={navigate}>
          <p>run content</p>
        </Shell>
      </ThemeProvider>,
    )

    expect(screen.getByRole('button', { name: 'oplogs home' })).toHaveTextContent('oplogs')
    expect(screen.getByRole('button', { name: 'Runs' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: 'Settings' })).not.toHaveAttribute('aria-current')

    fireEvent.click(screen.getByRole('button', { name: 'Artifacts' }))
    expect(navigate).toHaveBeenCalledWith('/artifacts')

    fireEvent.click(screen.getByRole('button', { name: 'Use dark mode' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(window.localStorage.getItem('oplogs-theme')).toBe('dark')
    expect(screen.getByRole('button', { name: 'Use light mode' })).toHaveAttribute('aria-pressed', 'true')
  })
})
