-- ===========================================================================
-- Block A · M1 Push-Inline-Actions — Persistent Idempotency Audit
-- ===========================================================================
-- Adds an append-only audit table for inline push-action taps (APPROVE /
-- REJECT on the iOS lockscreen). The PRIMARY KEY (notification_id, action_id)
-- gives us atomic duplicate-detection across app restarts — the in-memory
-- 5 s window in pushActionDispatcher only protects against rapid double-taps
-- in the same app lifetime; a tap, then app-kill, then tap-again on the
-- same notification from Notification Center would otherwise approve the
-- same correction twice.
--
-- Default-deny RLS + REVOKE writes (Memory: feedback_audit_table_revoke_writes).
-- The only writer is the SECURITY DEFINER RPC `record_push_action_attempt`,
-- which the bridge calls after the dispatcher returns navigate_with_sheet.
-- The RPC returns true on first insert, false on conflict — the bridge
-- converts a false return into a fallback outcome and aborts navigation.
-- ===========================================================================

create table public.push_action_audit (
  notification_id uuid not null,
  action_id       text not null,
  user_id         uuid not null references auth.users(id) on delete cascade,
  performed_at    timestamptz not null default now(),
  primary key (notification_id, action_id)
);

create index push_action_audit_user_time_idx
  on public.push_action_audit (user_id, performed_at desc);

alter table public.push_action_audit enable row level security;

revoke insert, update, delete, truncate on public.push_action_audit
  from anon, authenticated;
revoke select on public.push_action_audit from anon, authenticated;

comment on table public.push_action_audit is
  'Append-only audit of push-inline-action taps (APPROVE/REJECT). PK on (notification_id, action_id) gives persistent idempotency across app restarts — a re-tap from Notification Center after app-kill is rejected here even though the in-memory 5 s window is gone. Default-deny RLS + REVOKE writes; the only writer is the SECURITY DEFINER record_push_action_attempt RPC.';

-- ===========================================================================
-- record_push_action_attempt(notification_id, action_id) → boolean
-- ===========================================================================
-- Atomic insert with ON CONFLICT DO NOTHING. Returns:
--   true  — first attempt for this (notification_id, action_id) → continue
--   false — duplicate, missing auth.uid(), or invalid input → abort
--
-- The function never throws — the catch-all defends against partition / CTE
-- edge cases so a bridge call is always safe to make. A false return on a
-- non-duplicate input (e.g. transient DB error) is acceptable: the bridge
-- treats that as "duplicate" and aborts, which is the safe default.
-- ===========================================================================

create or replace function public.record_push_action_attempt(
  p_notification_id uuid,
  p_action_id       text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_inserted  int;
begin
  if v_uid is null then
    return false;
  end if;
  if p_notification_id is null then
    return false;
  end if;
  if p_action_id is null or p_action_id not in ('APPROVE', 'REJECT') then
    return false;
  end if;

  insert into public.push_action_audit (notification_id, action_id, user_id)
  values (p_notification_id, p_action_id, v_uid)
  on conflict (notification_id, action_id) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted = 1;

exception when others then
  return false;
end;
$$;

revoke execute on function public.record_push_action_attempt(uuid, text)
  from public;
grant execute on function public.record_push_action_attempt(uuid, text)
  to authenticated;

comment on function public.record_push_action_attempt(uuid, text) is
  'Block A · atomically records a push-inline-action tap attempt. Returns true on first insert (caller continues), false on duplicate / missing auth / invalid action_id (caller aborts). Used by pushNotificationBridge.handlePushActionTap as a persistent idempotency layer above the in-memory 5 s window — protects against re-tap from Notification Center after app-kill.';
