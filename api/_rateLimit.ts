/**
 * Server-side rate limiting for Vercel API functions.
 *
 * Uses @upstash/ratelimit with a sliding-window algorithm backed by
 * Upstash Redis (REST-based — no persistent TCP connections, serverless-safe).
 *
 * Two tiers:
 *   critical  — 10 requests / 60s per user (payment, destructive, email)
 *   standard  — 30 requests / 60s per user (connect, status, reads)
 *
 * Keying: userId (from JWT auth). All rate-limited routes require
 * authentication, so the userId is always available. userId is strictly
 * better than IP for authenticated routes: no shared-network false
 * positives, not bypassable by IP rotation, and precise per-user.
 *
 * Failure semantics differ by tier:
 *   critical  — fail-closed with in-memory fallback. If Upstash is
 *               unreachable or not configured, a per-isolate in-memory
 *               limiter still enforces the burst window. This is weaker
 *               than distributed limiting (each Vercel isolate tracks
 *               independently) but catches rapid-fire abuse within a
 *               single warm instance — the most common attack pattern.
 *   standard  — fail-open. Auth + authorization are the primary defense
 *               for lower-risk routes. Availability takes priority.
 *
 * Required environment variables (set in Vercel project settings):
 *   UPSTASH_REDIS_REST_URL    — Upstash Redis REST endpoint
 *   UPSTASH_REDIS_REST_TOKEN  — Upstash Redis REST auth token
 *
 * Emitted observability events:
 *   api.ratelimit.exceeded            — Request blocked via Upstash
 *   api.ratelimit.exceeded_fallback   — Request blocked via in-memory fallback
 *   api.ratelimit.error               — Upstash call failed (with fallback tier info)
 *   api.ratelimit.unconfigured        — Upstash env vars missing (once per cold start)
 */

import type { VercelResponse } from '@vercel/node'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { logWarning, logError } from './_observability.js'

// ---------------------------------------------------------------------------
// Tier definitions
// ---------------------------------------------------------------------------

export type RateLimitTier = 'critical' | 'standard'

const TIER_CONFIG: Record<RateLimitTier, { requests: number; windowSec: number }> = {
  critical: { requests: 10, windowSec: 60 },
  standard: { requests: 30, windowSec: 60 },
}

// ---------------------------------------------------------------------------
// Lazy-initialised Upstash limiters (shared across warm invocations)
// ---------------------------------------------------------------------------

let limiters: Record<RateLimitTier, Ratelimit> | null = null
let configWarningEmitted = false

function getLimiters(): Record<RateLimitTier, Ratelimit> | null {
  if (limiters) return limiters

  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN

  if (!url || !token) {
    if (!configWarningEmitted) {
      logWarning('api.ratelimit.unconfigured', {
        reason: 'UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not set',
        impact: 'critical routes use in-memory fallback, standard routes unprotected',
      })
      configWarningEmitted = true
    }
    return null
  }

  const redis = new Redis({ url, token })

  limiters = {
    critical: new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(
        TIER_CONFIG.critical.requests,
        `${TIER_CONFIG.critical.windowSec} s`,
      ),
      prefix: 'rl:critical',
      analytics: false,
    }),
    standard: new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(
        TIER_CONFIG.standard.requests,
        `${TIER_CONFIG.standard.windowSec} s`,
      ),
      prefix: 'rl:standard',
      analytics: false,
    }),
  }

  return limiters
}

// ---------------------------------------------------------------------------
// In-memory fallback limiter (per-isolate)
// ---------------------------------------------------------------------------
// Vercel keeps serverless functions warm for minutes. A burst attack
// hitting the same isolate will be caught. Different isolates don't share
// state — this is weaker than distributed limiting but still meaningful
// protection for the most common abuse pattern: rapid sequential requests.

const memoryStore = new Map<string, { count: number; windowStart: number }>()
const MEMORY_CLEANUP_THRESHOLD = 500

function checkMemoryLimit(
  key: string,
  maxRequests: number,
  windowMs: number,
): { allowed: boolean; remaining: number } {
  const now = Date.now()

  // Periodic cleanup: evict expired entries when store grows large.
  if (memoryStore.size > MEMORY_CLEANUP_THRESHOLD) {
    for (const [k, entry] of memoryStore) {
      if (now - entry.windowStart >= windowMs * 2) {
        memoryStore.delete(k)
      }
    }
  }

  const entry = memoryStore.get(key)

  if (!entry || now - entry.windowStart >= windowMs) {
    memoryStore.set(key, { count: 1, windowStart: now })
    return { allowed: true, remaining: maxRequests - 1 }
  }

  entry.count++
  const remaining = Math.max(0, maxRequests - entry.count)

  if (entry.count > maxRequests) {
    return { allowed: false, remaining: 0 }
  }

  return { allowed: true, remaining }
}

/**
 * Applies the in-memory fallback rate limit.
 * Returns `true` when blocked (429 already sent).
 */
function applyMemoryFallback(
  res: VercelResponse,
  tier: RateLimitTier,
  userId: string,
): boolean {
  const config = TIER_CONFIG[tier]
  const key = `${tier}:${userId}`
  const { allowed, remaining } = checkMemoryLimit(
    key,
    config.requests,
    config.windowSec * 1000,
  )

  res.setHeader('X-RateLimit-Limit', String(config.requests))
  res.setHeader('X-RateLimit-Remaining', String(remaining))
  res.setHeader('X-RateLimit-Source', 'memory-fallback')

  if (!allowed) {
    res.setHeader('Retry-After', String(config.windowSec))

    logWarning('api.ratelimit.exceeded_fallback', { tier, userId })

    res.status(429).json({
      error: 'Too many requests. Please retry later.',
      retryAfter: config.windowSec,
    })
    return true
  }

  return false
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Applies rate limiting for the given tier and user.
 *
 * Returns `true` when the request has been blocked (429 response already
 * sent) — the caller must `return` immediately, matching the `applyCors`
 * convention.
 *
 * Returns `false` when the request is allowed to proceed.
 *
 * Failure semantics:
 *   critical — always enforced. Falls back to in-memory limiter when
 *              Upstash is unavailable.
 *   standard — fail-open when Upstash is unavailable. Lower risk,
 *              availability preferred.
 *
 * Usage:
 *   const auth = await requireAuth(req, res)
 *   if (!auth) return
 *   if (await applyRateLimit(res, 'critical', auth.userId)) return
 */
export async function applyRateLimit(
  res: VercelResponse,
  tier: RateLimitTier,
  userId: string,
): Promise<boolean> {
  const instances = getLimiters()

  // ── Upstash not configured ──────────────────────────────────────────────
  if (!instances) {
    // Production must never silently run unlimited: the standard tier's
    // fail-open semantics assume Upstash is reachable in prod and only
    // degrades on transient errors below. Missing config in production is
    // a deploy defect, not a transient blip — treat it like `critical` and
    // fall back to the in-memory limiter instead of passing every request.
    if (tier === 'critical' || process.env.VERCEL_ENV === 'production') {
      return applyMemoryFallback(res, tier, userId)
    }
    return false
  }

  // ── Upstash configured — try distributed limit ─────────────────────────
  try {
    const { success, limit, remaining, reset } = await instances[tier].limit(userId)

    res.setHeader('X-RateLimit-Limit', String(limit))
    res.setHeader('X-RateLimit-Remaining', String(remaining))
    res.setHeader('X-RateLimit-Reset', String(reset))

    if (!success) {
      const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000))
      res.setHeader('Retry-After', String(retryAfter))

      logWarning('api.ratelimit.exceeded', {
        tier,
        userId,
        limit,
        reset,
        retryAfter,
      })

      res.status(429).json({
        error: 'Too many requests. Please retry later.',
        retryAfter,
      })
      return true
    }

    return false
  } catch (err) {
    // ── Upstash unreachable ─────────────────────────────────────────────
    logError('api.ratelimit.error', err instanceof Error ? err : undefined, {
      tier,
      userId,
      fallback: tier === 'critical' ? 'memory' : 'open',
      raw: err instanceof Error ? undefined : String(err),
    })

    if (tier === 'critical') {
      return applyMemoryFallback(res, tier, userId)
    }

    // standard: fail-open
    return false
  }
}
