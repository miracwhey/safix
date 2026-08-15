import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// In-memory idb-keyval so the outbox store is isolated per test run.
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

// Mock the network-level uploader — the runner calls uploadMediaFileDirect.
vi.mock('../../src/lib/media/mediaUploadService', () => ({
  uploadMediaFileDirect: vi.fn(),
}))

// Mock the Supabase client so we control the current auth uid (the M1 guard).
// `vi.hoisted` so the mock fn exists when the hoisted vi.mock factory runs.
const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }))
vi.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { getSession: getSessionMock } },
}))

// Silence observability.
vi.mock('../../src/lib/observability', () => ({
  logInfo: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
}))

import { enqueueUpload, listOutbox } from '../../src/lib/media/uploadOutbox'
import { runOutboxNowForTest, retryFailedUploads } from '../../src/lib/media/outboxRunner'
import { uploadMediaFileDirect } from '../../src/lib/media/mediaUploadService'
import {
  getPersistenceFailures,
  clearPersistenceFailures,
} from '../../src/lib/persistence/persistenceErrorStore'

const uploadDirect = vi.mocked(uploadMediaFileDirect)

async function resetStore() {
  const idb = await import('idb-keyval')
  ;(idb as unknown as { __reset: () => void }).__reset()
}

function makeFile(): File {
  return new File([new Uint8Array(1024)], 'photo.jpg', { type: 'image/jpeg' })
}

function setUid(uid: string | null): void {
  getSessionMock.mockResolvedValue({ data: { session: uid ? { user: { id: uid } } : null } })
}

function enqueueFor(ownerUserId: string, maxRetries = 5) {
  return enqueueUpload({
    file: makeFile(),
    entityType: 'job',
    entityId: 'job-1',
    ownerUserId,
    mediaRole: 'progress',
    idempotencyKey: `idem-${ownerUserId}`,
    label: 'Foto',
    maxRetries,
  })
}

beforeEach(async () => {
  await resetStore()
  clearPersistenceFailures()
  uploadDirect.mockReset()
  vi.stubGlobal('navigator', { onLine: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// M1 — cross-account drain guard
// ---------------------------------------------------------------------------

describe('outbox runner — user scoping (M1)', () => {
  it('does NOT drain an entry owned by a different signed-in user', async () => {
    await enqueueFor('userA')
    setUid('userB') // a different user is now signed in (shared device)

    await runOutboxNowForTest()

    expect(uploadDirect).not.toHaveBeenCalled()
    const remaining = await listOutbox()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].status).toBe('pending') // quarantined, not lost
  })

  it('drains the entry once its real owner is signed in', async () => {
    await enqueueFor('userA')
    setUid('userA')
    uploadDirect.mockResolvedValue(undefined as never)

    await runOutboxNowForTest()

    expect(uploadDirect).toHaveBeenCalledTimes(1)
    // U1: the stable idempotency key is threaded through to the upload.
    expect(uploadDirect.mock.calls[0][0]).toMatchObject({ idempotencyKey: 'idem-userA' })
    expect(await listOutbox()).toHaveLength(0)
  })

  it('drains nothing when no user is signed in', async () => {
    await enqueueFor('userA')
    setUid(null)

    await runOutboxNowForTest()

    expect(uploadDirect).not.toHaveBeenCalled()
    expect(await listOutbox()).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// H1 — exhausted uploads surface + are retryable
// ---------------------------------------------------------------------------

describe('outbox runner — failure visibility (H1)', () => {
  it('records a permanent media failure when an upload exhausts its retries', async () => {
    await enqueueFor('userA', 1) // single attempt budget
    setUid('userA')
    uploadDirect.mockRejectedValue(new Error('Failed to fetch'))

    await runOutboxNowForTest()

    const entries = await listOutbox()
    expect(entries[0].status).toBe('failed')

    const failures = getPersistenceFailures()
    const mediaFailure = failures.find((f) => f.domain === 'media')
    expect(mediaFailure).toBeDefined()
    expect(mediaFailure?.permanent).toBe(true)
  })

  it('retryFailedUploads re-arms the failed entry and clears the banner on success', async () => {
    await enqueueFor('userA', 1)
    setUid('userA')
    uploadDirect.mockRejectedValueOnce(new Error('Failed to fetch'))
    await runOutboxNowForTest()
    expect(getPersistenceFailures().some((f) => f.domain === 'media')).toBe(true)

    // Now the network is back — the user taps "Erneut versuchen".
    uploadDirect.mockResolvedValue(undefined as never)
    await retryFailedUploads()

    expect(await listOutbox()).toHaveLength(0)
    expect(getPersistenceFailures().some((f) => f.domain === 'media')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// B1-P1 — failure visibility survives a reload / app-kill
// ---------------------------------------------------------------------------

describe('outbox runner — visibility survives reload (B1-P1)', () => {
  it('re-records the permanent failure for a failed entry after an in-memory reset', async () => {
    await enqueueFor('userA', 1)
    setUid('userA')
    uploadDirect.mockRejectedValue(new Error('Failed to fetch'))
    await runOutboxNowForTest()
    expect((await listOutbox())[0].status).toBe('failed')

    // Simulate app reload: the in-memory failure store is wiped, but the
    // durable outbox entry survives in IndexedDB.
    clearPersistenceFailures()
    expect(getPersistenceFailures()).toHaveLength(0)

    await runOutboxNowForTest()

    const mediaFailure = getPersistenceFailures().find((f) => f.domain === 'media')
    expect(mediaFailure).toBeDefined()
    expect(mediaFailure?.permanent).toBe(true)
    // Re-recording is visibility-only — the entry is not re-armed.
    expect((await listOutbox())[0].status).toBe('failed')
  })

  it('does NOT restore another user\'s failed-upload visibility (owner-scoped)', async () => {
    await enqueueFor('userA', 1)
    setUid('userA')
    uploadDirect.mockRejectedValue(new Error('Failed to fetch'))
    await runOutboxNowForTest()

    clearPersistenceFailures() // reload
    setUid('userB') // a different user is now signed in (shared device)

    await runOutboxNowForTest()

    expect(getPersistenceFailures().some((f) => f.domain === 'media')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// B1-P2 — retry is owner-scoped
// ---------------------------------------------------------------------------

describe('outbox runner — retry is owner-scoped (B1-P2)', () => {
  it('does NOT re-arm or clear another user\'s failed upload', async () => {
    await enqueueFor('userA', 1)
    setUid('userA')
    uploadDirect.mockRejectedValue(new Error('Failed to fetch'))
    await runOutboxNowForTest()
    expect(getPersistenceFailures().some((f) => f.domain === 'media')).toBe(true)

    // A different user taps "Erneut versuchen" on the shared device.
    setUid('userB')
    uploadDirect.mockClear()
    uploadDirect.mockResolvedValue(undefined as never)
    await retryFailedUploads()

    // userA's entry stays failed, banner untouched, no drain attempted.
    expect((await listOutbox())[0].status).toBe('failed')
    expect(getPersistenceFailures().some((f) => f.domain === 'media')).toBe(true)
    expect(uploadDirect).not.toHaveBeenCalled()
  })
})
