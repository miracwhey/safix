-- Security hardening — 2026-06-02
--
-- (1) P0 — Cross-tenant finance+PII leak via SECURITY DEFINER views.
--     10 views are owner=postgres + security_invoker=false (→ bypass base-table
--     RLS) AND carry GRANT SELECT TO authenticated. A random logged-in user can
--     read every tenant's payments / disputes / jobs / team-members via
--     `GET /rest/v1/<view>` (behaviorally verified 2026-06-02: payment_details=5,
--     team_member_details=7, job_details=12 foreign rows). The base tables
--     correctly return 0 for the same user. All 10 views are referenced NOWHERE
--     in app code (repo grep = 0) → they are dead ops/debug views. Revoke the
--     authenticated/anon grant (closes the REST leak) and flip to
--     security_invoker=true (clears the advisor ERROR; ops keeps access via
--     service_role, which bypasses RLS).
--
-- (2) function_search_path_mutable hygiene on 16 functions. `pg_catalog, public`
--     keeps unqualified public refs resolvable (e.g. get_provider_median_response_ms
--     references `conversations` unqualified) while pinning the path.
--
-- NOT addressed here (separate design fix): discovery_providers is intentionally
-- anon/authenticated-readable (app reads it directly in 3 services). Its exposure
-- of pr.phone / pr.is_operator and absence of an is_public filter is a column-level
-- design change coupled to app code — must not be revoked.

-- ── (1) Definer-view leak ────────────────────────────────────────────────────
DO $$
DECLARE v text;
BEGIN
  FOREACH v IN ARRAY ARRAY[
    'payment_details','payment_risk_overview','payment_lifecycle_overview',
    'payment_reconciliation_details','dispute_details','dispute_ops_overview',
    'job_details','job_integrity_overview','job_assignment_details','team_member_details'
  ] LOOP
    EXECUTE format('REVOKE SELECT ON public.%I FROM authenticated, anon', v);
    EXECUTE format('ALTER VIEW public.%I SET (security_invoker = true)', v);
  END LOOP;
END$$;

-- ── (2) search_path hygiene ──────────────────────────────────────────────────
-- SECURITY DEFINER first (search_path mutation = privilege-escalation vector).
ALTER FUNCTION public.generate_invoice_number()                      SET search_path = pg_catalog, public;
ALTER FUNCTION public.get_provider_median_response_ms(text, integer) SET search_path = pg_catalog, public;
ALTER FUNCTION public.is_blocked(uuid, uuid)                         SET search_path = pg_catalog, public;
-- SECURITY INVOKER (trigger / helper fns).
ALTER FUNCTION public.disputes_sla_reset_trigger_fn()                SET search_path = pg_catalog, public;
ALTER FUNCTION public.enforce_comment_depth()                        SET search_path = pg_catalog, public;
ALTER FUNCTION public.enforce_invoice_immutability()                 SET search_path = pg_catalog, public;
ALTER FUNCTION public.enforce_parent_comment_id_immutable()          SET search_path = pg_catalog, public;
ALTER FUNCTION public.get_provider_avatar(uuid)                      SET search_path = pg_catalog, public;
ALTER FUNCTION public.get_provider_media(uuid)                       SET search_path = pg_catalog, public;
ALTER FUNCTION public.get_provider_portfolio(uuid)                   SET search_path = pg_catalog, public;
ALTER FUNCTION public.notification_push_copy(text)                   SET search_path = pg_catalog, public;
ALTER FUNCTION public.set_updated_at()                               SET search_path = pg_catalog, public;
ALTER FUNCTION public.time_entries_immutable_identity_trigger()      SET search_path = pg_catalog, public;
ALTER FUNCTION public.time_entries_reject_stamp_trigger()            SET search_path = pg_catalog, public;
ALTER FUNCTION public.touch_updated_at()                             SET search_path = pg_catalog, public;
ALTER FUNCTION public.update_provider_search_vector()                SET search_path = pg_catalog, public;

NOTIFY pgrst, 'reload schema';
