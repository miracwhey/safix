-- Spatial Core · Block A · Post-apply hotfix
-- Adds SET search_path = public to spatial_dispute_lock_guard().
-- (Helper functions in the rls migration already had it; trigger function was missed.)

CREATE OR REPLACE FUNCTION public.spatial_dispute_lock_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_scan_id uuid;
  v_uid     uuid;
BEGIN
  v_uid := auth.uid();

  IF TG_TABLE_NAME = 'scans' THEN
    v_scan_id := COALESCE(NEW.id, OLD.id);
    IF TG_OP = 'UPDATE'
       AND OLD.status = 'locked_for_dispute'
       AND NEW.status <> 'locked_for_dispute'
       AND public.spatial_is_operator(v_uid)
    THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'scan_rooms' THEN
    v_scan_id := COALESCE(NEW.scan_id, OLD.scan_id);
  ELSIF TG_TABLE_NAME = 'scan_measurements' THEN
    v_scan_id := COALESCE(NEW.scan_id, OLD.scan_id);
  ELSIF TG_TABLE_NAME = 'scan_annotations' THEN
    v_scan_id := COALESCE(NEW.scan_id, OLD.scan_id);
  ELSIF TG_TABLE_NAME = 'scan_assets' THEN
    v_scan_id := COALESCE(NEW.scan_id, OLD.scan_id);
  ELSIF TG_TABLE_NAME = 'scan_surfaces' THEN
    v_scan_id := (
      SELECT r.scan_id FROM public.scan_rooms r
      WHERE r.id = COALESCE(NEW.room_id, OLD.room_id)
    );
  ELSE
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF v_scan_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF public.spatial_is_operator(v_uid) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF public.spatial_scan_is_locked(v_scan_id) THEN
    RAISE EXCEPTION
      'scan % is locked_for_dispute - writes blocked (table %)', v_scan_id, TG_TABLE_NAME
      USING ERRCODE = 'P0001';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;
