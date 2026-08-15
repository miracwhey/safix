-- E4 Legal-Overhaul: Provider-Terms-Akzeptanz + erzwungene ToS-Neuannahme.
--
-- Kontext: Die Rechtstexte wurden materiell überarbeitet (neue Kunden-AGB B2C,
-- überarbeitete Datenschutzerklärung) und um die nach Apple-Guideline 1.2
-- erforderlichen Nutzungs-/Community-Richtlinien (EULA) erweitert. Außerdem
-- gibt es nun gesonderte Anbieterbedingungen (B2B) inkl. AVV-Anlage, die
-- Handwerksbetriebe aktiv akzeptieren.

-- 1. Akzeptanz der Anbieterbedingungen (B2B-AGB) + AVV durch Betriebe.
--    Wird im Handwerker-Onboarding gesetzt (acceptProviderTerms).
alter table public.profiles
  add column if not exists provider_terms_accepted_at timestamptz;

comment on column public.profiles.provider_terms_accepted_at is
  'Zeitpunkt, zu dem ein Handwerks-Inhaber die Anbieterbedingungen (B2B-AGB) + AVV akzeptiert hat. NULL = noch nicht akzeptiert.';

-- 2. Erzwinge Neuannahme der überarbeiteten Rechtstexte (inkl. neuer EULA,
--    Apple 1.2). Bestehende Zustimmungen datieren vor diesen Dokumenten und
--    decken die neue EULA/Community-Richtlinie nicht ab.
update public.profiles
  set tos_accepted_at = null
  where tos_accepted_at is not null;

-- PostgREST-Schemacache nach Spaltenänderung neu laden.
notify pgrst, 'reload schema';
