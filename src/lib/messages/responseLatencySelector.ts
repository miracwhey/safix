/**
 * Antwortzeit-Signal für Provider-Discovery-Surfaces.
 *
 * Wenn `medianResponseMs` vorhanden, leitet das Label direkt aus dem
 * echten Median ab (SECURITY DEFINER RPC `get_provider_median_response_ms`).
 * Fallback auf Rating-Count-Heuristik für neue Provider ohne Msg-Historie.
 */

export type ProviderResponseSignal = {
  craftsmanUserId: string
  ratingCount: number
  verified: boolean
  /** Median first-response latency in milliseconds from the RPC. */
  medianResponseMs?: number | null
}

export type ResponseLatencyLabel = '< 4 h' | '< 1 d' | '1-2 d'

// Bucket thresholds in milliseconds
const MS_4H = 4 * 60 * 60 * 1000
const MS_1D = 24 * 60 * 60 * 1000
const MS_2D = 48 * 60 * 60 * 1000

export function deriveProviderResponseLatency(
  signal: ProviderResponseSignal,
): ResponseLatencyLabel | null {
  // Real data path — use measured median when available
  if (signal.medianResponseMs != null && signal.medianResponseMs > 0) {
    if (signal.medianResponseMs <= MS_4H) return '< 4 h'
    if (signal.medianResponseMs <= MS_1D) return '< 1 d'
    if (signal.medianResponseMs <= MS_2D) return '1-2 d'
    return null
  }

  // Fallback heuristic for providers without sufficient message history
  if (signal.verified && signal.ratingCount >= 5) return '< 4 h'
  if (signal.ratingCount >= 1) return '< 1 d'
  return null
}

export function formatResponseLatencyLabel(label: ResponseLatencyLabel | null): string | null {
  if (!label) return null
  return `Antwort meist ${label}`
}
