import type { TranscodeStatus } from '../types'

/**
 * V1 — no transcoding. Videos play from original storage URLs.
 *
 * V2 swap point: replace with CloudflareStreamAdapter or MuxAdapter.
 * V2 flow:
 *   1. sendVideoMessageWorkflow uploads raw video to storage
 *   2. Edge Function queues the asset with the provider
 *   3. Provider webhook → Edge Function updates chat_attachments:
 *      { h264_url, poster_url, transcode_status = 'ready' }
 *   4. Realtime UPDATE delivers enriched attachment row to clients
 *   5. VideoMessageBubble detects h264_url / poster_url and switches URLs
 */
export const noopMediaProcessingAdapter = {
  getPlaybackUrl(h264Url: string | null, fallbackStorageUrl: string): string {
    return h264Url ?? fallbackStorageUrl
  },
  getPosterUrl(posterUrl: string | null, fallbackStorageUrl: string | null): string | null {
    return posterUrl ?? fallbackStorageUrl
  },
} as const

export type { TranscodeStatus }
