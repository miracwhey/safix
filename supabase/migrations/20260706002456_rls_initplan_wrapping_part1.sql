-- RLS initplan hardening 1/3: wrap auth.uid()/jwt()/role() in scalar subselects.
-- Semantically identical; evaluated once per statement instead of per row.

alter policy "absences_owner_select" on public.absences
  using ((provider_id IN ( SELECT providers.id
   FROM providers
  WHERE (providers.profile_id = (select auth.uid())))));

alter policy "absences_owner_update" on public.absences
  using ((provider_id IN ( SELECT providers.id
   FROM providers
  WHERE (providers.profile_id = (select auth.uid())))))
  with check ((provider_id IN ( SELECT providers.id
   FROM providers
  WHERE (providers.profile_id = (select auth.uid())))));

alter policy "absences_worker_cancel" on public.absences
  using (((status = 'active'::absence_status) AND (member_id IN ( SELECT team_members.id
   FROM team_members
  WHERE (team_members.profile_id = (select auth.uid()))))))
  with check (((status = 'cancelled'::absence_status) AND (member_id IN ( SELECT team_members.id
   FROM team_members
  WHERE (team_members.profile_id = (select auth.uid()))))));

alter policy "absences_worker_insert" on public.absences
  with check (((status = 'active'::absence_status) AND (EXISTS ( SELECT 1
   FROM team_members tm
  WHERE ((tm.id = absences.member_id) AND (tm.provider_id = absences.provider_id) AND (tm.profile_id = (select auth.uid())) AND (tm.is_active = true))))));

alter policy "absences_worker_select" on public.absences
  using ((member_id IN ( SELECT team_members.id
   FROM team_members
  WHERE ((team_members.profile_id = (select auth.uid())) AND (team_members.is_active = true)))));

alter policy "absences_worker_sick_note_update" on public.absences
  using (((status = 'active'::absence_status) AND (member_id IN ( SELECT team_members.id
   FROM team_members
  WHERE ((team_members.profile_id = (select auth.uid())) AND (team_members.is_active = true))))))
  with check (((status = 'active'::absence_status) AND (member_id IN ( SELECT team_members.id
   FROM team_members
  WHERE ((team_members.profile_id = (select auth.uid())) AND (team_members.is_active = true))))));

alter policy "acceptances_craftsman_read" on public.acceptances
  using ((EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = acceptances.job_id) AND ((j.craftsman_user_id)::uuid = (select auth.uid()))))));

alter policy "acceptances_customer_insert" on public.acceptances
  with check ((customer_user_id = (select auth.uid())));

alter policy "acceptances_customer_read" on public.acceptances
  using ((customer_user_id = (select auth.uid())));

alter policy "acceptances_customer_update" on public.acceptances
  using ((customer_user_id = (select auth.uid())));

alter policy "acceptances_service_all" on public.acceptances
  using (((select auth.role()) = 'service_role'::text));

alter policy "Operators can read analytics events" on public.analytics_events
  using ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = (select auth.uid())) AND (profiles.is_operator = true)))));

alter policy "analytics_events_insert_self" on public.analytics_events
  with check (((actor_user_id = (select auth.uid())) OR (actor_user_id IS NULL)));

alter policy "attribution_audit_log_operator_read" on public.attribution_audit_log
  using ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = (select auth.uid())) AND (p.is_operator IS TRUE)))));

alter policy "calendar_entries_owner_insert" on public.calendar_entries
  with check ((((provider_id IS NOT NULL) AND (provider_id IN ( SELECT providers.id
   FROM providers
  WHERE (providers.profile_id = (select auth.uid()))))) OR ((provider_id IS NULL) AND (job_id IN ( SELECT jobs.id
   FROM jobs
  WHERE (jobs.craftsman_user_id = ((select auth.uid()))::text))))));

alter policy "calendar_entries_owner_select" on public.calendar_entries
  using ((((provider_id IS NOT NULL) AND (provider_id IN ( SELECT providers.id
   FROM providers
  WHERE (providers.profile_id = (select auth.uid()))))) OR ((provider_id IS NULL) AND (job_id IN ( SELECT jobs.id
   FROM jobs
  WHERE (jobs.craftsman_user_id = ((select auth.uid()))::text))))));

alter policy "calendar_entries_owner_update" on public.calendar_entries
  using ((((provider_id IS NOT NULL) AND (provider_id IN ( SELECT providers.id
   FROM providers
  WHERE (providers.profile_id = (select auth.uid()))))) OR ((provider_id IS NULL) AND (job_id IN ( SELECT jobs.id
   FROM jobs
  WHERE (jobs.craftsman_user_id = ((select auth.uid()))::text))))))
  with check ((((provider_id IS NOT NULL) AND (provider_id IN ( SELECT providers.id
   FROM providers
  WHERE (providers.profile_id = (select auth.uid()))))) OR ((provider_id IS NULL) AND (job_id IN ( SELECT jobs.id
   FROM jobs
  WHERE (jobs.craftsman_user_id = ((select auth.uid()))::text))))));

alter policy "calendar_entries_worker_select" on public.calendar_entries
  using ((EXISTS ( SELECT 1
   FROM team_members tm
  WHERE ((tm.profile_id = (select auth.uid())) AND (tm.provider_id = calendar_entries.provider_id) AND (calendar_entries.assigned_member_ids @> ARRAY[(tm.id)::text])))));

alter policy "calendar_entries_worker_update" on public.calendar_entries
  using ((EXISTS ( SELECT 1
   FROM team_members tm
  WHERE ((tm.profile_id = (select auth.uid())) AND (tm.provider_id = calendar_entries.provider_id) AND (calendar_entries.assigned_member_ids @> ARRAY[(tm.id)::text])))));

alter policy "change_orders_craftsman_insert" on public.change_orders
  with check ((craftsman_user_id = (select auth.uid())));

alter policy "change_orders_craftsman_read" on public.change_orders
  using ((craftsman_user_id = (select auth.uid())));

alter policy "change_orders_craftsman_update" on public.change_orders
  using ((craftsman_user_id = (select auth.uid())))
  with check ((craftsman_user_id = (select auth.uid())));

alter policy "change_orders_customer_read" on public.change_orders
  using ((customer_user_id = (select auth.uid())));

alter policy "change_orders_customer_update" on public.change_orders
  using ((customer_user_id = (select auth.uid())))
  with check ((customer_user_id = (select auth.uid())));

alter policy "change_orders_service_all" on public.change_orders
  using (((select auth.role()) = 'service_role'::text));

alter policy "company_code_audit_select_owner" on public.company_code_audit
  using ((provider_id IN ( SELECT providers.id
   FROM providers
  WHERE (providers.profile_id = (select auth.uid())))));

alter policy "join_codes_owner_all" on public.company_join_codes
  using ((provider_id IN ( SELECT providers.id
   FROM providers
  WHERE (providers.profile_id = (select auth.uid())))))
  with check ((provider_id IN ( SELECT providers.id
   FROM providers
  WHERE (providers.profile_id = (select auth.uid())))));

alter policy "conversations_insert_own" on public.conversations
  with check ((customer_user_id = (select auth.uid())));

alter policy "conversations_select_own" on public.conversations
  using (((craftsman_user_id = (select auth.uid())) OR (customer_user_id = (select auth.uid()))));

alter policy "conversations_update_own" on public.conversations
  using (((craftsman_user_id = (select auth.uid())) OR (customer_user_id = (select auth.uid()))))
  with check (((craftsman_user_id = (select auth.uid())) OR (customer_user_id = (select auth.uid()))));

alter policy "correction_requests_owner_select" on public.correction_requests
  using ((provider_id IN ( SELECT providers.id
   FROM providers
  WHERE (providers.profile_id = (select auth.uid())))));

alter policy "correction_requests_owner_update" on public.correction_requests
  using ((provider_id IN ( SELECT providers.id
   FROM providers
  WHERE (providers.profile_id = (select auth.uid())))))
  with check ((provider_id IN ( SELECT providers.id
   FROM providers
  WHERE (providers.profile_id = (select auth.uid())))));

alter policy "correction_requests_worker_insert" on public.correction_requests
  with check ((worker_profile_id = (select auth.uid())));

alter policy "correction_requests_worker_select" on public.correction_requests
  using ((worker_profile_id = (select auth.uid())));

alter policy "craftsman_profiles_delete_own" on public.craftsman_profiles
  using ((user_id = ((select auth.uid()))::text));

alter policy "craftsman_profiles_insert_own" on public.craftsman_profiles
  with check ((user_id = ((select auth.uid()))::text));

alter policy "craftsman_profiles_select_authenticated" on public.craftsman_profiles
  using (((select auth.role()) = 'authenticated'::text));

alter policy "craftsman_profiles_update_own" on public.craftsman_profiles
  using ((user_id = ((select auth.uid()))::text));

alter policy "craftsman_subscriptions_select_own" on public.craftsman_subscriptions
  using ((profile_id = (select auth.uid())));

alter policy "customer_billing_profiles_insert_own" on public.customer_billing_profiles
  with check (((select auth.uid()) = user_id));

alter policy "customer_billing_profiles_select_own" on public.customer_billing_profiles
  using (((select auth.uid()) = user_id));

alter policy "customer_billing_profiles_update_own" on public.customer_billing_profiles
  using (((select auth.uid()) = user_id))
  with check (((select auth.uid()) = user_id));

alter policy "authenticated_insert_relationships" on public.customer_provider_relationships
  with check (((select auth.uid()) IS NOT NULL));

alter policy "craftsman_read_own_relationships" on public.customer_provider_relationships
  using ((craftsman_user_id = (select auth.uid())));

alter policy "customer_read_own_relationships" on public.customer_provider_relationships
  using ((customer_user_id = (select auth.uid())));

alter policy "customer_request_sends_insert_own" on public.customer_request_sends
  with check (((select auth.uid()) = user_id));

alter policy "customer_request_sends_select_own" on public.customer_request_sends
  using (((select auth.uid()) = user_id));

alter policy "dispute_evidence_insert_self" on public.dispute_evidence
  with check ((uploaded_by_profile_id = (select auth.uid())));

alter policy "dispute_spatial_evidence_service_role_all" on public.dispute_spatial_evidence
  using (((select auth.role()) = 'service_role'::text))
  with check (((select auth.role()) = 'service_role'::text));

alter policy "dsp_select_own" on public.dispute_split_proposals
  using (((proposed_by = (select auth.uid())) OR ((confirmed_by IS NOT NULL) AND (confirmed_by = (select auth.uid()))) OR (EXISTS ( SELECT 1
   FROM disputes d
  WHERE ((d.id = dispute_split_proposals.dispute_id) AND (d.customer_profile_id IS NOT NULL) AND (d.customer_profile_id = (select auth.uid()))))) OR (EXISTS ( SELECT 1
   FROM (disputes d
     JOIN providers pr ON ((pr.id = d.provider_id)))
  WHERE ((d.id = dispute_split_proposals.dispute_id) AND (pr.profile_id = (select auth.uid()))))) OR (EXISTS ( SELECT 1
   FROM disputes d
  WHERE ((d.id = dispute_split_proposals.dispute_id) AND (d.opened_by_profile_id IS NOT NULL) AND (d.opened_by_profile_id = (select auth.uid()))))) OR (EXISTS ( SELECT 1
   FROM (disputes d
     JOIN jobs j ON ((j.id = d.job_id)))
  WHERE ((d.id = dispute_split_proposals.dispute_id) AND (j.craftsman_user_id IS NOT NULL) AND (j.craftsman_user_id = ((select auth.uid()))::text)))) OR (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = (select auth.uid())) AND (p.is_operator = true))))));

alter policy "dispute_history_insert_client_own_side" on public.dispute_status_history
  with check (((source = 'client'::text) AND (EXISTS ( SELECT 1
   FROM disputes d
  WHERE ((d.id = dispute_status_history.dispute_id) AND ((d.opened_by_profile_id = (select auth.uid())) OR (d.customer_profile_id = (select auth.uid())) OR (d.provider_id IN ( SELECT providers.id
           FROM providers
          WHERE (providers.profile_id = (select auth.uid()))))))))));

alter policy "dispute_history_select_own_side" on public.dispute_status_history
  using (((EXISTS ( SELECT 1
   FROM disputes d
  WHERE ((d.id = dispute_status_history.dispute_id) AND ((d.opened_by_profile_id = (select auth.uid())) OR (d.customer_profile_id = (select auth.uid())) OR (d.provider_id IN ( SELECT providers.id
           FROM providers
          WHERE (providers.profile_id = (select auth.uid())))))))) OR (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = (select auth.uid())) AND (p.is_operator = true))))));

alter policy "disputes_insert_own_side" on public.disputes
  with check (((opened_by_profile_id = (select auth.uid())) AND (job_id IN ( SELECT j.id
   FROM jobs j
  WHERE ((j.customer_user_id = (select auth.uid())) OR (j.customer_profile_id = (select auth.uid())) OR (j.craftsman_user_id = ((select auth.uid()))::text) OR (j.provider_id IN ( SELECT pr.id
           FROM providers pr
          WHERE (pr.profile_id = (select auth.uid())))))))));

alter policy "disputes_select_own_side" on public.disputes
  using (((opened_by_profile_id = (select auth.uid())) OR (customer_profile_id = (select auth.uid())) OR (provider_id IN ( SELECT providers.id
   FROM providers
  WHERE (providers.profile_id = (select auth.uid())))) OR (provider_id IN ( SELECT tm.provider_id
   FROM team_members tm
  WHERE ((tm.profile_id = (select auth.uid())) AND (tm.is_active = true)))) OR (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = (select auth.uid())) AND (p.is_operator = true))))));

alter policy "disputes_update_own_side" on public.disputes
  using (((opened_by_profile_id = (select auth.uid())) OR (customer_profile_id = (select auth.uid())) OR (provider_id IN ( SELECT providers.id
   FROM providers
  WHERE (providers.profile_id = (select auth.uid())))) OR (provider_id IN ( SELECT tm.provider_id
   FROM team_members tm
  WHERE ((tm.profile_id = (select auth.uid())) AND (tm.is_active = true)))) OR (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = (select auth.uid())) AND (p.is_operator = true))))))
  with check (((opened_by_profile_id = (select auth.uid())) OR (customer_profile_id = (select auth.uid())) OR (provider_id IN ( SELECT providers.id
   FROM providers
  WHERE (providers.profile_id = (select auth.uid())))) OR (provider_id IN ( SELECT tm.provider_id
   FROM team_members tm
  WHERE ((tm.profile_id = (select auth.uid())) AND (tm.is_active = true)))) OR (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = (select auth.uid())) AND (p.is_operator = true))))));

alter policy "download_jobs_view" on public.download_jobs
  using (((requested_by = (select auth.uid())) OR spatial_can_view_scan(scan_id, (select auth.uid()))));

alter policy "escrow_plans_customer_insert" on public.escrow_payment_plans
  with check (((select auth.uid()) = customer_user_id));

alter policy "escrow_plans_customer_read" on public.escrow_payment_plans
  using (((select auth.uid()) = customer_user_id));

alter policy "escrow_plans_customer_update" on public.escrow_payment_plans
  using (((select auth.uid()) = customer_user_id))
  with check (((select auth.uid()) = customer_user_id));

alter policy "escrow_plans_provider_read" on public.escrow_payment_plans
  using ((EXISTS ( SELECT 1
   FROM providers
  WHERE ((providers.id = escrow_payment_plans.provider_id) AND (providers.profile_id = (select auth.uid()))))));

alter policy "escrow_plans_service_all" on public.escrow_payment_plans
  using (((select auth.role()) = 'service_role'::text))
  with check (((select auth.role()) = 'service_role'::text));

alter policy "escrow_tranches_customer_insert" on public.escrow_tranches
  with check ((EXISTS ( SELECT 1
   FROM escrow_payment_plans
  WHERE ((escrow_payment_plans.id = escrow_tranches.plan_id) AND (escrow_payment_plans.customer_user_id = (select auth.uid()))))));

alter policy "escrow_tranches_customer_read" on public.escrow_tranches
  using ((EXISTS ( SELECT 1
   FROM escrow_payment_plans
  WHERE ((escrow_payment_plans.id = escrow_tranches.plan_id) AND (escrow_payment_plans.customer_user_id = (select auth.uid()))))));

alter policy "escrow_tranches_customer_update" on public.escrow_tranches
  using ((EXISTS ( SELECT 1
   FROM escrow_payment_plans
  WHERE ((escrow_payment_plans.id = escrow_tranches.plan_id) AND (escrow_payment_plans.customer_user_id = (select auth.uid()))))))
  with check ((EXISTS ( SELECT 1
   FROM escrow_payment_plans
  WHERE ((escrow_payment_plans.id = escrow_tranches.plan_id) AND (escrow_payment_plans.customer_user_id = (select auth.uid()))))));

alter policy "escrow_tranches_provider_read" on public.escrow_tranches
  using ((EXISTS ( SELECT 1
   FROM (escrow_payment_plans
     JOIN providers ON ((providers.id = escrow_payment_plans.provider_id)))
  WHERE ((escrow_payment_plans.id = escrow_tranches.plan_id) AND (providers.profile_id = (select auth.uid()))))));

alter policy "escrow_tranches_service_all" on public.escrow_tranches
  using (((select auth.role()) = 'service_role'::text))
  with check (((select auth.role()) = 'service_role'::text));

alter policy "feature_flags_delete_operator" on public.feature_flags
  using ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = (select auth.uid())) AND (profiles.is_operator = true)))));

alter policy "feature_flags_insert_operator" on public.feature_flags
  with check ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = (select auth.uid())) AND (profiles.is_operator = true)))));

alter policy "feature_flags_update_operator" on public.feature_flags
  using ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = (select auth.uid())) AND (profiles.is_operator = true)))))
  with check ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = (select auth.uid())) AND (profiles.is_operator = true)))));

alter policy "funding_requests_customer_read" on public.funding_requests
  using (((select auth.uid()) = customer_user_id));

alter policy "funding_requests_provider_insert" on public.funding_requests
  with check (((select auth.uid()) = provider_user_id));

alter policy "funding_requests_provider_read" on public.funding_requests
  using (((select auth.uid()) = provider_user_id));

alter policy "funding_requests_provider_update" on public.funding_requests
  using (((select auth.uid()) = provider_user_id))
  with check (((select auth.uid()) = provider_user_id));

alter policy "funding_requests_service_all" on public.funding_requests
  using (((select auth.role()) = 'service_role'::text))
  with check (((select auth.role()) = 'service_role'::text));

alter policy "imsg_owner_select" on public.internal_messages
  using ((EXISTS ( SELECT 1
   FROM message_threads mt
  WHERE ((mt.id = internal_messages.thread_id) AND (mt.provider_id IN ( SELECT providers.id
           FROM providers
          WHERE (providers.profile_id = (select auth.uid()))))))));

alter policy "imsg_participant_insert" on public.internal_messages
  with check (((sender_kind = 'user'::text) AND (sender_team_member_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM (message_thread_participants mtp
     JOIN team_members tm ON (((tm.id)::text = mtp.team_member_id)))
  WHERE ((mtp.thread_id = internal_messages.thread_id) AND (mtp.team_member_id = internal_messages.sender_team_member_id) AND (mtp.is_active = true) AND (tm.profile_id = (select auth.uid())))))));
