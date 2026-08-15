-- Spatial Core · Phase 2 Post-Review Hotfix · LIVE PROD BUGS
--
-- Discovered during the hard-review of PR #931's stack (4 parallele Subagents
-- against Phase-1 base + #928 Block-J compliance + #927 Block-I download).
-- All four bugs below are LIVE in prod because migrations 20260518000061,
-- 20260518000070, 20260518000072 were applied via MCP at the time but contain
-- compile-time / runtime errors that only surface on actual call paths.
--
-- ## L1 — record_scan_event arity (request_scan_download, resign_download_url)
-- Both functions PERFORM `record_scan_event(uuid, action, jsonb, uuid, uuid)`
-- with 5 args; the canonical signature (migration 20260518000006) is 4 args
-- `(p_scan_id, p_action, p_payload, p_idempotency_key)`. Postgres raises
-- `42883 function does not exist` and the whole RPC aborts. Effect: every
-- customer download click + every signed-URL refresh returns 500.
-- Fix: drop the trailing `v_uid`; actor is captured via auth.uid() inside.
--
-- ## L2 — extensions.http_post does not exist (spatial_notify_convert_done)
-- Trigger calls `extensions.http_post(url, body, headers::text)` but the
-- extension is not installed; only `net.http_post(url, body jsonb, params
-- jsonb, headers jsonb, timeout_milliseconds int)` exists. Every glTF
-- INSERT into scan_assets aborts → rollback → Webansicht never appears.
-- Fix: rewrite using `net.http_post` with jsonb body + headers + named args.
--
-- ## L4 — anon-callable SECURITY DEFINER funcs missed by "lockdown" mig 61
-- prod ACL probe confirmed PUBLIC `=X/postgres` still present on
-- request_scan_download + spatial_notify_convert_done, and anon `=X/postgres`
-- on resign_download_url. Migration 20260518000061 misses all three.
-- Fix: explicit REVOKE EXECUTE FROM PUBLIC, anon (+ GRANT to authenticated
-- where the function is intended to be user-callable).
--
-- Note on L3 (notification_signals schema mismatch in edge function): that
-- lives in `supabase/functions/spatial-convert-done-push/index.ts` and is
-- patched in the same commit via a redeploy; no schema work needed here
-- because the prod `notification_signals` schema is already correct (the
-- bug was in the FUNCTION's INSERT statement using wrong column names).
--
-- ## Hardening
-- All three functions keep their SECURITY DEFINER + SET search_path discipline.
-- record_scan_event guards (auth.uid() + spatial_can_view_scan) are intact
-- because we don't touch them; we just align the arity in the callers.

-- ────────────────────────────────────────────────────────────────────────────
-- L1.a — request_scan_download: fix record_scan_event 5-arg → 4-arg call

CREATE OR REPLACE FUNCTION public.request_scan_download(p_scan_id uuid, p_kind text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id  uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '28000';
  END IF;
  IF NOT public.spatial_can_view_scan(p_scan_id, v_uid) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('pdf_report','floorplan_svg','mesh_summary_json') THEN
    RAISE EXCEPTION 'invalid download kind: %', p_kind USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.download_jobs (scan_id, requested_by, kind)
  VALUES (p_scan_id, v_uid, p_kind)
  RETURNING id INTO v_id;
  PERFORM pg_notify('download_jobs', v_id::text);
  -- L1 fix: drop trailing v_uid — record_scan_event signature is 4 args.
  -- The function reads auth.uid() itself, so omitting the explicit actor
  -- arg is semantically identical (and was the original intent).
  PERFORM public.record_scan_event(
    p_scan_id,
    'download_requested'::public.scan_event_action,
    jsonb_build_object('download_job_id', v_id, 'kind', p_kind),
    NULL
  );
  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.request_scan_download(uuid, text) IS
  'Phase 2 hotfix 2026-05-20: arity-fix for record_scan_event (5→4 args). Customer-callable RPC for PDF/SVG/JSON exports; gated by spatial_can_view_scan.';

-- ────────────────────────────────────────────────────────────────────────────
-- L1.b — resign_download_url: same arity fix

CREATE OR REPLACE FUNCTION public.resign_download_url(p_job_id uuid)
RETURNS public.download_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_job public.download_jobs;
  v_recent_count int;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_job
  FROM public.download_jobs
  WHERE id = p_job_id AND requested_by = v_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  -- Rate-limit: 5 resigns per hour per (scan, job, user, phase='resign').
  SELECT count(*) INTO v_recent_count
  FROM public.scan_events
  WHERE scan_id = v_job.scan_id
    AND action  = 'download_requested'::public.scan_event_action
    AND actor_id = v_uid
    AND occurred_at > now() - interval '1 hour'
    AND payload ->> 'phase' = 'resign'
    AND (payload ->> 'download_job_id')::uuid = p_job_id;
  IF v_recent_count >= 5 THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = '54000';
  END IF;
  UPDATE public.download_jobs
  SET expires_at = now() + interval '15 minutes'
  WHERE id = p_job_id
  RETURNING * INTO v_job;
  -- L1 fix: drop trailing v_uid arg.
  PERFORM public.record_scan_event(
    v_job.scan_id,
    'download_requested'::public.scan_event_action,
    jsonb_build_object('phase', 'resign', 'download_job_id', p_job_id),
    NULL
  );
  RETURN v_job;
END;
$$;

COMMENT ON FUNCTION public.resign_download_url(uuid) IS
  'Phase 2 hotfix 2026-05-20: arity-fix for record_scan_event (5→4 args). Refresh expiring signed download URLs; 5/hr rate limit per (scan, job, user).';

-- ────────────────────────────────────────────────────────────────────────────
-- L2 — spatial_notify_convert_done: extensions.http_post → net.http_post

CREATE OR REPLACE FUNCTION public.spatial_notify_convert_done()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, vault
AS $$
DECLARE
  v_user_id   uuid;
  v_url       text;
  v_secret    text;
  v_body      jsonb;
  v_signature text;
BEGIN
  IF NEW.kind <> 'gltf' THEN RETURN NEW; END IF;

  SELECT s.captured_by INTO v_user_id
  FROM public.scans s
  WHERE s.id = NEW.scan_id;

  IF v_user_id IS NULL THEN RETURN NEW; END IF;

  SELECT decrypted_secret INTO v_url
  FROM vault.decrypted_secrets
  WHERE name = 'spatial_convert_done_push.url';

  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = 'spatial_convert_done_push.shared_secret';

  IF v_url IS NULL OR v_secret IS NULL THEN
    RAISE NOTICE 'spatial_notify_convert_done: vault config missing, skipping';
    RETURN NEW;
  END IF;

  v_body := jsonb_build_object(
    'scan_id',  NEW.scan_id,
    'asset_id', NEW.id,
    'user_id',  v_user_id
  );

  -- HMAC over the JSON-serialised body. The Edge Function recomputes the
  -- same hex digest from the request body bytes; bytea ordering matters,
  -- so we materialise the jsonb to text once and hash THAT exact form.
  v_signature := encode(
    extensions.hmac(v_body::text::bytea, v_secret::bytea, 'sha256'),
    'hex'
  );

  -- L2 fix: net.http_post is the correct extension. Signature is
  -- (url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds int).
  -- Named-arg call skips the params slot. timeout left at default.
  PERFORM net.http_post(
    url     := v_url,
    body    := v_body,
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-spatial-convert-signature', v_signature
    )
  );

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.spatial_notify_convert_done() IS
  'Phase 2 hotfix 2026-05-20: extensions.http_post → net.http_post (extension not installed). Trigger fires on scan_assets INSERT WHERE kind=gltf; HMAC-signed POST to edge function via vault-secret URL.';

-- ────────────────────────────────────────────────────────────────────────────
-- L4 — REVOKE PUBLIC + anon from the three SECURITY DEFINER RPCs

-- request_scan_download — authenticated only.
REVOKE EXECUTE ON FUNCTION public.request_scan_download(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.request_scan_download(uuid, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.request_scan_download(uuid, text) TO authenticated;

-- resign_download_url — authenticated only.
REVOKE EXECUTE ON FUNCTION public.resign_download_url(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.resign_download_url(uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.resign_download_url(uuid) TO authenticated;

-- spatial_notify_convert_done — trigger function, no direct caller needed.
-- Defense-in-depth: revoke EXECUTE from everyone non-postgres; the trigger
-- itself runs as table owner per Postgres trigger semantics.
REVOKE EXECUTE ON FUNCTION public.spatial_notify_convert_done() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.spatial_notify_convert_done() FROM anon;
REVOKE EXECUTE ON FUNCTION public.spatial_notify_convert_done() FROM authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- Rollback
-- The buggy bodies live in 20260518000070 (push trigger) and 20260518000072
-- (download RPCs). Re-applying those files reverts the bodies; the REVOKEs
-- above would need a manual GRANT back to PUBLIC (don't — that's the bug
-- this migration fixes).
