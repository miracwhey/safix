-- Drop the RESTRICTIVE Pro-gate INSERT policies on the earning-loop tables.
--
-- ROOT CAUSE (server/client drift):
--   The Apple-3.1.1 "earning-loop decouple" (#958, 2026-06-03) made offer /
--   invoice / funding / change-order creation FREE for every verified craftsman
--   on the CLIENT (src/lib/subscription/entitlements.ts → FREE_ACTIONS, e.g.
--   'open_quote_composer'). But the RESTRICTIVE *_pro_gate_insert RLS policies
--   from the earlier Pro block (#891, 2026-05-08) were never dropped. Result: a
--   non-Pro craftsman (status trial_available / expired → is_pro_owner() = false)
--   opens the composer (UI permits the free action), fills it, and the INSERT is
--   denied with 42501 by the RESTRICTIVE is_pro_owner() gate. The chat offer path
--   uses a plain INSERT (no DEFINER-bypass RPC), so it hits the gate directly.
--
-- WHY THIS IS SAFE (authorization preserved):
--   Each table keeps its PERMISSIVE own-row INSERT policy
--   (auth.uid() = craftsman_user_id), so a craftsman can still only create their
--   OWN rows. Only the *subscription* requirement is removed — exactly matching
--   the deliberate Apple-3.1.1 product/legal decision the client already encodes.
--   Verified empirically before this change: is_pro_owner() = true only for
--   'active', false for 'trial_available' and 'expired'.
--
-- INTENTIONALLY UNCHANGED (office / Team-Hub — NOT in FREE_ACTIONS, stay Pro):
--   internal_messages_pro_gate_insert, team_members_pro_gate_insert.
--
-- Affected domains: offers, invoices, funding, change-orders (the earning loop).
-- External steps: none — passive policy drop, no data migration, no app changes.

DROP POLICY IF EXISTS "offers_pro_gate_insert"           ON public.offers;
DROP POLICY IF EXISTS "funding_requests_pro_gate_insert"  ON public.funding_requests;
DROP POLICY IF EXISTS "invoices_pro_gate_insert"          ON public.invoices;
DROP POLICY IF EXISTS "change_orders_pro_gate_insert"     ON public.change_orders;

-- ── Rollback (re-create the gates) ────────────────────────────────────────────
--   CREATE POLICY "offers_pro_gate_insert" ON public.offers AS RESTRICTIVE
--     FOR INSERT TO authenticated WITH CHECK (public.is_pro_owner(auth.uid()));
--   CREATE POLICY "funding_requests_pro_gate_insert" ON public.funding_requests AS RESTRICTIVE
--     FOR INSERT TO authenticated WITH CHECK (public.is_pro_owner(auth.uid()));
--   CREATE POLICY "invoices_pro_gate_insert" ON public.invoices AS RESTRICTIVE
--     FOR INSERT TO authenticated WITH CHECK (
--       public.is_pro_owner(auth.uid()) OR EXISTS (
--         SELECT 1 FROM public.escrow_payment_plans epp
--         WHERE epp.job_id = invoices.job_id
--           AND epp.status = ANY (ARRAY['funded_in_escrow'::text, 'partially_released'::text])));
--   CREATE POLICY "change_orders_pro_gate_insert" ON public.change_orders AS RESTRICTIVE
--     FOR INSERT TO authenticated WITH CHECK (
--       public.is_pro_owner(auth.uid()) OR EXISTS (
--         SELECT 1 FROM public.escrow_payment_plans epp
--         WHERE epp.job_id = change_orders.job_id
--           AND epp.status = ANY (ARRAY['funded_in_escrow'::text, 'partially_released'::text])));
