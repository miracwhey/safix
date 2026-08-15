import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'

import {
  isSpatialAssetBucketConfigured,
  resolveSpatialAssetUrl,
} from '../../../../../src/lib/spatial/canonical/assets/assetBaseUrl'

describe('resolveSpatialAssetUrl', () => {
  const ORIGINAL_ENV = { ...import.meta.env }

  beforeEach(() => {
    // Reset the env field tests will mutate; other env keys stay intact.
    vi.stubEnv('VITE_SPATIAL_ASSETS_BASE_URL', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    Object.assign(import.meta.env, ORIGINAL_ENV)
  })

  describe('local dev (no env)', () => {
    it('falls back to /spatial-assets/ prefix', () => {
      expect(resolveSpatialAssetUrl('spatial-assets/hdri/bathroom_2k.exr')).toBe(
        '/spatial-assets/hdri/bathroom_2k.exr',
      )
    })

    it('normalises a leading slash on the input', () => {
      expect(resolveSpatialAssetUrl('/spatial-assets/hdri/bathroom_2k.exr')).toBe(
        '/spatial-assets/hdri/bathroom_2k.exr',
      )
    })

    it('accepts already-stripped catalog form', () => {
      expect(resolveSpatialAssetUrl('hdri/bathroom_2k.exr')).toBe(
        '/spatial-assets/hdri/bathroom_2k.exr',
      )
    })

    it('reports bucket as not configured', () => {
      expect(isSpatialAssetBucketConfigured()).toBe(false)
    })
  })

  describe('production (env set)', () => {
    const BUCKET_URL =
      'https://itdntawwuzqfwmcwnwjr.supabase.co/storage/v1/object/public/spatial-public-assets'

    beforeEach(() => {
      vi.stubEnv('VITE_SPATIAL_ASSETS_BASE_URL', BUCKET_URL)
    })

    it('prepends the bucket URL', () => {
      expect(
        resolveSpatialAssetUrl('spatial-assets/materials/floor-wood-oak/albedo.ktx2'),
      ).toBe(
        `${BUCKET_URL}/materials/floor-wood-oak/albedo.ktx2`,
      )
    })

    it('handles leading slash + spatial-assets prefix the same as without', () => {
      expect(resolveSpatialAssetUrl('/spatial-assets/hdri/bathroom_2k.exr')).toBe(
        `${BUCKET_URL}/hdri/bathroom_2k.exr`,
      )
    })

    it('strips trailing slash from env to avoid double slashes', () => {
      vi.stubEnv('VITE_SPATIAL_ASSETS_BASE_URL', `${BUCKET_URL}/`)
      expect(resolveSpatialAssetUrl('hdri/bathroom_2k.exr')).toBe(
        `${BUCKET_URL}/hdri/bathroom_2k.exr`,
      )
    })

    it('reports bucket as configured', () => {
      expect(isSpatialAssetBucketConfigured()).toBe(true)
    })
  })

  describe('edge cases', () => {
    it('returns empty string for empty input', () => {
      expect(resolveSpatialAssetUrl('')).toBe('')
      expect(resolveSpatialAssetUrl('   ')).toBe('')
    })

    it('returns empty string for non-string input', () => {
      // @ts-expect-error - intentional misuse for guard test
      expect(resolveSpatialAssetUrl(undefined)).toBe('')
      // @ts-expect-error - intentional misuse for guard test
      expect(resolveSpatialAssetUrl(null)).toBe('')
    })

    it('treats whitespace-only env as unset', () => {
      vi.stubEnv('VITE_SPATIAL_ASSETS_BASE_URL', '   ')
      expect(isSpatialAssetBucketConfigured()).toBe(false)
      expect(resolveSpatialAssetUrl('hdri/foo.exr')).toBe('/spatial-assets/hdri/foo.exr')
    })
  })
})
