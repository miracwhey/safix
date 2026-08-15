-- Spatial Core · Block J (G follow-up) · Push trigger for convert-done
--
-- Wires `scan_assets` INSERT (kind = 'gltf') to the
-- `spatial-convert-done-push` Edge Function via pg_net. Lands here so
-- Block J ships compliance + plumbing together — the Edge Function
-- itself is in `supabase/functions/spatial-convert-done-push`.
--
-- Idempotent: re-runs are safe (DROP TRIGGER IF EXISTS + CREATE).

CREATE OR REPLACE FUNCTION public.spatial_notify_convert_done()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_user_id uuid;
  v_url     text;
  v_key     text;
BEGIN
  IF NEW.kind <> 'gltf' THEN RETURN NEW; END IF;

  -- The owning user is `captured_by` on the parent scan row.
  SELECT s.captured_by INTO v_user_id
  FROM public.scans s
  WHERE s.id = NEW.scan_id;

  IF v_user_id IS NULL THEN RETURN NEW; END IF;

  v_url := current_setting('app.spatial_convert_push_url', true);
  v_key := current_setting('app.supabase_service_role_key', true);

  -- Settings missing: skip silently. The trigger should never block
  -- the insert because of a missing config; the push is best-effort.
  IF v_url IS NULL OR v_key IS NULL THEN RETURN NEW; END IF;

  PERFORM extensions.http_post(
    url := v_url,
    body := jsonb_build_object(
      'scan_id', NEW.scan_id,
      'asset_id', NEW.id,
      'user_id', v_user_id
    )::text,
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'authorization', 'Bearer ' || v_key
    )::text
  );

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS spatial_notify_convert_done_trg ON public.scan_assets;
CREATE TRIGGER spatial_notify_convert_done_trg
AFTER INSERT ON public.scan_assets
FOR EACH ROW
WHEN (NEW.kind = 'gltf')
EXECUTE FUNCTION public.spatial_notify_convert_done();

COMMENT ON FUNCTION public.spatial_notify_convert_done IS
  'Block J — Fires spatial-convert-done-push Edge Function on glTF asset INSERT. Requires app.spatial_convert_push_url + app.supabase_service_role_key GUCs; otherwise silent no-op.';
