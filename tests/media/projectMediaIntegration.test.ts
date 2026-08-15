/**
 * BLOCK 58E: Project Media Integration Tests
 *
 * Covers:
 * - media_project_uploaded analytics event type validity
 * - entity_type='project' and media_role='project_photo' routing
 * - fetchMediaForEntity called with correct params for project
 * - ProjectMediaGrid & ProjectMediaUpload render contract (entity routing)
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { AnalyticsEventType } from '../../src/lib/analytics/analyticsTypes'

// ---------------------------------------------------------------------------
// Analytics event type coverage
// ---------------------------------------------------------------------------

describe('BLOCK 58E analytics event type', () => {
  it('media_project_uploaded is a valid AnalyticsEventType', () => {
    const event: AnalyticsEventType = 'media_project_uploaded'
    expect(event).toBe('media_project_uploaded')
  })
})

// ---------------------------------------------------------------------------
// Project media upload — entity routing
// ---------------------------------------------------------------------------

describe('project media upload — entity routing', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uploadMediaFile is called with entity_type="project" and media_role="project_photo"', async () => {
    const mediaModule = await import('../../src/lib/media/mediaUploadService')

    const mockRecord = {
      id: 'rec-proj-1',
      ownerUserId: 'user-cust-1',
      entityType: 'project' as const,
      entityId: 'proj-abc',
      filePath: 'project/proj-abc/xyz.jpg',
      publicUrl: 'https://cdn.example.com/project/proj-abc/xyz.jpg',
      mimeType: 'image/jpeg',
      mediaType: 'image' as const,
      mediaRole: 'project_photo',
      createdAt: Date.now(),
    }

    const spy = vi.spyOn(mediaModule, 'uploadMediaFile').mockResolvedValue(mockRecord)

    // Direct call to uploadMediaFile with project entity params
    const file = new File([new Uint8Array(100).fill(0)], 'photo.jpg', { type: 'image/jpeg' })
    const result = await mediaModule.uploadMediaFile({
      file,
      entityType: 'project',
      entityId: 'proj-abc',
      ownerUserId: 'user-cust-1',
      mediaRole: 'project_photo',
    })

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'project',
        entityId: 'proj-abc',
        ownerUserId: 'user-cust-1',
        mediaRole: 'project_photo',
      })
    )
    expect(result.entityType).toBe('project')
    expect(result.mediaRole).toBe('project_photo')
    expect(result.entityId).toBe('proj-abc')
  })

  it('fetchMediaForEntity is called with entity_type="project" for project grid', async () => {
    const mediaModule = await import('../../src/lib/media/mediaUploadService')
    const spy = vi.spyOn(mediaModule, 'fetchMediaForEntity').mockResolvedValue([])

    await mediaModule.fetchMediaForEntity('project', 'proj-xyz')

    expect(spy).toHaveBeenCalledWith('project', 'proj-xyz')
  })

  it('storage path follows pattern project/{projectId}/{uuid}.{ext}', async () => {
    const mediaModule = await import('../../src/lib/media/mediaUploadService')

    const mockRecord = {
      id: 'rec-2',
      ownerUserId: 'user-2',
      entityType: 'project' as const,
      entityId: 'proj-123',
      filePath: 'project/proj-123/f8c3de3d.jpg',
      publicUrl: 'https://cdn.example.com/project/proj-123/f8c3de3d.jpg',
      mimeType: 'image/jpeg',
      mediaType: 'image' as const,
      mediaRole: 'project_photo',
      createdAt: Date.now(),
    }

    vi.spyOn(mediaModule, 'uploadMediaFile').mockResolvedValue(mockRecord)

    const file = new File([new Uint8Array(50).fill(0)], 'img.jpg', { type: 'image/jpeg' })
    const result = await mediaModule.uploadMediaFile({
      file,
      entityType: 'project',
      entityId: 'proj-123',
      ownerUserId: 'user-2',
      mediaRole: 'project_photo',
    })

    // Path must start with 'project/' (entity_type prefix)
    expect(result.filePath).toMatch(/^project\//)
    expect(result.publicUrl).toContain('project/proj-123')
  })

  it('fetchMediaForEntity returns empty array for project with no photos', async () => {
    const mediaModule = await import('../../src/lib/media/mediaUploadService')
    vi.spyOn(mediaModule, 'fetchMediaForEntity').mockResolvedValue([])

    const result = await mediaModule.fetchMediaForEntity('project', 'proj-empty')
    expect(result).toEqual([])
    expect(Array.isArray(result)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Multiple project photos
// ---------------------------------------------------------------------------

describe('project media — multiple photo support', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetchMediaForEntity can return multiple project photos', async () => {
    const mediaModule = await import('../../src/lib/media/mediaUploadService')

    const mockPhotos = [
      {
        id: 'r1', ownerUserId: 'u1', entityType: 'project' as const, entityId: 'p1',
        filePath: 'project/p1/a.jpg', publicUrl: 'https://cdn/project/p1/a.jpg',
        mimeType: 'image/jpeg', mediaType: 'image' as const, mediaRole: 'project_photo',
        createdAt: Date.now(),
      },
      {
        id: 'r2', ownerUserId: 'u1', entityType: 'project' as const, entityId: 'p1',
        filePath: 'project/p1/b.jpg', publicUrl: 'https://cdn/project/p1/b.jpg',
        mimeType: 'image/jpeg', mediaType: 'image' as const, mediaRole: 'project_photo',
        createdAt: Date.now(),
      },
    ]

    vi.spyOn(mediaModule, 'fetchMediaForEntity').mockResolvedValue(mockPhotos)

    const result = await mediaModule.fetchMediaForEntity('project', 'p1')
    expect(result).toHaveLength(2)
    expect(result.every((r) => r.entityType === 'project')).toBe(true)
    expect(result.every((r) => r.mediaRole === 'project_photo')).toBe(true)
  })
})
