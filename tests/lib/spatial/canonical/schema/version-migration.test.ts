/**
 * Tests for src/lib/spatial/canonical/schema/version-migration.ts
 */
import { describe, it, expect } from 'vitest'

import {
  CURRENT_SCHEMA_VERSION,
  migrateParametricJson,
} from '../../../../../src/lib/spatial/canonical/schema/version-migration.ts'

describe('version-migration · no-op for current version', () => {
  it('passes a document at the current version through unchanged', () => {
    const doc = { schema_version: CURRENT_SCHEMA_VERSION, foo: 'bar' }
    expect(migrateParametricJson(doc)).toBe(doc)
  })

  it('rejects a document with a missing schema_version by default (H26 audit-fix)', () => {
    const doc = { foo: 'bar' } as Record<string, unknown>
    expect(() => migrateParametricJson(doc)).toThrow(/missing `schema_version`/)
  })

  it('opts into the legacy default with { assumeCurrent: true }', () => {
    const doc = { foo: 'bar' } as Record<string, unknown>
    const result = migrateParametricJson(doc, CURRENT_SCHEMA_VERSION, {
      assumeCurrent: true,
    })
    expect(result.schema_version).toBe(CURRENT_SCHEMA_VERSION)
  })

  it('throws on a document with no available migration step', () => {
    const doc = { schema_version: '0.1' } as Record<string, unknown>
    expect(() => migrateParametricJson(doc)).toThrow(/no migration/)
  })
})
