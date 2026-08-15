-- Block 7.1B1 — Provider Tax & Billing Profile
--
-- Adds the steuerlich/zahlungsrelevant Pflichtdaten an den Handwerker-Profilen.
-- Diese Felder sind die Grundlage für §14-UStG-konforme Rechnungs-Issuance,
-- die in Folgeblöcken (7.1B2+) aufbaut.
--
-- Designprinzipien:
--   - Alle Felder NULL-fähig oder mit DEFAULT, damit bestehende rows valid
--     bleiben und das initiale Onboarding nicht erschwert wird.
--   - Validierung erfolgt app-seitig (siehe taxProfileSelectors), keine harten
--     CHECK-Constraints, die legacy rows invalidieren würden.
--   - Stripe-Connect-Auszahlungslogik bleibt in provider_payout_accounts —
--     iban/bic hier sind Profil-/Anzeigedaten, nicht Payout-Truth.
--   - default_vat_rate ist DEFAULT 19.00 (Regelsteuersatz DE); per UI können
--     auch 7 oder 0 gewählt werden. Keine Auto-Steuerlogik in 7.1B1.
--
-- IF NOT EXISTS macht die Migration idempotent.

ALTER TABLE providers
  ADD COLUMN IF NOT EXISTS tax_number TEXT,
  ADD COLUMN IF NOT EXISTS vat_id TEXT,
  ADD COLUMN IF NOT EXISTS legal_form TEXT,
  ADD COLUMN IF NOT EXISTS is_kleinunternehmer BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS default_vat_rate NUMERIC(5,2) NOT NULL DEFAULT 19.00,
  ADD COLUMN IF NOT EXISTS iban TEXT,
  ADD COLUMN IF NOT EXISTS bic TEXT;

COMMENT ON COLUMN providers.tax_number IS
  'Steuernummer beim Finanzamt (z. B. "12/345/67890"). Pflichtangabe auf §14-UStG-Rechnungen, sofern keine vat_id vorliegt.';
COMMENT ON COLUMN providers.vat_id IS
  'Umsatzsteuer-Identifikationsnummer (USt-IdNr., z. B. "DE123456789"). Alternative zur Steuernummer auf Rechnungen.';
COMMENT ON COLUMN providers.legal_form IS
  'Rechtsform des Betriebs. Erlaubte App-Werte: einzelunternehmer | gbr | gmbh | ug | ag | kg | ohg | sonstige.';
COMMENT ON COLUMN providers.is_kleinunternehmer IS
  'Kleinunternehmerregelung nach §19 UStG. Wenn TRUE, darf vat_id leer bleiben und auf Rechnungen wird der entsprechende Hinweistext gedruckt (Logik kommt in 7.1B2).';
COMMENT ON COLUMN providers.default_vat_rate IS
  'Standard-Mehrwertsteuersatz in Prozent (DEFAULT 19.00). Vorbelegung für neue Rechnungspositionen — keine automatische Steuerberatung.';
COMMENT ON COLUMN providers.iban IS
  'IBAN für Profil-/Rechnungsanzeige. NICHT identisch mit der Stripe-Connect-Auszahlungs-IBAN; Stripe bleibt Truth für Payouts.';
COMMENT ON COLUMN providers.bic IS
  'BIC zur IBAN (optional, in DE oft nicht notwendig).';
