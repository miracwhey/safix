import { describe, it, expect, beforeEach, vi } from 'vitest'

// idb-keyval reads from real IndexedDB by default. The default `defaultStore`
// instance is global, so tests must mock the module to keep state isolated.
// We replace it with an in-memory Map-backed implementation.
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

import {
  enqueueUpload,
  listOutbox,
  removeOutboxEntry,
  updateOutboxEntry,
  getOutboxEntry,
  clearOutbox,
  reconcileOutboxIndex,
  subscribeToOutbox,
  MAX_OUTBOX_TOTAL_BYTES,
} from '../../src/lib/media/uploadOutbox'

// Pull the reset hook from the mock so each test starts with empty state.
async function resetStore() {
  const idb = await import('idb-keyval')
  ;(idb as unknown as { __reset: () => void }).__reset()
}

function makeFile(size = 1024, name = 'photo.jpg'): File {
  return new File([new Uint8Array(size)], name, { type: 'image/jpeg' })
}

beforeEach(async () => {
  await resetStore()
})

// ---------------------------------------------------------------------------
// enqueue + list + getOutboxEntry
// ---------------------------------------------------------------------------

describe('enqueueUpload', () => {
  it('persists an entry and returns it with default fields populated', async () => {
    const entry = await enqueueUpload({
      file: makeFile(),
      entityType: 'job',
      entityId: 'job-1',
      ownerUserId: 'u1',
      mediaRole: 'progress',
      idempotencyKey: 'idem',
      label: 'Foto',
    })
    expect(entry.id).toBeTruthy()
    expect(entry.idempotencyKey).toBe('idem')
    expect(entry.status).toBe('pending')
    expect(entry.retries).toBe(0)
    expect(entry.maxRetries).toBeGreaterThan(0)
    expect(entry.nextAttemptAt).toBeLessThanOrEqual(Date.now())
  })

  it('listOutbox returns entries in enqueue order', async () => {
    const a = await enqueueUpload({
      file: makeFile(),
      entityType: 'job',
      entityId: 'j',
      ownerUserId: 'u',
      mediaRole: '',
      idempotencyKey: 'idem',
      label: 'A',
    })
    const b = await enqueueUpload({
      file: makeFile(),
      entityType: 'job',
      entityId: 'j',
      ownerUserId: 'u',
      mediaRole: '',
      idempotencyKey: 'idem',
      label: 'B',
    })
    const list = await listOutbox()
    expect(list.map((e) => e.id)).toEqual([a.id, b.id])
  })

  it('rejects when the queue would exceed MAX_OUTBOX_TOTAL_BYTES', async () => {
    // Fill the queue to just under the cap, then try one more file.
    const big = makeFile(MAX_OUTBOX_TOTAL_BYTES - 1024)
    await enqueueUpload({
      file: big,
      entityType: 'job',
      entityId: 'j',
      ownerUserId: 'u',
      mediaRole: '',
      idempotencyKey: 'idem',
      label: 'big',
    })
    const tooMuch = makeFile(2048)
    await expect(
      enqueueUpload({
        file: tooMuch,
        entityType: 'job',
        entityId: 'j',
        ownerUserId: 'u',
        mediaRole: '',
        idempotencyKey: 'idem',
        label: 'overflow',
      })
    ).rejects.toThrow(/Offline-Upload-Speicher/)
  })
})

describe('updateOutboxEntry', () => {
  it('patches status, retries, nextAttemptAt, lastError', async () => {
    const entry = await enqueueUpload({
      file: makeFile(),
      entityType: 'job',
      entityId: 'j',
      ownerUserId: 'u',
      mediaRole: '',
      idempotencyKey: 'idem',
      label: 'x',
    })
    const updated = await updateOutboxEntry(entry.id, {
      status: 'failed',
      retries: 5,
      nextAttemptAt: 99999,
      lastError: 'boom',
    })
    expect(updated?.status).toBe('failed')
    expect(updated?.retries).toBe(5)
    expect(updated?.nextAttemptAt).toBe(99999)
    expect(updated?.lastError).toBe('boom')

    const stored = await getOutboxEntry(entry.id)
    expect(stored?.status).toBe('failed')
  })

  it('returns undefined for unknown id', async () => {
    const result = await updateOutboxEntry('nonexistent', { status: 'failed' })
    expect(result).toBeUndefined()
  })
})

describe('removeOutboxEntry', () => {
  it('drops both the entry and its index pointer', async () => {
    const entry = await enqueueUpload({
      file: makeFile(),
      entityType: 'job',
      entityId: 'j',
      ownerUserId: 'u',
      mediaRole: '',
      idempotencyKey: 'idem',
      label: 'x',
    })
    await removeOutboxEntry(entry.id)
    expect(await getOutboxEntry(entry.id)).toBeUndefined()
    expect(await listOutbox()).toEqual([])
  })
})

describe('clearOutbox', () => {
  it('removes all entries and resets the index', async () => {
    await enqueueUpload({
      file: makeFile(),
      entityType: 'job',
      entityId: 'a',
      ownerUserId: 'u',
      mediaRole: '',
      idempotencyKey: 'idem',
      label: 'a',
    })
    await enqueueUpload({
      file: makeFile(),
      entityType: 'job',
      entityId: 'b',
      ownerUserId: 'u',
      mediaRole: '',
      idempotencyKey: 'idem',
      label: 'b',
    })
    await clearOutbox()
    expect(await listOutbox()).toEqual([])
  })
})

describe('reconcileOutboxIndex', () => {
  it('drops orphaned entries that the index no longer references', async () => {
    const a = await enqueueUpload({
      file: makeFile(),
      entityType: 'job',
      entityId: 'j',
      ownerUserId: 'u',
      mediaRole: '',
      idempotencyKey: 'idem',
      label: 'a',
    })
    // Simulate an interrupted update that left a key without an index entry.
    const idb = await import('idb-keyval')
    await idb.set('media:upload-outbox:entry:v1:orphan-id', { ...a, id: 'orphan-id' })
    await reconcileOutboxIndex()
    const allKeys = await idb.keys()
    expect(allKeys.find((k) => String(k).endsWith('orphan-id'))).toBeUndefined()
    // Original entry remains intact.
    expect(await getOutboxEntry(a.id)).toBeTruthy()
  })
})

describe('subscribeToOutbox', () => {
  it('fires on enqueue and remove with the latest snapshot', async () => {
    const calls: number[] = []
    const unsubscribe = subscribeToOutbox((entries) => {
      calls.push(entries.length)
    })
    // Initial snapshot is fired async — wait a tick.
    await new Promise((r) => setTimeout(r, 0))

    const entry = await enqueueUpload({
      file: makeFile(),
      entityType: 'job',
      entityId: 'j',
      ownerUserId: 'u',
      mediaRole: '',
      idempotencyKey: 'idem',
      label: 'sub',
    })
    await new Promise((r) => setTimeout(r, 0))

    await removeOutboxEntry(entry.id)
    await new Promise((r) => setTimeout(r, 0))

    unsubscribe()
    // Calls observed: initial (0), after enqueue (1), after remove (0).
    expect(calls).toContain(1)
    expect(calls[calls.length - 1]).toBe(0)
  })
})
