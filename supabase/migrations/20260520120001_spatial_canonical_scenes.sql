-- Spatial Canonical · L2 Data-Contracts · (1/5) · Primary Scene-Graph Storage
--
-- Purpose:
--   The `spatial_scenes` table is the authoritative header record for every
--   canonical parametric scene in FixUp Spatial V1.  The actual parametric JSON
--   blob (RoomScene wire-format) is stored in Supabase Storage at
--   `parametric_storage_path` (Decision #2 — NOT embedded jsonb).
--   Content-addressed via `parametric_sha256`; size tracked for quota/billing.
--
-- R-numbers covered:
--   R4  — scan-source nullable; `source_scan_id` OR `source_job_id` required
--          (CHECK constraint `spatial_scenes_origin_chk`).
--   R7  — dual-flag `is_renderable` + `requires_user_confirmation` keep renderer
--          and customer-verify flows orthogonal.
--   R9  — forward-only migration; no DROP / no ALTER on shipped columns.
--
-- FK column types (verified against PROD schema 2026-05-20 · itdntawwuzqfwmcwnwjr):
--   scans.id         uuid     (20260518000002_spatial_core_block_a_schema.sql)
--   jobs.id          uuid     (live prod PK type — repo migration 20240101000000 is stale)
--   auth.users.id    uuid     (Supabase built-in)
--
-- External pairing (not in this file):
--   RLS policies           → 20260520120010_spatial_canonical_rls.sql    (Day 7)
--   updated_at triggers    → 20260520120011_spatial_canonical_triggers.sql (Day 7)
--   SpatialFsmViolation    → Postgres exception domain wired in Day 7 triggers.
--   CreateSpatialSceneInput / UpdateSpatialSceneInput DTOs
--                          → src/lib/spatial/canonical/repository/ (Day 8 B11, XM-5)
--
-- Plan reference: ~/.claude/plans/spatial-v1-day-6-17-NEXT-CHAT-HANDOVER.md §4 Day 6

-- ── Table ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.spatial_scenes (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Origin references (R4 · at least one must be set, enforced via CHECK below)
  source_scan_id              uuid        NULL REFERENCES public.scans(id)   ON DELETE SET NULL,
  source_job_id               uuid        NULL REFERENCES public.jobs(id)    ON DELETE SET NULL,

  -- Parametric blob location in Supabase Storage (Decision #2 — no inline jsonb)
  parametric_storage_path     text        NOT NULL,
  parametric_size_bytes       integer     NULL,
  parametric_sha256           text        NULL, -- content-addressed identifier; populated on write

  -- Schema versioning for migrateParametricJson (see schema/version-migration.ts)
  schema_version              text        NOT NULL DEFAULT '1.0',

  -- Validation state (R7 · 5-state FSM · SpatialFsmViolation enforced in Day 7 trigger)
  validation_state            text        NOT NULL DEFAULT 'pending'
    CONSTRAINT spatial_scenes_validation_state_chk
      CHECK (validation_state IN ('pending','passed','passed_with_warnings','blocked','re_review')),

  -- Renderer + customer-verify dual-flags (R7)
  is_renderable               boolean     NOT NULL DEFAULT false,
  requires_user_confirmation  boolean     NOT NULL DEFAULT false,

  -- Customer verify flow (mirrors Verify-Flow-Spec §2.6 · FSM home: Day 8 spatialSceneFsm.ts)
  customer_verify_state       text        NOT NULL DEFAULT 'not_started'
    CONSTRAINT spatial_scenes_customer_verify_state_chk
      CHECK (customer_verify_state IN ('not_started','in_progress','approved','rejected','expired')),

  -- Ownership
  customer_id                 uuid        NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  provider_id                 uuid        NULL REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Freeform extension bag (kept open for V1; hardened in Phase 1 via JSON Schema)
  metadata                    jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- Timestamps
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  -- R4: at least one origin must be set
  CONSTRAINT spatial_scenes_origin_chk
    CHECK (
      coalesce(source_scan_id::text, '') <> ''
      OR coalesce(source_job_id::text, '') <> ''
    )
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS spatial_scenes_source_scan_id_idx
  ON public.spatial_scenes(source_scan_id)
  WHERE source_scan_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS spatial_scenes_source_job_id_idx
  ON public.spatial_scenes(source_job_id)
  WHERE source_job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS spatial_scenes_customer_id_idx
  ON public.spatial_scenes(customer_id)
  WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS spatial_scenes_provider_id_idx
  ON public.spatial_scenes(provider_id)
  WHERE provider_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS spatial_scenes_validation_state_idx
  ON public.spatial_scenes(validation_state);

-- ── Comments ──────────────────────────────────────────────────────────────────

COMMENT ON TABLE  public.spatial_scenes IS
  'Spatial Canonical V1: header record per parametric scene. '
  'Parametric JSON blob lives in Storage at parametric_storage_path (Decision #2). '
  'R4: source_scan_id OR source_job_id required. '
  'R7: is_renderable + requires_user_confirmation are orthogonal dual-flags. '
  'RLS + triggers added in Day 7.';

COMMENT ON COLUMN public.spatial_scenes.parametric_storage_path IS
  'Supabase Storage path to the canonical parametric JSON blob (RoomScene wire-format). '
  'Content-addressed via parametric_sha256.';

COMMENT ON COLUMN public.spatial_scenes.parametric_sha256 IS
  'SHA-256 hex digest of the parametric blob. Used for content-addressed caching '
  'and integrity verification on download.';

COMMENT ON COLUMN public.spatial_scenes.schema_version IS
  'Maps to schema/version-migration.ts CURRENT_SCHEMA_VERSION. '
  'migrateParametricJson is run on load when version < current.';

COMMENT ON COLUMN public.spatial_scenes.validation_state IS
  'R7 5-state FSM: pending → passed | passed_with_warnings | blocked → re_review. '
  'SpatialFsmViolation Postgres exception domain wired in Day 7 triggers.';

COMMENT ON COLUMN public.spatial_scenes.customer_verify_state IS
  'Verify-Flow-Spec §2.6 customer confirmation FSM. '
  'FSM transitions enforced via spatialSceneFsm.ts (Day 8 B11).';

COMMENT ON COLUMN public.spatial_scenes.source_job_id IS
  'FK to jobs.id (uuid PK, verified against prod 2026-05-20). '
  'V1: job-only flows that have no RoomPlan scan.';

-- ── RLS (enabled here; policies follow in Day 7) ─────────────────────────────

ALTER TABLE public.spatial_scenes ENABLE ROW LEVEL SECURITY;

-- ── REVOKE writes (defence-in-depth, matching Block-A convention) ───────────
-- TRUNCATE is REVOKEd from both anon and authenticated. INSERT/UPDATE/DELETE
-- are REVOKEd from anon explicitly so a future `TO public` policy cannot
-- silently expose the table to unauthenticated callers; authenticated retains
-- access subject to the RLS policies in 20260520120010_*_rls.sql.

REVOKE TRUNCATE                  ON public.spatial_scenes FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE    ON public.spatial_scenes FROM anon;

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS public.spatial_scenes CASCADE;
