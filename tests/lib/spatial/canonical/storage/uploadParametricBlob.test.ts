/**
 * uploadParametricBlob · buildParametricPath — storage helper unit tests
 * (Szenen-Produktion · B2).
 *
 * Tests run in `in-memory` data-source mode (vitest define), so
 * `uploadParametricBlob` short-circuits to the logical path without a Storage
 * round-trip. The path-convention checks pin the schema the bucket RLS
 * (migration 20260521120049) depends on.
 */
import { describe, expect, it } from 'vitest'
import {
  buildParametricPath,
  PARAMETRIC_CONTENT_TYPE,
  uploadParametricBlob,
} from '../../../../../src/lib/spatial/canonical/storage/uploadParametricBlob'

describe('buildParametricPath', () => {
  it('builds the content-addressed {uid}/{sceneId}/parametric-{sha}.json.gz path', () => {
    expect(buildParametricPath('user-1', 'scene-9', 'deadbeef')).toBe(
      'user-1/scene-9/parametric-deadbeef.json.gz',
    )
  })

  it('puts the uploader uid in path segment 1 (bucket INSERT-policy gate)', () => {
    expect(buildParametricPath('uid-abc', 'scene-x', 'sha').split('/')[0]).toBe('uid-abc')
  })

  it('puts the sceneId in path segment 2 (bucket SELECT-policy gate)', () => {
    expect(buildParametricPath('uid', 'scene-77', 'sha').split('/')[1]).toBe('scene-77')
  })

  it('keeps the .json.gz extension so the gzip MIME is unambiguous', () => {
    expect(buildParametricPath('u', 's', 'h').endsWith('.json.gz')).toBe(true)
  })
})

describe('uploadParametricBlob · in-memory mode', () => {
  it('returns ok with the path unchanged (no Storage backend)', async () => {
    const result = await uploadParametricBlob(
      'u/s/parametric-h.json.gz',
      new Uint8Array([1, 2, 3]),
    )
    expect(result).toEqual({ ok: true, path: 'u/s/parametric-h.json.gz' })
  })

  it('declares the gzip content type expected by the bucket', () => {
    expect(PARAMETRIC_CONTENT_TYPE).toBe('application/gzip')
  })
})
