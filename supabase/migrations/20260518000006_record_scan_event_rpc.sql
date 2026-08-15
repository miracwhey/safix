-- Spatial Core · Block A.1 · record_scan_event RPC
--
-- SECURITY DEFINER RPC for append-only writes to public.scan_events. Block A
-- shipped the table with RLS deny-all-writes + REVOKE INSERT, so until this
-- migration there is no path for app-code to write audit rows. This RPC closes
-- that gap with hardening:
--
--   * Idempotency: optional UUID key, partial UNIQUE index on
--     (scan_id, idempotency_key) WHERE idempotency_key IS NOT NULL. A second
--     call with the same (scan_id, key) returns the prior row instead of
--     inserting again (retry-safe under network glitches).
--   * Authorization: SECURITY INVOKER-equivalent semantics via
--     `spatial_can_view_scan(p_scan_id, auth.uid())` gate inside the function.
--     SECURITY DEFINER is needed to bypass the deny-all RLS on writes; the
--     viewer check restores RLS-equivalent access control.
--   * Payload size cap: 64 KiB. Larger payloads suggest blob storage paths
--     belong in a different table — keep audit row payloads small + indexable.
--   * Action validation: column is `public.scan_event_action` enum, so an
--     invalid action raises `invalid_text_representation` automatically.
--   * Actor: derived from `auth.uid()` server-side — clients can never spoof.
--   * Search path: pg_catalog first to defend against schema-shadow attacks.

-- ── 1. Partial UNIQUE index for idempotency ──────────────────────────────────
-- Column does not exist on scan_events yet; add as nullable.
ALTER TABLE public.scan_events
  ADD COLUMN IF NOT EXISTS idempotency_key uuid;

CREATE UNIQUE INDEX IF NOT EXISTS scan_events_idempotency_key_uidx
  ON public.scan_events (scan_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN public.scan_events.idempotency_key
  IS 'Optional client-supplied UUID for retry-safety on record_scan_event RPC. Partial unique with scan_id.';

-- ── 2. RPC ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_scan_event(
  p_scan_id         uuid,
  p_action          public.scan_event_action,
  p_payload         jsonb DEFAULT '{}'::jsonb,
  p_idempotency_key uuid  DEFAULT NULL
)
RETURNS public.scan_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor   uuid := auth.uid();
  v_payload jsonb := COALESCE(p_payload, '{}'::jsonb);
  v_row     public.scan_events;
  v_size    int;
BEGIN
  -- Authn gate: only authenticated callers. auth.uid() is NULL for anon.
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'record_scan_event: authentication required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Authz gate: caller must be a viewer of the scan.
  IF NOT public.spatial_can_view_scan(p_scan_id, v_actor) THEN
    RAISE EXCEPTION 'record_scan_event: not permitted on scan %', p_scan_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Payload-size guardrail: 64 KiB. octet_length on a jsonb is its text form
  -- after compression-naive serialization — close enough to wire-size to
  -- catch the "client dumped a base64 image into audit payload" case.
  v_size := octet_length(v_payload::text);
  IF v_size > 65536 THEN
    RAISE EXCEPTION 'record_scan_event: payload too large (% bytes, max 65536)', v_size
      USING ERRCODE = 'program_limit_exceeded',
            HINT    = 'Store large blobs in scan_assets and reference by storage_path in payload.';
  END IF;

  -- Idempotent insert: ON CONFLICT noop, then re-read for return.
  INSERT INTO public.scan_events (scan_id, actor_id, action, payload, idempotency_key)
  VALUES (p_scan_id, v_actor, p_action, v_payload, p_idempotency_key)
  ON CONFLICT (scan_id, idempotency_key) DO NOTHING
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    -- Conflict path: the existing row wins. Use the idempotency_key index lookup.
    SELECT * INTO v_row
    FROM public.scan_events
    WHERE scan_id = p_scan_id
      AND idempotency_key = p_idempotency_key
    ORDER BY at ASC
    LIMIT 1;
  END IF;

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION public.record_scan_event(uuid, public.scan_event_action, jsonb, uuid)
  IS 'Spatial Core: append a scan audit event (RLS-bypassing via SECURITY DEFINER, but inner spatial_can_view_scan gate enforces authorization). Idempotent on (scan_id, idempotency_key). 64 KiB payload cap.';

REVOKE EXECUTE ON FUNCTION public.record_scan_event(uuid, public.scan_event_action, jsonb, uuid)
  FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.record_scan_event(uuid, public.scan_event_action, jsonb, uuid)
  TO authenticated;

-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP FUNCTION IF EXISTS public.record_scan_event(uuid, public.scan_event_action, jsonb, uuid);
-- DROP INDEX    IF EXISTS public.scan_events_idempotency_key_uidx;
-- ALTER TABLE   public.scan_events DROP COLUMN IF EXISTS idempotency_key;
