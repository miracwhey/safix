-- Spatial Canonical · L2 Data-Contracts · (4/5) · Cross-Domain Node Links
--
-- Purpose:
--   `spatial_node_links` bridges canonical scene-graph nodes (which live inside
--   parametric JSON blobs in Storage) to FixUp domain records in other tables.
--   A node_id is a stable string from the canonical scene graph — it is NOT a
--   Postgres uuid FK because nodes are embedded in the parametric blob, not in
--   a separate table row.
--
--   V1 use-cases already wired in link_type CHECK:
--     photo               → media_uploads or job_photos row
--     note                → free-text annotation (target_id = annotation PK)
--     task                → future work-order item
--     material_request    → provider material-change request
--     dispute_evidence    → dispute evidence pin (Phase 5 BoM)
--     change_order        → change_orders row (Phase 5 BoM)
--
--   target_table + target_id are text pairs (not typed FKs) to keep the bridge
--   generic across domains and avoid cross-schema coupling.
--
-- R-numbers covered:
--   R9 — forward-only migration.
--
-- External pairing:
--   RLS policies           → 20260520120010_spatial_canonical_rls.sql (Day 7)
--   updated_at / triggers  → 20260520120011_spatial_canonical_triggers.sql (Day 7)
--   Phase 5 BoM / dispute-evidence activation → Day 41-47 (not in Day 1-17 scope)
--
-- Plan reference: ~/.claude/plans/spatial-v1-day-6-17-NEXT-CHAT-HANDOVER.md §4 Day 6

-- ── Table: spatial_node_links ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.spatial_node_links (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id        uuid        NOT NULL REFERENCES public.spatial_scenes(id) ON DELETE CASCADE,

  -- Node reference: string id from the canonical scene graph (parametric blob).
  -- NOT a uuid FK — nodes live inside the parametric JSON, not in a Postgres table.
  node_id         text        NOT NULL,

  -- Link type: governs which domain table target_table + target_id point to
  link_type       text        NOT NULL
    CONSTRAINT spatial_node_links_link_type_chk
      CHECK (link_type IN (
        'photo',
        'note',
        'task',
        'material_request',
        'dispute_evidence',
        'change_order'
      )),

  -- Generic domain target (text pair to avoid cross-schema FK coupling)
  target_table    text        NOT NULL, -- e.g. 'job_photos', 'disputes', 'change_orders'
  target_id       text        NOT NULL, -- PK of the target row (uuid::text or text PK)

  -- Extension bag (confidence, priority, display hint, etc.)
  metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- Timestamps (append + mutate: full timestamps)
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid        NULL REFERENCES auth.users(id) ON DELETE SET NULL
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Primary access pattern: all links for a given node on a given scene
CREATE INDEX IF NOT EXISTS spatial_node_links_scene_node_link_idx
  ON public.spatial_node_links(scene_id, node_id, link_type);

-- Reverse lookup: find which scenes + nodes reference a domain record
CREATE INDEX IF NOT EXISTS spatial_node_links_target_idx
  ON public.spatial_node_links(target_table, target_id);

CREATE INDEX IF NOT EXISTS spatial_node_links_created_by_idx
  ON public.spatial_node_links(created_by)
  WHERE created_by IS NOT NULL;

-- ── Comments ──────────────────────────────────────────────────────────────────

COMMENT ON TABLE  public.spatial_node_links IS
  'Spatial Canonical V1: generic bridge from canonical scene-graph nodes '
  '(inside parametric JSON blob) to FixUp domain records in other tables. '
  'node_id is a canonical scene-graph string — NOT a Postgres FK. '
  'target_table + target_id are text pairs for cross-domain genericity. '
  'Phase 5 BoM / dispute-evidence use-cases activated in Day 41-47.';

COMMENT ON COLUMN public.spatial_node_links.node_id IS
  'Canonical scene-graph node identifier (e.g. wall_id, object_id, pin_id). '
  'Stable string defined in the parametric JSON blob; not stored in a Postgres table.';

COMMENT ON COLUMN public.spatial_node_links.target_table IS
  'Name of the Postgres table containing the linked domain record. '
  'Application layer enforces referential integrity (no DB-level FK by design).';

COMMENT ON COLUMN public.spatial_node_links.target_id IS
  'Primary key of the target row cast to text. '
  'For uuid PKs: uuid::text. For text PKs (e.g. disputes.id): stored as-is.';

-- RLS (enabled; policies in Day 7)
ALTER TABLE public.spatial_node_links ENABLE ROW LEVEL SECURITY;

-- REVOKE writes defence-in-depth
REVOKE TRUNCATE                ON public.spatial_node_links FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE  ON public.spatial_node_links FROM anon;

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS public.spatial_node_links CASCADE;
