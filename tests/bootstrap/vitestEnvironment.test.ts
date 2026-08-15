import { describe, expect, it } from 'vitest'

describe('Vitest repository mode', () => {
  it('keeps both direct and object-style environment access in memory', () => {
    expect(import.meta.env.VITE_DATA_SOURCE).toBe('in-memory')
    expect((import.meta.env as Record<string, string | undefined>).VITE_DATA_SOURCE).toBe(
      'in-memory',
    )
  })
})
