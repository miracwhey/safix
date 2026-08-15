-- Spatial Canonical · Phase C · (C-1) · Re-Scan Requests
--
-- Purpose:
--   Persists re-scan requests that a provider (owner or worker) sends to the
--   customer when the current scan basis is insufficient.  Replaces the
--   current in-memory-only state in JobSpatialRescanTab (Phase C Seam 7 wiring
--   pending).  Each row represents one request lifecycle; status transitions
--   are owned exclusively by the SECURITY DEFINER RPC below — authenticated
--   clients have no direct UPDATE/DELETE grant.
--
-- Provider-org pattern:
--   FK → public.providers(id).  FixUp has NO `provider_orgs` table — the
--   canonical provider-business entity is public.providers (see 20260520120046
--   comment §"Spec mapping correction").
--
-- Role invariant:
--   team_members.role in prod holds only 'owner' | 'worker'.  The CHECK
--   constraint on requested_by_role mirrors this (no office/read_only here).
--
-- Infrastructure reuse:
--   public.set_updated_at()         — shared trigger fn (20260518000002)
--   public.spatial_user_provider_org(uuid) — org resolver (20260520120046)
--   public.spatial_can_view_scene(uuid, uuid) — scene-actor guard (120010/120046)
--
-- What this migration does NOT do (by design):
--   - No customer-notification trigger.  Customer notification (Seam 7) is a
--     cross-domain signal wired in Phase C separately — NOT in this migration.
--   - No customer-facing RLS.  The customer has no direct row access; the
--     notification path is push-only via Seam 7.
--   - No UPDATE/DELETE policy for authenticated role.  Status changes are
--     exclusively through spatial_rescan_request_respond().
--
-- Payment/Job/Project sync: not affected (no state columns on jobs/projects).
-- Schema cache refresh: required after apply (new table + new RPC visible in
--   PostgREST schema cache — Dashboard → Settings → API → Reload schema cache).
--
-- Apply after: 20260520120046_spatial_multi_tenant.sql (last prod migration).
-- Plan reference: ~/.claude/plans/spatial-phase-b-code-handover.md (Phase C seams)

-- ── Table ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.spatial_rescan_requests (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Scene this request belongs to.  Cascade-delete keeps no orphans when a
  -- scene is removed.
  scene_id             uuid        NOT NULL
    REFERENCES public.spatial_scenes(id) ON DELETE CASCADE,

  -- Provider business that issued the request (not the individual user).
  provider_org_id      uuid        NOT NULL
    REFERENCES public.providers(id),

  -- Individual team member who created the request.
  requested_by_user_id uuid        NOT NULL
    REFERENCES auth.users(id),

  -- Role snapshot at request time.  Prod values: 'owner' | 'worker'.
  requested_by_role    text        NOT NULL
    CONSTRAINT spatial_rescan_requests_role_chk
      CHECK (requested_by_role IN ('owner','worker')),

  -- Human-readable rationale surfaced to the customer.
  reason               text        NOT NULL,

  -- Lifecycle.  Transitions: pending → accepted | rejected (terminal).
  -- Status changes exclusively via spatial_rescan_request_respond().
  status               text        NOT NULL DEFAULT 'pending'
    CONSTRAINT spatial_rescan_requests_status_chk
      CHECK (status IN ('pending','accepted','rejected')),

  -- Optional customer note on response.
  response_note        text,

  -- Server-stamped when status leaves 'pending'.
  responded_at         timestamptz,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.spatial_rescan_requests IS
  'Spatial Phase C (C-1): persists provider re-scan requests sent to the '
  'customer.  Status transitions (pending→accepted|rejected) are owned '
  'exclusively by spatial_rescan_request_respond() SECURITY DEFINER RPC. '
  'Customer notification is wired separately in Phase C Seam 7.';

COMMENT ON COLUMN public.spatial_rescan_requests.provider_org_id IS
  'FK → public.providers(id).  The provider BUSINESS, not an individual user. '
  'FixUp has no provider_orgs table — public.providers is the org entity.';

COMMENT ON COLUMN public.spatial_rescan_requests.requested_by_role IS
  'Role snapshot at request-creation time (owner|worker — prod-live values). '
  'Immutable after insert; stored for audit even if the user''s role changes.';

COMMENT ON COLUMN public.spatial_rescan_requests.status IS
  'Lifecycle: pending → accepted | rejected (both terminal). '
  'Only spatial_rescan_request_respond() may write this column.';

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Primary query: Hub lists all requests for a scene, newest first.
CREATE INDEX IF NOT EXISTS spatial_rescan_requests_scene_created_idx
  ON public.spatial_rescan_requests(scene_id, created_at DESC);

-- Secondary query: Hub dashboard lists all pending requests for an org.
CREATE INDEX IF NOT EXISTS spatial_rescan_requests_org_created_idx
  ON public.spatial_rescan_requests(provider_org_id, created_at DESC);

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- Default-deny baseline: no authenticated user can read/write without an
-- explicit policy.  service_role bypasses RLS entirely (PostgREST convention).

ALTER TABLE public.spatial_rescan_requests ENABLE ROW LEVEL SECURITY;

-- SELECT: any member of the owning provider org may read all requests for
-- their org.  spatial_user_provider_org() is SECURITY DEFINER — safe to call
-- from within a policy expression.
CREATE POLICY spatial_rescan_requests_select
  ON public.spatial_rescan_requests
  FOR SELECT
  TO authenticated
  USING (
    provider_org_id = public.spatial_user_provider_org(auth.uid())
  );

-- INSERT: org member may create a request provided:
--   (a) provider_org_id matches their own org, and
--   (b) requested_by_user_id = auth.uid() (no impersonation), and
--   (c) the target scene actually belongs to this org (prevents cross-org
--       injection via a scene_id belonging to a different provider).
CREATE POLICY spatial_rescan_requests_insert
  ON public.spatial_rescan_requests
  FOR INSERT
  TO authenticated
  WITH CHECK (
    provider_org_id = public.spatial_user_provider_org(auth.uid())
    AND requested_by_user_id = auth.uid()
    AND EXISTS (
      SELECT 1
        FROM public.spatial_scenes s
        WHERE s.id = scene_id
          AND s.provider_org_id = provider_org_id
    )
  );

-- UPDATE: no policy for authenticated — status transitions are exclusively
-- through spatial_rescan_request_respond() (SECURITY DEFINER).
-- service_role is not restricted by RLS.

-- DELETE: no policy for authenticated — rows are never deleted by clients
-- (append-only audit posture; cascade from spatial_scenes handles cleanup).

-- ── updated_at trigger ────────────────────────────────────────────────────────
-- public.set_updated_at() is shared infrastructure (20260518000002).

DROP TRIGGER IF EXISTS spatial_rescan_requests_set_updated_at
  ON public.spatial_rescan_requests;
CREATE TRIGGER spatial_rescan_requests_set_updated_at
  BEFORE UPDATE ON public.spatial_rescan_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RPC: spatial_rescan_request_respond ──────────────────────────────────────
--
-- SECURITY DEFINER: sole write path for status transitions on
-- spatial_rescan_requests.  Bypasses RLS on the table; all legitimacy
-- checks are performed inside the function body.
--
-- Design:
--   - Only the scene's customer may respond (verified via spatial_scenes.customer_id).
--   - Only 'pending' rows are transitionable — idempotent: already-responded
--     rows silently return false rather than raising.
--   - p_status must be 'accepted' or 'rejected'.
--   - responded_at and updated_at are stamped server-side (now()).
--   - p_note is optional; NULL clears any previously staged note.
--
-- Returns true when the transition was applied, false on idempotent no-op.
-- Raises on all hard violations (auth, unknown request, bad status).
--
-- Grant: authenticated + service_role.

CREATE OR REPLACE FUNCTION public.spatial_rescan_request_respond(
  p_request_id uuid,
  p_status     text,
  p_note       text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid        uuid;
  v_cur_status text;
  v_customer   uuid;
  v_scene_id   uuid;
BEGIN
  -- 1. Must be authenticated.
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'spatial_rescan_request_respond: authentication required'
      USING ERRCODE = '28000';
  END IF;

  -- 2. p_status must be a legal terminal value.
  IF p_status NOT IN ('accepted','rejected') THEN
    RAISE EXCEPTION
      'spatial_rescan_request_respond: invalid status %; must be accepted|rejected',
      p_status
      USING ERRCODE = '22023';
  END IF;

  -- 3. Request must exist; lock the row to serialise concurrent responses.
  SELECT r.status, r.scene_id
    INTO v_cur_status, v_scene_id
    FROM public.spatial_rescan_requests r
    WHERE r.id = p_request_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'spatial_rescan_request_respond: request % not found', p_request_id
      USING ERRCODE = 'P0002';
  END IF;

  -- 4. Idempotent no-op: already responded rows are not an error.
  IF v_cur_status <> 'pending' THEN
    RETURN false;
  END IF;

  -- 5. Only the scene's customer may respond.
  SELECT s.customer_id INTO v_customer
    FROM public.spatial_scenes s
    WHERE s.id = v_scene_id;
  IF v_customer IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION
      'spatial_rescan_request_respond: caller is not the scene customer (scene=%)',
      v_scene_id
      USING ERRCODE = '42501';
  END IF;

  -- 6. Apply transition.  now() is server-authoritative.
  UPDATE public.spatial_rescan_requests
     SET status        = p_status,
         response_note = p_note,
         responded_at  = now(),
         updated_at    = now()
   WHERE id = p_request_id;

  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.spatial_rescan_request_respond(uuid, text, text) IS
  'Spatial Phase C (C-1): SECURITY DEFINER RPC — sole write path for '
  'spatial_rescan_requests status transitions.  Validates auth.uid() = '
  'spatial_scenes.customer_id; only pending rows are transitionable (idempotent '
  'no-op otherwise).  Returns true when applied, false on no-op.  '
  'Customer-notification (Seam 7) is wired separately in Phase C — NOT here.';

REVOKE EXECUTE ON FUNCTION public.spatial_rescan_request_respond(uuid, text, text)
  FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.spatial_rescan_request_respond(uuid, text, text)
  TO authenticated, service_role;

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- Run to undo this migration completely.
-- NOTE: public.set_updated_at() is shared — do NOT drop it here.
--
-- REVOKE EXECUTE ON FUNCTION public.spatial_rescan_request_respond(uuid, text, text)
--   FROM authenticated, service_role;
-- DROP FUNCTION IF EXISTS public.spatial_rescan_request_respond(uuid, text, text);
--
-- DROP TRIGGER IF EXISTS spatial_rescan_requests_set_updated_at
--   ON public.spatial_rescan_requests;
--
-- DROP INDEX IF EXISTS public.spatial_rescan_requests_org_created_idx;
-- DROP INDEX IF EXISTS public.spatial_rescan_requests_scene_created_idx;
--
-- DROP TABLE IF EXISTS public.spatial_rescan_requests;
