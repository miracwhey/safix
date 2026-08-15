/**
 * Customer Request Send Limit Service
 *
 * Enforces a daily limit on how many providers a customer can send requests to.
 * The limit is persisted so it is NOT a UI-only gate.
 *
 * Persistence strategy:
 *   - Supabase mode: reads/writes the `customer_request_sends` table.
 *   - In-memory / test mode: uses a module-level Map as backing store.
 *
 * ENFORCEMENT ENTITY:   Each row in `customer_request_sends` represents one
 *                        request sent by a customer to a provider.
 * DAILY LIMIT:          Counted by `sent_date = CURRENT_DATE` per user.
 * HOW THE RULE WORKS:   `canSendRequest()` returns false once the daily
 *                        count reaches MAX_DAILY_SENDS.
 */

import { supabase } from '../supabase'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_DAILY_SENDS = 3

// ---------------------------------------------------------------------------
// In-memory backing store (used when Supabase is not available / tests)
// ---------------------------------------------------------------------------

type SendRecord = { userId: string; providerId: string; sentDate: string }
let inMemorySends: SendRecord[] = []

/** Returns today's date as 'YYYY-MM-DD' in UTC (matches Supabase CURRENT_DATE). */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Data-source detection
// ---------------------------------------------------------------------------

function isSupabaseMode(): boolean {
  // If the env var is explicitly set to 'in-memory' we skip Supabase calls.
  if (typeof import.meta !== 'undefined') {
    try {
      const ds = import.meta.env?.VITE_DATA_SOURCE as string | undefined
      if (ds === 'in-memory') return false
    } catch {
      // fallback
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Count how many requests the customer has already sent today.
 */
export async function getSendsToday(userId: string): Promise<number> {
  if (!isSupabaseMode()) {
    const today = todayISO()
    return inMemorySends.filter(
      (r) => r.userId === userId && r.sentDate === today,
    ).length
  }

  const today = todayISO()
  const { count, error } = await supabase
    .from('customer_request_sends')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('sent_date', today)

  if (error) throw error
  return count ?? 0
}

/**
 * Whether the customer is allowed to send another request today.
 */
export async function canSendRequest(userId: string): Promise<boolean> {
  const count = await getSendsToday(userId)
  return count < MAX_DAILY_SENDS
}

/**
 * Record a request send.  Returns the updated daily count.
 * Throws if the daily limit would be exceeded.
 */
export async function recordRequestSend(
  userId: string,
  providerId: string,
): Promise<number> {
  const count = await getSendsToday(userId)
  if (count >= MAX_DAILY_SENDS) {
    throw new Error(
      `Tageslimit erreicht: Du kannst maximal ${MAX_DAILY_SENDS} Anfragen pro Tag senden.`,
    )
  }

  if (!isSupabaseMode()) {
    inMemorySends.push({ userId, providerId, sentDate: todayISO() })
    return count + 1
  }

  const { error } = await supabase.from('customer_request_sends').insert({
    user_id: userId,
    provider_id: providerId,
    sent_date: todayISO(),
  })
  if (error) throw error
  return count + 1
}

/**
 * How many sends remain for today.
 */
export async function remainingSendsToday(userId: string): Promise<number> {
  const count = await getSendsToday(userId)
  return Math.max(0, MAX_DAILY_SENDS - count)
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Reset the in-memory store.  Only useful in tests. */
export function _resetInMemorySends(): void {
  inMemorySends = []
}
