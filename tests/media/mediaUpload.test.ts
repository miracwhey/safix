import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  validateMediaFile,
  resolveMediaType,
  mimeTypeToExtension,
  buildStoragePath,
  uploadMediaFile,
  MAX_FILE_SIZE_BYTES,
  MAX_VIDEO_SIZE_BYTES,
  MEDIA_STORAGE_BUCKET,
} from '../../src/lib/media/mediaUploadService'
import { InMemoryMediaRepository } from '../../src/lib/media/repository/InMemoryMediaRepository'
import { setMediaRepository } from '../../src/lib/media/repository/registry'
import { InMemoryAnalyticsRepository } from '../../src/lib/analytics/repository/InMemoryAnalyticsRepository'
import { setAnalyticsRepository } from '../../src/lib/analytics/repository/registry'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Magic-byte headers for the formats validateMediaFile + the pre-upload
 * pipeline accept. Each header is enough to satisfy `detectMagicBytes`
 * — the rest of the file body stays as zero-filler.
 */
const MAGIC_BYTES: Record<string, number[]> = {
  'image/jpeg': [0xff, 0xd8, 0xff, 0xe0],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/webp': [
    0x52, 0x49, 0x46, 0x46, 0x1c, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  ],
  'image/gif': [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  'image/heic': [0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63],
  'image/heif': [0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31],
  'video/mp4': [0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d],
  'video/webm': [0x1a, 0x45, 0xdf, 0xa3],
  'video/quicktime': [0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20],
  'application/pdf': [0x25, 0x50, 0x44, 0x46],
}

function makeFile(
  name = 'photo.jpg',
  type = 'image/jpeg',
  sizeBytes = 100_000
): File {
  // Stamp the canonical header for `type` at offset 0 so the pre-upload
  // pipeline's magic-byte sniff passes. Unknown types keep zero-filler.
  const content = new Uint8Array(sizeBytes).fill(0)
  const header = MAGIC_BYTES[type]
  if (header) content.set(header, 0)
  return new File([content], name, { type })
}

/**
 * Mocks supabase.auth.getSession() to return a session with the given userId.
 * The uploadMediaFile function resolves the auth user ID at runtime to
 * satisfy the RLS policy on media_uploads.
 */
async function mockAuthSession(userId: string) {
  const supabaseModule = await import('../../src/lib/supabase')
  vi.spyOn(supabaseModule.supabase.auth, 'getSession').mockResolvedValue({
    data: {
      session: {
        user: { id: userId },
      },
    },
    error: null,
  } as unknown as Awaited<ReturnType<typeof supabaseModule.supabase.auth.getSession>>)
}

/**
 * Mocks supabase.auth.getSession() to return NO session (unauthenticated).
 */
async function mockNoAuthSession() {
  const supabaseModule = await import('../../src/lib/supabase')
  vi.spyOn(supabaseModule.supabase.auth, 'getSession').mockResolvedValue({
    data: { session: null },
    error: null,
  } as unknown as Awaited<ReturnType<typeof supabaseModule.supabase.auth.getSession>>)
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  setMediaRepository(new InMemoryMediaRepository())
  setAnalyticsRepository(new InMemoryAnalyticsRepository())
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// validateMediaFile
// ---------------------------------------------------------------------------

describe('validateMediaFile', () => {
  it('accepts JPEG images', () => {
    const file = makeFile('photo.jpg', 'image/jpeg')
    expect(validateMediaFile(file)).toEqual({ valid: true })
  })

  it('accepts PNG images', () => {
    const file = makeFile('photo.png', 'image/png')
    expect(validateMediaFile(file)).toEqual({ valid: true })
  })

  it('accepts WebP images', () => {
    const file = makeFile('photo.webp', 'image/webp')
    expect(validateMediaFile(file)).toEqual({ valid: true })
  })

  it('accepts GIF images', () => {
    const file = makeFile('anim.gif', 'image/gif')
    expect(validateMediaFile(file)).toEqual({ valid: true })
  })

  it('accepts MP4 video', () => {
    const file = makeFile('clip.mp4', 'video/mp4')
    expect(validateMediaFile(file)).toEqual({ valid: true })
  })

  it('accepts WebM video', () => {
    const file = makeFile('clip.webm', 'video/webm')
    expect(validateMediaFile(file)).toEqual({ valid: true })
  })

  it('accepts QuickTime/MOV video (iPhone)', () => {
    const file = makeFile('clip.mov', 'video/quicktime')
    expect(validateMediaFile(file)).toEqual({ valid: true })
  })

  it('accepts iPhone HEIC photo (iOS native format)', () => {
    const file = makeFile('img.heic', 'image/heic')
    expect(validateMediaFile(file)).toEqual({ valid: true })
  })

  it('accepts HEIF photo', () => {
    const file = makeFile('img.heif', 'image/heif')
    expect(validateMediaFile(file)).toEqual({ valid: true })
  })

  it('rejects an unknown MIME type', () => {
    const file = makeFile('doc.pdf', 'application/pdf')
    const result = validateMediaFile(file)
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.reason).toContain('application/pdf')
    }
  })

  it('rejects a file that exceeds the size limit', () => {
    const oversized = makeFile('big.jpg', 'image/jpeg', MAX_FILE_SIZE_BYTES + 1)
    const result = validateMediaFile(oversized)
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.reason).toContain('MB')
    }
  })

  it('accepts a file exactly at the image size limit', () => {
    const maxFile = makeFile('max.jpg', 'image/jpeg', MAX_FILE_SIZE_BYTES)
    expect(validateMediaFile(maxFile)).toEqual({ valid: true })
  })

  it('accepts a video file up to the video size limit (50 MB)', () => {
    const videoFile = makeFile('clip.mp4', 'video/mp4', MAX_VIDEO_SIZE_BYTES)
    expect(validateMediaFile(videoFile)).toEqual({ valid: true })
  })

  it('applies the video size limit to MOV/QuickTime files', () => {
    const movOk = makeFile('clip.mov', 'video/quicktime', MAX_VIDEO_SIZE_BYTES)
    expect(validateMediaFile(movOk)).toEqual({ valid: true })

    const movTooBig = makeFile('clip.mov', 'video/quicktime', MAX_VIDEO_SIZE_BYTES + 1)
    const result = validateMediaFile(movTooBig)
    expect(result.valid).toBe(false)
  })

  it('rejects a video file exceeding the video size limit', () => {
    const bigVideo = makeFile('clip.mp4', 'video/mp4', MAX_VIDEO_SIZE_BYTES + 1)
    const result = validateMediaFile(bigVideo)
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.reason).toContain('200')
    }
  })

  it('rejects an image that is below video limit but above image limit', () => {
    // A 15 MB JPEG should be rejected (image limit is 10 MB)
    const bigImage = makeFile('big.jpg', 'image/jpeg', 15 * 1024 * 1024)
    const result = validateMediaFile(bigImage)
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.reason).toContain('10')
    }
  })
})

// ---------------------------------------------------------------------------
// resolveMediaType
// ---------------------------------------------------------------------------

describe('resolveMediaType', () => {
  it('returns "image" for image MIME types', () => {
    expect(resolveMediaType('image/jpeg')).toBe('image')
    expect(resolveMediaType('image/png')).toBe('image')
    expect(resolveMediaType('image/webp')).toBe('image')
    expect(resolveMediaType('image/gif')).toBe('image')
  })

  it('returns "video" for video MIME types', () => {
    expect(resolveMediaType('video/mp4')).toBe('video')
    expect(resolveMediaType('video/webm')).toBe('video')
    expect(resolveMediaType('video/quicktime')).toBe('video')
  })

  it('defaults to "image" for unknown MIME types', () => {
    expect(resolveMediaType('application/octet-stream')).toBe('image')
  })
})

// ---------------------------------------------------------------------------
// mimeTypeToExtension
// ---------------------------------------------------------------------------

describe('mimeTypeToExtension', () => {
  it('maps standard types to expected extensions', () => {
    expect(mimeTypeToExtension('image/jpeg')).toBe('jpg')
    expect(mimeTypeToExtension('image/png')).toBe('png')
    expect(mimeTypeToExtension('image/webp')).toBe('webp')
    expect(mimeTypeToExtension('image/gif')).toBe('gif')
    expect(mimeTypeToExtension('image/heic')).toBe('heic')
    expect(mimeTypeToExtension('image/heif')).toBe('heif')
    expect(mimeTypeToExtension('video/mp4')).toBe('mp4')
    expect(mimeTypeToExtension('video/webm')).toBe('webm')
    expect(mimeTypeToExtension('video/quicktime')).toBe('mov')
  })

  it('returns "bin" for unknown types', () => {
    expect(mimeTypeToExtension('application/octet-stream')).toBe('bin')
  })
})

// ---------------------------------------------------------------------------
// buildStoragePath
// ---------------------------------------------------------------------------

describe('buildStoragePath', () => {
  it('builds a path in the expected format: entity_type/entity_id/uuid.ext', () => {
    const path = buildStoragePath('profile', 'user-123', 'image/jpeg')
    expect(path).toMatch(/^profile\/user-123\/[a-f0-9-]+\.jpg$/)
  })

  it('uses the correct extension for each MIME type', () => {
    expect(buildStoragePath('dispute', 'dispute-1', 'image/png')).toMatch(/\.png$/)
    expect(buildStoragePath('job', 'job-1', 'video/mp4')).toMatch(/\.mp4$/)
  })

  it('generates unique paths for successive calls', () => {
    const p1 = buildStoragePath('profile', 'user-1', 'image/jpeg')
    const p2 = buildStoragePath('profile', 'user-1', 'image/jpeg')
    expect(p1).not.toBe(p2)
  })
})

// ---------------------------------------------------------------------------
// uploadMediaFile — validation errors (no Supabase calls needed)
// ---------------------------------------------------------------------------

describe('uploadMediaFile — validation', () => {
  it('throws when the file type is invalid', async () => {
    const file = makeFile('doc.pdf', 'application/pdf')
    await expect(
      uploadMediaFile({ file, entityType: 'profile', entityId: 'u1', ownerUserId: 'u1' })
    ).rejects.toThrow('application/pdf')
  })

  it('throws when the file exceeds the size limit', async () => {
    const file = makeFile('huge.jpg', 'image/jpeg', MAX_FILE_SIZE_BYTES + 1)
    await expect(
      uploadMediaFile({ file, entityType: 'profile', entityId: 'u1', ownerUserId: 'u1' })
    ).rejects.toThrow('MB')
  })
})

// ---------------------------------------------------------------------------
// uploadMediaFile — mocked Supabase storage
// ---------------------------------------------------------------------------

describe('uploadMediaFile — with mocked Supabase', () => {
  it('returns a PersistedMediaRecord on successful upload', async () => {
    await mockAuthSession('user-1')
    // Mock the Supabase client used inside mediaUploadService
    const supabaseModule = await import('../../src/lib/supabase')
    vi.spyOn(supabaseModule.supabase.storage, 'from').mockReturnValue({
      upload: vi.fn().mockResolvedValue({ data: { path: 'profile/u1/test.jpg' }, error: null }),
      getPublicUrl: vi.fn().mockReturnValue({
        data: { publicUrl: 'https://cdn.example.com/profile/u1/test.jpg' },
      }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.storage.from>)

    vi.spyOn(supabaseModule.supabase, 'from').mockReturnValue({
      insert: vi.fn().mockResolvedValue({ error: null }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.from>)

    const file = makeFile('photo.jpg', 'image/jpeg', 50_000)
    const result = await uploadMediaFile({
      file,
      entityType: 'profile',
      entityId: 'user-1',
      ownerUserId: 'user-1',
    })

    expect(result.ownerUserId).toBe('user-1')
    expect(result.entityType).toBe('profile')
    expect(result.entityId).toBe('user-1')
    expect(result.mimeType).toBe('image/jpeg')
    expect(result.mediaType).toBe('image')
    expect(result.publicUrl).toBe('https://cdn.example.com/profile/u1/test.jpg')
    expect(result.filePath).toMatch(/^profile\/user-1\//)
    expect(result.id).toBeTruthy()
    expect(result.createdAt).toBeGreaterThan(0)
  })

  it('throws when Supabase Storage upload fails', async () => {
    await mockAuthSession('u1')
    const supabaseModule = await import('../../src/lib/supabase')
    vi.spyOn(supabaseModule.supabase.storage, 'from').mockReturnValue({
      upload: vi.fn().mockResolvedValue({ data: null, error: { message: 'Bucket not found' } }),
      getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: '' } }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.storage.from>)

    const file = makeFile('photo.jpg', 'image/jpeg', 50_000)
    await expect(
      uploadMediaFile({ file, entityType: 'dispute', entityId: 'd1', ownerUserId: 'u1' })
    ).rejects.toThrow('Datei konnte nicht hochgeladen werden')
  })

  it('throws when DB insert fails after successful storage upload', async () => {
    await mockAuthSession('u1')
    const supabaseModule = await import('../../src/lib/supabase')
    vi.spyOn(supabaseModule.supabase.storage, 'from').mockReturnValue({
      upload: vi.fn().mockResolvedValue({ data: { path: 'job/j1/test.jpg' }, error: null }),
      getPublicUrl: vi.fn().mockReturnValue({
        data: { publicUrl: 'https://cdn.example.com/job/j1/test.jpg' },
      }),
      // remove() is called as a best-effort cleanup when the DB insert fails
      remove: vi.fn().mockResolvedValue({ error: null }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.storage.from>)

    vi.spyOn(supabaseModule.supabase, 'from').mockReturnValue({
      insert: vi.fn().mockResolvedValue({ error: { message: 'DB insert failed' } }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.from>)

    const file = makeFile('photo.jpg', 'image/jpeg', 50_000)
    await expect(
      uploadMediaFile({ file, entityType: 'job', entityId: 'j1', ownerUserId: 'u1' })
    ).rejects.toThrow('konnte aber nicht gespeichert werden')
  })

  it('emits media_upload_succeeded analytics event on success', async () => {
    await mockAuthSession('user-2')
    const analyticsRepo = new InMemoryAnalyticsRepository()
    setAnalyticsRepository(analyticsRepo)

    const supabaseModule = await import('../../src/lib/supabase')
    vi.spyOn(supabaseModule.supabase.storage, 'from').mockReturnValue({
      upload: vi.fn().mockResolvedValue({ data: { path: 'profile/u2/ok.jpg' }, error: null }),
      getPublicUrl: vi.fn().mockReturnValue({
        data: { publicUrl: 'https://cdn.example.com/ok.jpg' },
      }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.storage.from>)

    vi.spyOn(supabaseModule.supabase, 'from').mockReturnValue({
      insert: vi.fn().mockResolvedValue({ error: null }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.from>)

    const file = makeFile('ok.jpg', 'image/jpeg', 50_000)
    await uploadMediaFile({
      file,
      entityType: 'profile',
      entityId: 'user-2',
      ownerUserId: 'user-2',
    })

    const events = analyticsRepo.getAll()
    const started = events.find((e) => e.eventType === 'media_upload_started')
    const succeeded = events.find((e) => e.eventType === 'media_upload_succeeded')
    expect(started).toBeDefined()
    expect(succeeded).toBeDefined()
    expect(succeeded?.entityType).toBe('media')
  })

  it('emits media_upload_failed analytics event on storage failure', async () => {
    await mockAuthSession('u3')
    const analyticsRepo = new InMemoryAnalyticsRepository()
    setAnalyticsRepository(analyticsRepo)

    const supabaseModule = await import('../../src/lib/supabase')
    vi.spyOn(supabaseModule.supabase.storage, 'from').mockReturnValue({
      upload: vi.fn().mockResolvedValue({ data: null, error: { message: 'Network error' } }),
      getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: '' } }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.storage.from>)

    const file = makeFile('photo.jpg', 'image/jpeg', 50_000)
    await uploadMediaFile({ file, entityType: 'profile', entityId: 'u3', ownerUserId: 'u3' }).catch(
      (_ignored) => { /* Error is expected — we only care about the analytics event emitted on failure */ }
    )

    const events = analyticsRepo.getAll()
    const failed = events.find((e) => e.eventType === 'media_upload_failed')
    expect(failed).toBeDefined()
    expect(failed?.entityType).toBe('media')
  })

  it('cleans up orphaned storage object when DB insert fails (Bug #9)', async () => {
    await mockAuthSession('u1')
    const supabaseModule = await import('../../src/lib/supabase')
    const removeFn = vi.fn().mockResolvedValue({ error: null })
    vi.spyOn(supabaseModule.supabase.storage, 'from').mockReturnValue({
      upload: vi.fn().mockResolvedValue({ data: { path: 'job/j2/test.jpg' }, error: null }),
      getPublicUrl: vi.fn().mockReturnValue({
        data: { publicUrl: 'https://cdn.example.com/job/j2/test.jpg' },
      }),
      remove: removeFn,
    } as unknown as ReturnType<typeof supabaseModule.supabase.storage.from>)

    vi.spyOn(supabaseModule.supabase, 'from').mockReturnValue({
      insert: vi.fn().mockResolvedValue({ error: { message: 'DB insert failed' } }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.from>)

    const file = makeFile('photo.jpg', 'image/jpeg', 50_000)
    await expect(
      uploadMediaFile({ file, entityType: 'job', entityId: 'j2', ownerUserId: 'u1' })
    ).rejects.toThrow('konnte aber nicht gespeichert werden')

    // The storage remove call must have been attempted with the uploaded file path.
    expect(removeFn).toHaveBeenCalledOnce()
    const removedPaths: string[] = removeFn.mock.calls[0][0] as string[]
    expect(removedPaths).toHaveLength(1)
    expect(removedPaths[0]).toMatch(/^job\/j2\//)
  })
})

// ---------------------------------------------------------------------------
// InMemoryMediaRepository
// ---------------------------------------------------------------------------

describe('InMemoryMediaRepository', () => {
  it('starts empty', () => {
    const repo = new InMemoryMediaRepository()
    expect(repo.getAll()).toHaveLength(0)
  })

  it('stores and retrieves artifacts', () => {
    const repo = new InMemoryMediaRepository()
    repo.add({
      id: 'a1',
      jobId: 'job-1',
      kind: 'job_photo',
      label: 'Photo',
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      uploadedAt: 1000,
      uploadedBy: 'user-1',
    })
    expect(repo.getAll()).toHaveLength(1)
    expect(repo.getById('a1')).toBeDefined()
    expect(repo.getByJobId('job-1')).toHaveLength(1)
  })

  it('throws on duplicate artifact ids to match database behavior', () => {
    const repo = new InMemoryMediaRepository()
    const artifact = {
      id: 'a1',
      jobId: 'job-1',
      kind: 'job_photo' as const,
      label: 'Photo',
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      uploadedAt: 1000,
      uploadedBy: 'user-1',
    }
    repo.add(artifact)
    expect(() => repo.add(artifact)).toThrow(/Duplicate media artifact ID/)
  })

  it('retrieves dispute evidence by dispute id', () => {
    const repo = new InMemoryMediaRepository()
    repo.add({
      id: 'a2',
      jobId: 'job-2',
      kind: 'dispute_evidence',
      label: 'Evidence',
      filename: 'evidence.jpg',
      mimeType: 'image/jpeg',
      uploadedAt: 2000,
      uploadedBy: 'user-2',
      disputeId: 'dispute-1',
    })
    expect(repo.getByDisputeId('dispute-1')).toHaveLength(1)
    expect(repo.getByDisputeId('dispute-999')).toHaveLength(0)
  })

  it('notifies subscribers on add', () => {
    const repo = new InMemoryMediaRepository()
    let called = 0
    const unsubscribe = repo.subscribe(() => called++)

    repo.add({
      id: 'a3',
      jobId: 'job-3',
      kind: 'completion_photo',
      label: 'Done',
      filename: 'done.jpg',
      mimeType: 'image/jpeg',
      uploadedAt: 3000,
      uploadedBy: 'craftsman-1',
    })

    expect(called).toBe(1)
    unsubscribe()

    repo.add({
      id: 'a4',
      jobId: 'job-3',
      kind: 'completion_photo',
      label: 'Done2',
      filename: 'done2.jpg',
      mimeType: 'image/jpeg',
      uploadedAt: 4000,
      uploadedBy: 'craftsman-1',
    })

    // Should not be called after unsubscribe
    expect(called).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('Media upload constants', () => {
  it('MEDIA_STORAGE_BUCKET is "media"', () => {
    expect(MEDIA_STORAGE_BUCKET).toBe('media')
  })

  it('MAX_FILE_SIZE_BYTES is 10 MB', () => {
    expect(MAX_FILE_SIZE_BYTES).toBe(10 * 1024 * 1024)
  })

  it('MAX_VIDEO_SIZE_BYTES is 200 MB', () => {
    expect(MAX_VIDEO_SIZE_BYTES).toBe(200 * 1024 * 1024)
  })

  it('video limit is 20x the image limit', () => {
    expect(MAX_VIDEO_SIZE_BYTES).toBe(MAX_FILE_SIZE_BYTES * 20)
  })
})

// ---------------------------------------------------------------------------
// mediaRole — stored in PersistedMediaRecord
// ---------------------------------------------------------------------------

describe('uploadMediaFile — mediaRole field', () => {
  it('returns empty mediaRole when not specified', async () => {
    await mockAuthSession('user-1')
    const supabaseModule = await import('../../src/lib/supabase')
    vi.spyOn(supabaseModule.supabase.storage, 'from').mockReturnValue({
      upload: vi.fn().mockResolvedValue({ data: { path: 'profile/u1/test.jpg' }, error: null }),
      getPublicUrl: vi.fn().mockReturnValue({
        data: { publicUrl: 'https://cdn.example.com/profile/u1/test.jpg' },
      }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.storage.from>)

    vi.spyOn(supabaseModule.supabase, 'from').mockReturnValue({
      insert: vi.fn().mockResolvedValue({ error: null }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.from>)

    const file = makeFile('photo.jpg', 'image/jpeg', 50_000)
    const result = await uploadMediaFile({
      file,
      entityType: 'profile',
      entityId: 'user-1',
      ownerUserId: 'user-1',
    })

    expect(result.mediaRole).toBe('')
  })

  it('returns the specified mediaRole', async () => {
    await mockAuthSession('user-2')
    const supabaseModule = await import('../../src/lib/supabase')
    vi.spyOn(supabaseModule.supabase.storage, 'from').mockReturnValue({
      upload: vi.fn().mockResolvedValue({ data: { path: 'profile/u2/avatar.jpg' }, error: null }),
      getPublicUrl: vi.fn().mockReturnValue({
        data: { publicUrl: 'https://cdn.example.com/avatar.jpg' },
      }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.storage.from>)

    let capturedRow: Record<string, unknown> | null = null
    vi.spyOn(supabaseModule.supabase, 'from').mockReturnValue({
      insert: vi.fn().mockImplementation((row: Record<string, unknown>) => {
        capturedRow = row
        return Promise.resolve({ error: null })
      }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.from>)

    const file = makeFile('avatar.jpg', 'image/jpeg', 50_000)
    const result = await uploadMediaFile({
      file,
      entityType: 'profile',
      entityId: 'user-2',
      ownerUserId: 'user-2',
      mediaRole: 'avatar',
    })

    expect(result.mediaRole).toBe('avatar')
    expect(capturedRow?.media_role).toBe('avatar')
  })

  it('stores evidence role for dispute uploads', async () => {
    await mockAuthSession('user-3')
    const supabaseModule = await import('../../src/lib/supabase')
    vi.spyOn(supabaseModule.supabase.storage, 'from').mockReturnValue({
      upload: vi.fn().mockResolvedValue({ data: { path: 'dispute/d1/ev.jpg' }, error: null }),
      getPublicUrl: vi.fn().mockReturnValue({
        data: { publicUrl: 'https://cdn.example.com/ev.jpg' },
      }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.storage.from>)

    vi.spyOn(supabaseModule.supabase, 'from').mockReturnValue({
      insert: vi.fn().mockResolvedValue({ error: null }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.from>)

    const file = makeFile('evidence.png', 'image/png', 200_000)
    const result = await uploadMediaFile({
      file,
      entityType: 'dispute',
      entityId: 'dispute-1',
      ownerUserId: 'user-3',
      mediaRole: 'evidence',
    })

    expect(result.entityType).toBe('dispute')
    expect(result.mediaRole).toBe('evidence')
  })
})

// ---------------------------------------------------------------------------
// Showcase entity type — video foundation
// ---------------------------------------------------------------------------

describe('uploadMediaFile — showcase entity type', () => {
  it('accepts showcase entity type with image', async () => {
    await mockAuthSession('user-4')
    const supabaseModule = await import('../../src/lib/supabase')
    vi.spyOn(supabaseModule.supabase.storage, 'from').mockReturnValue({
      upload: vi.fn().mockResolvedValue({ data: { path: 'showcase/prov-1/ph.jpg' }, error: null }),
      getPublicUrl: vi.fn().mockReturnValue({
        data: { publicUrl: 'https://cdn.example.com/showcase/ph.jpg' },
      }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.storage.from>)

    vi.spyOn(supabaseModule.supabase, 'from').mockReturnValue({
      insert: vi.fn().mockResolvedValue({ error: null }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.from>)

    const file = makeFile('work.jpg', 'image/jpeg', 1_000_000)
    const result = await uploadMediaFile({
      file,
      entityType: 'showcase',
      entityId: 'prov-1',
      ownerUserId: 'user-4',
      mediaRole: 'showcase',
    })

    expect(result.entityType).toBe('showcase')
    expect(result.mediaType).toBe('image')
    expect(result.mediaRole).toBe('showcase')
  })

  it('accepts showcase entity type with MP4 video', async () => {
    await mockAuthSession('user-5')
    const supabaseModule = await import('../../src/lib/supabase')
    vi.spyOn(supabaseModule.supabase.storage, 'from').mockReturnValue({
      upload: vi.fn().mockResolvedValue({ data: { path: 'showcase/prov-2/clip.mp4' }, error: null }),
      getPublicUrl: vi.fn().mockReturnValue({
        data: { publicUrl: 'https://cdn.example.com/showcase/clip.mp4' },
      }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.storage.from>)

    vi.spyOn(supabaseModule.supabase, 'from').mockReturnValue({
      insert: vi.fn().mockResolvedValue({ error: null }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.from>)

    const file = makeFile('clip.mp4', 'video/mp4', 20 * 1024 * 1024) // 20 MB video
    const result = await uploadMediaFile({
      file,
      entityType: 'showcase',
      entityId: 'prov-2',
      ownerUserId: 'user-5',
      mediaRole: 'showcase',
    })

    expect(result.entityType).toBe('showcase')
    expect(result.mediaType).toBe('video')
    expect(result.mediaRole).toBe('showcase')
    expect(result.mimeType).toBe('video/mp4')
  })

  it('rejects a showcase video over 50 MB', () => {
    const bigVideo = makeFile('clip.mp4', 'video/mp4', MAX_VIDEO_SIZE_BYTES + 1)
    const result = validateMediaFile(bigVideo)
    expect(result.valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// buildStoragePath — showcase path
// ---------------------------------------------------------------------------

describe('buildStoragePath — showcase paths', () => {
  it('builds showcase/providerId/uuid.jpg for showcase image', () => {
    const path = buildStoragePath('showcase', 'prov-abc', 'image/jpeg')
    expect(path).toMatch(/^showcase\/prov-abc\/[a-f0-9-]+\.jpg$/)
  })

  it('builds showcase/providerId/uuid.mp4 for showcase video', () => {
    const path = buildStoragePath('showcase', 'prov-abc', 'video/mp4')
    expect(path).toMatch(/^showcase\/prov-abc\/[a-f0-9-]+\.mp4$/)
  })

  it('builds dispute/disputeId/uuid.png for dispute evidence', () => {
    const path = buildStoragePath('dispute', 'dispute-1', 'image/png')
    expect(path).toMatch(/^dispute\/dispute-1\/[a-f0-9-]+\.png$/)
  })
})

// ---------------------------------------------------------------------------
// Auth session verification — Root Cause Fix for media_uploads insert
// ---------------------------------------------------------------------------

describe('uploadMediaFile — auth session verification', () => {
  it('throws when no auth session exists', async () => {
    await mockNoAuthSession()

    const file = makeFile('photo.jpg', 'image/jpeg', 50_000)
    await expect(
      uploadMediaFile({ file, entityType: 'profile', entityId: 'u1', ownerUserId: 'u1' })
    ).rejects.toThrow('Nicht angemeldet')
  })

  it('uses auth user ID as owner_user_id in the insert row', async () => {
    const authUserId = 'auth-user-real-id'
    await mockAuthSession(authUserId)

    const supabaseModule = await import('../../src/lib/supabase')
    vi.spyOn(supabaseModule.supabase.storage, 'from').mockReturnValue({
      upload: vi.fn().mockResolvedValue({ data: { path: 'profile/u1/test.jpg' }, error: null }),
      getPublicUrl: vi.fn().mockReturnValue({
        data: { publicUrl: 'https://cdn.example.com/profile/u1/test.jpg' },
      }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.storage.from>)

    let capturedRow: Record<string, unknown> | null = null
    vi.spyOn(supabaseModule.supabase, 'from').mockReturnValue({
      insert: vi.fn().mockImplementation((row: Record<string, unknown>) => {
        capturedRow = row
        return Promise.resolve({ error: null })
      }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.from>)

    const file = makeFile('photo.jpg', 'image/jpeg', 50_000)
    const result = await uploadMediaFile({
      file,
      entityType: 'profile',
      entityId: 'u1',
      ownerUserId: authUserId,
    })

    // The insert row must use the auth user ID
    expect(capturedRow?.owner_user_id).toBe(authUserId)
    // The returned record must also use the auth user ID
    expect(result.ownerUserId).toBe(authUserId)
  })

  it('corrects mismatched ownerUserId to match auth user ID', async () => {
    const authUserId = 'real-auth-uid-123'
    const wrongCallerId = 'some-profile-id-456'
    await mockAuthSession(authUserId)

    const supabaseModule = await import('../../src/lib/supabase')
    vi.spyOn(supabaseModule.supabase.storage, 'from').mockReturnValue({
      upload: vi.fn().mockResolvedValue({ data: { path: 'job/j1/test.jpg' }, error: null }),
      getPublicUrl: vi.fn().mockReturnValue({
        data: { publicUrl: 'https://cdn.example.com/job/j1/test.jpg' },
      }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.storage.from>)

    let capturedRow: Record<string, unknown> | null = null
    vi.spyOn(supabaseModule.supabase, 'from').mockReturnValue({
      insert: vi.fn().mockImplementation((row: Record<string, unknown>) => {
        capturedRow = row
        return Promise.resolve({ error: null })
      }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.from>)

    const file = makeFile('photo.jpg', 'image/jpeg', 50_000)
    const result = await uploadMediaFile({
      file,
      entityType: 'job',
      entityId: 'j1',
      ownerUserId: wrongCallerId, // caller passes wrong ID
    })

    // The insert row must use the auth user ID, NOT the caller's wrong ID
    expect(capturedRow?.owner_user_id).toBe(authUserId)
    expect(capturedRow?.owner_user_id).not.toBe(wrongCallerId)
    // The returned record must also use the corrected auth user ID
    expect(result.ownerUserId).toBe(authUserId)
  })

  it('DB insert error includes Supabase error details in thrown message', async () => {
    await mockAuthSession('u1')
    const supabaseModule = await import('../../src/lib/supabase')
    vi.spyOn(supabaseModule.supabase.storage, 'from').mockReturnValue({
      upload: vi.fn().mockResolvedValue({ data: { path: 'job/j3/test.jpg' }, error: null }),
      getPublicUrl: vi.fn().mockReturnValue({
        data: { publicUrl: 'https://cdn.example.com/job/j3/test.jpg' },
      }),
      remove: vi.fn().mockResolvedValue({ error: null }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.storage.from>)

    vi.spyOn(supabaseModule.supabase, 'from').mockReturnValue({
      insert: vi.fn().mockResolvedValue({
        error: {
          message: 'new row violates row-level security policy',
          details: null,
          hint: null,
          code: '42501',
        },
      }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.from>)

    const file = makeFile('photo.jpg', 'image/jpeg', 50_000)
    await expect(
      uploadMediaFile({ file, entityType: 'job', entityId: 'j3', ownerUserId: 'u1' })
    ).rejects.toThrow('row-level security')
  })

  it('DB insert error includes error code in thrown message', async () => {
    await mockAuthSession('u1')
    const supabaseModule = await import('../../src/lib/supabase')
    vi.spyOn(supabaseModule.supabase.storage, 'from').mockReturnValue({
      upload: vi.fn().mockResolvedValue({ data: { path: 'job/j4/test.jpg' }, error: null }),
      getPublicUrl: vi.fn().mockReturnValue({
        data: { publicUrl: 'https://cdn.example.com/job/j4/test.jpg' },
      }),
      remove: vi.fn().mockResolvedValue({ error: null }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.storage.from>)

    vi.spyOn(supabaseModule.supabase, 'from').mockReturnValue({
      insert: vi.fn().mockResolvedValue({
        error: {
          message: 'null value in column "media_role" violates not-null constraint',
          code: '23502',
        },
      }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.from>)

    const file = makeFile('photo.jpg', 'image/jpeg', 50_000)
    await expect(
      uploadMediaFile({ file, entityType: 'job', entityId: 'j4', ownerUserId: 'u1' })
    ).rejects.toThrow('23502')
  })

  it('insert row contains all required NOT NULL fields', async () => {
    await mockAuthSession('u-check')
    const supabaseModule = await import('../../src/lib/supabase')
    vi.spyOn(supabaseModule.supabase.storage, 'from').mockReturnValue({
      upload: vi.fn().mockResolvedValue({ data: { path: 'profile/u-check/test.jpg' }, error: null }),
      getPublicUrl: vi.fn().mockReturnValue({
        data: { publicUrl: 'https://cdn.example.com/profile/u-check/test.jpg' },
      }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.storage.from>)

    let capturedRow: Record<string, unknown> | null = null
    vi.spyOn(supabaseModule.supabase, 'from').mockReturnValue({
      insert: vi.fn().mockImplementation((row: Record<string, unknown>) => {
        capturedRow = row
        return Promise.resolve({ error: null })
      }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.from>)

    const file = makeFile('photo.jpg', 'image/jpeg', 50_000)
    await uploadMediaFile({
      file,
      entityType: 'profile',
      entityId: 'u-check',
      ownerUserId: 'u-check',
    })

    // All NOT NULL columns must be present and defined
    expect(capturedRow).not.toBeNull()
    expect(capturedRow!.id).toBeTruthy()
    expect(capturedRow!.owner_user_id).toBe('u-check')
    expect(capturedRow!.entity_type).toBe('profile')
    expect(capturedRow!.entity_id).toBe('u-check')
    expect(capturedRow!.file_path).toBeTruthy()
    expect(capturedRow!.public_url).toBeTruthy()
    expect(capturedRow!.mime_type).toBe('image/jpeg')
    expect(capturedRow!.media_type).toBe('image')
    expect(capturedRow!.media_role).toBe('')
    expect(capturedRow!.created_at).toBeGreaterThan(0)
  })

  it('failed insert still cleans up uploaded storage file', async () => {
    await mockAuthSession('u1')
    const supabaseModule = await import('../../src/lib/supabase')
    const removeFn = vi.fn().mockResolvedValue({ error: null })
    vi.spyOn(supabaseModule.supabase.storage, 'from').mockReturnValue({
      upload: vi.fn().mockResolvedValue({ data: { path: 'profile/u1/cleanup.jpg' }, error: null }),
      getPublicUrl: vi.fn().mockReturnValue({
        data: { publicUrl: 'https://cdn.example.com/profile/u1/cleanup.jpg' },
      }),
      remove: removeFn,
    } as unknown as ReturnType<typeof supabaseModule.supabase.storage.from>)

    vi.spyOn(supabaseModule.supabase, 'from').mockReturnValue({
      insert: vi.fn().mockResolvedValue({
        error: { message: 'RLS violation', code: '42501' },
      }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.from>)

    const file = makeFile('cleanup.jpg', 'image/jpeg', 50_000)
    await uploadMediaFile({
      file,
      entityType: 'profile',
      entityId: 'u1',
      ownerUserId: 'u1',
    }).catch(() => { /* expected */ })

    // Storage cleanup must have been called
    expect(removeFn).toHaveBeenCalledOnce()
    const removedPaths: string[] = removeFn.mock.calls[0][0] as string[]
    expect(removedPaths).toHaveLength(1)
    expect(removedPaths[0]).toMatch(/^profile\/u1\//)
  })
})
