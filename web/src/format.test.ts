import { describe, expect, it } from 'vitest'

import { formatDateTime, humanBytes } from './format'

describe('lowercase interface formatting', () => {
  it('uses lowercase storage units and locale suffixes', () => {
    expect(humanBytes(1024)).toBe('1.0 kb')
    expect(formatDateTime('2026-08-15T10:02:00Z')).toBe(
      formatDateTime('2026-08-15T10:02:00Z').toLowerCase(),
    )
  })
})
