-- RLS initplan hardening 2/3: wrap auth.uid()/jwt()/role() in scalar subselects.
-- Semantically identical; evaluated once per statement instead of per row.

alter policy "imsg_participant_select" on public.internal_messages
  using ((EXISTS ( SELECT 1
   FROM (message_thread_participants mtp
     JOIN team_members tm ON (((tm.id)::text = mtp.team_member_id)))
  WHERE ((mtp.thread_id = internal_messages.thread_id) AND (mtp.is_active = true) AND (tm.profile_id = (select auth.uid()))))));

alter policy "internal_messages_pro_gate_insert" on public.internal_messages
  with check (is_pro_owner((select auth.uid())));

alter policy "invoices_insert_own" on public.invoices
  with check ((EXISTS ( SELECT 1
   FROM (jobs j
     LEFT JOIN providers p ON ((p.id = COALESCE(j.assigned_provider_id, j.provider_id))))
  WHERE ((j.id = invoices.job_id) AND (p.profile_id = (select auth.uid()))))));

alter policy "invoices_select_own" on public.invoices
  using ((EXISTS ( SELECT 1
   FROM (jobs j
     LEFT JOIN providers p ON ((p.id = COALESCE(j.assigned_provider_id, j.provider_id))))
  WHERE ((j.id = invoices.job_id) AND ((j.customer_user_id = (select auth.uid())) OR (p.profile_id = (select auth.uid())))))));

alter policy "invoices_update_own" on public.invoices
  using ((EXISTS ( SELECT 1
   FROM (jobs j
     LEFT JOIN providers p ON ((p.id = COALESCE(j.assigned_provider_id, j.provider_id))))
  WHERE ((j.id = invoices.job_id) AND (p.profile_id = (select auth.uid()))))));

alter policy "Job assignments: insert own provider" on public.job_assignments
  with check ((EXISTS ( SELECT 1
   FROM providers p
  WHERE ((p.id = job_assignments.provider_id) AND (p.profile_id = (select auth.uid()))))));

alter policy "Job assignments: read own provider" on public.job_assignments
  using ((EXISTS ( SELECT 1
   FROM providers p
  WHERE ((p.id = job_assignments.provider_id) AND (p.profile_id = (select auth.uid()))))));

alter policy "Job assignments: update own provider" on public.job_assignments
  using ((EXISTS ( SELECT 1
   FROM providers p
  WHERE ((p.id = job_assignments.provider_id) AND (p.profile_id = (select auth.uid()))))))
  with check ((EXISTS ( SELECT 1
   FROM providers p
  WHERE ((p.id = job_assignments.provider_id) AND (p.profile_id = (select auth.uid()))))));

alter policy "job_feedback_insert_authenticated" on public.job_feedback
  with check (((select auth.role()) = 'authenticated'::text));

alter policy "job_feedback_update_authenticated" on public.job_feedback
  using (((select auth.role()) = 'authenticated'::text));

alter policy "job_photos_customer_select" on public.job_photos
  using ((job_id IN ( SELECT jobs.id
   FROM jobs
  WHERE ((jobs.customer_user_id = (select auth.uid())) OR (jobs.customer_profile_id = (select auth.uid()))))));

alter policy "job_photos_owner_all" on public.job_photos
  using ((provider_id IN ( SELECT providers.id
   FROM providers
  WHERE (providers.profile_id = (select auth.uid())))))
  with check ((provider_id IN ( SELECT providers.id
   FROM providers
  WHERE (providers.profile_id = (select auth.uid())))));

alter policy "job_photos_worker_delete_recent" on public.job_photos
  using (((uploaded_by = (select auth.uid())) AND (created_at > (now() - '24:00:00'::interval))));

alter policy "job_photos_worker_insert" on public.job_photos
  with check (((uploaded_by = (select auth.uid())) AND (provider_id IN ( SELECT tm.provider_id
   FROM team_members tm
  WHERE ((tm.profile_id = (select auth.uid())) AND (tm.is_active = true)))) AND (EXISTS ( SELECT 1
   FROM (jobs j
     JOIN team_members tm ON (((tm.profile_id = (select auth.uid())) AND (tm.is_active = true) AND (tm.provider_id = j.provider_id))))
  WHERE ((j.id = job_photos.job_id) AND ((j.assigned_member_ids ? (tm.id)::text) OR (j.assigned_team_member_id = tm.id)))))));

alter policy "job_photos_worker_select" on public.job_photos
  using ((provider_id IN ( SELECT team_members.provider_id
   FROM team_members
  WHERE ((team_members.profile_id = (select auth.uid())) AND (team_members.is_active = true)))));

alter policy "job_reports_customer_select" on public.job_reports
  using ((job_id IN ( SELECT jobs.id
   FROM jobs
  WHERE ((jobs.customer_user_id = (select auth.uid())) OR (jobs.customer_profile_id = (select auth.uid()))))));

alter policy "job_reports_owner_all" on public.job_reports
  using ((provider_id IN ( SELECT providers.id
   FROM providers
  WHERE (providers.profile_id = (select auth.uid())))))
  with check ((provider_id IN ( SELECT providers.id
   FROM providers
  WHERE (providers.profile_id = (select auth.uid())))));

alter policy "job_reports_worker_delete_recent" on public.job_reports
  using (((authored_by = (select auth.uid())) AND (created_at > (now() - '24:00:00'::interval))));

alter policy "job_reports_worker_insert" on public.job_reports
  with check (((authored_by = (select auth.uid())) AND (provider_id IN ( SELECT tm.provider_id
   FROM team_members tm
  WHERE ((tm.profile_id = (select auth.uid())) AND (tm.is_active = true)))) AND (EXISTS ( SELECT 1
   FROM (jobs j
     JOIN team_members tm ON (((tm.profile_id = (select auth.uid())) AND (tm.is_active = true) AND (tm.provider_id = j.provider_id))))
  WHERE ((j.id = job_reports.job_id) AND ((j.assigned_member_ids ? (tm.id)::text) OR (j.assigned_team_member_id = tm.id)))))));

alter policy "job_reports_worker_select" on public.job_reports
  using ((provider_id IN ( SELECT team_members.provider_id
   FROM team_members
  WHERE ((team_members.profile_id = (select auth.uid())) AND (team_members.is_active = true)))));

alter policy "job_reports_worker_update_own" on public.job_reports
  using (((authored_by = (select auth.uid())) AND (created_at > (now() - '24:00:00'::interval))))
  with check ((authored_by = (select auth.uid())));

alter policy "Jobs: insert own customer" on public.jobs
  with check ((customer_user_id = (select auth.uid())));

alter policy "Jobs: read own customer or provider" on public.jobs
  using (((customer_user_id = (select auth.uid())) OR (EXISTS ( SELECT 1
   FROM providers p
  WHERE ((p.id = jobs.provider_id) AND (p.profile_id = (select auth.uid()))))) OR (EXISTS ( SELECT 1
   FROM providers p
  WHERE ((p.id = jobs.assigned_provider_id) AND (p.profile_id = (select auth.uid())))))));

alter policy "Jobs: read own team member" on public.jobs
  using ((EXISTS ( SELECT 1
   FROM team_members tm
  WHERE ((tm.provider_id = jobs.provider_id) AND (tm.profile_id = (select auth.uid())) AND (tm.is_active = true)))));

alter policy "Jobs: update own customer or provider" on public.jobs
  using (((customer_user_id = (select auth.uid())) OR (EXISTS ( SELECT 1
   FROM providers p
  WHERE ((p.id = jobs.provider_id) AND (p.profile_id = (select auth.uid()))))) OR (EXISTS ( SELECT 1
   FROM providers p
  WHERE ((p.id = jobs.assigned_provider_id) AND (p.profile_id = (select auth.uid())))))))
  with check (((customer_user_id = (select auth.uid())) OR (EXISTS ( SELECT 1
   FROM providers p
  WHERE ((p.id = jobs.provider_id) AND (p.profile_id = (select auth.uid()))))) OR (EXISTS ( SELECT 1
   FROM providers p
  WHERE ((p.id = jobs.assigned_provider_id) AND (p.profile_id = (select auth.uid())))))));

alter policy "Ledger: read own payment/job/dispute" on public.ledger_entries
  using (((EXISTS ( SELECT 1
   FROM payments p
  WHERE ((p.id = ledger_entries.payment_id) AND ((p.customer_profile_id = (select auth.uid())) OR (EXISTS ( SELECT 1
           FROM providers pr
          WHERE ((pr.id = p.provider_id) AND (pr.profile_id = (select auth.uid()))))))))) OR (EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = ledger_entries.job_id) AND ((j.customer_profile_id = (select auth.uid())) OR (EXISTS ( SELECT 1
           FROM providers pr
          WHERE ((pr.id = j.provider_id) AND (pr.profile_id = (select auth.uid()))))) OR (EXISTS ( SELECT 1
           FROM providers pr
          WHERE ((pr.id = j.assigned_provider_id) AND (pr.profile_id = (select auth.uid()))))))))) OR (EXISTS ( SELECT 1
   FROM disputes d
  WHERE ((d.id = ledger_entries.dispute_id) AND ((d.opened_by_profile_id = (select auth.uid())) OR (d.customer_profile_id = (select auth.uid())) OR (EXISTS ( SELECT 1
           FROM providers pr
          WHERE ((pr.id = d.provider_id) AND (pr.profile_id = (select auth.uid())))))))))));

alter policy "media_artifacts_insert_own" on public.media_artifacts
  with check ((EXISTS ( SELECT 1
   FROM (jobs j
     LEFT JOIN providers p ON ((p.id = COALESCE(j.assigned_provider_id, j.provider_id))))
  WHERE ((j.id = media_artifacts.job_id) AND (p.profile_id = (select auth.uid()))))));

alter policy "media_artifacts_select_own" on public.media_artifacts
  using ((EXISTS ( SELECT 1
   FROM (jobs j
     LEFT JOIN providers p ON ((p.id = COALESCE(j.assigned_provider_id, j.provider_id))))
  WHERE ((j.id = media_artifacts.job_id) AND ((j.customer_user_id = (select auth.uid())) OR (p.profile_id = (select auth.uid())))))));

alter policy "media_uploads_delete_own" on public.media_uploads
  using ((owner_user_id = ((select auth.uid()))::text));

alter policy "media_uploads_insert_party_scoped" on public.media_uploads
  with check (((owner_user_id = ((select auth.uid()))::text) AND (((entity_type = 'profile'::text) AND (entity_id = ((select auth.uid()))::text)) OR ((entity_type = ANY (ARRAY['showcase'::text, 'portfolio'::text])) AND (EXISTS ( SELECT 1
   FROM providers p
  WHERE (((p.id)::text = media_uploads.entity_id) AND (p.profile_id = (select auth.uid())))))) OR ((entity_type = 'job'::text) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE (((j.id)::text = media_uploads.entity_id) AND ((j.customer_user_id = (select auth.uid())) OR (j.craftsman_user_id = ((select auth.uid()))::text)))))) OR ((entity_type = 'project'::text) AND (EXISTS ( SELECT 1
   FROM projects pr
  WHERE (((pr.id)::text = media_uploads.entity_id) AND ((pr.craftsman_user_id = (select auth.uid())) OR (pr.customer_user_id = (select auth.uid()))))))) OR ((entity_type = 'dispute'::text) AND (EXISTS ( SELECT 1
   FROM disputes d
  WHERE (((d.id)::text = media_uploads.entity_id) AND ((d.opened_by_profile_id = (select auth.uid())) OR (d.customer_profile_id = (select auth.uid())) OR (EXISTS ( SELECT 1
           FROM providers pv
          WHERE ((pv.id = d.provider_id) AND (pv.profile_id = (select auth.uid())))))))))))));

alter policy "media_uploads_select_customer_visible" on public.media_uploads
  using (((entity_type = 'job'::text) AND (customer_visible = true) AND (EXISTS ( SELECT 1
   FROM jobs
  WHERE ((jobs.id = (media_uploads.entity_id)::uuid) AND (jobs.customer_user_id = (select auth.uid())))))));

alter policy "media_uploads_select_party_scoped" on public.media_uploads
  using (((owner_user_id = ((select auth.uid()))::text) OR (entity_type = ANY (ARRAY['profile'::text, 'showcase'::text, 'portfolio'::text])) OR ((entity_type = 'dispute'::text) AND (EXISTS ( SELECT 1
   FROM disputes d
  WHERE (((d.id)::text = media_uploads.entity_id) AND ((d.opened_by_profile_id = (select auth.uid())) OR (d.customer_profile_id = (select auth.uid())) OR (EXISTS ( SELECT 1
           FROM providers pv
          WHERE ((pv.id = d.provider_id) AND (pv.profile_id = (select auth.uid())))))))))) OR ((entity_type = 'project'::text) AND (EXISTS ( SELECT 1
   FROM projects pr
  WHERE (((pr.id)::text = media_uploads.entity_id) AND ((pr.craftsman_user_id = (select auth.uid())) OR (pr.customer_user_id = (select auth.uid())))))))));

alter policy "media_uploads_update_own" on public.media_uploads
  using ((owner_user_id = ((select auth.uid()))::text))
  with check ((owner_user_id = ((select auth.uid()))::text));

alter policy "mtp_own_update" on public.message_thread_participants
  using ((EXISTS ( SELECT 1
   FROM team_members tm
  WHERE (((tm.id)::text = message_thread_participants.team_member_id) AND (tm.profile_id = (select auth.uid()))))))
  with check ((EXISTS ( SELECT 1
   FROM team_members tm
  WHERE (((tm.id)::text = message_thread_participants.team_member_id) AND (tm.profile_id = (select auth.uid()))))));

alter policy "mtp_select" on public.message_thread_participants
  using (((EXISTS ( SELECT 1
   FROM team_members tm
  WHERE (((tm.id)::text = message_thread_participants.team_member_id) AND (tm.profile_id = (select auth.uid()))))) OR (EXISTS ( SELECT 1
   FROM (message_threads mt
     JOIN providers p ON ((p.id = mt.provider_id)))
  WHERE ((mt.id = message_thread_participants.thread_id) AND (p.profile_id = (select auth.uid())))))));

alter policy "mthread_owner_insert" on public.message_threads
  with check ((provider_id IN ( SELECT providers.id
   FROM providers
  WHERE (providers.profile_id = (select auth.uid())))));

alter policy "mthread_owner_select" on public.message_threads
  using ((provider_id IN ( SELECT providers.id
   FROM providers
  WHERE (providers.profile_id = (select auth.uid())))));

alter policy "mthread_owner_update" on public.message_threads
  using ((provider_id IN ( SELECT providers.id
   FROM providers
  WHERE (providers.profile_id = (select auth.uid())))));

alter policy "mthread_worker_select" on public.message_threads
  using ((EXISTS ( SELECT 1
   FROM team_members tm
  WHERE ((tm.profile_id = (select auth.uid())) AND (tm.provider_id = message_threads.provider_id) AND (tm.is_active = true)))));

alter policy "messages_insert_own" on public.messages
  with check ((conversation_id IN ( SELECT conversations.id
   FROM conversations
  WHERE ((conversations.craftsman_user_id = (select auth.uid())) OR (conversations.customer_user_id = (select auth.uid()))))));

alter policy "messages_select_own" on public.messages
  using ((conversation_id IN ( SELECT conversations.id
   FROM conversations
  WHERE ((conversations.craftsman_user_id = (select auth.uid())) OR (conversations.customer_user_id = (select auth.uid()))))));

alter policy "ndt_delete_own" on public.notification_device_tokens
  using ((user_id = ((select auth.uid()))::text));

alter policy "ndt_insert_own" on public.notification_device_tokens
  with check ((user_id = ((select auth.uid()))::text));

alter policy "ndt_select_own" on public.notification_device_tokens
  using ((user_id = ((select auth.uid()))::text));

alter policy "ndt_update_own" on public.notification_device_tokens
  using ((user_id = ((select auth.uid()))::text));

alter policy "notification_signals_insert_own" on public.notification_signals
  with check (((EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = notification_signals.job_id) AND (j.customer_user_id IS NOT NULL) AND (j.customer_user_id = (select auth.uid()))))) OR (EXISTS ( SELECT 1
   FROM (jobs j
     JOIN providers p ON (((p.id = j.provider_id) OR (p.id = j.assigned_provider_id))))
  WHERE ((j.id = notification_signals.job_id) AND (p.profile_id = (select auth.uid())))))));

alter policy "notification_signals_select_own" on public.notification_signals
  using ((((recipient_role = 'craftsman'::text) AND (EXISTS ( SELECT 1
   FROM (jobs j
     JOIN providers p ON (((p.id = j.provider_id) OR (p.id = j.assigned_provider_id))))
  WHERE ((j.id = notification_signals.job_id) AND (p.profile_id = (select auth.uid())))))) OR ((recipient_role = 'customer'::text) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = notification_signals.job_id) AND (j.customer_user_id IS NOT NULL) AND (j.customer_user_id = (select auth.uid()))))))));

alter policy "notification_signals_update_own" on public.notification_signals
  using ((((recipient_role = 'craftsman'::text) AND (EXISTS ( SELECT 1
   FROM (jobs j
     JOIN providers p ON (((p.id = j.provider_id) OR (p.id = j.assigned_provider_id))))
  WHERE ((j.id = notification_signals.job_id) AND (p.profile_id = (select auth.uid())))))) OR ((recipient_role = 'customer'::text) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = notification_signals.job_id) AND (j.customer_user_id IS NOT NULL) AND (j.customer_user_id = (select auth.uid()))))))));

alter policy "offers_insert_craftsman" on public.offers
  with check (((select auth.uid()) = craftsman_user_id));

alter policy "offers_select_own" on public.offers
  using ((((select auth.uid()) = craftsman_user_id) OR ((select auth.uid()) = customer_user_id)));

alter policy "offers_select_team_member" on public.offers
  using ((craftsman_user_id = spatial_user_org_owner_profile((select auth.uid()))));

alter policy "offers_update_own" on public.offers
  using ((((select auth.uid()) = craftsman_user_id) OR ((select auth.uid()) = customer_user_id)))
  with check ((((select auth.uid()) = craftsman_user_id) OR ((select auth.uid()) = customer_user_id)));

alter policy "Operators can insert own audit entries" on public.operator_action_audit
  with check ((operator_id = (select auth.uid())));

alter policy "owner_notes_owner_all" on public.owner_notes
  using ((job_id IN ( SELECT j.id
   FROM (jobs j
     JOIN providers p ON ((p.id = j.provider_id)))
  WHERE (p.profile_id = (select auth.uid())))))
  with check (((authored_by = (select auth.uid())) AND (job_id IN ( SELECT j.id
   FROM (jobs j
     JOIN providers p ON ((p.id = j.provider_id)))
  WHERE (p.profile_id = (select auth.uid()))))));

alter policy "owner_notes_worker_select" on public.owner_notes
  using ((job_id IN ( SELECT j.id
   FROM (jobs j
     JOIN team_members tm ON (((tm.provider_id = j.provider_id) AND (tm.profile_id = (select auth.uid())) AND (tm.is_active = true)))))));

alter policy "Payments: insert own customer or provider" on public.payments
  with check (((customer_profile_id = (select auth.uid())) OR (customer_user_id = (select auth.uid())) OR (craftsman_user_id = (select auth.uid())) OR (EXISTS ( SELECT 1
   FROM providers p
  WHERE ((p.id = payments.provider_id) AND (p.profile_id = (select auth.uid())))))));

alter policy "Payments: read own customer or provider" on public.payments
  using (((customer_profile_id = (select auth.uid())) OR (customer_user_id = (select auth.uid())) OR (craftsman_user_id = (select auth.uid())) OR (EXISTS ( SELECT 1
   FROM providers p
  WHERE ((p.id = payments.provider_id) AND (p.profile_id = (select auth.uid())))))));

alter policy "Payments: update own customer or provider" on public.payments
  using (((customer_profile_id = (select auth.uid())) OR (customer_user_id = (select auth.uid())) OR (craftsman_user_id = (select auth.uid())) OR (EXISTS ( SELECT 1
   FROM providers p
  WHERE ((p.id = payments.provider_id) AND (p.profile_id = (select auth.uid())))))))
  with check (((customer_profile_id = (select auth.uid())) OR (customer_user_id = (select auth.uid())) OR (craftsman_user_id = (select auth.uid())) OR (EXISTS ( SELECT 1
   FROM providers p
  WHERE ((p.id = payments.provider_id) AND (p.profile_id = (select auth.uid())))))));

alter policy "Profiles: read own" on public.profiles
  using ((id = (select auth.uid())));

alter policy "Profiles: update own" on public.profiles
  using ((id = (select auth.uid())))
  with check ((id = (select auth.uid())));

alter policy "Users can insert own profile" on public.profiles
  with check (((select auth.uid()) = id));

alter policy "Users can read own profile" on public.profiles
  using (((select auth.uid()) = id));

alter policy "Users can update own profile" on public.profiles
  using (((select auth.uid()) = id));

alter policy "Projects: insert own" on public.projects
  with check (((craftsman_user_id = (select auth.uid())) OR (customer_profile_id = (select auth.uid()))));

alter policy "Projects: read own" on public.projects
  using (((craftsman_user_id = (select auth.uid())) OR (customer_profile_id = (select auth.uid())) OR (EXISTS ( SELECT 1
   FROM (jobs j
     LEFT JOIN providers pr ON ((pr.id = j.provider_id)))
  WHERE ((j.id = projects.source_job_id) AND ((j.customer_user_id = (select auth.uid())) OR (pr.profile_id = (select auth.uid()))))))));

alter policy "Projects: update own" on public.projects
  using (((craftsman_user_id = (select auth.uid())) OR (customer_profile_id = (select auth.uid()))))
  with check (((craftsman_user_id = (select auth.uid())) OR (customer_profile_id = (select auth.uid()))));

alter policy "projects_select_shared_in_chat_thread" on public.projects
  using ((EXISTS ( SELECT 1
   FROM (chat_messages m
     JOIN chat_participants p ON ((p.thread_id = m.thread_id)))
  WHERE ((m.message_type = 'artifact_card'::text) AND (m.artifact_type = 'Project'::text) AND (m.artifact_id = (projects.id)::text) AND (m.deleted_at IS NULL) AND (m.sender_user_id = projects.customer_profile_id) AND (p.user_id = (select auth.uid())) AND (p.left_at IS NULL)))));

alter policy "highlight_items_delete_own" on public.provider_highlight_items
  using ((( SELECT provider_highlights.provider_user_id
   FROM provider_highlights
  WHERE (provider_highlights.id = provider_highlight_items.highlight_id)) = (select auth.uid())));

alter policy "highlight_items_insert_own" on public.provider_highlight_items
  with check ((( SELECT provider_highlights.provider_user_id
   FROM provider_highlights
  WHERE (provider_highlights.id = provider_highlight_items.highlight_id)) = (select auth.uid())));

alter policy "highlight_items_update_own" on public.provider_highlight_items
  using ((( SELECT provider_highlights.provider_user_id
   FROM provider_highlights
  WHERE (provider_highlights.id = provider_highlight_items.highlight_id)) = (select auth.uid())));

alter policy "highlights_delete_own" on public.provider_highlights
  using ((provider_user_id = (select auth.uid())));

alter policy "highlights_insert_own" on public.provider_highlights
  with check ((provider_user_id = (select auth.uid())));

alter policy "highlights_update_own" on public.provider_highlights
  using ((provider_user_id = (select auth.uid())))
  with check ((provider_user_id = (select auth.uid())));

alter policy "Provider media: insert own provider" on public.provider_media
  with check ((EXISTS ( SELECT 1
   FROM providers p
  WHERE ((p.id = provider_media.provider_id) AND (p.profile_id = (select auth.uid()))))));

alter policy "Provider media: update own provider" on public.provider_media
  using ((EXISTS ( SELECT 1
   FROM providers p
  WHERE ((p.id = provider_media.provider_id) AND (p.profile_id = (select auth.uid()))))))
  with check ((EXISTS ( SELECT 1
   FROM providers p
  WHERE ((p.id = provider_media.provider_id) AND (p.profile_id = (select auth.uid()))))));

alter policy "provider_media_delete_own" on public.provider_media
  using ((EXISTS ( SELECT 1
   FROM providers p
  WHERE ((p.id = provider_media.provider_id) AND (p.profile_id = (select auth.uid()))))));
