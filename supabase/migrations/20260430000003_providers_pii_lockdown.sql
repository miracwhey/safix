-- Block 7.1G — Provider PII Lockdown
--
-- providers enthält PII-Spalten (tax_number, vat_id, iban, bic,
-- business_address, is_kleinunternehmer, default_vat_rate). Die bisherige
-- Public-Policy `Public can read visible providers` mit USING (is_public=true)
-- gibt jeder anon-/authenticated-Rolle Spaltenzugriff auf diese PII, sobald
-- der Provider seine Profil-Sichtbarkeit aktiviert. Postgres-RLS arbeitet
-- zeilenweise — eine spaltengranulare Beschränkung über Policies ist nicht
-- möglich.
--
-- Saubere Trennung:
--   * Public-/Customer-/Worker-Reads laufen über die existierende View
--     `discovery_providers` bzw. den Wrapper `visible_discovery_providers`.
--     Diese geben nur nicht-sensitive Discovery-Felder aus.
--   * Direkter Zugriff auf `providers` ist auf den Owner reduziert (Owner-Read
--     via RLS-Policy `Providers: read own`).
--
-- Die View hat Owner=postgres und kein security_invoker → läuft als SECURITY
-- DEFINER und kann auch nach Drop der Public-Policy weiter Rows ausliefern.
-- Sie wird hier zusätzlich um is_operator erweitert, damit der bisherige
-- DiscoveryProvider-Mapper keine semantische Lücke bekommt.

-- 1) Public-Policy entfernen — Public-Browse erfolgt ab jetzt nur noch über die
-- View, nicht mehr über die Tabelle.
DROP POLICY IF EXISTS "Public can read visible providers" ON public.providers;

-- 2) Defense-in-depth: anon hat keinen Tabellen-Read mehr.
REVOKE SELECT ON public.providers FROM anon;

-- 3) discovery_providers View um is_operator erweitern (wird vom App-Mapper
-- konsumiert). Bestehende Spalten unverändert, nur is_operator hinzugefügt.
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
  'Block 7.1G: Public-/Discovery-Read-Surface ohne PII. providers-Tabelle ist nach 7.1G nur noch Owner-lesbar; Public-Reads konsumieren ausschließlich diese View.';
