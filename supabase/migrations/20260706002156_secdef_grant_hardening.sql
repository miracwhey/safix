-- Security-Advisor sweep (2026-07-06): SECURITY DEFINER functions reachable via
-- PostgREST /rest/v1/rpc/ that are either trigger functions (never legitimately
-- callable via RPC) or have no client/policy usage. service_role keeps EXECUTE
-- everywhere (owner grants untouched), so api/ routes, Edge Functions and
-- pg_cron are unaffected.
--
-- Kept intentionally (verified usage):
--   * client RPCs found in src/, api/, supabase/functions/ (string + indirection scan)
--   * RLS/policy helpers referenced in pg_policies (public, storage, realtime):
--     chat_user_is_thread_admin, is_blocked_by_me, is_caller_moderation_write_allowed,
--     is_current_user_operator, is_pro_owner, provider_is_public, spatial_can_*,
--     spatial_is_*, spatial_user_org_owner_profile, spatial_user_provider_org
--   * get_provider_median_response_ms keeps PUBLIC: read-only aggregate used by
--     discovery surfaces that may render pre-login.

-- 1) Trigger functions: fired by DML, never via RPC. EXECUTE not required at runtime.
revoke execute on function public._enforce_profile_privileged_columns() from authenticated;
revoke execute on function public.assert_attribution_finalized_before_release() from authenticated;
revoke execute on function public.enforce_payment_fsm() from authenticated;
revoke execute on function public.profiles_handle_guard() from public, anon, authenticated;
revoke execute on function public.sync_provider_media_cover() from authenticated;
revoke execute on function public.tg_advance_invoice_on_payment_released() from public, anon, authenticated;

-- 2) SECURITY DEFINER RPCs with zero client usage and zero policy references.
--    Legacy predecessors of the rpc_-prefixed chat thread RPCs, or internal helpers
--    only ever called from other SECDEF bodies (which run as owner).
revoke execute on function public.get_or_create_assignment_thread(uuid) from authenticated;
revoke execute on function public.get_or_create_office_thread() from authenticated;
revoke execute on function public.get_or_create_team_thread() from authenticated;
revoke execute on function public.is_blocked(uuid, uuid) from authenticated;
revoke execute on function public.offers_mark_quote_stale(uuid, text, uuid) from authenticated;
revoke execute on function public.resign_download_url(uuid) from authenticated;
revoke execute on function public.spatial_scan_is_locked(uuid) from authenticated;
revoke execute on function public.spatial_user_team_role(uuid, uuid) from authenticated;

-- 3) function_search_path_mutable: pin the only unpinned function.
alter function public.slugify_handle(text) set search_path = pg_catalog, public;

-- 4) Advisor ERROR security_definer_view on the two discovery views: accepted by
--    design, documented here. providers/profiles carry owner-only RLS (read own);
--    these views are the *curated* public projection (no PII columns, is_operator
--    nulled, iban/bic/tax_number/phone never projected). Switching to
--    security_invoker would break discovery for every role; opening RLS on the
--    base tables would leak strictly more than the views do.
comment on view public.discovery_providers is
  'SECURITY DEFINER by design: curated public discovery projection over providers+profiles (is_public=true only, no PII columns, is_operator nulled). Do not convert to security_invoker — base tables are RLS read-own by intent. Reviewed 2026-07-06.';
comment on view public.visible_discovery_providers is
  'SECURITY DEFINER by design: discovery_providers additionally filtered to onboarding_done=true. See discovery_providers comment. Reviewed 2026-07-06.';
