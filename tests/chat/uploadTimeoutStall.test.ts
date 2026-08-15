import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  uploadWithRetry,
  UploadTimeoutError,
} from '../../src/lib/chat/uploadWithRetry'
import {
  uploadVoiceNoteBlob,
  chatUploadTimeoutMs,
  CHAT_UPLOAD_STALL_TIMEOUT_MS,
} from '../../src/lib/chat/repository/chatAttachmentUploader'
import { ChatStorageUploadError, classifyChatSendError } from '../../src/lib/chat/errors'

// The uploader hits the Supabase Storage REST endpoint via XMLHttpRequest and
// reads a session. Mock both so the XHR path runs against a fake transport.
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) },
    storage: { from: () => ({ remove: async () => ({ data: null, error: null }) }) },
  },
}))

// jsdom/node leave navigator.onLine undefined → uploadWithRetry's offline guard
// would throw before the retry logic runs. Force "online".
beforeEach(() => {
  if (typeof navigator !== 'undefined') {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
  }
  vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

// ── Fake XMLHttpRequest ──────────────────────────────────────────────────────
// Records every request and lets a test drive progress / load / abort / timeout.
type Mode = 'manual' | 'auto200'

interface UploadListeners {
  progress: Array<(e: { lengthComputable: boolean; loaded: number; total: number }) => void>
}

class FakeXHR {
  static instances: FakeXHR[] = []
  static mode: Mode = 'manual'
  static reset(mode: Mode) {
    FakeXHR.instances = []
    FakeXHR.mode = mode
  }
  static last(): FakeXHR {
    return FakeXHR.instances[FakeXHR.instances.length - 1]
  }

  method = ''
  url = ''
  headers: Record<string, string> = {}
  timeout = 0
  status = 0
  aborted = false
  body: unknown = null
  private listeners: Record<string, Array<(e: unknown) => void>> = {}
  upload = {
    _l: { progress: [] } as UploadListeners,
    addEventListener(type: 'progress', cb: UploadListeners['progress'][number]) {
      this._l.progress.push(cb)
    },
  }

  addEventListener(type: string, cb: (e: unknown) => void) {
    ;(this.listeners[type] ||= []).push(cb)
  }
  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v
  }
  send(body: unknown) {
    this.body = body
    FakeXHR.instances.push(this)
    if (FakeXHR.mode === 'auto200') {
      setTimeout(() => {
        this.emitProgress(this.size(), this.size())
        this.complete(200)
      }, 0)
    }
  }
  abort() {
    this.aborted = true
    this.emit('abort')
  }

  // ── test drivers ──
  size(): number {
    if (this.body && typeof (this.body as Blob).size === 'number') return (this.body as Blob).size
    return 3
  }
  emitProgress(loaded: number, total: number) {
    this.upload._l.progress.forEach((cb) => cb({ lengthComputable: true, loaded, total }))
  }
  complete(status: number) {
    this.status = status
    this.emit('load')
  }
  emitError() {
    this.emit('error')
  }
  emitTimeout() {
    this.emit('timeout')
  }
  private emit(type: string) {
    ;(this.listeners[type] || []).forEach((cb) => cb({}))
  }
}

function installFakeXhr(mode: Mode) {
  FakeXHR.reset(mode)
  ;(globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXHR as unknown
}
function uninstallFakeXhr() {
  delete (globalThis as unknown as { XMLHttpRequest?: unknown }).XMLHttpRequest
}

const tick = () => new Promise((r) => setTimeout(r, 0))

function voiceInput(clientMessageId: string, overrides: Record<string, unknown> = {}) {
  return {
    threadId: 't1',
    channelType: 'customer' as const,
    providerId: 'prov',
    clientMessageId,
    blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/mp4' }),
    durationMs: 1234,
    mimeType: 'audio/mp4;codecs=mp4a',
    fileExtension: 'm4a',
    ...overrides,
  }
}

// ── uploadWithRetry: per-attempt timeout ─────────────────────────────────────

describe('uploadWithRetry — attemptTimeoutMs', () => {
  it('aborts a hung attempt, retries, and finally throws a transient UploadTimeoutError', async () => {
    vi.useFakeTimers()
    // fn never resolves on its own — only the abort signal ends it.
    const fn = vi.fn(
      (signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const caught = uploadWithRetry(fn, { maxAttempts: 2, delays: [0], attemptTimeoutMs: 1000 }).catch(
      (e) => e,
    )
    await vi.advanceTimersByTimeAsync(5000)
    const err = await caught
    expect(fn).toHaveBeenCalledTimes(2)
    expect(err).toBeInstanceOf(UploadTimeoutError)
    // The UI classifier must treat a timeout as retryable/transient.
    const classified = classifyChatSendError(err)
    expect(classified.retryable).toBe(true)
    expect(classified.klass).toBe('transient')
  })

  it('passes a fresh non-aborted signal per attempt and clears the timer on success', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    const fn = vi.fn(async (signal: AbortSignal) => {
      signals.push(signal)
      return 'ok'
    })
    const result = await uploadWithRetry(fn, { attemptTimeoutMs: 1000 })
    expect(result).toBe('ok')
    expect(signals[0]).toBeInstanceOf(AbortSignal)
    expect(signals[0].aborted).toBe(false)
    // If the timer leaked, the signal would abort after 1s. It must not.
    await vi.advanceTimersByTimeAsync(2000)
    expect(signals[0].aborted).toBe(false)
  })
})

// ── Uploader XHR path: deterministic path, upsert, stall, status mapping ──────

describe('chatAttachmentUploader — unified XHR path', () => {
  afterEach(() => uninstallFakeXhr())

  it('chatUploadTimeoutMs scales with size and clamps to [60s, 480s]', () => {
    expect(chatUploadTimeoutMs(0)).toBe(60_000)
    expect(chatUploadTimeoutMs(-5)).toBe(60_000)
    // 32 KiB → +1s
    expect(chatUploadTimeoutMs(32_768)).toBe(61_000)
    // Huge file clamps at the ceiling.
    expect(chatUploadTimeoutMs(1_000_000_000)).toBe(480_000)
  })

  it('builds a deterministic pending path from clientMessageId (stable across retries) with x-upsert:true', async () => {
    installFakeXhr('auto200')
    const res1 = await uploadVoiceNoteBlob(voiceInput('cmid-42'))
    const res2 = await uploadVoiceNoteBlob(voiceInput('cmid-42'))
    expect(res1.storagePath).toBe('prov/t1/pending/cmid-42.m4a')
    expect(res2.storagePath).toBe(res1.storagePath)
    // Segment 2 (the RLS anchor) is the threadId, upsert enabled for retry-overwrite.
    expect(res1.storagePath.split('/')[1]).toBe('t1')
    expect(FakeXHR.instances[0].headers['x-upsert']).toBe('true')
    // MIME essence stored (parameters stripped) so playback infers cleanly.
    expect(res1.mimeType).toBe('audio/mp4')
    expect(res1.durationMs).toBe(1234)
  })

  it('keeps threadId as path segment 2 even when clientMessageId carries path traversal', async () => {
    installFakeXhr('auto200')
    const res = await uploadVoiceNoteBlob(voiceInput('../../evil'))
    const segs = res.storagePath.split('/')
    expect(segs[1]).toBe('t1')
    expect(segs[2]).toBe('pending')
    // Traversal + slashes sanitized out of the filename segment.
    expect(segs[3]).not.toContain('..')
    expect(segs[3]).toBe('evil.m4a')
  })

  it('stall watchdog aborts a socket that never reports progress → transient (null status)', async () => {
    vi.useFakeTimers()
    installFakeXhr('manual')
    const caught = uploadVoiceNoteBlob(voiceInput('cmid-stall')).catch((e) => e)
    // Flush the getSession microtask + xhr.send + initial arm.
    await vi.advanceTimersByTimeAsync(0)
    const xhr = FakeXHR.last()
    expect(xhr).toBeDefined()
    expect(xhr.aborted).toBe(false)
    // No progress event → after the stall window the watchdog aborts.
    await vi.advanceTimersByTimeAsync(CHAT_UPLOAD_STALL_TIMEOUT_MS)
    const err = await caught
    expect(xhr.aborted).toBe(true)
    expect(err).toBeInstanceOf(ChatStorageUploadError)
    expect((err as ChatStorageUploadError).status).toBeNull()
  })

  it('a 400 completes fail-fast as a non-retryable ChatStorageUploadError (status preserved)', async () => {
    installFakeXhr('manual')
    const caught = uploadVoiceNoteBlob(voiceInput('cmid-400')).catch((e) => e)
    await tick()
    FakeXHR.last().complete(400)
    const err = await caught
    expect(err).toBeInstanceOf(ChatStorageUploadError)
    expect((err as ChatStorageUploadError).status).toBe(400)
  })

  it('a network error (status 0) surfaces as a transient ChatStorageUploadError', async () => {
    installFakeXhr('manual')
    const caught = uploadVoiceNoteBlob(voiceInput('cmid-net')).catch((e) => e)
    await tick()
    FakeXHR.last().emitError()
    const err = await caught
    expect(err).toBeInstanceOf(ChatStorageUploadError)
    expect((err as ChatStorageUploadError).status).toBe(0)
  })

  it('an external AbortSignal cancels an in-flight upload and cleans up', async () => {
    installFakeXhr('manual')
    const controller = new AbortController()
    const caught = uploadVoiceNoteBlob(voiceInput('cmid-abort', { signal: controller.signal })).catch(
      (e) => e,
    )
    await tick()
    const xhr = FakeXHR.last()
    controller.abort()
    const err = await caught
    expect(xhr.aborted).toBe(true)
    expect(err).toBeInstanceOf(ChatStorageUploadError)
    // Abort carries no HTTP status → transient (retry layer replays it).
    expect((err as ChatStorageUploadError).status).toBeNull()
  })

  it('a clean 2xx resolves with a progress callback delivered', async () => {
    installFakeXhr('manual')
    const progress: number[] = []
    const caught = uploadVoiceNoteBlob(
      voiceInput('cmid-ok', { onProgress: (p: number) => progress.push(p) }),
    )
    await tick()
    const xhr = FakeXHR.last()
    xhr.emitProgress(2, 4)
    xhr.emitProgress(4, 4)
    xhr.complete(201)
    const res = await caught
    expect(res.storagePath).toBe('prov/t1/pending/cmid-ok.m4a')
    expect(progress).toEqual([50, 100])
  })
})
