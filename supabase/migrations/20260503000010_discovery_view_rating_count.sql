-- Block 1 — Customer Discovery: View um rating_count erweitern.
--
-- Bisher liefert discovery_providers nur den aggregierten Schnitt (providers.rating)
-- ohne den zugrundeliegenden Count. Der App-Mapper hardcoded rating_count auf 0,
-- daher wird in jeder Card "★ 4.5 (0)" angezeigt — irreführend.
--
-- Diese Migration fügt einen scalar-aggregierten rating_count aus der ratings-Tabelle
-- hinzu. Sortierung/Filterung an PII-Lockdown-Garantien (Block 7.1G) ändert sich
-- nicht: discovery_providers bleibt Public-Read-Surface ohne sensible Spalten.

CREATE OR REPLACE VIEW public.discovery_providers AS
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

CREATE OR REPLACE VIEW public.visible_discovery_providers AS
SELECT *
FROM public.discovery_providers
WHERE is_public = true
  AND onboarding_done = true;

GRANT SELECT ON public.discovery_providers          TO anon, authenticated;
GRANT SELECT ON public.visible_discovery_providers  TO anon, authenticated;

COMMENT ON VIEW public.discovery_providers IS
  'Block 7.1G + Discovery-1: Public-/Discovery-Read-Surface ohne PII, inkl. rating_count.';
