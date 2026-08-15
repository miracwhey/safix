-- ===========================================================================
-- Moderation enforcement (Apple 1.2 UGC takedown) — C2, REWORKED.
--
-- APPLY HELD: run only after explicit "ja apply" (Supabase MCP apply_migration).
-- Authored from PROD-truth recon (project itdntawwuzqfwmcwnwjr), NOT from the
-- repo migration ledger. Corrects all 7 RLS-review footguns + 1 recon gap of the
-- original spec draft:
--   C2-1 is_caller_moderation_write_allowed() is fail-CLOSED + row-scoped.
--   C2-2 chat_messages INSERT policy preserves the VERBATIM prod predicate
--        (left_at IS NULL + NOT(customer&&worker) + (SELECT auth.uid())) and only
--        APPENDS the moderation gate.
--   C2-3 ZERO references to the frozen legacy public.messages table.
--   C2-4 user_reports.status CHECK added; RPC writes the established vocabulary
--        ('actioned' / 'dismissed').
--   C2-5 hide_content UPDATE is row-scoped (id + sender_user_id) and RAISEs on 0 rows.
--   C2-6 moderation_action_log REVOKEs writes from PUBLIC, anon, authenticated and
--        GRANTs SELECT to authenticated.
--   C2-7 _assert_caller_is_operator() is fail-CLOSED (RAISE on NULL uid).
--   recon profiles.moderation_state / suspension_expires_at did NOT exist — created here.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. profiles: moderation state columns (did not exist in prod)
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS moderation_state      text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS suspension_expires_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.profiles'::regclass
      AND conname = 'profiles_moderation_state_chk'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_moderation_state_chk
      CHECK (moderation_state IN ('active', 'suspended', 'banned'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_profiles_moderation_state
  ON public.profiles (moderation_state)
  WHERE moderation_state <> 'active';

COMMENT ON COLUMN public.profiles.moderation_state IS
  'Operator-set moderation state. active (default) | suspended (timed) | banned (permanent). Enforced fail-closed via is_caller_moderation_write_allowed() on write surfaces.';
COMMENT ON COLUMN public.profiles.suspension_expires_at IS
  'NULL for bans and active users; set for timed suspensions. A suspension is treated as expired (writes allowed again) once now() > suspension_expires_at.';

-- ---------------------------------------------------------------------------
-- 2. is_caller_moderation_write_allowed() — FAIL-CLOSED, row-scoped (C2-1)
--    Returns TRUE only when the CALLER'S OWN profile is not in a blocking state.
--    NOT EXISTS(blocked) form so a banned/suspended user can never write, and the
--    predicate is scoped to p.id = auth.uid() (no cross-row operator-precedence leak).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_caller_moderation_write_allowed()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid()
      AND (
        p.moderation_state = 'banned'
        OR (
          p.moderation_state = 'suspended'
          AND (p.suspension_expires_at IS NULL OR p.suspension_expires_at > now())
        )
      )
  );
$$;

-- REVOKE from anon too: Supabase default privileges auto-grant EXECUTE to anon on
-- CREATE, and REVOKE FROM PUBLIC alone does not remove that explicit role grant.
REVOKE EXECUTE ON FUNCTION public.is_caller_moderation_write_allowed() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.is_caller_moderation_write_allowed() TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. _assert_caller_is_operator() — FAIL-CLOSED on NULL uid (C2-7)
--    Replaces the prod body which did `RETURN NULL` on NULL uid (fail-open).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._assert_caller_is_operator()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'operator_required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_current_user_operator() THEN
    RAISE EXCEPTION 'operator_required' USING ERRCODE = '42501';
  END IF;

  RETURN v_uid;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. chat_messages INSERT policy — preserve VERBATIM prod predicate, APPEND gate (C2-2)
--    Verbatim WITH CHECK from prod (20260513000001): sender match + participant
--    EXISTS with left_at IS NULL + customer/worker channel isolation + (SELECT auth.uid()).
--    Only `AND is_caller_moderation_write_allowed()` is appended. Name preserved.
--    NO legacy public.messages handling (C2-3).
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS chat_messages_insert_participant ON public.chat_messages;

CREATE POLICY chat_messages_insert_participant ON public.chat_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    (sender_user_id = (SELECT auth.uid()))
    AND (EXISTS (
      SELECT 1
      FROM (public.chat_participants cp
        JOIN public.chat_threads ct ON ((ct.id = cp.thread_id)))
      WHERE ((cp.thread_id = chat_messages.thread_id)
        AND (cp.user_id = (SELECT auth.uid()))
        AND (cp.left_at IS NULL)
        AND (NOT ((ct.channel_type = 'customer'::text) AND (cp.role = 'worker'::text))))
    ))
    AND public.is_caller_moderation_write_allowed()
  );

-- ---------------------------------------------------------------------------
-- 5. user_reports.status CHECK (C2-4)
--    Established domain vocabulary. Table currently has only default 'pending'.
--    Two terminal close states coexist by design:
--      'actioned'  — enforcement taken via operator_enforce_report() (warn/suspend/ban/hide).
--      'dismissed' — report rejected, no action.
--      'resolved'  — manual operator triage-close (no enforcement); written by the
--                    OperatorReportsPanel 'Gelöst' button via resolveReport().
--    'reviewed' is the in-progress triage state. 'resolved' MUST stay in the set or
--    the shipped panel's 'Gelöst' write throws 23514. (0 existing rows → no backfill.)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.user_reports'::regclass
      AND conname = 'user_reports_status_chk'
  ) THEN
    ALTER TABLE public.user_reports
      ADD CONSTRAINT user_reports_status_chk
      CHECK (status IN ('pending', 'reviewed', 'resolved', 'dismissed', 'actioned'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. moderation_action_log — append-only audit table (C2-6)
--    Writes ONLY via operator_enforce_report() (SECURITY DEFINER bypasses RLS).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.moderation_action_log (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id        uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  report_id          uuid        NOT NULL REFERENCES public.user_reports(id) ON DELETE RESTRICT,
  action_type        text        NOT NULL,
  target_user_id     uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  target_entity_type text,
  target_entity_id   text,
  notes              text,
  suspension_until   timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.moderation_action_log'::regclass
      AND conname = 'moderation_action_log_action_type_check'
  ) THEN
    ALTER TABLE public.moderation_action_log
      ADD CONSTRAINT moderation_action_log_action_type_check
      CHECK (action_type IN ('warn', 'hide_content', 'suspend', 'ban', 'dismiss'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_moderation_action_log_report
  ON public.moderation_action_log (report_id);
CREATE INDEX IF NOT EXISTS idx_moderation_action_log_target_user
  ON public.moderation_action_log (target_user_id);
CREATE INDEX IF NOT EXISTS idx_moderation_action_log_operator
  ON public.moderation_action_log (operator_id);
CREATE INDEX IF NOT EXISTS idx_moderation_action_log_created_at
  ON public.moderation_action_log (created_at);

COMMENT ON TABLE public.moderation_action_log IS
  'Append-only audit of every enforcement action. Writes only via operator_enforce_report() SECURITY DEFINER RPC.';

ALTER TABLE public.moderation_action_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS moderation_action_log_operators_select ON public.moderation_action_log;
CREATE POLICY moderation_action_log_operators_select
  ON public.moderation_action_log FOR SELECT
  USING (public.is_current_user_operator());

-- No application write policy — inserts exclusively via the SECDEF RPC.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON public.moderation_action_log
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.moderation_action_log TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. operator_enforce_report() — SECURITY DEFINER enforcement RPC
--    Single atomic entrypoint. Corrected: row-scoped hide_content (C2-5), no
--    legacy message branch / param (C2-3), no non-existent profiles columns,
--    status from the established vocabulary (C2-4).
--
--    p_action:            'warn' | 'hide_content' | 'suspend' | 'ban' | 'dismiss'
--    p_report_id:         uuid of the user_reports row
--    p_target_user_id:    uuid of the user being actioned (must match report.reported_id)
--    p_notes:             operator-visible notes
--    p_suspend_hours:     for 'suspend' — duration in hours (> 0)
--    p_target_message_id: for 'hide_content' — uuid of the chat_messages row
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.operator_enforce_report(
  p_action            text,
  p_report_id         uuid,
  p_target_user_id    uuid,
  p_notes             text    DEFAULT NULL,
  p_suspend_hours     integer DEFAULT NULL,
  p_target_message_id uuid    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operator_id        uuid;
  v_now                timestamptz := now();
  v_expires_at         timestamptz;
  v_new_report_status  text;
  v_target_entity_type text := NULL;
  v_target_entity_id   text := NULL;
BEGIN
  -- 1. Auth gate (raises 42501 on NULL uid or non-operator)
  v_operator_id := public._assert_caller_is_operator();

  -- 2. Validate action
  IF p_action NOT IN ('warn', 'hide_content', 'suspend', 'ban', 'dismiss') THEN
    RAISE EXCEPTION 'invalid_argument: unknown action %', p_action USING ERRCODE = 'P0001';
  END IF;

  -- 3. Validate report exists and the target matches the report's reported_id
  IF NOT EXISTS (
    SELECT 1 FROM public.user_reports
    WHERE id = p_report_id AND reported_id = p_target_user_id
  ) THEN
    RAISE EXCEPTION 'invalid_argument: report % not found or target mismatch', p_report_id
      USING ERRCODE = 'P0001';
  END IF;

  -- 4. Apply enforcement
  IF p_action = 'suspend' THEN
    IF p_suspend_hours IS NULL OR p_suspend_hours <= 0 THEN
      RAISE EXCEPTION 'invalid_argument: suspend requires p_suspend_hours > 0' USING ERRCODE = 'P0001';
    END IF;
    v_expires_at := v_now + (p_suspend_hours * interval '1 hour');
    UPDATE public.profiles
      SET moderation_state = 'suspended', suspension_expires_at = v_expires_at
      WHERE id = p_target_user_id;
    v_new_report_status := 'actioned';

  ELSIF p_action = 'ban' THEN
    UPDATE public.profiles
      SET moderation_state = 'banned', suspension_expires_at = NULL
      WHERE id = p_target_user_id;
    v_new_report_status := 'actioned';

  ELSIF p_action = 'warn' THEN
    v_new_report_status := 'actioned';

  ELSIF p_action = 'hide_content' THEN
    IF p_target_message_id IS NULL THEN
      RAISE EXCEPTION 'invalid_argument: hide_content requires p_target_message_id' USING ERRCODE = 'P0001';
    END IF;
    -- Row-scoped redaction (C2-5): only the target message, only if authored by the target.
    UPDATE public.chat_messages
      SET deleted_at      = public.epoch_ms(),
          redacted        = true,
          redacted_at     = public.epoch_ms(),
          redacted_reason = COALESCE(p_notes, 'operator_moderation')
      WHERE id = p_target_message_id
        AND sender_user_id = p_target_user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid_argument: message % not found or not authored by target', p_target_message_id
        USING ERRCODE = 'P0001';
    END IF;
    v_target_entity_type := 'chat_message';
    v_target_entity_id   := p_target_message_id::text;
    v_new_report_status  := 'actioned';

  ELSIF p_action = 'dismiss' THEN
    v_new_report_status := 'dismissed';
  END IF;

  -- 5. Update the report
  UPDATE public.user_reports
    SET status         = v_new_report_status,
        reviewed_by    = v_operator_id,
        reviewed_at    = v_now,
        operator_notes = COALESCE(p_notes, operator_notes)
    WHERE id = p_report_id;

  -- 6. Append audit (direct INSERT OK: SECDEF bypasses the REVOKE)
  INSERT INTO public.moderation_action_log (
    operator_id, report_id, action_type, target_user_id,
    target_entity_type, target_entity_id, notes, suspension_until, created_at
  ) VALUES (
    v_operator_id, p_report_id, p_action, p_target_user_id,
    v_target_entity_type, v_target_entity_id, p_notes, v_expires_at, v_now
  );

  RETURN jsonb_build_object(
    'ok', true,
    'action', p_action,
    'report_status', v_new_report_status,
    'expires_at', v_expires_at
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.operator_enforce_report(text, uuid, uuid, text, integer, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.operator_enforce_report(text, uuid, uuid, text, integer, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 8. Reload PostgREST schema cache so the new RPC + columns are visible.
-- ---------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
