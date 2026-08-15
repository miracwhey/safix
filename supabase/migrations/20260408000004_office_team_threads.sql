-- =============================================================================
-- Migration: Office and Team Thread Singletons
-- =============================================================================
-- Purpose:
--   Makes office and team threads real, company-scoped singletons:
--     - Partial unique index: one office thread and one team thread per provider
--     - get_or_create_office_thread() — SECURITY DEFINER, race-safe, idempotent
--     - get_or_create_team_thread()  — SECURITY DEFINER, race-safe, idempotent
--
-- Thread identity model:
--   One office thread per company.
--   One team thread per company.
--   Enforced via partial unique index on (provider_id, thread_type).
--
-- Participant model:
--   Both office and team threads seed ALL team_members of the company.
--   Owner/admin participation is intentionally included in both types:
--   FixUp companies are small; the owner coordinates with the whole team.
--
-- Prerequisite: 20260408000003_internal_messages.sql must be applied first.
-- =============================================================================

-- One office thread and one team thread per company.
-- The existing uq_assignment_thread covers calendar_entry_id uniqueness; this
-- partial index covers the office/team singleton constraint independently.
CREATE UNIQUE INDEX uq_office_team_threads
  ON public.message_threads (provider_id, thread_type)
  WHERE thread_type IN ('office', 'team');

-- ── get_or_create_office_thread() ────────────────────────────────────────────
--
-- Race-safe, idempotent office thread resolver.
--
-- Guards:
--   - caller must have a team_members row (i.e. is a member of some company)
--   - raises 'access_denied' if not
--
-- On creation:
--   - seeds ALL team_members of the company as participants
--
-- On re-entry:
--   - ensures caller is a participant (idempotent INSERT ON CONFLICT DO NOTHING)
--
-- Returns the thread UUID.

CREATE OR REPLACE FUNCTION public.get_or_create_office_thread()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_thread_id   uuid;
  v_provider_id uuid;
  v_caller_id   text;
BEGIN
  -- Resolve caller's team member identity and company.
  SELECT tm.id::text, tm.provider_id
  INTO   v_caller_id, v_provider_id
  FROM   public.team_members tm
  WHERE  tm.profile_id = auth.uid()
  LIMIT  1;

  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'access_denied: caller has no team_member row';
  END IF;

  -- Fast path: office thread already exists for this company.
  SELECT id INTO v_thread_id
  FROM   public.message_threads
  WHERE  provider_id = v_provider_id
    AND  thread_type = 'office';

  IF v_thread_id IS NOT NULL THEN
    -- Ensure caller is a participant (idempotent re-entry).
    INSERT INTO public.message_thread_participants (thread_id, team_member_id)
    VALUES (v_thread_id, v_caller_id)
    ON CONFLICT (thread_id, team_member_id) DO NOTHING;

    RETURN v_thread_id;
  END IF;

  -- Create the singleton office thread.
  -- ON CONFLICT guards against a race with another simultaneous caller.
  INSERT INTO public.message_threads (
    provider_id,
    thread_type,
    created_by_team_member_id,
    title
  )
  VALUES (
    v_provider_id,
    'office',
    v_caller_id,
    'Büro'
  )
  ON CONFLICT (provider_id, thread_type) WHERE thread_type IN ('office', 'team') DO NOTHING
  RETURNING id INTO v_thread_id;

  -- Race: another session won the INSERT; re-fetch.
  IF v_thread_id IS NULL THEN
    SELECT id INTO v_thread_id
    FROM   public.message_threads
    WHERE  provider_id = v_provider_id
      AND  thread_type = 'office';
  END IF;

  -- Seed ALL company team members as participants.
  INSERT INTO public.message_thread_participants (thread_id, team_member_id)
  SELECT v_thread_id, tm.id::text
  FROM   public.team_members tm
  WHERE  tm.provider_id = v_provider_id
  ON CONFLICT (thread_id, team_member_id) DO NOTHING;

  RETURN v_thread_id;
END;
$$;

-- ── get_or_create_team_thread() ──────────────────────────────────────────────
--
-- Race-safe, idempotent team thread resolver.
-- Identical structure to get_or_create_office_thread; thread_type = 'team'.
--
-- Participant model: ALL team_members of the company (workers + owner/admin).
-- Owner/admin participation is intentional — they coordinate with the team.
--
-- Returns the thread UUID.

CREATE OR REPLACE FUNCTION public.get_or_create_team_thread()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_thread_id   uuid;
  v_provider_id uuid;
  v_caller_id   text;
BEGIN
  -- Resolve caller's team member identity and company.
  SELECT tm.id::text, tm.provider_id
  INTO   v_caller_id, v_provider_id
  FROM   public.team_members tm
  WHERE  tm.profile_id = auth.uid()
  LIMIT  1;

  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'access_denied: caller has no team_member row';
  END IF;

  -- Fast path: team thread already exists for this company.
  SELECT id INTO v_thread_id
  FROM   public.message_threads
  WHERE  provider_id = v_provider_id
    AND  thread_type = 'team';

  IF v_thread_id IS NOT NULL THEN
    -- Ensure caller is a participant (idempotent re-entry).
    INSERT INTO public.message_thread_participants (thread_id, team_member_id)
    VALUES (v_thread_id, v_caller_id)
    ON CONFLICT (thread_id, team_member_id) DO NOTHING;

    RETURN v_thread_id;
  END IF;

  -- Create the singleton team thread.
  INSERT INTO public.message_threads (
    provider_id,
    thread_type,
    created_by_team_member_id,
    title
  )
  VALUES (
    v_provider_id,
    'team',
    v_caller_id,
    'Team'
  )
  ON CONFLICT (provider_id, thread_type) WHERE thread_type IN ('office', 'team') DO NOTHING
  RETURNING id INTO v_thread_id;

  -- Race: another session won the INSERT; re-fetch.
  IF v_thread_id IS NULL THEN
    SELECT id INTO v_thread_id
    FROM   public.message_threads
    WHERE  provider_id = v_provider_id
      AND  thread_type = 'team';
  END IF;

  -- Seed ALL company team members as participants.
  -- Owner/admin is intentionally included.
  INSERT INTO public.message_thread_participants (thread_id, team_member_id)
  SELECT v_thread_id, tm.id::text
  FROM   public.team_members tm
  WHERE  tm.provider_id = v_provider_id
  ON CONFLICT (thread_id, team_member_id) DO NOTHING;

  RETURN v_thread_id;
END;
$$;
