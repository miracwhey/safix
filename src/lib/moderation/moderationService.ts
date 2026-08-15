import { supabase } from '../supabase';
import type { ReportReason } from './types';

// ---------------------------------------------------------------------------
// Synchronous block cache — refreshed on login and after block/unblock.
// Selectors (which are synchronous) read from this cache; async mutations
// refresh it after write.
// ---------------------------------------------------------------------------
let _blockedUserIds: Set<string> = new Set();

/** Synchronous read of cached blocked user IDs. */
export function getBlockedUserIdsSync(): ReadonlySet<string> {
  return _blockedUserIds;
}

/** Refresh the in-memory block cache from Supabase. */
export async function refreshBlockCache(): Promise<void> {
  const ids = await getBlockedUserIds();
  _blockedUserIds = new Set(ids);
}

/** Anchor describing which UGC surface a report originates from. */
export interface ReportContext {
  /** Free-text detail (e.g. the "other" reason description). Maps to user_reports.details. */
  details?: string;
  /** UGC surface, e.g. 'conversation' | 'profile' | 'explore_reel' | 'portfolio_comment' | 'review'. */
  contextType?: string;
  /** Id of the reported content on that surface (message/reel/comment/review/job id). */
  contextId?: string;
}

/**
 * Report a user for abusive behaviour.
 * Returns the created report ID on success.
 */
export async function reportUser(
  reportedUserId: string,
  reason: ReportReason,
  context?: ReportContext,
): Promise<string> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Nicht angemeldet.');

  const { data, error } = await supabase
    .from('user_reports')
    .insert({
      reporter_id: user.id,
      reported_id: reportedUserId,
      reason,
      details: context?.details ?? null,
      context_type: context?.contextType ?? null,
      context_id: context?.contextId ?? null,
    })
    .select('id')
    .single();

  if (error) throw new Error(error.message);
  return data.id as string;
}

/**
 * Block a user. Blocked users are filtered from conversation lists.
 */
export async function blockUser(blockedUserId: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Nicht angemeldet.');

  const { error } = await supabase
    .from('user_blocks')
    .upsert(
      { blocker_id: user.id, blocked_id: blockedUserId },
      { onConflict: 'blocker_id,blocked_id' },
    );

  if (error) throw new Error(error.message);
  await refreshBlockCache();
}

/**
 * Unblock a previously blocked user.
 */
export async function unblockUser(blockedUserId: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Nicht angemeldet.');

  const { error } = await supabase
    .from('user_blocks')
    .delete()
    .eq('blocker_id', user.id)
    .eq('blocked_id', blockedUserId);

  if (error) throw new Error(error.message);
  await refreshBlockCache();
}

/**
 * Get the list of user IDs blocked by the current user.
 */
export async function getBlockedUserIds(): Promise<string[]> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from('user_blocks')
    .select('blocked_id')
    .eq('blocker_id', user.id);

  if (error || !data) return [];
  return (data as { blocked_id: string }[]).map((b) => b.blocked_id);
}

/**
 * Check if the counterpart has blocked the current user.
 * Requires the "users_see_blocks_against_them" RLS policy.
 */
export async function isBlockedByCounterpart(counterpartId: string): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;

  const { data } = await supabase
    .from('user_blocks')
    .select('id')
    .eq('blocker_id', counterpartId)
    .eq('blocked_id', user.id)
    .maybeSingle();

  return data !== null;
}

/**
 * Check if the current user has blocked a specific user.
 */
export async function isUserBlocked(userId: string): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;

  const { data, error } = await supabase
    .from('user_blocks')
    .select('id')
    .eq('blocker_id', user.id)
    .eq('blocked_id', userId)
    .maybeSingle();

  if (error) return false;
  return data !== null;
}
