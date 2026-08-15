-- ===========================================================================
-- E4 Legal — § 356a BGB Widerruf-Button + § 356 Abs. 4 Consent-Audit.
--
-- Kontext: § 356a BGB (Widerrufsfunktion, in Kraft 19.06.2026) verlangt für
-- kostenpflichtige Fernabsatzverträge über eine Online-Schnittstelle einen
-- leicht zugänglichen Widerruf-Button. Betroffen ist nur das SaFix-Pro-Abo
-- (SaFix = Vertragspartner). Die Handwerksleistung selbst betrifft den
-- jeweiligen Anbieter, nicht SaFix.
--
-- Diese Migration ist rein additiv (zwei neue Tabellen) und idempotent.
--   1. widerruf_requests                — Eingang einer Widerrufserklärung.
--   2. subscription_withdrawal_consents — Audit-Trail des § 356 Abs. 4 Verzichts
--                                          (sofortiger Leistungsbeginn) beim Kauf.
-- Beide append-only: kein UPDATE/DELETE für App-Rollen.
--
-- FK ON DELETE CASCADE (bewusst): Bei Konto-Löschung (Apple 5.1.1(v) / DSGVO
-- Art. 17) werden diese Zeilen mit-gelöscht. Der Lösch-Pfad (api/delete-account.ts
-- → account_cascade_delete_owned_rows) hängt an CASCADE/Drain; ein Wechsel auf
-- RESTRICT würde admin.deleteUser blockieren und den In-App-Löschpfad brechen.
-- Der § 356a/§ 356-Beweis bleibt erhalten über: (a) die dem Nutzer zugestellte
-- Eingangsbestätigungs-E-Mail (dauerhafter Datenträger) und (b) Apple-/Stripe-
-- Zahlungsbelege. Will man die Zeilen über die Löschung hinaus halten, ist ein
-- Anonymisieren (user_id → NULL) vor deleteUser nötig — dann mit Legal abstimmen.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. widerruf_requests — § 356a Widerrufserklärungen (SaFix Pro).
--    Insert erfolgt serverseitig über api/submit-widerruf.ts (service-role,
--    + Resend-Eingangsbestätigung = dauerhafter Datenträger, § 356a Abs. 3).
--    Die RLS-Policies erlauben dem Nutzer zusätzlich, eigene Anträge zu lesen.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.widerruf_requests (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  subject       text        NOT NULL DEFAULT 'SaFix Pro Abonnement',
  contact_email text        NOT NULL,
  status        text        NOT NULL DEFAULT 'received',
  declared_at   timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.widerruf_requests'::regclass
      AND conname = 'widerruf_requests_status_chk'
  ) THEN
    ALTER TABLE public.widerruf_requests
      ADD CONSTRAINT widerruf_requests_status_chk
      CHECK (status IN ('received', 'processed', 'rejected'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_widerruf_requests_user
  ON public.widerruf_requests (user_id);
CREATE INDEX IF NOT EXISTS idx_widerruf_requests_declared_at
  ON public.widerruf_requests (declared_at);

COMMENT ON TABLE public.widerruf_requests IS
  'Append-only Eingang von Widerrufserklärungen (§ 356a BGB) zum SaFix-Pro-Abo. Insert via api/submit-widerruf.ts (service-role); Nutzer dürfen eigene Zeilen lesen. Kein UPDATE/DELETE für App-Rollen.';

ALTER TABLE public.widerruf_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS widerruf_requests_insert_own ON public.widerruf_requests;
CREATE POLICY widerruf_requests_insert_own
  ON public.widerruf_requests FOR INSERT
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS widerruf_requests_select_own ON public.widerruf_requests;
CREATE POLICY widerruf_requests_select_own
  ON public.widerruf_requests FOR SELECT
  USING ((SELECT auth.uid()) = user_id);

-- Append-only: anon ohne jeden Zugriff, authenticated nur SELECT + INSERT
-- (kein UPDATE/DELETE/TRUNCATE). Idiom wie moderation_action_log.
REVOKE ALL ON public.widerruf_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.widerruf_requests TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. subscription_withdrawal_consents — § 356 Abs. 4 Verzichts-Audit.
--    Beim Pro-Kauf bestätigt der Nutzer sofortigen Leistungsbeginn + Erlöschen
--    des Widerrufsrechts. Diese Zeile ist der Beweis-Trail. Insert clientseitig
--    (RLS-scoped auf die eigene user_id), append-only.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.subscription_withdrawal_consents (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  package_id           text        NOT NULL,
  consent_text_version text        NOT NULL DEFAULT 'v1',
  consented_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscription_withdrawal_consents_user
  ON public.subscription_withdrawal_consents (user_id);

COMMENT ON TABLE public.subscription_withdrawal_consents IS
  'Append-only Audit-Trail der § 356 Abs. 4 Einwilligung (sofortiger Leistungsbeginn, Erlöschen des Widerrufsrechts) beim SaFix-Pro-Kauf. Nutzer schreibt/liest nur eigene Zeilen. Kein UPDATE/DELETE für App-Rollen.';

ALTER TABLE public.subscription_withdrawal_consents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS subscription_withdrawal_consents_insert_own ON public.subscription_withdrawal_consents;
CREATE POLICY subscription_withdrawal_consents_insert_own
  ON public.subscription_withdrawal_consents FOR INSERT
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS subscription_withdrawal_consents_select_own ON public.subscription_withdrawal_consents;
CREATE POLICY subscription_withdrawal_consents_select_own
  ON public.subscription_withdrawal_consents FOR SELECT
  USING ((SELECT auth.uid()) = user_id);

REVOKE ALL ON public.subscription_withdrawal_consents FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.subscription_withdrawal_consents TO authenticated;

-- PostgREST-Schemacache nach Tabellen-Erstellung neu laden.
NOTIFY pgrst, 'reload schema';
