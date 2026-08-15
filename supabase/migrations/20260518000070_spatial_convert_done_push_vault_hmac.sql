-- Spatial Core · Block J post-review hotfix · Convert-Done-Push Trigger HMAC
--
-- Replaces the previous GUC-based pattern (`current_setting('app.*', true)`)
-- with `vault.decrypted_secrets` + HMAC-SHA256 signature.
--
-- Why this change:
--  * GUCs require superuser to set via `ALTER DATABASE`, which the Supabase
--    MCP role cannot do (`42501 permission denied`). Vault rows can be
--    managed via MCP.
--  * The previous pattern passed the service-role-key in a pg_net header.
--    `net.http_request_queue` stores headers in plaintext — anyone with
--    SELECT on `net.*` could read the root key.
--
-- New pattern:
--  * Vault rows `spatial_convert_done_push.url` and `.shared_secret` hold
--    config; both are created out-of-band (see Block J fix handover).
--  * Trigger HMAC-signs the payload with the shared secret and posts it.
--  * Edge function reads the same vault row via a SECURITY DEFINER RPC
--    that is locked to `service_role` only.
--  * vault.decrypted_secrets is NOT exposed via REST/PostgREST schema;
--    edge function uses the locked RPC instead of direct schema access.

-- ─── Trigger ──────────────────────────────────────────────────────────────

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
  v_body      text;
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
  )::text;

  v_signature := encode(
    extensions.hmac(v_body::bytea, v_secret::bytea, 'sha256'),
    'hex'
  );

  PERFORM extensions.http_post(
    url     := v_url,
    body    := v_body,
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-spatial-convert-signature', v_signature
    )::text
  );

  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.spatial_notify_convert_done IS
  'Block J hotfix — Fires spatial-convert-done-push Edge Function on glTF asset INSERT. Uses vault.decrypted_secrets (spatial_convert_done_push.url + .shared_secret) and HMAC-SHA256 signature. Missing vault rows = silent no-op.';

DROP TRIGGER IF EXISTS spatial_notify_convert_done_trg ON public.scan_assets;
CREATE TRIGGER spatial_notify_convert_done_trg
AFTER INSERT ON public.scan_assets
FOR EACH ROW
WHEN (NEW.kind = 'gltf')
EXECUTE FUNCTION public.spatial_notify_convert_done();

-- ─── Edge-Function-side secret accessor ───────────────────────────────────
-- Locked to service_role; the convert-done-push edge function reads the
-- shared secret via this RPC to verify incoming trigger payloads.
CREATE OR REPLACE FUNCTION public.spatial_get_convert_push_secret()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = vault, public
AS $$
  SELECT decrypted_secret
  FROM vault.decrypted_secrets
  WHERE name = 'spatial_convert_done_push.shared_secret'
  LIMIT 1
$$;

REVOKE EXECUTE ON FUNCTION public.spatial_get_convert_push_secret() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.spatial_get_convert_push_secret() TO service_role;

COMMENT ON FUNCTION public.spatial_get_convert_push_secret IS
  'Block J hotfix — Returns the HMAC shared secret for the spatial-convert-done-push edge function. service_role only; anon/authenticated REVOKED.';
