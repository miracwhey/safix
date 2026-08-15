/**
 * recordingCache — resilience against WebKit IDB connection kills
 * (Sentry FIXUP-WEB-6Q/6T class) on top of src/lib/idb/resilientIdb.ts.
 *
 * Contract: public functions NEVER reject (best-effort cache), heal a single
 * connection loss transparently, and tolerate absent IndexedDB.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  FakeIdbEnv,
  connectionClosingError,
  connectionLostError,
} from '../helpers/fakeIndexedDb'
import type { CachedVoiceRecording } from '../../src/lib/chat/voice/types'

vi.mock('../../src/lib/observability', () => ({
  logWarning: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}))

let env: FakeIdbEnv

beforeEach(() => {
  vi.resetModules()
  env = new FakeIdbEnv()
  env.keyPath = 'clientMessageId'
  vi.stubGlobal('indexedDB', env.indexedDB)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function importCache() {
  return import('../../src/lib/chat/voice/recordingCache')
}

/** Shape mirrors what useVoiceRecorder / MessageThreadScreen persist. */
function makeRecording(clientMessageId = 'vmid-1'): CachedVoiceRecording {
  return {
    clientMessageId,
    threadId: 'thread-1',
    channelType: 'customer',
    blob: new Blob([new Uint8Array([9, 9])], { type: 'audio/mp4' }),
    durationMs: 1200,
    mimeType: 'audio/mp4',
    fileExtension: 'm4a',
    createdAt: Date.now(),
  }
}

describe('round-trip', () => {
  it('caches, reads, lists, and clears a recording', async () => {
    const {
      cacheVoiceRecording,
      readVoiceRecording,
      listPendingVoiceRecordings,
      clearVoiceRecording,
    } = await importCache()

    await cacheVoiceRecording(makeRecording())
    expect((await readVoiceRecording('vmid-1'))?.durationMs).toBe(1200)
    expect(await listPendingVoiceRecordings()).toHaveLength(1)

    await clearVoiceRecording('vmid-1')
    expect(await readVoiceRecording('vmid-1')).toBeNull()
    expect(await listPendingVoiceRecordings()).toHaveLength(0)
  })
})

describe('connection kill mid-session', () => {
  it('heals a dead connection on the next read (no permanent silent no-op)', async () => {
    const { cacheVoiceRecording, readVoiceRecording } = await importCache()
    await cacheVoiceRecording(makeRecording())
    expect(env.openCalls).toBe(1)

    env.throwOnNextTransaction(connectionClosingError())
    const read = await readVoiceRecording('vmid-1')

    expect(read?.clientMessageId).toBe('vmid-1')
    expect(env.openCalls).toBe(2)
  })

  it('heals an async UnknownError during cursor listing', async () => {
    const { cacheVoiceRecording, listPendingVoiceRecordings } = await importCache()
    await cacheVoiceRecording(makeRecording())

    env.failNextRequest(connectionLostError())
    const all = await listPendingVoiceRecordings()

    expect(all).toHaveLength(1)
    expect(env.openCalls).toBe(2)
  })

  it('never rejects when both attempts fail — resolves null/[] and logs', async () => {
    const { cacheVoiceRecording, readVoiceRecording, listPendingVoiceRecordings } =
      await importCache()
    const observability = await import('../../src/lib/observability')
    const logWarning = vi.mocked(observability.logWarning)
    await cacheVoiceRecording(makeRecording())

    env.dbs[0].simulateServerKill()
    env.blockNextOpen()
    await expect(readVoiceRecording('vmid-1')).resolves.toBeNull()
    expect(logWarning).toHaveBeenCalledWith(
      'voice.cache.op_failed',
      expect.objectContaining({ error: expect.stringContaining('blocked') }),
    )

    env.blockNextOpen()
    await expect(listPendingVoiceRecordings()).resolves.toEqual([])
  })
})

describe('absent IndexedDB (private mode / non-browser env)', () => {
  it('all operations resolve void/null/[] without throwing', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const {
      cacheVoiceRecording,
      readVoiceRecording,
      listPendingVoiceRecordings,
      clearVoiceRecording,
      sweepStaleVoiceRecordings,
    } = await importCache()

    await expect(cacheVoiceRecording(makeRecording())).resolves.toBeUndefined()
    await expect(readVoiceRecording('vmid-1')).resolves.toBeNull()
    await expect(listPendingVoiceRecordings()).resolves.toEqual([])
    await expect(clearVoiceRecording('vmid-1')).resolves.toBeUndefined()
    await expect(sweepStaleVoiceRecordings()).resolves.toBeUndefined()
  })
})
