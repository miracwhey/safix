-- RLS initplan hardening 3/3: wrap auth.uid()/jwt()/role() in scalar subselects.
-- Semantically identical; evaluated once per statement instead of per row.

alter policy "provider_media_select_own" on public.provider_media
  using ((EXISTS ( SELECT 1
   FROM providers p
  WHERE ((p.id = provider_media.provider_id) AND (p.profile_id = (select auth.uid()))))));

alter policy "pma_delete_own" on public.provider_media_assets
  using ((EXISTS ( SELECT 1
   FROM providers p
  WHERE ((p.id = provider_media_assets.provider_id) AND (p.profile_id = (select auth.uid()))))));

alter policy "pma_insert_own" on public.provider_media_assets
  with check ((EXISTS ( SELECT 1
   FROM providers p
  WHERE ((p.id = provider_media_assets.provider_id) AND (p.profile_id = (select auth.uid()))))));

alter policy "pma_select_own" on public.provider_media_assets
  using ((EXISTS ( SELECT 1
   FROM providers p
  WHERE ((p.id = provider_media_assets.provider_id) AND (p.profile_id = (select auth.uid()))))));

alter policy "pma_update_own" on public.provider_media_assets
  using ((EXISTS ( SELECT 1
   FROM providers p
  WHERE ((p.id = provider_media_assets.provider_id) AND (p.profile_id = (select auth.uid()))))))
  with check ((EXISTS ( SELECT 1
   FROM providers p
  WHERE ((p.id = provider_media_assets.provider_id) AND (p.profile_id = (select auth.uid()))))));

alter policy "pmcl_delete" on public.provider_media_comment_likes
  using (((select auth.uid()) = user_id));

alter policy "pmcl_insert" on public.provider_media_comment_likes
  with check (((select auth.uid()) = user_id));

alter policy "provider_media_comments_delete" on public.provider_media_comments
  using ((((select auth.uid()) = user_id) OR (EXISTS ( SELECT 1
   FROM (provider_media pm
     JOIN providers p ON ((p.id = pm.provider_id)))
  WHERE ((pm.id = provider_media_comments.media_id) AND (p.profile_id = (select auth.uid())))))));

alter policy "provider_media_comments_insert" on public.provider_media_comments
  with check (((select auth.uid()) = user_id));

alter policy "provider_media_comments_update" on public.provider_media_comments
  using (((select auth.uid()) = user_id))
  with check (((select auth.uid()) = user_id));

alter policy "provider_media_likes_delete" on public.provider_media_likes
  using (((select auth.uid()) = user_id));

alter policy "provider_media_likes_insert" on public.provider_media_likes
  with check (((select auth.uid()) = user_id));

alter policy "provider_media_saves_delete" on public.provider_media_saves
  using (((select auth.uid()) = user_id));

alter policy "provider_media_saves_insert" on public.provider_media_saves
  with check (((select auth.uid()) = user_id));

alter policy "provider_media_saves_update" on public.provider_media_saves
  using (((select auth.uid()) = user_id))
  with check (((select auth.uid()) = user_id));

alter policy "provider_payout_own_row" on public.provider_payout_accounts
  using (((select auth.uid()) = provider_user_id))
  with check (((select auth.uid()) = provider_user_id));

alter policy "provider_saves_delete" on public.provider_saves
  using (((select auth.uid()) = user_id));

alter policy "provider_saves_insert" on public.provider_saves
  with check (((select auth.uid()) = user_id));

alter policy "Providers: insert own" on public.providers
  with check ((profile_id = (select auth.uid())));

alter policy "Providers: read own" on public.providers
  using ((profile_id = (select auth.uid())));

alter policy "Providers: update own" on public.providers
  using ((profile_id = (select auth.uid())))
  with check ((profile_id = (select auth.uid())));

alter policy "authenticated_can_read_ratings" on public.ratings
  using (((select auth.uid()) IS NOT NULL));

alter policy "customers_can_insert_own_ratings" on public.ratings
  with check ((customer_user_id = (select auth.uid())));

alter policy "srf_delete" on public.saved_reel_folders
  using (((select auth.uid()) = user_id));

alter policy "srf_insert" on public.saved_reel_folders
  with check (((select auth.uid()) = user_id));

alter policy "srf_select" on public.saved_reel_folders
  using (((select auth.uid()) = user_id));

alter policy "srf_update" on public.saved_reel_folders
  using (((select auth.uid()) = user_id))
  with check (((select auth.uid()) = user_id));

alter policy "schedules_insert_own" on public.schedules
  with check ((EXISTS ( SELECT 1
   FROM (jobs j
     LEFT JOIN providers p ON ((p.id = COALESCE(j.assigned_provider_id, j.provider_id))))
  WHERE ((j.id = schedules.job_id) AND (p.profile_id = (select auth.uid()))))));

alter policy "schedules_select_own" on public.schedules
  using ((EXISTS ( SELECT 1
   FROM (jobs j
     LEFT JOIN providers p ON ((p.id = COALESCE(j.assigned_provider_id, j.provider_id))))
  WHERE ((j.id = schedules.job_id) AND ((j.customer_user_id = (select auth.uid())) OR (p.profile_id = (select auth.uid())))))));

alter policy "schedules_update_own" on public.schedules
  using ((EXISTS ( SELECT 1
   FROM (jobs j
     LEFT JOIN providers p ON ((p.id = COALESCE(j.assigned_provider_id, j.provider_id))))
  WHERE ((j.id = schedules.job_id) AND (p.profile_id = (select auth.uid()))))));

alter policy "spatial_assets_service_role_all" on public.spatial_assets
  using (((select auth.role()) = 'service_role'::text))
  with check (((select auth.role()) = 'service_role'::text));

alter policy "spatial_change_orders_service_role_all" on public.spatial_change_orders
  using (((select auth.role()) = 'service_role'::text))
  with check (((select auth.role()) = 'service_role'::text));

alter policy "spatial_edit_history_service_role_all" on public.spatial_edit_history
  using (((select auth.role()) = 'service_role'::text))
  with check (((select auth.role()) = 'service_role'::text));

alter policy "spatial_materials_service_role_all" on public.spatial_materials
  using (((select auth.role()) = 'service_role'::text))
  with check (((select auth.role()) = 'service_role'::text));

alter policy "spatial_node_links_service_role_all" on public.spatial_node_links
  using (((select auth.role()) = 'service_role'::text))
  with check (((select auth.role()) = 'service_role'::text));

alter policy "spatial_node_overrides_service_role_all" on public.spatial_node_overrides
  using (((select auth.role()) = 'service_role'::text))
  with check (((select auth.role()) = 'service_role'::text));

alter policy "spatial_pin_reviews_delete" on public.spatial_pin_reviews
  using ((provider_org_id = spatial_user_provider_org((select auth.uid()))));

alter policy "spatial_pin_reviews_insert" on public.spatial_pin_reviews
  with check (((provider_org_id = spatial_user_provider_org((select auth.uid()))) AND (reviewed_by_user_id = (select auth.uid())) AND (EXISTS ( SELECT 1
   FROM spatial_scenes s
  WHERE ((s.id = spatial_pin_reviews.scene_id) AND (s.provider_org_id = spatial_user_provider_org((select auth.uid()))))))));

alter policy "spatial_pin_reviews_select" on public.spatial_pin_reviews
  using ((provider_org_id = spatial_user_provider_org((select auth.uid()))));

alter policy "spatial_pin_reviews_update" on public.spatial_pin_reviews
  using ((provider_org_id = spatial_user_provider_org((select auth.uid()))))
  with check ((provider_org_id = spatial_user_provider_org((select auth.uid()))));

alter policy "spatial_rescan_requests_customer_select" on public.spatial_rescan_requests
  using ((EXISTS ( SELECT 1
   FROM spatial_scenes s
  WHERE ((s.id = spatial_rescan_requests.scene_id) AND (s.customer_id = (select auth.uid()))))));

alter policy "spatial_rescan_requests_insert" on public.spatial_rescan_requests
  with check (((provider_org_id = spatial_user_provider_org((select auth.uid()))) AND (requested_by_user_id = (select auth.uid())) AND (EXISTS ( SELECT 1
   FROM spatial_scenes s
  WHERE ((s.id = spatial_rescan_requests.scene_id) AND (s.provider_org_id = spatial_user_provider_org((select auth.uid()))))))));

alter policy "spatial_rescan_requests_select" on public.spatial_rescan_requests
  using ((provider_org_id = spatial_user_provider_org((select auth.uid()))));

alter policy "spatial_scenes_service_role_all" on public.spatial_scenes
  using (((select auth.role()) = 'service_role'::text))
  with check (((select auth.role()) = 'service_role'::text));

alter policy "stripe_webhook_events_select_party" on public.stripe_webhook_events
  using (((job_id IS NOT NULL) AND ((EXISTS ( SELECT 1
   FROM jobs j
  WHERE (((j.id)::text = stripe_webhook_events.job_id) AND ((j.customer_user_id = (select auth.uid())) OR (j.provider_id IN ( SELECT pr.id
           FROM providers pr
          WHERE (pr.profile_id = (select auth.uid())))) OR (j.assigned_provider_id IN ( SELECT pr.id
           FROM providers pr
          WHERE (pr.profile_id = (select auth.uid())))))))) OR (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = (select auth.uid())) AND (p.is_operator = true)))))));

alter policy "supplementary_payment_requests_craftsman_read" on public.supplementary_payment_requests
  using ((((select auth.uid()))::text = craftsman_user_id));

alter policy "supplementary_payment_requests_craftsman_update" on public.supplementary_payment_requests
  using ((((select auth.uid()))::text = craftsman_user_id));

alter policy "supplementary_payment_requests_customer_read" on public.supplementary_payment_requests
  using ((((select auth.uid()))::text = customer_user_id));

alter policy "supplementary_payment_requests_customer_update" on public.supplementary_payment_requests
  using ((((select auth.uid()))::text = customer_user_id));

alter policy "supplementary_payment_requests_insert" on public.supplementary_payment_requests
  with check (((((select auth.uid()))::text = craftsman_user_id) OR (((select auth.uid()))::text = customer_user_id)));

alter policy "team_member_audit_owner_select" on public.team_member_audit
  using ((provider_id IN ( SELECT providers.id
   FROM providers
  WHERE (providers.profile_id = (select auth.uid())))));

alter policy "Team members: insert own provider" on public.team_members
  with check ((EXISTS ( SELECT 1
   FROM providers p
  WHERE ((p.id = team_members.provider_id) AND (p.profile_id = (select auth.uid()))))));

alter policy "Team members: read own profile_id" on public.team_members
  using ((profile_id = (select auth.uid())));

alter policy "Team members: read own provider" on public.team_members
  using ((EXISTS ( SELECT 1
   FROM providers p
  WHERE ((p.id = team_members.provider_id) AND (p.profile_id = (select auth.uid()))))));

alter policy "Team members: update own provider" on public.team_members
  using ((EXISTS ( SELECT 1
   FROM providers p
  WHERE ((p.id = team_members.provider_id) AND (p.profile_id = (select auth.uid()))))))
  with check ((EXISTS ( SELECT 1
   FROM providers p
  WHERE ((p.id = team_members.provider_id) AND (p.profile_id = (select auth.uid()))))));

alter policy "team_members_pro_gate_insert" on public.team_members
  with check (is_pro_owner((select auth.uid())));

alter policy "thread_artifacts_insert_own" on public.thread_artifacts
  with check ((((select auth.uid()) = customer_user_id) OR ((select auth.uid()) = craftsman_user_id)));

alter policy "thread_artifacts_select_own" on public.thread_artifacts
  using ((((select auth.uid()) = customer_user_id) OR ((select auth.uid()) = craftsman_user_id)));

alter policy "thread_artifacts_update_own" on public.thread_artifacts
  using ((((select auth.uid()) = customer_user_id) OR ((select auth.uid()) = craftsman_user_id)))
  with check ((((select auth.uid()) = customer_user_id) OR ((select auth.uid()) = craftsman_user_id)));

alter policy "time_entries_owner_select" on public.time_entries
  using ((provider_id IN ( SELECT providers.id
   FROM providers
  WHERE (providers.profile_id = (select auth.uid())))));

alter policy "time_entries_owner_update" on public.time_entries
  using ((provider_id IN ( SELECT providers.id
   FROM providers
  WHERE (providers.profile_id = (select auth.uid())))))
  with check (((provider_id IN ( SELECT providers.id
   FROM providers
  WHERE (providers.profile_id = (select auth.uid())))) AND (status = ANY (ARRAY['closed'::time_entry_status, 'rejected'::time_entry_status]))));

alter policy "time_entries_worker_close" on public.time_entries
  using (((status = 'active'::time_entry_status) AND (member_id IN ( SELECT team_members.id
   FROM team_members
  WHERE ((team_members.profile_id = (select auth.uid())) AND (team_members.is_active = true))))))
  with check (((status = 'closed'::time_entry_status) AND (member_id IN ( SELECT team_members.id
   FROM team_members
  WHERE ((team_members.profile_id = (select auth.uid())) AND (team_members.is_active = true)))) AND (duration_minutes IS NOT NULL) AND (duration_minutes >= 1) AND (duration_minutes <= (24 * 60)) AND (rejected_by IS NULL) AND (rejected_reason IS NULL)));

alter policy "time_entries_worker_delete_active" on public.time_entries
  using (((status = 'active'::time_entry_status) AND (member_id IN ( SELECT team_members.id
   FROM team_members
  WHERE ((team_members.profile_id = (select auth.uid())) AND (team_members.is_active = true))))));

alter policy "time_entries_worker_insert" on public.time_entries
  with check (((EXISTS ( SELECT 1
   FROM team_members tm
  WHERE ((tm.id = time_entries.member_id) AND (tm.provider_id = tm.provider_id) AND (tm.profile_id = (select auth.uid())) AND (tm.is_active = true)))) AND ((kind = 'day'::time_entry_kind) OR ((job_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = time_entries.job_id) AND (j.assigned_member_ids ? (time_entries.member_id)::text))))))));

alter policy "time_entries_worker_select" on public.time_entries
  using ((member_id IN ( SELECT team_members.id
   FROM team_members
  WHERE ((team_members.profile_id = (select auth.uid())) AND (team_members.is_active = true)))));

alter policy "timeline_signals_insert_own" on public.timeline_signals
  with check (((EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = timeline_signals.job_id) AND (j.customer_user_id IS NOT NULL) AND (j.customer_user_id = (select auth.uid()))))) OR (EXISTS ( SELECT 1
   FROM (jobs j
     JOIN providers p ON (((p.id = j.provider_id) OR (p.id = j.assigned_provider_id))))
  WHERE ((j.id = timeline_signals.job_id) AND (p.profile_id = (select auth.uid())))))));

alter policy "timeline_signals_select_own" on public.timeline_signals
  using ((EXISTS ( SELECT 1
   FROM (jobs j
     LEFT JOIN providers p ON ((p.id = COALESCE(j.assigned_provider_id, j.provider_id))))
  WHERE ((j.id = timeline_signals.job_id) AND ((j.customer_user_id = (select auth.uid())) OR (p.profile_id = (select auth.uid())))))));

alter policy "blocked_users_read_block_record" on public.user_blocks
  using (((select auth.uid()) = blocked_id));

alter policy "users_delete_own_blocks" on public.user_blocks
  using (((select auth.uid()) = blocker_id));

alter policy "users_insert_own_blocks" on public.user_blocks
  with check (((select auth.uid()) = blocker_id));

alter policy "users_read_own_blocks" on public.user_blocks
  using (((select auth.uid()) = blocker_id));

alter policy "operators_read_all_reports" on public.user_reports
  using ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = (select auth.uid())) AND (profiles.is_operator = true)))));

alter policy "operators_update_reports" on public.user_reports
  using ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = (select auth.uid())) AND (profiles.is_operator = true)))))
  with check ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = (select auth.uid())) AND (profiles.is_operator = true)))));

alter policy "users_insert_own_reports" on public.user_reports
  with check (((select auth.uid()) = reporter_id));

alter policy "users_read_own_reports" on public.user_reports
  using (((select auth.uid()) = reporter_id));

