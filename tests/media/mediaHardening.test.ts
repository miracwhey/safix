import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import {
  sanitizePathSegment,
  buildStoragePath,
  validateMediaFile,
  deleteMediaFile,
  IMAGE_ACCEPT,
  IMAGE_VIDEO_ACCEPT,
} from '../../src/lib/media/mediaUploadService'
import { InMemoryMediaRepository } from '../../src/lib/media/repository/InMemoryMediaRepository'
import { setMediaRepository } from '../../src/lib/media/repository/registry'
import { InMemoryAnalyticsRepository } from '../../src/lib/analytics/repository/InMemoryAnalyticsRepository'
import { setAnalyticsRepository } from '../../src/lib/analytics/repository/registry'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/** Magic-byte headers — see tests/media/mediaUpload.test.ts for the full set. */
const MAGIC_BYTES: Record<string, number[]> = {
  'image/jpeg': [0xff, 0xd8, 0xff, 0xe0],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'video/mp4': [0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d],
}

function makeFile(
  name = 'photo.jpg',
  type = 'image/jpeg',
  sizeBytes = 100_000
): File {
  const content = new Uint8Array(sizeBytes).fill(0)
  const header = MAGIC_BYTES[type]
  if (header) content.set(header, 0)
  return new File([content], name, { type })
}

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

beforeEach(() => {
  setMediaRepository(new InMemoryMediaRepository())
  setAnalyticsRepository(new InMemoryAnalyticsRepository())
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// sanitizePathSegment
// ---------------------------------------------------------------------------

describe('sanitizePathSegment', () => {
  it('returns a normal segment unchanged', () => {
    expect(sanitizePathSegment('user-abc-123')).toBe('user-abc-123')
  })

  it('removes path traversal sequences (..)', () => {
    expect(sanitizePathSegment('../../../etc')).toBe('etc')
  })

  it('removes forward slashes', () => {
    expect(sanitizePathSegment('a/b/c')).toBe('abc')
  })

  it('removes backslashes', () => {
    expect(sanitizePathSegment('a\\b\\c')).toBe('abc')
  })

  it('removes control characters', () => {
    expect(sanitizePathSegment('hello\x00world\x1f')).toBe('helloworld')
  })

  it('trims leading and trailing whitespace', () => {
    expect(sanitizePathSegment('  hello  ')).toBe('hello')
  })

  it('returns underscore for empty input', () => {
    expect(sanitizePathSegment('')).toBe('_')
  })

  it('returns underscore for whitespace-only input', () => {
    expect(sanitizePathSegment('   ')).toBe('_')
  })

  it('returns underscore for traversal-only input', () => {
    expect(sanitizePathSegment('../..')).toBe('_')
  })

  it('handles combined dangerous input', () => {
    const result = sanitizePathSegment('../\x00/etc\\passwd')
    expect(result).not.toContain('/')
    expect(result).not.toContain('\\')
    expect(result).not.toContain('..')
    expect(result).not.toContain('\x00')
    expect(result.length).toBeGreaterThan(0)
  })

  it('decodes percent-encoded traversal sequences before sanitizing', () => {
    const result = sanitizePathSegment('%2e%2e%2Fetc')
    expect(result).not.toContain('..')
    expect(result).not.toContain('/')
  })
})

// ---------------------------------------------------------------------------
// buildStoragePath — sanitization
// ---------------------------------------------------------------------------

describe('buildStoragePath — sanitized segments', () => {
  it('sanitizes entityType containing path traversal', () => {
    const path = buildStoragePath('../../admin', 'user-1', 'image/jpeg')
    expect(path).not.toContain('..')
    expect(path).toMatch(/^[^/]+\/[^/]+\/[a-f0-9-]+\.jpg$/)
  })

  it('sanitizes entityId containing slashes', () => {
    const path = buildStoragePath('profile', 'user/../../secret', 'image/png')
    expect(path).not.toContain('..')
    expect(path.split('/').length).toBe(3) // entityType/entityId/file.ext
  })

  it('handles empty entityId gracefully', () => {
    const path = buildStoragePath('profile', '', 'image/jpeg')
    expect(path).toMatch(/^profile\/_\/[a-f0-9-]+\.jpg$/)
  })
})

// ---------------------------------------------------------------------------
// validateMediaFile — empty file rejection
// ---------------------------------------------------------------------------

describe('validateMediaFile — empty file', () => {
  it('rejects a zero-byte file', () => {
    const empty = new File([], 'empty.jpg', { type: 'image/jpeg' })
    const result = validateMediaFile(empty)
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.reason).toContain('leer')
    }
  })
})

// ---------------------------------------------------------------------------
// IMAGE_ACCEPT and IMAGE_VIDEO_ACCEPT constants
// ---------------------------------------------------------------------------

describe('accept attribute constants', () => {
  // Why image/* wildcard rather than an explicit MIME list:
  //   iOS WebView only auto-converts HEIC → JPEG when the input's `accept`
  //   attribute is the wildcard. With an explicit list the picker hands back
  //   raw HEIC, which then fails MIME validation. The wildcard is the
  //   product-correct value for craftsmen on iPhone; server-side
  //   validateMediaFile() still rejects unsupported types.
  it('IMAGE_ACCEPT uses image/* wildcard for iOS HEIC auto-conversion', () => {
    expect(IMAGE_ACCEPT).toBe('image/*')
  })

  it('IMAGE_VIDEO_ACCEPT uses image/* and video/* wildcards', () => {
    expect(IMAGE_VIDEO_ACCEPT).toContain('image/*')
    expect(IMAGE_VIDEO_ACCEPT).toContain('video/*')
  })
})

// ---------------------------------------------------------------------------
// deleteMediaFile — resilient delete (treats storage 404 as success)
// ---------------------------------------------------------------------------

describe('deleteMediaFile — resilient delete', () => {
  it('proceeds to delete DB row when storage file is already gone (404)', async () => {
    const supabaseModule = await import('../../src/lib/supabase')
    vi.spyOn(supabaseModule.supabase.storage, 'from').mockReturnValue({
      remove: vi.fn().mockResolvedValue({
        error: { message: 'Object not found' },
      }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.storage.from>)

    const deleteFn = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    })
    vi.spyOn(supabaseModule.supabase, 'from').mockReturnValue({
      delete: deleteFn,
    } as unknown as ReturnType<typeof supabaseModule.supabase.from>)

    // Should NOT throw — storage 404 is treated as success
    await deleteMediaFile({ id: 'rec-1', filePath: 'profile/u1/old.jpg' })

    // DB delete should still have been called
    expect(deleteFn).toHaveBeenCalled()
  })

  it('throws when storage delete fails with a real error (non-404)', async () => {
    const supabaseModule = await import('../../src/lib/supabase')
    vi.spyOn(supabaseModule.supabase.storage, 'from').mockReturnValue({
      remove: vi.fn().mockResolvedValue({
        error: { message: 'Permission denied' },
      }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.storage.from>)

    await expect(
      deleteMediaFile({ id: 'rec-2', filePath: 'profile/u2/old.jpg' })
    ).rejects.toThrow('Datei konnte nicht gelöscht werden')
  })
})

// ---------------------------------------------------------------------------
// User-facing error messages are German, not raw backend errors
// ---------------------------------------------------------------------------

describe('user-facing error messages', () => {
  it('storage upload failure returns German user message (no raw Supabase error)', async () => {
    await mockAuthSession('u1')
    const supabaseModule = await import('../../src/lib/supabase')
    vi.spyOn(supabaseModule.supabase.storage, 'from').mockReturnValue({
      upload: vi.fn().mockResolvedValue({ data: null, error: { message: 'CORS blocked' } }),
      getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: '' } }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.storage.from>)

    const { uploadMediaFile } = await import('../../src/lib/media/mediaUploadService')
    const file = makeFile('photo.jpg', 'image/jpeg', 50_000)
    try {
      await uploadMediaFile({ file, entityType: 'profile', entityId: 'u1', ownerUserId: 'u1' })
      expect.unreachable('should have thrown')
    } catch (err) {
      const msg = (err as Error).message
      // Should NOT contain raw backend error
      expect(msg).not.toContain('CORS')
      // Should be German user-facing
      expect(msg).toContain('hochgeladen')
    }
  })

  it('DB insert failure includes diagnostic detail for debugging', async () => {
    await mockAuthSession('u1')
    const supabaseModule = await import('../../src/lib/supabase')
    vi.spyOn(supabaseModule.supabase.storage, 'from').mockReturnValue({
      upload: vi.fn().mockResolvedValue({ data: { path: 'profile/u1/test.jpg' }, error: null }),
      getPublicUrl: vi.fn().mockReturnValue({
        data: { publicUrl: 'https://cdn.example.com/profile/u1/test.jpg' },
      }),
      remove: vi.fn().mockResolvedValue({ error: null }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.storage.from>)

    vi.spyOn(supabaseModule.supabase, 'from').mockReturnValue({
      insert: vi.fn().mockResolvedValue({ error: { message: 'unique_violation pkey', code: '23505' } }),
    } as unknown as ReturnType<typeof supabaseModule.supabase.from>)

    const { uploadMediaFile } = await import('../../src/lib/media/mediaUploadService')
    const file = makeFile('photo.jpg', 'image/jpeg', 50_000)
    try {
      await uploadMediaFile({ file, entityType: 'profile', entityId: 'u1', ownerUserId: 'u1' })
      expect.unreachable('should have thrown')
    } catch (err) {
      const msg = (err as Error).message
      // Error message now includes the DB error detail for diagnosability
      expect(msg).toContain('gespeichert')
      expect(msg).toContain('unique_violation')
      expect(msg).toContain('23505')
    }
  })
})

// ---------------------------------------------------------------------------
// Barrel exports include new constants
// ---------------------------------------------------------------------------

describe('barrel exports include hardening additions', () => {
  it('exports sanitizePathSegment from barrel', async () => {
    const barrel = await import('../../src/lib/media/index')
    expect(barrel.sanitizePathSegment).toBeDefined()
    expect(typeof barrel.sanitizePathSegment).toBe('function')
  })

  it('exports IMAGE_ACCEPT from barrel', async () => {
    const barrel = await import('../../src/lib/media/index')
    expect(barrel.IMAGE_ACCEPT).toBeDefined()
    expect(typeof barrel.IMAGE_ACCEPT).toBe('string')
  })

  it('exports IMAGE_VIDEO_ACCEPT from barrel', async () => {
    const barrel = await import('../../src/lib/media/index')
    expect(barrel.IMAGE_VIDEO_ACCEPT).toBeDefined()
    expect(typeof barrel.IMAGE_VIDEO_ACCEPT).toBe('string')
  })
})
