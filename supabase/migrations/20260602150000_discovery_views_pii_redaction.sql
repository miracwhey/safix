-- Discovery views PII redaction — 2026-06-02
--
-- `discovery_providers` (anon+authenticated readable, SECURITY DEFINER → bypasses
-- providers/profiles RLS) exposed pr.phone (PII), pr.is_operator (operator-account
-- enumeration) and pr.role, with NO is_public filter. The app reads these views in
-- 5 places but selects NONE of phone/role, and only selects is_operator/craftsman_role
-- without ever reading them (verified by full repo trace).
--
-- Fix: rebuild both views without phone and role, and redact is_operator to NULL.
--   * phone / role are dropped outright (no consumer).
--   * is_operator is kept as a NULL column (not dropped) so the currently-deployed
--     app — which still SELECTs is_operator until the paired app change ships — does
--     not hit 42703. The value is always NULL → operator enumeration is closed now.
--   * craftsman_role is kept (non-sensitive, still selected by the app).
--
-- The views stay SECURITY DEFINER (default): providers has no anon SELECT policy, so
-- flipping to security_invoker=true would blank discovery for anon. The remaining
-- security_definer_view advisor ERRORs on these 3 discovery views are accepted —
-- now that no PII is in the column set.
--
-- visible_discovery_providers depends on discovery_providers → drop it first, then
-- recreate base, then recreate the filtered view. Grants are re-established (DROP
-- discards them).

DROP VIEW IF EXISTS public.visible_discovery_providers;
DROP VIEW IF EXISTS public.discovery_providers;

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
    COALESCE((SELECT count(*)::integer FROM ratings r WHERE r.provider_user_id = pr.id), 0) AS rating_count,
    p.verified,
    p.is_public,
    p.created_at    AS provider_created_at,
    p.updated_at    AS provider_updated_at,
    pr.display_name,
    pr.craftsman_role,
    pr.onboarding_done,
    NULL::boolean   AS is_operator,   -- redacted (was pr.is_operator): operator-account enumeration
    p.handle
  FROM providers p
  JOIN profiles pr ON pr.id = p.profile_id;

CREATE VIEW public.visible_discovery_providers AS
  SELECT
    provider_id, profile_id, company_name, description, city, trade_categories,
    avatar_url, rating, rating_count, verified, is_public,
    provider_created_at, provider_updated_at, display_name,
    craftsman_role, onboarding_done, is_operator, handle
  FROM discovery_providers
  WHERE is_public = true AND onboarding_done = true;

GRANT SELECT ON public.discovery_providers         TO anon, authenticated, service_role;
GRANT SELECT ON public.visible_discovery_providers TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
