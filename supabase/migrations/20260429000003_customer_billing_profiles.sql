-- Block 7.1B2 — Customer Billing Profile
--
-- Persistente Rechnungsdaten des Auftraggebers (Customer). Voraussetzung für
-- §14-UStG-konforme Rechnungs-Issuance, die in Folgeblöcken (7.1B3+) als
-- Hard-Gate scharfgeschaltet wird. In B2 wird das Profil nur erfasst und
-- vor dem Funding-Confirm sichtbar gemacht — keine bestehende Issuance-/
-- Payment-/Escrow-State-Machine wird hier verändert.
--
-- Designprinzipien:
--   - Eigene Tabelle, kein zweiter Mirror auf `profiles`. Single Source of
--     Truth für Customer-Rechnungsdaten.
--   - `user_id` als Owner-Key + UNIQUE — exakt eine Billing-Row pro
--     Auth-User. ON DELETE CASCADE, damit der Profil-Datensatz mit dem
--     Auth-User mitgeht.
--   - RLS so eng wie möglich: Owner liest und schreibt nur die eigene Row,
--     niemand sonst sieht sie. Kein Service-Role-Bypass nötig — Issuance-
--     Snapshots werden in 7.1B3+ über eine SECURITY DEFINER RPC erfolgen.
--   - Validierung erfolgt app-seitig (siehe customerBillingProfileSelectors).
--     Keine harten CHECK-Constraints, die spätere Bestandsdaten invalidieren.
--   - Idempotent via IF NOT EXISTS / DROP POLICY IF EXISTS.

CREATE TABLE IF NOT EXISTS customer_billing_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  billing_name TEXT,
  billing_address_line1 TEXT,
  billing_address_line2 TEXT,
  billing_postal_code TEXT,
  billing_city TEXT,
  billing_country TEXT NOT NULL DEFAULT 'DE',
  billing_email TEXT,
  billing_phone TEXT,
  is_business BOOLEAN NOT NULL DEFAULT FALSE,
  business_name TEXT,
  vat_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE customer_billing_profiles IS
  'Persistente Rechnungsdaten des Auftraggebers (Block 7.1B2). Eindeutig pro user_id. Wird in 7.1B3+ als Snapshot in Invoice eingefroren — die Row hier ist nur Profil-Truth, keine Invoice-Truth.';

COMMENT ON COLUMN customer_billing_profiles.user_id IS
  'Owner-Key — auth.uid() / profiles.id. UNIQUE: exakt eine Billing-Profile-Row pro User.';
COMMENT ON COLUMN customer_billing_profiles.billing_name IS
  'Vollständiger Name auf der Rechnung (Privatkunde) oder Ansprechpartner.';
COMMENT ON COLUMN customer_billing_profiles.billing_country IS
  'ISO-3166-1-Alpha-2-Länderkürzel. Default DE — Issuance-Logik in B3 wird länderspezifische Steuerregeln daran festmachen.';
COMMENT ON COLUMN customer_billing_profiles.is_business IS
  'TRUE wenn Geschäftskunde — entsperrt business_name und vat_id im UI. Keine §13b-Reverse-Charge-Aktivierung in B2.';
COMMENT ON COLUMN customer_billing_profiles.vat_id IS
  'USt-IdNr. des Geschäftskunden (optional). Spätere §13b-Logik wird hier ansetzen — in B2 nur erfasst.';

ALTER TABLE customer_billing_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS customer_billing_profiles_select_own ON customer_billing_profiles;
CREATE POLICY customer_billing_profiles_select_own ON customer_billing_profiles
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS customer_billing_profiles_insert_own ON customer_billing_profiles;
CREATE POLICY customer_billing_profiles_insert_own ON customer_billing_profiles
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS customer_billing_profiles_update_own ON customer_billing_profiles;
CREATE POLICY customer_billing_profiles_update_own ON customer_billing_profiles
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- DELETE bewusst nicht erlaubt: das Profil bleibt zur Issuance-Snapshot-
-- Auflösbarkeit historisch verfügbar, bis der Auth-User selbst gelöscht
-- wird (CASCADE oben). UI bietet keinen Lösch-Pfad an.
