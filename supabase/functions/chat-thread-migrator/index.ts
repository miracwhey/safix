/**
 * Edge Function `chat-thread-migrator` — Block D Slice 1 Phase 1a v2.
 * verify_jwt=false. Gateway-level apikey check happens before this code.
 *
 * SECURITY H2 (2026-06-12): the shared-secret gate is now REQUIRED. Every
 * non-GET request must carry header `x-fixup-trigger-secret` matching the
 * Edge env `FIXUP_TRIGGER_SHARED_SECRET` (timing-safe compare), else 401.
 * Without it, anyone could trigger batch migrations, corrupt migration state
 * (markFailed / exhaust MAX_ATTEMPTS) or force-migrate threads (integrity/DoS).
 *
 * Internal callers (pg_cron batch dispatcher + rpc_enqueue_thread_migration
 * lazy path) read the matching secret from the vault row
 * `account_cascade_cleanup.shared_secret` — the same prod-active row the
 * account-cascade + spatial-parametric cleanup dispatchers use — and send it
 * in the header (see migration 20260612030000).
 *
 * The GET branch stays open as a liveness/worker-id probe (no state, no secret).
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const LEASE_MS = 60_000
const DEFAULT_BATCH_SIZE = 20
const MAX_ATTEMPTS = 5
const WORKER_ID = `chat-migrator-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

interface Body {
  mode?: 'lazy' | 'batch' | 'verify'
  legacyThreadId?: string
  legacySource?: 'conversations' | 'message_threads'
  threadId?: string
  priority?: number
  batchSize?: number
}

function epochMs(): number { return Date.now() }

// Constant-time string compare (mirrors spatial-convert-done-push). Length
// check short-circuits — same accepted tradeoff as the rest of the codebase.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

Deno.serve(async (req) => {
  if (req.method === 'GET') {
    return Response.json({ ok: true, worker_id: WORKER_ID })
  }

  // SECURITY H2 — fail closed. Reject any mutating call without the shared
  // trigger secret BEFORE parsing the body or touching migration state.
  const expectedSecret = Deno.env.get('FIXUP_TRIGGER_SHARED_SECRET')
  if (!expectedSecret) {
    return Response.json({ error: 'server_misconfigured' }, { status: 500 })
  }
  const provided = req.headers.get('x-fixup-trigger-secret') ?? ''
  if (!provided || !timingSafeEqual(provided, expectedSecret)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: Body
  try { body = (await req.json()) as Body } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const mode = body.mode ?? 'batch'
  try {
    if (mode === 'lazy') {
      if (!body.legacyThreadId || !body.legacySource) {
        return Response.json({ error: 'missing_legacy_thread' }, { status: 400 })
      }
      return Response.json(await enqueueAndMigrate(body.legacyThreadId, body.legacySource, body.priority ?? 100))
    }
    if (mode === 'batch') {
      return Response.json(await batchMigrate(body.batchSize ?? DEFAULT_BATCH_SIZE))
    }
    if (mode === 'verify') {
      if (!body.threadId) return Response.json({ error: 'missing_thread_id' }, { status: 400 })
      return Response.json(await verifyThread(body.threadId))
    }
    return Response.json({ error: 'unknown_mode' }, { status: 400 })
  } catch (err) {
    return Response.json({ error: 'internal_error', message: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
})

async function enqueueAndMigrate(legacyThreadId: string, legacySource: 'conversations' | 'message_threads', priority: number) {
  const existing = await getMigrationStatusByLegacy(legacyThreadId, legacySource)
  if (existing && (existing.status === 'migration_complete' || existing.status === 'migration_verified')) {
    return { ok: true, status: existing.status, action: 'noop_already_migrated' }
  }
  let threadId: string
  if (existing) {
    threadId = existing.thread_id
  } else {
    threadId = await createChatThreadFromLegacy(legacyThreadId, legacySource)
    await supabase.from('chat_thread_migration_status').insert({
      thread_id: threadId,
      legacy_thread_id: legacyThreadId,
      legacy_source: legacySource,
      status: 'migration_queued',
      priority,
    })
  }
  return await migrateThread(threadId, legacyThreadId, legacySource)
}

async function batchMigrate(batchSize: number) {
  const { data: fallback } = await supabase
    .from('chat_thread_migration_status')
    .select('thread_id, legacy_thread_id, legacy_source')
    .in('status', ['not_migrated', 'migration_queued', 'migration_failed'])
    .lt('attempts', MAX_ATTEMPTS)
    .or(`lock_until.is.null,lock_until.lt.${epochMs()}`)
    .order('priority', { ascending: false })
    .order('updated_at', { ascending: true })
    .limit(batchSize)
  const list = fallback ?? []
  const results = []
  for (const row of list) {
    try {
      const r = await migrateThread(row.thread_id, row.legacy_thread_id, row.legacy_source)
      results.push({ thread_id: row.thread_id, ...r })
    } catch (err) {
      results.push({ thread_id: row.thread_id, ok: false, error: String(err) })
    }
  }
  return { ok: true, mode: 'batch', count: results.length, results }
}

async function verifyThread(threadId: string) {
  const { data: status } = await supabase.from('chat_thread_migration_status').select('*').eq('thread_id', threadId).single()
  if (!status) return { ok: false, error: 'status_row_not_found' }
  if (status.status !== 'migration_complete') return { ok: false, error: 'not_in_complete_state', current_status: status.status }
  const legacyCount = await countLegacyMessages(status.legacy_thread_id, status.legacy_source)
  const newCount = await countNewMessages(threadId)
  if (legacyCount !== newCount) {
    await markFailed(threadId, 'verification_count_mismatch', `legacy=${legacyCount} new=${newCount}`)
    return { ok: false, error: 'count_mismatch', legacyCount, newCount }
  }
  await supabase.from('chat_thread_migration_status').update({ status: 'migration_verified', verified_at: epochMs(), failure_reason: null, failed_step: null }).eq('thread_id', threadId)
  return { ok: true, status: 'migration_verified', legacyCount, newCount }
}

interface MigrationStatusRow {
  thread_id: string
  legacy_thread_id: string
  legacy_source: 'conversations' | 'message_threads'
  status: string
}

async function getMigrationStatusByLegacy(legacyThreadId: string, legacySource: 'conversations' | 'message_threads'): Promise<MigrationStatusRow | null> {
  const { data } = await supabase.from('chat_thread_migration_status').select('thread_id, legacy_thread_id, legacy_source, status').eq('legacy_thread_id', legacyThreadId).eq('legacy_source', legacySource).maybeSingle()
  return data
}

async function createChatThreadFromLegacy(legacyThreadId: string, legacySource: 'conversations' | 'message_threads'): Promise<string> {
  if (legacySource === 'conversations') {
    const { data: conv, error } = await supabase.from('conversations').select('*').eq('id', legacyThreadId).single()
    if (error || !conv) throw new Error(`legacy_conversation_not_found: ${legacyThreadId}`)
    let providerId: string | null = null
    if (conv.craftsman_user_id) {
      const { data: prov } = await supabase.from('providers').select('id').eq('profile_id', conv.craftsman_user_id).maybeSingle()
      providerId = prov?.id ?? null
    }
    const { data: created, error: insErr } = await supabase.from('chat_threads').insert({
      channel_type: 'customer',
      customer_user_id: conv.customer_user_id,
      craftsman_user_id: conv.craftsman_user_id,
      provider_id: providerId,
      legacy_thread_id: legacyThreadId,
      legacy_source: 'conversations',
      title: conv.project_title ?? null,
      created_at: conv.created_at ?? epochMs(),
    }).select('id').single()
    if (insErr || !created) throw new Error(`chat_threads_insert_failed: ${insErr?.message}`)
    return created.id
  }
  const { data: mt, error } = await supabase.from('message_threads').select('*').eq('id', legacyThreadId).single()
  if (error || !mt) throw new Error(`legacy_message_thread_not_found: ${legacyThreadId}`)
  const { data: created, error: insErr } = await supabase.from('chat_threads').insert({
    channel_type: mt.thread_type,
    provider_id: mt.provider_id,
    legacy_thread_id: legacyThreadId,
    legacy_source: 'message_threads',
    title: mt.title ?? null,
    last_message_body: mt.last_message_body ?? null,
    last_message_at: mt.last_message_at ?? null,
    created_at: mt.created_at ?? epochMs(),
  }).select('id').single()
  if (insErr || !created) throw new Error(`chat_threads_insert_failed: ${insErr?.message}`)
  return created.id
}

async function migrateThread(threadId: string, legacyThreadId: string, legacySource: 'conversations' | 'message_threads') {
  await supabase.from('chat_thread_migration_status').update({ status: 'migrating', started_at: epochMs(), lock_owner: WORKER_ID, lock_until: epochMs() + LEASE_MS }).eq('thread_id', threadId)
  try {
    await backfillParticipants(threadId, legacyThreadId, legacySource)
    await backfillMessages(threadId, legacyThreadId, legacySource)
    await supabase.from('chat_thread_migration_status').update({ status: 'migration_complete', completed_at: epochMs(), failure_reason: null, failed_step: null, lock_owner: null, lock_until: null }).eq('thread_id', threadId)
    const verified = await verifyThread(threadId)
    return { ok: true, status: verified.ok ? 'migration_verified' : 'migration_complete', verify: verified }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await markFailed(threadId, 'core_migration', reason)
    return { ok: false, status: 'migration_failed', error: reason }
  }
}

async function backfillParticipants(threadId: string, legacyThreadId: string, legacySource: 'conversations' | 'message_threads') {
  if (legacySource === 'conversations') {
    const { data: conv } = await supabase.from('conversations').select('customer_user_id, craftsman_user_id').eq('id', legacyThreadId).single()
    if (!conv) throw new Error('participants_source_not_found')
    const rows: Array<{ thread_id: string; user_id: string; role: string; joined_at: number }> = []
    if (conv.customer_user_id) rows.push({ thread_id: threadId, user_id: conv.customer_user_id, role: 'customer', joined_at: epochMs() })
    if (conv.craftsman_user_id) rows.push({ thread_id: threadId, user_id: conv.craftsman_user_id, role: 'craftsman', joined_at: epochMs() })
    if (rows.length > 0) await supabase.from('chat_participants').upsert(rows, { onConflict: 'thread_id,user_id' })
    return
  }
  const { data: mtp } = await supabase.from('message_thread_participants').select('team_member_id, is_active').eq('thread_id', legacyThreadId)
  if (!mtp || mtp.length === 0) return
  const teamMemberIds = mtp.filter((p) => p.is_active).map((p) => p.team_member_id)
  if (teamMemberIds.length === 0) return
  const { data: tms } = await supabase.from('team_members').select('id, profile_id, role').in('id', teamMemberIds)
  if (!tms) return
  const rows = tms.filter((tm) => tm.profile_id).map((tm) => ({
    thread_id: threadId,
    user_id: tm.profile_id as string,
    role: mapTeamRoleToChat(tm.role),
    joined_at: epochMs(),
  }))
  if (rows.length > 0) await supabase.from('chat_participants').upsert(rows, { onConflict: 'thread_id,user_id' })
}

function mapTeamRoleToChat(teamRole: string | null): string {
  if (teamRole === 'owner') return 'owner'
  if (teamRole === 'admin') return 'admin'
  return 'worker'
}

async function backfillMessages(threadId: string, legacyThreadId: string, legacySource: 'conversations' | 'message_threads') {
  if (legacySource === 'conversations') {
    const { data: msgs } = await supabase.from('messages').select('id, conversation_id, sender_user_id, content, created_at, media_url').eq('conversation_id', legacyThreadId).order('created_at', { ascending: true })
    if (!msgs) return
    for (const m of msgs) {
      const { error: rowErr } = await supabase.from('chat_messages').insert({
        thread_id: threadId,
        sender_user_id: m.sender_user_id,
        client_message_id: crypto.randomUUID(),
        body: m.content,
        message_type: 'text',
        created_at: m.created_at,
        legacy_message_id: m.id,
        legacy_source: 'messages',
      })
      if (rowErr && rowErr.code !== '23505') throw rowErr
    }
    return
  }
  const { data: msgs } = await supabase.from('internal_messages').select('id, thread_id, sender_team_member_id, body, message_kind, sender_kind, created_at').eq('thread_id', legacyThreadId).order('created_at', { ascending: true })
  if (!msgs) return
  const teamIds = [...new Set(msgs.map((m) => m.sender_team_member_id).filter(Boolean) as string[])]
  const tmMap = new Map<string, string>()
  if (teamIds.length > 0) {
    const { data: tms } = await supabase.from('team_members').select('id, profile_id').in('id', teamIds)
    for (const tm of tms ?? []) {
      if (tm.profile_id) tmMap.set(tm.id, tm.profile_id)
    }
  }
  const rows = msgs.filter((m) => m.sender_team_member_id && tmMap.has(m.sender_team_member_id)).map((m) => ({
    thread_id: threadId,
    sender_user_id: tmMap.get(m.sender_team_member_id as string) as string,
    client_message_id: crypto.randomUUID(),
    body: m.body,
    message_type: m.sender_kind === 'system' ? 'system' : 'text',
    created_at: m.created_at,
    legacy_message_id: m.id,
    legacy_source: 'internal_messages',
  }))
  for (const row of rows) {
    const { error: rowErr } = await supabase.from('chat_messages').insert(row)
    if (rowErr && rowErr.code !== '23505') throw rowErr
  }
}

async function markFailed(threadId: string, step: string, reason: string) {
  const { data: cur } = await supabase.from('chat_thread_migration_status').select('attempts').eq('thread_id', threadId).maybeSingle()
  const nextAttempts = (cur?.attempts ?? 0) + 1
  await supabase.from('chat_thread_migration_status').update({
    status: 'migration_failed',
    failed_at: epochMs(),
    failed_step: step,
    failure_reason: reason.slice(0, 1000),
    attempts: nextAttempts,
    lock_owner: null,
    lock_until: null,
  }).eq('thread_id', threadId)
}

async function countLegacyMessages(legacyThreadId: string, legacySource: 'conversations' | 'message_threads'): Promise<number> {
  if (legacySource === 'conversations') {
    const { count } = await supabase.from('messages').select('id', { count: 'exact', head: true }).eq('conversation_id', legacyThreadId)
    return count ?? 0
  }
  const { count } = await supabase.from('internal_messages').select('id', { count: 'exact', head: true }).eq('thread_id', legacyThreadId)
  return count ?? 0
}

async function countNewMessages(threadId: string): Promise<number> {
  const { count } = await supabase.from('chat_messages').select('id', { count: 'exact', head: true }).eq('thread_id', threadId).is('deleted_at', null)
  return count ?? 0
}
