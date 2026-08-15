-- Spatial Canonical · L2 Data-Contracts · (2/5) · Override History + Node Overrides
--
-- Purpose:
--   `spatial_edit_history` — append-only audit log of every parametric-scene
--   mutation.  Records the command, the affected variant + node, and before/after
--   SHA-256 hashes of the parametric blob so auditors can reconstruct state.
--   Writes from anon/authenticated are REVOKEd (append-only via SECURITY DEFINER
--   RPC, matching Block-A `scan_events` pattern).
--
--   `spatial_node_overrides` — V1.x preparation table for per-node override rows.
--   V1 does NOT write to this table; the canonical parametric JSON blob (embedded
--   in Storage) is the single source of truth for overrides (Decision #6).
--   Writes are blocked by RLS until the table is explicitly activated in V1.x.
--
-- R-numbers covered:
--   R9 — forward-only migration.
--
-- External pairing:
--   RLS policies        → 20260520120010_spatial_canonical_rls.sql    (Day 7)
--   updated_at triggers → 20260520120011_spatial_canonical_triggers.sql (Day 7)
--   MR1 REVOKE mandate  → Day 7 Handover §7
--
-- Plan reference: ~/.claude/plans/spatial-v1-day-6-17-NEXT-CHAT-HANDOVER.md §4 Day 6

-- ── Table: spatial_edit_history (append-only audit) ──────────────────────────

CREATE TABLE IF NOT EXISTS public.spatial_edit_history (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id                uuid        NOT NULL REFERENCES public.spatial_scenes(id) ON DELETE CASCADE,
  actor_id                uuid        NULL REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Variant + node targeting
  variant_id              text        NOT NULL,
  base_node_id            text        NOT NULL,

  -- Override payload as applied (delta, not full scene snapshot)
  override_fields         jsonb       NOT NULL,

  -- Operation performed
  command                 text        NOT NULL
    CONSTRAINT spatial_edit_history_command_chk
      CHECK (command IN ('set','delete','restore')),

  -- Content-addressed before/after for blob-level audit trail
  parametric_sha256_before text       NULL,
  parametric_sha256_after  text       NULL,

  -- Timestamp only (append-only; no updated_at)
  created_at              timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS spatial_edit_history_scene_id_idx
  ON public.spatial_edit_history(scene_id);

CREATE INDEX IF NOT EXISTS spatial_edit_history_actor_id_idx
  ON public.spatial_edit_history(actor_id)
  WHERE actor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS spatial_edit_history_created_at_idx
  ON public.spatial_edit_history(created_at DESC);

-- Comments
COMMENT ON TABLE  public.spatial_edit_history IS
  'Spatial Canonical V1: append-only audit log of parametric-scene override mutations. '
  'Writes REVOKEd from anon/authenticated (SECURITY DEFINER RPC path only, Day 7). '
  'before/after SHA-256 hashes allow external diff reconstruction.';

COMMENT ON COLUMN public.spatial_edit_history.command IS
  'Override command: set (create/update) | delete (soft-delete in parametric blob) | restore.';

COMMENT ON COLUMN public.spatial_edit_history.parametric_sha256_before IS
  'SHA-256 of the parametric blob immediately before this command was applied. '
  'NULL for the first write on a new scene.';

-- Append-only: REVOKE writes from anon and authenticated (matching scan_events pattern)
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.spatial_edit_history FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.spatial_edit_history FROM authenticated;

-- RLS (enabled here; SELECT policy added in Day 7)
ALTER TABLE public.spatial_edit_history ENABLE ROW LEVEL SECURITY;


-- ── Table: spatial_node_overrides (V1.x preparation · V1 does NOT write here) ─
--
-- V1.x feature: V1 reads the parametric JSON blob directly for override resolution;
-- writes here are blocked by RLS until the table is activated in V1.x.
-- The override engine (overrides/layer-merge.ts + overrides/variant-resolve.ts)
-- reads from the parametric blob, NOT from this table, in V1.

CREATE TABLE IF NOT EXISTS public.spatial_node_overrides (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id            uuid        NOT NULL REFERENCES public.spatial_scenes(id) ON DELETE CASCADE,

  -- Targeting (matches override engine variant_id + base_node_id convention)
  variant_id          text        NOT NULL,
  base_node_id        text        NOT NULL,

  -- Override delta (full override_fields object as per layer-merge.ts contract)
  override_fields     jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- Timestamps (mutable table)
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- One override row per (scene, variant, node) — uniqueness enforced
  CONSTRAINT spatial_node_overrides_scene_variant_node_uq
    UNIQUE (scene_id, variant_id, base_node_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS spatial_node_overrides_scene_id_idx
  ON public.spatial_node_overrides(scene_id);

-- Comments
COMMENT ON TABLE  public.spatial_node_overrides IS
  'Spatial Canonical V1.x preparation: per-node override rows for future DB-backed '
  'override storage. V1 writes are blocked by RLS (table is schema-present but inactive). '
  'V1 reads overrides from the parametric JSON blob in Storage (Decision #6). '
  'Activate in V1.x by adding INSERT/UPDATE policies in a follow-up RLS migration.';

COMMENT ON COLUMN public.spatial_node_overrides.variant_id IS
  'Must match a variant_id in the scene-graph variant chain. '
  'V1 engine: overrides/variant-resolve.ts reads from parametric blob, not this table.';

-- RLS (enabled; INSERT/UPDATE blocked until V1.x activation migration)
ALTER TABLE public.spatial_node_overrides ENABLE ROW LEVEL SECURITY;

-- REVOKE writes defence-in-depth
-- spatial_edit_history is fully append-only (see above); spatial_node_overrides
-- is read-only via RLS until V1.x activates writes. Explicit anon REVOKE is
-- belt-and-braces in case a future `TO public` policy slips in.
REVOKE TRUNCATE                ON public.spatial_edit_history    FROM anon, authenticated;
REVOKE TRUNCATE                ON public.spatial_node_overrides  FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE  ON public.spatial_node_overrides  FROM anon;

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS public.spatial_node_overrides CASCADE;
-- DROP TABLE IF EXISTS public.spatial_edit_history   CASCADE;
