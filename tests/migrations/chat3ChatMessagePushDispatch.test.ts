/**
 * CHAT-3 — structural verification of the
 * `20260610150000_chat3_chat_message_push_dispatch.sql` migration.
 *
 * The migration adds the FIRST push path for chat messages: an AFTER-INSERT
 * trigger on `chat_messages` that dispatches via pg_net to the already
 * deployed `notify-push` Edge Function (vault secrets `notify_push.url` /
 * `notify_push.shared_secret`, mirror of the live
 * `notification_signals_dispatch_push` pattern).
 *
 * Asserted here (regression-map top risk 3: a THROWING after-insert trigger
 * would kill every chat send):
 *   - non-throwing design: outer catch-all EXCEPTION backstop + RETURN NEW,
 *     nested EXCEPTION blocks around the vault read and net.http_post.
 *   - recipient resolution: thread participants minus sender, left_at IS
 *     NULL, muted_until respected, user_blocks mirrored from
 *     fn_chat_update_thread_last_message.
 *   - scope guards: channel_type='customer' only; system/deleted/redacted
 *     rows never push.
 *   - pre-enriched payload: route per participant role, fallbackRoute,
 *     actionVersion=1 (= PUSH_ROUTE_SCHEMA_VERSION).
 *   - ACL hygiene + trigger wiring + PostgREST cache reload.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

import { PUSH_ROUTE_SCHEMA_VERSION } from '../../src/lib/notifications/pushRoutes'

const MIGRATIONS_DIR = resolve(__dirname, '../../supabase/migrations')
const sql = readFileSync(
  resolve(MIGRATIONS_DIR, '20260610150000_chat3_chat_message_push_dispatch.sql'),
  'utf8',
)

describe('Migration 20260610150000 — chat_messages push dispatch trigger', () => {
  it('creates the AFTER INSERT trigger on public.chat_messages FOR EACH ROW', () => {
    expect(sql).toMatch(/CREATE TRIGGER\s+chat_messages_dispatch_push_tg/)
    expect(sql).toMatch(
      /AFTER INSERT\s+ON\s+public\.chat_messages\s+FOR EACH ROW/,
    )
    expect(sql).toMatch(
      /EXECUTE FUNCTION\s+public\.chat_messages_dispatch_push\(\)/,
    )
  })

  it('trigger creation is idempotent (DROP TRIGGER IF EXISTS + CREATE OR REPLACE FUNCTION)', () => {
    expect(sql).toMatch(
      /DROP TRIGGER IF EXISTS\s+chat_messages_dispatch_push_tg\s+ON\s+public\.chat_messages/,
    )
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION\s+public\.chat_messages_dispatch_push\(\)/,
    )
  })

  it('mirrors the live SECDEF pattern (SECURITY DEFINER + pinned search_path)', () => {
    expect(sql).toMatch(/SECURITY DEFINER/)
    expect(sql).toMatch(/SET search_path TO 'public', 'extensions'/)
  })
})

describe('Migration 20260610150000 — non-throwing design (chat send must never break)', () => {
  it('has an outer catch-all EXCEPTION backstop that returns NEW', () => {
    // Outer backstop goes BEYOND the notification_signals_dispatch_push
    // template: any unexpected error is swallowed with RAISE NOTICE.
    expect(sql).toMatch(
      /EXCEPTION WHEN OTHERS THEN\s*\n\s*--[^\n]*Backstop[\s\S]*?RAISE NOTICE 'chat_push: dispatch failed[\s\S]*?RETURN NEW;\s*\nEND;/,
    )
  })

  it('wraps the vault read in a nested EXCEPTION block that skips instead of throwing', () => {
    expect(sql).toMatch(
      /vault\.decrypted_secrets[\s\S]*?EXCEPTION WHEN OTHERS THEN\s*\n\s*RAISE NOTICE 'chat_push: vault unavailable[\s\S]*?RETURN NEW;/,
    )
  })

  it('wraps net.http_post in a nested EXCEPTION block (failed dispatch is a notice, not an error)', () => {
    expect(sql).toMatch(
      /net\.http_post\([\s\S]*?EXCEPTION WHEN OTHERS THEN\s*\n\s*RAISE NOTICE 'chat_push: pg_net\.http_post failed/,
    )
  })

  it('skips (RETURN NEW) when vault entries are missing instead of raising', () => {
    expect(sql).toMatch(
      /IF v_url IS NULL OR v_secret IS NULL THEN\s*\n\s*RAISE NOTICE[\s\S]*?RETURN NEW;/,
    )
  })
})

describe('Migration 20260610150000 — dispatch plumbing (live prod pattern)', () => {
  it('reads both vault secrets by their existing prod names', () => {
    expect(sql).toMatch(/WHERE name = 'notify_push\.url'/)
    expect(sql).toMatch(/WHERE name = 'notify_push\.shared_secret'/)
  })

  it('authenticates against the Edge Function with the shared-secret header', () => {
    expect(sql).toMatch(/'x-fixup-trigger-secret', v_secret/)
  })

  it('posts the same body shape as the signals dispatcher ({pushes: [...]}) with a 5s timeout', () => {
    expect(sql).toMatch(/jsonb_build_object\('pushes', v_pushes\)/)
    expect(sql).toMatch(/timeout_milliseconds := 5000/)
  })

  it('resolves device tokens via notification_device_tokens with the text-typed user_id join', () => {
    // notification_device_tokens.user_id is text (registration writes
    // session.user.id); chat_participants.user_id is uuid → explicit cast.
    expect(sql).toMatch(
      /JOIN public\.notification_device_tokens t\s*\n\s*ON t\.user_id = cp\.user_id::text/,
    )
  })
})

describe('Migration 20260610150000 — recipient resolution guards', () => {
  it('excludes the sender from recipients', () => {
    expect(sql).toMatch(/cp\.user_id <> NEW\.sender_user_id/)
  })

  it('only targets participants still in the thread (left_at IS NULL)', () => {
    expect(sql).toMatch(/cp\.left_at IS NULL/)
  })

  it('respects muted_until (bigint ms, compared against epoch_ms())', () => {
    expect(sql).toMatch(
      /cp\.muted_until IS NULL OR cp\.muted_until <= v_now/,
    )
    expect(sql).toMatch(/v_now := public\.epoch_ms\(\);/)
  })

  it('mirrors the user_blocks filter from fn_chat_update_thread_last_message (blocker gets no push)', () => {
    expect(sql).toMatch(
      /NOT EXISTS \(\s*\n\s*SELECT 1 FROM public\.user_blocks ub\s*\n\s*WHERE ub\.blocker_id = cp\.user_id\s*\n\s*AND ub\.blocked_id = NEW\.sender_user_id/,
    )
  })

  it('short-circuits cleanly when no recipient has a device token', () => {
    expect(sql).toMatch(/IF v_pushes IS NULL THEN\s*\n\s*RETURN NEW;/)
  })
})

describe('Migration 20260610150000 — scope guards (v1 = customer channel only)', () => {
  it('skips system, deleted and redacted messages', () => {
    expect(sql).toMatch(
      /IF NEW\.message_type = 'system' OR NEW\.deleted_at IS NOT NULL OR NEW\.redacted THEN\s*\n\s*RETURN NEW;/,
    )
  })

  it("only dispatches for channel_type = 'customer' threads (office/team are a follow-up block)", () => {
    expect(sql).toMatch(
      /IF v_channel IS DISTINCT FROM 'customer' THEN\s*\n\s*RETURN NEW;/,
    )
    expect(sql).toMatch(
      /SELECT ct\.channel_type INTO v_channel\s*\n\s*FROM public\.chat_threads ct WHERE ct\.id = NEW\.thread_id;/,
    )
  })
})

describe('Migration 20260610150000 — pre-enriched route payload', () => {
  it('carries type=chat_message with threadId/messageId and deliberately no jobId', () => {
    expect(sql).toMatch(/'type',\s+'chat_message'/)
    expect(sql).toMatch(/'threadId',\s+NEW\.thread_id/)
    expect(sql).toMatch(/'messageId',\s+NEW\.id/)
    // No jobId key: Edge enrichPushDataWithRoute requires type+jobId to touch
    // data — absence guarantees verified passthrough of the pre-built route.
    expect(sql).not.toMatch(/'jobId'/)
  })

  it('routes customers to /messages/{threadId} and craftsman-side roles to /craftsman/messages/{threadId}', () => {
    expect(sql).toMatch(
      /CASE WHEN cp\.role = 'customer'\s*\n\s*THEN '\/messages\/'\s+\|\| NEW\.thread_id\s*\n\s*ELSE '\/craftsman\/messages\/' \|\| NEW\.thread_id END/,
    )
  })

  it('sets the list tabs as fallbackRoute per role', () => {
    expect(sql).toMatch(
      /CASE WHEN cp\.role = 'customer'\s*\n\s*THEN '\/messages'\s*\n\s*ELSE '\/craftsman\/messages' END/,
    )
  })

  it('hardcodes actionVersion in lock-step with PUSH_ROUTE_SCHEMA_VERSION', () => {
    expect(sql).toMatch(/'actionVersion', 1\b/)
    // If the client schema version is ever bumped, the trigger function MUST
    // be migrated along — otherwise the resolver drops chat pushes with
    // reason `unknown_version`. This assertion fails loudly on a bump.
    expect(PUSH_ROUTE_SCHEMA_VERSION).toBe(1)
  })

  it('uses generic, PII-light copy without the message body', () => {
    expect(sql).toMatch(/'Neue Nachricht'/)
    expect(sql).toMatch(/'Sie haben eine neue Nachricht erhalten\.'/)
    // The push body must never embed NEW.body (message content on the
    // lock screen would leak chat content).
    expect(sql).not.toMatch(/v_body\s*:?=[^;]*NEW\.body/)
  })
})

describe('Migration 20260610150000 — ACL hygiene + cache reload', () => {
  it('revokes default EXECUTE from PUBLIC, anon and authenticated', () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.chat_messages_dispatch_push\(\) FROM PUBLIC, anon, authenticated;/,
    )
  })

  it('grants EXECUTE to service_role only (mirror of the signals dispatcher ACL)', () => {
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.chat_messages_dispatch_push\(\) TO service_role;/,
    )
  })

  it('reloads the PostgREST schema cache', () => {
    expect(sql).toMatch(/NOTIFY pgrst, 'reload schema';/)
  })
})
