import { describe, it, expect, vi, beforeEach } from 'vitest'

const { removeChannelMock, channelMock } = vi.hoisted(() => ({
  removeChannelMock: vi.fn(),
  channelMock: vi.fn(),
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    channel: channelMock,
    removeChannel: removeChannelMock,
  },
}))
vi.mock('../../src/lib/observability', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

import { subscribeJobPhotosForJob } from '../../src/lib/worker/jobPhotosLive'
import type { JobPhotoRepository } from '../../src/lib/worker/repository/JobPhotoRepository'
import type { JobPhoto } from '../../src/lib/worker/dokuTypes'

interface ChannelHandlers {
  insert?: (payload: { new: unknown }) => void
  update?: (payload: { new: unknown }) => void
  delete?: (payload: { old: unknown }) => void
  subscribeStatus?: (status: string) => void
}

function makeChannel(handlers: ChannelHandlers = {}) {
  const ch = {
    on: vi.fn((_event: string, config: { event: string }, handler: (p: unknown) => void) => {
      if (config.event === 'INSERT') handlers.insert = handler as ChannelHandlers['insert']
      if (config.event === 'UPDATE') handlers.update = handler as ChannelHandlers['update']
      if (config.event === 'DELETE') handlers.delete = handler as ChannelHandlers['delete']
      return ch
    }),
    subscribe: vi.fn((cb: (status: string) => void) => {
      handlers.subscribeStatus = cb
      cb('SUBSCRIBED')
      return ch
    }),
  }
  return { ch, handlers }
}

function makeRepo(initial: JobPhoto[] = []): JobPhotoRepository {
  return {
    listForJob: vi.fn().mockResolvedValue(initial),
    add: vi.fn(),
    delete: vi.fn(),
  }
}

function makePhoto(id: string, ts = Date.now()): JobPhoto {
  return {
    id,
    jobId: 'j-1',
    providerId: 'prov-1',
    uploadedBy: 'u-1',
    storagePath: `jobs/j-1/${id}.jpg`,
    clientUuid: id,
    createdAt: ts,
  }
}

beforeEach(() => {
  channelMock.mockReset()
  removeChannelMock.mockReset()
})

describe('Block FU-B · subscribeJobPhotosForJob', () => {
  it('emits initial fetch result then merges INSERT events', async () => {
    const { ch, handlers } = makeChannel()
    channelMock.mockReturnValue(ch)
    const repo = makeRepo([makePhoto('p-existing', 100)])
    const listener = vi.fn()

    subscribeJobPhotosForJob('j-1', listener, { repository: repo })

    // Subscribe runs first, then async initial fetch.
    await new Promise((r) => setTimeout(r, 0))

    expect(repo.listForJob).toHaveBeenCalledWith('j-1')
    expect(listener).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'p-existing' }),
    ])

    // Realtime INSERT later
    handlers.insert!({
      new: {
        id: 'p-new',
        job_id: 'j-1',
        provider_id: 'prov-1',
        uploaded_by: 'u-1',
        storage_path: 'jobs/j-1/p-new.jpg',
        client_uuid: 'p-new',
        width_px: null,
        height_px: null,
        size_bytes: null,
        created_at: '2026-05-08T12:01:00Z',
      },
    })

    expect(listener).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: 'p-new' }),
        expect.objectContaining({ id: 'p-existing' }),
      ]),
    )
  })

  it('dedups INSERT when row already arrived via fetch', async () => {
    const { ch, handlers } = makeChannel()
    channelMock.mockReturnValue(ch)
    const repo = makeRepo([makePhoto('dup', 100)])
    const listener = vi.fn()

    subscribeJobPhotosForJob('j-1', listener, { repository: repo })
    await new Promise((r) => setTimeout(r, 0))

    handlers.insert!({
      new: {
        id: 'dup',
        job_id: 'j-1',
        provider_id: 'prov-1',
        uploaded_by: 'u-1',
        storage_path: 'jobs/j-1/dup.jpg',
        client_uuid: 'dup',
        width_px: null,
        height_px: null,
        size_bytes: null,
        created_at: '2026-05-08T12:00:00Z',
      },
    })

    // Listener last call should still have only 1 entry — dedup matched.
    const lastCall = listener.mock.calls[listener.mock.calls.length - 1]![0]
    expect(lastCall).toHaveLength(1)
  })

  it('handles UPDATE by replacing existing row', async () => {
    const { ch, handlers } = makeChannel()
    channelMock.mockReturnValue(ch)
    const repo = makeRepo([makePhoto('p-1', 100)])
    const listener = vi.fn()

    subscribeJobPhotosForJob('j-1', listener, { repository: repo })
    await new Promise((r) => setTimeout(r, 0))

    handlers.update!({
      new: {
        id: 'p-1',
        job_id: 'j-1',
        provider_id: 'prov-1',
        uploaded_by: 'u-1',
        storage_path: 'jobs/j-1/p-1-renamed.jpg',
        client_uuid: 'p-1',
        width_px: 1920,
        height_px: 1080,
        size_bytes: 1234,
        created_at: '2026-05-08T12:00:00Z',
      },
    })

    const lastCall = listener.mock.calls[listener.mock.calls.length - 1]![0]
    expect(lastCall[0]).toMatchObject({
      id: 'p-1',
      storagePath: 'jobs/j-1/p-1-renamed.jpg',
      widthPx: 1920,
    })
  })

  it('handles DELETE by removing from cache', async () => {
    const { ch, handlers } = makeChannel()
    channelMock.mockReturnValue(ch)
    const repo = makeRepo([makePhoto('p-1', 100), makePhoto('p-2', 90)])
    const listener = vi.fn()

    subscribeJobPhotosForJob('j-1', listener, { repository: repo })
    await new Promise((r) => setTimeout(r, 0))

    handlers.delete!({ old: { id: 'p-1' } })

    const lastCall = listener.mock.calls[listener.mock.calls.length - 1]![0]
    expect(lastCall.map((p: JobPhoto) => p.id)).toEqual(['p-2'])
  })

  it('cleanup-fn closes channel + stops further emissions', async () => {
    const { ch, handlers } = makeChannel()
    channelMock.mockReturnValue(ch)
    const repo = makeRepo([])
    const listener = vi.fn()

    const unsubscribe = subscribeJobPhotosForJob('j-1', listener, { repository: repo })
    await new Promise((r) => setTimeout(r, 0))

    listener.mockReset()
    unsubscribe()

    expect(removeChannelMock).toHaveBeenCalledWith(ch)

    // A late INSERT after unsubscribe should not call listener.
    handlers.insert!({
      new: {
        id: 'late',
        job_id: 'j-1',
        provider_id: 'prov-1',
        uploaded_by: 'u-1',
        storage_path: 'jobs/j-1/late.jpg',
        client_uuid: 'late',
        width_px: null,
        height_px: null,
        size_bytes: null,
        created_at: '2026-05-08T12:00:00Z',
      },
    })

    expect(listener).not.toHaveBeenCalled()
  })

  it('does not crash when initial fetch throws', async () => {
    const { ch } = makeChannel()
    channelMock.mockReturnValue(ch)
    const repo: JobPhotoRepository = {
      listForJob: vi.fn().mockRejectedValue(new Error('rls')),
      add: vi.fn(),
      delete: vi.fn(),
    }
    const listener = vi.fn()

    subscribeJobPhotosForJob('j-1', listener, { repository: repo })
    await new Promise((r) => setTimeout(r, 0))

    expect(channelMock).toHaveBeenCalled()
    // Listener was not called with stale data — graceful degrade.
  })
})
