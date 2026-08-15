-- Spatial Canonical · Phase C · (C-2) · Pin Reviews
--
-- Purpose:
--   Persists which annotation pins a provider-org member has reviewed
--   (trusted or flagged).  Without this table the Hub signal
--   `workerPinsUnreviewedHrs` has no persistence target and can never
--   compute a "reviewed" state — this is Audit-Finding HIGH-3.
--
--   Model: existence of a row = this pin has been reviewed by this org.
--   One row per (scene_id, annotation_node_id, provider_org_id) enforced
--   by UNIQUE constraint.  annotation_node_id is a text slug referencing a
--   pin node inside the RoomScene parametric blob; NO FK because pins live
--   in Storage blobs, not in a relational table.
--
--   The "Allen vertrauen" action in JobSpatialPinsTab bulk-inserts rows
--   (one per unreviewed pin) via the SELECT + INSERT policy below.
--
-- Provider-org pattern:
--   FK → public.providers(id).  FixUp has NO `provider_orgs` table (see
--   20260520120046 comment §"Spec mapping correction").
--
-- Role invariant:
--   team_members.role in prod holds only 'owner' | 'worker'.  The CHECK
--   constraint on reviewed_by_role mirrors this.
--
-- Infrastructure reuse:
--   public.set_updated_at()              — shared trigger fn (20260518000002)
--   public.spatial_user_provider_org()   — org resolver (20260520120046)
--
-- What this migration does NOT do (by design):
--   - No customer-facing access.  Pin reviews are a provider-internal signal;
--     customers have no SELECT/INSERT/UPDATE/DELETE grant on this table.
--   - No FSM trigger on review_status.  The two values (trusted|flagged) are
--     directly togglable via the UPDATE policy — no lifecycle guard needed.
--   - No customer notification.  Out of scope for this migration.
--
-- Payment/Job/Project sync: not affected.
-- Schema cache refresh: required after apply (new table visible in PostgREST
--   schema cache — Dashboard → Settings → API → Reload schema cache).
--
-- Apply after: 20260521120047_spatial_rescan_requests.sql
-- Plan reference: ~/.claude/plans/spatial-phase-b-code-handover.md (Phase C Seam / HIGH-3)

-- ── Table ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.spatial_pin_reviews (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Scene this review belongs to.  Cascade-delete removes reviews when a
  -- scene is removed (pin reviews have no meaning without their scene).
  scene_id             uuid        NOT NULL
    REFERENCES public.spatial_scenes(id) ON DELETE CASCADE,

  -- Provider business that owns this review record.
  provider_org_id      uuid        NOT NULL
    REFERENCES public.providers(id),

  -- Text slug / node-ID of the annotation pin in the RoomScene blob.
  -- No FK — pins live in Storage blobs, not in a relational table.
  annotation_node_id   text        NOT NULL,

  -- Individual team member who performed the review.
  reviewed_by_user_id  uuid        NOT NULL
    REFERENCES auth.users(id),

  -- Role snapshot at review time.  Prod values: 'owner' | 'worker'.
  reviewed_by_role     text        NOT NULL
    CONSTRAINT spatial_pin_reviews_role_chk
      CHECK (reviewed_by_role IN ('owner','worker')),

  -- Review outcome.  Directly togglable; no FSM guard required.
  review_status        text        NOT NULL DEFAULT 'trusted'
    CONSTRAINT spatial_pin_reviews_status_chk
      CHECK (review_status IN ('trusted','flagged')),

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- One review record per pin per org.  Prevents duplicate "trust" inserts;
  -- makes upsert semantics deterministic for "Allen vertrauen" bulk path.
  CONSTRAINT spatial_pin_reviews_uniq
    UNIQUE (scene_id, annotation_node_id, provider_org_id)
);

COMMENT ON TABLE public.spatial_pin_reviews IS
  'Spatial Phase C (C-2): tracks which annotation pins a provider-org member '
  'has reviewed (trusted|flagged).  Fixes Audit-Finding HIGH-3 — without this '
  'table the Hub signal workerPinsUnreviewedHrs has no persistence target. '
  'Existence of a row = pin was reviewed.  One row per (scene, pin, org) via '
  'UNIQUE constraint.';

COMMENT ON COLUMN public.spatial_pin_reviews.annotation_node_id IS
  'Text slug / node-ID of the annotation pin inside the RoomScene parametric '
  'blob (Storage object).  No FK — pin nodes are not a relational table.';

COMMENT ON COLUMN public.spatial_pin_reviews.provider_org_id IS
  'FK → public.providers(id).  The provider BUSINESS, not an individual user. '
  'FixUp has no provider_orgs table — public.providers is the org entity.';

COMMENT ON COLUMN public.spatial_pin_reviews.reviewed_by_role IS
  'Role snapshot at review time (owner|worker — prod-live values). '
  'Immutable after insert; stored for audit even if the user''s role changes.';

COMMENT ON COLUMN public.spatial_pin_reviews.review_status IS
  'trusted = pin content accepted; flagged = pin content disputed internally. '
  'Directly togglable via UPDATE policy (no FSM trigger needed for two states).';

-- ── Index ─────────────────────────────────────────────────────────────────────

-- Primary query: Hub lists all reviews for a scene, newest first.
CREATE INDEX IF NOT EXISTS spatial_pin_reviews_scene_created_idx
  ON public.spatial_pin_reviews(scene_id, created_at DESC);

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- Default-deny baseline.  service_role bypasses RLS entirely (PostgREST convention).

ALTER TABLE public.spatial_pin_reviews ENABLE ROW LEVEL SECURITY;

-- SELECT: any member of the owning provider org may read their org's reviews.
CREATE POLICY spatial_pin_reviews_select
  ON public.spatial_pin_reviews
  FOR SELECT
  TO authenticated
  USING (
    provider_org_id = public.spatial_user_provider_org(auth.uid())
  );

-- INSERT: org member may create a review provided:
--   (a) provider_org_id matches their own org,
--   (b) reviewed_by_user_id = auth.uid() (no impersonation), and
--   (c) the target scene actually belongs to this org (cross-org injection guard).
CREATE POLICY spatial_pin_reviews_insert
  ON public.spatial_pin_reviews
  FOR INSERT
  TO authenticated
  WITH CHECK (
    provider_org_id = public.spatial_user_provider_org(auth.uid())
    AND reviewed_by_user_id = auth.uid()
    AND EXISTS (
      SELECT 1
        FROM public.spatial_scenes s
        WHERE s.id = scene_id
          AND s.provider_org_id = provider_org_id
    )
  );

-- UPDATE: org member may toggle review_status (trusted↔flagged) on their own
-- org's reviews.  USING restricts which rows are visible for update; WITH CHECK
-- ensures the updated row still belongs to the same org.
CREATE POLICY spatial_pin_reviews_update
  ON public.spatial_pin_reviews
  FOR UPDATE
  TO authenticated
  USING (
    provider_org_id = public.spatial_user_provider_org(auth.uid())
  )
  WITH CHECK (
    provider_org_id = public.spatial_user_provider_org(auth.uid())
  );

-- DELETE: org member may retract a review (remove the row entirely).
-- Enables "unmark as trusted" and bulk-retract flows.
CREATE POLICY spatial_pin_reviews_delete
  ON public.spatial_pin_reviews
  FOR DELETE
  TO authenticated
  USING (
    provider_org_id = public.spatial_user_provider_org(auth.uid())
  );

-- ── updated_at trigger ────────────────────────────────────────────────────────
-- public.set_updated_at() is shared infrastructure (20260518000002).

DROP TRIGGER IF EXISTS spatial_pin_reviews_set_updated_at
  ON public.spatial_pin_reviews;
CREATE TRIGGER spatial_pin_reviews_set_updated_at
  BEFORE UPDATE ON public.spatial_pin_reviews
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- Run to undo this migration completely.
-- NOTE: public.set_updated_at() is shared — do NOT drop it here.
--
-- DROP TRIGGER IF EXISTS spatial_pin_reviews_set_updated_at
--   ON public.spatial_pin_reviews;
--
-- DROP INDEX IF EXISTS public.spatial_pin_reviews_scene_created_idx;
--
-- DROP TABLE IF EXISTS public.spatial_pin_reviews;
