/**
 * Tests for src/lib/spatial/canonical/schema/parametric-json-schema.ts
 *
 * Verifies that:
 *   - a freshly-serialised parametric.json validates
 *   - missing top-level fields are rejected
 *   - additional top-level fields are rejected (defensive net)
 */
import { describe, it, expect } from 'vitest'

import { validateParametricJson, validateParametricJsonSafe } from '../../../../../src/lib/spatial/canonical/schema/ajv-validator.ts'
import { serialize } from '../../../../../src/lib/spatial/canonical/converters/canonical-roundtrip.ts'
import { runValidator } from '../../../../../src/lib/spatial/canonical/validator/run-validator.ts'
import { makeRoom } from '../__helpers__/sceneFactory.ts'

describe('parametric-json-schema · valid documents', () => {
  it('a freshly-serialised scene validates', () => {
    const scene = makeRoom()
    const report = runValidator(scene)
    const json = serialize({
      scene,
      validation_report: report,
      source: 'roomplan_ios18',
    })
    expect(validateParametricJson(json)).toBe(true)
  })
})

describe('parametric-json-schema · rejects malformed documents', () => {
  it('rejects a document missing schema_version', () => {
    const scene = makeRoom()
    const report = runValidator(scene)
    const json = serialize({ scene, validation_report: report, source: 'roomplan_ios18' })
    const { schema_version: _drop, ...rest } = json
    void _drop
    const result = validateParametricJsonSafe(rest)
    expect(result.valid).toBe(false)
  })

  it('rejects an unknown top-level property', () => {
    const scene = makeRoom()
    const report = runValidator(scene)
    const json = serialize({ scene, validation_report: report, source: 'roomplan_ios18' }) as Record<string, unknown>
    const result = validateParametricJsonSafe({ ...json, unexpected_field: 'oops' })
    expect(result.valid).toBe(false)
  })

  it('rejects an invalid schema_version pattern', () => {
    const scene = makeRoom()
    const report = runValidator(scene)
    const json = serialize({ scene, validation_report: report, source: 'roomplan_ios18' })
    const result = validateParametricJsonSafe({ ...json, schema_version: 'not-a-version' })
    expect(result.valid).toBe(false)
  })

  it('rejects an invalid source enum value', () => {
    const scene = makeRoom()
    const report = runValidator(scene)
    const json = serialize({ scene, validation_report: report, source: 'roomplan_ios18' })
    const result = validateParametricJsonSafe({ ...json, source: 'kinect' })
    expect(result.valid).toBe(false)
  })
})

describe('ajv-validator · nanInfinityWalker (CD-3 hardening)', () => {
  it('finds non-finite numbers ajv would let through', async () => {
    const { nanInfinityWalker } = await import(
      '../../../../../src/lib/spatial/canonical/schema/ajv-validator.ts'
    )
    expect(nanInfinityWalker({ a: 1, b: [2, 3] })).toEqual([])
    expect(nanInfinityWalker({ a: Number.NaN })).toEqual(['/a'])
    expect(nanInfinityWalker({ p: { x: 1, y: Infinity } })).toEqual(['/p/y'])
    expect(nanInfinityWalker([0, -Infinity])).toEqual(['/1'])
  })

  it('validateParametricJsonSafe rejects a document carrying a NaN number', () => {
    const scene = makeRoom()
    const report = runValidator(scene)
    const json = serialize({ scene, validation_report: report, source: 'roomplan_ios18' })
    // The clean document still validates.
    expect(validateParametricJsonSafe(json).valid).toBe(true)
    // ajv's `type: number` would accept a NaN; the CD-3 walker rejects it
    // before ajv ever runs.
    const corrupt = JSON.parse(JSON.stringify(json)) as Record<string, unknown>
    corrupt.__nanProbe = Number.NaN
    const result = validateParametricJsonSafe(corrupt)
    expect(result.valid).toBe(false)
    expect(result.errors?.some(e => e.keyword === 'finite')).toBe(true)
  })
})
