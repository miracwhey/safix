-- Offers · RLS · Worker-Self-Visibility — Team-Member Read Policy
--
-- Purpose:
--   Close R1 from the C-10 (`20260523120055_offers_spatial_canonical`)
--   handover: when a worker (active `team_members` row, not an owner-direct
--   provider) sends a Spatial quote via `create_spatial_offer`, that RPC
--   sets `offers.craftsman_user_id = providers.profile_id` of the org
--   owner — so the SECURITY-DEFINER RPC can bypass the
--   `offers_pro_gate_insert` RESTRICTIVE policy and reuse the existing
--   `offers_select_own` policy for the owner. The worker
--   (`auth.uid() != owner.profile_id`) therefore does NOT match
--   `offers_select_own`, and their own freshly-sent spatial quote is
--   invisible to them in any RLS-filtered list (UI-side hub, dashboard,
--   notification anchors).
--
--   The C-10 UI works around this for the Provider-BoM-Tab via
--   `SpatialOfferStatusCard` (which reads through `findBySpatialScene` +
--   `spatial_scenes.metadata.canonicalOfferId`, scoped by scene-RLS, not
--   offers-RLS). But every other surface that lists offers (CraftsmanHub,
--   notifications, push-route deep-links) still hides the offer from the
--   worker who created it. This migration adds a PERMISSIVE companion
--   policy so any active team member of the provider-org can SELECT the
--   org-owner's offers.
--
-- Design:
--   - Additive (R9): does not touch `offers_select_own`. The two PERMISSIVE
--     SELECT policies are OR-ed by the planner.
--   - Introduces SECURITY DEFINER helper
--     `spatial_user_org_owner_profile(uid)` that resolves a user's org
--     (via `spatial_user_provider_org`) to the owner's `profile_id`.
--     A plain subquery inside the policy `USING` clause cannot do this:
--     the `providers` table has RLS (`profile_id = auth.uid()`) and the
--     subquery executes in the caller's role, so a worker would see zero
--     `providers` rows. The SECURITY DEFINER helper bypasses that filter
--     for the single, narrow lookup the policy needs.
--   - Filter expression: `craftsman_user_id = spatial_user_org_owner_profile(auth.uid())`.
--     Today this matches exactly one profile_id per caller (the org
--     owner) — the team's canonical "craftsman of record". Both
--     Spatial-Path and Conversation-Path offers store the owner there
--     (Conversation-Path because `offers_insert_craftsman` requires
--     `auth.uid() = craftsman_user_id` AND `offers_pro_gate_insert`
--     requires `is_pro_owner(auth.uid())` — only the owner can INSERT
--     directly).
--   - Side effect (intentional): team workers gain read access to
--     conversation-path offers their org-owner sent. This matches the
--     spirit of the multi-tenant Provider Hub (spec
--     `spatial-v1-provider-hub-spec.md` §2) — the team operates on the
--     business's pipeline, not a per-user one. RBAC enforcement for
--     *actions* (edit / accept / supersede) continues to live in the
--     workflow layer (CLAUDE.md: "Workflow-layer RBAC guards mandatory").
--
-- What this migration does NOT do (by design):
--   - No UPDATE / INSERT / DELETE widening. Workers cannot modify the
--     org-owner's offers via SQL; all writes go through SECURITY DEFINER
--     RPCs or the existing owner-only PERMISSIVE policies.
--   - No customer-side change. `offers_select_own` already covers
--     customers via `auth.uid() = customer_user_id`.
--
-- Production state (verified read-only against prod 2026-05-23):
--   - `offers` RLS enabled, 4 existing policies:
--       offers_select_own           SELECT PERMISSIVE
--       offers_insert_craftsman     INSERT PERMISSIVE
--       offers_update_own           UPDATE PERMISSIVE
--       offers_pro_gate_insert      INSERT RESTRICTIVE
--   - `providers` RLS enabled (`Providers: read own` filters
--     `profile_id = auth.uid()`) — motivates the SECURITY DEFINER helper.
--   - Helper `public.spatial_user_provider_org(uuid)` exists, SECURITY DEFINER.
--
-- External steps:
--   None. RLS-only, no env vars, no edge-function changes.
--
-- Plan reference: ~/.claude/plans/spatial-c10-done-handover.md §5

-- ── 1. SECURITY DEFINER helper: resolve org-owner profile ─────────────────

CREATE OR REPLACE FUNCTION public.spatial_user_org_owner_profile(p_uid uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT p.profile_id
    FROM public.providers p
   WHERE p.id = public.spatial_user_provider_org(p_uid)
     AND p.profile_id IS NOT NULL
   LIMIT 1;
$function$;

COMMENT ON FUNCTION public.spatial_user_org_owner_profile(uuid) IS
  'Resolves a user (owner-direct OR active team_member) to their provider-org owner''s profile_id. '
  'SECURITY DEFINER so RLS-policies on providers do not hide the lookup. '
  'Returns NULL when the user is not part of any active provider-org.';

REVOKE ALL ON FUNCTION public.spatial_user_org_owner_profile(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.spatial_user_org_owner_profile(uuid) TO authenticated, anon;

-- ── 2. Worker-Self-Visibility policy ──────────────────────────────────────

CREATE POLICY offers_select_team_member ON public.offers
  FOR SELECT
  TO authenticated
  USING (
    craftsman_user_id = public.spatial_user_org_owner_profile(auth.uid())
  );

COMMENT ON POLICY offers_select_team_member ON public.offers IS
  'Active team members (workers + owner-direct) of a provider-org SELECT '
  'the offers belonging to that org (craftsman_user_id = org-owner.profile_id). '
  'Closes the worker-self-visibility gap introduced by the C-10 SECURITY DEFINER '
  'RPC create_spatial_offer. Companion to offers_select_own (OR-merged).';
