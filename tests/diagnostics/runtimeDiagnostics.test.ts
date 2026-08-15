import { describe, expect, it } from 'vitest'
import { buildDiagnostic, extractError } from '../../src/lib/diagnostics'

describe('extractError', () => {
  it('extracts fields from Error instances with metadata', () => {
    const err = new Error('Boom') as Error & { code?: string; details?: { id: string } }
    err.code = 'E_FAIL'
    err.details = { id: '123' }

    const extracted = extractError(err)

    expect(extracted.message).toBe('Boom')
    expect(extracted.code).toBe('E_FAIL')
    expect(extracted.details).toEqual({ id: '123' })
    expect(extracted.raw).toContain('Boom')
  })

  it('handles plain object errors without collapsing to [object Object]', () => {
    const extracted = extractError({
      message: 'Insert failed',
      code: '23505',
      details: { table: 'projects' },
    })

    expect(extracted.message).toBe('Insert failed')
    expect(extracted.code).toBe('23505')
    expect(extracted.details).toEqual({ table: 'projects' })
    expect(extracted.raw).toContain('projects')
    expect(extracted.raw).not.toBe('[object Object]')
  })
})

describe('buildDiagnostic', () => {
  it('builds a normalized diagnostic with overrides', () => {
    const diagnostic = buildDiagnostic({
      source: 'PROJECT_CREATE',
      step: 'submit_builder',
      name: 'test',
      error: { message: 'fail', code: '400' },
      message: 'override',
    })

    expect(diagnostic.source).toBe('PROJECT_CREATE')
    expect(diagnostic.step).toBe('submit_builder')
    expect(diagnostic.name).toBe('test')
    expect(diagnostic.message).toBe('override')
    expect(diagnostic.code).toBe('400')
    expect(diagnostic.raw).toContain('fail')
  })
})
