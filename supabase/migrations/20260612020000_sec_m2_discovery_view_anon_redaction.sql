-- M2: discovery SECDEF views anon-readable without is_public filter
-- Security Block-A · 2026-06-12
--
-- PROBLEM
--   discovery_providers and visible_discovery_providers are SECURITY DEFINER
--   views (view_options=null = security_invoker=false). providers has no anon
--   SELECT RLS policy — the SECDEF context means anon bypasses all base-table
--   RLS and can enumerate ALL provider profiles, including is_public=false
--   (unpublished) ones via GET /rest/v1/discovery_providers.
--
--   provider_media_tag_cooccur was created as SECURITY DEFINER (Postgres
--   default; the original migration comment incorrectly stated "default
--   security_invoker"). It reads provider_media without a provider is_public
--   guard, allowing tag co-occurrences from private providers' published media
--   to bleed into the "for you" adjacency feed.
--
--   Advisor ERROR security_definer_view was raised on all three views.
--
-- PROD STATE (recon 2026-06-12, project itdntawwuzqfwmcwnwjr)
--   discovery_providers        — SECDEF, NO is_public filter, anon: SELECT+DML
--   visible_discovery_providers — SECDEF, WHERE is_public+onboarding_done, anon: SELECT+DML
--   provider_media_tag_cooccur — SECDEF, SELECT-only for anon+authenticated (correct)
--
-- APP SURFACES (full repo trace)
--   visible_discovery_providers:
--     discoveryService.fetchDiscoveryProviders()          [anon + authenticated]
--     discoveryService.fetchDiscoveryProvider()           [anon + authenticated]
--     savedProviderService.listSavedProvidersWithDetails() [authenticated only]
--   discovery_providers:
--     discoveryService.fetchDiscoveryProviderForProfile() + .eq('is_public',true) [anon]
--     exploreItemFeedService.fetchExploreItemFeedPage()   + .eq('is_public',true) [anon]
--     providerProfileService.getProviderCompanyNameById() — NO is_public filter  [authenticated]
--   provider_media_tag_cooccur:
--     exploreRanking.fetchAdjacentTags()                  [authenticated only]
--
-- FIX
--   1. discovery_providers: add WHERE p.is_public = true to the base view.
--      Keeps SECURITY DEFINER — flipping to security_invoker=true would return
--      zero rows for anon because providers has no anon SELECT policy (verified
--      prod + documented in migration 20260602150000). The is_public=true row
--      filter closes the enumeration gap without breaking the anon feed.
--
--      Behaviour change: getProviderCompanyNameById() now returns null for
--      non-public providers. Called from useWorkerKonto.ts for the craftsman's
--      own providerId; active craftsmen have is_public=true by construction.
--      Callers already type the return as string|null and degrade gracefully.
--
--   2. visible_discovery_providers: DROP + CREATE (depends on base view).
--      Keeps WHERE is_public=true AND onboarding_done=true for defense-in-depth;
--      is_public is now also guaranteed by the base view.
--
--   3. Both discovery views: GRANT SELECT only. REVOKE INSERT/UPDATE/DELETE/
--      TRUNCATE/REFERENCES/TRIGGER from anon and authenticated. These views are
--      read-only public surfaces; write privs were over-granted by Supabase
--      default privileges and serve no purpose.
--
--   4. provider_media_tag_cooccur: ALTER VIEW SET (security_invoker=true).
--      provider_media has a working anon READ policy:
--        "Public can read provider media" ON {public} USING provider_is_public(provider_id)
--      (provider_is_public is SECURITY DEFINER, still executes elevated — safe).
--      Under security_invoker the view sees only public providers' published
--      media, so adjacency reflects only the public surface. Grant unchanged
--      (SELECT-only for anon+authenticated is already correct).
--
-- SCHEMA CACHE: NOTIFY pgrst at end — required because DROP+CREATE changes
-- view OIDs that PostgREST caches.

-- ── 1 + 2: discovery_providers + visible_discovery_providers ─────────────────

-- Drop dependent view first; grants are discarded with DROP.
DROP VIEW IF EXISTS public.visible_discovery_providers;
DROP VIEW IF EXISTS public.discovery_providers;

-- Rebuild base view WITH is_public = true guard.
-- Column set is identical to migration 20260602150000 — no app code change needed.
CREATE VIEW public.discovery_providers AS
  SELECT
    p.id            AS provider_id,
    p.profile_id,
    p.company_name,
    p.description,
    p.city,
    p.trade_categories,
    p.avatar_url,
    p.rating,
    COALESCE(
      (SELECT count(*)::integer FROM ratings r WHERE r.provider_user_id = pr.id),
      0
    )               AS rating_count,
    p.verified,
    p.is_public,
    p.created_at    AS provider_created_at,
    p.updated_at    AS provider_updated_at,
    pr.display_name,
    pr.craftsman_role,
    pr.onboarding_done,
    NULL::boolean   AS is_operator,   -- permanently redacted; kept as typed NULL for schema compat
    p.handle
  FROM providers p
  JOIN profiles pr ON pr.id = p.profile_id
  WHERE p.is_public = true;           -- M2: close anon enumeration of unpublished provider profiles

-- Grant SELECT only; Supabase default privileges re-apply DML grants on CREATE,
-- so explicit REVOKE follows immediately.
GRANT SELECT ON public.discovery_providers TO anon, authenticated, service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.discovery_providers FROM anon, authenticated;

-- Rebuild visible_discovery_providers.
-- is_public=true is now also guaranteed by the base view; keeping it here is
-- defense-in-depth and documents that this view is the fully-published surface.
CREATE VIEW public.visible_discovery_providers AS
  SELECT
    provider_id, profile_id, company_name, description, city, trade_categories,
    avatar_url, rating, rating_count, verified, is_public,
    provider_created_at, provider_updated_at, display_name,
    craftsman_role, onboarding_done, is_operator, handle
  FROM public.discovery_providers
  WHERE is_public     = true     -- redundant from base, kept for clarity
    AND onboarding_done = true;

GRANT SELECT ON public.visible_discovery_providers TO anon, authenticated, service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.visible_discovery_providers FROM anon, authenticated;

-- ── 4: provider_media_tag_cooccur ────────────────────────────────────────────

-- Flip to security_invoker so anon RLS on provider_media applies.
-- provider_media "Public can read provider media" policy (USING provider_is_public())
-- restricts to public providers' published media — adjacency data from private
-- providers is excluded. No grant change needed (already SELECT-only).
ALTER VIEW public.provider_media_tag_cooccur SET (security_invoker = true);

-- ── Schema cache ─────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

-- ── ROLLBACK (do not apply — document only) ──────────────────────────────────
-- DROP VIEW IF EXISTS public.visible_discovery_providers;
-- DROP VIEW IF EXISTS public.discovery_providers;
-- CREATE VIEW public.discovery_providers AS
--   SELECT p.id AS provider_id, p.profile_id, p.company_name, p.description,
--     p.city, p.trade_categories, p.avatar_url, p.rating,
--     COALESCE((SELECT count(*)::integer FROM ratings r WHERE r.provider_user_id = pr.id), 0)
--       AS rating_count,
--     p.verified, p.is_public, p.created_at AS provider_created_at,
--     p.updated_at AS provider_updated_at, pr.display_name, pr.craftsman_role,
--     pr.onboarding_done, NULL::boolean AS is_operator, p.handle
--   FROM providers p
--   JOIN profiles pr ON pr.id = p.profile_id;  -- NO is_public filter
-- CREATE VIEW public.visible_discovery_providers AS
--   SELECT provider_id, profile_id, company_name, description, city, trade_categories,
--     avatar_url, rating, rating_count, verified, is_public,
--     provider_created_at, provider_updated_at, display_name, craftsman_role,
--     onboarding_done, is_operator, handle
--   FROM public.discovery_providers
--   WHERE is_public = true AND onboarding_done = true;
-- GRANT SELECT ON public.discovery_providers         TO anon, authenticated, service_role;
-- GRANT SELECT ON public.visible_discovery_providers TO anon, authenticated, service_role;
-- ALTER VIEW public.provider_media_tag_cooccur SET (security_invoker = false);
-- NOTIFY pgrst, 'reload schema';
