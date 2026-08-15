-- Performance-advisor sweep (2026-07-06), part 2:
--  1) drop 9 duplicate indexes (verified via pg_index/pg_constraint: none
--     constraint-backed; the surviving twin is listed in each comment)
--  2) covering indexes for the 30 unindexed foreign keys
--  3) defense-in-depth on internal log/audit/quota tables that run RLS with
--     no policies (fail-closed by design): revoke client grants explicitly.
-- "unused_index" advisor findings are intentionally NOT acted on — the app is
-- one week live; usage stats carry no signal yet.

-- 1) duplicate indexes ------------------------------------------------------
drop index if exists public.idx_dispute_status_history_dispute_id; -- keep dispute_status_history_dispute_id_idx
drop index if exists public.idx_jobs_status;                       -- keep jobs_status_idx
drop index if exists public.idx_ledger_entries_type;               -- keep ledger_entries_type_idx
drop index if exists public.idx_ledger_entries_job_id;             -- keep ledger_entries_job_idx
drop index if exists public.idx_ledger_entries_payment_id;         -- keep ledger_entries_payment_idx
drop index if exists public.idx_payments_job_id;                   -- keep payments_job_id_idx
drop index if exists public.idx_payments_status;                   -- keep payments_status_idx
drop index if exists public.providers_search_idx;                  -- keep providers_search_vector_idx
drop index if exists public.idx_team_members_provider_profile_unique; -- keep team_members_unique_provider_profile_idx

-- 2) FK covering indexes ----------------------------------------------------
create index if not exists acceptances_payment_id_idx on public.acceptances (payment_id);
create index if not exists acceptances_source_offer_id_idx on public.acceptances (source_offer_id);
create index if not exists calendar_entries_job_id_idx on public.calendar_entries (job_id);
create index if not exists change_orders_source_offer_id_idx on public.change_orders (source_offer_id);
create index if not exists chat_messages_reply_to_message_id_idx on public.chat_messages (reply_to_message_id);
create index if not exists chat_participants_last_read_message_id_idx on public.chat_participants (last_read_message_id);
create index if not exists chat_participants_last_visible_message_id_idx on public.chat_participants (last_visible_message_id);
create index if not exists company_code_audit_new_code_id_idx on public.company_code_audit (new_code_id);
create index if not exists company_code_audit_old_code_id_idx on public.company_code_audit (old_code_id);
create index if not exists company_join_codes_replaced_by_idx on public.company_join_codes (replaced_by);
create index if not exists invoices_job_id_idx on public.invoices (job_id);
create index if not exists media_artifacts_job_id_idx on public.media_artifacts (job_id);
create index if not exists notification_signals_job_id_idx on public.notification_signals (job_id);
create index if not exists offers_created_job_id_idx on public.offers (created_job_id);
create index if not exists offers_project_id_idx on public.offers (project_id);
create index if not exists offers_stale_source_scene_id_idx on public.offers (stale_source_scene_id);
create index if not exists provider_highlight_items_portfolio_item_id_idx on public.provider_highlight_items (portfolio_item_id);
create index if not exists provider_highlights_cover_portfolio_item_id_idx on public.provider_highlights (cover_portfolio_item_id);
create index if not exists provider_media_saves_folder_id_idx on public.provider_media_saves (folder_id);
create index if not exists provider_presales_projects_created_by_user_id_idx on public.provider_presales_projects (created_by_user_id);
create index if not exists scan_annotations_photo_asset_id_idx on public.scan_annotations (photo_asset_id);
create index if not exists schedules_job_id_idx on public.schedules (job_id);
create index if not exists spatial_pin_reviews_provider_org_id_idx on public.spatial_pin_reviews (provider_org_id);
create index if not exists spatial_pin_reviews_reviewed_by_user_id_idx on public.spatial_pin_reviews (reviewed_by_user_id);
create index if not exists spatial_rescan_requests_requested_by_user_id_idx on public.spatial_rescan_requests (requested_by_user_id);
create index if not exists spatial_share_audit_job_id_idx on public.spatial_share_audit (job_id);
create index if not exists time_entries_job_id_idx on public.time_entries (job_id);
create index if not exists time_entries_rejected_by_idx on public.time_entries (rejected_by);
create index if not exists timeline_signals_job_id_idx on public.timeline_signals (job_id);
create index if not exists user_reports_reviewed_by_idx on public.user_reports (reviewed_by);

-- 3) fail-closed log/audit/quota tables: revoke client grants explicitly ----
revoke all on table public.account_deletion_log from anon, authenticated;
revoke all on table public.direct_thread_quota from anon, authenticated;
revoke all on table public.email_delivery_log from anon, authenticated;
revoke all on table public.failed_join_attempts from anon, authenticated;
revoke all on table public.parametric_cleanup_log from anon, authenticated;
revoke all on table public.profile_search_quota from anon, authenticated;
revoke all on table public.push_action_audit from anon, authenticated;
revoke all on table public.reserved_handles from anon, authenticated;
revoke all on table public.revenuecat_webhook_events from anon, authenticated;
revoke all on table public.scan_cleanup_log from anon, authenticated;
