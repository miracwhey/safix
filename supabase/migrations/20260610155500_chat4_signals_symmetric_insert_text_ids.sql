-- =============================================================================
-- CHAT-4 — notification_signals / timeline_signals
--   (1) id uuid→text (Prod-Drift: alle deterministischen Writer senden Text-Ids
--       — Bridge `notif-<uuid>[-c]` (notificationBridge.ts), Cron `reminder-…`
--       (api/_acceptanceReminder.ts), Webhook `timeline_<type>__<ref>`
--       (api/stripe-webhook.ts) — und werfen heute 22P02 VOR RLS; Repo-Kanon
--       20240800000000 ist `id text PRIMARY KEY`; beide Tabellen in Prod leer
--       (count=0, Dump 2026-06-10) → Rewrite trivial)
--   (2) INSERT-Policies symmetrisch: Autor muss Job-Partei sein (Kunde ODER
--       Provider/assigned Provider) — Kunde darf Signale für seine Jobs
--       schreiben, auch mit recipient_role='craftsman' (Gegenseite
--       benachrichtigen; Money-Flows deposit_paid / escrow_locked /
--       release_requested / dispute_opened laufen kundenseitig clientseitig)
--   (3) notification_signals SELECT/UPDATE: Provider-Join um
--       assigned_provider_id erweitert (strict widening, IN statt COALESCE —
--       reines COALESCE würde dem Ur-Provider bei gesetztem
--       assigned_provider_id Sichtbarkeit ENTZIEHEN = Narrowing)
--   (4) REVOKE-Hygiene PUBLIC + anon (anon hatte volle Default-Grants inkl.
--       TRUNCATE — TRUNCATE wird von RLS NICHT geschützt)
--
-- Geschrieben gegen LIVE-Prod-Dumps 2026-06-10 (pg_policy/pg_attribute/
-- pg_trigger, Salvage partial-CHAT-4.md), NICHT gegen Repo-Migrationsdateien
-- (Ledger-Drift). FK-Check: weder rescue-baseline (2026-04-29) noch irgendeine
-- Repo-Migration referenziert notification_signals.id / timeline_signals.id —
-- einzige Constraints sind die PKs + job_id-FKs Richtung jobs. Ein unbekannter
-- prod-seitiger FK würde ALTER TYPE laut fehlschlagen lassen (loud-fail).
--
-- EXTERNAL STEP: Repo-Datei only — NICHT automatisch applied. Apply im
-- Low-Traffic-Fenster (Realtime-publizierte Tabellen: ALTER TYPE erzwingt
-- kurze Locks + Subscription-Reconnect; bei 0 Rows trivial). Vor Apply den
-- Rest-Check aus dem Spec laufen lassen:
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid IN ('public.notification_signals'::regclass,
--                      'public.timeline_signals'::regclass)
--      OR confrelid IN ('public.notification_signals'::regclass,
--                       'public.timeline_signals'::regclass);
-- =============================================================================

-- (1) id-Typ angleichen. Dispatch-Trigger nutzt NEW.id nur in jsonb (text-safe);
--     keine FK/Policy referenziert id; PK-Index wird automatisch neu gebaut.
ALTER TABLE public.notification_signals
  ALTER COLUMN id DROP DEFAULT,
  ALTER COLUMN id TYPE text USING id::text,
  ALTER COLUMN id SET DEFAULT (gen_random_uuid())::text;

ALTER TABLE public.timeline_signals
  ALTER COLUMN id DROP DEFAULT,
  ALTER COLUMN id TYPE text USING id::text,
  ALTER COLUMN id SET DEFAULT (gen_random_uuid())::text;

-- (2a) notification_signals INSERT — symmetrisch.
--      NEW-Row-Spalten tabellenqualifiziert (Tautologie-Falle: unqualifizierte
--      Spalte in EXISTS resolved auf die Subquery-Tabelle). Kunden-Zweig
--      NULL-geguardet (Three-Valued-Logic). Provider-Zweig = Union aus
--      Live-INSERT-COALESCE und Live-SELECT-Join (provider_id UND assigned).
DROP POLICY IF EXISTS notification_signals_insert_own ON public.notification_signals;
CREATE POLICY notification_signals_insert_own ON public.notification_signals
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.jobs j
      WHERE j.id = notification_signals.job_id
        AND j.customer_user_id IS NOT NULL
        AND j.customer_user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.jobs j
      JOIN public.providers p
        ON p.id IN (j.provider_id, j.assigned_provider_id)
      WHERE j.id = notification_signals.job_id
        AND p.profile_id = auth.uid()
    )
  );

-- (2b) timeline_signals INSERT — identische Symmetrie (Live-Policy war
--      provider-only; Kunden-Money-Flows schreiben Timeline clientseitig).
DROP POLICY IF EXISTS timeline_signals_insert_own ON public.timeline_signals;
CREATE POLICY timeline_signals_insert_own ON public.timeline_signals
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.jobs j
      WHERE j.id = timeline_signals.job_id
        AND j.customer_user_id IS NOT NULL
        AND j.customer_user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.jobs j
      JOIN public.providers p
        ON p.id IN (j.provider_id, j.assigned_provider_id)
      WHERE j.id = timeline_signals.job_id
        AND p.profile_id = auth.uid()
    )
  );

-- (3) SELECT/UPDATE — Empfänger-Semantik unverändert; Provider-Join von
--     `p.id = j.provider_id` auf IN(provider_id, assigned_provider_id)
--     erweitert. Strict widening: jede heute sichtbare Row bleibt sichtbar;
--     assigned Provider sieht jetzt eigene Inserts + bekommt Realtime-Delivery
--     (Realtime respektiert die SELECT-Policy).
DROP POLICY IF EXISTS notification_signals_select_own ON public.notification_signals;
CREATE POLICY notification_signals_select_own ON public.notification_signals
  FOR SELECT TO authenticated
  USING (
    (notification_signals.recipient_role = 'craftsman' AND EXISTS (
      SELECT 1 FROM public.jobs j
      JOIN public.providers p
        ON p.id IN (j.provider_id, j.assigned_provider_id)
      WHERE j.id = notification_signals.job_id
        AND p.profile_id = auth.uid()
    ))
    OR (notification_signals.recipient_role = 'customer' AND EXISTS (
      SELECT 1 FROM public.jobs j
      WHERE j.id = notification_signals.job_id
        AND j.customer_user_id IS NOT NULL
        AND j.customer_user_id = auth.uid()
    ))
  );

DROP POLICY IF EXISTS notification_signals_update_own ON public.notification_signals;
CREATE POLICY notification_signals_update_own ON public.notification_signals
  FOR UPDATE TO authenticated
  USING (
    (notification_signals.recipient_role = 'craftsman' AND EXISTS (
      SELECT 1 FROM public.jobs j
      JOIN public.providers p
        ON p.id IN (j.provider_id, j.assigned_provider_id)
      WHERE j.id = notification_signals.job_id
        AND p.profile_id = auth.uid()
    ))
    OR (notification_signals.recipient_role = 'customer' AND EXISTS (
      SELECT 1 FROM public.jobs j
      WHERE j.id = notification_signals.job_id
        AND j.customer_user_id IS NOT NULL
        AND j.customer_user_id = auth.uid()
    ))
  );

-- timeline_signals_select_own bleibt UNVERÄNDERT (deckt laut Live-Dump bereits
-- beide Rollen: customer_user_id-OR + COALESCE-Provider-Join). Kein UPDATE/
-- DELETE auf timeline_signals → default-deny bleibt.

-- (4) REVOKE-Hygiene: anon hatte volle Default-Grants inkl. TRUNCATE
--     (TRUNCATE wird von RLS NICHT geschützt). authenticated braucht nur
--     SELECT/INSERT/UPDATE (kein Client-DELETE auf diesen Tabellen,
--     grep-verifiziert). service_role-Grants bleiben unberührt (BYPASSRLS);
--     SECDEF-Dispatch-Trigger läuft als Owner — Cron/Webhook/Edge unberührt.
REVOKE ALL ON public.notification_signals FROM PUBLIC, anon;
REVOKE ALL ON public.timeline_signals    FROM PUBLIC, anon;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.notification_signals FROM authenticated;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.timeline_signals    FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON public.notification_signals TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.timeline_signals    TO authenticated;

-- (5) Stale-PostgREST-Cache nach DDL
NOTIFY pgrst, 'reload schema';
