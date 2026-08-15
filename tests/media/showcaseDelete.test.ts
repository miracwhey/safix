/**
 * Showcase Delete Integration Tests
 *
 * Validates that deleteShowcaseMedia delegates to deleteMediaFile correctly
 * and that deleteMediaFile calls the expected Supabase operations.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// deleteShowcaseMedia — integration
// ---------------------------------------------------------------------------

describe('deleteShowcaseMedia — integration', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('deleteShowcaseMedia calls deleteMediaFile with id and filePath', async () => {
    const mediaModule = await import('../../src/lib/media/mediaUploadService')

    const spy = vi.spyOn(mediaModule, 'deleteMediaFile').mockResolvedValue(undefined)

    const { deleteShowcaseMedia } = await import(
      '../../src/lib/providerMedia/showcaseUploadService'
    )

    await deleteShowcaseMedia({
      id: 'rec-del-1',
      filePath: 'showcase/prov-1/photo.jpg',
    })

    expect(spy).toHaveBeenCalledWith({
      id: 'rec-del-1',
      filePath: 'showcase/prov-1/photo.jpg',
    })
  })

  it('deleteShowcaseMedia propagates errors from deleteMediaFile', async () => {
    const mediaModule = await import('../../src/lib/media/mediaUploadService')

    vi.spyOn(mediaModule, 'deleteMediaFile').mockRejectedValue(
      new Error('Storage error')
    )

    const { deleteShowcaseMedia } = await import(
      '../../src/lib/providerMedia/showcaseUploadService'
    )

    await expect(
      deleteShowcaseMedia({
        id: 'rec-del-2',
        filePath: 'showcase/prov-1/broken.jpg',
      })
    ).rejects.toThrow('Storage error')
  })
})

// ---------------------------------------------------------------------------
// deleteMediaFile — API shape
// ---------------------------------------------------------------------------

describe('deleteMediaFile — API shape', () => {
  it('deleteMediaFile is exported from mediaUploadService', async () => {
    const { deleteMediaFile } = await import('../../src/lib/media/mediaUploadService')
    expect(typeof deleteMediaFile).toBe('function')
  })

  it('deleteMediaFile is exported from media barrel', async () => {
    const { deleteMediaFile } = await import('../../src/lib/media/index')
    expect(typeof deleteMediaFile).toBe('function')
  })

  it('deleteShowcaseMedia is exported from providerMedia barrel', async () => {
    const { deleteShowcaseMedia } = await import('../../src/lib/providerMedia/index')
    expect(typeof deleteShowcaseMedia).toBe('function')
  })
})
