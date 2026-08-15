-- Spatial Core · Block A · Schema (1/2)
--
-- 8 tables for the Spatial Job Capture Core domain:
--   scans, scan_assets, scan_rooms, scan_surfaces, scan_measurements,
--   scan_annotations, scan_quality_reports, scan_events
--
-- Decisions wired in (see Obsidian: 06 Decisions/2026-05-17 Spatial Core 6 Open Decisions.md):
--   D1 (Dual USDZ + glTF):       asset_kind enum includes 'usdz' + 'gltf' + others;
--                                scan_assets.converted_from tracks glTF -> source USDZ.
--   D2 (Hybrid 3-Layer Anchor):  scan_annotations holds 4 anchor layers
--                                (anchor_uv = SoT, anchor_world_cache, anchor_ar_hint, anchor_2d)
--                                plus drift columns + anchor_confidence enum.
--   D5 (Defer Geometry-Edit):    scan_surfaces has only estimated + verified dims;
--                                NO edited_geometry columns.
--
-- Append-only audit (scan_events): RLS + REVOKE writes from anon/authenticated.
-- Writes happen only via SECURITY DEFINER RPCs (added in a follow-up migration).
--
-- RLS policies live in 20260518000003_spatial_core_block_a_rls.sql.
--
-- FK column type reference (verified against prod 2026-05-17):
--   profiles.id       uuid
--   projects.id       uuid       projects.customer_user_id     uuid
--   jobs.id           uuid       jobs.craftsman_user_id        text (legacy)
--   media_uploads.id  text       media_uploads.owner_user_id   text (legacy)
--   auth.uid()        uuid

-- ── Enums ─────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE public.scan_status AS ENUM (
    'draft',
    'capturing',
    'captured',
    'quality_checked',
    'needs_rescan',
    'needs_provider_review',
    'provider_verified',
    'offer_ready',
    'locked_for_dispute',
    'archived'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.scan_source AS ENUM (
    'roomplan',
    'object_capture_area',
    'manual'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.scan_asset_kind AS ENUM (
    'usdz',
    'gltf',
    'scan_json',
    'mesh_summary',
    'thumbnail',
    'floorplan_svg'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.scan_surface_kind AS ENUM (
    'wall',
    'door',
    'window',
    'opening',
    'object'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.scan_measurement_status AS ENUM (
    'estimated_roomplan',
    'estimated_depth',
    'depth_checked',
    'provider_review_required',
    'provider_verified',
    'rejected',
    'superseded'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.scan_measurement_source AS ENUM (
    'roomplan',
    'depth_checked',
    'manual',
    'laser_bt'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.scan_annotation_kind AS ENUM (
    'damage',
    'note',
    'photo',
    'measurement_ref',
    'gewerk_marker'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.scan_annotation_status AS ENUM (
    'open',
    'needs_photo',
    'needs_measurement',
    'offer_relevant',
    'included_in_offer',
    'resolved',
    'dispute_relevant'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.scan_quality_bucket AS ENUM (
    'poor',
    'fair',
    'good',
    'excellent'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.scan_anchor_confidence AS ENUM (
    'high',
    'medium',
    'low',
    'lost'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.scan_event_action AS ENUM (
    'captured',
    'quality_run',
    'measurement_edited',
    'annotation_added',
    'annotation_resolved',
    'verified',
    'rejected',
    'rescan_requested',
    'rescan_linked',
    'locked',
    'unlocked',
    'archived',
    'asset_converted',
    'drift_detected'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Tables ────────────────────────────────────────────────────────────────────

-- 1. scans · Header per capture session, versioned via parent_scan_id
CREATE TABLE IF NOT EXISTS public.scans (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id              uuid REFERENCES public.jobs(id)     ON DELETE CASCADE,
  project_id          uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  parent_scan_id      uuid REFERENCES public.scans(id)    ON DELETE SET NULL,
  status              public.scan_status NOT NULL DEFAULT 'draft',
  source              public.scan_source NOT NULL DEFAULT 'roomplan',
  captured_by         uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  device_meta         jsonb NOT NULL DEFAULT '{}'::jsonb,
  scan_started_at     timestamptz,
  scan_ended_at       timestamptz,
  archived_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scans_owner_anchor_chk CHECK (job_id IS NOT NULL OR project_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS scans_job_id_idx         ON public.scans(job_id)         WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS scans_project_id_idx     ON public.scans(project_id)     WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS scans_parent_scan_id_idx ON public.scans(parent_scan_id) WHERE parent_scan_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS scans_status_idx         ON public.scans(status);
CREATE INDEX IF NOT EXISTS scans_captured_by_idx    ON public.scans(captured_by);

COMMENT ON TABLE  public.scans                IS 'Spatial Core: per-capture-session header. Versioned via parent_scan_id. CHECK requires job_id OR project_id (no orphan scans).';
COMMENT ON COLUMN public.scans.parent_scan_id IS 'Self-FK for re-scan versioning. Pin migration uses D2 anchor matching.';
COMMENT ON COLUMN public.scans.device_meta    IS 'Device + sensor info (model, iOS, LiDAR cap, ARKit version) for forensics + quality scoring.';

-- 2. scan_assets · Files attached to a scan (D1: dual USDZ + glTF)
CREATE TABLE IF NOT EXISTS public.scan_assets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id         uuid NOT NULL REFERENCES public.scans(id)        ON DELETE CASCADE,
  kind            public.scan_asset_kind NOT NULL,
  storage_path    text NOT NULL,
  bytes           bigint,
  sha256          text,
  converted_from  uuid REFERENCES public.scan_assets(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scan_id, kind)
);

CREATE INDEX IF NOT EXISTS scan_assets_scan_id_idx        ON public.scan_assets(scan_id);
CREATE INDEX IF NOT EXISTS scan_assets_kind_idx           ON public.scan_assets(kind);
CREATE INDEX IF NOT EXISTS scan_assets_converted_from_idx ON public.scan_assets(converted_from) WHERE converted_from IS NOT NULL;

COMMENT ON TABLE  public.scan_assets                IS 'Spatial Core: files attached to a scan. UNIQUE(scan_id, kind) = one file per format per scan. converted_from links glTF back to source USDZ (D1 dual-format pipeline).';
COMMENT ON COLUMN public.scan_assets.converted_from IS 'D1: glTF row points to its source USDZ row. NULL for native captures (usdz, scan_json, mesh_summary).';

-- 3. scan_rooms · Rooms inside a scan (V1: typically 1)
CREATE TABLE IF NOT EXISTS public.scan_rooms (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id             uuid NOT NULL REFERENCES public.scans(id) ON DELETE CASCADE,
  name                text,
  area_m2_estimated   numeric(8, 3),
  area_m2_verified    numeric(8, 3),
  ceiling_h_estimated numeric(5, 3),
  ceiling_h_verified  numeric(5, 3),
  floor_anchor        jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scan_rooms_scan_id_idx ON public.scan_rooms(scan_id);

COMMENT ON TABLE public.scan_rooms IS 'Spatial Core: rooms within a scan. estimated_* = RoomPlan output, verified_* = handwerker truth (D5 Dimension-Override).';

-- 4. scan_surfaces · Walls, doors, windows, openings, objects
--    surface_external_id is plugin-vergeben (D2 Layer 1 UV-anchor)
CREATE TABLE IF NOT EXISTS public.scan_surfaces (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id             uuid NOT NULL REFERENCES public.scan_rooms(id) ON DELETE CASCADE,
  surface_external_id text NOT NULL,
  kind                public.scan_surface_kind NOT NULL,
  dim_w_estimated     numeric(6, 3),
  dim_h_estimated     numeric(6, 3),
  dim_w_verified      numeric(6, 3),
  dim_h_verified      numeric(6, 3),
  transform           jsonb,
  status              public.scan_measurement_status NOT NULL DEFAULT 'estimated_roomplan',
  confidence          numeric(3, 2),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scan_surfaces_confidence_range_chk CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  UNIQUE (room_id, surface_external_id)
);

CREATE INDEX IF NOT EXISTS scan_surfaces_room_id_idx              ON public.scan_surfaces(room_id);
CREATE INDEX IF NOT EXISTS scan_surfaces_kind_idx                 ON public.scan_surfaces(kind);
CREATE INDEX IF NOT EXISTS scan_surfaces_status_idx               ON public.scan_surfaces(status);
CREATE INDEX IF NOT EXISTS scan_surfaces_surface_external_id_idx  ON public.scan_surfaces(surface_external_id);

COMMENT ON TABLE  public.scan_surfaces                     IS 'Spatial Core: walls / doors / windows / openings / objects. No edited_geometry (D5 deferred V3+).';
COMMENT ON COLUMN public.scan_surfaces.surface_external_id IS 'D2 Layer 1: plugin-vergebene stabile ID (hash from RoomPlan geometry) for UV-anchor cross-format + re-scan migration.';
COMMENT ON COLUMN public.scan_surfaces.confidence          IS '0.00 to 1.00 from mesh classification (Quality Engine input).';

-- 5. scan_measurements · Atomic measurements
CREATE TABLE IF NOT EXISTS public.scan_measurements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id           uuid NOT NULL REFERENCES public.scans(id)         ON DELETE CASCADE,
  surface_id        uuid REFERENCES public.scan_surfaces(id)          ON DELETE SET NULL,
  label             text,
  value_estimated_m numeric(8, 4),
  value_verified_m  numeric(8, 4),
  unit              text NOT NULL DEFAULT 'm',
  status            public.scan_measurement_status NOT NULL DEFAULT 'estimated_roomplan',
  source            public.scan_measurement_source NOT NULL DEFAULT 'roomplan',
  verified_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  verified_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scan_measurements_unit_m_only_chk CHECK (unit = 'm'),
  -- One-way implication: verified status REQUIRES all 3 verification fields,
  -- but later transitions (provider_verified -> superseded / rejected / locked_for_dispute)
  -- preserve the verified-history (value_verified_m, verified_by, verified_at) for audit trail.
  CONSTRAINT scan_measurements_verified_consistency_chk CHECK (
    status <> 'provider_verified'
    OR (value_verified_m IS NOT NULL AND verified_by IS NOT NULL AND verified_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS scan_measurements_scan_id_idx     ON public.scan_measurements(scan_id);
CREATE INDEX IF NOT EXISTS scan_measurements_surface_id_idx  ON public.scan_measurements(surface_id) WHERE surface_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS scan_measurements_status_idx      ON public.scan_measurements(status);
CREATE INDEX IF NOT EXISTS scan_measurements_verified_by_idx ON public.scan_measurements(verified_by) WHERE verified_by IS NOT NULL;

COMMENT ON TABLE public.scan_measurements IS 'Spatial Core: atomic measurements with FSM estimated_* -> verified_*. CHECK enforces verified state has all three fields set.';

-- 6. scan_annotations · D2 Hybrid 3-Layer Anchor + 2D-Fallback + Drift-Detection
CREATE TABLE IF NOT EXISTS public.scan_annotations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id               uuid NOT NULL REFERENCES public.scans(id) ON DELETE CASCADE,
  kind                  public.scan_annotation_kind NOT NULL,
  -- D2 Layer 1 · UV-on-Surface (Source of Truth): {surface_external_id, uv:[u,v]}
  anchor_uv             jsonb,
  -- D2 Layer 2 · World-XYZ Cache (performance + drift detector):
  --   {usdz:{x,y,z}, gltf:{x,y,z}, computed_at}
  anchor_world_cache    jsonb,
  -- D2 Layer 3 · AR-Anchor Hint (iOS only, Visual SLAM via ARWorldMap):
  --   {ar_anchor_uuid, world_map_ref}
  anchor_ar_hint        jsonb,
  -- D2 Layer 4 · 2D-Floorplan Fallback (for free-floating pins or pre-3D phase):
  --   {svg_x, svg_y}
  anchor_2d             jsonb,
  -- Drift-Detection state
  last_drift_check_at   timestamptz,
  last_drift_distance_m numeric(8, 4),
  confidence            public.scan_anchor_confidence NOT NULL DEFAULT 'high',
  -- Content
  photo_asset_id        text REFERENCES public.media_uploads(id) ON DELETE SET NULL,
  note                  text,
  status                public.scan_annotation_status NOT NULL DEFAULT 'open',
  gewerk                text,
  offer_relevant        boolean NOT NULL DEFAULT false,
  offer_line_item_id    uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scan_annotations_has_some_anchor_chk CHECK (
    anchor_uv IS NOT NULL OR anchor_2d IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS scan_annotations_scan_id_idx        ON public.scan_annotations(scan_id);
CREATE INDEX IF NOT EXISTS scan_annotations_status_idx         ON public.scan_annotations(status);
CREATE INDEX IF NOT EXISTS scan_annotations_kind_idx           ON public.scan_annotations(kind);
CREATE INDEX IF NOT EXISTS scan_annotations_confidence_idx     ON public.scan_annotations(confidence) WHERE confidence IN ('low', 'lost');
CREATE INDEX IF NOT EXISTS scan_annotations_offer_relevant_idx ON public.scan_annotations(scan_id) WHERE offer_relevant = true;

COMMENT ON TABLE  public.scan_annotations                    IS 'Spatial Core: pins with D2 Hybrid Anchor (UV SoT + World-XYZ Cache + AR-Hint + 2D-Fallback) + Drift-Detection. CHECK requires at least anchor_uv OR anchor_2d.';
COMMENT ON COLUMN public.scan_annotations.anchor_uv          IS 'D2 Layer 1 (SoT): {surface_external_id, uv:[u,v]}. UV always wins on conflict; cache/hint are derived.';
COMMENT ON COLUMN public.scan_annotations.anchor_world_cache IS 'D2 Layer 2: per-format cached World-XYZ for 1ms render + drift comparison vs UV-resolve.';
COMMENT ON COLUMN public.scan_annotations.anchor_ar_hint     IS 'D2 Layer 3 (iOS only): ARWorldMap-Anchor for re-scan Visual-SLAM cross-check.';
COMMENT ON COLUMN public.scan_annotations.anchor_2d          IS 'D2 Layer 4: SVG-Floorplan fallback for free-floating pins, furniture, or pre-3D phase.';
COMMENT ON COLUMN public.scan_annotations.confidence         IS 'high = UV+AR consistent / medium = UV ok, AR missing / low = UV fragwürdig, User-Review CTA / lost = surface removed, manual re-pin needed.';
COMMENT ON COLUMN public.scan_annotations.offer_line_item_id IS 'V2: link to offers.line_items[].id. FK NOT enforced here (deferred Block F).';

-- 7. scan_quality_reports · Output of pure-function Quality Engine V1
CREATE TABLE IF NOT EXISTS public.scan_quality_reports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id        uuid NOT NULL REFERENCES public.scans(id) ON DELETE CASCADE,
  score          smallint NOT NULL,
  bucket         public.scan_quality_bucket NOT NULL,
  warnings       jsonb NOT NULL DEFAULT '[]'::jsonb,
  engine_version text NOT NULL,
  generated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scan_quality_reports_score_range_chk CHECK (score >= 0 AND score <= 100)
);

CREATE INDEX IF NOT EXISTS scan_quality_reports_scan_id_idx      ON public.scan_quality_reports(scan_id);
CREATE INDEX IF NOT EXISTS scan_quality_reports_generated_at_idx ON public.scan_quality_reports(generated_at DESC);
CREATE INDEX IF NOT EXISTS scan_quality_reports_bucket_idx       ON public.scan_quality_reports(bucket);

COMMENT ON TABLE  public.scan_quality_reports          IS 'Spatial Core: pure-function Quality Engine V1 output. Warnings enum-only (no free text). Multiple reports per scan = history.';
COMMENT ON COLUMN public.scan_quality_reports.warnings IS 'Array of warning codes: too_few_walls | area_implausible | ceiling_implausible | wall_coverage_low | low_confidence | door_dimensions_unusual | window_dimensions_unusual (enum-validated in app layer).';

-- 8. scan_events · Append-only audit (defense-in-depth: RLS + REVOKE writes)
CREATE TABLE IF NOT EXISTS public.scan_events (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id  uuid NOT NULL REFERENCES public.scans(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  action   public.scan_event_action NOT NULL,
  payload  jsonb NOT NULL DEFAULT '{}'::jsonb,
  at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scan_events_scan_id_at_idx ON public.scan_events(scan_id, at DESC);
CREATE INDEX IF NOT EXISTS scan_events_action_idx     ON public.scan_events(action);
CREATE INDEX IF NOT EXISTS scan_events_actor_id_idx   ON public.scan_events(actor_id) WHERE actor_id IS NOT NULL;

COMMENT ON TABLE public.scan_events IS 'Spatial Core: append-only audit log. Writes only via SECURITY DEFINER RPCs (added later). RLS + REVOKE = two-layer append-only.';

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.scan_events FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.scan_events FROM authenticated;

-- Defense-in-depth: REVOKE TRUNCATE on all spatial tables.
-- TRUNCATE is privilege-gated (not RLS-gated) and bypasses both row policies
-- AND the dispute-lock trigger (no statement-level trigger here). Even if
-- default GRANTs ever shift, evidence tables stay protected against mass-purge.
REVOKE TRUNCATE ON public.scans                FROM anon, authenticated;
REVOKE TRUNCATE ON public.scan_assets          FROM anon, authenticated;
REVOKE TRUNCATE ON public.scan_rooms           FROM anon, authenticated;
REVOKE TRUNCATE ON public.scan_surfaces        FROM anon, authenticated;
REVOKE TRUNCATE ON public.scan_measurements    FROM anon, authenticated;
REVOKE TRUNCATE ON public.scan_annotations     FROM anon, authenticated;
REVOKE TRUNCATE ON public.scan_quality_reports FROM anon, authenticated;

-- ── updated_at triggers ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS scans_set_updated_at             ON public.scans;
CREATE TRIGGER        scans_set_updated_at
  BEFORE UPDATE ON public.scans
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS scan_rooms_set_updated_at        ON public.scan_rooms;
CREATE TRIGGER        scan_rooms_set_updated_at
  BEFORE UPDATE ON public.scan_rooms
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS scan_surfaces_set_updated_at     ON public.scan_surfaces;
CREATE TRIGGER        scan_surfaces_set_updated_at
  BEFORE UPDATE ON public.scan_surfaces
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS scan_measurements_set_updated_at ON public.scan_measurements;
CREATE TRIGGER        scan_measurements_set_updated_at
  BEFORE UPDATE ON public.scan_measurements
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS scan_annotations_set_updated_at  ON public.scan_annotations;
CREATE TRIGGER        scan_annotations_set_updated_at
  BEFORE UPDATE ON public.scan_annotations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Enable RLS · policies follow in *_block_a_rls.sql ─────────────────────────

ALTER TABLE public.scans                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scan_assets          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scan_rooms           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scan_surfaces        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scan_measurements    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scan_annotations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scan_quality_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scan_events          ENABLE ROW LEVEL SECURITY;

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS public.scan_events           CASCADE;
-- DROP TABLE IF EXISTS public.scan_quality_reports  CASCADE;
-- DROP TABLE IF EXISTS public.scan_annotations      CASCADE;
-- DROP TABLE IF EXISTS public.scan_measurements     CASCADE;
-- DROP TABLE IF EXISTS public.scan_surfaces         CASCADE;
-- DROP TABLE IF EXISTS public.scan_rooms            CASCADE;
-- DROP TABLE IF EXISTS public.scan_assets           CASCADE;
-- DROP TABLE IF EXISTS public.scans                 CASCADE;
-- DROP TYPE  IF EXISTS public.scan_event_action;
-- DROP TYPE  IF EXISTS public.scan_anchor_confidence;
-- DROP TYPE  IF EXISTS public.scan_quality_bucket;
-- DROP TYPE  IF EXISTS public.scan_annotation_status;
-- DROP TYPE  IF EXISTS public.scan_annotation_kind;
-- DROP TYPE  IF EXISTS public.scan_measurement_source;
-- DROP TYPE  IF EXISTS public.scan_measurement_status;
-- DROP TYPE  IF EXISTS public.scan_surface_kind;
-- DROP TYPE  IF EXISTS public.scan_asset_kind;
-- DROP TYPE  IF EXISTS public.scan_source;
-- DROP TYPE  IF EXISTS public.scan_status;
--
-- set_updated_at() is shared infrastructure - do NOT drop on rollback.

-- ── External steps (not in this migration) ────────────────────────────────────
-- 1. RLS policies                            -> 20260518000003_spatial_core_block_a_rls.sql
-- 2. SECURITY DEFINER RPCs for scan_events   -> follow-up migration in Block A
-- 3. Storage bucket sub-paths per asset kind -> Block A RLS migration (extends project-scans bucket from PR #914)
-- 4. Convert-pipeline (D1 eager USDZ -> glTF) -> Block X (Cloud Run + Blender headless)
-- 5. Block B: legacy migration projects.room_scan_url/_metadata -> scans + scan_assets
