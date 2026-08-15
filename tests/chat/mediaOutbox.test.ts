/**
 * mediaOutbox — persistent media send queue (IndexedDB).
 *
 * Covers the durable state machine the drain-worker relies on:
 * roundtrip, markAttempt / markFailed / requeue, per-thread listing, remove,
 * and the best-effort contract (never rejects; tolerates absent IndexedDB).
 *
 * Each test re-imports the module (vi.resetModules) so the module-level
 * resilient store starts with a fresh connection cache per test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { FakeIdbEnv } from '../helpers/fakeIndexedDb'
import type { MediaOutboxRecord } from '../../src/lib/chat/mediaOutbox'

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

async function importOutbox() {
  return import('../../src/lib/chat/mediaOutbox')
}

function makeRecord(clientMessageId = 'cmid-1', threadId = 'thread-1'): MediaOutboxRecord {
  return {
    clientMessageId,
    threadId,
    channelType: 'customer',
    providerId: 'prov-1',
    kind: 'voice',
    fileName: `voice-${clientMessageId}.m4a`,
    mimeType: 'audio/mp4',
    storagePath: '',
    metadata: { durationMs: 3200, fileExtension: 'm4a', caption: null },
    createdAt: Date.now(),
    attempts: 0,
    lastAttemptAt: null,
    state: 'queued',
  }
}

describe('roundtrip', () => {
  it('enqueues, reads, lists, and removes a record', async () => {
    const outbox = await importOutbox()
    await outbox.enqueue(makeRecord())

    const read = await outbox.get('cmid-1')
    expect(read?.kind).toBe('voice')
    expect(read?.state).toBe('queued')
    expect(read?.attempts).toBe(0)

    const all = await outbox.listAll()
    expect(all).toHaveLength(1)

    await outbox.remove('cmid-1')
    expect(await outbox.get('cmid-1')).toBeNull()
    expect(await outbox.listAll()).toHaveLength(0)
  })
})

describe('state machine', () => {
  it('markAttempt bumps attempts, stamps lastAttemptAt, keeps queued', async () => {
    const outbox = await importOutbox()
    await outbox.enqueue(makeRecord())

    await outbox.markAttempt('cmid-1')
    const afterFirst = await outbox.get('cmid-1')
    expect(afterFirst?.attempts).toBe(1)
    expect(afterFirst?.lastAttemptAt).toBeTypeOf('number')
    expect(afterFirst?.state).toBe('queued')

    await outbox.markAttempt('cmid-1')
    expect((await outbox.get('cmid-1'))?.attempts).toBe(2)
  })

  it('markFailed terminalises, requeue reverts to queued', async () => {
    const outbox = await importOutbox()
    await outbox.enqueue(makeRecord())

    await outbox.markFailed('cmid-1')
    expect((await outbox.get('cmid-1'))?.state).toBe('failed')

    await outbox.requeue('cmid-1')
    expect((await outbox.get('cmid-1'))?.state).toBe('queued')
  })

  it('mutations on an absent record are a no-op (never throw)', async () => {
    const outbox = await importOutbox()
    await expect(outbox.markAttempt('missing')).resolves.toBeUndefined()
    await expect(outbox.markFailed('missing')).resolves.toBeUndefined()
    await expect(outbox.requeue('missing')).resolves.toBeUndefined()
  })
})

describe('listForThread', () => {
  it('returns only records for the given thread', async () => {
    const outbox = await importOutbox()
    await outbox.enqueue(makeRecord('a', 'thread-1'))
    await outbox.enqueue(makeRecord('b', 'thread-1'))
    await outbox.enqueue(makeRecord('c', 'thread-2'))

    const t1 = await outbox.listForThread('thread-1')
    expect(t1.map((r) => r.clientMessageId).sort()).toEqual(['a', 'b'])
    expect(await outbox.listForThread('thread-2')).toHaveLength(1)
  })
})

describe('absent IndexedDB (private mode / non-browser env)', () => {
  it('all operations resolve void/null/[] without throwing', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const outbox = await importOutbox()

    await expect(outbox.enqueue(makeRecord())).resolves.toBeUndefined()
    await expect(outbox.get('cmid-1')).resolves.toBeNull()
    await expect(outbox.listAll()).resolves.toEqual([])
    await expect(outbox.listForThread('thread-1')).resolves.toEqual([])
    await expect(outbox.markAttempt('cmid-1')).resolves.toBeUndefined()
    await expect(outbox.remove('cmid-1')).resolves.toBeUndefined()
  })
})
