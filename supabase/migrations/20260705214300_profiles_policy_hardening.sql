-- @-Handle-System · Block H2b — profiles-Policy-Härtung (Ansatz B)
--
-- Schließt die größte PII-/Enumeration-Flanke: die tabellenweite SELECT-Policy
-- „Public can read onboarded profiles" gilt bislang für PUBLIC (= anon UND
-- authenticated). Ein NICHT eingeloggter Client kann damit alle onboarded
-- Profile inkl. `phone` enumerieren.
--
-- Ansatz B (bewusst minimal, kein Client-Breaking): die Policy auf `authenticated`
-- einschränken. Damit verliert anon jeglichen Direkt-Lesezugriff auf profiles
-- (keine SELECT-Policy → RLS default-deny), während eingeloggte Consumer
-- unberührt bleiben:
--   • eigene Reads (`profile.ts`, alle `.eq('id', auth.uid())`)  — eigene Policies
--   • Fremd-Reads via authenticated (`ratingDistributionService`, embedded
--     Join `portfolioCommentService author:profiles(display_name)`) — laufen weiter
-- Öffentliche Provider-Discovery läuft über die owner-ausgeführte
-- `discovery_providers`-View → unabhängig von dieser Policy.
--
-- NICHT enthalten (bewusst, eigener späterer Schritt = „Ansatz A"): Spalten-
-- Minimierung (phone aus Fremd-Reads eingeloggter User) via `public_profiles`-
-- View. Erfordert Repoint des embedded FK-Joins mit PostgREST-Smoke — separater
-- Commit. Diese Migration kappt nur den anon-Leak.
--
-- Risk-Flag laut Plan: höchstes Breaking-Potential → eigener Commit, eigener
-- Device-/PostgREST-Smoke nach Apply (SET ROLE anon liefert 0 Rows).

DROP POLICY IF EXISTS "Public can read onboarded profiles" ON public.profiles;

CREATE POLICY "Authenticated can read onboarded profiles" ON public.profiles
  FOR SELECT
  TO authenticated
  USING (onboarding_done = true);

-- anon behält keinen Lesezugriff mehr (keine Policy). GRANT bleibt unberührt;
-- RLS default-deny genügt. Kein REVOKE nötig.

NOTIFY pgrst, 'reload schema';
