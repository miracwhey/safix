-- =============================================================================
-- Hardening Phase 1 (Audit 2026-07-06): H2/H3/M4/M5 + systemischer Sweep
-- Legacy-Tabellen an RLS-Sweeps vorbei + anon/authenticated Write-Grants.
-- Live-verifiziert vor Apply (2026-07-06): alle 3 Legacy-Tabellen 0 Rows,
-- keine Code-Refs; attribution_audit_log + ledger_entries haben keine
-- INSERT-Policy (REST-Writes waren schon RLS-denied) -> Grants-Revoke ist
-- reine Defense-in-Depth, kein Verhaltens-Change.
-- Applied to prod itdntawwuzqfwmcwnwjr as 20260706090721.
-- =============================================================================

-- H2: stripe_events SELECT USING(true) -- jeder Authenticated las rohe Stripe-Payloads
drop policy if exists "Authenticated users can read stripe events" on public.stripe_events;

-- H3: payment_status_history SELECT USING(true) -- FSM-Historie world-readable
drop policy if exists "Authenticated users can read payment status history" on public.payment_status_history;

-- M4: dispute_evidence SELECT USING(true) + INSERT-Policy -- Dead-Path (Evidence
-- lebt in disputes.metadata), 0 Rows, kein from('dispute_evidence')
drop policy if exists "Authenticated users can read dispute evidence" on public.dispute_evidence;
drop policy if exists "dispute_evidence_insert_self" on public.dispute_evidence;

-- M5: Write-Grants (inkl. TRUNCATE, das nicht RLS-gated ist)
-- Tote Legacy-Tabellen: kompletter Client-Zugriff weg
revoke select, insert, update, delete, truncate
  on public.stripe_events, public.payment_status_history, public.dispute_evidence
  from anon, authenticated;

-- Append-only Audit/Ledger ohne Client-INSERT-Policy: alle Writes weg
revoke insert, update, delete, truncate
  on public.attribution_audit_log, public.ledger_entries
  from anon, authenticated;

-- Tabellen mit legitimen policy-gated Client-INSERTs: nur Mutations-/Loesch-Grants weg
revoke update, delete, truncate
  on public.analytics_events, public.dispute_status_history, public.operator_action_audit
  from anon, authenticated;

-- Systemisch: TRUNCATE ist fuer Client-Rollen nie legitim und nicht RLS-gated
revoke truncate on all tables in schema public from anon, authenticated;
