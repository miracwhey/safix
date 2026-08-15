-- =============================================================================
-- Migration: Internal Messaging Foundation
-- =============================================================================
-- Purpose:
--   Creates the real company-internal messaging model supporting:
--     - assignment threads (tied to calendar_entries)
--     - office threads (company ↔ worker communication not tied to a specific assignment)
--     - team threads (internal worker/team communication)
--
--   The schema is intentionally separate from the customer ↔ craftsman
--   conversations/messages tables. Workers are not Conversation participants.
--   This is a new domain.
--
-- Determinism rule:
--   Each calendar_entry has at most ONE assignment thread (UNIQUE constraint on
--   calendar_entry_id). The get_or_create_assignment_thread() DB function is
--   the single, race-safe creation path.
--
-- Visibility model:
--   Owner/admin → all threads for their provider
--   Worker      → only threads where they are an active participant
--   Other company → blocked (provider_id scoping)
--
-- Participant model:
--   message_thread_participants uses team_members.id (stored as text to
--   accommodate both UUID members and legacy tm-* seeded members).
--   get_or_create_assignment_thread() auto-adds all assigned_member_ids from
--   the calendar_entry plus all owner/admin members of the company.
-- =============================================================================

-- ── Tables ────────────────────────────────────────────────────────────────────

CREATE TABLE public.message_threads (
  id                        uuid    NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  provider_id               uuid    NOT NULL REFERENCES public.providers(id) ON DELETE CASCADE,
  thread_type               text    NOT NULL CHECK (thread_type IN ('assignment', 'office', 'team')),
  calendar_entry_id         uuid    REFERENCES public.calendar_entries(id) ON DELETE SET NULL,
  created_by_team_member_id text    NOT NULL,
  title                     text,
  last_message_at           bigint,
  last_message_body         text,
  created_at                bigint  NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint,
  updated_at                bigint  NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint,
  -- One and only one primary assignment thread per calendar entry.
  -- NULL calendar_entry_id values do not collide (SQL NULL != NULL in UNIQUE).
  CONSTRAINT uq_assignment_thread UNIQUE (calendar_entry_id)
);

CREATE INDEX idx_message_threads_provider
  ON public.message_threads (provider_id);

CREATE INDEX idx_message_threads_calendar_entry
  ON public.message_threads (calendar_entry_id)
  WHERE calendar_entry_id IS NOT NULL;

-- ──

CREATE TABLE public.message_thread_participants (
  id             uuid    NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  thread_id      uuid    NOT NULL REFERENCES public.message_threads(id) ON DELETE CASCADE,
  team_member_id text    NOT NULL,
  is_active      boolean NOT NULL DEFAULT true,
  last_read_at   bigint,
  created_at     bigint  NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint,
  UNIQUE (thread_id, team_member_id)
);

CREATE INDEX idx_mtp_thread  ON public.message_thread_participants (thread_id);
CREATE INDEX idx_mtp_member  ON public.message_thread_participants (team_member_id);

-- ──

CREATE TABLE public.internal_messages (
  id                     uuid   NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  thread_id              uuid   NOT NULL REFERENCES public.message_threads(id) ON DELETE CASCADE,
  sender_team_member_id  text   NOT NULL,
  body                   text   NOT NULL,
  message_kind           text   NOT NULL DEFAULT 'text' CHECK (message_kind IN ('text')),
  created_at             bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint,
  updated_at             bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
);

CREATE INDEX idx_imsg_thread_time
  ON public.internal_messages (thread_id, created_at);

-- ── Row-Level Security ────────────────────────────────────────────────────────

ALTER TABLE public.message_threads              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_thread_participants  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.internal_messages            ENABLE ROW LEVEL SECURITY;

-- ── message_threads ───────────────────────────────────────────────────────────

-- Owner/admin sees all threads for their company.
CREATE POLICY mthread_owner_select ON public.message_threads
  FOR SELECT USING (
    provider_id IN (
      SELECT id FROM public.providers WHERE profile_id = auth.uid()
    )
  );

-- Worker sees threads where they are an active participant in their company.
CREATE POLICY mthread_worker_select ON public.message_threads
  FOR SELECT USING (
    EXISTS (
      SELECT 1
      FROM   public.message_thread_participants mtp
      JOIN   public.team_members tm ON tm.id::text = mtp.team_member_id
      WHERE  mtp.thread_id  = message_threads.id
        AND  mtp.is_active  = true
        AND  tm.profile_id  = auth.uid()
        AND  tm.provider_id = message_threads.provider_id
    )
  );

-- Owner can create threads directly (workers use get_or_create_assignment_thread).
CREATE POLICY mthread_owner_insert ON public.message_threads
  FOR INSERT WITH CHECK (
    provider_id IN (
      SELECT id FROM public.providers WHERE profile_id = auth.uid()
    )
  );

-- Owner can update threads (title, etc.).
CREATE POLICY mthread_owner_update ON public.message_threads
  FOR UPDATE USING (
    provider_id IN (
      SELECT id FROM public.providers WHERE profile_id = auth.uid()
    )
  );

-- ── message_thread_participants ───────────────────────────────────────────────

-- Can see participants of threads you can access (same company, via owner OR participant path).
CREATE POLICY mtp_select ON public.message_thread_participants
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.message_threads mt
      WHERE  mt.id = message_thread_participants.thread_id
        AND (
          -- Owner/admin of this company
          mt.provider_id IN (
            SELECT id FROM public.providers WHERE profile_id = auth.uid()
          )
          OR
          -- Active participant in this thread
          EXISTS (
            SELECT 1
            FROM   public.message_thread_participants mtp2
            JOIN   public.team_members tm ON tm.id::text = mtp2.team_member_id
            WHERE  mtp2.thread_id = mt.id
              AND  mtp2.is_active = true
              AND  tm.profile_id  = auth.uid()
          )
        )
    )
  );

-- Users can update their own participant row (last_read_at).
CREATE POLICY mtp_own_update ON public.message_thread_participants
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.team_members tm
      WHERE tm.id::text = message_thread_participants.team_member_id
        AND tm.profile_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.team_members tm
      WHERE tm.id::text = message_thread_participants.team_member_id
        AND tm.profile_id = auth.uid()
    )
  );

-- ── internal_messages ─────────────────────────────────────────────────────────

-- Owner sees all messages in their company's threads.
CREATE POLICY imsg_owner_select ON public.internal_messages
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.message_threads mt
      WHERE  mt.id = internal_messages.thread_id
        AND  mt.provider_id IN (
          SELECT id FROM public.providers WHERE profile_id = auth.uid()
        )
    )
  );

-- Active participant sees messages in threads they are in.
CREATE POLICY imsg_participant_select ON public.internal_messages
  FOR SELECT USING (
    EXISTS (
      SELECT 1
      FROM   public.message_thread_participants mtp
      JOIN   public.team_members tm ON tm.id::text = mtp.team_member_id
      WHERE  mtp.thread_id = internal_messages.thread_id
        AND  mtp.is_active = true
        AND  tm.profile_id = auth.uid()
    )
  );

-- Active participant can send a message — must send as themselves.
CREATE POLICY imsg_participant_insert ON public.internal_messages
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1
      FROM   public.message_thread_participants mtp
      JOIN   public.team_members tm ON tm.id::text = mtp.team_member_id
      WHERE  mtp.thread_id              = internal_messages.thread_id
        AND  mtp.team_member_id         = internal_messages.sender_team_member_id
        AND  mtp.is_active              = true
        AND  tm.profile_id              = auth.uid()
    )
  );

-- ── Trigger: update thread last_message on new message ───────────────────────
--
-- Runs with SECURITY DEFINER so the UPDATE succeeds even when the INSERT caller
-- is a worker who has no direct UPDATE policy on message_threads.

CREATE OR REPLACE FUNCTION public.fn_update_thread_last_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.message_threads
  SET    last_message_at   = NEW.created_at,
         last_message_body = LEFT(NEW.body, 200),
         updated_at        = NEW.created_at
  WHERE  id = NEW.thread_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_internal_message_last_message
  AFTER INSERT ON public.internal_messages
  FOR EACH ROW EXECUTE FUNCTION public.fn_update_thread_last_message();

-- ── get_or_create_assignment_thread() ────────────────────────────────────────
--
-- Race-safe, idempotent assignment thread resolver.
--
-- Guards:
--   - caller must be a team_member of the calendar_entry's company
--   - raises 'access_denied' if not
--
-- On creation:
--   - adds all calendar_entry.assigned_member_ids as participants
--   - adds all owner/admin team_members of the company as participants
--
-- On re-entry:
--   - ensures caller is a participant (idempotent INSERT ON CONFLICT DO NOTHING)
--
-- Returns the thread UUID.

CREATE OR REPLACE FUNCTION public.get_or_create_assignment_thread(
  p_calendar_entry_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_thread_id       uuid;
  v_provider_id     uuid;
  v_title           text;
  v_caller_id       text;
  v_assigned_ids    text[];
BEGIN
  -- Verify caller is a team member of this calendar entry's company and
  -- resolve their team_member id + the entry's provider + title in one shot.
  SELECT tm.id::text,
         ce.provider_id,
         ce.title,
         ce.assigned_member_ids
  INTO   v_caller_id,
         v_provider_id,
         v_title,
         v_assigned_ids
  FROM   public.calendar_entries ce
  JOIN   public.team_members     tm
    ON   tm.profile_id  = auth.uid()
   AND   tm.provider_id = ce.provider_id
  WHERE  ce.id = p_calendar_entry_id
  LIMIT  1;

  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'access_denied: caller is not a team member of this entry''s company';
  END IF;

  -- Fast path: thread already exists.
  SELECT id INTO v_thread_id
  FROM   public.message_threads
  WHERE  calendar_entry_id = p_calendar_entry_id;

  IF v_thread_id IS NOT NULL THEN
    -- Ensure caller is a participant (safe re-entry).
    INSERT INTO public.message_thread_participants (thread_id, team_member_id)
    VALUES (v_thread_id, v_caller_id)
    ON CONFLICT (thread_id, team_member_id) DO NOTHING;

    RETURN v_thread_id;
  END IF;

  -- Create the thread — ON CONFLICT guards against race with another caller.
  INSERT INTO public.message_threads (
    provider_id,
    thread_type,
    calendar_entry_id,
    created_by_team_member_id,
    title
  )
  VALUES (
    v_provider_id,
    'assignment',
    p_calendar_entry_id,
    v_caller_id,
    v_title
  )
  ON CONFLICT (calendar_entry_id) DO NOTHING
  RETURNING id INTO v_thread_id;

  -- Race: another session won the INSERT; re-fetch.
  IF v_thread_id IS NULL THEN
    SELECT id INTO v_thread_id
    FROM   public.message_threads
    WHERE  calendar_entry_id = p_calendar_entry_id;
  END IF;

  -- Seed participants: all assigned workers.
  IF v_assigned_ids IS NOT NULL AND array_length(v_assigned_ids, 1) > 0 THEN
    INSERT INTO public.message_thread_participants (thread_id, team_member_id)
    SELECT v_thread_id, unnest(v_assigned_ids)
    ON CONFLICT (thread_id, team_member_id) DO NOTHING;
  END IF;

  -- Seed participants: all owner/admin team members of the company.
  INSERT INTO public.message_thread_participants (thread_id, team_member_id)
  SELECT v_thread_id, tm.id::text
  FROM   public.team_members tm
  WHERE  tm.provider_id = v_provider_id
    AND  tm.role IN ('owner', 'admin')
  ON CONFLICT (thread_id, team_member_id) DO NOTHING;

  RETURN v_thread_id;
END;
$$;
