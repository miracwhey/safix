import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// Same in-memory mock as uploadOutbox.test.ts so the two modules share
// nothing across files.
vi.mock('idb-keyval', () => {
  const store = new Map<string, unknown>()
  return {
    get: vi.fn(async (key: string) => store.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value)
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key)
    }),
    keys: vi.fn(async () => Array.from(store.keys())),
    __reset: () => store.clear(),
  }
})

import { tryUploadOrEnqueue } from '../../src/lib/media/uploadOrEnqueue'
import { listOutbox } from '../../src/lib/media/uploadOutbox'

async function resetStore() {
  const idb = await import('idb-keyval')
  ;(idb as unknown as { __reset: () => void }).__reset()
}

function makeFile(name = 'photo.jpg'): File {
  return new File([new Uint8Array(1024)], name, { type: 'image/jpeg' })
}

const baseInput = {
  entityType: 'job' as const,
  entityId: 'job-1',
  ownerUserId: 'u1',
  mediaRole: 'progress',
}

// `globalThis.navigator` in Node is exposed as a getter-only property on
// modern releases, so direct assignment and `Object.defineProperty` both
// throw. `vi.stubGlobal` is the supported Vitest path: it shadows the
// global within the test scope and is restored automatically.
function setOnline(value: boolean): void {
  vi.stubGlobal('navigator', { onLine: value })
}

beforeEach(async () => {
  await resetStore()
  setOnline(true)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// Offline pre-flight
// ---------------------------------------------------------------------------

describe('tryUploadOrEnqueue — offline pre-flight', () => {
  it('enqueues without attempting the network when navigator.onLine is false', async () => {
    setOnline(false)

    const mediaModule = await import('../../src/lib/media/mediaUploadService')
    const uploadSpy = vi.spyOn(mediaModule, 'uploadMediaFile')

    const result = await tryUploadOrEnqueue(
      { ...baseInput, file: makeFile() },
      { label: 'Foto' }
    )

    expect(result.status).toBe('queued')
    if (result.status === 'queued') {
      expect(result.reason).toBe('offline')
      expect(result.entry.label).toBe('Foto')
    }
    expect(uploadSpy).not.toHaveBeenCalled()
    expect((await listOutbox()).length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Network-error fallback
// ---------------------------------------------------------------------------

describe('tryUploadOrEnqueue — online with network failure', () => {
  it('enqueues when the upload throws a network-shaped error', async () => {
    const mediaModule = await import('../../src/lib/media/mediaUploadService')
    vi.spyOn(mediaModule, 'uploadMediaFile').mockRejectedValue(
      new Error('Failed to fetch')
    )

    const result = await tryUploadOrEnqueue({ ...baseInput, file: makeFile() })

    expect(result.status).toBe('queued')
    if (result.status === 'queued') {
      expect(result.reason).toBe('network_error')
    }
    expect((await listOutbox()).length).toBe(1)
  })

  it('rethrows non-network errors so the user sees the real reason', async () => {
    const mediaModule = await import('../../src/lib/media/mediaUploadService')
    vi.spyOn(mediaModule, 'uploadMediaFile').mockRejectedValue(
      new Error('Ungültiger Dateityp "application/pdf".')
    )

    await expect(
      tryUploadOrEnqueue({ ...baseInput, file: makeFile() })
    ).rejects.toThrow(/Dateityp/)

    expect((await listOutbox()).length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// U1 — idempotency key threading
// ---------------------------------------------------------------------------

describe('tryUploadOrEnqueue — idempotency key', () => {
  it('offline: enqueues with a stable idempotency key', async () => {
    setOnline(false)
    const result = await tryUploadOrEnqueue({ ...baseInput, file: makeFile() })
    expect(result.status).toBe('queued')
    if (result.status === 'queued') {
      expect(result.entry.idempotencyKey).toBeTruthy()
    }
  })

  it('network error: the SAME key is passed to the upload attempt and the queued entry', async () => {
    const mediaModule = await import('../../src/lib/media/mediaUploadService')
    const uploadSpy = vi
      .spyOn(mediaModule, 'uploadMediaFile')
      .mockRejectedValue(new Error('Failed to fetch'))

    const result = await tryUploadOrEnqueue({ ...baseInput, file: makeFile() })

    expect(result.status).toBe('queued')
    const attemptedKey = uploadSpy.mock.calls[0]?.[0]?.idempotencyKey
    expect(attemptedKey).toBeTruthy()
    if (result.status === 'queued') {
      // First-attempt key === queued key → a post-commit-timeout retry from the
      // outbox re-targets the same storage object + media_uploads row.
      expect(result.entry.idempotencyKey).toBe(attemptedKey)
    }
  })
})

describe('tryUploadOrEnqueue — happy path', () => {
  it('returns uploaded with the persisted record on success', async () => {
    const mediaModule = await import('../../src/lib/media/mediaUploadService')
    const fakeRecord = {
      id: 'rec-1',
      ownerUserId: 'u1',
      entityType: 'job' as const,
      entityId: 'job-1',
      filePath: 'job/job-1/abc.jpg',
      publicUrl: 'https://cdn.example.com/job/job-1/abc.jpg',
      mimeType: 'image/jpeg',
      mediaType: 'image' as const,
      mediaRole: 'progress',
      createdAt: Date.now(),
    }
    vi.spyOn(mediaModule, 'uploadMediaFile').mockResolvedValue(fakeRecord)

    const result = await tryUploadOrEnqueue({ ...baseInput, file: makeFile() })

    expect(result.status).toBe('uploaded')
    if (result.status === 'uploaded') {
      expect(result.record.id).toBe('rec-1')
    }
    expect((await listOutbox()).length).toBe(0)
  })
})
