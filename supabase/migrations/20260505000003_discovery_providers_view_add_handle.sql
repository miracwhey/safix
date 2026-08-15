-- 20260505000003_discovery_providers_view_add_handle.sql
--
-- Extend `public.discovery_providers` (PII-free public-read surface) with
-- `handle` so the Reels Item-Feed can render a stable @user identifier
-- without falling back to the slug helper.
--
-- Pre-state (verified live 2026-05-05):
--   discovery_providers columns: provider_id, profile_id, company_name,
--   description, city, trade_categories, avatar_url, rating, rating_count,
--   verified, is_public, provider_created_at, provider_updated_at,
--   display_name, phone, role, craftsman_role, onboarding_done, is_operator.
--   `handle` is missing.
--   100% of providers in prod have a non-empty handle (4/4) — switching the
--   App-side query from `providers!inner` to discovery_providers without
--   `handle` would regress every existing card to the slug fallback.
--
-- Why include in the public view
--   `handle` is a user-chosen public identifier (the @username surface). It
--   does NOT carry PII; it is intentionally rendered to all viewers in
--   profile screens and reels. Inclusion here is consistent with the view's
--   purpose (PII-free public-read).
--
-- Note on column ordering
--   PostgreSQL's `CREATE OR REPLACE VIEW` only permits *appending* columns to
--   the existing column list — inserting a new column in the middle is
--   rejected (42P16). `handle` is therefore appended as the last column.
--   The App layer projects by name, so position is irrelevant.
--
-- Idempotent: CREATE OR REPLACE VIEW preserves grants; explicit GRANTs at the
-- end act as defense-in-depth.

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
  COALESCE(( SELECT count(*)::integer
               FROM ratings r
              WHERE r.provider_user_id = pr.id), 0) AS rating_count,
  p.verified,
  p.is_public,
  p.created_at                AS provider_created_at,
  p.updated_at                AS provider_updated_at,
  pr.display_name,
  pr.phone,
  pr.role,
  pr.craftsman_role,
  pr.onboarding_done,
  pr.is_operator,
  p.handle
FROM public.providers p
JOIN public.profiles pr ON pr.id = p.profile_id;

GRANT SELECT ON public.discovery_providers          TO anon, authenticated;
GRANT SELECT ON public.visible_discovery_providers  TO anon, authenticated;
