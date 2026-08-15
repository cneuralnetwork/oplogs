import { describe, expect, it } from 'vitest'

import { formatDateTime, humanBytes } from './format'

describe('professional interface formatting', () => {
  it('uses conventional storage units and preserves locale casing', () => {
    const timestamp = '2026-08-15T10:02:00Z'
    expect(humanBytes(1024)).toBe('1.0 KB')
    expect(formatDateTime(timestamp)).toBe(new Date(timestamp).toLocaleString())
  })
})
