-- Spatial Canonical · L2 Data-Contracts · (5/5) · Dispute Evidence + Change Orders
--
-- Purpose:
--   `dispute_spatial_evidence` — append-only bridge tying dispute records to
--   canonical scene pins / photos.  Evidence rows are forensically significant:
--   writes from anon/authenticated are REVOKEd (matching scan_events + edit_history
--   pattern); inserts via SECURITY DEFINER RPC only (Day 7).
--
--   `spatial_change_orders` — provider-proposed scope changes anchored to
--   scene-graph nodes.  Phase 5 BoM activation.  Schema present from V1 so that
--   dispute-evidence and change-order cross-domain links can be created without a
--   future schema-breaking migration.
--
-- FK column types (verified against PROD schema 2026-05-20 · itdntawwuzqfwmcwnwjr):
--   disputes.id          uuid               (live prod PK type — repo migration is stale)
--   spatial_scenes.id    uuid               (20260520120001_spatial_canonical_scenes.sql)
--   auth.users.id        uuid               (Supabase built-in)
--
-- R-numbers covered:
--   R9 — forward-only migration.
--
-- External pairing:
--   RLS policies           → 20260520120010_spatial_canonical_rls.sql (Day 7)
--   updated_at triggers    → 20260520120011_spatial_canonical_triggers.sql (Day 7)
--   MR1 REVOKE mandate     → Day 7 Handover §7 (dispute_spatial_evidence append-only)
--   Phase 5 BoM activation → Day 41-47 (not in Day 1-17 scope)
--    FIXUP CLAUDE.md note   → DisputeEvidence lives in disputes.metadata jsonb (dead path
--                             for the existing dispute_evidence table); this table is a NEW
--                             spatial-specific bridge distinct from that dead path.
--
-- Plan reference: ~/.claude/plans/spatial-v1-day-6-17-NEXT-CHAT-HANDOVER.md §4 Day 6

-- ── Table: dispute_spatial_evidence (append-only) ────────────────────────────

CREATE TABLE IF NOT EXISTS public.dispute_spatial_evidence (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- References (both NOT NULL: evidence must be tied to both a dispute and a scene)
  dispute_id      uuid        NOT NULL REFERENCES public.disputes(id) ON DELETE CASCADE,
  scene_id        uuid        NOT NULL REFERENCES public.spatial_scenes(id) ON DELETE CASCADE,

  -- Canonical node this evidence is anchored to (string id from parametric blob)
  node_id         text        NOT NULL,

  -- Evidence classification
  evidence_kind   text        NOT NULL
    CONSTRAINT dispute_spatial_evidence_kind_chk
      CHECK (evidence_kind IN ('damage_pin','photo','note','measurement')),

  -- Submitter (NULL if submitted via automated pipeline)
  submitted_by    uuid        NULL REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Timestamp only (append-only; no updated_at)
  submitted_at    timestamptz NOT NULL DEFAULT now(),

  -- Extension bag (measurement value, photo caption, confidence, etc.)
  metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb
);

-- Indexes (access patterns: by dispute + by scene + by submitter)
CREATE INDEX IF NOT EXISTS dispute_spatial_evidence_dispute_id_idx
  ON public.dispute_spatial_evidence(dispute_id);

CREATE INDEX IF NOT EXISTS dispute_spatial_evidence_scene_id_idx
  ON public.dispute_spatial_evidence(scene_id);

CREATE INDEX IF NOT EXISTS dispute_spatial_evidence_submitted_by_idx
  ON public.dispute_spatial_evidence(submitted_by)
  WHERE submitted_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS dispute_spatial_evidence_submitted_at_idx
  ON public.dispute_spatial_evidence(submitted_at DESC);

-- Comments
COMMENT ON TABLE  public.dispute_spatial_evidence IS
  'Spatial Canonical V1: append-only bridge from disputes to canonical scene pins. '
  'dispute_id FK → disputes.id (uuid PK, verified against prod 2026-05-20). '
  'Writes REVOKEd from anon/authenticated; SECURITY DEFINER RPC insert path (Day 7). '
  'Distinct from the dead dispute_evidence table path noted in FIXUP CLAUDE.md.';

COMMENT ON COLUMN public.dispute_spatial_evidence.dispute_id IS
  'FK to disputes.id (uuid PRIMARY KEY, verified against prod 2026-05-20).';

COMMENT ON COLUMN public.dispute_spatial_evidence.node_id IS
  'Canonical scene-graph node identifier (pin, wall, object) from parametric JSON blob. '
  'NOT a Postgres FK — nodes are embedded in Storage blob.';

COMMENT ON COLUMN public.dispute_spatial_evidence.evidence_kind IS
  'damage_pin: spatial pin marking damage. photo: attached photo at pin. '
  'note: text annotation at node. measurement: verified dimension at node.';

-- Append-only: REVOKE writes from anon and authenticated (MR1)
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.dispute_spatial_evidence FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.dispute_spatial_evidence FROM authenticated;

-- RLS (enabled; SELECT policy added in Day 7)
ALTER TABLE public.dispute_spatial_evidence ENABLE ROW LEVEL SECURITY;


-- ── Table: spatial_change_orders ─────────────────────────────────────────────
--
-- Phase 5 BoM: provider proposes scope changes anchored to specific scene nodes.
-- Schema present from V1; activation (RLS write policies, workflow integration)
-- in Day 41-47.

CREATE TABLE IF NOT EXISTS public.spatial_change_orders (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id        uuid        NOT NULL REFERENCES public.spatial_scenes(id) ON DELETE CASCADE,

  -- Optional node anchor (NULL = scene-level change order, not node-specific)
  node_id         text        NULL,

  -- Proposer is always a provider (NOT NULL — change orders require authorship)
  proposer_id     uuid        NOT NULL REFERENCES auth.users(id),

  -- FSM status
  status          text        NOT NULL DEFAULT 'proposed'
    CONSTRAINT spatial_change_orders_status_chk
      CHECK (status IN ('proposed','accepted','rejected','withdrawn')),

  -- Content
  title           text        NOT NULL,
  body            text        NULL,

  -- Extension bag (cost estimate, line items, gewerk category, etc.)
  metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- Timestamps
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS spatial_change_orders_scene_id_idx
  ON public.spatial_change_orders(scene_id);

CREATE INDEX IF NOT EXISTS spatial_change_orders_proposer_id_idx
  ON public.spatial_change_orders(proposer_id);

CREATE INDEX IF NOT EXISTS spatial_change_orders_status_idx
  ON public.spatial_change_orders(status);

-- Comments
COMMENT ON TABLE  public.spatial_change_orders IS
  'Spatial Canonical V1 schema / Phase 5 BoM: provider-proposed scope changes '
  'anchored to canonical scene nodes. Status FSM: proposed → accepted | rejected | withdrawn. '
  'Write policies (RLS) and workflow integration activated in Day 41-47 Phase 5.';

COMMENT ON COLUMN public.spatial_change_orders.node_id IS
  'Canonical scene-graph node identifier (string from parametric blob). '
  'NULL for scene-level change orders not tied to a specific surface or object.';

COMMENT ON COLUMN public.spatial_change_orders.status IS
  'FSM states: proposed (initial) → accepted | rejected | withdrawn. '
  'Day 8 spatialSceneFsm.ts will enforce valid transitions (XM-7 pattern).';

-- RLS (enabled; policies in Day 7)
ALTER TABLE public.spatial_change_orders ENABLE ROW LEVEL SECURITY;

-- REVOKE writes defence-in-depth
-- dispute_spatial_evidence: already fully append-only via REVOKE above.
-- spatial_change_orders: anon must never insert/update/delete (RLS limits
-- authenticated to provider-only proposer per H-A1).
REVOKE TRUNCATE                ON public.dispute_spatial_evidence FROM anon, authenticated;
REVOKE TRUNCATE                ON public.spatial_change_orders    FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE  ON public.spatial_change_orders    FROM anon;

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS public.spatial_change_orders    CASCADE;
-- DROP TABLE IF EXISTS public.dispute_spatial_evidence CASCADE;
