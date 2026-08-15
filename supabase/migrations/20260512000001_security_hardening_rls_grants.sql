-- =============================================================================
-- Block 0.5 — Security Hardening
-- =============================================================================
-- Behebt 4 Klassen von Sicherheitslücken (Repo-Prod-Drift + Default-PUBLIC-Grants):
--
--   (1) RLS off auf public.messages + public.conversations + 0 Policies
--       (Drift gegen Repo-Migrationen 20240400000000 und 20260317000007).
--       Restoriert intended state — App-Code erwartet RLS-on bereits
--       (siehe SupabaseMessageRepository.ts Inline-Kommentar).
--
--   (2) 20 SECURITY DEFINER RPCs sind anon-callable per Default (Bucket A).
--       App ruft sie aus authenticated Context — REVOKE FROM anon ist sicher.
--
--   (3) 5 trigger-only / definer-internal RPCs sind public-callable (Bucket B).
--       Trigger laufen mit owner-Privilegien, REST-Zugriff nicht nötig.
--
--   (4) 13 SECURITY DEFINER Views haben Voll-DML-Grants für anon+authenticated
--       (INSERT/UPDATE/DELETE/TRIGGER/TRUNCATE). Views sind nicht writable —
--       Grants sind nur Lärm + Risiko. SELECT-Klassifikation: 3 public, 10 auth-only.
--
--   (5) 3 RLS-always-true INSERT-Policies (analytics_events, dispute_evidence,
--       payment_status_history) → Härtung auf eigene-User-only oder false.
--
--   (6) Vestigial RPC become_provider (kein Code-Caller mehr) → REVOKE komplett.
--
-- KEINE App-Code-Änderungen, KEINE Schema-Migrationen, KEINE neuen Tabellen.
-- Atomar in Transaction. Reversal-Pfad in Section R unten dokumentiert.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- SECTION 1 — RLS Re-Activation für public.messages und public.conversations
-- -----------------------------------------------------------------------------
-- Idempotent: ENABLE ist no-op wenn schon enabled.
-- Policies: DROP IF EXISTS + CREATE → matcht 20260317000007 Quelle.

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages      ENABLE ROW LEVEL SECURITY;

-- conversations
-- HINWEIS: Prod-Schema hat conversations.{craftsman,customer}_user_id und
-- messages.sender_user_id als uuid (NICHT text wie Repo-Migration 20260317000007
-- deklariert). Daher direkter uuid=uuid-Vergleich, kein ::text-Cast.
DROP POLICY IF EXISTS conversations_select_own ON public.conversations;
CREATE POLICY conversations_select_own ON public.conversations
  FOR SELECT TO authenticated USING (
    craftsman_user_id = auth.uid()
    OR customer_user_id = auth.uid()
  );

DROP POLICY IF EXISTS conversations_insert_own ON public.conversations;
CREATE POLICY conversations_insert_own ON public.conversations
  FOR INSERT TO authenticated WITH CHECK (
    customer_user_id = auth.uid()
  );

DROP POLICY IF EXISTS conversations_update_own ON public.conversations;
CREATE POLICY conversations_update_own ON public.conversations
  FOR UPDATE TO authenticated USING (
    craftsman_user_id = auth.uid()
    OR customer_user_id = auth.uid()
  ) WITH CHECK (
    craftsman_user_id = auth.uid()
    OR customer_user_id = auth.uid()
  );

-- messages
DROP POLICY IF EXISTS messages_select_own ON public.messages;
CREATE POLICY messages_select_own ON public.messages
  FOR SELECT TO authenticated USING (
    conversation_id IN (
      SELECT id FROM public.conversations
      WHERE craftsman_user_id = auth.uid()
         OR customer_user_id  = auth.uid()
    )
  );

DROP POLICY IF EXISTS messages_insert_own ON public.messages;
CREATE POLICY messages_insert_own ON public.messages
  FOR INSERT TO authenticated WITH CHECK (
    conversation_id IN (
      SELECT id FROM public.conversations
      WHERE craftsman_user_id = auth.uid()
         OR customer_user_id  = auth.uid()
    )
  );

-- REVOKE Voll-DML von anon (RLS allein reicht NICHT — Default-Grants sind eine
-- separate Schicht). authenticated behält INSERT/UPDATE/SELECT, aber nicht DELETE.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.conversations FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.messages      FROM anon;
REVOKE DELETE, TRUNCATE                 ON public.conversations FROM authenticated;
REVOKE DELETE, TRUNCATE                 ON public.messages      FROM authenticated;

-- -----------------------------------------------------------------------------
-- SECTION 2 — RPC EXECUTE-Privilegien Hardening
-- -----------------------------------------------------------------------------

-- Bucket A: REVOKE FROM anon, GRANT TO authenticated (20 RPCs)
DO $$
DECLARE
  fn_signature text;
  fn_signatures text[] := ARRAY[
    'public.confirm_funding_atomic(uuid, uuid, text)',
    'public.finalize_payment_state_atomic(text, text, text, text, numeric)',
    'public.open_dispute_atomic(uuid, uuid, text, text, text, uuid, jsonb, jsonb, timestamp with time zone)',
    'public.start_trial()',
    'public.ensure_subscription_row()',
    'public.create_team_member_stub(uuid, text, text, text, text, numeric, numeric)',
    'public.deactivate_team_member(uuid)',
    'public.reactivate_team_member(uuid)',
    'public.update_team_member(uuid, text, text, text, text, numeric, numeric)',
    'public.leave_company()',
    'public.join_company_with_code(text, text)',
    'public.rotate_company_code(uuid, text)',
    'public.get_or_create_assignment_thread(uuid)',
    'public.get_or_create_office_thread()',
    'public.get_or_create_team_thread()',
    'public.record_push_action_attempt(uuid, text)',
    'public.reassign_job_member(uuid, text, text)',
    'public.is_current_user_operator()',
    'public.increment_craftsman_jobs_count(text)',
    'public.get_customer_billing_for_invoice(uuid)'
  ];
BEGIN
  FOREACH fn_signature IN ARRAY fn_signatures LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, public', fn_signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn_signature);
  END LOOP;
END $$;

-- Bucket B: REVOKE FROM PUBLIC (Trigger-only / Definer-internal, 5 RPCs)
DO $$
DECLARE
  fn_signature text;
  fn_signatures text[] := ARRAY[
    'public.notification_signals_dispatch_push()',
    'public.notification_push_recipient(uuid, text)',
    'public.fn_update_thread_last_message()',
    'public.generate_invoice_number()',
    'public.generate_unique_company_code()'
  ];
BEGIN
  FOREACH fn_signature IN ARRAY fn_signatures LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM public, anon, authenticated', fn_signature);
  END LOOP;
END $$;

-- Bucket D: handle_new_user (Auth-System-Trigger; läuft mit postgres-Role,
-- nicht via REST-API — anon/authenticated EXECUTE nicht nötig)
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon, authenticated, public;

-- Vestigial: become_provider (kein Code-Caller im Repo) — komplett REVOKE.
-- Falls Onboarding-Pfad wieder benötigt: GRANT EXECUTE TO authenticated zurück.
REVOKE EXECUTE ON FUNCTION public.become_provider(text, text) FROM public, anon, authenticated;

-- Bucket C bleibt unverändert (bewusst public read-only Helper):
--   is_blocked, provider_is_public, get_provider_median_response_ms

-- -----------------------------------------------------------------------------
-- SECTION 3 — View-Privilegien Hardening
-- -----------------------------------------------------------------------------
-- Alle 13 SECURITY DEFINER Views haben heute anon+authenticated Voll-DML-Grants
-- (INSERT/UPDATE/DELETE/TRIGGER/TRUNCATE/REFERENCES). Views sind nicht writable
-- → Grants sind Lärm + Angriffsfläche.
--
-- SELECT-Klassifikation:
--   • 3 Public (anon SELECT bleibt): discovery_providers, visible_discovery_providers, provider_media_tag_cooccur
--   • 5 Auth-only User-Views: job_details, job_assignment_details, dispute_details, dispute_ops_overview, payment_lifecycle_overview
--   • 5 Auth-only Operator/Owner-Views (App-Gate via is_current_user_operator()):
--     payment_details, payment_reconciliation_details, payment_risk_overview, team_member_details, job_integrity_overview
--
-- HINWEIS: security_invoker=true Recreate ist NICHT in diesem Block (verhalten-
-- ändernd, eigener Folge-Block). Hier nur Privilege-Reduktion.

DO $$
DECLARE
  v_name text;
  public_views   text[] := ARRAY['discovery_providers', 'visible_discovery_providers', 'provider_media_tag_cooccur'];
  auth_views     text[] := ARRAY['job_details', 'job_assignment_details', 'dispute_details', 'dispute_ops_overview', 'payment_lifecycle_overview'];
  operator_views text[] := ARRAY['payment_details', 'payment_reconciliation_details', 'payment_risk_overview', 'team_member_details', 'job_integrity_overview'];
BEGIN
  -- Alle Views: REVOKE Voll-DML-Grants (Views sind nicht updatable)
  FOREACH v_name IN ARRAY (public_views || auth_views || operator_views) LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRIGGER, TRUNCATE, REFERENCES ON public.%I FROM anon, authenticated, public', v_name);
  END LOOP;

  -- Public Views: SELECT für anon bleibt
  FOREACH v_name IN ARRAY public_views LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO anon, authenticated', v_name);
  END LOOP;

  -- Auth-only User-Views: SELECT nur für authenticated
  FOREACH v_name IN ARRAY auth_views LOOP
    EXECUTE format('REVOKE SELECT ON public.%I FROM anon, public', v_name);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', v_name);
  END LOOP;

  -- Auth-only Operator/Owner-Views: SELECT nur für authenticated
  -- (Operator-Gating via is_current_user_operator() in App-Layer / View-Filter)
  FOREACH v_name IN ARRAY operator_views LOOP
    EXECUTE format('REVOKE SELECT ON public.%I FROM anon, public', v_name);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', v_name);
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- SECTION 4 — RLS-Always-True INSERT-Policies härten
-- -----------------------------------------------------------------------------

-- analytics_events: User darf nur eigene Events einfügen (Spalte heißt actor_user_id, uuid).
-- actor_user_id IS NULL erlaubt für system-/anonyme Events (z.B. Server-Side-Pipeline).
DROP POLICY IF EXISTS "Authenticated users can insert analytics events" ON public.analytics_events;
CREATE POLICY analytics_events_insert_self ON public.analytics_events
  FOR INSERT TO authenticated WITH CHECK (
    actor_user_id = auth.uid() OR actor_user_id IS NULL
  );

-- payment_status_history: rein Trigger-fed; authenticated darf NIE direkt schreiben
DROP POLICY IF EXISTS "Authenticated users can insert payment status history" ON public.payment_status_history;
CREATE POLICY payment_status_history_insert_block ON public.payment_status_history
  FOR INSERT TO authenticated WITH CHECK (false);

-- dispute_evidence: kanonischer Pfad ist disputes.metadata.shared_evidence_ids
-- (Memory: feedback_disputes_metadata_jsonb_canonical.md). Tabelle ist tot, aber
-- nicht gedropped. Härten auf uploaded_by_profile_id = auth.uid().
-- DROP der Tabelle wartet auf Slice 6 (Dispute-Block).
DROP POLICY IF EXISTS "Authenticated users can insert dispute evidence" ON public.dispute_evidence;
CREATE POLICY dispute_evidence_insert_self ON public.dispute_evidence
  FOR INSERT TO authenticated WITH CHECK (
    uploaded_by_profile_id = auth.uid()
  );

COMMIT;

-- =============================================================================
-- Section R — Reversal-Plan (NICHT auto-ausgeführt)
-- =============================================================================
-- Bei unerwarteter App-Bruch nach Apply, manuell ausführen:
--
-- 1. RLS-Off + Voll-DML zurück (Re-Drift):
--    ALTER TABLE public.messages      DISABLE ROW LEVEL SECURITY;
--    ALTER TABLE public.conversations DISABLE ROW LEVEL SECURITY;
--    GRANT INSERT, UPDATE, DELETE, TRUNCATE ON public.conversations TO anon, authenticated;
--    GRANT INSERT, UPDATE, DELETE, TRUNCATE ON public.messages      TO anon, authenticated;
--    DROP POLICY IF EXISTS conversations_select_own ON public.conversations;
--    DROP POLICY IF EXISTS conversations_insert_own ON public.conversations;
--    DROP POLICY IF EXISTS conversations_update_own ON public.conversations;
--    DROP POLICY IF EXISTS messages_select_own ON public.messages;
--    DROP POLICY IF EXISTS messages_insert_own ON public.messages;
--
-- 2. RPC-Revoke zurück (Bucket A — 20 Funktionen):
--    GRANT EXECUTE ON FUNCTION public.<fn_signature> TO anon, public;
--    (Liste aus SECTION 2 oben anwenden)
--
-- 3. Bucket B / D Revoke zurück:
--    GRANT EXECUTE ON FUNCTION public.<fn> TO public, anon, authenticated;
--
-- 4. View-Grants zurück (alle 13 Views):
--    GRANT INSERT, UPDATE, DELETE, TRIGGER, TRUNCATE, REFERENCES ON public.<view> TO anon, authenticated;
--    GRANT SELECT ON public.<view> TO anon, authenticated;  (für 10 ehemals-restricted)
--
-- 5. INSERT-Policy-Härtung zurück:
--    DROP POLICY IF EXISTS analytics_events_insert_self ON public.analytics_events;
--    CREATE POLICY "Authenticated users can insert analytics events" ON public.analytics_events
--      FOR INSERT TO authenticated WITH CHECK (true);
--    DROP POLICY IF EXISTS payment_status_history_insert_block ON public.payment_status_history;
--    CREATE POLICY "Authenticated users can insert payment status history" ON public.payment_status_history
--      FOR INSERT TO authenticated WITH CHECK (true);
--    DROP POLICY IF EXISTS dispute_evidence_insert_self ON public.dispute_evidence;
--    CREATE POLICY "Authenticated users can insert dispute evidence" ON public.dispute_evidence
--      FOR INSERT TO authenticated WITH CHECK (true);
-- =============================================================================
