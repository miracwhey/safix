/**
 * Voice playback transport — robustness state machine.
 *
 * Covers the "play/stop must always work cleanly" guarantees of the shared
 * VoicePlayer against a fake HTMLAudioElement (vitest env is `node`, no DOM):
 *   • play() → loading, then playing once the element starts
 *   • pause() reflects, and a system 'pause' event re-emits (call/route change)
 *   • 'ended' resets to a clean idle track
 *   • seek issued before metadata is buffered and applied on loadedmetadata
 *   • a rejected play() recreates the element + retries once (renderer drop);
 *     a double rejection surfaces hasError without sticking on loading
 *   • a pause during the signed-URL await cancels the in-flight start
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolveChatAttachmentUrl } from '../../src/lib/chat/voice/storageUrl'
import { VoicePlayer } from '../../src/hooks/useVoicePlayer'

vi.mock('../../src/lib/chat/voice/storageUrl', () => ({
  resolveChatAttachmentUrl: vi.fn(),
}))
vi.mock('../../src/lib/observability', () => ({
  logWarning: vi.fn(),
  logError: vi.fn(),
}))

const mockResolve = vi.mocked(resolveChatAttachmentUrl)

// Per-play() outcomes consumed in order across all (re)created elements.
let playQueue: Array<'resolve' | 'reject'> = []
let createdAudios: FakeAudio[] = []

class FakeAudio {
  paused = true
  ended = false
  currentTime = 0
  duration = Number.NaN
  playbackRate = 1
  preload = ''
  src = ''
  readyState = 0
  error: { code: number } | null = null
  private listeners: Record<string, Array<() => void>> = {}

  constructor() {
    createdAudios.push(this)
  }
  addEventListener(type: string, cb: () => void) {
    ;(this.listeners[type] ||= []).push(cb)
  }
  removeEventListener(type: string, cb: () => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== cb)
  }
  dispatch(type: string) {
    for (const cb of this.listeners[type] ?? []) cb()
  }
  setAttribute() {}
  removeAttribute(name: string) {
    if (name === 'src') this.src = ''
  }
  load() {}
  play(): Promise<void> {
    const outcome = playQueue.length ? playQueue.shift() : 'resolve'
    if (outcome === 'reject') return Promise.reject(new Error('play-rejected'))
    this.paused = false
    return Promise.resolve()
  }
  pause() {
    this.paused = true
    this.dispatch('pause')
  }
}

const ARGS = ['att-1', 'chat-voice', 'p/att-1.m4a', 24000] as const

function lastAudio(): FakeAudio {
  return createdAudios[createdAudios.length - 1]
}

beforeEach(() => {
  playQueue = []
  createdAudios = []
  mockResolve.mockResolvedValue('blob://att-1')
  vi.stubGlobal('Audio', FakeAudio)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('VoicePlayer transport', () => {
  it('play → loading then playing; pause reflects', async () => {
    const p = new VoicePlayer()
    await p.play(...ARGS)
    const s = p.snapshot()
    expect(s.attachmentId).toBe('att-1')
    expect(s.isPlaying).toBe(true)
    expect(s.isLoading).toBe(false)
    expect(s.hasError).toBe(false)

    p.pause('att-1')
    expect(p.snapshot().isPlaying).toBe(false)
  })

  it('a system pause event re-emits and reflects stopped', async () => {
    const p = new VoicePlayer()
    let emits = 0
    p.subscribe(() => {
      emits += 1
    })
    await p.play(...ARGS)
    const before = emits
    // Simulate iOS pausing playback (incoming call / route change).
    lastAudio().paused = true
    lastAudio().dispatch('pause')
    expect(emits).toBeGreaterThan(before)
    expect(p.snapshot().isPlaying).toBe(false)
  })

  it("'ended' resets to a clean idle track", async () => {
    const p = new VoicePlayer()
    await p.play(...ARGS)
    lastAudio().dispatch('ended')
    const s = p.snapshot()
    expect(s.attachmentId).toBe(null)
    expect(s.isPlaying).toBe(false)
    expect(s.positionMs).toBe(0)
  })

  it('seek before metadata is buffered and applied on loadedmetadata', async () => {
    const p = new VoicePlayer()
    await p.play(...ARGS)
    const audio = lastAudio()
    audio.readyState = 0 // not yet seekable
    p.seek('att-1', 5000)
    expect(p.snapshot().positionMs).toBe(5000) // optimistic UI right away
    expect(audio.currentTime).toBe(0) // not applied to the element yet

    audio.readyState = 1
    audio.dispatch('loadedmetadata')
    expect(audio.currentTime).toBe(5) // seconds
  })

  it('applies an immediate seek once the element is seekable', async () => {
    const p = new VoicePlayer()
    await p.play(...ARGS)
    const audio = lastAudio()
    audio.readyState = 4
    p.seek('att-1', 8000)
    expect(audio.currentTime).toBe(8)
    expect(p.snapshot().positionMs).toBe(8000)
  })

  it('rejected play() recreates the element and retries once', async () => {
    playQueue = ['reject', 'resolve']
    const p = new VoicePlayer()
    await p.play(...ARGS)
    expect(createdAudios.length).toBe(2) // original + recreated
    expect(p.snapshot().isPlaying).toBe(true)
    expect(p.snapshot().hasError).toBe(false)
  })

  it('double play() rejection surfaces hasError, not stuck loading', async () => {
    playQueue = ['reject', 'reject']
    const p = new VoicePlayer()
    await p.play(...ARGS)
    const s = p.snapshot()
    expect(s.hasError).toBe(true)
    expect(s.isLoading).toBe(false)
    expect(s.isPlaying).toBe(false)
  })

  it('pause during the signed-URL await cancels the in-flight start', async () => {
    let resolveUrl: (v: string) => void = () => {}
    mockResolve.mockReturnValue(
      new Promise<string>((res) => {
        resolveUrl = res
      }),
    )
    const p = new VoicePlayer()
    const pending = p.play(...ARGS)
    expect(p.snapshot().isLoading).toBe(true)
    // User pauses before the URL resolves.
    p.pause('att-1')
    resolveUrl('blob://att-1')
    await pending
    // Start was abandoned: no element was created, nothing is playing.
    expect(createdAudios.length).toBe(0)
    expect(p.snapshot().isPlaying).toBe(false)
    expect(p.snapshot().isLoading).toBe(false)
  })

  it('switching tracks reuses the single element and follows the new track', async () => {
    const p = new VoicePlayer()
    await p.play(...ARGS)
    await p.play('att-2', 'chat-voice', 'p/att-2.m4a', 12000)
    // One shared element, reused (not leaked/recreated) across the switch.
    expect(createdAudios.length).toBe(1)
    expect(p.snapshot().attachmentId).toBe('att-2')
    expect(p.snapshot().isPlaying).toBe(true)
    expect(p.snapshot().positionMs).toBe(0)
  })
})
