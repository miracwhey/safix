/**
 * attachmentPendingCache — resilience against WebKit IDB connection kills
 * (Sentry FIXUP-WEB-6Q/6T class) on top of src/lib/idb/resilientIdb.ts.
 *
 * Contract: public functions NEVER reject (best-effort cache), heal a single
 * connection loss transparently, and tolerate absent IndexedDB.
 *
 * Each test re-imports the module (vi.resetModules) so the module-level
 * resilient store starts with a fresh connection cache per test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  FakeIdbEnv,
  connectionClosingError,
} from '../helpers/fakeIndexedDb'
import type { CachedAttachment } from '../../src/lib/chat/attachmentPendingCache'

vi.mock('../../src/lib/observability', () => ({
  logWarning: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}))

let env: FakeIdbEnv

beforeEach(() => {
  vi.resetModules()
  env = new FakeIdbEnv()
  // The store uses keyPath 'clientMessageId' (in-line keys).
  env.keyPath = 'clientMessageId'
  vi.stubGlobal('indexedDB', env.indexedDB)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function importCache() {
  return import('../../src/lib/chat/attachmentPendingCache')
}

async function importLogWarning() {
  const observability = await import('../../src/lib/observability')
  return vi.mocked(observability.logWarning)
}

/** Shape mirrors what MessageThreadScreen / chatWorkflow actually persist. */
function makeEntry(clientMessageId = 'cmid-1'): CachedAttachment {
  return {
    clientMessageId,
    threadId: 'thread-1',
    channelType: 'customer',
    blobData: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
    fileName: 'photo.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 3,
    kind: 'image',
    caption: null,
    durationMs: null,
    createdAt: Date.now(),
  }
}

describe('round-trip', () => {
  it('caches, reads, and clears an attachment', async () => {
    const { cacheAttachment, getCachedAttachment, clearCachedAttachment } = await importCache()
    const entry = makeEntry()

    await cacheAttachment(entry)
    const read = await getCachedAttachment('cmid-1')
    expect(read?.fileName).toBe('photo.jpg')
    expect(read?.kind).toBe('image')

    await clearCachedAttachment('cmid-1')
    expect(await getCachedAttachment('cmid-1')).toBeNull()
  })
})

describe('connection kill mid-session', () => {
  it('heals a dead connection on the next read instead of no-opping forever', async () => {
    const { cacheAttachment, getCachedAttachment } = await importCache()
    await cacheAttachment(makeEntry())
    expect(env.openCalls).toBe(1)

    // WebKit killed the connection while backgrounded.
    env.throwOnNextTransaction(connectionClosingError())
    const read = await getCachedAttachment('cmid-1')

    expect(read?.clientMessageId).toBe('cmid-1')
    expect(env.openCalls).toBe(2)
  })

  it('never rejects even when the retry cannot reopen — resolves null and logs', async () => {
    const { cacheAttachment, getCachedAttachment } = await importCache()
    const logWarning = await importLogWarning()
    await cacheAttachment(makeEntry())

    // Kill the live connection AND block the reopen → both attempts fail.
    env.dbs[0].simulateServerKill()
    env.blockNextOpen()

    await expect(getCachedAttachment('cmid-1')).resolves.toBeNull()
    expect(logWarning).toHaveBeenCalledWith(
      'attachment.cache.get_failed',
      expect.objectContaining({ clientMessageId: 'cmid-1' }),
    )
  })

  it('write failures resolve void and log instead of rejecting', async () => {
    const { cacheAttachment } = await importCache()
    const logWarning = await importLogWarning()
    await cacheAttachment(makeEntry('cmid-a')) // warm connection

    env.dbs[0].simulateServerKill()
    env.blockNextOpen()

    await expect(cacheAttachment(makeEntry('cmid-b'))).resolves.toBeUndefined()
    expect(logWarning).toHaveBeenCalledWith(
      'attachment.cache.put_failed',
      expect.objectContaining({ clientMessageId: 'cmid-b' }),
    )
  })
})

describe('absent IndexedDB (private mode / non-browser env)', () => {
  it('all operations resolve void/null without throwing', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const { cacheAttachment, getCachedAttachment, clearCachedAttachment } = await importCache()

    await expect(cacheAttachment(makeEntry())).resolves.toBeUndefined()
    await expect(getCachedAttachment('cmid-1')).resolves.toBeNull()
    await expect(clearCachedAttachment('cmid-1')).resolves.toBeUndefined()
  })
})
