-- =============================================================================
-- Prod ACL overlay for the pgTAP baseline (grant fidelity)
-- =============================================================================
-- `supabase db dump --schema public` does NOT faithfully reproduce per-table
-- REVOKEs: supabase's default privileges re-grant anon/authenticated at CREATE
-- time, so the dumped baseline ends up GRANTing access that production has since
-- revoked (e.g. legacy conversations/messages, notification_signals, the
-- append-only audit tables). The grant-level security pgTAP tests (01/03/04/08)
-- check exactly that revoked posture, so against the raw dump they fail falsely.
--
-- This overlay runs AFTER the schema dump and reconstructs production's exact
-- anon/authenticated table ACL: REVOKE ALL, then GRANT back precisely what prod
-- grants. Generated from prod information_schema.role_table_grants (107 tables).
-- service_role grants come from the dump and are intentionally left untouched.
--
-- Regenerate with the query in supabase/tests/baseline/README (run against prod).
-- =============================================================================

REVOKE ALL ON public.absences FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.absences TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.absences TO authenticated;
REVOKE ALL ON public.acceptances FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.acceptances TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.acceptances TO anon;
REVOKE ALL ON public.account_deletion_log FROM anon, authenticated;
REVOKE ALL ON public.analytics_events FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.analytics_events TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.analytics_events TO authenticated;
REVOKE ALL ON public.attribution_audit_log FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.attribution_audit_log TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.attribution_audit_log TO anon;
REVOKE ALL ON public.calendar_entries FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.calendar_entries TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.calendar_entries TO authenticated;
REVOKE ALL ON public.change_orders FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.change_orders TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.change_orders TO authenticated;
REVOKE ALL ON public.chat_attachments FROM anon, authenticated;
GRANT INSERT, SELECT ON public.chat_attachments TO authenticated;
REVOKE ALL ON public.chat_messages FROM anon, authenticated;
GRANT INSERT, SELECT, UPDATE ON public.chat_messages TO authenticated;
REVOKE ALL ON public.chat_participants FROM anon, authenticated;
GRANT INSERT, SELECT, UPDATE ON public.chat_participants TO authenticated;
REVOKE ALL ON public.chat_thread_migration_status FROM anon, authenticated;
GRANT SELECT ON public.chat_thread_migration_status TO authenticated;
REVOKE ALL ON public.chat_threads FROM anon, authenticated;
GRANT INSERT, SELECT, UPDATE ON public.chat_threads TO authenticated;
REVOKE ALL ON public.company_code_audit FROM anon, authenticated;
GRANT REFERENCES, SELECT, TRIGGER ON public.company_code_audit TO authenticated;
GRANT REFERENCES, SELECT, TRIGGER ON public.company_code_audit TO anon;
REVOKE ALL ON public.company_join_codes FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.company_join_codes TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.company_join_codes TO anon;
REVOKE ALL ON public.conversations FROM anon, authenticated;
GRANT SELECT ON public.conversations TO authenticated;
REVOKE ALL ON public.correction_requests FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.correction_requests TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.correction_requests TO authenticated;
REVOKE ALL ON public.craftsman_profiles FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.craftsman_profiles TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.craftsman_profiles TO authenticated;
REVOKE ALL ON public.craftsman_subscriptions FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.craftsman_subscriptions TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.craftsman_subscriptions TO anon;
REVOKE ALL ON public.customer_billing_profiles FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.customer_billing_profiles TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.customer_billing_profiles TO authenticated;
REVOKE ALL ON public.customer_provider_relationships FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.customer_provider_relationships TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.customer_provider_relationships TO authenticated;
REVOKE ALL ON public.customer_request_sends FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.customer_request_sends TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.customer_request_sends TO authenticated;
GRANT SELECT ON public.discovery_providers TO authenticated;
GRANT SELECT ON public.discovery_providers TO anon;
REVOKE ALL ON public.dispute_evidence FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.dispute_evidence TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.dispute_evidence TO authenticated;
REVOKE ALL ON public.dispute_spatial_evidence FROM anon, authenticated;
GRANT REFERENCES, SELECT, TRIGGER ON public.dispute_spatial_evidence TO authenticated;
GRANT REFERENCES, SELECT, TRIGGER ON public.dispute_spatial_evidence TO anon;
REVOKE ALL ON public.dispute_split_proposals FROM anon, authenticated;
GRANT REFERENCES, SELECT, TRIGGER ON public.dispute_split_proposals TO authenticated;
GRANT REFERENCES, SELECT, TRIGGER ON public.dispute_split_proposals TO anon;
REVOKE ALL ON public.dispute_status_history FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.dispute_status_history TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.dispute_status_history TO authenticated;
REVOKE ALL ON public.disputes FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.disputes TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.disputes TO authenticated;
REVOKE ALL ON public.download_jobs FROM anon, authenticated;
GRANT REFERENCES, SELECT, TRIGGER ON public.download_jobs TO authenticated;
GRANT REFERENCES, SELECT, TRIGGER ON public.download_jobs TO anon;
REVOKE ALL ON public.email_delivery_log FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.email_delivery_log TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.email_delivery_log TO authenticated;
REVOKE ALL ON public.escrow_payment_plans FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.escrow_payment_plans TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.escrow_payment_plans TO authenticated;
REVOKE ALL ON public.escrow_tranches FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.escrow_tranches TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.escrow_tranches TO authenticated;
REVOKE ALL ON public.failed_join_attempts FROM anon, authenticated;
GRANT REFERENCES, TRIGGER ON public.failed_join_attempts TO authenticated;
GRANT REFERENCES, TRIGGER ON public.failed_join_attempts TO anon;
REVOKE ALL ON public.funding_requests FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.funding_requests TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.funding_requests TO authenticated;
REVOKE ALL ON public.internal_messages FROM anon, authenticated;
GRANT REFERENCES, SELECT, TRIGGER, TRUNCATE ON public.internal_messages TO authenticated;
GRANT REFERENCES, SELECT, TRIGGER, TRUNCATE ON public.internal_messages TO anon;
REVOKE ALL ON public.invoices FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.invoices TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.invoices TO authenticated;
REVOKE ALL ON public.job_assignments FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.job_assignments TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.job_assignments TO authenticated;
REVOKE ALL ON public.job_feedback FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.job_feedback TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.job_feedback TO authenticated;
REVOKE ALL ON public.job_photos FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.job_photos TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.job_photos TO authenticated;
REVOKE ALL ON public.job_reports FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.job_reports TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.job_reports TO authenticated;
REVOKE ALL ON public.jobs FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.jobs TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.jobs TO authenticated;
REVOKE ALL ON public.ledger_entries FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ledger_entries TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ledger_entries TO authenticated;
REVOKE ALL ON public.media_artifacts FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.media_artifacts TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.media_artifacts TO authenticated;
REVOKE ALL ON public.media_uploads FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.media_uploads TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.media_uploads TO anon;
REVOKE ALL ON public.message_thread_participants FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.message_thread_participants TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.message_thread_participants TO anon;
REVOKE ALL ON public.message_threads FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.message_threads TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.message_threads TO anon;
REVOKE ALL ON public.messages FROM anon, authenticated;
GRANT SELECT ON public.messages TO authenticated;
REVOKE ALL ON public.moderation_action_log FROM anon, authenticated;
GRANT REFERENCES, SELECT, TRIGGER ON public.moderation_action_log TO anon;
GRANT REFERENCES, SELECT, TRIGGER ON public.moderation_action_log TO authenticated;
REVOKE ALL ON public.notification_device_tokens FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.notification_device_tokens TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.notification_device_tokens TO authenticated;
REVOKE ALL ON public.notification_signals FROM anon, authenticated;
GRANT INSERT, SELECT, UPDATE ON public.notification_signals TO authenticated;
REVOKE ALL ON public.offers FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.offers TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.offers TO authenticated;
REVOKE ALL ON public.operator_action_audit FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.operator_action_audit TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.operator_action_audit TO anon;
REVOKE ALL ON public.owner_notes FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.owner_notes TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.owner_notes TO authenticated;
REVOKE ALL ON public.parametric_cleanup_log FROM anon, authenticated;
REVOKE ALL ON public.payment_status_history FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.payment_status_history TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.payment_status_history TO anon;
REVOKE ALL ON public.payments FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.payments TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.payments TO authenticated;
REVOKE ALL ON public.profiles FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.profiles TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.profiles TO authenticated;
REVOKE ALL ON public.projects FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.projects TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.projects TO anon;
REVOKE ALL ON public.provider_highlight_items FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.provider_highlight_items TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.provider_highlight_items TO authenticated;
REVOKE ALL ON public.provider_highlights FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.provider_highlights TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.provider_highlights TO anon;
REVOKE ALL ON public.provider_media FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.provider_media TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.provider_media TO anon;
REVOKE ALL ON public.provider_media_assets FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.provider_media_assets TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.provider_media_assets TO authenticated;
REVOKE ALL ON public.provider_media_comment_likes FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.provider_media_comment_likes TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.provider_media_comment_likes TO anon;
REVOKE ALL ON public.provider_media_comments FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.provider_media_comments TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.provider_media_comments TO anon;
REVOKE ALL ON public.provider_media_likes FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.provider_media_likes TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.provider_media_likes TO authenticated;
REVOKE ALL ON public.provider_media_saves FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.provider_media_saves TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.provider_media_saves TO authenticated;
GRANT SELECT ON public.provider_media_tag_cooccur TO authenticated;
GRANT SELECT ON public.provider_media_tag_cooccur TO anon;
REVOKE ALL ON public.provider_payout_accounts FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.provider_payout_accounts TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.provider_payout_accounts TO anon;
REVOKE ALL ON public.provider_presales_projects FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.provider_presales_projects TO authenticated;
REVOKE ALL ON public.provider_saves FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.provider_saves TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.provider_saves TO authenticated;
REVOKE ALL ON public.providers FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.providers TO authenticated;
GRANT DELETE, INSERT, REFERENCES, TRIGGER, TRUNCATE, UPDATE ON public.providers TO anon;
REVOKE ALL ON public.push_action_audit FROM anon, authenticated;
GRANT REFERENCES, TRIGGER ON public.push_action_audit TO authenticated;
GRANT REFERENCES, TRIGGER ON public.push_action_audit TO anon;
REVOKE ALL ON public.ratings FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ratings TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ratings TO authenticated;
REVOKE ALL ON public.revenuecat_webhook_events FROM anon, authenticated;
GRANT REFERENCES, SELECT, TRIGGER ON public.revenuecat_webhook_events TO anon;
GRANT REFERENCES, SELECT, TRIGGER ON public.revenuecat_webhook_events TO authenticated;
REVOKE ALL ON public.saved_reel_folders FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.saved_reel_folders TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.saved_reel_folders TO authenticated;
REVOKE ALL ON public.scan_annotations FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, UPDATE ON public.scan_annotations TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, UPDATE ON public.scan_annotations TO authenticated;
REVOKE ALL ON public.scan_assets FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, UPDATE ON public.scan_assets TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, UPDATE ON public.scan_assets TO authenticated;
REVOKE ALL ON public.scan_cleanup_log FROM anon, authenticated;
REVOKE ALL ON public.scan_events FROM anon, authenticated;
GRANT REFERENCES, SELECT, TRIGGER ON public.scan_events TO authenticated;
GRANT REFERENCES, SELECT, TRIGGER ON public.scan_events TO anon;
REVOKE ALL ON public.scan_measurements FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, UPDATE ON public.scan_measurements TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, UPDATE ON public.scan_measurements TO authenticated;
REVOKE ALL ON public.scan_quality_reports FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, UPDATE ON public.scan_quality_reports TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, UPDATE ON public.scan_quality_reports TO authenticated;
REVOKE ALL ON public.scan_rooms FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, UPDATE ON public.scan_rooms TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, UPDATE ON public.scan_rooms TO authenticated;
REVOKE ALL ON public.scan_status_transition_allowed FROM anon, authenticated;
GRANT SELECT ON public.scan_status_transition_allowed TO authenticated;
REVOKE ALL ON public.scan_status_transition_log FROM anon, authenticated;
GRANT REFERENCES, SELECT, TRIGGER ON public.scan_status_transition_log TO anon;
GRANT REFERENCES, SELECT, TRIGGER ON public.scan_status_transition_log TO authenticated;
REVOKE ALL ON public.scan_surfaces FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, UPDATE ON public.scan_surfaces TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, UPDATE ON public.scan_surfaces TO authenticated;
REVOKE ALL ON public.scans FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, UPDATE ON public.scans TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, UPDATE ON public.scans TO anon;
REVOKE ALL ON public.schedules FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.schedules TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.schedules TO anon;
REVOKE ALL ON public.spatial_assets FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, UPDATE ON public.spatial_assets TO authenticated;
GRANT REFERENCES, SELECT, TRIGGER ON public.spatial_assets TO anon;
REVOKE ALL ON public.spatial_change_orders FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, UPDATE ON public.spatial_change_orders TO authenticated;
GRANT REFERENCES, SELECT, TRIGGER ON public.spatial_change_orders TO anon;
REVOKE ALL ON public.spatial_edit_history FROM anon, authenticated;
GRANT REFERENCES, SELECT, TRIGGER ON public.spatial_edit_history TO anon;
GRANT REFERENCES, SELECT, TRIGGER ON public.spatial_edit_history TO authenticated;
REVOKE ALL ON public.spatial_materials FROM anon, authenticated;
GRANT REFERENCES, SELECT, TRIGGER ON public.spatial_materials TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, UPDATE ON public.spatial_materials TO authenticated;
REVOKE ALL ON public.spatial_node_links FROM anon, authenticated;
GRANT REFERENCES, SELECT, TRIGGER ON public.spatial_node_links TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, UPDATE ON public.spatial_node_links TO authenticated;
REVOKE ALL ON public.spatial_node_overrides FROM anon, authenticated;
GRANT REFERENCES, SELECT, TRIGGER ON public.spatial_node_overrides TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, UPDATE ON public.spatial_node_overrides TO authenticated;
REVOKE ALL ON public.spatial_pin_reviews FROM anon, authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.spatial_pin_reviews TO authenticated;
REVOKE ALL ON public.spatial_rescan_requests FROM anon, authenticated;
GRANT INSERT, SELECT ON public.spatial_rescan_requests TO authenticated;
REVOKE ALL ON public.spatial_scenes FROM anon, authenticated;
GRANT REFERENCES, SELECT, TRIGGER ON public.spatial_scenes TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, UPDATE ON public.spatial_scenes TO authenticated;
REVOKE ALL ON public.spatial_share_audit FROM anon, authenticated;
GRANT REFERENCES, SELECT, TRIGGER ON public.spatial_share_audit TO anon;
GRANT REFERENCES, SELECT, TRIGGER ON public.spatial_share_audit TO authenticated;
REVOKE ALL ON public.stripe_events FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.stripe_events TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.stripe_events TO anon;
REVOKE ALL ON public.stripe_webhook_events FROM anon, authenticated;
GRANT REFERENCES, SELECT, TRIGGER ON public.stripe_webhook_events TO anon;
GRANT REFERENCES, SELECT, TRIGGER ON public.stripe_webhook_events TO authenticated;
REVOKE ALL ON public.subscription_withdrawal_consents FROM anon, authenticated;
GRANT INSERT, SELECT ON public.subscription_withdrawal_consents TO authenticated;
REVOKE ALL ON public.supplementary_payment_requests FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.supplementary_payment_requests TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.supplementary_payment_requests TO anon;
REVOKE ALL ON public.team_member_audit FROM anon, authenticated;
GRANT REFERENCES, SELECT, TRIGGER ON public.team_member_audit TO authenticated;
GRANT REFERENCES, SELECT, TRIGGER ON public.team_member_audit TO anon;
REVOKE ALL ON public.team_members FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.team_members TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.team_members TO authenticated;
REVOKE ALL ON public.thread_artifacts FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.thread_artifacts TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.thread_artifacts TO authenticated;
REVOKE ALL ON public.time_entries FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.time_entries TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.time_entries TO anon;
REVOKE ALL ON public.timeline_signals FROM anon, authenticated;
GRANT INSERT, SELECT, UPDATE ON public.timeline_signals TO authenticated;
REVOKE ALL ON public.user_blocks FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.user_blocks TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.user_blocks TO anon;
REVOKE ALL ON public.user_notification_preferences FROM anon, authenticated;
GRANT INSERT, SELECT, UPDATE ON public.user_notification_preferences TO authenticated;
REVOKE ALL ON public.user_reports FROM anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.user_reports TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.user_reports TO authenticated;
GRANT SELECT ON public.visible_discovery_providers TO authenticated;
GRANT SELECT ON public.visible_discovery_providers TO anon;
REVOKE ALL ON public.widerruf_requests FROM anon, authenticated;
GRANT INSERT, SELECT ON public.widerruf_requests TO authenticated;

-- =============================================================================
-- Auth-schema triggers on auth.users
-- =============================================================================
-- These live on auth.users (auth schema), so a `--schema public` dump misses
-- them — but their functions are in public (and thus dumped). Re-attach them so
-- the baseline reproduces prod behaviour: profile auto-create on signup and the
-- account-deletion cascade. Without these, fixtures that create/delete test
-- users fail (FK violation / no cascade), which is what broke tests 07 and 03.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();
DROP TRIGGER IF EXISTS auth_users_after_delete_cascade ON auth.users;
CREATE TRIGGER auth_users_after_delete_cascade AFTER DELETE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_auth_user_delete_cascade();

-- =============================================================================
-- DSGVO account-delete cascade: defer moderation_action_log SET-NULL FKs
-- =============================================================================
-- When a moderated user is deleted, the cascade SET-NULLs three FKs on the same
-- moderation_action_log row (operator_id/target_user_id/report_id) while it also
-- CASCADE-deletes the referenced user_reports row. pg_dump recreates constraints
-- in non-deterministic order, so an immediate (non-deferred) check can transiently
-- see report_id pointing at the already-deleted user_reports row and raise 23503.
-- Deferring the checks to commit time (after every SET NULL has applied) makes the
-- DSGVO delete order-independent — which is the correct shape for a multi-FK
-- SET-NULL cascade. (Prod hardening candidate: prod's FKs are not deferrable and
-- only happen to avoid this by current constraint order.)
ALTER TABLE public.moderation_action_log
  ALTER CONSTRAINT moderation_action_log_report_id_fkey      DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.moderation_action_log
  ALTER CONSTRAINT moderation_action_log_target_user_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.moderation_action_log
  ALTER CONSTRAINT moderation_action_log_operator_id_fkey    DEFERRABLE INITIALLY DEFERRED;
