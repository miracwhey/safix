/**
 * Spatial · Canonical · Workflow · resolveProviderOrg (Phase C · C-0 · Seam 8)
 *
 * Resolves the signed-in provider-team member's provider-org id (`providers.id`).
 *
 * Phase B derived the org id from `job.providerId` of the owner's jobs — a
 * shortcut that is structurally the wrong source (it breaks the moment an
 * owner has zero jobs, and silently picks an arbitrary row otherwise).
 *
 * Phase C resolves it through the authoritative DB function
 * `public.spatial_user_provider_org(uid)` — the SAME `SECURITY DEFINER`
 * resolver the spatial RLS policies use. That function resolves the org for an
 * OWNER (`providers.profile_id = uid`) AND falls back to an active TEAM MEMBER
 * (`team_members.profile_id = uid AND is_active`). Going through the RPC keeps
 * the client and RLS in lockstep: any user who can pass RLS also resolves an
 * org id client-side.
 *
 * (The first C-0 implementation called `getProviderProfile`, which only
 * matches `providers.profile_id` — i.e. owners. A signed-in WORKER resolved to
 * `null`, the hooks early-returned, and the whole Spatial Hub silently rendered
 * its "first-login" empty state even though the worker's org had scenes.)
 *
 * Data-source aware (mirrors the repository registry): in `supabase` mode it
 * hits the RPC; in `in-memory` mode (tests + first-run dev) there is no
 * `providers`/`team_members` table, so it keeps the jobs-derived shortcut.
 * Both paths return the same thing — `providers.id`.
 *
 * Caching: a SUCCESSFUL resolution is cached module-level, keyed on the auth
 * uid, and dropped on sign-out. A transient failure is NEVER cached and is
 * reported distinctly (`failed: true`) so the React layer can retry instead of
 * settling permanently into the empty state.
 */

import { useCallback, useEffect, useState } from 'react'
import { getJobs } from '../../../jobs/jobsStore.ts'
import { getSession, subscribeSession } from '../../../session.ts'
import { supabase } from '../../../supabase.ts'
import { resolveSpatialDataSource } from '../repository/registry.ts'

interface OrgCacheEntry {
  /** auth uid the entry was resolved for. */
  uid: string
  /** Resolved `providers.id`, or `null` when the user has no provider org. */
  orgId: string | null
}

let _cache: OrgCacheEntry | null = null
let _signOutHookInstalled = false

/** Drop the cached resolution. Exposed for tests + the sign-out hook. */
export function clearProviderOrgCache(): void {
  _cache = null
}

/**
 * Install a one-time session subscription that drops the cache the moment the
 * signed-in uid disappears (sign-out). Keying the cache on the uid already
 * makes a *different* account miss the cache; this additionally prevents the
 * stale entry from outliving the session that produced it.
 */
function ensureSignOutHook(): void {
  if (_signOutHookInstalled) return
  _signOutHookInstalled = true
  subscribeSession(() => {
    if (!getSession().user?.id) _cache = null
  })
}

/** Provider-org id from the owner's in-memory jobs (in-memory data source). */
function resolveOrgFromJobs(): string | null {
  for (const job of getJobs()) {
    if (job.providerId) return job.providerId
  }
  return null
}

/** Outcome of a single resolution attempt. */
export interface ProviderOrgResolution {
  /** Resolved `providers.id`, or `null` when there is no session / no org. */
  orgId: string | null
  /**
   * True when the attempt failed transiently (network / RPC error) rather than
   * settling on a definitive `null`. The caller should retry; the result is
   * not cached.
   */
  failed: boolean
}

/**
 * Resolve the current user's `providers.id`. A successful resolution (incl. a
 * definitive `null` for a user with no org) is cached per auth uid; a transient
 * failure is reported via `failed` and never cached.
 */
export async function resolveProviderOrg(): Promise<ProviderOrgResolution> {
  ensureSignOutHook()

  const uid = getSession().user?.id ?? null
  if (!uid) {
    _cache = null
    return { orgId: null, failed: false }
  }
  if (_cache && _cache.uid === uid) return { orgId: _cache.orgId, failed: false }

  if (resolveSpatialDataSource() === 'supabase') {
    const { data, error } = await supabase.rpc('spatial_user_provider_org', {
      p_uid: uid,
    })
    if (error) {
      // Transient failure — do NOT cache. Reported as `failed` so the hook
      // retries rather than settling into the empty state.
      return { orgId: null, failed: true }
    }
    const orgId = (data as string | null) ?? null
    _cache = { uid, orgId }
    return { orgId, failed: false }
  }

  const orgId = resolveOrgFromJobs()
  _cache = { uid, orgId }
  return { orgId, failed: false }
}

/** Reactive provider-org resolution for the spatial hooks. */
export interface ProviderOrgState {
  /** Resolved `providers.id`, or `null` once resolution settled with no org. */
  orgId: string | null
  /** True while the resolver round-trip (incl. retries) is still in flight. */
  resolving: boolean
  /** True once resolution settled after exhausting retries without success. */
  failed: boolean
  /** Force a fresh resolution round (after a `failed` settle, or on demand). */
  retry: () => void
}

/** Retry backoff for transient resolver failures (ms per attempt index). */
const RETRY_DELAYS_MS = [500, 1500, 3000]

/**
 * React wrapper around {@link resolveProviderOrg}.
 *
 * `resolving` stays `true` for the whole resolver round-trip — INCLUDING the
 * bounded auto-retry on a transient failure — so consumers MUST gate their
 * `loading` flag on it. A transient blip on first load no longer wedges the
 * screen into the empty state: the hook retries up to {@link RETRY_DELAYS_MS}
 * times before settling, and `retry()` triggers a fresh round on demand.
 */
export function useProviderOrgId(): ProviderOrgState {
  const [state, setState] = useState<{
    orgId: string | null
    resolving: boolean
    failed: boolean
  }>({ orgId: null, resolving: true, failed: false })
  const [retryNonce, setRetryNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const attempt = (n: number): void => {
      resolveProviderOrg()
        .then((res) => {
          if (cancelled) return
          if (res.failed && n < RETRY_DELAYS_MS.length) {
            timer = setTimeout(() => attempt(n + 1), RETRY_DELAYS_MS[n])
            return
          }
          setState({ orgId: res.orgId, resolving: false, failed: res.failed })
        })
        .catch(() => {
          if (cancelled) return
          if (n < RETRY_DELAYS_MS.length) {
            timer = setTimeout(() => attempt(n + 1), RETRY_DELAYS_MS[n])
            return
          }
          setState({ orgId: null, resolving: false, failed: true })
        })
    }

    attempt(0)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [retryNonce])

  // The retry() entry-point flips state back into `resolving` and bumps the
  // nonce; the effect above only consumes the new nonce and triggers the
  // fetch. Combining the two writes keeps setState out of the effect body
  // (react-hooks/set-state-in-effect).
  const retry = useCallback(() => {
    setState((s) => ({ ...s, resolving: true, failed: false }))
    setRetryNonce((n) => n + 1)
  }, [])

  return { ...state, retry }
}
