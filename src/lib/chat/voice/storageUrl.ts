/**
 * Block D Slice 3 — Shared signed-URL cache for voice-note storage objects.
 *
 * Both `useVoicePlayer` (audio playback) and `VoiceMessageBubble` (waveform
 * decode) need a signed URL for the same chat-* storage object. Without a
 * shared cache they each issue an independent `createSignedUrl` call,
 * doubling the Storage round-trips per voice bubble.
 *
 * One module-level Map keyed by `{bucket}|{path}` with a TTL guard.
 */

import { supabase } from '../../supabase'

const URL_TTL_SEC = 60 * 60
const REFRESH_MARGIN_MS = 60 * 1000

interface CachedUrl {
  url: string
  expiresAt: number
}

const cache = new Map<string, CachedUrl>()

export async function resolveChatAttachmentUrl(bucket: string, path: string): Promise<string> {
  const key = `${bucket}|${path}`
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && hit.expiresAt > now + REFRESH_MARGIN_MS) {
    return hit.url
  }
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, URL_TTL_SEC)
  if (error || !data?.signedUrl) {
    throw new Error(error?.message ?? 'failed to sign url')
  }
  cache.set(key, {
    url: data.signedUrl,
    expiresAt: now + URL_TTL_SEC * 1000,
  })
  return data.signedUrl
}

/**
 * Drop the cached signed URL for one object so the next resolve issues a fresh
 * `createSignedUrl`. Used by media bubbles on `<img>`/`<video>` onError: a
 * still-cached-but-broken URL (expired token, object moved) must not be handed
 * back unchanged — invalidating first guarantees the re-resolve returns a new
 * token, which changes the element `src` and actually retries the load.
 */
export function invalidateChatAttachmentUrl(bucket: string, path: string): void {
  cache.delete(`${bucket}|${path}`)
}

export function __resetChatAttachmentUrlCacheForTests(): void {
  cache.clear()
}
