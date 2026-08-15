import { describe, it, expect, vi, beforeEach } from 'vitest'

// idb-keyval mock — die Library nutzt IndexedDB unterm Hub. In Test-Env
// ohne IndexedDB ersetzen wir get/set/del durch in-memory Map.
const { storage } = vi.hoisted(() => ({ storage: new Map<string, unknown>() }))

vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => storage.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    storage.set(key, value)
  }),
  del: vi.fn(async (key: string) => {
    storage.delete(key)
  }),
}))
vi.mock('../../src/lib/observability', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

import {
  enqueuePhotoUpload,
  peekPhotoUploads,
  markPhotoUploadAttempt,
  removePhotoUpload,
  clearPhotoUploads,
  __testOnly_resetQueue,
} from '../../src/lib/worker/photoUploadQueue'

const NOW = 1_746_374_400_000 // 2026-05-04T12:00:00Z (deterministic)

function makeBlob(content = 'jpeg-bytes'): Blob {
  return new Blob([content], { type: 'image/jpeg' })
}

function makeUpload(overrides: Partial<Parameters<typeof enqueuePhotoUpload>[0]> = {}) {
  return {
    clientUuid: 'cuuid-1',
    jobId: 'job-42',
    providerId: 'prov-1',
    uploadedBy: 'user-w1',
    storagePath: 'jobs/job-42/cuuid-1.jpg',
    blob: makeBlob(),
    contentType: 'image/jpeg',
    sizeBytes: 12345,
    ...overrides,
  }
}

describe('Block C.2 · photoUploadQueue', () => {
  beforeEach(async () => {
    storage.clear()
    await __testOnly_resetQueue()
  })

  describe('enqueue + peek', () => {
    it('enqueues with attempts=0 and timestamp', async () => {
      await enqueuePhotoUpload(makeUpload(), NOW)
      const queue = await peekPhotoUploads(NOW)
      expect(queue).toHaveLength(1)
      expect(queue[0]).toMatchObject({
        clientUuid: 'cuuid-1',
        attempts: 0,
        enqueuedAt: NOW,
      })
    })

    it('is idempotent on duplicate clientUuid', async () => {
      await enqueuePhotoUpload(makeUpload({ clientUuid: 'dup' }), NOW)
      await enqueuePhotoUpload(makeUpload({ clientUuid: 'dup' }), NOW + 1000)
      const queue = await peekPhotoUploads(NOW + 2000)
      expect(queue).toHaveLength(1)
      expect(queue[0]!.enqueuedAt).toBe(NOW) // first one wins
    })

    it('preserves order across multiple enqueues', async () => {
      await enqueuePhotoUpload(makeUpload({ clientUuid: 'a' }), NOW)
      await enqueuePhotoUpload(makeUpload({ clientUuid: 'b' }), NOW + 1)
      await enqueuePhotoUpload(makeUpload({ clientUuid: 'c' }), NOW + 2)
      const queue = await peekPhotoUploads(NOW + 10)
      expect(queue.map((e) => e.clientUuid)).toEqual(['a', 'b', 'c'])
    })
  })

  describe('markAttempt', () => {
    it('increments attempts counter', async () => {
      await enqueuePhotoUpload(makeUpload({ clientUuid: 'cu' }), NOW)
      const after1 = await markPhotoUploadAttempt('cu', NOW + 100)
      expect(after1?.attempts).toBe(1)
      const after2 = await markPhotoUploadAttempt('cu', NOW + 200)
      expect(after2?.attempts).toBe(2)
    })

    it('drops entry once attempts reach MAX_ATTEMPTS=5', async () => {
      await enqueuePhotoUpload(makeUpload({ clientUuid: 'cu' }), NOW)
      for (let i = 0; i < 4; i++) {
        await markPhotoUploadAttempt('cu', NOW + i * 100)
      }
      // 4 attempts = under MAX, still in queue
      let queue = await peekPhotoUploads(NOW + 500)
      expect(queue).toHaveLength(1)
      // 5th attempt → pruned next read
      await markPhotoUploadAttempt('cu', NOW + 500)
      queue = await peekPhotoUploads(NOW + 600)
      expect(queue).toHaveLength(0)
    })

    it('returns null when clientUuid is unknown', async () => {
      const result = await markPhotoUploadAttempt('unknown', NOW)
      expect(result).toBeNull()
    })
  })

  describe('age-based pruning', () => {
    it('drops entries older than 7 days on peek', async () => {
      await enqueuePhotoUpload(makeUpload({ clientUuid: 'old' }), NOW)
      const eightDaysLater = NOW + 8 * 24 * 60 * 60 * 1000
      const queue = await peekPhotoUploads(eightDaysLater)
      expect(queue).toHaveLength(0)
    })
  })

  describe('remove + clear', () => {
    it('removes a specific entry by clientUuid', async () => {
      await enqueuePhotoUpload(makeUpload({ clientUuid: 'a' }), NOW)
      await enqueuePhotoUpload(makeUpload({ clientUuid: 'b' }), NOW + 1)
      await removePhotoUpload('a')
      const queue = await peekPhotoUploads(NOW + 100)
      expect(queue.map((e) => e.clientUuid)).toEqual(['b'])
    })

    it('clear empties the queue', async () => {
      await enqueuePhotoUpload(makeUpload({ clientUuid: 'a' }), NOW)
      await enqueuePhotoUpload(makeUpload({ clientUuid: 'b' }), NOW + 1)
      await clearPhotoUploads()
      const queue = await peekPhotoUploads(NOW + 100)
      expect(queue).toHaveLength(0)
    })
  })
})
