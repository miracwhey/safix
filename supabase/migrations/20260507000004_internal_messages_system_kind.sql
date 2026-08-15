-- ===========================================================================
-- Team-Hub Block 3 — internal_messages.sender_kind (system messages)
-- ===========================================================================
-- Adds support for system-generated messages (e.g. "Anna hat sich vom 01.05. bis
-- 03.05. krankgemeldet") posted into office/team threads by the absence-notify
-- API. System messages have NO team_member sender — they are inserted via
-- service_role from a server endpoint, not by an authenticated user.
--
-- Constraint design — bruch-safe migration (Plan 4.2 R1–R6):
--   1. New column with default 'user' so EXISTING rows + EXISTING INSERTs
--      remain valid without code changes.
--   2. CHECK constraint locks the value to ('user', 'system').
--   3. sender_team_member_id becomes nullable, but a paired CHECK enforces
--      consistency: 'user' rows must have a sender, 'system' rows must not.
--   4. RLS policy imsg_participant_insert is replaced — the new policy
--      explicitly only allows sender_kind='user' for authenticated callers.
--      System inserts must come through service_role (bypasses RLS).
--   5. Realtime publication adds internal_messages so system messages light
--      up the Owner-Hub team chat in <2s.

-- Step 1: column with default — existing rows safely backfilled to 'user'.
alter table public.internal_messages
  add column sender_kind text not null default 'user';

-- Step 2: defensive backfill (NULL would violate NOT NULL anyway, but keep
-- the explicit UPDATE so re-runs against a partial state converge).
update public.internal_messages set sender_kind = 'user' where sender_kind is null;

-- Step 3: CHECK constraint on the value domain.
alter table public.internal_messages
  add constraint internal_messages_sender_kind_check
  check (sender_kind in ('user', 'system'));

-- Step 4: drop NOT NULL on sender_team_member_id so system inserts can leave
-- it null. Existing rows are unaffected (all have sender_team_member_id set).
alter table public.internal_messages
  alter column sender_team_member_id drop not null;

-- Step 5: consistency CHECK — user has sender, system does not.
alter table public.internal_messages
  add constraint internal_messages_sender_kind_consistency
  check (
    (sender_kind = 'user'   and sender_team_member_id is not null)
    or (sender_kind = 'system' and sender_team_member_id is null)
  );

-- Step 6: replace insert policy. The original policy required
-- sender_team_member_id NOT NULL implicitly (via the participant join). The
-- replacement policy requires sender_kind='user' explicitly so a malicious
-- authenticated client cannot post sender_kind='system' messages. System
-- messages must come from service_role (which bypasses RLS).
drop policy if exists imsg_participant_insert on public.internal_messages;

create policy imsg_participant_insert on public.internal_messages
for insert to authenticated
with check (
  sender_kind = 'user'
  and sender_team_member_id is not null
  and exists (
    select 1
    from public.message_thread_participants mtp
    join public.team_members tm on tm.id::text = mtp.team_member_id
    where mtp.thread_id = internal_messages.thread_id
      and mtp.team_member_id = internal_messages.sender_team_member_id
      and mtp.is_active = true
      and tm.profile_id = auth.uid()
  )
);

-- SELECT policies (imsg_owner_select, imsg_participant_select) are
-- sender_kind-agnostic — both surface user AND system messages to the same
-- audiences. No change needed.

-- Step 7: realtime publication so system messages live-update the chat
-- without requiring a manual re-fetch.
alter publication supabase_realtime add table public.internal_messages;

-- ===========================================================================
-- Comments
-- ===========================================================================

comment on column public.internal_messages.sender_kind is
  'user = posted by an authenticated team member (sender_team_member_id is set). system = posted by a server endpoint via service_role (sender_team_member_id is null).';
