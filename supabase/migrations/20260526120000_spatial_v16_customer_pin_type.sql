-- Spatial V1.6 · Phase 1d · Customer Pin Types
--
-- Adds `customer_pin_type` to scan_annotations so Customer users can classify
-- pins by structural element (door / window / heating / electrical).
--
-- Design decision (Option B, locked 2026-05-26):
--   NOT extending scan_annotation_kind enum (would mix HW-RBAC kinds with
--   Customer-UX kinds in a single discriminator — brittle for policy/filter logic).
--   Orthogonal nullable column: NULL = no customer typification, value = typed.
--
-- Coexistence: a pin can have BOTH kind='damage' AND customer_pin_type='door'
-- (Customer marks a door as the damaged element). Neither column restricts the
-- other. RLS UNCHANGED — existing scan_annotations_select policy with
-- customer_visible filter (Block 3, 20260525120000) applies correctly.
--
-- Phase 2 note: LiDAR-RoomPlan door/window auto-detection will write into this
-- column. heating/electrical stay customer-manual-pins indefinitely.

-- ── Schema change ──────────────────────────────────────────────────────────────

ALTER TABLE public.scan_annotations
  ADD COLUMN IF NOT EXISTS customer_pin_type text NULL;

-- CHECK: NULL (HW-pin, no customer typification) or one of 4 Customer types.
-- Pattern: DROP + re-ADD to make this migration safely re-runnable in CI or on
-- staging where a previous partial run may have left the constraint.
ALTER TABLE public.scan_annotations
  DROP CONSTRAINT IF EXISTS scan_annotations_customer_pin_type_chk;

ALTER TABLE public.scan_annotations
  ADD CONSTRAINT scan_annotations_customer_pin_type_chk
  CHECK (
    customer_pin_type IS NULL
    OR customer_pin_type IN ('door', 'window', 'heating', 'electrical')
  );

COMMENT ON COLUMN public.scan_annotations.customer_pin_type IS
  'V1.6 Phase 1d: Customer-UX pin classification. NULL = HW-only pin, no typification.'
  ' door/window/heating/electrical = Customer-typed structural element.'
  ' Orthogonal to kind — both can be set simultaneously (e.g. kind=damage + customer_pin_type=door).'
  ' Phase 2: door/window populated automatically by LiDAR-RoomPlan detection.';

-- ── Partial index ──────────────────────────────────────────────────────────────
-- Used by pin-list filter queries: WHERE scan_id = $1 AND customer_pin_type = $2
-- Excludes NULL rows (HW-only pins) — keeps the index small.

CREATE INDEX IF NOT EXISTS scan_annotations_customer_pin_type_idx
  ON public.scan_annotations (scan_id, customer_pin_type)
  WHERE customer_pin_type IS NOT NULL;

-- ── RLS unchanged ──────────────────────────────────────────────────────────────
-- scan_annotations_select policy (Block 3) gates on spatial_can_view_scan +
-- customer_visible filter. customer_pin_type is a plain readable column on any
-- row the policy already admits — no separate column-level RLS required.
--
-- UPDATE: existing scan_annotations_update policy (Block A RLS) gates on
-- spatial_can_edit_scan OR spatial_is_job_craftsman. Customers who own a
-- Customer-Self-Scan (owner_type='customer', captured_by=auth.uid()) satisfy
-- spatial_can_edit_scan via the captured_by branch (draft/capturing status) or
-- spatial_can_view_scan via the captured_by=p_uid branch, but do NOT satisfy the
-- UPDATE policy unless they are also the project customer or craftsman.
--
-- Customer Self-Scan pin UPDATE path: Customer creates the pin (INSERT via
-- scan_annotations_insert = spatial_can_view_scan, which includes captured_by),
-- but to UPDATE their own pin they currently need to hit the craftsman path.
-- This is intentional for Phase 1d — customer_pin_type set at INSERT time.
-- If Customer needs to re-type a pin post-INSERT, Phase 2 will add a narrow
-- SECDEF RPC (set_customer_pin_type). No policy change in this migration.
--
-- No audit table needed for this column (Customer-UX path, not RBAC-sensitive).
-- If dispute forensics ever need pin-type history, add via separate migration.

-- ── Schema cache reload ────────────────────────────────────────────────────────
-- Required so PostgREST serves the new column immediately after apply.
-- Without this, Frontend throws "The database schema is invalid or incompatible"
-- on the first scan_annotations read/write after deploy.
-- See: feedback_postgrest_schema_cache_reload

NOTIFY pgrst, 'reload schema';

-- ── Rollback (run manually — NOT part of apply) ────────────────────────────────
-- ALTER TABLE public.scan_annotations
--   DROP CONSTRAINT IF EXISTS scan_annotations_customer_pin_type_chk;
-- DROP INDEX IF EXISTS public.scan_annotations_customer_pin_type_idx;
-- ALTER TABLE public.scan_annotations
--   DROP COLUMN IF EXISTS customer_pin_type;
-- NOTIFY pgrst, 'reload schema';
