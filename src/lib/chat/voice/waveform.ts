/**
 * Block D Slice 3 — Voice-note waveform compute.
 *
 * Slice 3 does NOT persist waveform data (no metadata column on
 * chat_attachments per current schema). Instead the player decodes the audio
 * blob on first playback, downsamples it to a fixed-size bar array, and
 * caches the result in memory for the session.
 *
 * Live-recording feedback uses pseudo-animated bars rendered by the composer
 * overlay — the recorder plugin exposes no amplitude callback on either OS.
 *
 * Cost: ~10–30ms per 1-minute m4a on a recent iPhone, run lazily on first
 * `play` tap. Decoded results are cached by `storagePath` to amortize repeat
 * plays of the same message in a session.
 */

import { VOICE_WAVEFORM_BAR_COUNT } from './types'

const memoryCache = new Map<string, number[]>()

/**
 * Returns a normalised array of {VOICE_WAVEFORM_BAR_COUNT} values in [0, 1]
 * representing the RMS envelope of the audio file. Uses WebAudio's
 * `decodeAudioData` which is available on all target Safari/WKWebView and
 * Chromium builds (Capacitor 8 minimum iOS 14 + Android 24).
 *
 * On decode failure (corrupt file, unsupported codec), returns a flat array
 * — the bubble still renders as a generic progress strip.
 */
export async function computeVoiceWaveform(
  blob: Blob,
  cacheKey?: string,
): Promise<number[]> {
  if (cacheKey) {
    const hit = memoryCache.get(cacheKey)
    if (hit) return hit
  }

  const fallback = new Array<number>(VOICE_WAVEFORM_BAR_COUNT).fill(0.35)

  if (typeof window === 'undefined') return fallback

  const AudioContextCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) return fallback

  let ctx: AudioContext | null = null
  try {
    const buf = await blob.arrayBuffer()
    ctx = new AudioContextCtor()
    const audio = await ctx.decodeAudioData(buf.slice(0))
    const channelData = audio.getChannelData(0)
    const bars = downsampleRms(channelData, VOICE_WAVEFORM_BAR_COUNT)
    if (cacheKey) memoryCache.set(cacheKey, bars)
    return bars
  } catch {
    return fallback
  } finally {
    if (ctx && ctx.state !== 'closed') {
      try {
        await ctx.close()
      } catch {
        // ignore
      }
    }
  }
}

function downsampleRms(samples: Float32Array, bars: number): number[] {
  const out = new Array<number>(bars).fill(0)
  if (samples.length === 0) return out
  const bucketSize = Math.max(1, Math.floor(samples.length / bars))
  let maxRms = 0
  for (let i = 0; i < bars; i++) {
    const start = i * bucketSize
    const end = i === bars - 1 ? samples.length : Math.min(samples.length, start + bucketSize)
    let sumSq = 0
    for (let j = start; j < end; j++) {
      const v = samples[j]
      sumSq += v * v
    }
    const rms = Math.sqrt(sumSq / Math.max(1, end - start))
    out[i] = rms
    if (rms > maxRms) maxRms = rms
  }
  if (maxRms > 0) {
    for (let i = 0; i < bars; i++) {
      out[i] = clamp01(out[i] / maxRms)
    }
  }
  // Ensure a visible minimum height for silent bars so the static shape still
  // reads as a waveform rather than an empty strip.
  for (let i = 0; i < bars; i++) {
    if (out[i] < 0.1) out[i] = 0.1
  }
  return out
}

function clamp01(value: number): number {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * Test-only: clear the in-memory cache so repeat invocations get a fresh
 * decode. Production callers should not need this.
 */
export function __resetVoiceWaveformCacheForTests(): void {
  memoryCache.clear()
}
