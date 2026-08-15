import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Server-side Supabase admin client.
 *
 * Uses the service-role key which bypasses Row Level Security.  This client
 * is safe to use ONLY in server-side functions (api/).
 *
 * NEVER export this module or its client to client-side code.
 * NEVER put SUPABASE_SERVICE_ROLE_KEY in any VITE_* environment variable.
 *
 * Required server-side environment variables (set in Vercel project settings):
 *   SUPABASE_URL              — project URL (same value as VITE_SUPABASE_URL
 *                               but read server-side, never bundled)
 *   SUPABASE_SERVICE_ROLE_KEY — service-role JWT; bypasses RLS
 *
 * Returns a structured result describing missing env vars so callers can
 * emit precise errors instead of silently failing auth.
 */

// Module-level singleton: one admin client per warm serverless invocation.
let adminClient: SupabaseClient | null = null

export type SupabaseAdminResult =
  | { ok: true; client: SupabaseClient }
  | { ok: false; missing: string[] }

function readEnv(key: string): string | null {
  const value = process.env[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function resolveSupabaseAdminEnv(): { url: string | null; key: string | null; missing: string[] } {
  const url = readEnv('SUPABASE_URL') ?? readEnv('VITE_SUPABASE_URL')
  const key = readEnv('SUPABASE_SERVICE_ROLE_KEY') ?? readEnv('SUPABASE_SERVICE_KEY')

  const missing: string[] = []
  if (!url) missing.push('SUPABASE_URL')
  if (!key) missing.push('SUPABASE_SERVICE_ROLE_KEY')

  return { url, key, missing }
}

export function getSupabaseAdminWithStatus(): SupabaseAdminResult {
  const { url, key, missing } = resolveSupabaseAdminEnv()

  if (!url || !key) {
    return { ok: false, missing }
  }

  if (!adminClient) {
    adminClient = createClient(url, key, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  }

  return { ok: true, client: adminClient }
}

export function getSupabaseAdmin(): SupabaseClient | null {
  const result = getSupabaseAdminWithStatus()
  return result.ok ? result.client : null
}

// ---------------------------------------------------------------------------
// Shared error formatting
// ---------------------------------------------------------------------------

/**
 * Formats a human-readable error message from the missing env-var list
 * of a failed {@link SupabaseAdminResult}.
 *
 * Centralises the diagnostic string so every admin-unavailable error path
 * reports the same shape.
 */
export function formatAdminUnavailable(missing: string[]): string {
  return missing.length > 0
    ? `missing ${missing.join(', ')}.`
    : 'Supabase server credentials missing or invalid.'
}
