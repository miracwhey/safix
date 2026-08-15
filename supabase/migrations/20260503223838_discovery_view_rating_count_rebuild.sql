-- Block 3 Follow-up — discovery_providers View force-rebuild.
--
-- Findings (siehe PR #830 R1): die Block-1-Migration `20260503000010` war in
-- #828 gemergte aber nicht auf prod-Supabase ausgeführt. Die in prod live
-- liegende ältere View enthielt `rating_count` nicht in der Spaltenliste.
-- `CREATE OR REPLACE VIEW` lehnt eine Mid-list-Spalte mit
-- `42P16: cannot change name of view column "verified" to "rating_count"`
-- ab. Diese Migration droppt View + abhängige `visible_discovery_providers`
-- vorher mit CASCADE und legt beide frisch an.
--
-- Idempotent: läuft sauber auf jedem prod- und dev-Stand. Auf frischen
-- Installern, die `20260503000010` zuvor angewendet haben, ist der DROP
-- IF EXISTS / CREATE-Pfad ein No-op-Replace.

DROP VIEW IF EXISTS public.visible_discovery_providers;
DROP VIEW IF EXISTS public.discovery_providers;

CREATE VIEW public.discovery_providers AS
SELECT
  p.id                        AS provider_id,
  p.profile_id,
  p.company_name,
  p.description,
  p.city,
  p.trade_categories,
  p.avatar_url,
  p.rating,
  COALESCE((
    SELECT COUNT(*)::int
    FROM public.ratings r
    WHERE r.provider_user_id = pr.id
  ), 0)                       AS rating_count,
  p.verified,
  p.is_public,
  p.created_at                AS provider_created_at,
  p.updated_at                AS provider_updated_at,
  pr.display_name,
  pr.phone,
  pr.role,
  pr.craftsman_role,
  pr.onboarding_done,
  pr.is_operator
FROM public.providers p
JOIN public.profiles pr ON pr.id = p.profile_id;

CREATE VIEW public.visible_discovery_providers AS
SELECT *
FROM public.discovery_providers
WHERE is_public = true
  AND onboarding_done = true;

GRANT SELECT ON public.discovery_providers          TO anon, authenticated;
GRANT SELECT ON public.visible_discovery_providers  TO anon, authenticated;

COMMENT ON VIEW public.discovery_providers IS
  'Block 7.1G + Discovery-1: Public-/Discovery-Read-Surface ohne PII, inkl. rating_count.';
