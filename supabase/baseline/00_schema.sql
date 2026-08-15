


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE TYPE "public"."absence_status" AS ENUM (
    'active',
    'cancelled'
);


ALTER TYPE "public"."absence_status" OWNER TO "postgres";


CREATE TYPE "public"."absence_type" AS ENUM (
    'sick',
    'vacation',
    'other'
);


ALTER TYPE "public"."absence_type" OWNER TO "postgres";


CREATE TYPE "public"."scan_anchor_confidence" AS ENUM (
    'high',
    'medium',
    'low',
    'lost'
);


ALTER TYPE "public"."scan_anchor_confidence" OWNER TO "postgres";


CREATE TYPE "public"."scan_annotation_kind" AS ENUM (
    'damage',
    'note',
    'photo',
    'measurement_ref',
    'gewerk_marker'
);


ALTER TYPE "public"."scan_annotation_kind" OWNER TO "postgres";


CREATE TYPE "public"."scan_annotation_status" AS ENUM (
    'open',
    'needs_photo',
    'needs_measurement',
    'offer_relevant',
    'included_in_offer',
    'resolved',
    'dispute_relevant'
);


ALTER TYPE "public"."scan_annotation_status" OWNER TO "postgres";


CREATE TYPE "public"."scan_asset_kind" AS ENUM (
    'usdz',
    'gltf',
    'scan_json',
    'mesh_summary',
    'thumbnail',
    'floorplan_svg',
    'worldmap'
);


ALTER TYPE "public"."scan_asset_kind" OWNER TO "postgres";


CREATE TYPE "public"."scan_event_action" AS ENUM (
    'captured',
    'quality_run',
    'measurement_edited',
    'annotation_added',
    'annotation_resolved',
    'verified',
    'rejected',
    'rescan_requested',
    'rescan_linked',
    'locked',
    'unlocked',
    'archived',
    'asset_converted',
    'drift_detected',
    'download_requested'
);


ALTER TYPE "public"."scan_event_action" OWNER TO "postgres";


CREATE TYPE "public"."scan_measurement_source" AS ENUM (
    'roomplan',
    'depth_checked',
    'manual',
    'laser_bt'
);


ALTER TYPE "public"."scan_measurement_source" OWNER TO "postgres";


CREATE TYPE "public"."scan_measurement_status" AS ENUM (
    'estimated_roomplan',
    'estimated_depth',
    'depth_checked',
    'provider_review_required',
    'provider_verified',
    'rejected',
    'superseded'
);


ALTER TYPE "public"."scan_measurement_status" OWNER TO "postgres";


CREATE TYPE "public"."scan_quality_bucket" AS ENUM (
    'poor',
    'fair',
    'good',
    'excellent'
);


ALTER TYPE "public"."scan_quality_bucket" OWNER TO "postgres";


CREATE TYPE "public"."scan_source" AS ENUM (
    'roomplan',
    'object_capture_area',
    'manual'
);


ALTER TYPE "public"."scan_source" OWNER TO "postgres";


CREATE TYPE "public"."scan_status" AS ENUM (
    'draft',
    'capturing',
    'captured',
    'quality_checked',
    'needs_rescan',
    'needs_provider_review',
    'provider_verified',
    'offer_ready',
    'locked_for_dispute',
    'archived'
);


ALTER TYPE "public"."scan_status" OWNER TO "postgres";


CREATE TYPE "public"."scan_surface_kind" AS ENUM (
    'wall',
    'door',
    'window',
    'opening',
    'object'
);


ALTER TYPE "public"."scan_surface_kind" OWNER TO "postgres";


CREATE TYPE "public"."time_entry_kind" AS ENUM (
    'day',
    'job'
);


ALTER TYPE "public"."time_entry_kind" OWNER TO "postgres";


CREATE TYPE "public"."time_entry_status" AS ENUM (
    'active',
    'closed',
    'rejected'
);


ALTER TYPE "public"."time_entry_status" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_assert_caller_is_operator"() RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'operator_required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_current_user_operator() THEN
    RAISE EXCEPTION 'operator_required' USING ERRCODE = '42501';
  END IF;

  RETURN v_uid;
END;
$$;


ALTER FUNCTION "public"."_assert_caller_is_operator"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_enforce_profile_privileged_columns"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_touches_privileged boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_touches_privileged := (
      NEW.is_operator IS TRUE
      OR COALESCE(NEW.moderation_state, 'active') <> 'active'
      OR NEW.suspension_expires_at IS NOT NULL
    );
  ELSE  -- UPDATE
    v_touches_privileged := (
      NEW.moderation_state      IS DISTINCT FROM OLD.moderation_state
      OR NEW.suspension_expires_at IS DISTINCT FROM OLD.suspension_expires_at
      OR NEW.is_operator         IS DISTINCT FROM OLD.is_operator
      -- H7 role guard: locked once OLD.role is canonical; first-set (NULL / malformed
      -- default '''customer''') passes through.
      OR (
        NEW.role IS DISTINCT FROM OLD.role
        AND OLD.role IN ('customer', 'craftsman')
      )
      -- H7 craftsman_role guard: first-set NULL->value only when OLD.role='craftsman';
      -- post-first-set switch AND clearing a previously-set role are operator-only
      -- (clearing exemption removed -> closes the clear-then-reset worker->owner
      -- laundering bypass; the only legit clear is RoleSelectionScreen's NULL->NULL no-op).
      OR (
        NEW.craftsman_role IS DISTINCT FROM OLD.craftsman_role
        AND (
          OLD.craftsman_role IS NOT NULL
          OR OLD.role IS DISTINCT FROM 'craftsman'
        )
      )
    );
  END IF;

  IF v_touches_privileged
     AND auth.uid() IS NOT NULL
     AND public.is_current_user_operator() IS NOT TRUE
  THEN
    RAISE EXCEPTION
      'profiles: role / craftsman_role changes after first canonical set, and moderation_state / suspension_expires_at / is_operator changes, are operator-only'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."_enforce_profile_privileged_columns"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."account_cascade_delete_owned_rows"("p_user_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v jsonb := '{}'::jsonb;
  n integer;
begin
  if p_user_id is null then
    raise exception 'account_cascade_delete_owned_rows: p_user_id is required'
      using errcode = '22023';
  end if;

  delete from public.spatial_pin_reviews where reviewed_by_user_id = p_user_id;
  get diagnostics n = row_count; v := v || jsonb_build_object('spatial_pin_reviews', n);

  delete from public.spatial_change_orders where proposer_id = p_user_id;
  get diagnostics n = row_count; v := v || jsonb_build_object('spatial_change_orders', n);

  delete from public.spatial_rescan_requests where requested_by_user_id = p_user_id;
  get diagnostics n = row_count; v := v || jsonb_build_object('spatial_rescan_requests', n);

  delete from public.spatial_share_audit where actor_user_id = p_user_id;
  get diagnostics n = row_count; v := v || jsonb_build_object('spatial_share_audit', n);

  delete from public.provider_presales_projects where created_by_user_id = p_user_id;
  get diagnostics n = row_count; v := v || jsonb_build_object('provider_presales_projects', n);

  delete from public.scans where captured_by = p_user_id;
  get diagnostics n = row_count; v := v || jsonb_build_object('scans', n);

  return v;
end;
$$;


ALTER FUNCTION "public"."account_cascade_delete_owned_rows"("p_user_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."account_cascade_delete_owned_rows"("p_user_id" "uuid") IS 'DSGVO · Deletes the rows a user owns/authored across the six tables whose NOT NULL FK to profiles/auth.users blocks admin.deleteUser (scans, provider_presales_projects, spatial_share_audit, spatial_change_orders, spatial_pin_reviews, spatial_rescan_requests). Service-role only. Called by api/delete-account.ts before admin.deleteUser. Returns per-table delete counts.';



CREATE OR REPLACE FUNCTION "public"."account_cascade_list_storage"("p_user_id" "uuid") RETURNS TABLE("bucket_id" "text", "name" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'storage', 'extensions'
    AS $$
BEGIN
  -- 4 user-prefixed buckets (path[1] = userId)
  RETURN QUERY
    SELECT o.bucket_id::text, o.name::text
    FROM storage.objects o
    WHERE o.bucket_id IN (
      'project-scans',
      'spatial-mesh-snapshots',
      'spatial-parametric',
      'spatial-annotation-photos'
    )
    AND o.name LIKE p_user_id::text || '/%';

  -- 2 owner-based buckets (owner column = userId)
  RETURN QUERY
    SELECT o.bucket_id::text, o.name::text
    FROM storage.objects o
    WHERE o.bucket_id IN ('worker-doku-photos', 'media')
    AND o.owner = p_user_id;

  -- sick-notes (mid-segment match: providerId/userId/yyyy/file)
  RETURN QUERY
    SELECT o.bucket_id::text, o.name::text
    FROM storage.objects o
    WHERE o.bucket_id = 'sick-notes'
    AND o.name LIKE '%/' || p_user_id::text || '/%';

  -- 3 chat buckets (thread-prefixed; enumerate via chat_participants)
  RETURN QUERY
    SELECT DISTINCT o.bucket_id::text, o.name::text
    FROM storage.objects o
    JOIN public.chat_participants cp
      ON cp.user_id = p_user_id
      AND o.bucket_id IN ('chat-customer', 'chat-internal', 'chat-dispute')
      AND (o.name LIKE cp.thread_id::text || '/%' OR o.name = cp.thread_id::text);
END;
$$;


ALTER FUNCTION "public"."account_cascade_list_storage"("p_user_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."account_cascade_list_storage"("p_user_id" "uuid") IS 'Phase 5 Spatial V1.6 · DSGVO cascade list helper. Returns (bucket_id, name) for every storage.objects row attributable to the user across the 10 user-owned buckets. SECURITY DEFINER bypasses storage-schema PostgREST exposure restriction. Service-role only. spatial-public-assets EXCLUDED (shared library, never user-owned).';



CREATE OR REPLACE FUNCTION "public"."apply_dispute_default_refund"("p_dispute_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_status             text;
  v_decision           text;
  v_settlement_status  text;
  v_default_applied_at timestamptz;
  v_job_id             uuid;
  v_held_minor         bigint;
  v_result             jsonb;
BEGIN
  SELECT d.status, d.decision, d.settlement_status, d.default_applied_at, d.job_id
    INTO v_status, v_decision, v_settlement_status, v_default_applied_at, v_job_id
    FROM public.disputes d
   WHERE d.id = p_dispute_id
   FOR UPDATE;

  IF v_job_id IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT (
    v_status IN ('open', 'under_review', 'customer_waiting', 'provider_waiting')
    AND v_decision IS NULL
    AND v_default_applied_at IS NULL
  ) THEN
    SELECT row_to_json(d)::jsonb INTO v_result
      FROM public.disputes d
     WHERE d.id = p_dispute_id;
    RETURN v_result;
  END IF;

  -- Held-remainder snapshot (75% side). SHARED held predicate (G4).
  SELECT COALESCE(round(SUM(t.amount) * 100), 0)::bigint
    INTO v_held_minor
    FROM public.escrow_tranches t
    JOIN public.escrow_payment_plans epp ON epp.id = t.plan_id
   WHERE epp.job_id = v_job_id
     AND t.status NOT IN ('released', 'release_pending')
     AND t.external_release_ref  IS NULL
     AND t.external_payout_ref   IS NULL
     AND t.transfer_reversal_ref IS NULL;

  UPDATE public.disputes
     SET status               = 'resolved',
         decision             = 'refund',
         resolution_type      = 'refund_partial',
         split_ratio          = 0.25,
         default_refund_minor = v_held_minor,
         settlement_status    = 'pending',
         default_applied_at   = now(),
         resolved_at          = COALESCE(resolved_at, now()),
         updated_at           = now()
   WHERE id = p_dispute_id;

  INSERT INTO public.dispute_status_history
    (dispute_id, previous_status, next_status, source, note, metadata, job_id)
  VALUES (
    p_dispute_id,
    v_status,
    'resolved',
    'system',
    'AGB T+80 default refund (75/25 partial)',
    jsonb_build_object(
      'auto_default',         true,
      'rule',                 'AGB_T80_default',
      'resolution_type',      'refund_partial',
      'split_ratio',          0.25,
      'default_refund_minor', v_held_minor
    ),
    v_job_id
  );

  UPDATE public.acceptances
     SET status     = 'disputed',
         updated_at = (extract(epoch FROM now()) * 1000)::bigint
   WHERE job_id = v_job_id
     AND status = 'pending';

  UPDATE public.jobs
     SET dispute_status = 'resolved'
   WHERE id = v_job_id;

  SELECT row_to_json(d)::jsonb INTO v_result
    FROM public.disputes d
   WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."apply_dispute_default_refund"("p_dispute_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."apply_dispute_default_refund"("p_dispute_id" "uuid") IS 'P4 Batch 2 - T+80 default cut (75/25): applies AGB default = PARTIAL refund of the still-HELD remainder. Stamps resolution_type=refund_partial, split_ratio=0.25 and the held-remainder snapshot (default_refund_minor). SECURITY DEFINER, service_role ONLY. Idempotent. Dormant when FUNDING_DESTINATION_CHARGE_ENABLED unset.';



CREATE OR REPLACE FUNCTION "public"."assert_attribution_finalized_before_release"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_job_id     UUID;
  v_status     TEXT;
  v_origin     TEXT;
  v_dlq_reason TEXT;
  v_old_status TEXT;
BEGIN
  IF NEW.status IS DISTINCT FROM 'released' THEN
    RETURN NEW;
  END IF;

  v_old_status := CASE WHEN TG_OP = 'UPDATE' THEN OLD.status ELSE NULL END;

  IF v_old_status IS NOT DISTINCT FROM 'released' THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'escrow_tranches' THEN
    IF NEW.plan_id IS NULL THEN
      RAISE EXCEPTION 'ATTRIBUTION_NOT_FINALIZED: missing_plan_id'
        USING ERRCODE = 'P0004',
              DETAIL  = 'escrow_tranches.plan_id is required to resolve the owning job.';
    END IF;

    SELECT job_id INTO v_job_id
    FROM public.escrow_payment_plans
    WHERE id = NEW.plan_id;

    IF v_job_id IS NULL THEN
      RAISE EXCEPTION 'ATTRIBUTION_NOT_FINALIZED: plan_not_found_or_missing_job'
        USING ERRCODE = 'P0004',
              DETAIL  = format('plan_id=%L has no owning job_id', NEW.plan_id);
    END IF;

  ELSIF TG_TABLE_NAME = 'supplementary_payment_requests' THEN
    v_job_id := NEW.job_id;

    IF v_job_id IS NULL THEN
      RAISE EXCEPTION 'ATTRIBUTION_NOT_FINALIZED: missing_job_id'
        USING ERRCODE = 'P0004',
              DETAIL  = 'supplementary_payment_requests.job_id is required.';
    END IF;

  ELSE
    RAISE EXCEPTION 'ATTRIBUTION_NOT_FINALIZED: trigger_misconfigured'
      USING ERRCODE = 'P0004',
            DETAIL  = format('trigger on unknown table %I', TG_TABLE_NAME);
  END IF;

  SELECT attribution_status, commercial_origin, attribution_dlq_reason
  INTO v_status, v_origin, v_dlq_reason
  FROM public.jobs
  WHERE id = v_job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ATTRIBUTION_NOT_FINALIZED: job_not_found'
      USING ERRCODE = 'P0004',
            DETAIL  = format('job_id=%L', v_job_id);
  END IF;

  IF v_status = 'dlq' THEN
    RAISE EXCEPTION 'ATTRIBUTION_NOT_FINALIZED: dlq'
      USING ERRCODE = 'P0004',
            DETAIL  = format('job_id=%L dlq_reason=%L', v_job_id, COALESCE(v_dlq_reason, 'null'));
  END IF;

  IF v_status IS DISTINCT FROM 'finalized' THEN
    RAISE EXCEPTION 'ATTRIBUTION_NOT_FINALIZED: unresolved'
      USING ERRCODE = 'P0004',
            DETAIL  = format('job_id=%L attribution_status=%L', v_job_id, COALESCE(v_status, 'null'));
  END IF;

  IF v_origin IS DISTINCT FROM 'merchant_brought' AND v_origin IS DISTINCT FROM 'platform_acquired' THEN
    RAISE EXCEPTION 'ATTRIBUTION_NOT_FINALIZED: origin_invalid'
      USING ERRCODE = 'P0004',
            DETAIL  = format('job_id=%L commercial_origin=%L', v_job_id, COALESCE(v_origin, 'null'));
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."assert_attribution_finalized_before_release"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."assert_attribution_finalized_before_release"() IS 'DB-level defense: blocks any transition into status=released on escrow_tranches or supplementary_payment_requests when the owning jobs row has attribution_status != finalized or an invalid commercial_origin. Raises SQLSTATE P0004 with ATTRIBUTION_NOT_FINALIZED: prefix.';



CREATE OR REPLACE FUNCTION "public"."become_provider"("p_company_name" "text" DEFAULT NULL::"text", "p_description" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
begin
  -- muss eingeloggt sein
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  -- Rolle im Profile setzen
  update public.profiles
  set role = 'provider'
  where id = auth.uid();

  -- Provider-Row anlegen (falls noch nicht existiert)
  insert into public.providers (id, company_name, description)
  values (auth.uid(), p_company_name, p_description)
  on conflict (id) do update
    set company_name = coalesce(excluded.company_name, public.providers.company_name),
        description  = coalesce(excluded.description,  public.providers.description);
end;
$$;


ALTER FUNCTION "public"."become_provider"("p_company_name" "text", "p_description" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."chat_messages_dispatch_push"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
DECLARE
  v_channel     text;
  v_url         text;
  v_secret      text;
  v_sender_name text;
  v_title       text;
  v_body        text;
  v_pushes      jsonb;
  v_now         bigint;
BEGIN
  -- Nur echte, sichtbare User-Nachrichten pushen. System-Rows sind
  -- app-generierte Notizen (Erstklass-Events pushen bereits über
  -- notification_signals); gelöschte/redactete Rows dürfen nie leaken.
  IF NEW.message_type = 'system' OR NEW.deleted_at IS NOT NULL OR NEW.redacted THEN
    RETURN NEW;
  END IF;

  SELECT ct.channel_type INTO v_channel
  FROM public.chat_threads ct WHERE ct.id = NEW.thread_id;
  IF v_channel IS DISTINCT FROM 'customer' THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT decrypted_secret INTO v_url
    FROM vault.decrypted_secrets WHERE name = 'notify_push.url';
    SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets WHERE name = 'notify_push.shared_secret';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'chat_push: vault unavailable — skipping (sqlstate=%, msg=%)', SQLSTATE, SQLERRM;
    RETURN NEW;
  END;

  IF v_url IS NULL OR v_secret IS NULL THEN
    RAISE NOTICE 'chat_push: vault entries notify_push.url or notify_push.shared_secret missing — skipping';
    RETURN NEW;
  END IF;

  v_now := public.epoch_ms();

  SELECT p.display_name INTO v_sender_name
  FROM public.profiles p WHERE p.id = NEW.sender_user_id;

  -- Generische Copy ohne Nachrichteninhalt (PII-arm, Muster notification_push_copy).
  v_title := 'Neue Nachricht';
  v_body  := CASE
    WHEN v_sender_name IS NOT NULL AND length(btrim(v_sender_name)) > 0
      THEN btrim(v_sender_name) || ' hat Ihnen geschrieben.'
    ELSE 'Sie haben eine neue Nachricht erhalten.'
  END;

  -- Empfänger = alle aktiven Thread-Teilnehmer AUSSER dem Sender:
  --   · left_at IS NULL (noch im Thread)
  --   · nicht gemutet (muted_until in ms, Vergleich gegen epoch_ms())
  --   · Empfänger hat den Sender nicht geblockt (Spiegel des user_blocks-
  --     Filters aus fn_chat_update_thread_last_message)
  -- Route per Teilnehmer-Rolle: customer → /messages/{threadId},
  -- Handwerker-Seite → /craftsman/messages/{threadId}. fallbackRoute = Listen-Tab.
  -- actionVersion = 1 (= PUSH_ROUTE_SCHEMA_VERSION — bei Schema-Bump mitziehen!).
  SELECT
    jsonb_agg(
      jsonb_build_object(
        'token', t.token,
        'title', v_title,
        'body',  v_body,
        'data',  jsonb_build_object(
          'type',          'chat_message',
          'threadId',      NEW.thread_id,
          'messageId',     NEW.id,
          'route',         CASE WHEN cp.role = 'customer'
                             THEN '/messages/'           || NEW.thread_id
                             ELSE '/craftsman/messages/' || NEW.thread_id END,
          'fallbackRoute', CASE WHEN cp.role = 'customer'
                             THEN '/messages'
                             ELSE '/craftsman/messages' END,
          'actionVersion', 1
        )
      )
    )
  INTO v_pushes
  FROM public.chat_participants cp
  JOIN public.notification_device_tokens t
    ON t.user_id = cp.user_id::text
  WHERE cp.thread_id = NEW.thread_id
    AND cp.user_id <> NEW.sender_user_id
    AND cp.left_at IS NULL
    AND (cp.muted_until IS NULL OR cp.muted_until <= v_now)
    AND NOT EXISTS (
      SELECT 1 FROM public.user_blocks ub
      WHERE ub.blocker_id = cp.user_id
        AND ub.blocked_id = NEW.sender_user_id
    );

  IF v_pushes IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    PERFORM net.http_post(
      url     := v_url,
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-fixup-trigger-secret', v_secret
      ),
      body    := jsonb_build_object('pushes', v_pushes),
      timeout_milliseconds := 5000
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'chat_push: pg_net.http_post failed (sqlstate=%, msg=%)', SQLSTATE, SQLERRM;
  END;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Absoluter Backstop: ein werfender AFTER-INSERT-Trigger würde JEDEN
  -- Chat-Send fehlschlagen lassen. Niemals propagieren.
  RAISE NOTICE 'chat_push: dispatch failed — skipping (sqlstate=%, msg=%)', SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."chat_messages_dispatch_push"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."chat_messages_dispatch_push"() IS 'CHAT-3: AFTER-INSERT Push-Dispatch für chat_messages (channel_type=customer) via pg_net → notify-push Edge Function. Non-throwing by design — Fehler dürfen den Chat-Send nie blockieren.';



CREATE OR REPLACE FUNCTION "public"."chat_user_is_thread_admin"("p_thread_id" "uuid", "p_uid" "uuid", "p_include_craftsman" boolean DEFAULT false) RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.chat_participants cp
    WHERE cp.thread_id = p_thread_id
      AND cp.user_id   = p_uid
      AND cp.left_at IS NULL
      AND (
        cp.role IN ('owner', 'admin')
        OR (p_include_craftsman AND cp.role = 'craftsman')
      )
  );
$$;


ALTER FUNCTION "public"."chat_user_is_thread_admin"("p_thread_id" "uuid", "p_uid" "uuid", "p_include_craftsman" boolean) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."chat_user_is_thread_admin"("p_thread_id" "uuid", "p_uid" "uuid", "p_include_craftsman" boolean) IS 'Chat RLS helper: returns true if p_uid is active owner/admin (or optionally craftsman) of p_thread_id. SECDEF bypasses chat_participants self-recursion.';



CREATE OR REPLACE FUNCTION "public"."comment_reply_summary"("p_parent_id" "uuid") RETURNS TABLE("comment_id" "uuid", "like_count" bigint, "liked_by_me" boolean)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  SELECT c.id,
    (SELECT count(*) FROM public.provider_media_comment_likes l WHERE l.comment_id = c.id)::bigint,
    EXISTS (SELECT 1 FROM public.provider_media_comment_likes l WHERE l.comment_id = c.id AND l.user_id = auth.uid())
  FROM public.provider_media_comments c
 WHERE c.parent_comment_id = p_parent_id;
$$;


ALTER FUNCTION "public"."comment_reply_summary"("p_parent_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."comment_thread_summary"("p_media_id" "uuid") RETURNS TABLE("comment_id" "uuid", "reply_count" bigint, "like_count" bigint, "liked_by_me" boolean)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  WITH base AS (
    SELECT id FROM public.provider_media_comments
     WHERE media_id = p_media_id AND parent_comment_id IS NULL
  )
  SELECT b.id,
    (SELECT count(*) FROM public.provider_media_comments c WHERE c.parent_comment_id = b.id)::bigint,
    (SELECT count(*) FROM public.provider_media_comment_likes l WHERE l.comment_id = b.id)::bigint,
    EXISTS (SELECT 1 FROM public.provider_media_comment_likes l WHERE l.comment_id = b.id AND l.user_id = auth.uid())
  FROM base b;
$$;


ALTER FUNCTION "public"."comment_thread_summary"("p_media_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."complete_tranche_payout"("p_tranche_id" "text", "p_payout_id" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_tranche         RECORD;
  v_plan_id         uuid;
  v_total           bigint;
  v_released_count  bigint;
  v_plan_status     text;
BEGIN
  SELECT plan_id INTO v_plan_id
  FROM escrow_tranches
  WHERE id = p_tranche_id::uuid;

  IF v_plan_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  PERFORM 1 FROM escrow_payment_plans WHERE id = v_plan_id FOR UPDATE;

  SELECT id, status, plan_id
  INTO v_tranche
  FROM escrow_tranches
  WHERE id = p_tranche_id::uuid
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  v_plan_id := v_tranche.plan_id;

  IF v_tranche.status <> 'release_pending' THEN
    RETURN jsonb_build_object(
      'outcome', CASE WHEN v_tranche.status = 'released'
                      THEN 'already_released' ELSE 'skipped' END,
      'status',  v_tranche.status
    );
  END IF;

  UPDATE escrow_tranches
  SET
    status              = 'released',
    released_at         = now(),
    external_payout_ref = COALESCE(external_payout_ref, p_payout_id),
    updated_at          = now()
  WHERE id = p_tranche_id::uuid
    AND status = 'release_pending';

  SELECT COUNT(*) INTO v_total
  FROM escrow_tranches WHERE plan_id = v_plan_id;

  SELECT COUNT(*) INTO v_released_count
  FROM escrow_tranches
  WHERE plan_id = v_plan_id
    AND status = 'released'
    AND transfer_reversal_ref IS NULL;

  v_plan_status := CASE
    WHEN v_released_count >= v_total THEN 'fully_released'
    WHEN v_released_count > 0        THEN 'partially_released'
    ELSE                                  'funded_in_escrow'
  END;

  UPDATE escrow_payment_plans
  SET status = v_plan_status, updated_at = now()
  WHERE id = v_plan_id;

  RETURN jsonb_build_object(
    'outcome',           'released',
    'plan_status',       v_plan_status,
    'total_tranches',    v_total,
    'released_tranches', v_released_count
  );
END;
$$;


ALTER FUNCTION "public"."complete_tranche_payout"("p_tranche_id" "text", "p_payout_id" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."complete_tranche_payout"("p_tranche_id" "text", "p_payout_id" "text") IS 'P3 + P4 Batch 3: payout.paid completion (release_pending->released) with plan rollup. Takes escrow_payment_plans FOR UPDATE before the tranche lock (Plan->Tranche order, identical to settle_dispute_default) -> G2 deadlock fix + A1 write-skew fix. SECURITY DEFINER, service_role only. Idempotent.';



CREATE OR REPLACE FUNCTION "public"."confirm_funding_atomic"("p_funding_request_id" "uuid", "p_escrow_plan_id" "uuid" DEFAULT NULL::"uuid", "p_payment_intent_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_now             TIMESTAMPTZ := now();
  v_fr_status       TEXT;
  v_ep_status       TEXT;
  v_fr_updated      BOOLEAN := FALSE;
  v_ep_updated      BOOLEAN := FALSE;
  v_tranches_updated INT := 0;
BEGIN
  -- 0. Lock + read funding_request status
  SELECT status INTO v_fr_status
  FROM funding_requests
  WHERE id = p_funding_request_id
  FOR UPDATE;

  IF v_fr_status IS NULL THEN
    RETURN jsonb_build_object(
      'outcome', 'not_found',
      'detail', 'funding_request not found'
    );
  END IF;

  -- Already funded -> idempotent success (no changes needed)
  IF v_fr_status = 'funded' THEN
    RETURN jsonb_build_object(
      'outcome', 'already_funded',
      'funding_request_status', v_fr_status
    );
  END IF;

  -- Status guard: only advance from pre-funded states
  IF v_fr_status NOT IN ('created', 'sent', 'funding_started', 'funding_initiated') THEN
    RETURN jsonb_build_object(
      'outcome', 'invalid_state',
      'detail', 'funding_request in non-fundable state: ' || v_fr_status,
      'funding_request_status', v_fr_status
    );
  END IF;

  -- 1. Update funding_requests -> 'funded'
  UPDATE funding_requests
  SET status     = 'funded',
      funded_at  = v_now,
      updated_at = v_now
  WHERE id = p_funding_request_id
    AND status IN ('created', 'sent', 'funding_started', 'funding_initiated');

  v_fr_updated := FOUND;

  -- 2. Update escrow_payment_plans -> 'funded_in_escrow'
  IF p_escrow_plan_id IS NOT NULL THEN
    SELECT status INTO v_ep_status
    FROM escrow_payment_plans
    WHERE id = p_escrow_plan_id
    FOR UPDATE;

    IF v_ep_status IN ('awaiting_customer_funding', 'funding_initiated') THEN
      UPDATE escrow_payment_plans
      SET status              = 'funded_in_escrow',
          funded_at           = v_now,
          external_funding_ref = COALESCE(p_payment_intent_id, external_funding_ref),
          updated_at          = v_now
      WHERE id = p_escrow_plan_id
        AND status IN ('awaiting_customer_funding', 'funding_initiated');

      v_ep_updated := FOUND;
    END IF;
    -- If plan is already funded_in_escrow / partially_released / fully_released -> no-op (idempotent)

    -- 3. Update pending_funding tranches -> 'funded'
    UPDATE escrow_tranches
    SET status     = 'funded',
        updated_at = v_now
    WHERE plan_id = p_escrow_plan_id
      AND status = 'pending_funding';

    GET DIAGNOSTICS v_tranches_updated = ROW_COUNT;

    -- 4. C1 Funding-Ledger audit rows (audit-only, no money movement)
    -- Idempotent via ON CONFLICT on UNIQUE(payment_id, entry_type, movement_ref).
    -- Skips when no payments row resolves (non-fatal audit gap). movement_ref = escrow_plan_id::text.
    DECLARE
      v_pay_id uuid;
      v_job_id uuid;
      v_gross  numeric;
      v_fee    numeric;
      v_rate   numeric;
      v_cur    text;
    BEGIN
      SELECT job_id, total_amount, platform_fee_amount, platform_fee_rate, upper(COALESCE(currency, 'EUR'))
        INTO v_job_id, v_gross, v_fee, v_rate, v_cur
        FROM escrow_payment_plans
        WHERE id = p_escrow_plan_id;

      -- Deterministic attribution: pin to the oldest payments row for the job.
      SELECT id INTO v_pay_id
        FROM payments
        WHERE job_id = v_job_id
        ORDER BY created_at ASC
        LIMIT 1;

      IF v_pay_id IS NOT NULL AND v_gross IS NOT NULL THEN
        v_fee := COALESCE(v_fee, round(v_gross * COALESCE(v_rate, 0), 2));

        INSERT INTO ledger_entries (payment_id, job_id, entry_type, amount, currency, metadata, movement_ref)
        VALUES
          (v_pay_id, v_job_id, 'escrow_deposit', v_gross, v_cur,
           jsonb_build_object('note', 'Treuhand-Einzahlung eingegangen', 'escrow_plan_id', p_escrow_plan_id::text), p_escrow_plan_id::text),
          (v_pay_id, v_job_id, 'platform_fee', v_fee, v_cur,
           jsonb_build_object('note', 'SaFix Plattformprovision', 'escrow_plan_id', p_escrow_plan_id::text, 'rate', v_rate), p_escrow_plan_id::text)
        ON CONFLICT (payment_id, entry_type, movement_ref) DO NOTHING;
      END IF;
    END;
  END IF;

  -- Return result
  RETURN jsonb_build_object(
    'outcome', 'confirmed',
    'funding_request_updated', v_fr_updated,
    'escrow_plan_updated', v_ep_updated,
    'tranches_updated', v_tranches_updated
  );
END;
$$;


ALTER FUNCTION "public"."confirm_funding_atomic"("p_funding_request_id" "uuid", "p_escrow_plan_id" "uuid", "p_payment_intent_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."confirm_split_proposal"("p_proposal_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid               uuid        := auth.uid();
  v_dispute_id        uuid;
  v_job_id            uuid;
  v_proposed_by       uuid;
  v_proposed_ratio    numeric;
  v_dispute_status    text;
  v_decision          text;
  v_settlement_status text;
  v_customer_pid      uuid;
  v_provider_id       uuid;
  v_is_customer       boolean     := false;
  v_is_provider       boolean     := false;
  v_is_party          boolean     := false;
  v_now               timestamptz := now();
  v_result            jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;

  SELECT dsp.dispute_id, dsp.job_id, dsp.proposed_by, dsp.proposed_ratio
    INTO v_dispute_id, v_job_id, v_proposed_by, v_proposed_ratio
    FROM public.dispute_split_proposals dsp
   WHERE dsp.id = p_proposal_id
     AND dsp.status = 'pending'
   FOR UPDATE;

  IF v_dispute_id IS NULL THEN
    RAISE EXCEPTION 'proposal_not_found_or_not_pending: %', p_proposal_id USING ERRCODE = 'P0002';
  END IF;

  IF v_uid = v_proposed_by THEN
    RAISE EXCEPTION 'proposer_cannot_confirm: caller % proposed this split; the other party must confirm',
      v_uid USING ERRCODE = '42501';
  END IF;

  SELECT d.status, d.decision, d.settlement_status,
         d.customer_profile_id, d.provider_id
    INTO v_dispute_status, v_decision, v_settlement_status,
         v_customer_pid, v_provider_id
    FROM public.disputes d
   WHERE d.id = v_dispute_id
   FOR UPDATE;

  IF v_customer_pid IS NOT NULL AND v_customer_pid = v_uid THEN
    v_is_customer := true;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.jobs j
    WHERE j.id = v_job_id
      AND (
        j.craftsman_user_id = v_uid::text
        OR (v_provider_id IS NOT NULL AND j.provider_id IN (
          SELECT pr.id FROM public.providers pr WHERE pr.profile_id = v_uid
        ))
      )
  ) INTO v_is_provider;

  v_is_party := v_is_customer OR v_is_provider;

  IF NOT v_is_party THEN
    RAISE EXCEPTION 'unauthorized: caller is not a party to dispute %', v_dispute_id
      USING ERRCODE = '42501';
  END IF;

  IF v_dispute_status = 'resolved'
     AND v_decision = 'split'
     AND v_settlement_status IN ('pending', 'settled')
  THEN
    SELECT row_to_json(d)::jsonb INTO v_result
      FROM public.disputes d WHERE d.id = v_dispute_id;
    RETURN v_result;
  END IF;

  IF v_dispute_status NOT IN ('open','under_review','customer_waiting','provider_waiting') THEN
    RAISE EXCEPTION 'dispute_not_active: cannot confirm split in status %, decision %',
      v_dispute_status, COALESCE(v_decision, 'none')
      USING ERRCODE = 'P0001';
  END IF;

  IF v_dispute_status = 'resolved' AND v_decision IS NOT NULL AND v_decision <> 'split' THEN
    RAISE EXCEPTION 'decision_immutable: dispute % already resolved with decision %, cannot override with split',
      v_dispute_id, v_decision USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.dispute_split_proposals
     SET status       = 'accepted',
         confirmed_by = v_uid,
         updated_at   = v_now
   WHERE id = p_proposal_id;

  PERFORM set_config('app.p4b_split_consensus_commit', 'allow', true);

  UPDATE public.disputes
     SET status            = 'resolved',
         decision           = 'split',
         resolution_type    = 'split',
         split_ratio        = v_proposed_ratio,
         settlement_status  = 'pending',
         resolved_at        = COALESCE(resolved_at, v_now),
         updated_at         = v_now
   WHERE id = v_dispute_id;

  INSERT INTO public.dispute_status_history (
    dispute_id, job_id, previous_status, next_status, source, note, metadata, created_at
  ) VALUES (
    v_dispute_id, v_job_id, v_dispute_status, 'resolved', 'consensus', NULL,
    jsonb_build_object(
      'confirmed_by',    v_uid,
      'proposed_by',     v_proposed_by,
      'proposal_id',     p_proposal_id,
      'split_ratio',     v_proposed_ratio,
      'decision',        'split',
      'resolution_type', 'split'
    ),
    v_now
  );

  UPDATE public.jobs
     SET dispute_status = 'resolved'
   WHERE id = v_job_id;

  SELECT row_to_json(d)::jsonb INTO v_result
    FROM public.disputes d WHERE d.id = v_dispute_id;

  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."confirm_split_proposal"("p_proposal_id" "uuid") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."offers" (
    "id" "uuid" NOT NULL,
    "conversation_id" "uuid",
    "customer_user_id" "uuid" NOT NULL,
    "craftsman_user_id" "uuid" NOT NULL,
    "price" "text" NOT NULL,
    "description" "text",
    "timing_note" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" bigint DEFAULT ((EXTRACT(epoch FROM "now"()) * (1000)::numeric))::bigint NOT NULL,
    "updated_at" bigint DEFAULT ((EXTRACT(epoch FROM "now"()) * (1000)::numeric))::bigint NOT NULL,
    "accepted_at" bigint,
    "declined_at" bigint,
    "created_job_id" "uuid",
    "sent_at" bigint,
    "currency" "text",
    "gross_total" numeric,
    "net_total" numeric,
    "vat_amount" numeric,
    "vat_rate" integer,
    "labor_cost" numeric,
    "material_cost" numeric,
    "other_cost" numeric,
    "scope_summary" "text",
    "scope_included" "text",
    "scope_excluded" "text",
    "assumptions" "text",
    "payment_terms" "text",
    "valid_until" "text",
    "cancellation_terms" "text",
    "escrow_required" boolean,
    "project_title_snapshot" "text",
    "customer_description_snapshot" "text",
    "location_snapshot" "text",
    "version" integer DEFAULT 1,
    "notes" "text",
    "locked_at" bigint,
    "project_id" "uuid",
    "line_items" "jsonb",
    "offer_mode" "text",
    "craftsman_name_snapshot" "text",
    "vat_included" boolean,
    "evidence_media_ids" "text",
    "offer_ref" "text",
    "document_type" "text",
    "context_type" "text",
    "source_diagnosis_id" "text",
    "is_stale" boolean DEFAULT false NOT NULL,
    "stale_reason" "text",
    "stale_marked_at" timestamp with time zone,
    "stale_source_scene_id" "uuid",
    "source_spatial_scene_id" "uuid",
    "spatial_metadata" "jsonb",
    "pdf_url" "text",
    CONSTRAINT "offers_context_type_check" CHECK ((("context_type" IS NULL) OR ("context_type" = ANY (ARRAY['conversation'::"text", 'inquiry'::"text", 'project'::"text"])))),
    CONSTRAINT "offers_document_type_check" CHECK ((("document_type" IS NULL) OR ("document_type" = ANY (ARRAY['estimate'::"text", 'cost_estimate'::"text", 'binding_offer'::"text", 'diagnosis'::"text"])))),
    CONSTRAINT "offers_stale_consistency_chk" CHECK (((("is_stale" = false) AND ("stale_reason" IS NULL) AND ("stale_marked_at" IS NULL)) OR (("is_stale" = true) AND ("stale_reason" IS NOT NULL) AND ("stale_marked_at" IS NOT NULL)))),
    CONSTRAINT "offers_stale_reason_chk" CHECK ((("stale_reason" IS NULL) OR ("stale_reason" = ANY (ARRAY['measurement_changed'::"text", 'high_severity_pin_added'::"text", 'layout_changed'::"text"])))),
    CONSTRAINT "offers_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'pending'::"text", 'accepted'::"text", 'declined'::"text", 'expired'::"text", 'superseded'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."offers" OWNER TO "postgres";


COMMENT ON COLUMN "public"."offers"."conversation_id" IS 'Conversation anchor. NULLABLE since Spatial C-10. FK ON DELETE CASCADE intact (cascade only fires for non-null values).';



COMMENT ON COLUMN "public"."offers"."offer_mode" IS '''binding'' (default, verbindliches Angebot) | ''estimate'' (unverbindliche Schätzung). NULL is treated as ''binding'' for backward compatibility. Only binding offers unlock the payment corridor on acceptance.';



COMMENT ON COLUMN "public"."offers"."document_type" IS 'Leading commercial document type (Paket 1+). ''binding_offer'' (verbindliches Angebot, standard escrow) | ''estimate'' (unverbindliche Schätzung, no payment) | ''cost_estimate'' (Kostenvoranschlag, no payment) | ''diagnosis'' (Diagnose-Einsatz, own instant-payment path). NULL rows are resolved to ''binding_offer'' by the domain layer for backward compatibility.';



COMMENT ON COLUMN "public"."offers"."context_type" IS 'Context classification for this commercial document (Paket 1). ''conversation'' (default) | ''inquiry'' | ''project''. The actual context anchor is conversation_id. context_type classifies it.';



COMMENT ON COLUMN "public"."offers"."source_diagnosis_id" IS 'ID of the diagnosis offer this binding_offer was created from (Paket 4d). NULL for all offers not created as a follow-up to a diagnosis. Soft reference — no FK constraint. Provides audit trail: diagnosis → follow-up binding_offer.';



COMMENT ON COLUMN "public"."offers"."is_stale" IS 'QUOTE-STALE (Verify-Flow 4): the scan basis was significantly changed by the customer after this offer was sent (VF-2 threshold). Offer stays formally pending; only pending offers are ever marked stale.';



COMMENT ON COLUMN "public"."offers"."stale_reason" IS 'QUOTE-STALE: why the offer was marked stale - measurement_changed | high_severity_pin_added | layout_changed. NULL iff is_stale = false.';



COMMENT ON COLUMN "public"."offers"."stale_marked_at" IS 'QUOTE-STALE: timestamp the offer was marked stale. NULL iff is_stale = false.';



COMMENT ON COLUMN "public"."offers"."stale_source_scene_id" IS 'QUOTE-STALE: spatial_scenes.id whose customer-verify change triggered the stale flag. Audit + provider diff-link. ON DELETE SET NULL.';



COMMENT ON COLUMN "public"."offers"."source_spatial_scene_id" IS 'Spatial C-10: the canonical scene whose BoM produced this offer (set by create_spatial_offer RPC). NULL for non-spatial offers. Distinct from stale_source_scene_id (VF-2 stale-trigger source); semantics are disjoint. ON DELETE SET NULL.';



COMMENT ON COLUMN "public"."offers"."spatial_metadata" IS 'Spatial C-10: BoM-item richness (nodeId scene-anchors + source=auto|manual per line item). NULL for non-spatial offers.';



COMMENT ON COLUMN "public"."offers"."pdf_url" IS 'Spatial C-10/C10.8: storage URL of generated offer PDF. NULL until C10.8 PDF generator runs.';



CREATE OR REPLACE FUNCTION "public"."create_spatial_offer"("p_id" "uuid", "p_scene_id" "uuid", "p_document_type" "text", "p_price" numeric, "p_net_total" numeric, "p_gross_total" numeric, "p_vat_amount" numeric, "p_vat_rate" integer, "p_currency" "text" DEFAULT 'EUR'::"text", "p_line_items" "jsonb" DEFAULT '[]'::"jsonb", "p_spatial_metadata" "jsonb" DEFAULT '{}'::"jsonb", "p_description" "text" DEFAULT NULL::"text", "p_conversation_id" "uuid" DEFAULT NULL::"uuid") RETURNS "public"."offers"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_uid           uuid := auth.uid();
  v_scene         public.spatial_scenes;
  v_job           public.jobs;
  v_owner_uid     uuid;
  v_caller_org    uuid;
  v_customer_uid  uuid;
  v_conv_id       uuid;
  v_offer         public.offers;
  v_now_ms        bigint := (EXTRACT(EPOCH FROM now()) * 1000)::bigint;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'create_spatial_offer: authentication required'
      USING ERRCODE = '28000';
  END IF;

  IF p_id IS NULL THEN
    RAISE EXCEPTION 'create_spatial_offer: p_id required (client-generated offer uuid)'
      USING ERRCODE = '22023';
  END IF;
  IF p_scene_id IS NULL THEN
    RAISE EXCEPTION 'create_spatial_offer: p_scene_id required'
      USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_document_type, '') NOT IN ('binding_offer', 'cost_estimate') THEN
    RAISE EXCEPTION
      'create_spatial_offer: p_document_type must be binding_offer | cost_estimate (got %)',
      p_document_type
      USING ERRCODE = '22023';
  END IF;
  IF p_price IS NULL OR p_price < 0 THEN
    RAISE EXCEPTION 'create_spatial_offer: p_price required and non-negative'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_scene
    FROM public.spatial_scenes
    WHERE id = p_scene_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'create_spatial_offer: scene % not found', p_scene_id
      USING ERRCODE = '22023';
  END IF;

  IF v_scene.source_job_id IS NULL THEN
    RAISE EXCEPTION
      'create_spatial_offer: scene % has no source_job_id — Spatial-Quote requires job context',
      p_scene_id
      USING ERRCODE = '22023';
  END IF;

  IF v_scene.provider_org_id IS NULL THEN
    RAISE EXCEPTION
      'create_spatial_offer: scene % has no provider_org_id — Quote requires a provider',
      p_scene_id
      USING ERRCODE = '22023';
  END IF;

  v_caller_org := public.spatial_user_provider_org(v_uid);
  IF v_caller_org IS NULL OR v_caller_org IS DISTINCT FROM v_scene.provider_org_id THEN
    RAISE EXCEPTION
      'create_spatial_offer: caller % not authorized for provider_org %',
      v_uid, v_scene.provider_org_id
      USING ERRCODE = '42501';
  END IF;

  SELECT p.profile_id INTO v_owner_uid
    FROM public.providers p
    WHERE p.id = v_scene.provider_org_id;
  IF v_owner_uid IS NULL THEN
    RAISE EXCEPTION
      'create_spatial_offer: cannot resolve provider org % owner profile',
      v_scene.provider_org_id
      USING ERRCODE = '22023';
  END IF;
  IF NOT public.is_pro_owner(v_owner_uid) THEN
    RAISE EXCEPTION
      'create_spatial_offer: provider org % owner does not have an active Pro plan',
      v_scene.provider_org_id
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_job
    FROM public.jobs
    WHERE id = v_scene.source_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'create_spatial_offer: source_job % not found',
      v_scene.source_job_id
      USING ERRCODE = '22023';
  END IF;

  v_customer_uid := coalesce(v_scene.customer_id, v_job.customer_user_id);
  IF v_customer_uid IS NULL THEN
    RAISE EXCEPTION
      'create_spatial_offer: cannot resolve customer for scene %', p_scene_id
      USING ERRCODE = '22023';
  END IF;

  v_conv_id := coalesce(p_conversation_id, v_job.source_conversation_id);

  SELECT * INTO v_offer
    FROM public.offers
    WHERE source_spatial_scene_id = p_scene_id
      AND status = 'pending'
    LIMIT 1;
  IF FOUND THEN
    RETURN v_offer;
  END IF;

  INSERT INTO public.offers (
    id,
    conversation_id,
    customer_user_id,
    craftsman_user_id,
    price,
    description,
    status,
    sent_at,
    currency,
    gross_total,
    net_total,
    vat_amount,
    vat_rate,
    line_items,
    document_type,
    context_type,
    source_spatial_scene_id,
    spatial_metadata
  )
  VALUES (
    p_id,
    v_conv_id,
    v_customer_uid,
    v_owner_uid,
    p_price::text,
    p_description,
    'pending',
    v_now_ms,
    coalesce(p_currency, 'EUR'),
    p_gross_total,
    p_net_total,
    p_vat_amount,
    p_vat_rate,
    coalesce(p_line_items, '[]'::jsonb),
    p_document_type,
    CASE WHEN v_conv_id IS NULL THEN 'project' ELSE 'conversation' END,
    p_scene_id,
    coalesce(p_spatial_metadata, '{}'::jsonb)
  )
  ON CONFLICT (id) DO NOTHING
  RETURNING * INTO v_offer;

  IF v_offer.id IS NULL THEN
    SELECT * INTO v_offer
      FROM public.offers
      WHERE id = p_id;
  END IF;

  RETURN v_offer;
END;
$$;


ALTER FUNCTION "public"."create_spatial_offer"("p_id" "uuid", "p_scene_id" "uuid", "p_document_type" "text", "p_price" numeric, "p_net_total" numeric, "p_gross_total" numeric, "p_vat_amount" numeric, "p_vat_rate" integer, "p_currency" "text", "p_line_items" "jsonb", "p_spatial_metadata" "jsonb", "p_description" "text", "p_conversation_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."create_spatial_offer"("p_id" "uuid", "p_scene_id" "uuid", "p_document_type" "text", "p_price" numeric, "p_net_total" numeric, "p_gross_total" numeric, "p_vat_amount" numeric, "p_vat_rate" integer, "p_currency" "text", "p_line_items" "jsonb", "p_spatial_metadata" "jsonb", "p_description" "text", "p_conversation_id" "uuid") IS 'Spatial Canonical C-10: canonical Spatial-Quote INSERT path. SECURITY DEFINER RPC bypasses RESTRICTIVE offers_pro_gate_insert so Worker callers can send under Org-Owner Pro plan. Owner+Worker authorized via spatial_user_provider_org. Pro-Gate via Org-Owner is_pro_owner. Customer = COALESCE(scene.customer_id, job.customer_user_id). Conversation = COALESCE(param, job.source_conversation_id) — NULL allowed. Idempotent per (source_spatial_scene_id, status=pending). craftsman_user_id = Org-Owner profile.';



CREATE OR REPLACE FUNCTION "public"."create_team_member_stub"("p_provider_id" "uuid", "p_full_name" "text", "p_role" "text", "p_phone" "text", "p_email" "text", "p_weekly_target_hours" numeric, "p_daily_target_hours" numeric) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller_uid uuid := "auth"."uid"();
  v_full       text;
  v_role       text;
  v_phone      text;
  v_email      text;
  v_existing_id uuid;
  v_new_id      uuid;
BEGIN
  IF v_caller_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Nicht eingeloggt.', 'code', 'unauthenticated');
  END IF;

  v_full  := COALESCE(NULLIF(TRIM(p_full_name), ''), NULL);
  v_role  := COALESCE(NULLIF(TRIM(p_role), ''), NULL);
  v_phone := NULLIF(TRIM(p_phone), '');
  v_email := NULLIF(LOWER(TRIM(p_email)), '');

  IF v_full IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Name darf nicht leer sein.', 'code', 'invalid_name');
  END IF;
  IF v_role IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Rolle darf nicht leer sein.', 'code', 'invalid_role');
  END IF;
  IF v_role = 'owner' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Inhaber-Rolle kann hier nicht gesetzt werden.', 'code', 'invalid_role');
  END IF;
  IF p_weekly_target_hours IS NOT NULL AND (p_weekly_target_hours < 0 OR p_weekly_target_hours > 168) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Wochenstunden außerhalb des erlaubten Bereichs.', 'code', 'invalid_hours');
  END IF;
  IF p_daily_target_hours IS NOT NULL AND (p_daily_target_hours < 0 OR p_daily_target_hours > 24) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Tagesstunden außerhalb des erlaubten Bereichs.', 'code', 'invalid_hours');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "team_members" tm
    WHERE tm."provider_id" = p_provider_id
      AND tm."profile_id"  = v_caller_uid
      AND tm."role"        = 'owner'
      AND tm."is_active"   = true
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Nur der Inhaber darf Mitarbeiter anlegen.', 'code', 'rbac_owner_required');
  END IF;

  IF v_email IS NOT NULL AND EXISTS (
    SELECT 1 FROM "team_members" tm
    WHERE tm."provider_id" = p_provider_id
      AND lower(tm."email") = v_email
      AND tm."profile_id" IS NOT NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Es existiert bereits ein verknüpfter Mitarbeiter mit dieser E-Mail.', 'code', 'email_exists');
  END IF;

  IF v_email IS NOT NULL THEN
    SELECT tm."id" INTO v_existing_id
    FROM "team_members" tm
    WHERE tm."provider_id" = p_provider_id
      AND lower(tm."email") = v_email
      AND tm."profile_id" IS NULL
    LIMIT 1;
  END IF;

  IF v_existing_id IS NOT NULL THEN
    UPDATE "team_members"
       SET "full_name"           = v_full,
           "role"                = v_role,
           "phone"               = v_phone,
           "email"               = v_email,
           "weekly_target_hours" = p_weekly_target_hours,
           "daily_target_hours"  = p_daily_target_hours,
           "is_active"           = true,
           "updated_at"          = now()
     WHERE "id" = v_existing_id;
    v_new_id := v_existing_id;
  ELSE
    INSERT INTO "team_members" (
      "provider_id", "profile_id", "full_name", "role", "phone", "email",
      "weekly_target_hours", "daily_target_hours", "is_active"
    ) VALUES (
      p_provider_id, NULL, v_full, v_role, v_phone, v_email,
      p_weekly_target_hours, p_daily_target_hours, true
    )
    RETURNING "id" INTO v_new_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'member_id', v_new_id);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', 'Anlegen fehlgeschlagen.', 'code', 'unknown');
END;
$$;


ALTER FUNCTION "public"."create_team_member_stub"("p_provider_id" "uuid", "p_full_name" "text", "p_role" "text", "p_phone" "text", "p_email" "text", "p_weekly_target_hours" numeric, "p_daily_target_hours" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deactivate_team_member"("p_member_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller_uid  uuid := "auth"."uid"();
  v_old_row     RECORD;
BEGIN
  IF v_caller_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Nicht eingeloggt.', 'code', 'unauthenticated');
  END IF;

  SELECT tm.* INTO v_old_row FROM "team_members" tm WHERE tm."id" = p_member_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Mitarbeiter nicht gefunden.', 'code', 'not_found');
  END IF;

  IF v_old_row."role" = 'owner' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Inhaber-Datensatz kann nicht deaktiviert werden.', 'code', 'owner_immutable');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "team_members" tm2
    WHERE tm2."provider_id" = v_old_row."provider_id"
      AND tm2."profile_id"  = v_caller_uid
      AND tm2."role"        = 'owner'
      AND tm2."is_active"   = true
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Nur der Inhaber darf Mitarbeiter deaktivieren.', 'code', 'rbac_owner_required');
  END IF;

  IF v_old_row."profile_id" = v_caller_uid THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Eigene Mitgliedschaft kann hier nicht deaktiviert werden.', 'code', 'self_edit_forbidden');
  END IF;

  IF v_old_row."is_active" = false THEN
    RETURN jsonb_build_object('ok', true, 'noop', true);
  END IF;

  UPDATE "team_members"
     SET "is_active"  = false,
         "updated_at" = now()
   WHERE "id" = p_member_id;

  INSERT INTO "team_member_audit" (
    "provider_id", "member_id", "actor_id", "action", "old_values", "new_values"
  ) VALUES (
    v_old_row."provider_id",
    p_member_id,
    v_caller_uid,
    'deactivate',
    jsonb_build_object('is_active', true),
    jsonb_build_object('is_active', false)
  );

  RETURN jsonb_build_object('ok', true);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', 'Deaktivierung fehlgeschlagen.', 'code', 'unknown');
END;
$$;


ALTER FUNCTION "public"."deactivate_team_member"("p_member_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dispute_spatial_evidence_append"("p_dispute_id" "uuid", "p_scene_id" "uuid", "p_node_id" "text", "p_evidence_kind" "text", "p_metadata" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid uuid; v_row_id uuid;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'dispute_spatial_evidence_append: authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT public.spatial_can_view_scene(p_scene_id, v_uid) THEN
    RAISE EXCEPTION 'dispute_spatial_evidence_append: caller is not a scene-actor (scene=%)', p_scene_id USING ERRCODE = '42501';
  END IF;
  IF p_evidence_kind NOT IN ('damage_pin','photo','note','measurement') THEN
    RAISE EXCEPTION 'dispute_spatial_evidence_append: invalid evidence_kind %; must be damage_pin|photo|note|measurement', p_evidence_kind USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.disputes WHERE id = p_dispute_id) THEN
    RAISE EXCEPTION 'dispute_spatial_evidence_append: dispute % not found', p_dispute_id USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.dispute_spatial_evidence (
    dispute_id, scene_id, node_id, evidence_kind, submitted_by, metadata
  ) VALUES (
    p_dispute_id, p_scene_id, p_node_id, p_evidence_kind, v_uid, COALESCE(p_metadata, '{}'::jsonb)
  ) RETURNING id INTO v_row_id;
  RETURN v_row_id;
END;
$$;


ALTER FUNCTION "public"."dispute_spatial_evidence_append"("p_dispute_id" "uuid", "p_scene_id" "uuid", "p_node_id" "text", "p_evidence_kind" "text", "p_metadata" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."disputes_sla_reset_trigger_fn"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF NEW.status IN ('customer_waiting', 'provider_waiting')
     AND (OLD.status IS NULL OR OLD.status NOT IN ('customer_waiting', 'provider_waiting'))
  THEN
    NEW.metadata = COALESCE(NEW.metadata, '{}'::jsonb) - 'sla_reminders_sent';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."disputes_sla_reset_trigger_fn"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."disputes_sla_reset_trigger_fn"() IS 'N13.SLA-Cron: clears metadata.sla_reminders_sent when a dispute re-enters customer_waiting / provider_waiting from any other state, so a fresh round of SLA reminders can fire. No-op on transitions within the *_waiting set (which never happen in the FSM today, but the guard keeps the contract explicit).';



CREATE OR REPLACE FUNCTION "public"."disputes_status_change_guard"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NEW.status              IS NOT DISTINCT FROM OLD.status
     AND NEW.decision          IS NOT DISTINCT FROM OLD.decision
     AND NEW.resolution_type   IS NOT DISTINCT FROM OLD.resolution_type
     AND NEW.split_ratio       IS NOT DISTINCT FROM OLD.split_ratio
     AND NEW.settlement_status IS NOT DISTINCT FROM OLD.settlement_status
     AND NEW.resolved_at       IS NOT DISTINCT FROM OLD.resolved_at
     AND NEW.closed_at         IS NOT DISTINCT FROM OLD.closed_at
  THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF current_setting('app.p4b_split_consensus_commit', true) = 'allow' THEN
    RETURN NEW;
  END IF;

  IF current_setting('app.p4b_split_settle_commit', true) = 'allow'
     AND OLD.settlement_status = 'pending' AND NEW.settlement_status = 'settled'
     AND NEW.status            IS NOT DISTINCT FROM OLD.status
     AND NEW.decision          IS NOT DISTINCT FROM OLD.decision
     AND NEW.resolution_type   IS NOT DISTINCT FROM OLD.resolution_type
     AND NEW.split_ratio       IS NOT DISTINCT FROM OLD.split_ratio
     AND NEW.resolved_at       IS NOT DISTINCT FROM OLD.resolved_at
     AND NEW.closed_at         IS NOT DISTINCT FROM OLD.closed_at
  THEN
    RETURN NEW;
  END IF;

  IF public.is_current_user_operator() THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'unauthorized: only operators can change dispute lifecycle fields'
    USING ERRCODE = '42501';
END;
$$;


ALTER FUNCTION "public"."disputes_status_change_guard"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."disputes_status_change_guard"() IS 'Block 5.6 + P4B + P4A: guards status/decision/resolution_type/split_ratio/settlement_status/resolved_at/closed_at against direct mutations by non-operator authenticated callers. P4B: allows confirm_split_proposal via app.p4b_split_consensus_commit sentinel. P4A: allows settle_consensus_split via app.p4b_split_settle_commit sentinel (scoped to settlement_status pending->settled; no other lifecycle change).';



CREATE OR REPLACE FUNCTION "public"."enforce_comment_depth"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF NEW.parent_comment_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.provider_media_comments
       WHERE id = NEW.parent_comment_id AND parent_comment_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'COMMENT_NESTING_TOO_DEEP' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;


ALTER FUNCTION "public"."enforce_comment_depth"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_invoice_immutability"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
DECLARE
  immutable_violations text[] := ARRAY[]::text[];
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF NOT (
      (OLD.status = 'issued' AND NEW.status IN ('sent', 'paid'))
      OR (OLD.status = 'sent' AND NEW.status = 'paid')
    ) THEN
      RAISE EXCEPTION
        'invoice status transition % -> % not permitted on issued invoice (id=%)',
        OLD.status, NEW.status, OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF OLD.invoice_number IS DISTINCT FROM NEW.invoice_number THEN immutable_violations := array_append(immutable_violations, 'invoice_number'); END IF;
  IF OLD.issued_at IS DISTINCT FROM NEW.issued_at THEN immutable_violations := array_append(immutable_violations, 'issued_at'); END IF;
  IF OLD.issued_at_label IS DISTINCT FROM NEW.issued_at_label THEN immutable_violations := array_append(immutable_violations, 'issued_at_label'); END IF;
  IF OLD.due_at_label IS DISTINCT FROM NEW.due_at_label THEN immutable_violations := array_append(immutable_violations, 'due_at_label'); END IF;
  IF OLD.sent_at <> 0 AND OLD.sent_at IS DISTINCT FROM NEW.sent_at THEN immutable_violations := array_append(immutable_violations, 'sent_at'); END IF;
  IF OLD.parties IS DISTINCT FROM NEW.parties THEN immutable_violations := array_append(immutable_violations, 'parties'); END IF;
  IF OLD.provider_snapshot IS DISTINCT FROM NEW.provider_snapshot THEN immutable_violations := array_append(immutable_violations, 'provider_snapshot'); END IF;
  IF OLD.customer_snapshot IS DISTINCT FROM NEW.customer_snapshot THEN immutable_violations := array_append(immutable_violations, 'customer_snapshot'); END IF;
  IF OLD.line_items IS DISTINCT FROM NEW.line_items THEN immutable_violations := array_append(immutable_violations, 'line_items'); END IF;
  IF OLD.amounts IS DISTINCT FROM NEW.amounts THEN immutable_violations := array_append(immutable_violations, 'amounts'); END IF;
  IF OLD.tax_breakdown IS DISTINCT FROM NEW.tax_breakdown THEN immutable_violations := array_append(immutable_violations, 'tax_breakdown'); END IF;
  IF OLD.tax_note IS DISTINCT FROM NEW.tax_note THEN immutable_violations := array_append(immutable_violations, 'tax_note'); END IF;
  IF OLD.service_period_from IS DISTINCT FROM NEW.service_period_from THEN immutable_violations := array_append(immutable_violations, 'service_period_from'); END IF;
  IF OLD.service_period_to IS DISTINCT FROM NEW.service_period_to THEN immutable_violations := array_append(immutable_violations, 'service_period_to'); END IF;
  IF OLD.service_period_label IS DISTINCT FROM NEW.service_period_label THEN immutable_violations := array_append(immutable_violations, 'service_period_label'); END IF;
  IF OLD.source_offer_id IS DISTINCT FROM NEW.source_offer_id THEN immutable_violations := array_append(immutable_violations, 'source_offer_id'); END IF;
  IF OLD.source_change_order_ids IS DISTINCT FROM NEW.source_change_order_ids THEN immutable_violations := array_append(immutable_violations, 'source_change_order_ids'); END IF;
  IF OLD.source_supplementary_payment_ids IS DISTINCT FROM NEW.source_supplementary_payment_ids THEN immutable_violations := array_append(immutable_violations, 'source_supplementary_payment_ids'); END IF;
  IF OLD.kind IS DISTINCT FROM NEW.kind THEN immutable_violations := array_append(immutable_violations, 'kind'); END IF;
  IF OLD.original_invoice_id IS DISTINCT FROM NEW.original_invoice_id THEN immutable_violations := array_append(immutable_violations, 'original_invoice_id'); END IF;
  IF OLD.correction_reason IS DISTINCT FROM NEW.correction_reason THEN immutable_violations := array_append(immutable_violations, 'correction_reason'); END IF;
  IF OLD.correction_amount_cents IS DISTINCT FROM NEW.correction_amount_cents THEN immutable_violations := array_append(immutable_violations, 'correction_amount_cents'); END IF;
  IF OLD.original_invoice_number IS DISTINCT FROM NEW.original_invoice_number THEN immutable_violations := array_append(immutable_violations, 'original_invoice_number'); END IF;
  IF OLD.original_invoice_issued_at_label IS DISTINCT FROM NEW.original_invoice_issued_at_label THEN immutable_violations := array_append(immutable_violations, 'original_invoice_issued_at_label'); END IF;
  IF OLD.job_id IS DISTINCT FROM NEW.job_id THEN immutable_violations := array_append(immutable_violations, 'job_id'); END IF;
  IF OLD.created_at IS DISTINCT FROM NEW.created_at THEN immutable_violations := array_append(immutable_violations, 'created_at'); END IF;

  IF array_length(immutable_violations, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'invoice immutable fields modified after issuance (id=%, status=%, fields=%)',
      OLD.id, OLD.status, array_to_string(immutable_violations, ',')
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."enforce_invoice_immutability"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."enforce_invoice_immutability"() IS 'Block 7.1G: §14-Immutability für ausgestellte Rechnungen. Erlaubt nur issued->sent, issued->paid, sent->paid sowie technische Updates (sent_at one-shot, refund_event_id, updated_at). Cancellation läuft per INSERT von kind=cancellation.';



CREATE OR REPLACE FUNCTION "public"."enforce_parent_comment_id_immutable"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.parent_comment_id IS DISTINCT FROM OLD.parent_comment_id THEN
    RAISE EXCEPTION 'PARENT_COMMENT_ID_IMMUTABLE'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;


ALTER FUNCTION "public"."enforce_parent_comment_id_immutable"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_scan_fsm"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
DECLARE
  v_actor  uuid;
  v_reason text;
  v_old    public.scan_status;
  v_new    public.scan_status;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'draft'::public.scan_status THEN
      RAISE EXCEPTION 'Illegal scan INSERT: new scans must start at status=draft (got %)', NEW.status
        USING ERRCODE = 'check_violation',
              HINT    = 'Insert with status=draft, then UPDATE via the FSM. See scan_status_transition_allowed.';
    END IF;
    RETURN NEW;
  END IF;

  v_old := OLD.status;
  v_new := NEW.status;
  IF v_new IS NOT DISTINCT FROM v_old THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.scan_status_transition_allowed
    WHERE from_status = v_old AND to_status = v_new
  ) THEN
    RAISE EXCEPTION 'Illegal scan transition: % -> %', v_old, v_new
      USING ERRCODE = 'check_violation',
            HINT    = 'See public.scan_status_transition_allowed for the FSM diagram.';
  END IF;

  v_actor  := auth.uid();
  v_reason := current_setting('app.scan_fsm_reason', true);
  IF v_reason = '' THEN
    v_reason := NULL;
  END IF;

  INSERT INTO public.scan_status_transition_log
    (scan_id, from_status, to_status, actor_id, reason)
  VALUES
    (NEW.id, v_old, v_new, v_actor, v_reason);

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."enforce_scan_fsm"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."enforce_scan_fsm"() IS 'Spatial Core FSM trigger: validates scans.status transitions against scan_status_transition_allowed and writes scan_status_transition_log. Fires alphabetically AFTER scans_dispute_lock_guard.';



CREATE OR REPLACE FUNCTION "public"."ensure_subscription_row"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_role text;
  v_craftsman_role text;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT role, craftsman_role INTO v_role, v_craftsman_role FROM profiles WHERE id = v_caller;
  IF v_role IS DISTINCT FROM 'craftsman' OR v_craftsman_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'not_owner';
  END IF;
  INSERT INTO craftsman_subscriptions (profile_id, status) VALUES (v_caller, 'trial_available')
  ON CONFLICT (profile_id) DO NOTHING;
END;
$$;


ALTER FUNCTION "public"."ensure_subscription_row"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."epoch_ms"() RETURNS bigint
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$ SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint; $$;


ALTER FUNCTION "public"."epoch_ms"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."finalize_payment_state_atomic"("p_job_id" "text", "p_target_state" "text", "p_dispute_id" "text" DEFAULT NULL::"text", "p_actor" "text" DEFAULT 'system'::"text", "p_refunded_amount" numeric DEFAULT NULL::numeric) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_payment_id     TEXT;
  v_payment_status TEXT;
  v_project_id     TEXT;
  v_now            TIMESTAMPTZ := clock_timestamp();
BEGIN
  -- ── 1. Validate target state parameter ────────────────────────────────────
  IF p_target_state NOT IN ('released', 'refunded') THEN
    RAISE EXCEPTION 'invalid_target_state: % is not a terminal payment state (released | refunded)',
      p_target_state
      USING ERRCODE = 'P0001';
  END IF;

  -- ── 2. Lock payment row ───────────────────────────────────────────────────
  -- Blocking lock — concurrent open_dispute_atomic or a duplicate release call
  -- will wait here rather than racing.  The lock serializes both paths and lets
  -- the state-machine validation (step 3) detect the race and reject.
  SELECT id, status
    INTO v_payment_id, v_payment_status
    FROM public.payments
   WHERE job_id = p_job_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment_not_found: no payment record for job %', p_job_id
      USING ERRCODE = 'P0002';
  END IF;

  -- ── 2b. Authorization check ────────────────────────────────────────────────
  -- Authenticated callers (auth.uid() IS NOT NULL) must be a participant in the job.
  -- Webhooks and crons run as service_role where auth.uid() IS NULL — exempt.
  IF auth.uid() IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.jobs
       WHERE id = p_job_id
         AND (customer_user_id = auth.uid()::text
              OR craftsman_user_id = auth.uid()::text)
    ) THEN
      RAISE EXCEPTION 'unauthorized: caller is not a participant in job %', p_job_id
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- ── 3. Idempotent guard ───────────────────────────────────────────────────
  IF v_payment_status = p_target_state THEN
    RETURN jsonb_build_object(
      'idempotent', TRUE,
      'state',      p_target_state,
      'paymentId',  v_payment_id
    );
  END IF;

  -- ── 4. State-machine validation ───────────────────────────────────────────
  IF p_target_state = 'released' AND v_payment_status NOT IN (
    'release_pending', 'disputed'
  ) THEN
    RAISE EXCEPTION 'invalid_transition: cannot finalize payment from % to released (job %)',
      v_payment_status, p_job_id
      USING ERRCODE = 'P0001';
  END IF;

  IF p_target_state = 'refunded' AND v_payment_status NOT IN (
    'deposit_paid', 'in_escrow', 'release_pending', 'disputed'
  ) THEN
    RAISE EXCEPTION 'invalid_transition: cannot finalize payment from % to refunded (job %)',
      v_payment_status, p_job_id
      USING ERRCODE = 'P0001';
  END IF;

  -- ── 5. Dispute guard (release without dispute bypass) ─────────────────────
  -- For non-dispute releases (p_dispute_id IS NULL), refuse to finalize if any
  -- active dispute exists.  The FOR UPDATE lock acquired above ensures no
  -- concurrent open_dispute_atomic can insert a dispute between this check and
  -- the UPDATE below.
  IF p_target_state = 'released' AND p_dispute_id IS NULL THEN
    IF EXISTS (
      SELECT 1
        FROM public.disputes
       WHERE job_id = p_job_id
         AND status IN ('open', 'awaiting_evidence', 'under_review')
    ) THEN
      RAISE EXCEPTION 'release_blocked_by_dispute: active dispute exists for job % — resolve before releasing',
        p_job_id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- ── 5b. Validate supplied dispute_id ──────────────────────────────────────
  -- When p_dispute_id is supplied (dispute-bypass path), verify it actually
  -- exists and belongs to this job.  Without this check any job participant
  -- could pass an arbitrary UUID to bypass step 5's active-dispute guard.
  IF p_dispute_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.disputes
       WHERE id      = p_dispute_id
         AND job_id  = p_job_id
    ) THEN
      RAISE EXCEPTION 'invalid_dispute_id: dispute % does not exist or does not belong to job %',
        p_dispute_id, p_job_id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- ── 6. Update payments ────────────────────────────────────────────────────
  UPDATE public.payments
     SET status          = p_target_state,
         refunded_amount = COALESCE(p_refunded_amount, refunded_amount),
         updated_at      = v_now
   WHERE job_id = p_job_id;

  -- ── 7. Update jobs: payment_state + status (waiting_payment → completed) ──
  UPDATE public.jobs
     SET payment_state = p_target_state,
         status        = CASE WHEN status = 'waiting_payment' THEN 'completed' ELSE status END,
         updated_at    = v_now
   WHERE id = p_job_id;

  -- ── 8. Update linked project (if any) ─────────────────────────────────────
  SELECT project_id
    INTO v_project_id
    FROM public.jobs
   WHERE id = p_job_id;

  IF v_project_id IS NOT NULL AND v_project_id != '' THEN
    UPDATE public.projects
       SET payment_state = p_target_state,
           updated_at    = v_now
     WHERE id = v_project_id;
  END IF;

  -- ── 9. Return result ──────────────────────────────────────────────────────
  RETURN jsonb_build_object(
    'idempotent',   FALSE,
    'state',        p_target_state,
    'paymentId',    v_payment_id,
    'jobId',        p_job_id,
    'projectId',    v_project_id,
    'actor',        p_actor,
    'finalizedAt',  (EXTRACT(EPOCH FROM v_now) * 1000)::BIGINT
  );
END;
$$;


ALTER FUNCTION "public"."finalize_payment_state_atomic"("p_job_id" "text", "p_target_state" "text", "p_dispute_id" "text", "p_actor" "text", "p_refunded_amount" numeric) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."finalize_payment_state_atomic"("p_job_id" "text", "p_target_state" "text", "p_dispute_id" "text", "p_actor" "text", "p_refunded_amount" numeric) IS 'v2: Adds dispute_id validation — supplied dispute must exist and belong to the job. Atomically commits released|refunded state across payments, jobs, and projects in a single transaction after a Stripe operation has succeeded. Acquires a row-level lock on the payment to serialize concurrent dispute opens. Called by SupabasePaymentRepository.finalizeStateAtomic() after provider success.';



CREATE OR REPLACE FUNCTION "public"."fn_chat_migration_status_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN NEW.updated_at = public.epoch_ms(); RETURN NEW; END;
$$;


ALTER FUNCTION "public"."fn_chat_migration_status_set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_chat_set_message_type_on_attachment"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_current text;
BEGIN
  SELECT message_type INTO v_current
  FROM public.chat_messages
  WHERE id = NEW.message_id;

  IF v_current IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_current = 'text' THEN
    UPDATE public.chat_messages
    SET message_type = NEW.asset_type
    WHERE id = NEW.message_id;
  ELSIF v_current IN ('image', 'document', 'voice', 'video')
    AND v_current <> NEW.asset_type THEN
    UPDATE public.chat_messages
    SET message_type = 'mixed'
    WHERE id = NEW.message_id;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."fn_chat_set_message_type_on_attachment"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_chat_update_thread_last_message"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_preview_body text;
BEGIN
  v_preview_body := CASE
    WHEN NEW.deleted_at IS NOT NULL    THEN NULL
    WHEN NEW.message_type = 'image'    THEN '[Bild]'
    WHEN NEW.message_type = 'document' THEN '[Dokument]'
    WHEN NEW.message_type = 'voice'    THEN '[Sprachnachricht]'
    WHEN NEW.message_type = 'video'    THEN '[Video]'
    WHEN NEW.message_type = 'artifact_card' THEN
      CASE NEW.artifact_type
        WHEN 'Project'      THEN '[Projekt]'
        WHEN 'OfferPayment' THEN '[Angebot]'
        WHEN 'FundingStep'  THEN '[Zahlung]'
        WHEN 'ChangeOrder'  THEN '[Nachtrag]'
        ELSE '[Anhang]'
      END
    WHEN NEW.message_type = 'system'   THEN NEW.body
    ELSE NEW.body
  END;

  UPDATE public.chat_threads
  SET
    last_message_id   = NEW.id,
    last_message_at   = NEW.created_at,
    last_message_body = v_preview_body,
    updated_at        = NEW.created_at
  WHERE id = NEW.thread_id;

  UPDATE public.chat_participants cp
  SET
    last_visible_message_id   = NEW.id,
    last_visible_message_at   = NEW.created_at,
    last_visible_message_body = v_preview_body,
    last_visible_message_type = NEW.message_type
  WHERE cp.thread_id = NEW.thread_id
    AND cp.left_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.user_blocks ub
      WHERE ub.blocker_id = cp.user_id
        AND ub.blocked_id = NEW.sender_user_id
    );

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."fn_chat_update_thread_last_message"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_resolve_provider_for_caller"() RETURNS TABLE("team_member_id" "uuid", "profile_id" "uuid", "provider_id" "uuid", "member_role" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid uuid;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'access_denied: no auth session' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
    SELECT tm.id, tm.profile_id, tm.provider_id, tm.role
    FROM public.team_members tm
    WHERE tm.profile_id = v_uid
      AND tm.is_active = true
    ORDER BY tm.created_at DESC, tm.id DESC
    LIMIT 1;
END;
$$;


ALTER FUNCTION "public"."fn_resolve_provider_for_caller"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_seed_chat_participants_for_provider"("p_thread_id" "uuid", "p_provider_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  INSERT INTO public.chat_participants (thread_id, user_id, role, joined_at)
  SELECT
    p_thread_id,
    tm.profile_id,
    CASE WHEN tm.role = 'owner' THEN 'owner' ELSE 'worker' END,
    public.epoch_ms()
  FROM public.team_members tm
  WHERE tm.provider_id = p_provider_id
    AND tm.profile_id IS NOT NULL
    AND tm.is_active = true
  ON CONFLICT (thread_id, user_id) DO NOTHING;
END;
$$;


ALTER FUNCTION "public"."fn_seed_chat_participants_for_provider"("p_thread_id" "uuid", "p_provider_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_update_thread_last_message"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  UPDATE public.message_threads
  SET    last_message_at   = NEW.created_at,
         last_message_body = LEFT(NEW.body, 200),
         updated_at        = NEW.created_at
  WHERE  id = NEW.thread_id;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."fn_update_thread_last_message"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_user_notification_prefs_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN NEW.updated_at = public.epoch_ms(); RETURN NEW; END;
$$;


ALTER FUNCTION "public"."fn_user_notification_prefs_set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_invoice_number"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
DECLARE
  v_assign  boolean := FALSE;
  v_year    int;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'issued'
       AND (NEW.invoice_number IS NULL OR NEW.invoice_number = '') THEN
      v_assign := TRUE;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.status = 'issued'
       AND OLD.status = 'draft'
       AND (OLD.invoice_number IS NULL OR OLD.invoice_number = '') THEN
      v_assign := TRUE;
    END IF;
  END IF;

  IF v_assign THEN
    v_year := EXTRACT(YEAR FROM NOW())::int;
    IF NEW.kind = 'cancellation' THEN
      NEW.invoice_number :=
        'FX-S-' || v_year || '-' ||
        LPAD(nextval('cancellation_invoice_seq')::text, 4, '0');
    ELSIF NEW.kind = 'credit_note' THEN
      NEW.invoice_number :=
        'FX-G-' || v_year || '-' ||
        LPAD(nextval('credit_note_seq')::text, 4, '0');
    ELSE
      NEW.invoice_number :=
        'FX-' || v_year || '-' ||
        LPAD(nextval('invoice_number_seq')::text, 4, '0');
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."generate_invoice_number"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_unique_company_code"() RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_charlen int := length(v_chars);
  v_bytes bytea;
  v_code text;
  v_attempt int := 0;
BEGIN
  LOOP
    v_bytes := gen_random_bytes(6);
    v_code := '';
    FOR i IN 0..5 LOOP
      v_code := v_code || substr(v_chars, 1 + (get_byte(v_bytes, i) % v_charlen)::int, 1);
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM public.company_join_codes WHERE code = v_code) THEN
      RETURN v_code;
    END IF;
    v_attempt := v_attempt + 1;
    IF v_attempt > 5 THEN
      RAISE EXCEPTION 'code_collision_unrecoverable';
    END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."generate_unique_company_code"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_customer_billing_for_invoice"("p_job_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller_uid_text  text;
  v_craftsman_uid    text;
  v_customer_uid     uuid;
  v_profile          public.customer_billing_profiles%ROWTYPE;
BEGIN
  v_caller_uid_text := auth.uid()::text;
  IF v_caller_uid_text IS NULL THEN
    RAISE EXCEPTION 'auth required'
      USING ERRCODE = '28000';
  END IF;

  SELECT j.craftsman_user_id, j.customer_user_id
    INTO v_craftsman_uid, v_customer_uid
  FROM public.jobs j
  WHERE j.id = p_job_id
  LIMIT 1;

  IF v_craftsman_uid IS NULL THEN
    RAISE EXCEPTION 'job not found'
      USING ERRCODE = '02000';
  END IF;

  IF v_craftsman_uid <> v_caller_uid_text THEN
    RAISE EXCEPTION 'not authorised for job %', p_job_id
      USING ERRCODE = '42501';
  END IF;

  IF v_customer_uid IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT *
    INTO v_profile
  FROM public.customer_billing_profiles
  WHERE user_id = v_customer_uid
  LIMIT 1;

  IF v_profile.id IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'userId',                v_profile.user_id,
    'billingName',           v_profile.billing_name,
    'billingAddressLine1',   v_profile.billing_address_line1,
    'billingAddressLine2',   v_profile.billing_address_line2,
    'billingPostalCode',     v_profile.billing_postal_code,
    'billingCity',           v_profile.billing_city,
    'billingCountry',        v_profile.billing_country,
    'billingEmail',          v_profile.billing_email,
    'billingPhone',          v_profile.billing_phone,
    'isBusiness',            COALESCE(v_profile.is_business, FALSE),
    'businessName',          v_profile.business_name,
    'vatId',                 v_profile.vat_id
  );
END;
$$;


ALTER FUNCTION "public"."get_customer_billing_for_invoice"("p_job_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_or_create_assignment_thread"("p_calendar_entry_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_thread_id       uuid;
  v_provider_id     uuid;
  v_title           text;
  v_caller_id       text;
  v_assigned_ids    text[];
BEGIN
  SELECT tm.id::text,
         ce.provider_id,
         ce.title,
         ce.assigned_member_ids
  INTO   v_caller_id,
         v_provider_id,
         v_title,
         v_assigned_ids
  FROM   public.calendar_entries ce
  JOIN   public.team_members     tm
    ON   tm.profile_id  = auth.uid()
   AND   tm.provider_id = ce.provider_id
  WHERE  ce.id = p_calendar_entry_id
  LIMIT  1;

  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'access_denied: caller is not a team member of this entry''s company';
  END IF;

  SELECT id INTO v_thread_id
  FROM   public.message_threads
  WHERE  calendar_entry_id = p_calendar_entry_id;

  IF v_thread_id IS NOT NULL THEN
    INSERT INTO public.message_thread_participants (thread_id, team_member_id)
    VALUES (v_thread_id, v_caller_id)
    ON CONFLICT (thread_id, team_member_id) DO NOTHING;

    RETURN v_thread_id;
  END IF;

  INSERT INTO public.message_threads (
    provider_id,
    thread_type,
    calendar_entry_id,
    created_by_team_member_id,
    title
  )
  VALUES (
    v_provider_id,
    'assignment',
    p_calendar_entry_id,
    v_caller_id,
    v_title
  )
  ON CONFLICT (calendar_entry_id) DO NOTHING
  RETURNING id INTO v_thread_id;

  IF v_thread_id IS NULL THEN
    SELECT id INTO v_thread_id
    FROM   public.message_threads
    WHERE  calendar_entry_id = p_calendar_entry_id;
  END IF;

  IF v_assigned_ids IS NOT NULL AND array_length(v_assigned_ids, 1) > 0 THEN
    INSERT INTO public.message_thread_participants (thread_id, team_member_id)
    SELECT v_thread_id, unnest(v_assigned_ids)
    ON CONFLICT (thread_id, team_member_id) DO NOTHING;
  END IF;

  INSERT INTO public.message_thread_participants (thread_id, team_member_id)
  SELECT v_thread_id, tm.id::text
  FROM   public.team_members tm
  WHERE  tm.provider_id = v_provider_id
    AND  tm.role IN ('owner', 'admin')
  ON CONFLICT (thread_id, team_member_id) DO NOTHING;

  RETURN v_thread_id;
END;
$$;


ALTER FUNCTION "public"."get_or_create_assignment_thread"("p_calendar_entry_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_or_create_office_thread"() RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_thread_id   uuid;
  v_provider_id uuid;
  v_caller_id   text;
BEGIN
  SELECT tm.id::text, tm.provider_id
  INTO   v_caller_id, v_provider_id
  FROM   public.team_members tm
  WHERE  tm.profile_id = auth.uid()
  LIMIT  1;

  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'access_denied: caller has no team_member row';
  END IF;

  SELECT id INTO v_thread_id
  FROM   public.message_threads
  WHERE  provider_id = v_provider_id
    AND  thread_type = 'office';

  IF v_thread_id IS NOT NULL THEN
    INSERT INTO public.message_thread_participants (thread_id, team_member_id)
    VALUES (v_thread_id, v_caller_id)
    ON CONFLICT (thread_id, team_member_id) DO NOTHING;
    RETURN v_thread_id;
  END IF;

  INSERT INTO public.message_threads (
    provider_id, thread_type, created_by_team_member_id, title
  )
  VALUES (v_provider_id, 'office', v_caller_id, 'Büro')
  ON CONFLICT (provider_id, thread_type) WHERE thread_type IN ('office', 'team') DO NOTHING
  RETURNING id INTO v_thread_id;

  IF v_thread_id IS NULL THEN
    SELECT id INTO v_thread_id
    FROM   public.message_threads
    WHERE  provider_id = v_provider_id AND thread_type = 'office';
  END IF;

  INSERT INTO public.message_thread_participants (thread_id, team_member_id)
  SELECT v_thread_id, tm.id::text
  FROM   public.team_members tm
  WHERE  tm.provider_id = v_provider_id
  ON CONFLICT (thread_id, team_member_id) DO NOTHING;

  RETURN v_thread_id;
END;
$$;


ALTER FUNCTION "public"."get_or_create_office_thread"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_or_create_team_thread"() RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_thread_id   uuid;
  v_provider_id uuid;
  v_caller_id   text;
BEGIN
  SELECT tm.id::text, tm.provider_id
  INTO   v_caller_id, v_provider_id
  FROM   public.team_members tm
  WHERE  tm.profile_id = auth.uid()
  LIMIT  1;

  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'access_denied: caller has no team_member row';
  END IF;

  SELECT id INTO v_thread_id
  FROM   public.message_threads
  WHERE  provider_id = v_provider_id
    AND  thread_type = 'team';

  IF v_thread_id IS NOT NULL THEN
    INSERT INTO public.message_thread_participants (thread_id, team_member_id)
    VALUES (v_thread_id, v_caller_id)
    ON CONFLICT (thread_id, team_member_id) DO NOTHING;
    RETURN v_thread_id;
  END IF;

  INSERT INTO public.message_threads (
    provider_id, thread_type, created_by_team_member_id, title
  )
  VALUES (v_provider_id, 'team', v_caller_id, 'Team')
  ON CONFLICT (provider_id, thread_type) WHERE thread_type IN ('office', 'team') DO NOTHING
  RETURNING id INTO v_thread_id;

  IF v_thread_id IS NULL THEN
    SELECT id INTO v_thread_id
    FROM   public.message_threads
    WHERE  provider_id = v_provider_id AND thread_type = 'team';
  END IF;

  INSERT INTO public.message_thread_participants (thread_id, team_member_id)
  SELECT v_thread_id, tm.id::text
  FROM   public.team_members tm
  WHERE  tm.provider_id = v_provider_id
  ON CONFLICT (thread_id, team_member_id) DO NOTHING;

  RETURN v_thread_id;
END;
$$;


ALTER FUNCTION "public"."get_or_create_team_thread"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_provider_avatar"("p_provider_id" "uuid") RETURNS "text"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
  select public_url
  from public.provider_media
  where provider_id = p_provider_id
    and kind = 'avatar'
  order by created_at desc
  limit 1;
$$;


ALTER FUNCTION "public"."get_provider_avatar"("p_provider_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_provider_media"("p_provider_id" "uuid") RETURNS TABLE("id" "uuid", "provider_id" "uuid", "kind" "text", "public_url" "text", "caption" "text", "sort_order" integer)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
  select
    id,
    provider_id,
    kind,
    public_url,
    caption,
    sort_order
  from public.provider_media
  where provider_id = p_provider_id
  order by sort_order asc, created_at asc;
$$;


ALTER FUNCTION "public"."get_provider_media"("p_provider_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_provider_median_response_ms"("p_craftsman_user_id" "text", "p_window_days" integer DEFAULT 90) RETURNS bigint
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
  SELECT
    (
      percentile_cont(0.5) WITHIN GROUP (
        ORDER BY (first_reply.first_message_at - c.created_at)
      )
    )::bigint
  FROM conversations c
  JOIN LATERAL (
    SELECT MIN(m.created_at) AS first_message_at
    FROM messages m
    WHERE m.conversation_id = c.id
      AND m.sender_user_id   = p_craftsman_user_id::uuid
  ) first_reply
    ON first_reply.first_message_at IS NOT NULL
  WHERE c.craftsman_user_id = p_craftsman_user_id::uuid
    AND c.created_at > 0
    AND c.created_at > (
      EXTRACT(epoch FROM now())::bigint - p_window_days::bigint * 86400
    ) * 1000
$$;


ALTER FUNCTION "public"."get_provider_median_response_ms"("p_craftsman_user_id" "text", "p_window_days" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_provider_portfolio"("p_provider_id" "uuid") RETURNS TABLE("id" "uuid", "public_url" "text", "caption" "text", "sort_order" integer)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
  select
    id,
    public_url,
    caption,
    sort_order
  from public.provider_media
  where provider_id = p_provider_id
    and kind = 'portfolio'
  order by sort_order asc, created_at asc;
$$;


ALTER FUNCTION "public"."get_provider_portfolio"("p_provider_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_auth_user_delete_cascade"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'vault', 'extensions'
    AS $$
DECLARE
  v_url text;
  v_secret text;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'account_cascade_cleanup.url' LIMIT 1;
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'account_cascade_cleanup.shared_secret' LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'account-cascade vault unavailable: %', SQLERRM;
    RETURN OLD;
  END;
  IF v_url IS NULL OR v_secret IS NULL THEN
    RAISE NOTICE 'account-cascade vault secrets missing (account_cascade_cleanup.url / .shared_secret) — skipping cleanup dispatch';
    RETURN OLD;
  END IF;
  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-fixup-trigger-secret', v_secret
      ),
      body := jsonb_build_object('user_id', OLD.id::text),
      timeout_milliseconds := 5000
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'account-cascade pg_net.http_post failed: %', SQLERRM;
  END;
  RETURN OLD;
END;
$$;


ALTER FUNCTION "public"."handle_auth_user_delete_cascade"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."handle_auth_user_delete_cascade"() IS 'Phase 5 Spatial V1.6 · Hybrid DSGVO-Cascade Safety-Net. Vercel-Route primär (api/delete-account.ts), dieser Trigger fängt alternative Delete-Pfade (Admin-Console, RPC, direct-SQL). EXCEPTION WHEN OTHERS damit auth.users DELETE nie blockiert.';



CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  INSERT INTO public.profiles (id)
  VALUES (NEW.id)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."increment_craftsman_jobs_count"("p_craftsman_user_id" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- Caller must be the craftsman themselves, or a customer on an active/completed
  -- job with this craftsman.  Prevents arbitrary authenticated users from inflating
  -- any craftsman's counter via direct RPC calls.
  IF auth.uid()::text <> p_craftsman_user_id AND NOT EXISTS (
    SELECT 1 FROM public.jobs
    WHERE craftsman_user_id = p_craftsman_user_id
      AND customer_user_id  = auth.uid()::text
      AND status IN ('waiting_payment', 'in_progress', 'completed')
  ) THEN
    RAISE EXCEPTION 'Not authorized to increment jobs count for this craftsman';
  END IF;

  UPDATE public.craftsman_profiles
  SET completed_jobs_count = COALESCE(completed_jobs_count, 0) + 1
  WHERE user_id = p_craftsman_user_id;
END;
$$;


ALTER FUNCTION "public"."increment_craftsman_jobs_count"("p_craftsman_user_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_blocked"("user_a" "uuid", "user_b" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
  select exists (
    select 1 from public.user_blocks
    where (blocker_id = user_a and blocked_id = user_b)
       or (blocker_id = user_b and blocked_id = user_a)
  );
$$;


ALTER FUNCTION "public"."is_blocked"("user_a" "uuid", "user_b" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."is_blocked"("user_a" "uuid", "user_b" "uuid") IS 'Returns true if either user has blocked the other. Use to filter content visibility.';



CREATE OR REPLACE FUNCTION "public"."is_blocked_by_me"("target_user_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_blocks
    WHERE blocker_id = (SELECT auth.uid())
      AND blocked_id = target_user_id
  );
$$;


ALTER FUNCTION "public"."is_blocked_by_me"("target_user_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."is_blocked_by_me"("target_user_id" "uuid") IS 'Returns true if auth.uid() has blocked target_user_id. Used by chat_messages_select_participant policy for silent-drop semantics. SECURITY DEFINER bypasses user_blocks RLS to keep policy evaluation deterministic.';



CREATE OR REPLACE FUNCTION "public"."is_caller_moderation_write_allowed"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid()
      AND (
        p.moderation_state = 'banned'
        OR (
          p.moderation_state = 'suspended'
          AND (p.suspension_expires_at IS NULL OR p.suspension_expires_at > now())
        )
      )
  );
$$;


ALTER FUNCTION "public"."is_caller_moderation_write_allowed"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_current_user_operator"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.is_operator = true
  );
$$;


ALTER FUNCTION "public"."is_current_user_operator"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_pro_owner"("p_profile_id" "uuid", "p_now" timestamp with time zone DEFAULT "now"()) RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.craftsman_subscriptions cs
    WHERE cs.profile_id = p_profile_id
      AND (
        cs.status IN ('active', 'grace')
        OR (cs.status = 'trial_active' AND cs.trial_ends_at > p_now)
        OR (cs.status = 'canceled'     AND cs.current_period_end > p_now)
      )
  );
$$;


ALTER FUNCTION "public"."is_pro_owner"("p_profile_id" "uuid", "p_now" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."jobs_terminal_status_guard"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF OLD.status IN ('completed', 'cancelled')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF auth.uid() IS NULL OR public.is_current_user_operator() THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'terminal_status_immutable: job % cannot leave terminal status % (attempted %)',
      OLD.id, OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."jobs_terminal_status_guard"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."join_company_with_code"("p_code" "text", "p_full_name" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_normalized_code text;
  v_uid             uuid := auth.uid();
  v_code_row        record;
  v_recent_failures int;
  v_caller_email    text;
  v_stub_id         uuid;
begin
  v_normalized_code := upper(trim(coalesce(p_code, '')));

  if v_normalized_code !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$' then
    insert into public.failed_join_attempts (attempted_by, code_input, reason)
    values (v_uid, left(v_normalized_code, 32), 'invalid_format');
    return jsonb_build_object(
      'ok', false,
      'error', 'Code muss 6 Zeichen aus A–Z (ohne I, O) und 2–9 sein.',
      'code', 'invalid_format'
    );
  end if;

  if v_uid is not null then
    select count(*) into v_recent_failures
    from public.failed_join_attempts
    where attempted_by = v_uid
      and attempted_at > now() - interval '1 hour';
    if v_recent_failures >= 10 then
      return jsonb_build_object(
        'ok', false,
        'error', 'Zu viele Versuche. Bitte in einer Stunde nochmal.',
        'code', 'rate_limited'
      );
    end if;
  end if;

  select id, provider_id, target_role, status into v_code_row
  from public.company_join_codes
  where code = v_normalized_code;

  if not found then
    insert into public.failed_join_attempts (attempted_by, code_input, reason)
    values (v_uid, v_normalized_code, 'not_found');
    return jsonb_build_object(
      'ok', false,
      'error', 'Code unbekannt. Bitte den aktuellen Code beim Chef erfragen.',
      'code', 'not_found'
    );
  end if;

  if v_code_row.status = 'rotated' then
    insert into public.failed_join_attempts (attempted_by, code_input, reason)
    values (v_uid, v_normalized_code, 'rotated');
    return jsonb_build_object(
      'ok', false,
      'error', 'Dieser Code wurde geändert. Bitte den neuen Code erfragen.',
      'code', 'rotated'
    );
  end if;

  if v_code_row.status <> 'active' then
    insert into public.failed_join_attempts (attempted_by, code_input, reason)
    values (v_uid, v_normalized_code, 'expired');
    return jsonb_build_object(
      'ok', false,
      'error', 'Dieser Code ist abgelaufen.',
      'code', 'expired'
    );
  end if;

  if exists (
    select 1 from public.team_members
    where provider_id = v_code_row.provider_id and profile_id = v_uid
  ) then
    update public.team_members
       set is_active  = true,
           full_name  = coalesce(nullif(trim(p_full_name), ''), full_name),
           updated_at = now()
     where provider_id = v_code_row.provider_id and profile_id = v_uid;
    return jsonb_build_object('ok', true, 'provider_id', v_code_row.provider_id);
  end if;

  select lower(u.email) into v_caller_email from auth.users u where u.id = v_uid;
  if v_caller_email is not null then
    select tm.id into v_stub_id
    from public.team_members tm
    where tm.provider_id = v_code_row.provider_id
      and lower(tm.email) = v_caller_email
      and tm.profile_id is null
    limit 1;
    if v_stub_id is not null then
      update public.team_members
         set profile_id = v_uid,
             full_name  = coalesce(nullif(trim(p_full_name), ''), full_name),
             is_active  = true,
             updated_at = now()
       where id = v_stub_id;
      return jsonb_build_object(
        'ok', true,
        'provider_id', v_code_row.provider_id,
        'matched_stub', true
      );
    end if;
  end if;

  insert into public.team_members (provider_id, profile_id, full_name, role, is_active)
  values (
    v_code_row.provider_id,
    v_uid,
    coalesce(nullif(trim(p_full_name), ''), 'Mitarbeiter'),
    v_code_row.target_role,
    true
  )
  on conflict do nothing;

  return jsonb_build_object('ok', true, 'provider_id', v_code_row.provider_id);

exception when others then
  insert into public.failed_join_attempts (attempted_by, code_input, reason)
  values (v_uid, left(coalesce(v_normalized_code, ''), 32), 'unknown');
  return jsonb_build_object(
    'ok', false,
    'error', 'Beitritt fehlgeschlagen. Bitte versuche es erneut.',
    'code', 'unknown'
  );
end;
$_$;


ALTER FUNCTION "public"."join_company_with_code"("p_code" "text", "p_full_name" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."join_company_with_code"("p_code" "text", "p_full_name" "text") IS 'Hardened Block-4 join-code lookup. Validates format + rate-limit + status before insert; preserves stub-email-match and idempotent re-activation. Audit rows go to public.failed_join_attempts (default-deny). Reason codes: invalid_format, not_found, rotated, expired, rate_limited, unknown.';



CREATE OR REPLACE FUNCTION "public"."leave_company"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid   uuid := "auth"."uid"();
  v_count int;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Nicht eingeloggt.', 'code', 'unauthenticated');
  END IF;

  IF EXISTS (
    SELECT 1 FROM "team_members"
    WHERE "profile_id" = v_uid
      AND "role"       = 'owner'
      AND "is_active"  = true
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Inhaber können das Team nicht selbst verlassen. Bitte Support kontaktieren.', 'code', 'owner_cannot_leave');
  END IF;

  UPDATE "team_members"
     SET "is_active"  = false,
         "updated_at" = now()
   WHERE "profile_id" = v_uid
     AND "is_active"  = true
     AND "role"      <> 'owner';

  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Du bist aktuell nicht Mitglied eines Teams.', 'code', 'not_member');
  END IF;

  RETURN jsonb_build_object('ok', true, 'count', v_count);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', 'Austritt fehlgeschlagen. Bitte versuche es erneut.', 'code', 'unknown');
END;
$$;


ALTER FUNCTION "public"."leave_company"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notification_push_copy"("p_type" "text") RETURNS TABLE("title" "text", "body" "text")
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
  SELECT
    CASE p_type
      WHEN 'dispute_opened'              THEN 'Streitfall eröffnet'
      WHEN 'dispute_resolved'            THEN 'Streitfall entschieden'
      WHEN 'dispute_under_review'        THEN 'Streitfall in Prüfung'
      WHEN 'dispute_evidence_attached'   THEN 'Neue Belege im Streitfall'
      WHEN 'dispute_evidence_requested'  THEN 'Belege angefordert'
      WHEN 'dispute_response_required'   THEN 'Antwort erforderlich'
      WHEN 'release_requested'           THEN 'Freigabe angefragt'
      WHEN 'release_blocked'             THEN 'Freigabe blockiert'
      WHEN 'work_completed'              THEN 'Arbeit abgeschlossen'
      WHEN 'worker_marked_complete'      THEN 'Mitarbeiter meldet Abschluss'
      WHEN 'admin_confirmed_complete'    THEN 'Abschluss bestätigt'
      WHEN 'admin_rejected_completion'   THEN 'Abschluss abgelehnt'
      WHEN 'acceptance_reminder_24h'     THEN 'Erinnerung: Abnahme'
      WHEN 'acceptance_reminder_60h'     THEN 'Letzte Erinnerung: Abnahme'
      WHEN 'funding_requested'           THEN 'Zahlung angefragt'
      WHEN 'invoice_cancelled'           THEN 'Rechnung storniert'
      WHEN 'payment_refunded'            THEN 'Zahlung zurückerstattet'
      WHEN 'payout_handoff_failed'       THEN 'Auszahlung fehlgeschlagen'
      WHEN 'payout_failed'               THEN 'Auszahlung fehlgeschlagen'
      WHEN 'transfer_reversed'           THEN 'Buchung zurückgenommen'
      WHEN 'schedule_rescheduled'        THEN 'Termin geändert'
      WHEN 'schedule_cancelled'          THEN 'Termin abgesagt'
      WHEN 'proposal_accepted'           THEN 'Angebot angenommen'
      WHEN 'correction_created'          THEN 'Korrektur angefragt'
      WHEN 'correction_rejected'         THEN 'Korrektur abgelehnt'
      WHEN 'correction_resolved'         THEN 'Korrektur angenommen'
      ELSE 'Neue Benachrichtigung'
    END,
    CASE p_type
      WHEN 'dispute_opened'              THEN 'Ein Streitfall wurde eröffnet. Bitte in der App prüfen.'
      WHEN 'dispute_resolved'            THEN 'Eine Entscheidung wurde getroffen.'
      WHEN 'dispute_under_review'        THEN 'Wir prüfen die Unterlagen — Status in der App einsehbar.'
      WHEN 'dispute_evidence_attached'   THEN 'Es wurden neue Belege hochgeladen.'
      WHEN 'dispute_evidence_requested'  THEN 'Bitte reichen Sie weitere Belege ein.'
      WHEN 'dispute_response_required'   THEN 'Im Streitfall wird Ihre Stellungnahme erwartet.'
      WHEN 'release_requested'           THEN 'Eine Auszahlung wurde angefragt.'
      WHEN 'release_blocked'             THEN 'Eine Auszahlung ist blockiert — bitte prüfen.'
      WHEN 'work_completed'              THEN 'Die Arbeit wurde als abgeschlossen gemeldet.'
      WHEN 'worker_marked_complete'      THEN 'Ein Mitarbeiter hat den Abschluss gemeldet.'
      WHEN 'admin_confirmed_complete'    THEN 'Der Abschluss wurde bestätigt.'
      WHEN 'admin_rejected_completion'   THEN 'Der Abschluss wurde abgelehnt — bitte prüfen.'
      WHEN 'acceptance_reminder_24h'     THEN 'Bitte schließen Sie die Abnahme ab.'
      WHEN 'acceptance_reminder_60h'     THEN 'Letzte Erinnerung — bitte Abnahme abschließen.'
      WHEN 'funding_requested'           THEN 'Bitte hinterlegen Sie die Zahlung in der App.'
      WHEN 'invoice_cancelled'           THEN 'Eine Rechnung wurde storniert.'
      WHEN 'payment_refunded'            THEN 'Eine Zahlung wurde zurückerstattet.'
      WHEN 'payout_handoff_failed'       THEN 'Die Auszahlung konnte nicht ausgelöst werden.'
      WHEN 'payout_failed'               THEN 'Eine Auszahlung ist fehlgeschlagen.'
      WHEN 'transfer_reversed'           THEN 'Eine Buchung wurde zurückgenommen.'
      WHEN 'schedule_rescheduled'        THEN 'Ein Termin wurde verschoben.'
      WHEN 'schedule_cancelled'          THEN 'Ein Termin wurde abgesagt.'
      WHEN 'proposal_accepted'           THEN 'Ein Angebot wurde angenommen.'
      WHEN 'correction_created'          THEN 'Eine Korrektur wurde angefragt.'
      WHEN 'correction_rejected'         THEN 'Eine Korrektur wurde abgelehnt.'
      WHEN 'correction_resolved'         THEN 'Eine Korrektur wurde angenommen.'
      ELSE 'Bitte in der App prüfen.'
    END
$$;


ALTER FUNCTION "public"."notification_push_copy"("p_type" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."notification_push_copy"("p_type" "text") IS 'N13.NOTIFY — German title/body strings for APNs alerts. Mirror of the email template catalogue. Block A: includes correction_resolved (worker-facing approval push).';



CREATE OR REPLACE FUNCTION "public"."notification_push_recipient"("p_job_id" "uuid", "p_recipient_role" "text") RETURNS "text"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user_id text;
BEGIN
  IF p_job_id IS NULL OR p_recipient_role IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_recipient_role = 'customer' THEN
    SELECT customer_user_id::text INTO v_user_id
    FROM public.jobs WHERE id = p_job_id;
  ELSIF p_recipient_role = 'craftsman' THEN
    SELECT craftsman_user_id INTO v_user_id
    FROM public.jobs WHERE id = p_job_id;
  ELSE
    RETURN NULL;
  END IF;
  RETURN v_user_id;
END;
$$;


ALTER FUNCTION "public"."notification_push_recipient"("p_job_id" "uuid", "p_recipient_role" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."notification_push_recipient"("p_job_id" "uuid", "p_recipient_role" "text") IS 'N13.NOTIFY — resolves notification_signals.recipient_role + job_id to user_id.';



CREATE OR REPLACE FUNCTION "public"."notification_signals_dispatch_push"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
DECLARE
  v_recipient text;
  v_url       text;
  v_secret    text;
  v_title     text;
  v_body      text;
  v_pushes    jsonb;
  v_token_count int;
BEGIN
  IF NEW.priority NOT IN ('action', 'alert') THEN
    RETURN NEW;
  END IF;

  v_recipient := public.notification_push_recipient(NEW.job_id, NEW.recipient_role);
  IF v_recipient IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT decrypted_secret INTO v_url
    FROM vault.decrypted_secrets WHERE name = 'notify_push.url';
    SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets WHERE name = 'notify_push.shared_secret';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'notify_push: vault unavailable — skipping (sqlstate=%, msg=%)', SQLSTATE, SQLERRM;
    RETURN NEW;
  END;

  IF v_url IS NULL OR v_secret IS NULL THEN
    RAISE NOTICE 'notify_push: vault entries notify_push.url or notify_push.shared_secret missing — skipping';
    RETURN NEW;
  END IF;

  SELECT title, body INTO v_title, v_body FROM public.notification_push_copy(NEW.type);

  SELECT
    jsonb_agg(
      jsonb_build_object(
        'token', t.token,
        'title', v_title,
        'body',  v_body,
        'data',  jsonb_build_object(
          'jobId',          NEW.job_id,
          'type',           NEW.type,
          'signalId',       NEW.id,
          'priority',       NEW.priority,
          'entityId',       NEW.entity_id,
          'entityType',     NEW.entity_type,
          'actionType',     NEW.action_type,
          'roleTarget',     NEW.role_target,
          'expectedStatus', NEW.expected_status,
          'expiresAt',      NEW.expires_at
        )
      )
    ),
    COUNT(*)
  INTO v_pushes, v_token_count
  FROM public.notification_device_tokens t
  WHERE t.user_id = v_recipient;

  IF v_token_count = 0 OR v_pushes IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    PERFORM net.http_post(
      url     := v_url,
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-fixup-trigger-secret', v_secret
      ),
      body    := jsonb_build_object('pushes', v_pushes),
      timeout_milliseconds := 5000
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'notify_push: pg_net.http_post failed (sqlstate=%, msg=%)', SQLSTATE, SQLERRM;
  END;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."notification_signals_dispatch_push"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."notification_signals_dispatch_push"() IS 'N13.NOTIFY — fan-out trigger. AFTER INSERT on notification_signals, resolves recipient, reads tokens, posts to notify-push Edge Function. Fire-and-forget; never blocks the insert.';



CREATE OR REPLACE FUNCTION "public"."offers_mark_quote_stale"("p_offer_id" "uuid", "p_reason" "text", "p_source_scene_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid              uuid;
  v_customer_user_id uuid;
  v_status           text;
  v_is_stale         boolean;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'offers_mark_quote_stale: authentication required' USING ERRCODE = '28000';
  END IF;

  IF p_reason NOT IN ('measurement_changed','high_severity_pin_added','layout_changed') THEN
    RAISE EXCEPTION
      'offers_mark_quote_stale: invalid reason %; must be measurement_changed|high_severity_pin_added|layout_changed',
      p_reason USING ERRCODE = '22023';
  END IF;

  SELECT customer_user_id, status, is_stale
    INTO v_customer_user_id, v_status, v_is_stale
    FROM public.offers WHERE id = p_offer_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'offers_mark_quote_stale: offer % not found', p_offer_id USING ERRCODE = 'P0002';
  END IF;

  IF v_customer_user_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'offers_mark_quote_stale: caller is not the customer of offer %', p_offer_id USING ERRCODE = '42501';
  END IF;

  IF NOT public.spatial_can_view_scene(p_source_scene_id, v_uid) THEN
    RAISE EXCEPTION 'offers_mark_quote_stale: caller is not a scene-actor of source scene %', p_source_scene_id USING ERRCODE = '42501';
  END IF;

  IF v_is_stale = true THEN RETURN false; END IF;
  IF v_status <> 'pending' THEN RETURN false; END IF;

  UPDATE public.offers
     SET is_stale              = true,
         stale_reason          = p_reason,
         stale_marked_at       = now(),
         stale_source_scene_id = p_source_scene_id
   WHERE id = p_offer_id;

  RETURN true;
END;
$$;


ALTER FUNCTION "public"."offers_mark_quote_stale"("p_offer_id" "uuid", "p_reason" "text", "p_source_scene_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."offers_mark_quote_stale"("p_offer_id" "uuid", "p_reason" "text", "p_source_scene_id" "uuid") IS 'Spatial Canonical Block 3.9 (Verify-Flow 4): SECURITY DEFINER RPC that marks one pending offer stale on behalf of its customer after a scan-basis change. Validates auth.uid() = offers.customer_user_id and scene-actor membership of the source scene; bypasses offers RLS so the customer never needs a direct UPDATE grant on a provider offer column. now() is stamped server-side. Returns true when newly flagged, false on idempotent no-op (already stale / not pending). Pairs with verifyReQuote.ts planMarkQuotesStale.';



CREATE OR REPLACE FUNCTION "public"."open_dispute_atomic"("p_job_id" "uuid", "p_dispute_id" "uuid", "p_reason" "text", "p_description" "text", "p_raised_by" "text" DEFAULT NULL::"text", "p_payment_id" "uuid" DEFAULT NULL::"uuid", "p_metadata" "jsonb" DEFAULT '{}'::"jsonb", "p_context_snapshot" "jsonb" DEFAULT NULL::"jsonb", "p_opened_at" timestamp with time zone DEFAULT "now"()) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid                  uuid := auth.uid();
  v_payment_status       text;
  v_payment_id_uuid      uuid;
  v_customer_profile_id  uuid;
  v_provider_id          uuid;
  v_is_operator          boolean := false;
  v_is_customer          boolean := false;
  v_is_provider          boolean := false;
  v_is_party             boolean := false;
  v_now                  timestamptz := COALESCE(p_opened_at, now());
  v_raised_by            text;
  v_dispute_json         jsonb;
BEGIN
  v_raised_by := CASE
    WHEN v_uid IS NOT NULL THEN v_uid::text
    ELSE p_raised_by
  END;

  SELECT j.customer_profile_id,
         j.provider_id
    INTO v_customer_profile_id, v_provider_id
    FROM public.jobs j
   WHERE j.id = p_job_id
   FOR UPDATE;

  IF v_customer_profile_id IS NULL AND v_provider_id IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = p_job_id) THEN
      RAISE EXCEPTION 'job_not_found: %', p_job_id
        USING ERRCODE = 'P0002';
    END IF;
  END IF;

  IF v_uid IS NOT NULL THEN
    v_is_operator := public.is_current_user_operator();

    SELECT EXISTS (
      SELECT 1 FROM public.jobs j
      WHERE j.id = p_job_id
        AND (j.customer_user_id = v_uid OR j.customer_profile_id = v_uid)
    ) INTO v_is_customer;

    SELECT EXISTS (
      SELECT 1 FROM public.jobs j
      WHERE j.id = p_job_id
        AND (
          j.craftsman_user_id = v_uid::text
          OR j.provider_id IN (
            SELECT pr.id FROM public.providers pr WHERE pr.profile_id = v_uid
          )
        )
    ) INTO v_is_provider;

    v_is_party := v_is_operator OR v_is_customer OR v_is_provider;

    IF NOT v_is_party THEN
      RAISE EXCEPTION 'unauthorized: caller is not a participant in job %', p_job_id
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.disputes
    WHERE job_id = p_job_id
      AND status IN ('open','under_review','customer_waiting','provider_waiting')
  ) THEN
    RAISE EXCEPTION 'active_dispute_exists: job %', p_job_id
      USING ERRCODE = '23505';
  END IF;

  IF p_payment_id IS NOT NULL THEN
    SELECT status::text INTO v_payment_status
      FROM public.payments
     WHERE id = p_payment_id
     FOR UPDATE;
  ELSE
    SELECT status::text, id INTO v_payment_status, v_payment_id_uuid
      FROM public.payments
     WHERE job_id::text = p_job_id::text
     FOR UPDATE;
    IF v_payment_id_uuid IS NOT NULL THEN
      p_payment_id := v_payment_id_uuid;
    END IF;
  END IF;

  IF v_payment_status IS NOT NULL
     AND v_payment_status NOT IN ('in_escrow','work_in_progress','release_pending','disputed')
  THEN
    RAISE EXCEPTION 'payment_invalid_for_dispute: current status is %, cannot transition to disputed',
      v_payment_status
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.disputes (
    id, job_id, payment_id, opened_by_profile_id, customer_profile_id, provider_id,
    status, reason, description, raised_by, metadata, context_snapshot,
    opened_at, created_at, updated_at
  ) VALUES (
    p_dispute_id, p_job_id, p_payment_id, v_uid, v_customer_profile_id, v_provider_id,
    'open', p_reason, p_description, v_raised_by, COALESCE(p_metadata, '{}'::jsonb), p_context_snapshot,
    v_now, v_now, v_now
  );

  IF v_payment_status IS NOT NULL AND v_payment_status <> 'disputed' THEN
    UPDATE public.payments
       SET status     = 'disputed',
           updated_at = now()
     WHERE (p_payment_id IS NOT NULL AND id = p_payment_id)
        OR (p_payment_id IS NULL     AND job_id::text = p_job_id::text);
  END IF;

  UPDATE public.jobs
     SET dispute_status = 'open'
   WHERE id = p_job_id;

  INSERT INTO public.dispute_status_history (
    dispute_id, job_id, previous_status, next_status, source, note, metadata, created_at
  ) VALUES (
    p_dispute_id, p_job_id, NULL, 'open', 'system', NULL,
    jsonb_build_object(
      'reason',               p_reason,
      'raised_by',            v_raised_by,
      'payment_id',           p_payment_id,
      'opened_by_profile_id', v_uid,
      'context_snapshot',     p_context_snapshot
    ),
    v_now
  );

  SELECT row_to_json(d)::jsonb INTO v_dispute_json
    FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_dispute_json;
END;
$$;


ALTER FUNCTION "public"."open_dispute_atomic"("p_job_id" "uuid", "p_dispute_id" "uuid", "p_reason" "text", "p_description" "text", "p_raised_by" "text", "p_payment_id" "uuid", "p_metadata" "jsonb", "p_context_snapshot" "jsonb", "p_opened_at" timestamp with time zone) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."open_dispute_atomic"("p_job_id" "uuid", "p_dispute_id" "uuid", "p_reason" "text", "p_description" "text", "p_raised_by" "text", "p_payment_id" "uuid", "p_metadata" "jsonb", "p_context_snapshot" "jsonb", "p_opened_at" timestamp with time zone) IS 'Block 5.6 v2: opens a dispute atomically using the gamma schema (uuid + timestamptz + jsonb metadata).';



CREATE OR REPLACE FUNCTION "public"."operator_enforce_report"("p_action" "text", "p_report_id" "uuid", "p_target_user_id" "uuid", "p_notes" "text" DEFAULT NULL::"text", "p_suspend_hours" integer DEFAULT NULL::integer, "p_target_message_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_operator_id        uuid;
  v_now                timestamptz := now();
  v_expires_at         timestamptz;
  v_new_report_status  text;
  v_target_entity_type text := NULL;
  v_target_entity_id   text := NULL;
BEGIN
  v_operator_id := public._assert_caller_is_operator();

  IF p_action NOT IN ('warn', 'hide_content', 'suspend', 'ban', 'dismiss') THEN
    RAISE EXCEPTION 'invalid_argument: unknown action %', p_action USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_reports
    WHERE id = p_report_id AND reported_id = p_target_user_id
  ) THEN
    RAISE EXCEPTION 'invalid_argument: report % not found or target mismatch', p_report_id
      USING ERRCODE = 'P0001';
  END IF;

  IF p_action = 'suspend' THEN
    IF p_suspend_hours IS NULL OR p_suspend_hours <= 0 THEN
      RAISE EXCEPTION 'invalid_argument: suspend requires p_suspend_hours > 0' USING ERRCODE = 'P0001';
    END IF;
    v_expires_at := v_now + (p_suspend_hours * interval '1 hour');
    UPDATE public.profiles
      SET moderation_state = 'suspended', suspension_expires_at = v_expires_at
      WHERE id = p_target_user_id;
    v_new_report_status := 'actioned';

  ELSIF p_action = 'ban' THEN
    UPDATE public.profiles
      SET moderation_state = 'banned', suspension_expires_at = NULL
      WHERE id = p_target_user_id;
    v_new_report_status := 'actioned';

  ELSIF p_action = 'warn' THEN
    v_new_report_status := 'actioned';

  ELSIF p_action = 'hide_content' THEN
    IF p_target_message_id IS NULL THEN
      RAISE EXCEPTION 'invalid_argument: hide_content requires p_target_message_id' USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.chat_messages
      SET deleted_at      = public.epoch_ms(),
          redacted        = true,
          redacted_at     = public.epoch_ms(),
          redacted_reason = COALESCE(p_notes, 'operator_moderation')
      WHERE id = p_target_message_id
        AND sender_user_id = p_target_user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid_argument: message % not found or not authored by target', p_target_message_id
        USING ERRCODE = 'P0001';
    END IF;
    v_target_entity_type := 'chat_message';
    v_target_entity_id   := p_target_message_id::text;
    v_new_report_status  := 'actioned';

  ELSIF p_action = 'dismiss' THEN
    v_new_report_status := 'dismissed';
  END IF;

  UPDATE public.user_reports
    SET status         = v_new_report_status,
        reviewed_by    = v_operator_id,
        reviewed_at    = v_now,
        operator_notes = COALESCE(p_notes, operator_notes)
    WHERE id = p_report_id;

  INSERT INTO public.moderation_action_log (
    operator_id, report_id, action_type, target_user_id,
    target_entity_type, target_entity_id, notes, suspension_until, created_at
  ) VALUES (
    v_operator_id, p_report_id, p_action, p_target_user_id,
    v_target_entity_type, v_target_entity_id, p_notes, v_expires_at, v_now
  );

  RETURN jsonb_build_object(
    'ok', true,
    'action', p_action,
    'report_status', v_new_report_status,
    'expires_at', v_expires_at
  );
END;
$$;


ALTER FUNCTION "public"."operator_enforce_report"("p_action" "text", "p_report_id" "uuid", "p_target_user_id" "uuid", "p_notes" "text", "p_suspend_hours" integer, "p_target_message_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."operator_mark_dispute_under_review"("p_dispute_id" "uuid", "p_note" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_operator_id  uuid;
  v_from_status  text;
  v_job_id       uuid;
  v_now          timestamptz := now();
  v_result       jsonb;
BEGIN
  v_operator_id := public._assert_caller_is_operator();
  SELECT status, job_id INTO v_from_status, v_job_id FROM public.disputes WHERE id = p_dispute_id FOR UPDATE;
  IF v_from_status IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id USING ERRCODE = 'P0002';
  END IF;
  IF v_from_status = 'under_review' THEN
    SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
    RETURN v_result;
  END IF;
  IF v_from_status NOT IN ('open','customer_waiting','provider_waiting') THEN
    RAISE EXCEPTION 'invalid_dispute_status: under_review requires status in (open,customer_waiting,provider_waiting), got %',
      v_from_status USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.disputes SET status = 'under_review', updated_at = v_now WHERE id = p_dispute_id;
  INSERT INTO public.dispute_status_history (dispute_id, job_id, previous_status, next_status, source, note, metadata, created_at)
  VALUES (p_dispute_id, v_job_id, v_from_status, 'under_review', 'admin', p_note,
    jsonb_build_object('operator_id', v_operator_id), v_now);
  UPDATE public.jobs SET dispute_status = 'under_review' WHERE id = v_job_id;
  SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."operator_mark_dispute_under_review"("p_dispute_id" "uuid", "p_note" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."operator_reject_dispute"("p_dispute_id" "uuid", "p_note" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_operator_id        uuid;
  v_from_status        text;
  v_decision           text;
  v_settlement_status  text;
  v_job_id             uuid;
  v_now                timestamptz := now();
  v_result             jsonb;
BEGIN
  v_operator_id := public._assert_caller_is_operator();
  SELECT status, job_id, decision, settlement_status
    INTO v_from_status, v_job_id, v_decision, v_settlement_status
    FROM public.disputes WHERE id = p_dispute_id FOR UPDATE;
  IF v_from_status IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id USING ERRCODE = 'P0002';
  END IF;
  IF v_from_status NOT IN ('open','under_review','customer_waiting','provider_waiting','resolved') THEN
    RAISE EXCEPTION 'invalid_dispute_status: reject got %', v_from_status USING ERRCODE = 'P0001';
  END IF;
  -- C5 decision immutability: a resolved dispute's decision can never be overwritten
  -- with a different decision. NULL-guarded (three-valued logic).
  IF v_from_status = 'resolved' AND v_decision IS NOT NULL AND v_decision <> 'reject' THEN
    RAISE EXCEPTION 'decision_immutable: dispute % already resolved with decision %, cannot re-resolve as reject',
      p_dispute_id, v_decision USING ERRCODE = 'P0001';
  END IF;
  -- Fully settled disputes are immutable: idempotent no-op (never regress settled -> pending).
  IF v_from_status = 'resolved' AND v_settlement_status = 'settled' THEN
    SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
    RETURN v_result;
  END IF;
  UPDATE public.disputes
     SET status            = 'resolved',
         decision           = 'reject',
         resolution_type    = 'rejected',
         settlement_status  = 'pending',  -- C4 fix: was 'settled'; money leg has not run yet
         resolved_at        = COALESCE(resolved_at, v_now),
         updated_at         = v_now
   WHERE id = p_dispute_id;
  INSERT INTO public.dispute_status_history (dispute_id, job_id, previous_status, next_status, source, note, metadata, created_at)
  VALUES (p_dispute_id, v_job_id, v_from_status, 'resolved', 'admin', p_note,
    jsonb_build_object('operator_id', v_operator_id, 'decision', 'reject', 'resolution_type', 'rejected'), v_now);
  UPDATE public.jobs SET dispute_status = 'resolved' WHERE id = v_job_id;
  SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."operator_reject_dispute"("p_dispute_id" "uuid", "p_note" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."operator_request_customer_evidence_dispute"("p_dispute_id" "uuid", "p_note" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_operator_id  uuid;
  v_from_status  text;
  v_job_id       uuid;
  v_now          timestamptz := now();
  v_result       jsonb;
BEGIN
  v_operator_id := public._assert_caller_is_operator();
  SELECT status, job_id INTO v_from_status, v_job_id FROM public.disputes WHERE id = p_dispute_id FOR UPDATE;
  IF v_from_status IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id USING ERRCODE = 'P0002';
  END IF;
  IF v_from_status = 'customer_waiting' THEN
    SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
    RETURN v_result;
  END IF;
  IF v_from_status NOT IN ('open','under_review') THEN
    RAISE EXCEPTION 'invalid_dispute_status: customer_waiting requires status in (open,under_review), got %',
      v_from_status USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.disputes SET status = 'customer_waiting', updated_at = v_now WHERE id = p_dispute_id;
  INSERT INTO public.dispute_status_history (dispute_id, job_id, previous_status, next_status, source, note, metadata, created_at)
  VALUES (p_dispute_id, v_job_id, v_from_status, 'customer_waiting', 'admin', p_note,
    jsonb_build_object('operator_id', v_operator_id, 'requested_party', 'customer'), v_now);
  UPDATE public.jobs SET dispute_status = 'customer_waiting' WHERE id = v_job_id;
  SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."operator_request_customer_evidence_dispute"("p_dispute_id" "uuid", "p_note" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."operator_request_provider_evidence_dispute"("p_dispute_id" "uuid", "p_note" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_operator_id  uuid;
  v_from_status  text;
  v_job_id       uuid;
  v_now          timestamptz := now();
  v_result       jsonb;
BEGIN
  v_operator_id := public._assert_caller_is_operator();
  SELECT status, job_id INTO v_from_status, v_job_id FROM public.disputes WHERE id = p_dispute_id FOR UPDATE;
  IF v_from_status IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id USING ERRCODE = 'P0002';
  END IF;
  IF v_from_status = 'provider_waiting' THEN
    SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
    RETURN v_result;
  END IF;
  IF v_from_status NOT IN ('open','under_review') THEN
    RAISE EXCEPTION 'invalid_dispute_status: provider_waiting requires status in (open,under_review), got %',
      v_from_status USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.disputes SET status = 'provider_waiting', updated_at = v_now WHERE id = p_dispute_id;
  INSERT INTO public.dispute_status_history (dispute_id, job_id, previous_status, next_status, source, note, metadata, created_at)
  VALUES (p_dispute_id, v_job_id, v_from_status, 'provider_waiting', 'admin', p_note,
    jsonb_build_object('operator_id', v_operator_id, 'requested_party', 'provider'), v_now);
  UPDATE public.jobs SET dispute_status = 'provider_waiting' WHERE id = v_job_id;
  SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."operator_request_provider_evidence_dispute"("p_dispute_id" "uuid", "p_note" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."operator_resolve_attribution"("p_job_id" "uuid", "p_mode" "text", "p_to_origin" "text", "p_reason" "text", "p_operator_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_current_status TEXT;
  v_current_origin TEXT;
  v_new_status     TEXT;
  v_new_origin     TEXT;
  v_event_type     TEXT;
  v_is_operator    BOOLEAN;
  v_normalized_reason TEXT;
BEGIN
  v_normalized_reason := NULLIF(btrim(COALESCE(p_reason, '')), '');

  IF p_operator_id IS NULL THEN
    RAISE EXCEPTION 'unauthorized: operator_id required'
      USING ERRCODE = '42501';
  END IF;

  SELECT is_operator
    INTO v_is_operator
    FROM public.profiles
   WHERE id = p_operator_id;

  IF NOT COALESCE(v_is_operator, FALSE) THEN
    RAISE EXCEPTION 'unauthorized: caller is not an operator'
      USING ERRCODE = '42501';
  END IF;

  IF p_mode NOT IN ('resolve', 'reclassify', 'reject') THEN
    RAISE EXCEPTION 'invalid_mode: %', p_mode
      USING ERRCODE = 'P0001';
  END IF;

  IF v_normalized_reason IS NULL THEN
    RAISE EXCEPTION 'reason_required: every operator action must carry a note'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_mode IN ('resolve', 'reclassify') THEN
    IF p_to_origin IS NULL OR p_to_origin NOT IN ('merchant_brought', 'platform_acquired') THEN
      RAISE EXCEPTION 'invalid_to_origin: must be merchant_brought or platform_acquired'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF p_mode = 'reject' THEN
    IF p_to_origin IS NOT NULL THEN
      RAISE EXCEPTION 'invalid_to_origin: reject must not carry an origin'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT attribution_status, commercial_origin
    INTO v_current_status, v_current_origin
    FROM public.jobs
   WHERE id = p_job_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'job_not_found: %', p_job_id
      USING ERRCODE = 'P0002';
  END IF;

  IF p_mode = 'resolve' THEN
    IF v_current_status NOT IN ('pending', 'retrying', 'dlq') THEN
      RAISE EXCEPTION 'invalid_transition: resolve requires pending|retrying|dlq, got %',
        v_current_status USING ERRCODE = 'P0001';
    END IF;
    v_new_status := 'finalized';
    v_new_origin := p_to_origin;
    v_event_type := 'operator_resolve';

  ELSIF p_mode = 'reclassify' THEN
    IF v_current_status IS DISTINCT FROM 'finalized' THEN
      RAISE EXCEPTION 'invalid_transition: reclassify requires finalized, got %',
        v_current_status USING ERRCODE = 'P0001';
    END IF;
    v_new_status := 'finalized';
    v_new_origin := p_to_origin;
    v_event_type := 'operator_reclassify';

  ELSIF p_mode = 'reject' THEN
    IF v_current_status NOT IN ('pending', 'retrying', 'dlq') THEN
      RAISE EXCEPTION 'invalid_transition: reject requires pending|retrying|dlq, got %',
        v_current_status USING ERRCODE = 'P0001';
    END IF;
    v_new_status := 'dlq';
    v_new_origin := NULL;
    v_event_type := 'dlq_entered';
  END IF;

  IF p_mode = 'reject' THEN
    UPDATE public.jobs
       SET attribution_status        = v_new_status,
           attribution_dlq_reason    = v_normalized_reason,
           attribution_last_retry_at = clock_timestamp()
     WHERE id = p_job_id;
  ELSE
    UPDATE public.jobs
       SET attribution_status        = v_new_status,
           commercial_origin         = v_new_origin,
           attribution_dlq_reason    = NULL,
           attribution_last_retry_at = clock_timestamp()
     WHERE id = p_job_id;
  END IF;

  INSERT INTO public.attribution_audit_log (
    job_id, event_type, from_status, to_status,
    from_origin, to_origin, operator_id, reason
  ) VALUES (
    p_job_id, v_event_type, v_current_status, v_new_status,
    v_current_origin, v_new_origin, p_operator_id, v_normalized_reason
  );

  RETURN jsonb_build_object(
    'outcome',     'resolved',
    'mode',        p_mode,
    'jobId',       p_job_id,
    'fromStatus',  v_current_status,
    'toStatus',    v_new_status,
    'fromOrigin',  v_current_origin,
    'toOrigin',    v_new_origin
  );
END;
$$;


ALTER FUNCTION "public"."operator_resolve_attribution"("p_job_id" "uuid", "p_mode" "text", "p_to_origin" "text", "p_reason" "text", "p_operator_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."operator_resolve_attribution"("p_job_id" "uuid", "p_mode" "text", "p_to_origin" "text", "p_reason" "text", "p_operator_id" "uuid") IS 'Operator RPC — moves a job out of DLQ, reclassifies a finalized origin, or re-affirms a DLQ row with a new operator note. Validates operator flag, transition matrix, reason presence. Writes attribution_audit_log atomically. SERVICE_ROLE only. Reject on dlq (since 20260420000005) keeps the row frozen but records the operator review.';



CREATE OR REPLACE FUNCTION "public"."operator_resolve_dispute_refund"("p_dispute_id" "uuid", "p_note" "text" DEFAULT NULL::"text", "p_refund_amount" numeric DEFAULT NULL::numeric, "p_release_amount" numeric DEFAULT NULL::numeric) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_operator_id        uuid;
  v_from_status        text;
  v_decision           text;
  v_settlement_status  text;
  v_job_id             uuid;
  v_resolution_type    text;
  v_now                timestamptz := now();
  v_result             jsonb;
BEGIN
  v_operator_id := public._assert_caller_is_operator();
  SELECT status, job_id, decision, settlement_status
    INTO v_from_status, v_job_id, v_decision, v_settlement_status
    FROM public.disputes WHERE id = p_dispute_id FOR UPDATE;
  IF v_from_status IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id USING ERRCODE = 'P0002';
  END IF;
  IF v_from_status NOT IN ('open','under_review','customer_waiting','provider_waiting','resolved') THEN
    RAISE EXCEPTION 'invalid_dispute_status: resolve_refund got %', v_from_status USING ERRCODE = 'P0001';
  END IF;
  IF v_from_status = 'resolved' AND v_decision IS NOT NULL AND v_decision <> 'refund' THEN
    RAISE EXCEPTION 'decision_immutable: dispute % already resolved with decision %, cannot re-resolve as refund',
      p_dispute_id, v_decision USING ERRCODE = 'P0001';
  END IF;
  IF v_from_status = 'resolved' AND v_settlement_status = 'settled' THEN
    SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
    RETURN v_result;
  END IF;
  v_resolution_type := CASE WHEN p_release_amount IS NULL OR p_release_amount = 0 THEN 'refund_full' ELSE 'refund_partial' END;
  UPDATE public.disputes
     SET status                 = 'resolved',
         decision               = 'refund',
         resolution_type        = v_resolution_type,
         settlement_status      = 'pending',
         refund_amount          = COALESCE(p_refund_amount,  refund_amount),
         release_amount         = COALESCE(p_release_amount, release_amount),
         customer_refund_amount = COALESCE(p_refund_amount,  customer_refund_amount),
         provider_award_amount  = COALESCE(p_release_amount, provider_award_amount),
         resolved_at            = COALESCE(resolved_at, v_now),
         updated_at             = v_now
   WHERE id = p_dispute_id;
  INSERT INTO public.dispute_status_history (dispute_id, job_id, previous_status, next_status, source, note, metadata, created_at)
  VALUES (p_dispute_id, v_job_id, v_from_status, 'resolved', 'admin', p_note,
    jsonb_build_object('operator_id', v_operator_id, 'decision', 'refund', 'resolution_type', v_resolution_type, 'refund_amount', p_refund_amount, 'release_amount', p_release_amount), v_now);
  UPDATE public.jobs SET dispute_status = 'resolved' WHERE id = v_job_id;

  -- R3.2 zombie-acceptance hygiene (additive): drive the related pending acceptance
  -- terminal so the auto-release sweep can never release the now-refunded final tranche.
  UPDATE public.acceptances
     SET status     = 'disputed',
         updated_at = (extract(epoch FROM now()) * 1000)::bigint
   WHERE job_id = v_job_id AND status = 'pending';

  SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."operator_resolve_dispute_refund"("p_dispute_id" "uuid", "p_note" "text", "p_refund_amount" numeric, "p_release_amount" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."operator_resolve_dispute_release"("p_dispute_id" "uuid", "p_note" "text" DEFAULT NULL::"text", "p_release_amount" numeric DEFAULT NULL::numeric, "p_refund_amount" numeric DEFAULT NULL::numeric) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_operator_id        uuid;
  v_from_status        text;
  v_decision           text;
  v_settlement_status  text;
  v_job_id             uuid;
  v_resolution_type    text;
  v_now                timestamptz := now();
  v_result             jsonb;
BEGIN
  v_operator_id := public._assert_caller_is_operator();
  SELECT status, job_id, decision, settlement_status
    INTO v_from_status, v_job_id, v_decision, v_settlement_status
    FROM public.disputes WHERE id = p_dispute_id FOR UPDATE;
  IF v_from_status IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id USING ERRCODE = 'P0002';
  END IF;
  IF v_from_status NOT IN ('open','under_review','customer_waiting','provider_waiting','resolved') THEN
    RAISE EXCEPTION 'invalid_dispute_status: resolve_release got %', v_from_status USING ERRCODE = 'P0001';
  END IF;
  IF v_from_status = 'resolved' AND v_decision IS NOT NULL AND v_decision <> 'release' THEN
    RAISE EXCEPTION 'decision_immutable: dispute % already resolved with decision %, cannot re-resolve as release',
      p_dispute_id, v_decision USING ERRCODE = 'P0001';
  END IF;
  IF v_from_status = 'resolved' AND v_settlement_status = 'settled' THEN
    SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
    RETURN v_result;
  END IF;
  v_resolution_type := CASE WHEN p_refund_amount IS NULL OR p_refund_amount = 0 THEN 'release_full' ELSE 'release_partial' END;
  UPDATE public.disputes
     SET status                 = 'resolved',
         decision               = 'release',
         resolution_type        = v_resolution_type,
         settlement_status      = 'pending',
         release_amount         = COALESCE(p_release_amount, release_amount),
         refund_amount          = COALESCE(p_refund_amount,  refund_amount),
         provider_award_amount  = COALESCE(p_release_amount, provider_award_amount),
         customer_refund_amount = COALESCE(p_refund_amount,  customer_refund_amount),
         resolved_at            = COALESCE(resolved_at, v_now),
         updated_at             = v_now
   WHERE id = p_dispute_id;
  INSERT INTO public.dispute_status_history (dispute_id, job_id, previous_status, next_status, source, note, metadata, created_at)
  VALUES (p_dispute_id, v_job_id, v_from_status, 'resolved', 'admin', p_note,
    jsonb_build_object('operator_id', v_operator_id, 'decision', 'release', 'resolution_type', v_resolution_type, 'release_amount', p_release_amount, 'refund_amount', p_refund_amount), v_now);
  UPDATE public.jobs SET dispute_status = 'resolved' WHERE id = v_job_id;
  SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."operator_resolve_dispute_release"("p_dispute_id" "uuid", "p_note" "text", "p_release_amount" numeric, "p_refund_amount" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."operator_resolve_dispute_split"("p_dispute_id" "uuid", "p_split_ratio" numeric, "p_note" "text" DEFAULT NULL::"text", "p_provider_award_amount" numeric DEFAULT NULL::numeric, "p_customer_refund_amount" numeric DEFAULT NULL::numeric) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_operator_id        uuid;
  v_from_status        text;
  v_decision           text;
  v_settlement_status  text;
  v_job_id             uuid;
  v_now                timestamptz := now();
  v_result             jsonb;
BEGIN
  v_operator_id := public._assert_caller_is_operator();
  -- (0,1) EXCLUSIVE: 0% is a full refund, 100% is a full release — neither is a
  -- split. Inclusive bounds double-paid at ratio=0 (see migration header).
  IF p_split_ratio IS NULL OR p_split_ratio <= 0 OR p_split_ratio >= 1 THEN
    RAISE EXCEPTION 'invalid_split_ratio: must be in (0,1) exclusive (0%% = refund, 100%% = release), got %', p_split_ratio USING ERRCODE = 'P0001';
  END IF;
  SELECT status, job_id, decision, settlement_status
    INTO v_from_status, v_job_id, v_decision, v_settlement_status
    FROM public.disputes WHERE id = p_dispute_id FOR UPDATE;
  IF v_from_status IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id USING ERRCODE = 'P0002';
  END IF;
  IF v_from_status NOT IN ('open','under_review','customer_waiting','provider_waiting','resolved') THEN
    RAISE EXCEPTION 'invalid_dispute_status: resolve_split got %', v_from_status USING ERRCODE = 'P0001';
  END IF;
  IF v_from_status = 'resolved' AND v_decision IS NOT NULL AND v_decision <> 'split' THEN
    RAISE EXCEPTION 'decision_immutable: dispute % already resolved with decision %, cannot re-resolve as split',
      p_dispute_id, v_decision USING ERRCODE = 'P0001';
  END IF;
  IF v_from_status = 'resolved' AND v_settlement_status = 'settled' THEN
    SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
    RETURN v_result;
  END IF;
  UPDATE public.disputes
     SET status                 = 'resolved',
         decision               = 'split',
         resolution_type        = 'split',
         split_ratio            = p_split_ratio,
         settlement_status      = 'pending',
         provider_award_amount  = COALESCE(p_provider_award_amount,  provider_award_amount),
         customer_refund_amount = COALESCE(p_customer_refund_amount, customer_refund_amount),
         release_amount         = COALESCE(p_provider_award_amount,  release_amount),
         refund_amount          = COALESCE(p_customer_refund_amount, refund_amount),
         resolved_at            = COALESCE(resolved_at, v_now),
         updated_at             = v_now
   WHERE id = p_dispute_id;
  INSERT INTO public.dispute_status_history (dispute_id, job_id, previous_status, next_status, source, note, metadata, created_at)
  VALUES (p_dispute_id, v_job_id, v_from_status, 'resolved', 'admin', p_note,
    jsonb_build_object('operator_id', v_operator_id, 'decision', 'split', 'resolution_type', 'split', 'split_ratio', p_split_ratio, 'provider_award_amount', p_provider_award_amount, 'customer_refund_amount', p_customer_refund_amount), v_now);
  UPDATE public.jobs SET dispute_status = 'resolved' WHERE id = v_job_id;

  -- R3.2 zombie-acceptance hygiene (additive): a split also refunds the customer's
  -- share, so the pending acceptance must go terminal — otherwise the auto-release
  -- sweep would blind-release the FULL final tranche to the provider.
  UPDATE public.acceptances
     SET status     = 'disputed',
         updated_at = (extract(epoch FROM now()) * 1000)::bigint
   WHERE job_id = v_job_id AND status = 'pending';

  SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."operator_resolve_dispute_split"("p_dispute_id" "uuid", "p_split_ratio" numeric, "p_note" "text", "p_provider_award_amount" numeric, "p_customer_refund_amount" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."party_submit_dispute_statement"("p_dispute_id" "uuid", "p_evidence" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid          uuid := auth.uid();
  v_status       text;
  v_job_id       uuid;
  v_is_customer  boolean := false;
  v_is_provider  boolean := false;
  v_role         text;
  v_now          timestamptz := now();
  v_evidence     jsonb;
  v_result       jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthorized: authentication required'
      USING ERRCODE = '42501';
  END IF;

  IF p_evidence IS NULL OR jsonb_typeof(p_evidence) <> 'object' THEN
    RAISE EXCEPTION 'invalid_evidence: p_evidence must be a jsonb object'
      USING ERRCODE = '22023';
  END IF;

  IF COALESCE(btrim(p_evidence->>'description'), '') = '' THEN
    RAISE EXCEPTION 'invalid_evidence: description must not be empty'
      USING ERRCODE = '22023';
  END IF;

  SELECT d.status, d.job_id
    INTO v_status, v_job_id
    FROM public.disputes d
   WHERE d.id = p_dispute_id
   FOR UPDATE;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Party resolution (mirrors open_dispute_atomic; provider side is
  -- OWNER-only per N3a — team_members are deliberately NOT accepted).
  SELECT EXISTS (
    SELECT 1 FROM public.jobs j
    WHERE j.id = v_job_id
      AND (j.customer_user_id = v_uid OR j.customer_profile_id = v_uid)
  ) INTO v_is_customer;

  SELECT EXISTS (
    SELECT 1 FROM public.jobs j
    WHERE j.id = v_job_id
      AND (
        j.craftsman_user_id = v_uid::text
        OR j.provider_id IN (
          SELECT pr.id FROM public.providers pr WHERE pr.profile_id = v_uid
        )
      )
  ) INTO v_is_provider;

  -- Idempotent retry guard (timeout-after-commit): the exact same evidence
  -- object (same client-generated id) already landed and the status already
  -- flipped -> return current row, NO second append. A NEW statement at
  -- under_review still errors below (no multi-submit semantics change).
  IF v_status = 'under_review'
     AND COALESCE(p_evidence->>'id', '') <> ''
     AND (v_is_customer OR v_is_provider)
     AND EXISTS (
       SELECT 1 FROM public.disputes d2
       WHERE d2.id = p_dispute_id
         AND COALESCE(d2.metadata->'evidence', '[]'::jsonb)
             @> jsonb_build_array(jsonb_build_object('id', p_evidence->>'id'))
     )
  THEN
    SELECT row_to_json(d)::jsonb INTO v_result
      FROM public.disputes d WHERE d.id = p_dispute_id;
    RETURN v_result;
  END IF;

  IF v_status NOT IN ('customer_waiting', 'provider_waiting') THEN
    RAISE EXCEPTION 'dispute_not_awaiting_response: status is %, statement requires customer_waiting or provider_waiting',
      v_status USING ERRCODE = 'P0001';
  END IF;

  -- Ownership gate: ONLY the party whose statement is pending.
  IF v_status = 'customer_waiting' THEN
    IF NOT COALESCE(v_is_customer, false) THEN
      RAISE EXCEPTION 'unauthorized: caller is not the responding customer for dispute %', p_dispute_id
        USING ERRCODE = '42501';
    END IF;
    v_role := 'customer';
  ELSE
    IF NOT COALESCE(v_is_provider, false) THEN
      RAISE EXCEPTION 'unauthorized: caller is not the responding provider owner for dispute %', p_dispute_id
        USING ERRCODE = '42501';
    END IF;
    v_role := 'provider';
  END IF;

  -- Server-side authorship: client cannot spoof submittedBy / row linkage.
  v_evidence := p_evidence || jsonb_build_object(
    'submittedBy', v_uid::text,
    'disputeId',   p_dispute_id::text,
    'jobId',       v_job_id::text
  );

  -- Arm the trigger sentinel: transaction-local (is_local = true), evaporates
  -- at COMMIT/ROLLBACK, never leaks into pooled connections.
  PERFORM set_config('fixup.dispute_party_transition', 'allow', true);

  UPDATE public.disputes
     SET status   = 'under_review',
         metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb),
           '{evidence}',
           COALESCE(metadata->'evidence', '[]'::jsonb) || v_evidence
         ),
         updated_at = v_now
   WHERE id = p_dispute_id;

  -- Disarm immediately after the guarded write (defense-in-depth within tx).
  PERFORM set_config('fixup.dispute_party_transition', '', true);

  UPDATE public.jobs
     SET dispute_status = 'under_review'
   WHERE id = v_job_id;

  INSERT INTO public.dispute_status_history (
    dispute_id, job_id, previous_status, next_status, source, note, metadata, created_at
  ) VALUES (
    p_dispute_id, v_job_id, v_status, 'under_review', 'client', NULL,
    jsonb_build_object(
      'via',              'party_submit_dispute_statement',
      'actor_profile_id', v_uid,
      'role',             v_role
    ),
    v_now
  );

  SELECT row_to_json(d)::jsonb INTO v_result
    FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."party_submit_dispute_statement"("p_dispute_id" "uuid", "p_evidence" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."propose_split_atomic"("p_dispute_id" "uuid", "p_ratio" numeric) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid               uuid        := auth.uid();
  v_dispute_status    text;
  v_decision          text;
  v_customer_pid      uuid;
  v_provider_id       uuid;
  v_job_id            uuid;
  v_is_customer       boolean     := false;
  v_is_provider       boolean     := false;
  v_is_party          boolean     := false;
  v_next_round        smallint;
  v_new_id            uuid;
  v_new_row           jsonb;
  v_now               timestamptz := now();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;

  IF p_ratio IS NULL OR p_ratio <= 0 OR p_ratio >= 1 THEN
    RAISE EXCEPTION 'invalid_split_ratio: must be strictly between 0 and 1, got %', p_ratio
      USING ERRCODE = 'P0001';
  END IF;

  SELECT d.status, d.decision, d.customer_profile_id, d.provider_id, d.job_id
    INTO v_dispute_status, v_decision, v_customer_pid, v_provider_id, v_job_id
    FROM public.disputes d
   WHERE d.id = p_dispute_id
   FOR UPDATE;

  IF v_job_id IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id USING ERRCODE = 'P0002';
  END IF;

  IF v_customer_pid IS NOT NULL AND v_customer_pid = v_uid THEN
    v_is_customer := true;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.jobs j
    WHERE j.id = v_job_id
      AND (
        j.craftsman_user_id = v_uid::text
        OR (v_provider_id IS NOT NULL AND j.provider_id IN (
          SELECT pr.id FROM public.providers pr WHERE pr.profile_id = v_uid
        ))
      )
  ) INTO v_is_provider;

  v_is_party := v_is_customer OR v_is_provider;

  IF NOT v_is_party THEN
    RAISE EXCEPTION 'unauthorized: caller is not a party to dispute %', p_dispute_id
      USING ERRCODE = '42501';
  END IF;

  IF v_dispute_status NOT IN ('open','under_review','customer_waiting','provider_waiting') THEN
    RAISE EXCEPTION 'dispute_not_active: cannot propose split in status %, decision %',
      v_dispute_status, COALESCE(v_decision, 'none')
      USING ERRCODE = 'P0001';
  END IF;

  SELECT (COALESCE(MAX(dsp.proposal_round), 0) + 1)::smallint
    INTO v_next_round
    FROM public.dispute_split_proposals dsp
   WHERE dsp.dispute_id = p_dispute_id;

  IF v_next_round > 10 THEN
    RAISE EXCEPTION 'split_proposal_cap_reached: dispute % has reached the maximum of 10 proposal rounds',
      p_dispute_id USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.dispute_split_proposals
     SET status     = 'superseded',
         updated_at = v_now
   WHERE dispute_id = p_dispute_id
     AND status     = 'pending';

  INSERT INTO public.dispute_split_proposals (
    dispute_id, job_id, proposed_by, proposed_ratio,
    status, proposal_round, created_at, updated_at
  ) VALUES (
    p_dispute_id, v_job_id, v_uid, p_ratio,
    'pending', v_next_round, v_now, v_now
  )
  RETURNING id INTO v_new_id;

  SELECT row_to_json(dsp)::jsonb INTO v_new_row
    FROM public.dispute_split_proposals dsp
   WHERE dsp.id = v_new_id;

  RETURN v_new_row;
END;
$$;


ALTER FUNCTION "public"."propose_split_atomic"("p_dispute_id" "uuid", "p_ratio" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."provider_is_public"("p_provider_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.providers
    WHERE id = p_provider_id AND is_public = true
  );
$$;


ALTER FUNCTION "public"."provider_is_public"("p_provider_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."provider_is_public"("p_provider_id" "uuid") IS 'SECURITY DEFINER helper for provider_media public-read RLS. Returns true when the providers row exists and has is_public=true. Bypasses the caller-side RLS gap on providers introduced by the 7.1G PII lockdown. Used exclusively by the "Public can read provider media" policy.';



CREATE OR REPLACE FUNCTION "public"."provider_presales_projects_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."provider_presales_projects_set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reactivate_team_member"("p_member_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller_uid  uuid := "auth"."uid"();
  v_old_row     RECORD;
BEGIN
  IF v_caller_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Nicht eingeloggt.', 'code', 'unauthenticated');
  END IF;

  SELECT tm.* INTO v_old_row FROM "team_members" tm WHERE tm."id" = p_member_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Mitarbeiter nicht gefunden.', 'code', 'not_found');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "team_members" tm2
    WHERE tm2."provider_id" = v_old_row."provider_id"
      AND tm2."profile_id"  = v_caller_uid
      AND tm2."role"        = 'owner'
      AND tm2."is_active"   = true
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Nur der Inhaber darf Mitarbeiter reaktivieren.', 'code', 'rbac_owner_required');
  END IF;

  IF v_old_row."is_active" = true THEN
    RETURN jsonb_build_object('ok', true, 'noop', true);
  END IF;

  UPDATE "team_members"
     SET "is_active"  = true,
         "updated_at" = now()
   WHERE "id" = p_member_id;

  INSERT INTO "team_member_audit" (
    "provider_id", "member_id", "actor_id", "action", "old_values", "new_values"
  ) VALUES (
    v_old_row."provider_id",
    p_member_id,
    v_caller_uid,
    'reactivate',
    jsonb_build_object('is_active', false),
    jsonb_build_object('is_active', true)
  );

  RETURN jsonb_build_object('ok', true);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', 'Reaktivierung fehlgeschlagen.', 'code', 'unknown');
END;
$$;


ALTER FUNCTION "public"."reactivate_team_member"("p_member_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reassign_job_member"("p_job_id" "uuid", "p_from" "text", "p_to" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_provider_id uuid;
  v_assigned    jsonb;
  v_next        jsonb;
  v_result      jsonb;
  v_caller_uid  uuid;
  v_to_member   uuid;
begin
  v_caller_uid := auth.uid();
  if v_caller_uid is null then
    raise exception 'rbac_no_session' using errcode = '42501';
  end if;

  select provider_id, assigned_member_ids
    into v_provider_id, v_assigned
    from public.jobs
    where id = p_job_id
    for update;

  if v_provider_id is null then
    raise exception 'job_not_found' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.providers
    where id = v_provider_id and profile_id = v_caller_uid
  ) then
    raise exception 'rbac_owner_required' using errcode = '42501';
  end if;

  if v_assigned ? p_to then
    if v_assigned ? p_from then
      v_next := v_assigned - p_from;
    else
      v_next := v_assigned;
    end if;
  elsif v_assigned ? p_from then
    v_next := (v_assigned - p_from) || jsonb_build_array(p_to);
  else
    v_next := coalesce(v_assigned, '[]'::jsonb) || jsonb_build_array(p_to);
  end if;

  update public.jobs
    set assigned_member_ids = v_next,
        updated_at = now()
    where id = p_job_id
    returning to_jsonb(jobs.*) into v_result;

  begin
    v_to_member := p_to::uuid;
  exception when others then
    return v_result;
  end;

  insert into public.team_member_audit (provider_id, member_id, actor_id, action, old_values, new_values)
  values (
    v_provider_id,
    v_to_member,
    v_caller_uid,
    'springer_reassigned',
    jsonb_build_object('jobId', p_job_id, 'fromMemberId', p_from),
    jsonb_build_object('jobId', p_job_id, 'toMemberId', p_to)
  );

  return v_result;
end;
$$;


ALTER FUNCTION "public"."reassign_job_member"("p_job_id" "uuid", "p_from" "text", "p_to" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."reassign_job_member"("p_job_id" "uuid", "p_from" "text", "p_to" "text") IS 'Atomic member reassignment for the Owner-driven Springer flow + audit row. SECURITY DEFINER so the audit INSERT lands; Owner identity is verified via auth.uid() before any writes. Idempotent: re-running after partial failure converges.';



CREATE OR REPLACE FUNCTION "public"."reconcile_transfer_reversal_atomic"("p_tranche_id" "uuid", "p_plan_id" "uuid", "p_reversal_ref" "text", "p_reversed_at" timestamp with time zone DEFAULT "now"()) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_existing_reversal_ref text;
  v_plan_status           text;
  v_tranche_count         int;
  v_released_count        int;
BEGIN
  SELECT transfer_reversal_ref
  INTO v_existing_reversal_ref
  FROM escrow_tranches
  WHERE id = p_tranche_id AND plan_id = p_plan_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  IF v_existing_reversal_ref IS NOT DISTINCT FROM p_reversal_ref THEN
    RETURN jsonb_build_object('outcome', 'already_recorded');
  END IF;

  UPDATE escrow_tranches
  SET
    transfer_reversal_ref = p_reversal_ref,
    updated_at            = p_reversed_at
  WHERE id = p_tranche_id
    AND plan_id = p_plan_id;

  -- Recompute plan status: reversed tranches do not count as released.
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE status = 'released' AND transfer_reversal_ref IS NULL)
  INTO v_tranche_count, v_released_count
  FROM escrow_tranches
  WHERE plan_id = p_plan_id;

  IF v_tranche_count > 0 AND v_tranche_count = v_released_count THEN
    v_plan_status := 'fully_released';
  ELSIF v_released_count > 0 THEN
    v_plan_status := 'partially_released';
  ELSE
    v_plan_status := 'funded_in_escrow';
  END IF;

  UPDATE escrow_payment_plans
  SET
    status     = v_plan_status,
    updated_at = now()
  WHERE id = p_plan_id;

  RETURN jsonb_build_object(
    'outcome',        'reversed',
    'plan_status',    v_plan_status,
    'tranche_count',  v_tranche_count,
    'released_count', v_released_count
  );
END;
$$;


ALTER FUNCTION "public"."reconcile_transfer_reversal_atomic"("p_tranche_id" "uuid", "p_plan_id" "uuid", "p_reversal_ref" "text", "p_reversed_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_push_action_attempt"("p_notification_id" "uuid", "p_action_id" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_uid       uuid := auth.uid();
  v_inserted  int;
begin
  if v_uid is null then
    return false;
  end if;
  if p_notification_id is null then
    return false;
  end if;
  if p_action_id is null or p_action_id not in ('APPROVE', 'REJECT') then
    return false;
  end if;

  insert into public.push_action_audit (notification_id, action_id, user_id)
  values (p_notification_id, p_action_id, v_uid)
  on conflict (notification_id, action_id) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted = 1;

exception when others then
  return false;
end;
$$;


ALTER FUNCTION "public"."record_push_action_attempt"("p_notification_id" "uuid", "p_action_id" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."record_push_action_attempt"("p_notification_id" "uuid", "p_action_id" "text") IS 'Block A · atomically records a push-inline-action tap attempt. Returns true on first insert (caller continues), false on duplicate / missing auth / invalid action_id (caller aborts). Used by pushNotificationBridge.handlePushActionTap as a persistent idempotency layer above the in-memory 5 s window — protects against re-tap from Notification Center after app-kill.';



CREATE TABLE IF NOT EXISTS "public"."scan_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "scan_id" "uuid" NOT NULL,
    "actor_id" "uuid",
    "action" "public"."scan_event_action" NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "idempotency_key" "uuid"
);


ALTER TABLE "public"."scan_events" OWNER TO "postgres";


COMMENT ON TABLE "public"."scan_events" IS 'Spatial Core: append-only audit log. Writes only via SECURITY DEFINER RPCs.';



COMMENT ON COLUMN "public"."scan_events"."idempotency_key" IS 'Optional client-supplied UUID for retry-safety on record_scan_event RPC. Partial unique with scan_id.';



CREATE OR REPLACE FUNCTION "public"."record_scan_event"("p_scan_id" "uuid", "p_action" "public"."scan_event_action", "p_payload" "jsonb" DEFAULT '{}'::"jsonb", "p_idempotency_key" "uuid" DEFAULT NULL::"uuid") RETURNS "public"."scan_events"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
DECLARE
  v_actor   uuid := auth.uid();
  v_payload jsonb := COALESCE(p_payload, '{}'::jsonb);
  v_row     public.scan_events;
  v_size    int;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'record_scan_event: authentication required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT public.spatial_can_view_scan(p_scan_id, v_actor) THEN
    RAISE EXCEPTION 'record_scan_event: not permitted on scan %', p_scan_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_size := octet_length(v_payload::text);
  IF v_size > 65536 THEN
    RAISE EXCEPTION 'record_scan_event: payload too large (% bytes, max 65536)', v_size
      USING ERRCODE = 'program_limit_exceeded',
            HINT    = 'Store large blobs in scan_assets and reference by storage_path in payload.';
  END IF;

  INSERT INTO public.scan_events (scan_id, actor_id, action, payload, idempotency_key)
  VALUES (p_scan_id, v_actor, p_action, v_payload, p_idempotency_key)
  ON CONFLICT (scan_id, idempotency_key) DO NOTHING
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    SELECT * INTO v_row
    FROM public.scan_events
    WHERE scan_id = p_scan_id
      AND idempotency_key = p_idempotency_key
    ORDER BY at ASC
    LIMIT 1;
  END IF;

  RETURN v_row;
END;
$$;


ALTER FUNCTION "public"."record_scan_event"("p_scan_id" "uuid", "p_action" "public"."scan_event_action", "p_payload" "jsonb", "p_idempotency_key" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."record_scan_event"("p_scan_id" "uuid", "p_action" "public"."scan_event_action", "p_payload" "jsonb", "p_idempotency_key" "uuid") IS 'Spatial Core: append a scan audit event (RLS-bypassing via SECURITY DEFINER, but inner spatial_can_view_scan gate enforces authorization). Idempotent on (scan_id, idempotency_key). 64 KiB payload cap.';



CREATE OR REPLACE FUNCTION "public"."reject_split_proposal"("p_proposal_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid          uuid        := auth.uid();
  v_dispute_id   uuid;
  v_job_id       uuid;
  v_proposed_by  uuid;
  v_customer_pid uuid;
  v_provider_id  uuid;
  v_is_customer  boolean     := false;
  v_is_provider  boolean     := false;
  v_is_party     boolean     := false;
  v_now          timestamptz := now();
  v_result       jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;

  SELECT dsp.dispute_id, dsp.job_id, dsp.proposed_by
    INTO v_dispute_id, v_job_id, v_proposed_by
    FROM public.dispute_split_proposals dsp
   WHERE dsp.id = p_proposal_id
     AND dsp.status = 'pending'
   FOR UPDATE;

  IF v_dispute_id IS NULL THEN
    RAISE EXCEPTION 'proposal_not_found_or_not_pending: %', p_proposal_id USING ERRCODE = 'P0002';
  END IF;

  IF v_uid = v_proposed_by THEN
    RAISE EXCEPTION 'proposer_cannot_reject_own_proposal: caller % proposed this split; the other party must reject',
      v_uid USING ERRCODE = '42501';
  END IF;

  SELECT d.customer_profile_id, d.provider_id
    INTO v_customer_pid, v_provider_id
    FROM public.disputes d
   WHERE d.id = v_dispute_id;

  IF v_customer_pid IS NOT NULL AND v_customer_pid = v_uid THEN
    v_is_customer := true;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.jobs j
    WHERE j.id = v_job_id
      AND (
        j.craftsman_user_id = v_uid::text
        OR (v_provider_id IS NOT NULL AND j.provider_id IN (
          SELECT pr.id FROM public.providers pr WHERE pr.profile_id = v_uid
        ))
      )
  ) INTO v_is_provider;

  v_is_party := v_is_customer OR v_is_provider;

  IF NOT v_is_party THEN
    RAISE EXCEPTION 'unauthorized: caller is not a party to dispute %', v_dispute_id
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.dispute_split_proposals
     SET status     = 'rejected',
         updated_at = v_now
   WHERE id = p_proposal_id;

  SELECT row_to_json(dsp)::jsonb INTO v_result
    FROM public.dispute_split_proposals dsp
   WHERE dsp.id = p_proposal_id;

  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."reject_split_proposal"("p_proposal_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."release_tranche_atomic"("p_tranche_id" "uuid", "p_plan_id" "uuid", "p_transfer_id" "text", "p_actor" "text", "p_released_at" timestamp with time zone DEFAULT "now"()) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_existing_ref   text;
  v_plan_status    text;
  v_tranche_count  int;
  v_released_count int;
BEGIN
  -- Read the current external_release_ref to detect already-idempotent calls.
  SELECT external_release_ref
  INTO v_existing_ref
  FROM escrow_tranches
  WHERE id = p_tranche_id AND plan_id = p_plan_id
  FOR UPDATE;  -- Row lock: prevents concurrent releases of the same tranche.

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  -- If this exact transfer ID is already recorded, the write is fully idempotent.
  -- Still recompute and update the plan status in case that write was missed.
  IF v_existing_ref IS DISTINCT FROM p_transfer_id THEN
    UPDATE escrow_tranches
    SET
      status               = 'released',
      released_at          = p_released_at,
      released_by          = p_actor,
      external_release_ref = p_transfer_id,
      updated_at           = now()
    WHERE id = p_tranche_id
      AND plan_id = p_plan_id;
  END IF;

  -- Read all tranches for the plan within the same transaction.
  -- Sees the updated state of the row above.
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE status = 'released')
  INTO v_tranche_count, v_released_count
  FROM escrow_tranches
  WHERE plan_id = p_plan_id;

  IF v_tranche_count > 0 AND v_tranche_count = v_released_count THEN
    v_plan_status := 'fully_released';
  ELSIF v_released_count > 0 THEN
    v_plan_status := 'partially_released';
  ELSE
    v_plan_status := 'funded_in_escrow';
  END IF;

  UPDATE escrow_payment_plans
  SET
    status     = v_plan_status,
    updated_at = now()
  WHERE id = p_plan_id;

  RETURN jsonb_build_object(
    'outcome',        CASE WHEN v_existing_ref IS NOT DISTINCT FROM p_transfer_id THEN 'already_recorded' ELSE 'released' END,
    'plan_status',    v_plan_status,
    'tranche_count',  v_tranche_count,
    'released_count', v_released_count
  );
END;
$$;


ALTER FUNCTION "public"."release_tranche_atomic"("p_tranche_id" "uuid", "p_plan_id" "uuid", "p_transfer_id" "text", "p_actor" "text", "p_released_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."release_tranche_with_ledger"("p_tranche_id" "text", "p_plan_id" "text", "p_transfer_id" "text", "p_actor" "text", "p_released_at" timestamp with time zone, "p_net_amount" numeric, "p_currency" "text" DEFAULT 'EUR'::"text", "p_payment_id" "text" DEFAULT NULL::"text", "p_job_id" "text" DEFAULT NULL::"text", "p_ledger_entry_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_tranche          RECORD;
  v_total            bigint;
  v_released_count   bigint;
  v_plan_status      text;
  v_outcome          text;
  v_is_payout        boolean;
BEGIN
  SELECT id, status, external_release_ref, external_payout_ref, kind
  INTO v_tranche
  FROM escrow_tranches
  WHERE id = p_tranche_id::uuid
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'outcome',          'not_found',
      'plan_status',      null,
      'total_tranches',   0,
      'released_tranches',0
    );
  END IF;

  v_is_payout := (p_transfer_id LIKE 'po\_%' ESCAPE '\');

  IF v_is_payout THEN
    IF v_tranche.external_payout_ref IS NOT NULL
       AND v_tranche.external_payout_ref = p_transfer_id
    THEN
      SELECT COUNT(*) INTO v_total
      FROM escrow_tranches WHERE plan_id = p_plan_id::uuid;
      SELECT COUNT(*) INTO v_released_count
      FROM escrow_tranches WHERE plan_id = p_plan_id::uuid AND status = 'released';
      RETURN jsonb_build_object(
        'outcome',           'already_recorded',
        'plan_status',       (SELECT status FROM escrow_payment_plans WHERE id = p_plan_id::uuid),
        'total_tranches',    v_total,
        'released_tranches', v_released_count
      );
    END IF;

    UPDATE escrow_tranches
    SET
      status              = 'release_pending',
      external_payout_ref = p_transfer_id,
      released_by         = p_actor,
      released_at         = p_released_at,
      updated_at          = now()
    WHERE id = p_tranche_id::uuid;

    v_outcome := 'release_pending';

    IF p_payment_id IS NOT NULL AND p_ledger_entry_id IS NOT NULL THEN
      INSERT INTO ledger_entries (
        payment_id, job_id, entry_type, amount, currency, metadata, movement_ref
      )
      VALUES (
        p_payment_id::uuid,
        COALESCE(
          NULLIF(p_job_id, '')::uuid,
          (SELECT job_id FROM escrow_payment_plans WHERE id = p_plan_id::uuid)
        ),
        'payout',
        p_net_amount,
        p_currency,
        jsonb_build_object(
          'note',       'Tranche released via Stripe payout ' || p_transfer_id,
          'payout_id',  p_transfer_id,
          'actor',      p_actor,
          'tranche_id', p_tranche_id
        ),
        p_tranche_id
      )
      ON CONFLICT (payment_id, entry_type, movement_ref) DO NOTHING;
    END IF;

    SELECT COUNT(*) INTO v_total
    FROM escrow_tranches WHERE plan_id = p_plan_id::uuid;
    SELECT COUNT(*) INTO v_released_count
    FROM escrow_tranches
    WHERE plan_id = p_plan_id::uuid
      AND status = 'released'
      AND transfer_reversal_ref IS NULL;

    RETURN jsonb_build_object(
      'outcome',           v_outcome,
      'plan_status',       (SELECT status FROM escrow_payment_plans WHERE id = p_plan_id::uuid),
      'total_tranches',    v_total,
      'released_tranches', v_released_count
    );
  END IF;

  IF v_tranche.external_release_ref IS NOT NULL
     AND v_tranche.external_release_ref = p_transfer_id
  THEN
    SELECT COUNT(*) INTO v_total
    FROM escrow_tranches WHERE plan_id = p_plan_id::uuid;
    SELECT COUNT(*) INTO v_released_count
    FROM escrow_tranches WHERE plan_id = p_plan_id::uuid AND status = 'released';
    RETURN jsonb_build_object(
      'outcome',           'already_recorded',
      'plan_status',       (SELECT status FROM escrow_payment_plans WHERE id = p_plan_id::uuid),
      'total_tranches',    v_total,
      'released_tranches', v_released_count
    );
  END IF;

  UPDATE escrow_tranches
  SET
    status               = 'released',
    external_release_ref = p_transfer_id,
    released_by          = p_actor,
    released_at          = p_released_at,
    updated_at           = now()
  WHERE id = p_tranche_id::uuid;

  v_outcome := 'released';

  SELECT COUNT(*) INTO v_total
  FROM escrow_tranches WHERE plan_id = p_plan_id::uuid;

  SELECT COUNT(*) INTO v_released_count
  FROM escrow_tranches
  WHERE plan_id = p_plan_id::uuid
    AND status = 'released'
    AND transfer_reversal_ref IS NULL;

  v_plan_status := CASE
    WHEN v_released_count >= v_total THEN 'fully_released'
    WHEN v_released_count > 0        THEN 'partially_released'
    ELSE                                  'funded_in_escrow'
  END;

  UPDATE escrow_payment_plans
  SET status = v_plan_status, updated_at = now()
  WHERE id = p_plan_id::uuid;

  IF p_payment_id IS NOT NULL AND p_ledger_entry_id IS NOT NULL THEN
    INSERT INTO ledger_entries (
      payment_id, job_id, entry_type, amount, currency, metadata, movement_ref
    )
    VALUES (
      p_payment_id::uuid,
      COALESCE(
        NULLIF(p_job_id, '')::uuid,
        (SELECT job_id FROM escrow_payment_plans WHERE id = p_plan_id::uuid)
      ),
      'payout',
      p_net_amount,
      p_currency,
      jsonb_build_object(
        'note',        'Tranche released via Stripe transfer ' || p_transfer_id,
        'transfer_id', p_transfer_id,
        'actor',       p_actor,
        'tranche_id',  p_tranche_id
      ),
      p_tranche_id
    )
    ON CONFLICT (payment_id, entry_type, movement_ref) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'outcome',           v_outcome,
    'plan_status',       v_plan_status,
    'total_tranches',    v_total,
    'released_tranches', v_released_count
  );
END;
$$;


ALTER FUNCTION "public"."release_tranche_with_ledger"("p_tranche_id" "text", "p_plan_id" "text", "p_transfer_id" "text", "p_actor" "text", "p_released_at" timestamp with time zone, "p_net_amount" numeric, "p_currency" "text", "p_payment_id" "text", "p_job_id" "text", "p_ledger_entry_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."request_scan_download"("p_scan_id" "uuid", "p_kind" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id  uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '28000';
  END IF;
  IF NOT public.spatial_can_view_scan(p_scan_id, v_uid) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('pdf_report','floorplan_svg','mesh_summary_json') THEN
    RAISE EXCEPTION 'invalid download kind: %', p_kind USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.download_jobs (scan_id, requested_by, kind)
  VALUES (p_scan_id, v_uid, p_kind)
  RETURNING id INTO v_id;
  PERFORM pg_notify('download_jobs', v_id::text);
  PERFORM public.record_scan_event(
    p_scan_id,
    'download_requested'::public.scan_event_action,
    jsonb_build_object('download_job_id', v_id, 'kind', p_kind),
    NULL
  );
  RETURN v_id;
END;
$$;


ALTER FUNCTION "public"."request_scan_download"("p_scan_id" "uuid", "p_kind" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."download_jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "scan_id" "uuid" NOT NULL,
    "requested_by" "uuid" NOT NULL,
    "kind" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "storage_path" "text",
    "expires_at" timestamp with time zone,
    "error_message" "text",
    "requested_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    CONSTRAINT "download_jobs_kind_check" CHECK (("kind" = ANY (ARRAY['pdf_report'::"text", 'floorplan_svg'::"text", 'mesh_summary_json'::"text"]))),
    CONSTRAINT "download_jobs_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'processing'::"text", 'ready'::"text", 'failed'::"text"]))),
    CONSTRAINT "download_jobs_storage_path_chk" CHECK ((("storage_path" IS NULL) OR (("storage_path" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/export/'::"text") AND (POSITION(('..'::"text") IN ("storage_path")) = 0))))
);


ALTER TABLE "public"."download_jobs" OWNER TO "postgres";


COMMENT ON TABLE "public"."download_jobs" IS 'Block I — async download artefacts (PDF / SVG / JSON) per scan. INSERT via request_scan_download() RPC only.';



CREATE OR REPLACE FUNCTION "public"."resign_download_url"("p_job_id" "uuid") RETURNS "public"."download_jobs"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_job public.download_jobs;
  v_recent_count int;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_job
  FROM public.download_jobs
  WHERE id = p_job_id AND requested_by = v_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT count(*) INTO v_recent_count
  FROM public.scan_events
  WHERE scan_id = v_job.scan_id
    AND action  = 'download_requested'::public.scan_event_action
    AND actor_id = v_uid
    AND occurred_at > now() - interval '1 hour'
    AND payload ->> 'phase' = 'resign'
    AND (payload ->> 'download_job_id')::uuid = p_job_id;
  IF v_recent_count >= 5 THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = '54000';
  END IF;
  UPDATE public.download_jobs
  SET expires_at = now() + interval '15 minutes'
  WHERE id = p_job_id
  RETURNING * INTO v_job;
  PERFORM public.record_scan_event(
    v_job.scan_id,
    'download_requested'::public.scan_event_action,
    jsonb_build_object('phase', 'resign', 'download_job_id', p_job_id),
    NULL
  );
  RETURN v_job;
END;
$$;


ALTER FUNCTION "public"."resign_download_url"("p_job_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rotate_company_code"("p_provider_id" "uuid", "p_reason" "text" DEFAULT NULL::"text") RETURNS TABLE("new_code" "text", "new_code_id" "uuid")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller_uid uuid := auth.uid();
  v_role text;
  v_old_code_id uuid;
  v_new_code text;
  v_new_code_id uuid;
  v_recent_count int;
BEGIN
  IF v_caller_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;

  SELECT tm.role INTO v_role
  FROM public.team_members tm
  WHERE tm.provider_id = p_provider_id
    AND tm.profile_id = v_caller_uid;

  IF v_role IS NULL OR v_role <> 'owner' THEN
    RAISE EXCEPTION 'rbac_owner_required' USING ERRCODE = '28000';
  END IF;

  SELECT count(*) INTO v_recent_count
  FROM public.company_code_audit
  WHERE provider_id = p_provider_id
    AND rotated_at > now() - interval '24 hours';

  IF v_recent_count >= 5 THEN
    RAISE EXCEPTION 'rate_limit_exceeded' USING ERRCODE = '53400';
  END IF;

  SELECT id INTO v_old_code_id
  FROM public.company_join_codes
  WHERE provider_id = p_provider_id AND status = 'active'
  FOR UPDATE;

  IF v_old_code_id IS NULL THEN
    RAISE EXCEPTION 'no_active_code';
  END IF;

  v_new_code := public.generate_unique_company_code();

  UPDATE public.company_join_codes
  SET status = 'rotated',
      rotated_at = now(),
      rotated_by = v_caller_uid,
      updated_at = now()
  WHERE id = v_old_code_id;

  INSERT INTO public.company_join_codes (provider_id, code, target_role, status)
  VALUES (p_provider_id, v_new_code, 'worker', 'active')
  RETURNING id INTO v_new_code_id;

  UPDATE public.company_join_codes
  SET replaced_by = v_new_code_id
  WHERE id = v_old_code_id;

  INSERT INTO public.company_code_audit (provider_id, old_code_id, new_code_id, rotated_by, reason)
  VALUES (p_provider_id, v_old_code_id, v_new_code_id, v_caller_uid, p_reason);

  RETURN QUERY SELECT v_new_code, v_new_code_id;
END;
$$;


ALTER FUNCTION "public"."rotate_company_code"("p_provider_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rpc_enqueue_thread_migration"("p_legacy_thread_id" "text", "p_legacy_source" "text", "p_priority" integer DEFAULT 100) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid uuid;
  v_thread_id uuid;
  v_status text;
  v_secret text;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'access_denied: no auth session' USING ERRCODE = 'P0001';
  END IF;
  IF p_legacy_source NOT IN ('conversations', 'message_threads') THEN
    RAISE EXCEPTION 'invalid_argument: legacy_source must be conversations|message_threads' USING ERRCODE = 'P0001';
  END IF;

  IF p_legacy_source = 'conversations' THEN
    PERFORM 1 FROM public.conversations
      WHERE id::text = p_legacy_thread_id
        AND (customer_user_id = v_uid OR craftsman_user_id = v_uid);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'access_denied: not a participant of conversation' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    PERFORM 1
      FROM public.message_threads mt
      JOIN public.message_thread_participants mtp ON mtp.thread_id = mt.id
      JOIN public.team_members tm ON tm.id::text = mtp.team_member_id
      WHERE mt.id::text = p_legacy_thread_id
        AND tm.profile_id = v_uid
        AND tm.is_active = true
        AND mtp.is_active = true;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'access_denied: not an active participant of message_thread' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT thread_id, status INTO v_thread_id, v_status
  FROM public.chat_thread_migration_status
  WHERE legacy_thread_id = p_legacy_thread_id AND legacy_source = p_legacy_source;

  IF v_thread_id IS NOT NULL AND v_status IN ('migration_complete', 'migration_verified') THEN
    RETURN;
  END IF;

  IF v_thread_id IS NULL THEN
    SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
    WHERE name = 'account_cascade_cleanup.shared_secret'
    LIMIT 1;

    PERFORM net.http_post(
      url := 'https://itdntawwuzqfwmcwnwjr.supabase.co/functions/v1/chat-thread-migrator',
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-fixup-trigger-secret', v_secret
      ),
      body := jsonb_build_object(
        'mode', 'lazy',
        'legacyThreadId', p_legacy_thread_id,
        'legacySource', p_legacy_source,
        'priority', p_priority
      )
    );
    RETURN;
  END IF;

  UPDATE public.chat_thread_migration_status
    SET status = 'migration_queued',
        priority = GREATEST(priority, p_priority),
        lock_owner = NULL,
        lock_until = NULL,
        updated_at = public.epoch_ms()
    WHERE thread_id = v_thread_id
      AND status IN ('not_migrated', 'migration_failed', 'migration_queued');
END;
$$;


ALTER FUNCTION "public"."rpc_enqueue_thread_migration"("p_legacy_thread_id" "text", "p_legacy_source" "text", "p_priority" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rpc_get_or_create_chat_assignment_thread"("p_calendar_entry_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller record;
  v_thread_id uuid;
  v_calendar_provider_id uuid;
  v_assigned_member_ids text[];
BEGIN
  SELECT * INTO v_caller FROM public.fn_resolve_provider_for_caller();
  IF v_caller.team_member_id IS NULL THEN
    RAISE EXCEPTION 'access_denied: caller has no team_member row' USING ERRCODE = 'P0001';
  END IF;

  SELECT provider_id, assigned_member_ids
    INTO v_calendar_provider_id, v_assigned_member_ids
  FROM public.calendar_entries
  WHERE id = p_calendar_entry_id;

  IF v_calendar_provider_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument: calendar_entry % not found', p_calendar_entry_id USING ERRCODE = 'P0001';
  END IF;
  IF v_calendar_provider_id <> v_caller.provider_id THEN
    RAISE EXCEPTION 'access_denied: calendar_entry belongs to different provider' USING ERRCODE = 'P0001';
  END IF;

  IF v_caller.member_role <> 'owner'
     AND NOT (v_caller.team_member_id::text = ANY(COALESCE(v_assigned_member_ids, ARRAY[]::text[]))) THEN
    RAISE EXCEPTION 'access_denied: caller not assigned to this calendar_entry' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_thread_id
  FROM public.chat_threads
  WHERE provider_id = v_caller.provider_id
    AND channel_type = 'assignment'
    AND assignment_calendar_entry_id = p_calendar_entry_id;

  IF v_thread_id IS NULL THEN
    INSERT INTO public.chat_threads (
      channel_type, provider_id, assignment_calendar_entry_id, title
    )
    VALUES (
      'assignment', v_caller.provider_id, p_calendar_entry_id, 'Einsatz'
    )
    ON CONFLICT (provider_id, assignment_calendar_entry_id)
      WHERE channel_type = 'assignment' AND assignment_calendar_entry_id IS NOT NULL
    DO NOTHING
    RETURNING id INTO v_thread_id;

    IF v_thread_id IS NULL THEN
      SELECT id INTO v_thread_id
      FROM public.chat_threads
      WHERE provider_id = v_caller.provider_id
        AND channel_type = 'assignment'
        AND assignment_calendar_entry_id = p_calendar_entry_id;
    END IF;
  END IF;

  INSERT INTO public.chat_participants (thread_id, user_id, role, joined_at)
  SELECT
    v_thread_id,
    tm.profile_id,
    CASE WHEN tm.role = 'owner' THEN 'owner' ELSE 'worker' END,
    public.epoch_ms()
  FROM public.calendar_entries ce
  JOIN public.team_members tm ON tm.id::text = ANY(ce.assigned_member_ids)
  WHERE ce.id = p_calendar_entry_id
    AND tm.profile_id IS NOT NULL
    AND tm.is_active = true
  ON CONFLICT (thread_id, user_id) DO NOTHING;

  INSERT INTO public.chat_participants (thread_id, user_id, role, joined_at)
  VALUES (
    v_thread_id,
    v_caller.profile_id,
    CASE WHEN v_caller.member_role = 'owner' THEN 'owner' ELSE 'worker' END,
    public.epoch_ms()
  )
  ON CONFLICT (thread_id, user_id) DO NOTHING;

  INSERT INTO public.chat_participants (thread_id, user_id, role, joined_at)
  SELECT
    v_thread_id,
    tm.profile_id,
    'owner',
    public.epoch_ms()
  FROM public.team_members tm
  WHERE tm.provider_id = v_caller.provider_id
    AND tm.role = 'owner'
    AND tm.profile_id IS NOT NULL
    AND tm.is_active = true
  ON CONFLICT (thread_id, user_id) DO NOTHING;

  RETURN v_thread_id;
END;
$$;


ALTER FUNCTION "public"."rpc_get_or_create_chat_assignment_thread"("p_calendar_entry_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rpc_get_or_create_chat_customer_thread"("p_craftsman_user_id" "uuid", "p_title" "text" DEFAULT NULL::"text", "p_inquiry_origin" "text" DEFAULT NULL::"text", "p_source_project_id" "text" DEFAULT NULL::"text", "p_inquiry_criteria" "jsonb" DEFAULT NULL::"jsonb", "p_display_metadata" "jsonb" DEFAULT NULL::"jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid uuid;
  v_provider_id uuid;
  v_thread_id uuid;
  v_cooldown_window_ms bigint := 60000;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'access_denied: no auth session' USING ERRCODE = 'P0001';
  END IF;
  IF p_craftsman_user_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument: craftsman_user_id required' USING ERRCODE = 'P0001';
  END IF;
  IF p_craftsman_user_id = v_uid THEN
    RAISE EXCEPTION 'invalid_argument: cannot start customer-thread with self' USING ERRCODE = 'P0001';
  END IF;
  IF p_inquiry_origin IS NOT NULL
     AND p_inquiry_origin NOT IN ('reel','profile','category','project') THEN
    RAISE EXCEPTION 'invalid_argument: unknown inquiry_origin %', p_inquiry_origin USING ERRCODE = 'P0001';
  END IF;

  IF p_inquiry_origin IS NOT NULL THEN
    SELECT id INTO v_thread_id
    FROM public.chat_threads
    WHERE channel_type = 'customer'
      AND customer_user_id = v_uid
      AND craftsman_user_id = p_craftsman_user_id
      AND closed_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_thread_id IS NOT NULL THEN
      UPDATE public.chat_threads
      SET inquiry_origin    = p_inquiry_origin,
          source_project_id = COALESCE(source_project_id, p_source_project_id),
          inquiry_criteria  = COALESCE(inquiry_criteria, p_inquiry_criteria),
          display_metadata  = COALESCE(display_metadata, p_display_metadata),
          updated_at        = public.epoch_ms()
      WHERE id = v_thread_id
        AND inquiry_origin IS NULL;
      RETURN v_thread_id;
    END IF;
  ELSE
    SELECT id INTO v_thread_id
    FROM public.chat_threads
    WHERE channel_type = 'customer'
      AND customer_user_id = v_uid
      AND craftsman_user_id = p_craftsman_user_id
      AND created_at > (public.epoch_ms() - v_cooldown_window_ms)
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_thread_id IS NOT NULL THEN
      RETURN v_thread_id;
    END IF;
  END IF;

  SELECT id INTO v_provider_id
  FROM public.providers
  WHERE profile_id = p_craftsman_user_id;
  IF v_provider_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument: craftsman has no provider profile' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.chat_threads (
    channel_type, customer_user_id, craftsman_user_id, provider_id, title,
    inquiry_origin, source_project_id, inquiry_criteria, display_metadata
  )
  VALUES (
    'customer', v_uid, p_craftsman_user_id, v_provider_id, p_title,
    p_inquiry_origin, p_source_project_id, p_inquiry_criteria, p_display_metadata
  )
  RETURNING id INTO v_thread_id;

  INSERT INTO public.chat_participants (thread_id, user_id, role, joined_at)
  VALUES
    (v_thread_id, v_uid, 'customer', public.epoch_ms()),
    (v_thread_id, p_craftsman_user_id, 'craftsman', public.epoch_ms())
  ON CONFLICT (thread_id, user_id) DO NOTHING;

  RETURN v_thread_id;
END;
$$;


ALTER FUNCTION "public"."rpc_get_or_create_chat_customer_thread"("p_craftsman_user_id" "uuid", "p_title" "text", "p_inquiry_origin" "text", "p_source_project_id" "text", "p_inquiry_criteria" "jsonb", "p_display_metadata" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rpc_get_or_create_chat_dispute_thread"("p_dispute_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid                 uuid;
  v_customer_profile_id uuid;
  v_provider_id         uuid;
  v_thread_id           uuid;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'access_denied: no auth session' USING ERRCODE = 'P0001';
  END IF;

  SELECT customer_profile_id, provider_id
  INTO   v_customer_profile_id, v_provider_id
  FROM   public.disputes
  WHERE  id = p_dispute_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_argument: dispute % not found', p_dispute_id
      USING ERRCODE = 'P0001';
  END IF;

  IF v_uid <> v_customer_profile_id
    AND NOT EXISTS (
      SELECT 1
      FROM   public.team_members tm
      WHERE  tm.provider_id = v_provider_id
        AND  tm.profile_id  = v_uid
        AND  tm.is_active   = true
    )
    AND NOT EXISTS (
      SELECT 1
      FROM   public.profiles p
      WHERE  p.id          = v_uid
        AND  p.is_operator = true
    )
  THEN
    RAISE EXCEPTION 'access_denied: caller is not a party to this dispute'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_thread_id
  FROM   public.chat_threads
  WHERE  dispute_id   = p_dispute_id
    AND  channel_type = 'dispute';

  IF v_thread_id IS NOT NULL THEN
    INSERT INTO public.chat_participants (thread_id, user_id, role, joined_at)
    VALUES (v_thread_id, v_uid, 'customer', public.epoch_ms())
    ON CONFLICT (thread_id, user_id) DO NOTHING;
    RETURN v_thread_id;
  END IF;

  INSERT INTO public.chat_threads (
    channel_type, dispute_id, title, created_at, updated_at
  )
  VALUES (
    'dispute',
    p_dispute_id,
    'Streitfall-Chat',
    public.epoch_ms(),
    public.epoch_ms()
  )
  ON CONFLICT (dispute_id) WHERE channel_type = 'dispute' AND dispute_id IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_thread_id;

  IF v_thread_id IS NULL THEN
    SELECT id INTO v_thread_id
    FROM   public.chat_threads
    WHERE  dispute_id   = p_dispute_id
      AND  channel_type = 'dispute';
  END IF;

  INSERT INTO public.chat_participants (thread_id, user_id, role, joined_at)
  VALUES (v_thread_id, v_customer_profile_id, 'customer', public.epoch_ms())
  ON CONFLICT (thread_id, user_id) DO NOTHING;

  INSERT INTO public.chat_participants (thread_id, user_id, role, joined_at)
  SELECT v_thread_id, tm.profile_id, 'craftsman', public.epoch_ms()
  FROM   public.team_members tm
  WHERE  tm.provider_id = v_provider_id
    AND  tm.role        = 'owner'
    AND  tm.profile_id  IS NOT NULL
    AND  tm.is_active   = true
  ON CONFLICT (thread_id, user_id) DO NOTHING;

  INSERT INTO public.chat_participants (thread_id, user_id, role, joined_at)
  SELECT v_thread_id, p.id, 'admin', public.epoch_ms()
  FROM   public.profiles p
  WHERE  p.is_operator = true
  ON CONFLICT (thread_id, user_id) DO NOTHING;

  RETURN v_thread_id;
END;
$$;


ALTER FUNCTION "public"."rpc_get_or_create_chat_dispute_thread"("p_dispute_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rpc_get_or_create_chat_office_thread"() RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller record;
  v_thread_id uuid;
BEGIN
  SELECT * INTO v_caller FROM public.fn_resolve_provider_for_caller();
  IF v_caller.team_member_id IS NULL THEN
    RAISE EXCEPTION 'access_denied: caller has no team_member row' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_thread_id
  FROM public.chat_threads
  WHERE provider_id = v_caller.provider_id AND channel_type = 'office';

  IF v_thread_id IS NULL THEN
    INSERT INTO public.chat_threads (channel_type, provider_id, title)
    VALUES ('office', v_caller.provider_id, 'Büro')
    ON CONFLICT (provider_id, channel_type) WHERE channel_type IN ('office','team') DO NOTHING
    RETURNING id INTO v_thread_id;

    IF v_thread_id IS NULL THEN
      SELECT id INTO v_thread_id
      FROM public.chat_threads
      WHERE provider_id = v_caller.provider_id AND channel_type = 'office';
    END IF;
  END IF;

  PERFORM public.fn_seed_chat_participants_for_provider(v_thread_id, v_caller.provider_id);
  RETURN v_thread_id;
END;
$$;


ALTER FUNCTION "public"."rpc_get_or_create_chat_office_thread"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rpc_get_or_create_chat_team_thread"() RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller record;
  v_thread_id uuid;
BEGIN
  SELECT * INTO v_caller FROM public.fn_resolve_provider_for_caller();
  IF v_caller.team_member_id IS NULL THEN
    RAISE EXCEPTION 'access_denied: caller has no team_member row' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_thread_id
  FROM public.chat_threads
  WHERE provider_id = v_caller.provider_id AND channel_type = 'team';

  IF v_thread_id IS NULL THEN
    INSERT INTO public.chat_threads (channel_type, provider_id, title)
    VALUES ('team', v_caller.provider_id, 'Team')
    ON CONFLICT (provider_id, channel_type) WHERE channel_type IN ('office','team') DO NOTHING
    RETURNING id INTO v_thread_id;

    IF v_thread_id IS NULL THEN
      SELECT id INTO v_thread_id
      FROM public.chat_threads
      WHERE provider_id = v_caller.provider_id AND channel_type = 'team';
    END IF;
  END IF;

  PERFORM public.fn_seed_chat_participants_for_provider(v_thread_id, v_caller.provider_id);
  RETURN v_thread_id;
END;
$$;


ALTER FUNCTION "public"."rpc_get_or_create_chat_team_thread"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rpc_send_chat_message_with_attachments"("p_thread_id" "uuid", "p_client_message_id" "uuid", "p_body" "text", "p_reply_to_message_id" "uuid", "p_attachments" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid uuid;
  v_thread record;
  v_member_role text;
  v_message_id uuid;
  v_attachment_ids uuid[] := ARRAY[]::uuid[];
  v_attachment jsonb;
  v_attachment_id uuid;
  v_existing_message_id uuid;
  v_message_type text;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'access_denied: no auth session' USING ERRCODE = 'P0001';
  END IF;
  IF p_thread_id IS NULL OR p_client_message_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument: thread_id + client_message_id required' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(p_attachments) <> 'array' OR jsonb_array_length(p_attachments) = 0 THEN
    RAISE EXCEPTION 'invalid_argument: attachments must be non-empty array' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_array_length(p_attachments) > 20 THEN
    RAISE EXCEPTION 'invalid_argument: maximum 20 attachments per message' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_existing_message_id
  FROM public.chat_messages
  WHERE sender_user_id = v_uid
    AND client_message_id = p_client_message_id;
  IF v_existing_message_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'message_id', v_existing_message_id,
      'attachment_ids', (
        SELECT COALESCE(jsonb_agg(id), '[]'::jsonb)
        FROM public.chat_attachments
        WHERE message_id = v_existing_message_id
      ),
      'message_type', (
        SELECT message_type FROM public.chat_messages WHERE id = v_existing_message_id
      ),
      'idempotent', true
    );
  END IF;

  SELECT * INTO v_thread FROM public.chat_threads WHERE id = p_thread_id;
  IF v_thread.id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument: thread % not found', p_thread_id USING ERRCODE = 'P0001';
  END IF;

  SELECT cp.role INTO v_member_role
  FROM public.chat_participants cp
  WHERE cp.thread_id = p_thread_id
    AND cp.user_id = v_uid
    AND cp.left_at IS NULL;
  IF v_member_role IS NULL THEN
    RAISE EXCEPTION 'access_denied: caller is not a participant of this thread' USING ERRCODE = 'P0001';
  END IF;

  IF v_member_role = 'worker' AND v_thread.channel_type = 'customer' THEN
    RAISE EXCEPTION 'access_denied: workers cannot send in customer channels' USING ERRCODE = 'P0001';
  END IF;
  IF v_member_role = 'customer' AND v_thread.channel_type IN ('office', 'team', 'assignment') THEN
    RAISE EXCEPTION 'access_denied: customers cannot send in internal channels' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.chat_messages (
    thread_id, sender_user_id, client_message_id, body, message_type, reply_to_message_id
  )
  VALUES (
    p_thread_id, v_uid, p_client_message_id, p_body, 'text', p_reply_to_message_id
  )
  RETURNING id INTO v_message_id;

  FOR v_attachment IN SELECT * FROM jsonb_array_elements(p_attachments)
  LOOP
    INSERT INTO public.chat_attachments (
      message_id,
      asset_type,
      mime_type,
      size_bytes,
      storage_bucket,
      storage_path,
      width,
      height,
      duration_ms,
      poster_storage_path
    )
    VALUES (
      v_message_id,
      v_attachment->>'asset_type',
      v_attachment->>'mime_type',
      (v_attachment->>'size_bytes')::bigint,
      v_attachment->>'storage_bucket',
      v_attachment->>'storage_path',
      NULLIF(v_attachment->>'width', '')::int,
      NULLIF(v_attachment->>'height', '')::int,
      NULLIF(v_attachment->>'duration_ms', '')::int,
      NULLIF(v_attachment->>'poster_storage_path', '')
    )
    RETURNING id INTO v_attachment_id;
    v_attachment_ids := array_append(v_attachment_ids, v_attachment_id);
  END LOOP;

  SELECT message_type INTO v_message_type
  FROM public.chat_messages WHERE id = v_message_id;

  RETURN jsonb_build_object(
    'message_id', v_message_id,
    'attachment_ids', to_jsonb(v_attachment_ids),
    'message_type', v_message_type,
    'idempotent', false
  );
END;
$$;


ALTER FUNCTION "public"."rpc_send_chat_message_with_attachments"("p_thread_id" "uuid", "p_client_message_id" "uuid", "p_body" "text", "p_reply_to_message_id" "uuid", "p_attachments" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rpc_update_chat_thread_inquiry_state"("p_thread_id" "uuid", "p_reviewed_at" bigint DEFAULT NULL::bigint, "p_declined_at" bigint DEFAULT NULL::bigint) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid uuid;
  v_craftsman uuid;
  v_channel text;
  v_origin text;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'access_denied: no auth session' USING ERRCODE = 'P0001';
  END IF;
  IF p_thread_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument: thread_id required' USING ERRCODE = 'P0001';
  END IF;

  SELECT craftsman_user_id, channel_type, inquiry_origin
    INTO v_craftsman, v_channel, v_origin
  FROM public.chat_threads
  WHERE id = p_thread_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found: thread % does not exist', p_thread_id USING ERRCODE = 'P0001';
  END IF;
  IF v_channel <> 'customer' OR v_origin IS NULL THEN
    RAISE EXCEPTION 'invalid_argument: thread % is not an inquiry thread', p_thread_id USING ERRCODE = 'P0001';
  END IF;
  IF v_craftsman IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'access_denied: caller is not the thread craftsman' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.chat_threads
  SET reviewed_at = COALESCE(reviewed_at, p_reviewed_at),
      declined_at = COALESCE(declined_at, p_declined_at),
      updated_at  = public.epoch_ms()
  WHERE id = p_thread_id;
END;
$$;


ALTER FUNCTION "public"."rpc_update_chat_thread_inquiry_state"("p_thread_id" "uuid", "p_reviewed_at" bigint, "p_declined_at" bigint) OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scan_quality_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "scan_id" "uuid" NOT NULL,
    "score" smallint NOT NULL,
    "bucket" "public"."scan_quality_bucket" NOT NULL,
    "warnings" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "engine_version" "text" NOT NULL,
    "generated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "scan_quality_reports_score_range_chk" CHECK ((("score" >= 0) AND ("score" <= 100)))
);


ALTER TABLE "public"."scan_quality_reports" OWNER TO "postgres";


COMMENT ON TABLE "public"."scan_quality_reports" IS 'Spatial Core: pure-function Quality Engine V1 output. Warnings enum-only.';



COMMENT ON COLUMN "public"."scan_quality_reports"."warnings" IS 'Array of enum codes validated in app layer.';



CREATE OR REPLACE FUNCTION "public"."run_quality_engine"("p_scan_id" "uuid") RETURNS "public"."scan_quality_reports"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid           uuid := auth.uid();
  v_room          public.scan_rooms;
  v_wall_count    int  := 0;
  v_door_count    int  := 0;
  v_window_count  int  := 0;
  v_door_bad      boolean := false;
  v_window_bad    boolean := false;
  v_avg_conf      numeric;
  v_score         int  := 100;
  v_warnings      text[] := ARRAY[]::text[];
  v_bucket        public.scan_quality_bucket;
  v_report        public.scan_quality_reports;
  v_area          numeric;
  v_ceiling       numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE insufficient_privilege USING MESSAGE = 'auth required';
  END IF;
  IF NOT public.spatial_can_view_scan(p_scan_id, v_uid) THEN
    RAISE insufficient_privilege USING MESSAGE = 'no_access';
  END IF;

  SELECT * INTO v_room
  FROM public.scan_rooms
  WHERE scan_id = p_scan_id
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_room.id IS NOT NULL THEN
    SELECT count(*) FILTER (WHERE kind = 'wall'),
           count(*) FILTER (WHERE kind = 'door'),
           count(*) FILTER (WHERE kind = 'window')
      INTO v_wall_count, v_door_count, v_window_count
    FROM public.scan_surfaces
    WHERE room_id = v_room.id;

    SELECT EXISTS (
      SELECT 1
      FROM public.scan_surfaces s
      WHERE s.room_id = v_room.id
        AND s.kind = 'door'
        AND (
          COALESCE(s.dim_w_verified, s.dim_w_estimated) IS NOT NULL
          AND COALESCE(s.dim_h_verified, s.dim_h_estimated) IS NOT NULL
          AND (
            COALESCE(s.dim_w_verified, s.dim_w_estimated) < 0.6
            OR COALESCE(s.dim_w_verified, s.dim_w_estimated) > 1.2
            OR COALESCE(s.dim_h_verified, s.dim_h_estimated) < 1.8
            OR COALESCE(s.dim_h_verified, s.dim_h_estimated) > 2.4
          )
        )
    ) INTO v_door_bad;

    SELECT EXISTS (
      SELECT 1
      FROM public.scan_surfaces s
      WHERE s.room_id = v_room.id
        AND s.kind = 'window'
        AND (
          COALESCE(s.dim_w_verified, s.dim_w_estimated) IS NOT NULL
          AND COALESCE(s.dim_h_verified, s.dim_h_estimated) IS NOT NULL
          AND (
            COALESCE(s.dim_w_verified, s.dim_w_estimated) < 0.2
            OR COALESCE(s.dim_w_verified, s.dim_w_estimated) > 3.0
            OR COALESCE(s.dim_h_verified, s.dim_h_estimated) < 0.3
            OR COALESCE(s.dim_h_verified, s.dim_h_estimated) > 2.5
          )
        )
    ) INTO v_window_bad;

    SELECT avg(confidence)
      INTO v_avg_conf
    FROM public.scan_surfaces
    WHERE room_id = v_room.id AND confidence IS NOT NULL;
  END IF;

  IF v_wall_count < 4 THEN
    v_warnings := array_append(v_warnings, 'too_few_walls');
    v_score    := v_score - 25;
  END IF;

  v_area := COALESCE(v_room.area_m2_verified, v_room.area_m2_estimated);
  IF v_area IS NOT NULL AND (v_area < 3 OR v_area > 200) THEN
    v_warnings := array_append(v_warnings, 'area_implausible');
    v_score    := v_score - 18;
  END IF;

  v_ceiling := COALESCE(v_room.ceiling_h_verified, v_room.ceiling_h_estimated);
  IF v_ceiling IS NOT NULL AND (v_ceiling < 2.0 OR v_ceiling > 4.5) THEN
    v_warnings := array_append(v_warnings, 'ceiling_implausible');
    v_score    := v_score - 15;
  END IF;

  IF v_door_count > 0 AND v_door_bad THEN
    v_warnings := array_append(v_warnings, 'door_dimensions_unusual');
    v_score    := v_score - 9;
  END IF;

  IF v_window_count > 0 AND v_window_bad THEN
    v_warnings := array_append(v_warnings, 'window_dimensions_unusual');
    v_score    := v_score - 9;
  END IF;

  IF v_avg_conf IS NOT NULL AND v_avg_conf < 0.5 THEN
    v_warnings := array_append(v_warnings, 'low_confidence');
    v_score    := v_score - 10;
  END IF;

  IF v_score < 0   THEN v_score := 0;   END IF;
  IF v_score > 100 THEN v_score := 100; END IF;
  v_bucket := CASE
    WHEN v_score >= 85 THEN 'excellent'::public.scan_quality_bucket
    WHEN v_score >= 70 THEN 'good'::public.scan_quality_bucket
    WHEN v_score >= 50 THEN 'fair'::public.scan_quality_bucket
    ELSE 'poor'::public.scan_quality_bucket
  END;

  SELECT array_agg(w ORDER BY w) INTO v_warnings FROM unnest(v_warnings) w;
  IF v_warnings IS NULL THEN
    v_warnings := ARRAY[]::text[];
  END IF;

  INSERT INTO public.scan_quality_reports (scan_id, score, bucket, warnings, engine_version)
  VALUES (
    p_scan_id,
    v_score,
    v_bucket,
    to_jsonb(v_warnings),
    'v1.0.0'
  )
  RETURNING * INTO v_report;

  PERFORM public.record_scan_event(
    p_scan_id,
    'quality_run'::public.scan_event_action,
    jsonb_build_object(
      'score',         v_score,
      'bucket',        v_bucket,
      'warnings',      v_warnings,
      'engineVersion', 'v1.0.0',
      'reportId',      v_report.id
    ),
    NULL
  );

  RETURN v_report;
END;
$$;


ALTER FUNCTION "public"."run_quality_engine"("p_scan_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."run_quality_engine"("p_scan_id" "uuid") IS 'Spatial Core: server-authoritative Quality Engine V1. Mirrors src/lib/spatial/quality/rules.ts. Inserts scan_quality_reports row + emits quality_run audit event. EXECUTE granted to authenticated; gate via spatial_can_view_scan.';



CREATE OR REPLACE FUNCTION "public"."saved_reels_count_by_folder"() RETURNS TABLE("folder_id" "uuid", "save_count" bigint)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  SELECT pms.folder_id, count(*)::bigint AS save_count
    FROM public.provider_media_saves pms
   WHERE pms.user_id = auth.uid()
   GROUP BY pms.folder_id;
$$;


ALTER FUNCTION "public"."saved_reels_count_by_folder"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."settle_consensus_split"("p_dispute_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid               uuid        := auth.uid();
  v_status            text;
  v_decision          text;
  v_settlement_status text;
  v_customer_pid      uuid;
  v_provider_id       uuid;
  v_job_id            uuid;
  v_is_customer       boolean     := false;
  v_is_provider       boolean     := false;
  v_is_operator       boolean     := false;
  v_is_party          boolean     := false;
  v_now               timestamptz := now();
  v_result            jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;

  SELECT d.status, d.decision, d.settlement_status,
         d.customer_profile_id, d.provider_id, d.job_id
    INTO v_status, v_decision, v_settlement_status,
         v_customer_pid, v_provider_id, v_job_id
    FROM public.disputes d
   WHERE d.id = p_dispute_id
   FOR UPDATE;

  IF v_job_id IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id USING ERRCODE = 'P0002';
  END IF;

  IF v_customer_pid IS NOT NULL AND v_customer_pid = v_uid THEN
    v_is_customer := true;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.jobs j
     WHERE j.id = v_job_id
       AND (
             j.craftsman_user_id = v_uid::text
             OR (v_provider_id IS NOT NULL AND j.provider_id IN (
                   SELECT pr.id FROM public.providers pr WHERE pr.profile_id = v_uid
                 ))
           )
  ) INTO v_is_provider;

  SELECT COALESCE(p.is_operator, false) INTO v_is_operator
    FROM public.profiles p WHERE p.id = v_uid;

  v_is_party := v_is_customer OR v_is_provider OR v_is_operator;

  IF NOT v_is_party THEN
    RAISE EXCEPTION 'unauthorized: caller is not a party to dispute %', p_dispute_id USING ERRCODE = '42501';
  END IF;

  IF v_status IS DISTINCT FROM 'resolved' OR v_decision IS DISTINCT FROM 'split' THEN
    RAISE EXCEPTION 'settle_precondition_failed: dispute % has status=%, decision=%; expected status=resolved and decision=split',
      p_dispute_id, COALESCE(v_status, 'null'), COALESCE(v_decision, 'null') USING ERRCODE = 'P0001';
  END IF;

  IF v_settlement_status = 'settled' THEN
    SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
    RETURN v_result;
  END IF;

  IF v_settlement_status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'settle_precondition_failed: dispute % settlement_status=%, expected pending',
      p_dispute_id, COALESCE(v_settlement_status, 'null') USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('app.p4b_split_settle_commit', 'allow', true);

  UPDATE public.disputes
     SET settlement_status = 'settled', updated_at = v_now
   WHERE id = p_dispute_id;

  SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."settle_consensus_split"("p_dispute_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."settle_consensus_split"("p_dispute_id" "uuid") IS 'P4A: marks a consensus-split dispute settlement complete (pending->settled). SECURITY DEFINER. service_role ONLY until CONSENSUS_SPLIT_ENABLED launch flag. Idempotent on already-settled. Uses app.p4b_split_settle_commit sentinel to pass disputes_status_change_guard (scoped to settlement_status pending->settled only). LAUNCH RE-GRANT: GRANT EXECUTE ... TO authenticated;';



CREATE OR REPLACE FUNCTION "public"."settle_dispute_default"("p_dispute_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN public.settle_dispute_resolution(p_dispute_id);
END;
$$;


ALTER FUNCTION "public"."settle_dispute_default"("p_dispute_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."settle_dispute_default"("p_dispute_id" "uuid") IS 'P4 Batch 3 - T+80 default cut (75/25 PARTIAL settle): refunds ONLY the still-HELD tranches, writes a refund_partial ledger row over default_refund_minor (G3), does NOT mark the plan refunded and does NOT touch payments/jobs/project (Option B). Plan->Tranche lock order. SECURITY DEFINER, service_role ONLY. Idempotent. Dormant when FUNDING_DESTINATION_CHARGE_ENABLED unset.';



CREATE OR REPLACE FUNCTION "public"."settle_dispute_resolution"("p_dispute_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_status            text;
  v_decision          text;
  v_resolution_type   text;
  v_settlement_status text;
  v_default_applied   timestamptz;
  v_snapshot_minor    bigint;
  v_job_id            uuid;
  v_plan_id           uuid;
  v_total             numeric;
  v_currency          text;
  v_fee_total         numeric;
  v_fee_rate          numeric;
  v_payment_id        uuid;
  v_refund_minor      bigint;
  v_total_minor       bigint;
  v_retained_minor    bigint;
  v_refund_ratio      numeric;
  v_retained_ratio    numeric;
  v_fee_refunded      numeric;
  v_source            text;
  v_project_id        text;
  v_result            jsonb;
BEGIN
  SELECT d.status, d.decision, d.resolution_type, d.settlement_status,
         d.default_applied_at, d.default_refund_minor, d.job_id
    INTO v_status, v_decision, v_resolution_type, v_settlement_status,
         v_default_applied, v_snapshot_minor, v_job_id
    FROM public.disputes d
   WHERE d.id = p_dispute_id
   FOR UPDATE;

  IF v_job_id IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_settlement_status = 'settled' THEN
    SELECT row_to_json(d)::jsonb INTO v_result
      FROM public.disputes d
     WHERE d.id = p_dispute_id;
    RETURN v_result;
  END IF;

  IF v_status IS DISTINCT FROM 'resolved'
     OR v_decision NOT IN ('refund', 'split', 'release', 'reject')
  THEN
    RAISE EXCEPTION 'settle_precondition_failed: dispute % has status=%, decision=%; '
                    'expected status=resolved and decision in (refund,split,release,reject)',
      p_dispute_id,
      COALESCE(v_status,   'null'),
      COALESCE(v_decision, 'null')
      USING ERRCODE = 'P0001';
  END IF;

  SELECT epp.id, epp.total_amount, epp.currency,
         epp.platform_fee_amount, epp.platform_fee_rate
    INTO v_plan_id, v_total, v_currency, v_fee_total, v_fee_rate
    FROM public.escrow_payment_plans epp
   WHERE epp.job_id = v_job_id
   LIMIT 1;

  IF v_plan_id IS NOT NULL THEN
    PERFORM 1 FROM public.escrow_payment_plans WHERE id = v_plan_id FOR UPDATE;
  END IF;

  SELECT p.id INTO v_payment_id
    FROM public.payments p
   WHERE p.job_id = v_job_id
   LIMIT 1;

  IF v_decision NOT IN ('refund', 'split') THEN
    v_refund_minor := 0;
  ELSIF v_snapshot_minor IS NOT NULL THEN
    v_refund_minor := v_snapshot_minor;
  ELSIF v_plan_id IS NOT NULL THEN
    SELECT COALESCE(round(SUM(t.amount) * 100), 0)::bigint
      INTO v_refund_minor
      FROM public.escrow_tranches t
     WHERE t.plan_id = v_plan_id
       AND t.status NOT IN ('released', 'release_pending', 'refunded')
       AND t.external_release_ref  IS NULL
       AND t.external_payout_ref   IS NULL
       AND t.transfer_reversal_ref IS NULL;
  ELSE
    v_refund_minor := 0;
  END IF;
  v_refund_minor := COALESCE(v_refund_minor, 0);

  v_total_minor    := round(COALESCE(v_total, 0) * 100)::bigint;
  v_retained_minor := GREATEST(v_total_minor - v_refund_minor, 0);
  IF v_total_minor > 0 THEN
    v_refund_ratio   := round(v_refund_minor::numeric   / v_total_minor, 4);
    v_retained_ratio := round(v_retained_minor::numeric / v_total_minor, 4);
  ELSE
    v_refund_ratio   := 0;
    v_retained_ratio := 0;
  END IF;
  v_fee_refunded := round(COALESCE(v_fee_total, 0) * v_refund_ratio, 2);
  v_source := CASE WHEN v_default_applied IS NOT NULL
                   THEN 't80_default' ELSE 'corridor_resolution' END;

  UPDATE public.disputes
     SET settlement_status = 'settled',
         updated_at        = now()
   WHERE id = p_dispute_id;

  IF v_plan_id IS NOT NULL AND v_decision IN ('refund', 'split') THEN
    UPDATE public.escrow_tranches
       SET status     = 'refunded',
           updated_at = now()
     WHERE plan_id = v_plan_id
       AND status NOT IN ('released', 'release_pending')
       AND external_release_ref  IS NULL
       AND external_payout_ref   IS NULL
       AND transfer_reversal_ref IS NULL;
  END IF;

  IF v_payment_id IS NOT NULL AND v_refund_minor > 0 THEN
    INSERT INTO public.ledger_entries
      (payment_id, job_id, dispute_id, entry_type, amount, currency, movement_ref, metadata)
    VALUES (
      v_payment_id,
      v_job_id,
      p_dispute_id,
      'refund_partial',
      v_refund_minor::numeric / 100,
      COALESCE(v_currency, 'EUR'),
      p_dispute_id::text,
      jsonb_build_object(
        'source',                  v_source,
        'decision',                v_decision,
        'resolution_type',         COALESCE(v_resolution_type, 'refund_partial'),
        'held_minor',              v_refund_minor,
        'released_retained_minor', v_retained_minor,
        'total_minor',             v_total_minor,
        'split_ratio',             v_retained_ratio,
        'refund_ratio',            v_refund_ratio,
        'fee', jsonb_build_object(
                 'platform_fee_amount',   COALESCE(v_fee_total, 0),
                 'platform_fee_rate',     v_fee_rate,
                 'platform_fee_refunded', v_fee_refunded
               )
      )
    )
    ON CONFLICT (payment_id, entry_type, movement_ref) DO NOTHING;
  END IF;

  IF v_decision IN ('release', 'reject') THEN
    IF v_payment_id IS NOT NULL THEN
      UPDATE public.payments
         SET status = 'released'
       WHERE id = v_payment_id
         AND status = 'disputed';
    END IF;

    UPDATE public.jobs
       SET payment_state = 'released',
           status        = CASE WHEN status = 'waiting_payment' THEN 'completed' ELSE status END,
           updated_at    = now()
     WHERE id = v_job_id
     RETURNING project_id INTO v_project_id;

    IF v_project_id IS NOT NULL AND v_project_id <> '' THEN
      UPDATE public.projects
         SET payment_state = 'released',
             updated_at     = now()
       WHERE id = v_project_id::uuid;
    END IF;
  END IF;

  SELECT row_to_json(d)::jsonb INTO v_result
    FROM public.disputes d
   WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."settle_dispute_resolution"("p_dispute_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spatial_can_convert_scan"("p_scan_id" "uuid", "p_uid" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT
    public.spatial_is_operator(p_uid)
    OR EXISTS (
      SELECT 1
      FROM public.scans s
      LEFT JOIN public.projects p ON p.id = s.project_id
      LEFT JOIN public.provider_presales_projects pp ON pp.id = s.presales_project_id
      WHERE s.id = p_scan_id
        AND s.status <> 'archived'
        AND s.status <> 'locked_for_dispute'
        AND (
          p.customer_user_id = p_uid
          OR s.captured_by   = p_uid
          OR (
            pp.provider_org_id IS NOT NULL
            AND pp.provider_org_id = public.spatial_user_provider_org(p_uid)
          )
        )
    );
$$;


ALTER FUNCTION "public"."spatial_can_convert_scan"("p_scan_id" "uuid", "p_uid" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_can_convert_scan"("p_scan_id" "uuid", "p_uid" "uuid") IS 'P0 review fix + V1.5 hotfix — convert-permission helper. Wider than spatial_can_edit_scan: captured_by + presales-org-member retain convert-trigger access through captured/quality_checked/etc, but lose it on archived + locked_for_dispute.';



CREATE OR REPLACE FUNCTION "public"."spatial_can_edit_scan"("p_scan_id" "uuid", "p_uid" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT
    public.spatial_is_operator(p_uid)
    OR EXISTS (
      SELECT 1
      FROM public.scans s
      LEFT JOIN public.projects p ON p.id = s.project_id
      LEFT JOIN public.provider_presales_projects pp ON pp.id = s.presales_project_id
      WHERE s.id = p_scan_id
        AND (
          p.customer_user_id = p_uid
          OR (s.captured_by = p_uid AND s.status IN ('draft', 'capturing'))
          OR (
            pp.provider_org_id IS NOT NULL
            AND pp.provider_org_id = public.spatial_user_provider_org(p_uid)
          )
          OR (s.owner_type = 'customer' AND s.captured_by = p_uid)
        )
    );
$$;


ALTER FUNCTION "public"."spatial_can_edit_scan"("p_scan_id" "uuid", "p_uid" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_can_edit_scan"("p_scan_id" "uuid", "p_uid" "uuid") IS 'Spatial Core RLS helper: full edit-access. VOLATILE seit 20260526 Hotfix (gleiche Begruendung wie spatial_can_view_scan; UPDATE...RETURNING haette gleichen Snapshot-Quirk).';



CREATE OR REPLACE FUNCTION "public"."spatial_can_edit_scene"("p_scene_id" "uuid", "p_uid" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT
    auth.role() = 'service_role'
    OR public.spatial_is_operator(p_uid)
    OR EXISTS (
      SELECT 1 FROM public.spatial_scenes s
      WHERE s.id = p_scene_id
        AND (
          -- The provider who owns the scene record may edit it.
          s.provider_id = p_uid
          -- A customer self-scan: the source scan is customer-owned AND was
          -- captured by this caller. A craftsman scene shared with the customer
          -- has owner_type='craftsman' (or a different captured_by) and is thus
          -- NOT editable by the customer — read-only, comment via pins only.
          OR (
            s.source_scan_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM public.scans sc
              WHERE sc.id = s.source_scan_id
                AND sc.owner_type = 'customer'
                AND sc.captured_by = p_uid
            )
          )
        )
    );
$$;


ALTER FUNCTION "public"."spatial_can_edit_scene"("p_scene_id" "uuid", "p_uid" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spatial_can_view_mesh_snapshot"("p_object_name" "text", "p_uid" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'storage'
    AS $$
  SELECT
    (storage.foldername(p_object_name))[1] = p_uid::text
    OR EXISTS (
      SELECT 1
      FROM public.scans sc
      JOIN  public.jobs  j  ON j.id = sc.job_id
      WHERE sc.id = public.spatial_mesh_snapshot_scan_id(p_object_name)
        AND sc.shared_with_customer = true
        AND j.craftsman_user_id = p_uid::text
    )
    OR public.spatial_is_operator(p_uid);
$$;


ALTER FUNCTION "public"."spatial_can_view_mesh_snapshot"("p_object_name" "text", "p_uid" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_can_view_mesh_snapshot"("p_object_name" "text", "p_uid" "uuid") IS 'V1.6 Phase 2: RLS helper for spatial-mesh-snapshots SELECT. (a) path-owner (customer who captured), (b) craftsman on linked job with shared_with_customer=true, (c) operator. SECDEF bypasses scans/jobs RLS for the cross-table lookup. Does NOT use INSERT-RETURNING path (INSERT policy uses inline foldername check to avoid SECDEF snapshot bug).';



CREATE OR REPLACE FUNCTION "public"."spatial_can_view_scan"("p_scan_id" "uuid", "p_uid" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT
    public.spatial_is_operator(p_uid)
    OR EXISTS (
      SELECT 1
      FROM public.scans s
      LEFT JOIN public.projects    p  ON p.id  = s.project_id
      LEFT JOIN public.jobs        j  ON j.id  = s.job_id
      LEFT JOIN public.provider_presales_projects pp ON pp.id = s.presales_project_id
      WHERE s.id = p_scan_id
        AND (
          p.customer_user_id = p_uid
          OR j.craftsman_user_id = p_uid::text
          OR j.customer_user_id = p_uid
          OR EXISTS (
            SELECT 1
            FROM public.job_assignments ja
            JOIN public.team_members    tm ON tm.id = ja.team_member_id
            WHERE ja.job_id     = s.job_id
              AND tm.profile_id = p_uid
              AND tm.is_active  = true
              AND ja.status     IN ('assigned', 'accepted', 'active', 'in_progress', 'completed')
          )
          OR (s.captured_by = p_uid AND s.status IN ('draft', 'capturing'))
          OR (
            pp.provider_org_id IS NOT NULL
            AND pp.provider_org_id = public.spatial_user_provider_org(p_uid)
          )
          OR (s.owner_type = 'customer' AND s.captured_by = p_uid)
          OR (
            s.shared_with_customer = true
            AND s.job_id IS NOT NULL
            AND j.customer_user_id = p_uid
          )
          OR s.shared_with_provider_id = p_uid
        )
    );
$$;


ALTER FUNCTION "public"."spatial_can_view_scan"("p_scan_id" "uuid", "p_uid" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_can_view_scan"("p_scan_id" "uuid", "p_uid" "uuid") IS 'Spatial Core RLS helper: union view-access. VOLATILE seit 20260526 Hotfix damit INSERT...RETURNING (Customer Self-Scan) den fresh-snapshot der eingefuegten Row sieht. Vorher STABLE -> SELECT-USING returnte false auf neue Row -> 42501 maskiert als WITH-CHECK-Violation.';



CREATE OR REPLACE FUNCTION "public"."spatial_can_view_scene"("p_scene_id" "uuid", "p_uid" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT
    auth.role() = 'service_role'
    OR public.spatial_is_operator(p_uid)
    OR EXISTS (
      SELECT 1 FROM public.spatial_scenes s
      WHERE s.id = p_scene_id
        AND (
          s.customer_id = p_uid
          OR s.provider_id = p_uid
          OR (
            s.source_scan_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM public.scans sc
              JOIN public.jobs  j ON j.id = sc.job_id
              WHERE sc.id = s.source_scan_id
                AND sc.shared_with_customer = true
                AND j.customer_user_id = p_uid
            )
          )
          OR (
            s.customer_id IS NULL
            AND s.source_scan_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM public.scans sc
              WHERE sc.id = s.source_scan_id
                AND sc.owner_type = 'customer'
                AND sc.captured_by = p_uid
            )
          )
        )
    );
$$;


ALTER FUNCTION "public"."spatial_can_view_scene"("p_scene_id" "uuid", "p_uid" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_can_view_scene"("p_scene_id" "uuid", "p_uid" "uuid") IS 'Spatial Canonical RLS helper: scene-actor check. Lane 3 V1.6 additions: HW-shared scene (source scan shared_with_customer=true + job.customer_user_id=uid) + customer-owned Self-Scan scene (source scan owner_type=customer + captured_by=uid).';



CREATE OR REPLACE FUNCTION "public"."spatial_canonical_dispute_lock_guard"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid          uuid;
  v_scene_id     uuid;
  v_scan_id      uuid;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN COALESCE(NEW, OLD); END IF;
  v_uid := auth.uid();
  IF TG_TABLE_NAME = 'spatial_scenes' THEN
    v_scene_id := COALESCE(NEW.id, OLD.id);
  ELSIF TG_TABLE_NAME IN ('spatial_node_overrides', 'spatial_change_orders') THEN
    v_scene_id := COALESCE(NEW.scene_id, OLD.scene_id);
  ELSE
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF v_scene_id IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT s.source_scan_id INTO v_scan_id FROM public.spatial_scenes s WHERE s.id = v_scene_id;
  IF v_scan_id IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  IF public.spatial_is_operator(v_uid) THEN RETURN COALESCE(NEW, OLD); END IF;
  IF public.spatial_scan_is_locked(v_scan_id) THEN
    RAISE EXCEPTION 'spatial_scene % is locked for dispute (source scan %) - writes blocked on table %',
      v_scene_id, v_scan_id, TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;


ALTER FUNCTION "public"."spatial_canonical_dispute_lock_guard"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spatial_change_orders_immutable_cols_guard"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
  IF NEW.id <> OLD.id THEN
    RAISE EXCEPTION 'SPATIAL_FSM_VIOLATION: spatial_change_orders.id is immutable (id=%)', OLD.id USING ERRCODE = '45SPF';
  END IF;
  IF NEW.scene_id <> OLD.scene_id THEN
    RAISE EXCEPTION 'SPATIAL_FSM_VIOLATION: spatial_change_orders.scene_id is immutable (id=%)', OLD.id USING ERRCODE = '45SPF';
  END IF;
  IF NEW.proposer_id <> OLD.proposer_id THEN
    RAISE EXCEPTION 'SPATIAL_FSM_VIOLATION: spatial_change_orders.proposer_id is immutable (id=%)', OLD.id USING ERRCODE = '45SPF';
  END IF;
  IF NEW.node_id IS DISTINCT FROM OLD.node_id THEN
    RAISE EXCEPTION 'SPATIAL_FSM_VIOLATION: spatial_change_orders.node_id is immutable (id=%)', OLD.id USING ERRCODE = '45SPF';
  END IF;
  IF NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'SPATIAL_FSM_VIOLATION: spatial_change_orders.created_at is immutable (id=%)', OLD.id USING ERRCODE = '45SPF';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."spatial_change_orders_immutable_cols_guard"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spatial_change_orders_status_fsm_guard"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
DECLARE v_allowed text[];
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  v_allowed := CASE OLD.status
    WHEN 'proposed'   THEN ARRAY['accepted','rejected','withdrawn']
    WHEN 'accepted'   THEN ARRAY[]::text[]
    WHEN 'rejected'   THEN ARRAY[]::text[]
    WHEN 'withdrawn'  THEN ARRAY[]::text[]
    ELSE ARRAY[]::text[]
  END;
  IF NOT (NEW.status = ANY(v_allowed)) THEN
    RAISE EXCEPTION 'SPATIAL_FSM_VIOLATION: illegal spatial_change_orders.status transition % to % (id=%)',
      OLD.status, NEW.status, OLD.id USING ERRCODE = '45SPF';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."spatial_change_orders_status_fsm_guard"() OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."spatial_scenes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source_scan_id" "uuid",
    "source_job_id" "uuid",
    "parametric_storage_path" "text" NOT NULL,
    "parametric_size_bytes" integer,
    "parametric_sha256" "text",
    "schema_version" "text" DEFAULT '1.0'::"text" NOT NULL,
    "validation_state" "text" DEFAULT 'pending'::"text" NOT NULL,
    "is_renderable" boolean DEFAULT false NOT NULL,
    "requires_user_confirmation" boolean DEFAULT false NOT NULL,
    "customer_verify_state" "text" DEFAULT 'not_started'::"text" NOT NULL,
    "customer_id" "uuid",
    "provider_id" "uuid",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "customer_verify_last_stage" integer,
    "customer_verify_last_active_at" timestamp with time zone,
    "customer_verify_last_reminder_sent_at" timestamp with time zone,
    "customer_verify_last_reminder_channel" "text",
    "provider_org_id" "uuid",
    "parent_scene_id" "uuid",
    "polygon_outline" "jsonb",
    "origin" "text" DEFAULT 'roomplan'::"text" NOT NULL,
    "parametric_version" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "spatial_scenes_anchor_chk" CHECK (((COALESCE(("source_scan_id")::"text", ''::"text") <> ''::"text") OR (COALESCE(("source_job_id")::"text", ''::"text") <> ''::"text") OR ("origin" = ANY (ARRAY['manual'::"text", 'example_room'::"text"])))),
    CONSTRAINT "spatial_scenes_customer_verify_last_reminder_channel_chk" CHECK ((("customer_verify_last_reminder_channel" IS NULL) OR ("customer_verify_last_reminder_channel" = ANY (ARRAY['push'::"text", 'email'::"text"])))),
    CONSTRAINT "spatial_scenes_customer_verify_last_stage_chk" CHECK ((("customer_verify_last_stage" IS NULL) OR (("customer_verify_last_stage" >= 1) AND ("customer_verify_last_stage" <= 5)))),
    CONSTRAINT "spatial_scenes_customer_verify_state_chk" CHECK (("customer_verify_state" = ANY (ARRAY['not_started'::"text", 'in_progress'::"text", 'approved'::"text", 'rejected'::"text", 'expired'::"text"]))),
    CONSTRAINT "spatial_scenes_origin_value_chk" CHECK (("origin" = ANY (ARRAY['roomplan'::"text", 'manual'::"text", 'example_room'::"text"]))),
    CONSTRAINT "spatial_scenes_validation_state_chk" CHECK (("validation_state" = ANY (ARRAY['pending'::"text", 'passed'::"text", 'passed_with_warnings'::"text", 'blocked'::"text", 're_review'::"text"])))
);


ALTER TABLE "public"."spatial_scenes" OWNER TO "postgres";


COMMENT ON TABLE "public"."spatial_scenes" IS 'Spatial Canonical V1: header record per parametric scene. Parametric JSON blob lives in Storage at parametric_storage_path (Decision #2). R4: source_scan_id OR source_job_id required. R7: is_renderable + requires_user_confirmation are orthogonal dual-flags. RLS + triggers added in Day 7.';



COMMENT ON COLUMN "public"."spatial_scenes"."source_job_id" IS 'FK to jobs.id (uuid PK, verified against prod 2026-05-20). V1: job-only flows that have no RoomPlan scan.';



COMMENT ON COLUMN "public"."spatial_scenes"."parametric_storage_path" IS 'Supabase Storage path to the canonical parametric JSON blob (RoomScene wire-format). Content-addressed via parametric_sha256.';



COMMENT ON COLUMN "public"."spatial_scenes"."parametric_sha256" IS 'SHA-256 hex digest of the parametric blob. Used for content-addressed caching and integrity verification on download.';



COMMENT ON COLUMN "public"."spatial_scenes"."schema_version" IS 'Maps to schema/version-migration.ts CURRENT_SCHEMA_VERSION. migrateParametricJson is run on load when version < current.';



COMMENT ON COLUMN "public"."spatial_scenes"."validation_state" IS 'R7 5-state FSM: pending to passed | passed_with_warnings | blocked to re_review. SpatialFsmViolation Postgres exception domain wired in Day 7 triggers.';



COMMENT ON COLUMN "public"."spatial_scenes"."customer_verify_state" IS 'Verify-Flow-Spec 2.6 customer confirmation FSM. FSM transitions enforced via spatialSceneFsm.ts (Day 8 B11).';



COMMENT ON COLUMN "public"."spatial_scenes"."customer_verify_last_stage" IS 'Verify-Flow Block 3.12: 1-5 sub-stage index the customer last saw (1=Welcome, 2=Maße, 3=Layout, 4=Pins, 5=Confirm). Drives App-Kill/Re-Enter resume via resolveResumeStage(). NULL = never entered verify.';



COMMENT ON COLUMN "public"."spatial_scenes"."customer_verify_last_active_at" IS 'Verify-Flow Block 3.12: timestamp of the customer last verify activity (sheet-open or stage mutation). Drives the VF-4 verify-reminder cadence (24h push / 72h email) and the re-prompt copy. NULL = never entered verify.';



COMMENT ON COLUMN "public"."spatial_scenes"."customer_verify_last_reminder_sent_at" IS 'Verify-Flow Block 3.11 (VF-4): timestamp the last verify-reminder was sent for this scene. De-dup anchor for resolveVerifyReminderChannel - a channel already sent after the current customer_verify_last_active_at is not re-fired. NULL = no reminder sent yet.';



COMMENT ON COLUMN "public"."spatial_scenes"."customer_verify_last_reminder_channel" IS 'Verify-Flow Block 3.11 (VF-4): channel of the last verify-reminder sent (push | email). Lets the resolver suppress a duplicate same-channel push while still allowing the 72h email escalation. NULL = no reminder sent yet.';



COMMENT ON COLUMN "public"."spatial_scenes"."provider_org_id" IS 'Provider Spatial Hub: the provider BUSINESS (public.providers.id) that owns this scene. Distinct from provider_id (one auth user). Drives the Hub job-listing scope. Auto-derived from provider_id by the spatial_scenes_fill_provider_org trigger.';



COMMENT ON COLUMN "public"."spatial_scenes"."parent_scene_id" IS 'Spatial D2 (B7): the predecessor scene this one supersedes. NULL for root scenes (initial customer/provider capture). Set when the scene was produced as a re-scan response (via spatial_create_scene with p_parent_scene_id). Immutable post-insert (spatial_scenes_immutable_cols_guard) — the version chain is intrinsic to the scene''s identity.';



COMMENT ON COLUMN "public"."spatial_scenes"."polygon_outline" IS 'V1.5 Hotfix E4: per-wall world-space polygon corners from Surface.polygonCorners (iOS 17+ only). Shape: { wall_id: [[x,y,z], ...] }. NULL = renderer falls back to bbox approximation. Mutable (not in immutable-cols-guard) so canonical reconverts can backfill.';



COMMENT ON COLUMN "public"."spatial_scenes"."parametric_version" IS 'H1 audit-fix · optimistic-concurrency token. Bumped on every repository update() via compare-and-set so a concurrent writer surfaces CONFLICT instead of clobbering the parametric blob pointer. The column-scoped verify-state RPC does not touch it.';



CREATE OR REPLACE FUNCTION "public"."spatial_create_manual_scene"("p_id" "uuid", "p_presales_project_id" "uuid", "p_parametric_storage_path" "text", "p_parametric_sha256" "text" DEFAULT NULL::"text", "p_parametric_size_bytes" integer DEFAULT NULL::integer, "p_origin" "text" DEFAULT 'manual'::"text", "p_metadata" "jsonb" DEFAULT '{}'::"jsonb", "p_schema_version" "text" DEFAULT '1.0'::"text") RETURNS "public"."spatial_scenes"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_uid              uuid := auth.uid();
  v_scene            public.spatial_scenes;
  v_provider_org_id  uuid;
  v_provider_user_id uuid;
  v_owner_user_id    uuid;
  v_authorized       boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'spatial_create_manual_scene: authentication required'
      USING ERRCODE = '28000';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'spatial_create_manual_scene: p_id is required'
      USING ERRCODE = '22023';
  END IF;
  IF p_presales_project_id IS NULL THEN
    RAISE EXCEPTION 'spatial_create_manual_scene: p_presales_project_id is required'
      USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_parametric_storage_path, '') = '' THEN
    RAISE EXCEPTION 'spatial_create_manual_scene: p_parametric_storage_path is required'
      USING ERRCODE = '22023';
  END IF;
  IF p_origin NOT IN ('manual', 'example_room') THEN
    RAISE EXCEPTION
      'spatial_create_manual_scene: origin must be manual or example_room (got %)',
      p_origin
      USING ERRCODE = '22023';
  END IF;

  SELECT pp.provider_org_id, pp.created_by_user_id
    INTO v_provider_org_id, v_owner_user_id
    FROM public.provider_presales_projects pp
    WHERE pp.id = p_presales_project_id;
  IF v_provider_org_id IS NULL THEN
    RAISE EXCEPTION
      'spatial_create_manual_scene: presales project % not found',
      p_presales_project_id
      USING ERRCODE = '22023';
  END IF;

  v_authorized := (v_owner_user_id = v_uid)
    OR (v_provider_org_id = public.spatial_user_provider_org(v_uid))
    OR public.spatial_is_operator(v_uid);
  IF NOT v_authorized THEN
    RAISE EXCEPTION
      'spatial_create_manual_scene: caller % not authorised for presales project %',
      v_uid, p_presales_project_id
      USING ERRCODE = '42501';
  END IF;

  SELECT p.profile_id INTO v_provider_user_id
    FROM public.providers p
    WHERE p.id = v_provider_org_id;

  INSERT INTO public.spatial_scenes (
    id,
    source_scan_id,
    source_job_id,
    parametric_storage_path,
    parametric_size_bytes,
    parametric_sha256,
    schema_version,
    validation_state,
    is_renderable,
    requires_user_confirmation,
    provider_id,
    provider_org_id,
    metadata,
    origin
  )
  VALUES (
    p_id,
    NULL,
    NULL,
    p_parametric_storage_path,
    p_parametric_size_bytes,
    p_parametric_sha256,
    COALESCE(p_schema_version, '1.0'),
    'passed',
    true,
    false,
    v_provider_user_id,
    v_provider_org_id,
    COALESCE(p_metadata, '{}'::jsonb)
      || jsonb_build_object('presales_project_id', p_presales_project_id),
    p_origin
  )
  RETURNING * INTO v_scene;

  RETURN v_scene;
END;
$$;


ALTER FUNCTION "public"."spatial_create_manual_scene"("p_id" "uuid", "p_presales_project_id" "uuid", "p_parametric_storage_path" "text", "p_parametric_sha256" "text", "p_parametric_size_bytes" integer, "p_origin" "text", "p_metadata" "jsonb", "p_schema_version" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spatial_create_scene"("p_id" "uuid", "p_parametric_storage_path" "text", "p_parametric_sha256" "text" DEFAULT NULL::"text", "p_parametric_size_bytes" integer DEFAULT NULL::integer, "p_source_scan_id" "uuid" DEFAULT NULL::"uuid", "p_source_job_id" "uuid" DEFAULT NULL::"uuid", "p_schema_version" "text" DEFAULT '1.0'::"text", "p_validation_state" "text" DEFAULT 'pending'::"text", "p_validation_report" "jsonb" DEFAULT '{}'::"jsonb", "p_is_renderable" boolean DEFAULT false, "p_requires_user_confirmation" boolean DEFAULT false, "p_metadata" "jsonb" DEFAULT '{}'::"jsonb", "p_parent_scene_id" "uuid" DEFAULT NULL::"uuid", "p_rescan_request_id" "uuid" DEFAULT NULL::"uuid") RETURNS "public"."spatial_scenes"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_uid              uuid := auth.uid();
  v_scene            public.spatial_scenes;
  v_effective_job_id uuid;
  v_customer_id      uuid;
  v_capture_uid      uuid;
  v_owner_type       text;
  v_provider_org_id  uuid;
  v_provider_user_id uuid;
  v_authorized       boolean := false;
  v_req_status       text;
  v_req_scene_id     uuid;
  v_req_resulting    uuid;
  v_parent_customer  uuid;
  v_effective_parent uuid := p_parent_scene_id;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'spatial_create_scene: authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'spatial_create_scene: p_id is required (client-generated scene uuid)' USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_parametric_storage_path, '') = '' THEN
    RAISE EXCEPTION 'spatial_create_scene: p_parametric_storage_path is required' USING ERRCODE = '22023';
  END IF;
  IF p_source_scan_id IS NULL AND p_source_job_id IS NULL THEN
    RAISE EXCEPTION 'spatial_create_scene: source_scan_id OR source_job_id required (R4)' USING ERRCODE = '22023';
  END IF;

  IF p_rescan_request_id IS NOT NULL THEN
    SELECT r.status, r.scene_id, r.resulting_scene_id
      INTO v_req_status, v_req_scene_id, v_req_resulting
      FROM public.spatial_rescan_requests r
      WHERE r.id = p_rescan_request_id
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'spatial_create_scene: rescan_request % not found', p_rescan_request_id USING ERRCODE = '22023';
    END IF;
    IF v_req_resulting IS NOT NULL THEN
      SELECT * INTO v_scene FROM public.spatial_scenes WHERE id = v_req_resulting;
      IF FOUND THEN RETURN v_scene; END IF;
    END IF;
    IF v_req_status <> 'accepted' THEN
      RAISE EXCEPTION 'spatial_create_scene: rescan_request status must be accepted (got %)', v_req_status USING ERRCODE = '22023';
    END IF;
    IF v_effective_parent IS NULL THEN
      v_effective_parent := v_req_scene_id;
    ELSIF v_effective_parent IS DISTINCT FROM v_req_scene_id THEN
      RAISE EXCEPTION 'spatial_create_scene: parent_scene_id must match rescan_request.scene_id' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_source_scan_id IS NOT NULL THEN
    SELECT * INTO v_scene FROM public.spatial_scenes WHERE source_scan_id = p_source_scan_id;
    IF FOUND THEN RETURN v_scene; END IF;
  END IF;

  v_effective_job_id := p_source_job_id;
  IF v_effective_job_id IS NULL AND p_source_scan_id IS NOT NULL THEN
    SELECT s.job_id INTO v_effective_job_id FROM public.scans s WHERE s.id = p_source_scan_id;
  END IF;

  IF v_effective_parent IS NOT NULL THEN
    IF p_rescan_request_id IS NOT NULL THEN
      SELECT s.customer_id INTO v_parent_customer FROM public.spatial_scenes s WHERE s.id = v_effective_parent;
      IF v_parent_customer IS NULL THEN
        RAISE EXCEPTION 'spatial_create_scene: parent scene % not found', v_effective_parent USING ERRCODE = '22023';
      END IF;
      IF v_parent_customer IS DISTINCT FROM v_uid THEN
        RAISE EXCEPTION 'spatial_create_scene: caller % is not the customer of parent scene %', v_uid, v_effective_parent USING ERRCODE = '42501';
      END IF;
    ELSE
      IF NOT public.spatial_can_view_scene(v_effective_parent, v_uid) THEN
        RAISE EXCEPTION 'spatial_create_scene: caller % cannot view parent scene %', v_uid, v_effective_parent USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  IF p_source_scan_id IS NOT NULL THEN
    v_authorized := public.spatial_can_convert_scan(p_source_scan_id, v_uid);
  ELSE
    SELECT (
        public.spatial_is_operator(v_uid)
        OR j.customer_user_id = v_uid
        OR (j.provider_id IS NOT NULL AND j.provider_id = public.spatial_user_provider_org(v_uid))
        OR (j.assigned_provider_id IS NOT NULL AND j.assigned_provider_id = public.spatial_user_provider_org(v_uid))
      )
      INTO v_authorized
      FROM public.jobs j
      WHERE j.id = p_source_job_id;
  END IF;
  IF v_authorized IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'spatial_create_scene: caller % is not authorized for this scan/job', v_uid USING ERRCODE = '42501';
  END IF;

  IF p_source_scan_id IS NOT NULL THEN
    SELECT pr.customer_user_id, s.captured_by, s.owner_type
      INTO v_customer_id, v_capture_uid, v_owner_type
      FROM public.scans s
      LEFT JOIN public.projects pr ON pr.id = s.project_id
      WHERE s.id = p_source_scan_id;
  END IF;
  IF v_customer_id IS NULL AND v_effective_job_id IS NOT NULL THEN
    SELECT j.customer_user_id INTO v_customer_id FROM public.jobs j WHERE j.id = v_effective_job_id;
  END IF;
  IF v_customer_id IS NULL AND v_owner_type = 'customer' AND v_capture_uid IS NOT NULL THEN
    v_customer_id := v_capture_uid;
  END IF;

  IF v_effective_job_id IS NOT NULL THEN
    SELECT coalesce(j.provider_id, j.assigned_provider_id) INTO v_provider_org_id
      FROM public.jobs j WHERE j.id = v_effective_job_id;
    IF v_provider_org_id IS NOT NULL THEN
      SELECT p.profile_id INTO v_provider_user_id FROM public.providers p WHERE p.id = v_provider_org_id;
    END IF;
  END IF;

  INSERT INTO public.spatial_scenes (
    id, source_scan_id, source_job_id, parent_scene_id, parametric_storage_path,
    parametric_size_bytes, parametric_sha256, schema_version, validation_state,
    is_renderable, requires_user_confirmation, customer_id, provider_id, provider_org_id, metadata
  ) VALUES (
    p_id, p_source_scan_id, p_source_job_id, v_effective_parent, p_parametric_storage_path,
    p_parametric_size_bytes, p_parametric_sha256, coalesce(p_schema_version, '1.0'),
    coalesce(p_validation_state, 'pending'), coalesce(p_is_renderable, false),
    coalesce(p_requires_user_confirmation, false), v_customer_id, v_provider_user_id, v_provider_org_id,
    coalesce(p_metadata, '{}'::jsonb) || CASE
      WHEN p_validation_report IS NOT NULL AND p_validation_report <> '{}'::jsonb
        THEN jsonb_build_object('validation_report', p_validation_report)
      ELSE '{}'::jsonb
    END
  )
  ON CONFLICT (source_scan_id) WHERE source_scan_id IS NOT NULL
  DO NOTHING
  RETURNING * INTO v_scene;

  IF v_scene.id IS NULL THEN
    SELECT * INTO v_scene FROM public.spatial_scenes WHERE source_scan_id = p_source_scan_id;
  END IF;

  IF p_rescan_request_id IS NOT NULL AND v_scene.id IS NOT NULL THEN
    UPDATE public.spatial_rescan_requests
       SET resulting_scene_id = v_scene.id, updated_at = now()
     WHERE id = p_rescan_request_id;
  END IF;

  RETURN v_scene;
END;
$$;


ALTER FUNCTION "public"."spatial_create_scene"("p_id" "uuid", "p_parametric_storage_path" "text", "p_parametric_sha256" "text", "p_parametric_size_bytes" integer, "p_source_scan_id" "uuid", "p_source_job_id" "uuid", "p_schema_version" "text", "p_validation_state" "text", "p_validation_report" "jsonb", "p_is_renderable" boolean, "p_requires_user_confirmation" boolean, "p_metadata" "jsonb", "p_parent_scene_id" "uuid", "p_rescan_request_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_create_scene"("p_id" "uuid", "p_parametric_storage_path" "text", "p_parametric_sha256" "text", "p_parametric_size_bytes" integer, "p_source_scan_id" "uuid", "p_source_job_id" "uuid", "p_schema_version" "text", "p_validation_state" "text", "p_validation_report" "jsonb", "p_is_renderable" boolean, "p_requires_user_confirmation" boolean, "p_metadata" "jsonb", "p_parent_scene_id" "uuid", "p_rescan_request_id" "uuid") IS 'Spatial Canonical B1+B7 (CAD Lane V1.5.1 patch): scene-INSERT path (AD-2). V1.5.1: customer_id falls back to scans.captured_by when source scan is owner_type=customer and no project/job carries an owner.';



CREATE OR REPLACE FUNCTION "public"."spatial_dispute_lock_guard"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_scan_id uuid;
  v_uid     uuid;
BEGIN
  v_uid := auth.uid();

  IF TG_TABLE_NAME = 'scans' THEN
    v_scan_id := COALESCE(NEW.id, OLD.id);
    IF TG_OP = 'UPDATE'
       AND OLD.status = 'locked_for_dispute'
       AND NEW.status <> 'locked_for_dispute'
       AND public.spatial_is_operator(v_uid)
    THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'scan_rooms' THEN
    v_scan_id := COALESCE(NEW.scan_id, OLD.scan_id);
  ELSIF TG_TABLE_NAME = 'scan_measurements' THEN
    v_scan_id := COALESCE(NEW.scan_id, OLD.scan_id);
  ELSIF TG_TABLE_NAME = 'scan_annotations' THEN
    v_scan_id := COALESCE(NEW.scan_id, OLD.scan_id);
  ELSIF TG_TABLE_NAME = 'scan_assets' THEN
    v_scan_id := COALESCE(NEW.scan_id, OLD.scan_id);
  ELSIF TG_TABLE_NAME = 'scan_surfaces' THEN
    v_scan_id := (
      SELECT r.scan_id FROM public.scan_rooms r
      WHERE r.id = COALESCE(NEW.room_id, OLD.room_id)
    );
  ELSE
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF v_scan_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF public.spatial_is_operator(v_uid) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF public.spatial_scan_is_locked(v_scan_id) THEN
    RAISE EXCEPTION
      'scan % is locked_for_dispute - writes blocked (table %)', v_scan_id, TG_TABLE_NAME
      USING ERRCODE = 'P0001';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;


ALTER FUNCTION "public"."spatial_dispute_lock_guard"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_dispute_lock_guard"() IS 'Spatial Core: BEFORE-trigger blocking writes on dispute-locked scans (operator-only unlock path; child-tables also gate INSERT).';



CREATE OR REPLACE FUNCTION "public"."spatial_edit_history_append"("p_scene_id" "uuid", "p_variant_id" "text", "p_base_node_id" "text", "p_override_fields" "jsonb", "p_command" "text", "p_sha_before" "text", "p_sha_after" "text", "p_semantic_op" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid              uuid;
  v_row_id           uuid;
  v_validation       text;
  v_source_scan_id   uuid;
  v_provider_org_id  uuid;
  v_provider_id      uuid;
  v_expected_variant text;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'spatial_edit_history_append: authentication required'
      USING ERRCODE = '28000';
  END IF;

  IF NOT public.spatial_can_view_scene(p_scene_id, v_uid) THEN
    RAISE EXCEPTION
      'spatial_edit_history_append: caller is not a scene-actor (scene=%)', p_scene_id
      USING ERRCODE = '42501';
  END IF;

  SELECT validation_state, source_scan_id, provider_org_id, provider_id
    INTO v_validation, v_source_scan_id, v_provider_org_id, v_provider_id
    FROM public.spatial_scenes
    WHERE id = p_scene_id;
  IF v_validation IS NULL THEN
    RAISE EXCEPTION 'spatial_edit_history_append: scene % not found', p_scene_id
      USING ERRCODE = 'P0002';
  END IF;

  -- H2 · role↔variant guard. Derive the caller's ONE writable variant server-side
  -- (mirror of spatialEditPermissions.resolveWritableVariantId) and reject any
  -- other p_variant_id. INVARIANT: the non-provider→customer_corrections
  -- fallthrough is correct only because spatial_can_view_scene has no org branch.
  IF public.spatial_is_operator(v_uid) THEN
    v_expected_variant := 'operator_review';
  ELSIF v_provider_id IS NOT NULL AND v_uid = v_provider_id THEN
    v_expected_variant := 'provider_' || v_uid::text || '_annotations';
  ELSE
    v_expected_variant := 'customer_corrections';
  END IF;
  IF p_variant_id IS DISTINCT FROM v_expected_variant THEN
    RAISE EXCEPTION
      'spatial_edit_history_append: caller may not write variant % (role-writable variant is %)',
      p_variant_id, v_expected_variant
      USING ERRCODE = '42501';
  END IF;

  IF v_validation = 'blocked' THEN
    RAISE EXCEPTION
      'spatial_edit_history_append: scene % is in validation_state=blocked — edits not permitted',
      p_scene_id
      USING ERRCODE = 'P0001';
  END IF;

  IF v_source_scan_id IS NOT NULL
     AND NOT public.spatial_is_operator(v_uid)
     AND public.spatial_scan_is_locked(v_source_scan_id)
  THEN
    RAISE EXCEPTION
      'spatial_edit_history_append: source scan % is locked_for_dispute — edits blocked',
      v_source_scan_id
      USING ERRCODE = 'P0001';
  END IF;

  IF p_command NOT IN ('set','delete','restore') THEN
    RAISE EXCEPTION
      'spatial_edit_history_append: invalid command %; must be set|delete|restore', p_command
      USING ERRCODE = '22023';
  END IF;

  IF p_semantic_op IS NOT NULL
     AND p_semantic_op NOT IN (
       'move_node','resize_wall','add_door','add_pin','delete_node',
       'snap_object','set_material','move_pin','set_room_height'
     )
  THEN
    RAISE EXCEPTION
      'spatial_edit_history_append: invalid semantic_op %; must be a canonical EditOperation kind',
      p_semantic_op
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.spatial_edit_history (
    scene_id, actor_id, provider_org_id, variant_id, base_node_id,
    override_fields, command, semantic_op,
    parametric_sha256_before, parametric_sha256_after
  )
  VALUES (
    p_scene_id, v_uid, v_provider_org_id, p_variant_id, p_base_node_id,
    p_override_fields, p_command, p_semantic_op,
    p_sha_before, p_sha_after
  )
  RETURNING id INTO v_row_id;

  RETURN v_row_id;
END;
$$;


ALTER FUNCTION "public"."spatial_edit_history_append"("p_scene_id" "uuid", "p_variant_id" "text", "p_base_node_id" "text", "p_override_fields" "jsonb", "p_command" "text", "p_sha_before" "text", "p_sha_after" "text", "p_semantic_op" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_edit_history_append"("p_scene_id" "uuid", "p_variant_id" "text", "p_base_node_id" "text", "p_override_fields" "jsonb", "p_command" "text", "p_sha_before" "text", "p_sha_after" "text", "p_semantic_op" "text") IS 'Spatial Canonical Phase 2-3 + Phase B B-0: SECURITY DEFINER RPC for append-only insert into spatial_edit_history. actor_id = auth.uid(); provider_org_id stamped from the target scene. Returns the inserted row id.';



CREATE OR REPLACE FUNCTION "public"."spatial_get_convert_push_secret"() RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'vault', 'public'
    AS $$
  SELECT decrypted_secret
  FROM vault.decrypted_secrets
  WHERE name = 'spatial_convert_done_push.shared_secret'
  LIMIT 1
$$;


ALTER FUNCTION "public"."spatial_get_convert_push_secret"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_get_convert_push_secret"() IS 'Block J hotfix — Returns the HMAC shared secret for the spatial-convert-done-push edge function. service_role only; anon/authenticated REVOKED.';



CREATE OR REPLACE FUNCTION "public"."spatial_idempotency_cleanup"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.scan_events
  SET idempotency_key = NULL
  WHERE idempotency_key IS NOT NULL
    AND at < now() - interval '90 days';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;


ALTER FUNCTION "public"."spatial_idempotency_cleanup"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_idempotency_cleanup"() IS 'Spatial Core: nulls scan_events.idempotency_key entries older than 90 days. Run nightly by pg_cron job spatial_idempotency_cleanup_nightly.';



CREATE OR REPLACE FUNCTION "public"."spatial_is_customer_viewer"("p_scan_id" "uuid", "p_uid" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT
    NOT public.spatial_is_operator(p_uid)
    AND EXISTS (
      SELECT 1
      FROM public.scans s
      LEFT JOIN public.jobs j ON j.id = s.job_id
      WHERE s.id = p_scan_id
        AND COALESCE(j.craftsman_user_id, '') <> p_uid::text
        AND NOT EXISTS (
          SELECT 1
          FROM public.job_assignments ja
          JOIN public.team_members    tm ON tm.id = ja.team_member_id
          WHERE ja.job_id     = s.job_id
            AND tm.profile_id = p_uid
            AND tm.is_active  = true
            AND ja.status IN ('assigned','accepted','active','in_progress','completed')
        )
        AND (
          (s.shared_with_customer = true AND s.job_id IS NOT NULL AND j.customer_user_id = p_uid)
          OR (s.owner_type = 'customer' AND s.captured_by = p_uid)
        )
    );
$$;


ALTER FUNCTION "public"."spatial_is_customer_viewer"("p_scan_id" "uuid", "p_uid" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_is_customer_viewer"("p_scan_id" "uuid", "p_uid" "uuid") IS 'Lane 3 V1.6 Block 3: returns true only when the viewer is a pure customer (HW-shared scan customer or Self-Scan owner) — never for HW owners, workers, or operators. Used by scan_annotations_select to enforce customer_visible filter.';



CREATE OR REPLACE FUNCTION "public"."spatial_is_job_craftsman"("p_scan_id" "uuid", "p_uid" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.scans s
    JOIN public.jobs  j ON j.id = s.job_id
    WHERE s.id = p_scan_id
      AND j.craftsman_user_id = p_uid::text
  );
$$;


ALTER FUNCTION "public"."spatial_is_job_craftsman"("p_scan_id" "uuid", "p_uid" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_is_job_craftsman"("p_scan_id" "uuid", "p_uid" "uuid") IS 'Spatial Core RLS helper: craftsman of the scan-linked job.';



CREATE OR REPLACE FUNCTION "public"."spatial_is_job_worker"("p_scan_id" "uuid", "p_uid" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.scans            s
    JOIN public.job_assignments  ja ON ja.job_id     = s.job_id
    JOIN public.team_members     tm ON tm.id         = ja.team_member_id
    WHERE s.id = p_scan_id
      AND tm.profile_id = p_uid
      AND tm.is_active  = true
      AND ja.status     IN ('assigned', 'accepted', 'active', 'in_progress', 'completed')
  );
$$;


ALTER FUNCTION "public"."spatial_is_job_worker"("p_scan_id" "uuid", "p_uid" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_is_job_worker"("p_scan_id" "uuid", "p_uid" "uuid") IS 'Spatial Core RLS helper: worker assigned to the scan-linked job via team_members.';



CREATE OR REPLACE FUNCTION "public"."spatial_is_operator"("p_uid" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_uid AND is_operator = true);
$$;


ALTER FUNCTION "public"."spatial_is_operator"("p_uid" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_is_operator"("p_uid" "uuid") IS 'Spatial Core RLS helper: operator check.';



CREATE OR REPLACE FUNCTION "public"."spatial_log_provider_share_action"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_action text;
  v_actor  uuid;
BEGIN
  IF OLD.shared_with_provider_id IS NOT DISTINCT FROM NEW.shared_with_provider_id THEN
    RETURN NEW;
  END IF;
  v_action := CASE
    WHEN NEW.shared_with_provider_id IS NOT NULL THEN 'shared'
    ELSE 'unshared'
  END;
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.shared_with_provider_id IS NOT NULL THEN
    NEW.shared_with_provider_at := now();
  ELSE
    NEW.shared_with_provider_at := NULL;
  END IF;
  INSERT INTO public.spatial_share_audit (scan_id, actor_user_id, action, job_id)
  VALUES (NEW.id, v_actor, v_action, NEW.job_id);
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."spatial_log_provider_share_action"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spatial_log_share_action"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_action text;
  v_actor  uuid;
BEGIN
  IF OLD.shared_with_customer = NEW.shared_with_customer THEN
    RETURN NEW;
  END IF;

  v_action := CASE
    WHEN NEW.shared_with_customer = true  THEN 'shared'
    WHEN NEW.shared_with_customer = false THEN 'unshared'
  END;

  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.shared_with_customer = true THEN
    NEW.shared_at := now();
  ELSE
    NEW.shared_at := NULL;
  END IF;

  INSERT INTO public.spatial_share_audit (scan_id, actor_user_id, action, job_id)
  VALUES (NEW.id, v_actor, v_action, NEW.job_id);

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."spatial_log_share_action"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_log_share_action"() IS 'Lane 3 V1.6: BEFORE UPDATE trigger on scans.shared_with_customer. Appends to spatial_share_audit (SECURITY DEFINER bypasses REVOKE). Also stamps/clears scans.shared_at in the same transaction.';



CREATE OR REPLACE FUNCTION "public"."spatial_mesh_snapshot_scan_id"("p_object_name" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public', 'storage'
    AS $$
DECLARE
  v_filename text;
  v_scan_id  text;
BEGIN
  v_filename := storage.filename(p_object_name);
  v_scan_id  := split_part(v_filename, '.', 1);
  IF v_scan_id IS NULL OR v_scan_id = '' THEN
    RETURN NULL;
  END IF;
  RETURN v_scan_id::uuid;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;


ALTER FUNCTION "public"."spatial_mesh_snapshot_scan_id"("p_object_name" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_mesh_snapshot_scan_id"("p_object_name" "text") IS 'V1.6 Phase 2: extracts the scan_id segment of a spatial-mesh-snapshots object path as uuid. Path convention: {user_id}/{scan_id}.usdz - filename without extension = scan_id. Returns NULL on malformed input. Used by spatial_can_view_mesh_snapshot helper.';



CREATE OR REPLACE FUNCTION "public"."spatial_notify_convert_done"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'vault'
    AS $$
DECLARE
  v_user_id   uuid;
  v_url       text;
  v_secret    text;
  v_body      jsonb;
  v_signature text;
BEGIN
  IF NEW.kind <> 'gltf' THEN RETURN NEW; END IF;
  SELECT s.captured_by INTO v_user_id FROM public.scans s WHERE s.id = NEW.scan_id;
  IF v_user_id IS NULL THEN RETURN NEW; END IF;
  SELECT decrypted_secret INTO v_url
  FROM vault.decrypted_secrets WHERE name = 'spatial_convert_done_push.url';
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name = 'spatial_convert_done_push.shared_secret';
  IF v_url IS NULL OR v_secret IS NULL THEN
    RAISE NOTICE 'spatial_notify_convert_done: vault config missing, skipping';
    RETURN NEW;
  END IF;
  v_body := jsonb_build_object('scan_id', NEW.scan_id, 'asset_id', NEW.id, 'user_id', v_user_id);
  v_signature := encode(extensions.hmac(v_body::text::bytea, v_secret::bytea, 'sha256'), 'hex');
  PERFORM net.http_post(
    url := v_url,
    body := v_body,
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-spatial-convert-signature', v_signature
    )
  );
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."spatial_notify_convert_done"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_notify_convert_done"() IS 'Block J hotfix — Fires spatial-convert-done-push Edge Function on glTF asset INSERT. Uses vault.decrypted_secrets (spatial_convert_done_push.url + .shared_secret) and HMAC-SHA256 signature. Missing vault rows = silent no-op.';



CREATE OR REPLACE FUNCTION "public"."spatial_parametric_cleanup_dispatch"() RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'vault', 'extensions'
    AS $$
declare
  v_url        text;
  v_secret     text;
  v_request_id bigint;
  v_lock       boolean;
begin
  v_lock := pg_try_advisory_lock(hashtext('spatial_parametric_cleanup'));
  if not v_lock then
    raise notice 'spatial-parametric-cleanup: skipped (concurrent run)';
    return null;
  end if;

  begin
    select decrypted_secret into v_url
      from vault.decrypted_secrets where name = 'spatial_parametric_cleanup.url' limit 1;
    -- Shared FIXUP_TRIGGER_SHARED_SECRET value (account-cascade seeds the prod env).
    select decrypted_secret into v_secret
      from vault.decrypted_secrets where name = 'account_cascade_cleanup.shared_secret' limit 1;
  exception when others then
    raise notice 'spatial-parametric-cleanup: vault unavailable (%, %) — skipping', sqlstate, sqlerrm;
    return null;
  end;

  if v_url is null or v_secret is null then
    raise notice 'spatial-parametric-cleanup: vault entries missing — skipping';
    return null;
  end if;

  begin
    select net.http_post(
      url     := v_url,
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-fixup-trigger-secret', v_secret
      ),
      body    := jsonb_build_object('source', 'cron', 'grace_days', 7, 'max_files', 500),
      timeout_milliseconds := 30000
    ) into v_request_id;
  exception when others then
    raise notice 'spatial-parametric-cleanup: pg_net.http_post failed (%, %)', sqlstate, sqlerrm;
    return null;
  end;

  return v_request_id;
end;
$$;


ALTER FUNCTION "public"."spatial_parametric_cleanup_dispatch"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_parametric_cleanup_dispatch"() IS 'Spatial V1.6.1 L4.c · pg_cron dispatch for parametric-cleanup Edge Function.';



CREATE OR REPLACE FUNCTION "public"."spatial_parametric_cleanup_list_orphans"("p_grace_days" integer DEFAULT 7, "p_limit" integer DEFAULT 500) RETURNS TABLE("object_name" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'storage', 'extensions'
    AS $$
declare
  v_grace  integer := greatest(0, coalesce(p_grace_days, 7));
  v_limit  integer := greatest(0, least(coalesce(p_limit, 500), 5000));
  v_cutoff timestamptz := now() - make_interval(days => v_grace);
begin
  return query
    select o.name::text
    from storage.objects o
    where o.bucket_id = 'spatial-parametric'
      and o.created_at is not null
      and o.created_at < v_cutoff
      and not exists (
        select 1 from public.spatial_scenes s
        where s.parametric_storage_path = o.name
      )
    order by o.created_at asc
    limit v_limit;
end;
$$;


ALTER FUNCTION "public"."spatial_parametric_cleanup_list_orphans"("p_grace_days" integer, "p_limit" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_parametric_cleanup_list_orphans"("p_grace_days" integer, "p_limit" integer) IS 'Spatial V1.6.1 L4.c · Lists spatial-parametric orphan blobs older than grace. Service-role only.';



CREATE OR REPLACE FUNCTION "public"."spatial_parametric_scene_id"("p_object_name" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public', 'storage'
    AS $$
DECLARE
  v_seg text;
BEGIN
  v_seg := (storage.foldername(p_object_name))[2];
  IF v_seg IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN v_seg::uuid;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;


ALTER FUNCTION "public"."spatial_parametric_scene_id"("p_object_name" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_parametric_scene_id"("p_object_name" "text") IS 'Spatial Phase C (C-2): extracts the {sceneId} segment of a spatial-parametric object path as uuid, NULL on malformed input. Used by the storage.objects SELECT policy.';



CREATE OR REPLACE FUNCTION "public"."spatial_realtime_uuid_pat"() RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'pg_catalog'
    AS $$ SELECT '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' $$;


ALTER FUNCTION "public"."spatial_realtime_uuid_pat"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_realtime_uuid_pat"() IS 'Spatial Core: lowercase-uuid regex fragment used in realtime.messages RLS policies to prevent prefix-wildcard topic leaks.';



CREATE OR REPLACE FUNCTION "public"."spatial_reap_stuck_download_jobs"() RETURNS TABLE("failed" integer, "deleted" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_failed  int := 0;
  v_deleted int := 0;
BEGIN
  WITH up AS (
    UPDATE public.download_jobs
    SET status = 'failed',
        error_message = COALESCE(error_message, 'reaper: stuck > timeout'),
        completed_at  = now()
    WHERE (status = 'pending'    AND requested_at < now() - interval '30 minutes')
       OR (status = 'processing' AND requested_at < now() - interval '60 minutes')
    RETURNING 1
  )
  SELECT count(*) INTO v_failed FROM up;
  WITH del AS (
    DELETE FROM public.download_jobs
    WHERE status IN ('ready','failed')
      AND requested_at < now() - interval '7 days'
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM del;
  RETURN QUERY SELECT v_failed, v_deleted;
END $$;


ALTER FUNCTION "public"."spatial_reap_stuck_download_jobs"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spatial_rescan_request_respond"("p_request_id" "uuid", "p_status" "text", "p_note" "text" DEFAULT NULL::"text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid        uuid;
  v_cur_status text;
  v_customer   uuid;
  v_scene_id   uuid;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'spatial_rescan_request_respond: authentication required'
      USING ERRCODE = '28000';
  END IF;

  IF p_status NOT IN ('accepted','rejected') THEN
    RAISE EXCEPTION
      'spatial_rescan_request_respond: invalid status %; must be accepted|rejected',
      p_status
      USING ERRCODE = '22023';
  END IF;

  SELECT r.status, r.scene_id
    INTO v_cur_status, v_scene_id
    FROM public.spatial_rescan_requests r
    WHERE r.id = p_request_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'spatial_rescan_request_respond: request % not found', p_request_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_cur_status <> 'pending' THEN
    RETURN false;
  END IF;

  SELECT s.customer_id INTO v_customer
    FROM public.spatial_scenes s
    WHERE s.id = v_scene_id;
  IF v_customer IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION
      'spatial_rescan_request_respond: caller is not the scene customer (scene=%)',
      v_scene_id
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.spatial_rescan_requests
     SET status        = p_status,
         response_note = p_note,
         responded_at  = now(),
         updated_at    = now()
   WHERE id = p_request_id;

  RETURN true;
END;
$$;


ALTER FUNCTION "public"."spatial_rescan_request_respond"("p_request_id" "uuid", "p_status" "text", "p_note" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_rescan_request_respond"("p_request_id" "uuid", "p_status" "text", "p_note" "text") IS 'Spatial Phase C (C-1): SECURITY DEFINER RPC — sole write path for spatial_rescan_requests status transitions. Validates auth.uid() = spatial_scenes.customer_id; only pending rows are transitionable (idempotent no-op otherwise). Returns true when applied, false on no-op.';



CREATE OR REPLACE FUNCTION "public"."spatial_scan_broadcast"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public', 'realtime'
    AS $$
DECLARE
  v_scan_id    uuid;
  v_project_id uuid;
  v_payload    jsonb;
BEGIN
  v_scan_id    := COALESCE(NEW.id, OLD.id);
  v_project_id := COALESCE(NEW.project_id, OLD.project_id);

  v_payload := jsonb_build_object(
    'op',         TG_OP,
    'id',         v_scan_id,
    'status',     COALESCE(NEW.status, OLD.status),
    'project_id', v_project_id,
    'job_id',     COALESCE(NEW.job_id, OLD.job_id),
    'updated_at', COALESCE(NEW.updated_at, OLD.updated_at)
  );

  PERFORM realtime.send(v_payload, TG_OP, 'scan:' || v_scan_id::text, true);
  IF v_project_id IS NOT NULL THEN
    PERFORM realtime.send(v_payload, TG_OP, 'project:' || v_project_id::text || ':scans', true);
  END IF;

  RETURN NULL;
END;
$$;


ALTER FUNCTION "public"."spatial_scan_broadcast"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_scan_broadcast"() IS 'Spatial Core: lean per-row broadcast to scan:{id} + project:{id}:scans topics on INSERT/UPDATE/DELETE of public.scans. Payload is metadata only — clients re-fetch detail on receipt.';



CREATE OR REPLACE FUNCTION "public"."spatial_scan_cleanup_dispatch"() RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'vault', 'extensions'
    AS $$
declare
  v_url        text;
  v_secret     text;
  v_request_id bigint;
  v_lock       boolean;
begin
  v_lock := pg_try_advisory_lock(hashtext('spatial_scan_cleanup'));
  if not v_lock then
    raise notice 'spatial-scan-cleanup: skipped (concurrent run)';
    return null;
  end if;

  begin
    select decrypted_secret into v_url
      from vault.decrypted_secrets where name = 'spatial_scan_cleanup.url' limit 1;
    select decrypted_secret into v_secret
      from vault.decrypted_secrets where name = 'account_cascade_cleanup.shared_secret' limit 1;
  exception when others then
    raise notice 'spatial-scan-cleanup: vault unavailable (%, %) — skipping', sqlstate, sqlerrm;
    return null;
  end;

  if v_url is null or v_secret is null then
    raise notice 'spatial-scan-cleanup: vault entries missing — skipping';
    return null;
  end if;

  begin
    select net.http_post(
      url     := v_url,
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-fixup-trigger-secret', v_secret
      ),
      body    := jsonb_build_object('source', 'cron', 'retention_days', 90, 'max_files', 500),
      timeout_milliseconds := 30000
    ) into v_request_id;
  exception when others then
    raise notice 'spatial-scan-cleanup: pg_net.http_post failed (%, %)', sqlstate, sqlerrm;
    return null;
  end;

  return v_request_id;
end;
$$;


ALTER FUNCTION "public"."spatial_scan_cleanup_dispatch"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_scan_cleanup_dispatch"() IS 'Spatial · pg_cron dispatch — looks up Vault (spatial_scan_cleanup.url + reused account_cascade_cleanup.shared_secret) and fires async pg_net POST to the spatial-scan-cleanup Edge Function. Returns the pg_net request_id (NULL on skip). EXCEPTION WHEN OTHERS so cron is never marked failed.';



CREATE OR REPLACE FUNCTION "public"."spatial_scan_cleanup_list_expired"("p_retention_days" integer DEFAULT 90, "p_limit" integer DEFAULT 500) RETURNS TABLE("object_name" "text", "size_bytes" bigint)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'storage', 'extensions'
    AS $$
declare
  v_retention integer := greatest(1, coalesce(p_retention_days, 90));
  v_limit     integer := greatest(0, least(coalesce(p_limit, 500), 5000));
  v_cutoff    timestamptz := now() - make_interval(days => v_retention);
begin
  return query
    select
      sa.storage_path::text                         as object_name,
      coalesce((o.metadata->>'size')::bigint, 0)    as size_bytes
    from public.scan_assets sa
    join public.scans s on s.id = sa.scan_id
    left join storage.objects o
      on o.bucket_id = 'project-scans' and o.name = sa.storage_path
    where s.status = 'archived'
      and s.archived_at is not null
      and s.archived_at < v_cutoff
      and sa.kind <> 'worldmap'
    order by s.archived_at asc
    limit v_limit;
end;
$$;


ALTER FUNCTION "public"."spatial_scan_cleanup_list_expired"("p_retention_days" integer, "p_limit" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_scan_cleanup_list_expired"("p_retention_days" integer, "p_limit" integer) IS 'Spatial · Lists scan_assets storage paths for scans archived > p_retention_days (default 90, kind<>worldmap). Tied to archived status, not raw blob age. Returns (object_name=storage_path, size_bytes) capped at p_limit (default 500, max 5000). Service-role only. Replaces spatial_storage_lifecycle. The Edge fn removes blob + deletes the row.';



CREATE OR REPLACE FUNCTION "public"."spatial_scan_cleanup_list_orphans"("p_limit" integer DEFAULT 500) RETURNS TABLE("object_name" "text", "size_bytes" bigint)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'storage', 'extensions'
    AS $$
declare
  v_limit integer := greatest(0, least(coalesce(p_limit, 500), 5000));
begin
  return query
    select
      o.name::text                                  as object_name,
      coalesce((o.metadata->>'size')::bigint, 0)    as size_bytes
    from storage.objects o
    where o.bucket_id = 'project-scans'
      and o.name ~ '^[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}/'
      and not exists (
        select 1 from public.scans s
        where s.id::text = split_part(o.name, '/', 2)
      )
    order by o.created_at asc nulls first
    limit v_limit;
end;
$$;


ALTER FUNCTION "public"."spatial_scan_cleanup_list_orphans"("p_limit" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_scan_cleanup_list_orphans"("p_limit" integer) IS 'Spatial · Lists project-scans blobs whose scan_id (path segment 2) no longer exists in public.scans. Well-formed <uuid>/<uuid>/ paths only. Returns (object_name, size_bytes) capped at p_limit (default 500, max 5000). Service-role only. Drives the spatial-scan-cleanup Edge Function.';



CREATE OR REPLACE FUNCTION "public"."spatial_scan_event_broadcast"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public', 'realtime'
    AS $$
DECLARE
  v_project_id uuid;
  v_payload    jsonb;
BEGIN
  SELECT project_id INTO v_project_id FROM public.scans WHERE id = NEW.scan_id;

  v_payload := jsonb_build_object(
    'op',        'INSERT',
    'kind',      'scan_event',
    'id',        NEW.id,
    'scan_id',   NEW.scan_id,
    'action',    NEW.action,
    'actor_id',  NEW.actor_id,
    'at',        NEW.at
  );

  PERFORM realtime.send(v_payload, 'scan_event', 'scan:' || NEW.scan_id::text, true);
  IF v_project_id IS NOT NULL THEN
    PERFORM realtime.send(v_payload, 'scan_event', 'project:' || v_project_id::text || ':scans', true);
  END IF;

  RETURN NULL;
END;
$$;


ALTER FUNCTION "public"."spatial_scan_event_broadcast"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_scan_event_broadcast"() IS 'Spatial Core: broadcasts scan_events.INSERT to scan + project topics. Read via spatial_can_view_scan-gated channel auth.';



CREATE OR REPLACE FUNCTION "public"."spatial_scan_is_locked"("p_scan_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (SELECT 1 FROM public.scans WHERE id = p_scan_id AND status = 'locked_for_dispute');
$$;


ALTER FUNCTION "public"."spatial_scan_is_locked"("p_scan_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_scan_is_locked"("p_scan_id" "uuid") IS 'Spatial Core RLS helper: scan in dispute-locked state.';



CREATE OR REPLACE FUNCTION "public"."spatial_scan_quality_broadcast"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public', 'realtime'
    AS $$
DECLARE
  v_project_id uuid;
  v_payload    jsonb;
BEGIN
  SELECT project_id INTO v_project_id FROM public.scans WHERE id = NEW.scan_id;

  v_payload := jsonb_build_object(
    'op',           'INSERT',
    'kind',         'quality_report',
    'id',           NEW.id,
    'scan_id',      NEW.scan_id,
    'score',        NEW.score,
    'bucket',       NEW.bucket,
    'generated_at', NEW.generated_at
  );

  PERFORM realtime.send(v_payload, 'quality_report', 'scan:' || NEW.scan_id::text, true);
  IF v_project_id IS NOT NULL THEN
    PERFORM realtime.send(v_payload, 'quality_report', 'project:' || v_project_id::text || ':scans', true);
  END IF;

  RETURN NULL;
END;
$$;


ALTER FUNCTION "public"."spatial_scan_quality_broadcast"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_scan_quality_broadcast"() IS 'Spatial Core: broadcasts scan_quality_reports.INSERT for instant UI bucket-update without re-fetch.';



CREATE OR REPLACE FUNCTION "public"."spatial_scan_storage_path_ok"("p_name" "text") RETURNS boolean
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'pg_catalog'
    AS $_$
DECLARE
  v_parts text[];
  v_kind  text;
  v_file  text;
  v_lower text;
BEGIN
  IF position('..' in p_name) <> 0 THEN
    RETURN false;
  END IF;
  v_parts := storage.foldername(p_name);
  IF array_length(v_parts, 1) IS NULL OR array_length(v_parts, 1) < 3 THEN
    RETURN false;
  END IF;
  v_kind := v_parts[3];
  v_file := substring(p_name from '[^/]+$');
  v_lower := lower(coalesce(v_file, ''));
  RETURN CASE v_kind
    WHEN 'usdz'          THEN v_lower LIKE '%.usdz'
    WHEN 'gltf'          THEN v_lower LIKE '%.glb' OR v_lower LIKE '%.gltf'
    WHEN 'scan_json'     THEN v_lower LIKE '%.json'
    WHEN 'mesh_summary'  THEN v_lower LIKE '%.json'
    WHEN 'thumbnail'     THEN v_lower LIKE '%.png' OR v_lower LIKE '%.jpg' OR v_lower LIKE '%.jpeg' OR v_lower LIKE '%.webp'
    WHEN 'floorplan_svg' THEN v_lower LIKE '%.svg'
    WHEN 'worldmap'      THEN v_lower LIKE '%.bin'
    WHEN 'photo'         THEN v_lower LIKE '%.jpg' OR v_lower LIKE '%.jpeg' OR v_lower LIKE '%.png' OR v_lower LIKE '%.webp' OR v_lower LIKE '%.heic'
    WHEN 'voice'         THEN v_lower LIKE '%.m4a' OR v_lower LIKE '%.aac' OR v_lower LIKE '%.mp4' OR v_lower LIKE '%.webm' OR v_lower LIKE '%.wav'
    WHEN 'export'        THEN v_lower LIKE '%.pdf' OR v_lower LIKE '%.svg' OR v_lower LIKE '%.json'
    ELSE false
  END;
END;
$_$;


ALTER FUNCTION "public"."spatial_scan_storage_path_ok"("p_name" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_scan_storage_path_ok"("p_name" "text") IS 'Spatial Core: validates a project-scans Storage object name matches schema {user}/{scan}/{kind}/file.ext with kind/ext allowlist and no path-traversal.';



CREATE OR REPLACE FUNCTION "public"."spatial_scenes_customer_verify_fsm_guard"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
DECLARE v_allowed text[];
BEGIN
  IF NEW.customer_verify_state = OLD.customer_verify_state THEN RETURN NEW; END IF;
  v_allowed := CASE OLD.customer_verify_state
    WHEN 'not_started'  THEN ARRAY['in_progress']
    WHEN 'in_progress'  THEN ARRAY['approved','rejected','expired']
    WHEN 'approved'     THEN ARRAY['not_started']
    WHEN 'rejected'     THEN ARRAY['in_progress']
    WHEN 'expired'      THEN ARRAY['in_progress']
    ELSE ARRAY[]::text[]
  END;
  IF NOT (NEW.customer_verify_state = ANY(v_allowed)) THEN
    RAISE EXCEPTION 'SPATIAL_FSM_VIOLATION: illegal customer_verify_state transition % to % (scene=%)',
      OLD.customer_verify_state, NEW.customer_verify_state, OLD.id USING ERRCODE = '45SPF';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."spatial_scenes_customer_verify_fsm_guard"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spatial_scenes_fill_provider_org"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NEW.provider_id IS NOT NULL THEN
    IF NEW.provider_org_id IS NULL
       OR (TG_OP = 'UPDATE' AND NEW.provider_id IS DISTINCT FROM OLD.provider_id)
    THEN
      NEW.provider_org_id := (
        SELECT p.id FROM public.providers p
        WHERE p.profile_id = NEW.provider_id
        LIMIT 1
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."spatial_scenes_fill_provider_org"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_scenes_fill_provider_org"() IS 'Provider Spatial Hub B-0: BEFORE INSERT/UPDATE trigger — keeps spatial_scenes.provider_org_id derived from provider_id so the column is self-maintaining.';



CREATE OR REPLACE FUNCTION "public"."spatial_scenes_immutable_cols_guard"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
  IF NEW.id <> OLD.id THEN
    RAISE EXCEPTION 'SPATIAL_FSM_VIOLATION: spatial_scenes.id is immutable (scene=%)', OLD.id
      USING ERRCODE = '45SPF';
  END IF;
  IF (NEW.source_scan_id IS DISTINCT FROM OLD.source_scan_id) THEN
    RAISE EXCEPTION 'SPATIAL_FSM_VIOLATION: spatial_scenes.source_scan_id is immutable (scene=%)', OLD.id
      USING ERRCODE = '45SPF';
  END IF;
  IF (NEW.source_job_id IS DISTINCT FROM OLD.source_job_id) THEN
    RAISE EXCEPTION 'SPATIAL_FSM_VIOLATION: spatial_scenes.source_job_id is immutable (scene=%)', OLD.id
      USING ERRCODE = '45SPF';
  END IF;
  IF (NEW.parent_scene_id IS DISTINCT FROM OLD.parent_scene_id) THEN
    RAISE EXCEPTION 'SPATIAL_FSM_VIOLATION: spatial_scenes.parent_scene_id is immutable (scene=%)', OLD.id
      USING ERRCODE = '45SPF';
  END IF;
  IF NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'SPATIAL_FSM_VIOLATION: spatial_scenes.created_at is immutable (scene=%)', OLD.id
      USING ERRCODE = '45SPF';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."spatial_scenes_immutable_cols_guard"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_scenes_immutable_cols_guard"() IS 'BEFORE UPDATE guard on spatial_scenes: id / source_scan_id / source_job_id / parent_scene_id / created_at are append-only. Re-entrant trigger depth > 1 is exempt (allows SECURITY DEFINER helpers to back-fill on insert).';



CREATE OR REPLACE FUNCTION "public"."spatial_scenes_validation_state_fsm_guard"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
DECLARE v_allowed text[];
BEGIN
  IF NEW.validation_state = OLD.validation_state THEN RETURN NEW; END IF;
  v_allowed := CASE OLD.validation_state
    WHEN 'pending'              THEN ARRAY['passed','passed_with_warnings','blocked']
    WHEN 'passed'               THEN ARRAY['re_review','blocked']
    WHEN 'passed_with_warnings' THEN ARRAY['passed','re_review','blocked']
    WHEN 'blocked'              THEN ARRAY['re_review','pending']
    WHEN 're_review'            THEN ARRAY['passed','passed_with_warnings','blocked']
    ELSE ARRAY[]::text[]
  END;
  IF NOT (NEW.validation_state = ANY(v_allowed)) THEN
    RAISE EXCEPTION 'SPATIAL_FSM_VIOLATION: illegal validation_state transition % to % (scene=%)',
      OLD.validation_state, NEW.validation_state, OLD.id USING ERRCODE = '45SPF';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."spatial_scenes_validation_state_fsm_guard"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spatial_set_customer_verify_state"("p_scene_id" "uuid", "p_state" "text" DEFAULT NULL::"text", "p_stage" integer DEFAULT NULL::integer) RETURNS "public"."spatial_scenes"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid            uuid;
  v_customer_id    uuid;
  v_source_scan_id uuid;
  v_scene          public.spatial_scenes;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'spatial_set_customer_verify_state: authentication required'
      USING ERRCODE = '28000';
  END IF;

  IF p_state IS NOT NULL
     AND p_state NOT IN ('not_started','in_progress','approved','rejected','expired')
  THEN
    RAISE EXCEPTION 'spatial_set_customer_verify_state: invalid state %', p_state
      USING ERRCODE = '22023';
  END IF;
  IF p_stage IS NOT NULL AND (p_stage < 1 OR p_stage > 5) THEN
    RAISE EXCEPTION 'spatial_set_customer_verify_state: invalid stage % (must be 1-5)', p_stage
      USING ERRCODE = '22023';
  END IF;

  SELECT customer_id, source_scan_id
    INTO v_customer_id, v_source_scan_id
    FROM public.spatial_scenes
    WHERE id = p_scene_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'spatial_set_customer_verify_state: scene % not found', p_scene_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Customer-recipient gate (NOT the provider). Mirrors the customer branches
  -- of spatial_can_view_scene. The customer_id equality is NULL-guarded: a
  -- self-scan scene has customer_id IS NULL, and a bare `v_uid = NULL` would
  -- poison the whole OR chain to NULL and silently skip the RAISE.
  IF NOT (
    public.spatial_is_operator(v_uid)
    OR (v_customer_id IS NOT NULL AND v_uid = v_customer_id)
    OR (
      v_source_scan_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.scans sc
        JOIN public.jobs  j ON j.id = sc.job_id
        WHERE sc.id = v_source_scan_id
          AND sc.shared_with_customer = true
          AND j.customer_user_id = v_uid
      )
    )
    OR (
      v_customer_id IS NULL
      AND v_source_scan_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.scans sc
        WHERE sc.id = v_source_scan_id
          AND sc.owner_type = 'customer'
          AND sc.captured_by = v_uid
      )
    )
  ) THEN
    RAISE EXCEPTION
      'spatial_set_customer_verify_state: caller is not the scene customer (scene=%)', p_scene_id
      USING ERRCODE = '42501';
  END IF;

  -- Column-scoped write — ONLY the verify tracking columns, NEVER the blob.
  UPDATE public.spatial_scenes
     SET customer_verify_state         = COALESCE(p_state, customer_verify_state),
         customer_verify_last_stage     = COALESCE(p_stage, customer_verify_last_stage),
         customer_verify_last_active_at = now()
   WHERE id = p_scene_id
  RETURNING * INTO v_scene;

  RETURN v_scene;
END;
$$;


ALTER FUNCTION "public"."spatial_set_customer_verify_state"("p_scene_id" "uuid", "p_state" "text", "p_stage" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."spatial_user_org_owner_profile"("p_uid" "uuid") RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT p.profile_id
    FROM public.providers p
   WHERE p.id = public.spatial_user_provider_org(p_uid)
     AND p.profile_id IS NOT NULL
   LIMIT 1;
$$;


ALTER FUNCTION "public"."spatial_user_org_owner_profile"("p_uid" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_user_org_owner_profile"("p_uid" "uuid") IS 'Resolves a user (owner-direct OR active team_member) to their provider-org owner profile_id. SECURITY DEFINER so RLS-policies on providers do not hide the lookup. Returns NULL when the user is not part of any active provider-org.';



CREATE OR REPLACE FUNCTION "public"."spatial_user_provider_org"("p_uid" "uuid") RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT COALESCE(
    (SELECT p.id FROM public.providers p WHERE p.profile_id = p_uid LIMIT 1),
    (SELECT tm.provider_id FROM public.team_members tm
       WHERE tm.profile_id = p_uid AND tm.is_active = true LIMIT 1)
  );
$$;


ALTER FUNCTION "public"."spatial_user_provider_org"("p_uid" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_user_provider_org"("p_uid" "uuid") IS 'Provider Spatial Hub: resolves an auth user to their provider business id (public.providers.id). Owner via providers.profile_id; otherwise active team_members.provider_id. NULL for non-provider users.';



CREATE OR REPLACE FUNCTION "public"."spatial_user_team_role"("p_uid" "uuid", "p_provider_org_id" "uuid") RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT CASE
    WHEN p_uid IS NULL OR p_provider_org_id IS NULL THEN NULL
    WHEN EXISTS (
      SELECT 1 FROM public.providers p
      WHERE p.id = p_provider_org_id AND p.profile_id = p_uid
    ) THEN 'owner'
    ELSE (
      SELECT tm.role FROM public.team_members tm
      WHERE tm.profile_id = p_uid
        AND tm.provider_id = p_provider_org_id
        AND tm.is_active = true
      LIMIT 1
    )
  END;
$$;


ALTER FUNCTION "public"."spatial_user_team_role"("p_uid" "uuid", "p_provider_org_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_user_team_role"("p_uid" "uuid", "p_provider_org_id" "uuid") IS 'Provider Spatial Hub (spec 2.1/2.2): a user role within a provider org — owner for the business owner (Foreman), else team_members.role, else NULL. Consumed by the workflow-layer RBAC guard.';



CREATE OR REPLACE FUNCTION "public"."spatial_verify_reminder_tick"() RETURNS TABLE("reminders_due" integer, "signals_emitted" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_due       int := 0;
  v_emitted   int := 0;
  v_channel   text;
  v_elapsed   interval;
  r_scene     record;
BEGIN
  FOR r_scene IN
    SELECT s.id                                    AS scene_id,
           s.source_job_id                         AS source_job_id,
           s.customer_verify_last_active_at         AS last_active_at,
           s.customer_verify_last_reminder_sent_at  AS last_reminder_sent_at,
           s.customer_verify_last_reminder_channel  AS last_reminder_channel
    FROM public.spatial_scenes s
    WHERE s.customer_verify_state IN ('not_started','in_progress')
      AND s.customer_verify_last_active_at IS NOT NULL
      AND now() - s.customer_verify_last_active_at >= interval '24 hours'
      AND (s.source_scan_id IS NULL OR NOT public.spatial_scan_is_locked(s.source_scan_id))
  LOOP
    v_elapsed := now() - r_scene.last_active_at;
    IF v_elapsed >= interval '72 hours' THEN
      v_channel := 'email';
    ELSE
      v_channel := 'push';
    END IF;

    IF r_scene.last_reminder_channel IS NOT NULL
       AND r_scene.last_reminder_sent_at IS NOT NULL
       AND r_scene.last_active_at <= r_scene.last_reminder_sent_at
       AND r_scene.last_reminder_channel = v_channel THEN
      CONTINUE;
    END IF;

    v_due := v_due + 1;

    BEGIN
      IF r_scene.source_job_id IS NOT NULL THEN
        INSERT INTO public.notification_signals
          (job_id, type, priority, read, occurred_at,
           recipient_role, entity_id, entity_type, action_type)
        VALUES
          (r_scene.source_job_id, 'spatial_verify_reminder', 'low', false,
           (extract(epoch FROM now()) * 1000)::bigint,
           'customer', r_scene.scene_id::text, 'spatial_scene', 'open_verify');
        v_emitted := v_emitted + 1;
      END IF;

      UPDATE public.spatial_scenes
         SET customer_verify_last_reminder_sent_at = now(),
             customer_verify_last_reminder_channel = v_channel
       WHERE id = r_scene.scene_id;
    EXCEPTION WHEN OTHERS THEN
      CONTINUE;
    END;
  END LOOP;

  RETURN QUERY SELECT v_due, v_emitted;
END;
$$;


ALTER FUNCTION "public"."spatial_verify_reminder_tick"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."spatial_verify_reminder_tick"() IS 'Spatial Canonical Block 3.11 (VF-4): hourly verify-reminder scheduler. Scans spatial_scenes for an unfinished customer-verify idle >= 24h, ports verifyReminder.ts resolveVerifyReminderChannel (24h push / 72h email + de-dup), emits a notification_signals row and advances the customer_verify_last_reminder_* columns. SECURITY DEFINER - cron-invoked only.';



CREATE OR REPLACE FUNCTION "public"."start_trial"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_role text;
  v_craftsman_role text;
  v_row craftsman_subscriptions%ROWTYPE;
  v_now timestamptz := now();
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT role, craftsman_role INTO v_role, v_craftsman_role FROM profiles WHERE id = v_caller;
  IF v_role IS DISTINCT FROM 'craftsman' OR v_craftsman_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'not_owner';
  END IF;
  SELECT * INTO v_row FROM craftsman_subscriptions WHERE profile_id = v_caller FOR UPDATE;
  IF v_row IS NULL THEN RAISE EXCEPTION 'no_subscription_row'; END IF;
  IF v_row.status != 'trial_available' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_state', 'current', v_row.status);
  END IF;
  IF v_row.trial_started_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'trial_already_used');
  END IF;
  UPDATE craftsman_subscriptions
  SET status = 'trial_active', trial_started_at = v_now, trial_ends_at = v_now + interval '14 days', updated_at = v_now
  WHERE id = v_row.id;
  RETURN jsonb_build_object('ok', true, 'trial_ends_at', (v_now + interval '14 days')::text);
END;
$$;


ALTER FUNCTION "public"."start_trial"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_provider_media_cover"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_portfolio_item_id uuid;
  v_cover             record;
BEGIN
  v_portfolio_item_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.portfolio_item_id
                              ELSE NEW.portfolio_item_id
                         END;

  SELECT public_url, storage_path, media_type, poster_url, h264_url
    INTO v_cover
    FROM public.provider_media_assets
   WHERE portfolio_item_id = v_portfolio_item_id
   ORDER BY sort_order ASC
   LIMIT 1;

  IF FOUND THEN
    UPDATE public.provider_media
       SET public_url    = v_cover.public_url,
           storage_path  = v_cover.storage_path,
           media_type    = v_cover.media_type,
           poster_url    = v_cover.poster_url,
           h264_url      = v_cover.h264_url,
           updated_at    = now()
     WHERE id = v_portfolio_item_id
       AND kind = 'portfolio';
  END IF;

  RETURN NULL;
END;
$$;


ALTER FUNCTION "public"."sync_provider_media_cover"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."time_entries_immutable_identity_trigger"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
begin
  if (new.started_at is distinct from old.started_at) then
    raise exception 'time_entries.started_at is immutable' using errcode = '42501';
  end if;
  if (new.member_id is distinct from old.member_id) then
    raise exception 'time_entries.member_id is immutable' using errcode = '42501';
  end if;
  if (new.provider_id is distinct from old.provider_id) then
    raise exception 'time_entries.provider_id is immutable' using errcode = '42501';
  end if;
  if (new.kind is distinct from old.kind) then
    raise exception 'time_entries.kind is immutable' using errcode = '42501';
  end if;
  if (new.job_id is distinct from old.job_id) then
    raise exception 'time_entries.job_id is immutable' using errcode = '42501';
  end if;
  return new;
end $$;


ALTER FUNCTION "public"."time_entries_immutable_identity_trigger"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."time_entries_immutable_identity_trigger"() IS 'Block 2.1 hardening: prevents identity columns (started_at, member_id, provider_id, kind, job_id) from being mutated after INSERT. Fires before every UPDATE, regardless of caller role.';



CREATE OR REPLACE FUNCTION "public"."time_entries_reject_stamp_trigger"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
begin
  if (new.status = 'rejected' and old.status <> 'rejected') then
    new.rejected_at := now();
  elsif (new.status <> 'rejected' and old.status = 'rejected') then
    new.rejected_at := null;
  end if;
  return new;
end $$;


ALTER FUNCTION "public"."time_entries_reject_stamp_trigger"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."time_entries_reject_stamp_trigger"() IS 'Block 2.1 hardening: stamps rejected_at on transition into status=rejected, clears it on transition out.';



CREATE OR REPLACE FUNCTION "public"."touch_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;


ALTER FUNCTION "public"."touch_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_provider_search_vector"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
BEGIN
  NEW.search_vector :=
    to_tsvector(
      'german',
      coalesce(NEW.company_name, '') || ' ' ||
      coalesce(NEW.description, '') || ' ' ||
      coalesce(NEW.city, '') || ' ' ||
      coalesce(NEW.trade_categories, '')
    );
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_provider_search_vector"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_team_member"("p_member_id" "uuid", "p_full_name" "text", "p_role" "text", "p_phone" "text", "p_email" "text", "p_weekly_target_hours" numeric, "p_daily_target_hours" numeric) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller_uid  uuid := "auth"."uid"();
  v_provider_id uuid;
  v_old_row     RECORD;
  v_new_full    text;
  v_new_role    text;
  v_new_phone   text;
  v_new_email   text;
BEGIN
  IF v_caller_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Nicht eingeloggt.', 'code', 'unauthenticated');
  END IF;

  v_new_full  := COALESCE(NULLIF(TRIM(p_full_name), ''), NULL);
  v_new_role  := COALESCE(NULLIF(TRIM(p_role), ''), NULL);
  v_new_phone := NULLIF(TRIM(p_phone), '');
  v_new_email := NULLIF(LOWER(TRIM(p_email)), '');

  IF v_new_full IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Name darf nicht leer sein.', 'code', 'invalid_name');
  END IF;
  IF v_new_role IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Rolle darf nicht leer sein.', 'code', 'invalid_role');
  END IF;
  IF v_new_role = 'owner' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Inhaber-Rolle kann hier nicht gesetzt werden.', 'code', 'invalid_role');
  END IF;
  IF p_weekly_target_hours IS NOT NULL AND (p_weekly_target_hours < 0 OR p_weekly_target_hours > 168) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Wochenstunden außerhalb des erlaubten Bereichs.', 'code', 'invalid_hours');
  END IF;
  IF p_daily_target_hours IS NOT NULL AND (p_daily_target_hours < 0 OR p_daily_target_hours > 24) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Tagesstunden außerhalb des erlaubten Bereichs.', 'code', 'invalid_hours');
  END IF;

  SELECT tm.* INTO v_old_row FROM "team_members" tm WHERE tm."id" = p_member_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Mitarbeiter nicht gefunden.', 'code', 'not_found');
  END IF;
  IF v_old_row."role" = 'owner' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Inhaber-Datensatz kann hier nicht geändert werden.', 'code', 'owner_immutable');
  END IF;

  v_provider_id := v_old_row."provider_id";

  IF NOT EXISTS (
    SELECT 1 FROM "team_members" tm2
    WHERE tm2."provider_id" = v_provider_id
      AND tm2."profile_id"  = v_caller_uid
      AND tm2."role"        = 'owner'
      AND tm2."is_active"   = true
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Nur der Inhaber darf Mitarbeiter bearbeiten.', 'code', 'rbac_owner_required');
  END IF;

  IF v_old_row."profile_id" = v_caller_uid THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Eigene Daten können hier nicht geändert werden.', 'code', 'self_edit_forbidden');
  END IF;

  UPDATE "team_members"
     SET "full_name"           = v_new_full,
         "role"                = v_new_role,
         "phone"               = v_new_phone,
         "email"               = v_new_email,
         "weekly_target_hours" = p_weekly_target_hours,
         "daily_target_hours"  = p_daily_target_hours,
         "updated_at"          = now()
   WHERE "id" = p_member_id;

  INSERT INTO "team_member_audit" (
    "provider_id", "member_id", "actor_id", "action", "old_values", "new_values"
  ) VALUES (
    v_provider_id,
    p_member_id,
    v_caller_uid,
    'update',
    jsonb_build_object(
      'full_name',           v_old_row."full_name",
      'role',                v_old_row."role",
      'phone',               v_old_row."phone",
      'email',               v_old_row."email",
      'weekly_target_hours', v_old_row."weekly_target_hours",
      'daily_target_hours',  v_old_row."daily_target_hours"
    ),
    jsonb_build_object(
      'full_name',           v_new_full,
      'role',                v_new_role,
      'phone',               v_new_phone,
      'email',               v_new_email,
      'weekly_target_hours', p_weekly_target_hours,
      'daily_target_hours',  p_daily_target_hours
    )
  );

  RETURN jsonb_build_object('ok', true);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', 'Aktualisierung fehlgeschlagen.', 'code', 'unknown');
END;
$$;


ALTER FUNCTION "public"."update_team_member"("p_member_id" "uuid", "p_full_name" "text", "p_role" "text", "p_phone" "text", "p_email" "text", "p_weekly_target_hours" numeric, "p_daily_target_hours" numeric) OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."absences" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider_id" "uuid" NOT NULL,
    "member_id" "uuid" NOT NULL,
    "type" "public"."absence_type" NOT NULL,
    "start_date" "date" NOT NULL,
    "end_date" "date" NOT NULL,
    "reason_note" "text",
    "status" "public"."absence_status" DEFAULT 'active'::"public"."absence_status" NOT NULL,
    "sick_note_requested" boolean DEFAULT false NOT NULL,
    "sick_note_requested_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "cancelled_at" timestamp with time zone,
    "sick_note_url" "text",
    "sick_note_submitted_at" timestamp with time zone,
    CONSTRAINT "cancelled_has_timestamp" CHECK ((("status" <> 'cancelled'::"public"."absence_status") OR ("cancelled_at" IS NOT NULL))),
    CONSTRAINT "end_after_or_equal_start" CHECK (("end_date" >= "start_date")),
    CONSTRAINT "sick_note_request_consistency" CHECK (((("sick_note_requested" = false) AND ("sick_note_requested_at" IS NULL)) OR (("sick_note_requested" = true) AND ("sick_note_requested_at" IS NOT NULL)))),
    CONSTRAINT "sick_note_upload_consistency" CHECK (((("sick_note_url" IS NULL) AND ("sick_note_submitted_at" IS NULL)) OR (("sick_note_url" IS NOT NULL) AND ("sick_note_submitted_at" IS NOT NULL))))
);

ALTER TABLE ONLY "public"."absences" REPLICA IDENTITY FULL;


ALTER TABLE "public"."absences" OWNER TO "postgres";


COMMENT ON TABLE "public"."absences" IS 'Worker absence rows (sick, vacation, other). Active rows drive the Owner-Hub Krank-Badge + Springer flow. status=cancelled is the soft-delete path; rows are not physically deleted.';



COMMENT ON COLUMN "public"."absences"."sick_note_requested" IS 'Owner-side flag set when an Attest is requested. Paired with sick_note_requested_at via CHECK constraint.';



COMMENT ON COLUMN "public"."absences"."cancelled_at" IS 'Timestamp of cancellation. Required when status=cancelled; null otherwise (CHECK).';



COMMENT ON COLUMN "public"."absences"."sick_note_url" IS 'Supabase Storage path (sick-notes bucket) of the uploaded AU-Bescheinigung. Null until worker submits.';



COMMENT ON COLUMN "public"."absences"."sick_note_submitted_at" IS 'Timestamp when the sick note was first uploaded. Required when sick_note_url is set (CHECK).';



CREATE TABLE IF NOT EXISTS "public"."acceptances" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "payment_id" "uuid",
    "source_offer_id" "uuid",
    "customer_user_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "accepted_at" bigint,
    "notes" "text",
    "created_at" bigint NOT NULL,
    "updated_at" bigint NOT NULL,
    "expires_at" bigint,
    "reminders_sent" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "acceptances_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'accepted'::"text", 'disputed'::"text"])))
);


ALTER TABLE "public"."acceptances" OWNER TO "postgres";


COMMENT ON TABLE "public"."acceptances" IS 'Canonical Abnahme record. Opened (pending) when craftsman marks work complete. Transitions to accepted when customer explicitly confirms. One per job in terminal state.';



COMMENT ON COLUMN "public"."acceptances"."status" IS 'pending | accepted | disputed';



COMMENT ON COLUMN "public"."acceptances"."expires_at" IS 'Unix timestamp (ms) when the acceptance deadline expires. Set to created_at + 72h at work completion. After expiry, cron auto-releases the final payment tranche.';



COMMENT ON COLUMN "public"."acceptances"."reminders_sent" IS 'Block 7.2.1e — idempotency flags per reminder threshold. Keys: customer_24h, customer_60h, worker_acceptance, worker_auto_release. Set to true after a successful insert into notification_signals so the next cron tick skips the row.';



CREATE TABLE IF NOT EXISTS "public"."account_deletion_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "deleted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source" "text" NOT NULL,
    "buckets_cleared" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "files_removed" integer DEFAULT 0 NOT NULL,
    "duration_ms" integer,
    "error_detail" "text",
    CONSTRAINT "account_deletion_log_source_check" CHECK (("source" = ANY (ARRAY['vercel'::"text", 'trigger'::"text", 'admin_console'::"text"])))
);


ALTER TABLE "public"."account_deletion_log" OWNER TO "postgres";


COMMENT ON TABLE "public"."account_deletion_log" IS 'Phase 5 Spatial V1.6 · Append-only DSGVO audit trail for account deletions. Service-role only. Sources: vercel (api/delete-account.ts pre-deleteUser path), trigger (handle_auth_user_delete_cascade safety-net), admin_console (manual ASC/Dashboard ops).';



CREATE TABLE IF NOT EXISTS "public"."analytics_events" (
    "event_id" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "text" NOT NULL,
    "actor_user_id" "uuid",
    "metadata" "jsonb",
    "created_at" bigint NOT NULL
);


ALTER TABLE "public"."analytics_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."attribution_audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "from_status" "text",
    "to_status" "text",
    "from_origin" "text",
    "to_origin" "text",
    "retry_count" integer,
    "reason" "text",
    "operator_id" "uuid",
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "attribution_audit_log_dlq_reason_required" CHECK ((("event_type" <> 'dlq_entered'::"text") OR ("reason" IS NOT NULL))),
    CONSTRAINT "attribution_audit_log_event_type_check" CHECK (("event_type" = ANY (ARRAY['finalize_auto'::"text", 'finalize_absent'::"text", 'retry_incremented'::"text", 'dlq_entered'::"text", 'operator_resolve'::"text", 'operator_reclassify'::"text"]))),
    CONSTRAINT "attribution_audit_log_operator_id_required" CHECK ((("event_type" <> ALL (ARRAY['operator_resolve'::"text", 'operator_reclassify'::"text"])) OR ("operator_id" IS NOT NULL)))
);


ALTER TABLE "public"."attribution_audit_log" OWNER TO "postgres";


COMMENT ON TABLE "public"."attribution_audit_log" IS 'Operator-visible forensic history of attribution lifecycle transitions. Written by finalize-attribution cron and operator RPCs only.';



CREATE TABLE IF NOT EXISTS "public"."calendar_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid",
    "title" "text" DEFAULT ''::"text" NOT NULL,
    "customer_name" "text" DEFAULT ''::"text" NOT NULL,
    "location" "text" DEFAULT ''::"text" NOT NULL,
    "date_label" "text" DEFAULT ''::"text" NOT NULL,
    "date_key" "text" DEFAULT ''::"text" NOT NULL,
    "starts_at_label" "text" DEFAULT ''::"text" NOT NULL,
    "ends_at_label" "text" DEFAULT ''::"text" NOT NULL,
    "assigned_member_ids" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "status" "text" DEFAULT 'scheduled'::"text" NOT NULL,
    "created_at" bigint DEFAULT 0 NOT NULL,
    "updated_at" bigint DEFAULT 0 NOT NULL,
    "provider_id" "uuid",
    "description" "text" DEFAULT ''::"text" NOT NULL,
    CONSTRAINT "calendar_entries_requires_scope" CHECK ((("job_id" IS NOT NULL) OR ("provider_id" IS NOT NULL)))
);


ALTER TABLE "public"."calendar_entries" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."cancellation_invoice_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."cancellation_invoice_seq" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."change_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "source_offer_id" "uuid",
    "craftsman_user_id" "uuid" NOT NULL,
    "customer_user_id" "uuid" NOT NULL,
    "description" "text" NOT NULL,
    "price" "text" NOT NULL,
    "currency" "text",
    "gross_total" bigint,
    "net_total" bigint,
    "vat_rate" numeric(5,2),
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "sent_at" bigint,
    "accepted_at" bigint,
    "declined_at" bigint,
    "created_at" bigint NOT NULL,
    "updated_at" bigint NOT NULL,
    CONSTRAINT "change_orders_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'pending'::"text", 'accepted'::"text", 'declined'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."change_orders" OWNER TO "postgres";


COMMENT ON TABLE "public"."change_orders" IS 'Canonical Nachtrag record. Commercial change proposal for a Job that has already been accepted. Only accepted ChangeOrders update the canonical payment amount.';



COMMENT ON COLUMN "public"."change_orders"."gross_total" IS 'Gross delta in minor units (cents). Positive = additional cost. Negative = credit.';



COMMENT ON COLUMN "public"."change_orders"."status" IS 'draft | pending | accepted | declined | cancelled';



CREATE TABLE IF NOT EXISTS "public"."chat_attachments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "message_id" "uuid" NOT NULL,
    "asset_type" "text" NOT NULL,
    "mime_type" "text" NOT NULL,
    "size_bytes" bigint NOT NULL,
    "storage_bucket" "text" NOT NULL,
    "storage_path" "text" NOT NULL,
    "width" integer,
    "height" integer,
    "duration_ms" integer,
    "poster_storage_path" "text",
    "transcript" "text",
    "transcript_language" "text",
    "uploaded_at" bigint DEFAULT "public"."epoch_ms"() NOT NULL,
    "deleted_at" bigint,
    "transcode_status" "text" DEFAULT 'none'::"text" NOT NULL,
    "h264_url" "text",
    "poster_url" "text",
    "transcode_provider" "text",
    "transcode_error" "text",
    CONSTRAINT "chat_attachments_asset_type_check" CHECK (("asset_type" = ANY (ARRAY['image'::"text", 'document'::"text", 'voice'::"text", 'video'::"text"]))),
    CONSTRAINT "chat_attachments_storage_bucket_check" CHECK (("storage_bucket" = ANY (ARRAY['chat-customer'::"text", 'chat-internal'::"text", 'chat-dispute'::"text"]))),
    CONSTRAINT "chat_attachments_transcode_status_check" CHECK (("transcode_status" = ANY (ARRAY['none'::"text", 'pending'::"text", 'processing'::"text", 'ready'::"text", 'failed'::"text"])))
);

ALTER TABLE ONLY "public"."chat_attachments" REPLICA IDENTITY FULL;


ALTER TABLE "public"."chat_attachments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."chat_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "thread_id" "uuid" NOT NULL,
    "sender_user_id" "uuid" NOT NULL,
    "client_message_id" "uuid" NOT NULL,
    "body" "text",
    "message_type" "text" DEFAULT 'text'::"text" NOT NULL,
    "artifact_type" "text",
    "artifact_id" "text",
    "reply_to_message_id" "uuid",
    "created_at" bigint DEFAULT "public"."epoch_ms"() NOT NULL,
    "server_received_at" bigint DEFAULT "public"."epoch_ms"() NOT NULL,
    "delivered_at" bigint,
    "legacy_message_id" "text",
    "legacy_source" "text",
    "deleted_at" bigint,
    "redacted" boolean DEFAULT false NOT NULL,
    "redacted_at" bigint,
    "redacted_reason" "text",
    "idempotency_key" "uuid",
    "body_tsv" "tsvector" GENERATED ALWAYS AS ("to_tsvector"('"german"'::"regconfig", COALESCE("body", ''::"text"))) STORED,
    CONSTRAINT "chat_messages_legacy_source_check" CHECK ((("legacy_source" = ANY (ARRAY['messages'::"text", 'internal_messages'::"text", 'thread_artifacts'::"text"])) OR ("legacy_source" IS NULL))),
    CONSTRAINT "chat_messages_message_type_check" CHECK (("message_type" = ANY (ARRAY['text'::"text", 'image'::"text", 'document'::"text", 'voice'::"text", 'video'::"text", 'mixed'::"text", 'artifact_card'::"text", 'system'::"text"])))
);

ALTER TABLE ONLY "public"."chat_messages" REPLICA IDENTITY FULL;


ALTER TABLE "public"."chat_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."chat_participants" (
    "thread_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "joined_at" bigint DEFAULT "public"."epoch_ms"() NOT NULL,
    "left_at" bigint,
    "last_read_message_id" "uuid",
    "last_read_at" bigint,
    "muted_until" bigint,
    "pinned" boolean DEFAULT false NOT NULL,
    "notification_preference" "jsonb",
    "last_visible_message_id" "uuid",
    "last_visible_message_at" bigint,
    "last_visible_message_body" "text",
    "last_visible_message_type" "text",
    CONSTRAINT "chat_participants_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'craftsman'::"text", 'worker'::"text", 'customer'::"text", 'admin'::"text"])))
);

ALTER TABLE ONLY "public"."chat_participants" REPLICA IDENTITY FULL;


ALTER TABLE "public"."chat_participants" OWNER TO "postgres";


COMMENT ON COLUMN "public"."chat_participants"."last_visible_message_at" IS 'Per-participant denormalized timestamp of the most recent message visible to this user (after applying user_blocks filter). Used for thread-list preview, sort, and unread count. See M3 Hotfix.';



CREATE TABLE IF NOT EXISTS "public"."chat_thread_migration_status" (
    "thread_id" "uuid" NOT NULL,
    "legacy_thread_id" "text" NOT NULL,
    "legacy_source" "text" NOT NULL,
    "status" "text" DEFAULT 'not_migrated'::"text" NOT NULL,
    "priority" smallint DEFAULT 0 NOT NULL,
    "started_at" bigint,
    "completed_at" bigint,
    "verified_at" bigint,
    "failed_at" bigint,
    "failure_reason" "text",
    "failed_step" "text",
    "attempts" smallint DEFAULT 0 NOT NULL,
    "lock_owner" "text",
    "lock_until" bigint,
    "created_at" bigint DEFAULT "public"."epoch_ms"() NOT NULL,
    "updated_at" bigint DEFAULT "public"."epoch_ms"() NOT NULL,
    CONSTRAINT "chat_thread_migration_status_status_check" CHECK (("status" = ANY (ARRAY['not_migrated'::"text", 'migration_queued'::"text", 'migrating'::"text", 'migration_complete'::"text", 'migration_verified'::"text", 'migration_failed'::"text"])))
);

ALTER TABLE ONLY "public"."chat_thread_migration_status" REPLICA IDENTITY FULL;


ALTER TABLE "public"."chat_thread_migration_status" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."chat_threads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "channel_type" "text" NOT NULL,
    "customer_user_id" "uuid",
    "craftsman_user_id" "uuid",
    "provider_id" "uuid",
    "legacy_thread_id" "text",
    "legacy_source" "text",
    "title" "text",
    "last_message_id" "uuid",
    "last_message_at" bigint,
    "last_message_body" "text",
    "created_at" bigint DEFAULT "public"."epoch_ms"() NOT NULL,
    "updated_at" bigint DEFAULT "public"."epoch_ms"() NOT NULL,
    "closed_at" bigint,
    "assignment_calendar_entry_id" "uuid",
    "dispute_id" "uuid",
    "inquiry_origin" "text",
    "declined_at" bigint,
    "reviewed_at" bigint,
    "source_project_id" "text",
    "inquiry_criteria" "jsonb",
    "display_metadata" "jsonb",
    CONSTRAINT "chat_threads_channel_type_check" CHECK (("channel_type" = ANY (ARRAY['customer'::"text", 'office'::"text", 'team'::"text", 'assignment'::"text", 'dispute'::"text"]))),
    CONSTRAINT "chat_threads_customer_channel_check" CHECK ((("channel_type" <> 'customer'::"text") OR (("customer_user_id" IS NOT NULL) AND ("craftsman_user_id" IS NOT NULL) AND ("provider_id" IS NOT NULL)))),
    CONSTRAINT "chat_threads_inquiry_origin_check" CHECK ((("inquiry_origin" IS NULL) OR ("inquiry_origin" = ANY (ARRAY['reel'::"text", 'profile'::"text", 'category'::"text", 'project'::"text"])))),
    CONSTRAINT "chat_threads_legacy_source_check" CHECK ((("legacy_source" = ANY (ARRAY['conversations'::"text", 'message_threads'::"text"])) OR ("legacy_source" IS NULL))),
    CONSTRAINT "chat_threads_provider_required_check" CHECK ((("channel_type" = 'customer'::"text") OR ("provider_id" IS NOT NULL)))
);

ALTER TABLE ONLY "public"."chat_threads" REPLICA IDENTITY FULL;


ALTER TABLE "public"."chat_threads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."company_code_audit" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider_id" "uuid" NOT NULL,
    "old_code_id" "uuid",
    "new_code_id" "uuid",
    "rotated_by" "uuid" NOT NULL,
    "rotated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reason" "text"
);


ALTER TABLE "public"."company_code_audit" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."company_join_codes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider_id" "uuid" NOT NULL,
    "code" "text" NOT NULL,
    "target_role" "text" DEFAULT 'worker'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "rotated_at" timestamp with time zone,
    "rotated_by" "uuid",
    "replaced_by" "uuid",
    CONSTRAINT "company_join_codes_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'rotated'::"text"]))),
    CONSTRAINT "company_join_codes_target_role_check" CHECK (("target_role" = 'worker'::"text"))
);


ALTER TABLE "public"."company_join_codes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."conversations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "craftsman_user_id" "uuid",
    "customer_user_id" "uuid",
    "created_at" bigint DEFAULT (EXTRACT(epoch FROM "now"()) * (1000)::numeric),
    "customer_name" "text" DEFAULT ''::"text" NOT NULL,
    "customer_avatar_url" "text" DEFAULT ''::"text" NOT NULL,
    "craftsman_name" "text" DEFAULT ''::"text" NOT NULL,
    "craftsman_handle" "text" DEFAULT ''::"text" NOT NULL,
    "craftsman_avatar_url" "text" DEFAULT ''::"text" NOT NULL,
    "project_title" "text" DEFAULT ''::"text" NOT NULL,
    "project_subtitle" "text" DEFAULT ''::"text" NOT NULL,
    "project_location" "text",
    "project_cost_range" "text",
    "project_duration" "text",
    "project_status_label" "text",
    "time_label" "text",
    "unread_count" integer,
    "inquiry_origin" "text",
    "source_project_id" "text",
    "reviewed_at" bigint,
    "declined_at" bigint,
    "inquiry_criteria" "jsonb",
    "project_description" "text"
);


ALTER TABLE "public"."conversations" OWNER TO "postgres";


COMMENT ON TABLE "public"."conversations" IS 'LEGACY (retired 2026-06-11, Chat-Cutover): read-only Archiv. Writes laufen auf chat_threads. DROP frühestens nach Safety-Window 2026-07-11, wenn Lazy-Message-Migration abgeschlossen ist.';



CREATE TABLE IF NOT EXISTS "public"."correction_requests" (
    "id" "text" NOT NULL,
    "provider_id" "uuid" NOT NULL,
    "worker_team_member_id" "text" NOT NULL,
    "worker_profile_id" "uuid" NOT NULL,
    "calendar_entry_id" "text",
    "requested_date" "text",
    "kind" "text" NOT NULL,
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "owner_note" "text",
    "created_at" bigint NOT NULL,
    "updated_at" bigint NOT NULL,
    "field" "text",
    "current_value" "text",
    "proposed_value" "text",
    "reason" "text",
    "applied_at" bigint,
    "applied_target_entry_id" "uuid",
    "apply_skip_reason" "text",
    CONSTRAINT "correction_requests_kind_check" CHECK (("kind" = ANY (ARRAY['missing_time'::"text", 'wrong_time'::"text", 'wrong_assignment'::"text", 'other'::"text"]))),
    CONSTRAINT "correction_requests_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'in_review'::"text", 'resolved'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."correction_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."craftsman_profiles" (
    "user_id" "text" NOT NULL,
    "business_name" "text" DEFAULT ''::"text" NOT NULL,
    "handle" "text" DEFAULT ''::"text" NOT NULL,
    "avatar_url" "text",
    "bio" "text",
    "location" "text" DEFAULT ''::"text" NOT NULL,
    "trade_categories" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "services_offered" "text"[],
    "service_radius_km" numeric,
    "years_in_business" integer,
    "completed_jobs_count" integer DEFAULT 0 NOT NULL,
    "phone" "text",
    "website" "text",
    "onboarding_completed" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "business_address" "text"
);


ALTER TABLE "public"."craftsman_profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."craftsman_subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'trial_available'::"text" NOT NULL,
    "trial_started_at" timestamp with time zone,
    "trial_ends_at" timestamp with time zone,
    "current_period_start" timestamp with time zone,
    "current_period_end" timestamp with time zone,
    "canceled_at" timestamp with time zone,
    "grace_started_at" timestamp with time zone,
    "billing_provider" "text",
    "billing_provider_subscription_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "craftsman_subscriptions_billing_provider_check" CHECK ((("billing_provider" = ANY (ARRAY['apple'::"text", 'stripe'::"text"])) OR ("billing_provider" IS NULL))),
    CONSTRAINT "craftsman_subscriptions_status_check" CHECK (("status" = ANY (ARRAY['trial_available'::"text", 'trial_active'::"text", 'active'::"text", 'grace'::"text", 'canceled'::"text", 'expired'::"text"])))
);

ALTER TABLE ONLY "public"."craftsman_subscriptions" REPLICA IDENTITY FULL;


ALTER TABLE "public"."craftsman_subscriptions" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."credit_note_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."credit_note_seq" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."customer_billing_profiles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "billing_name" "text",
    "billing_address_line1" "text",
    "billing_address_line2" "text",
    "billing_postal_code" "text",
    "billing_city" "text",
    "billing_country" "text" DEFAULT 'DE'::"text" NOT NULL,
    "billing_email" "text",
    "billing_phone" "text",
    "is_business" boolean DEFAULT false NOT NULL,
    "business_name" "text",
    "vat_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."customer_billing_profiles" OWNER TO "postgres";


COMMENT ON TABLE "public"."customer_billing_profiles" IS 'Persistente Rechnungsdaten des Auftraggebers (Block 7.1B2). Eindeutig pro user_id. Wird in 7.1B3+ als Snapshot in Invoice eingefroren — die Row hier ist nur Profil-Truth, keine Invoice-Truth.';



COMMENT ON COLUMN "public"."customer_billing_profiles"."user_id" IS 'Owner-Key — auth.uid() / profiles.id. UNIQUE: exakt eine Billing-Profile-Row pro User.';



COMMENT ON COLUMN "public"."customer_billing_profiles"."billing_name" IS 'Vollständiger Name auf der Rechnung (Privatkunde) oder Ansprechpartner.';



COMMENT ON COLUMN "public"."customer_billing_profiles"."billing_country" IS 'ISO-3166-1-Alpha-2-Länderkürzel. Default DE — Issuance-Logik in B3 wird länderspezifische Steuerregeln daran festmachen.';



COMMENT ON COLUMN "public"."customer_billing_profiles"."is_business" IS 'TRUE wenn Geschäftskunde — entsperrt business_name und vat_id im UI. Keine §13b-Reverse-Charge-Aktivierung in B2.';



COMMENT ON COLUMN "public"."customer_billing_profiles"."vat_id" IS 'USt-IdNr. des Geschäftskunden (optional). Spätere §13b-Logik wird hier ansetzen — in B2 nur erfasst.';



CREATE TABLE IF NOT EXISTS "public"."customer_provider_relationships" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "customer_user_id" "uuid" NOT NULL,
    "craftsman_user_id" "uuid" NOT NULL,
    "commercial_origin" "text" NOT NULL,
    "origin_context" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "customer_provider_relationships_commercial_origin_check" CHECK (("commercial_origin" = ANY (ARRAY['merchant_brought'::"text", 'platform_acquired'::"text"]))),
    CONSTRAINT "customer_provider_relationships_origin_context_check" CHECK (("origin_context" = ANY (ARRAY['invite'::"text", 'reel'::"text", 'search'::"text", 'referral'::"text", 'manual_import'::"text", 'unknown'::"text"])))
);


ALTER TABLE "public"."customer_provider_relationships" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."customer_request_sends" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "provider_id" "uuid" NOT NULL,
    "sent_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."customer_request_sends" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "role" "text" DEFAULT '''customer'''::"text",
    "display_name" "text",
    "phone" "text",
    "onboarding_done" boolean DEFAULT false,
    "craftsman_role" "text",
    "is_operator" boolean DEFAULT false NOT NULL,
    "guided_entry_state" "jsonb",
    "tos_accepted_at" timestamp with time zone,
    "timezone" "text" DEFAULT 'Europe/Berlin'::"text" NOT NULL,
    "moderation_state" "text" DEFAULT 'active'::"text" NOT NULL,
    "suspension_expires_at" timestamp with time zone,
    "provider_terms_accepted_at" timestamp with time zone,
    CONSTRAINT "profiles_moderation_state_chk" CHECK (("moderation_state" = ANY (ARRAY['active'::"text", 'suspended'::"text", 'banned'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


COMMENT ON COLUMN "public"."profiles"."moderation_state" IS 'Operator-set moderation state. active (default) | suspended (timed) | banned (permanent). Enforced fail-closed via is_caller_moderation_write_allowed() on write surfaces.';



COMMENT ON COLUMN "public"."profiles"."suspension_expires_at" IS 'NULL for bans and active users; set for timed suspensions. A suspension is treated as expired (writes allowed again) once now() > suspension_expires_at.';



COMMENT ON COLUMN "public"."profiles"."provider_terms_accepted_at" IS 'Zeitpunkt, zu dem ein Handwerks-Inhaber die Anbieterbedingungen (B2B-AGB) + AVV akzeptiert hat. NULL = noch nicht akzeptiert.';



CREATE TABLE IF NOT EXISTS "public"."providers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "company_name" "text",
    "description" "text",
    "rating" numeric DEFAULT '0'::numeric,
    "verified" boolean DEFAULT false,
    "profile_id" "uuid",
    "city" "text",
    "trade_categories" "text",
    "avatar_url" "text",
    "is_public" boolean DEFAULT true,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "search_vector" "tsvector",
    "slug" "text",
    "handle" "text",
    "business_address" "text",
    "tax_number" "text",
    "vat_id" "text",
    "legal_form" "text",
    "is_kleinunternehmer" boolean DEFAULT false NOT NULL,
    "default_vat_rate" numeric(5,2) DEFAULT 19.00 NOT NULL,
    "iban" "text",
    "bic" "text",
    CONSTRAINT "providers_company_name_not_blank_check" CHECK ((("company_name" IS NULL) OR ("length"(TRIM(BOTH FROM "company_name")) > 0))),
    CONSTRAINT "providers_handle_not_blank_check" CHECK ((("handle" IS NULL) OR ("length"(TRIM(BOTH FROM "handle")) > 0))),
    CONSTRAINT "providers_rating_range_check" CHECK ((("rating" IS NULL) OR (("rating" >= (0)::numeric) AND ("rating" <= (5)::numeric)))),
    CONSTRAINT "providers_slug_not_blank_check" CHECK ((("slug" IS NULL) OR ("length"(TRIM(BOTH FROM "slug")) > 0)))
);


ALTER TABLE "public"."providers" OWNER TO "postgres";


COMMENT ON COLUMN "public"."providers"."tax_number" IS 'Steuernummer beim Finanzamt (z. B. "12/345/67890"). Pflichtangabe auf §14-UStG-Rechnungen, sofern keine vat_id vorliegt.';



COMMENT ON COLUMN "public"."providers"."vat_id" IS 'Umsatzsteuer-Identifikationsnummer (USt-IdNr., z. B. "DE123456789"). Alternative zur Steuernummer auf Rechnungen.';



COMMENT ON COLUMN "public"."providers"."legal_form" IS 'Rechtsform des Betriebs. Erlaubte App-Werte: einzelunternehmer | gbr | gmbh | ug | ag | kg | ohg | sonstige.';



COMMENT ON COLUMN "public"."providers"."is_kleinunternehmer" IS 'Kleinunternehmerregelung nach §19 UStG. Wenn TRUE, darf vat_id leer bleiben und auf Rechnungen wird der entsprechende Hinweistext gedruckt (Logik kommt in 7.1B2).';



COMMENT ON COLUMN "public"."providers"."default_vat_rate" IS 'Standard-Mehrwertsteuersatz in Prozent (DEFAULT 19.00). Vorbelegung für neue Rechnungspositionen — keine automatische Steuerberatung.';



COMMENT ON COLUMN "public"."providers"."iban" IS 'IBAN für Profil-/Rechnungsanzeige. NICHT identisch mit der Stripe-Connect-Auszahlungs-IBAN; Stripe bleibt Truth für Payouts.';



COMMENT ON COLUMN "public"."providers"."bic" IS 'BIC zur IBAN (optional, in DE oft nicht notwendig).';



CREATE TABLE IF NOT EXISTS "public"."ratings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "provider_user_id" "uuid" NOT NULL,
    "customer_user_id" "uuid" NOT NULL,
    "rating_score" smallint NOT NULL,
    "rating_comment" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ratings_rating_score_check" CHECK ((("rating_score" >= 1) AND ("rating_score" <= 5)))
);


ALTER TABLE "public"."ratings" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."discovery_providers" AS
 SELECT "p"."id" AS "provider_id",
    "p"."profile_id",
    "p"."company_name",
    "p"."description",
    "p"."city",
    "p"."trade_categories",
    "p"."avatar_url",
    "p"."rating",
    COALESCE(( SELECT ("count"(*))::integer AS "count"
           FROM "public"."ratings" "r"
          WHERE ("r"."provider_user_id" = "pr"."id")), 0) AS "rating_count",
    "p"."verified",
    "p"."is_public",
    "p"."created_at" AS "provider_created_at",
    "p"."updated_at" AS "provider_updated_at",
    "pr"."display_name",
    "pr"."craftsman_role",
    "pr"."onboarding_done",
    NULL::boolean AS "is_operator",
    "p"."handle"
   FROM ("public"."providers" "p"
     JOIN "public"."profiles" "pr" ON (("pr"."id" = "p"."profile_id")))
  WHERE ("p"."is_public" = true);


ALTER VIEW "public"."discovery_providers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."disputes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "payment_id" "uuid",
    "project_id" "uuid",
    "opened_by_profile_id" "uuid",
    "provider_id" "uuid",
    "customer_profile_id" "uuid",
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "reason" "text",
    "description" "text",
    "resolution_type" "text",
    "resolution_note" "text",
    "refund_amount" numeric DEFAULT 0 NOT NULL,
    "release_amount" numeric DEFAULT 0 NOT NULL,
    "opened_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved_at" timestamp with time zone,
    "closed_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "split_ratio" numeric,
    "provider_award_amount" numeric DEFAULT 0 NOT NULL,
    "customer_refund_amount" numeric DEFAULT 0 NOT NULL,
    "settlement_status" "text",
    "raised_by" "text",
    "decision" "text",
    "context_snapshot" "jsonb",
    "default_applied_at" timestamp with time zone,
    "default_refund_minor" bigint,
    CONSTRAINT "disputes_decision_check" CHECK ((("decision" IS NULL) OR ("decision" = ANY (ARRAY['release'::"text", 'refund'::"text", 'split'::"text", 'reject'::"text"])))),
    CONSTRAINT "disputes_resolution_type_check" CHECK ((("resolution_type" IS NULL) OR ("resolution_type" = ANY (ARRAY['refund_full'::"text", 'refund_partial'::"text", 'release_full'::"text", 'release_partial'::"text", 'split'::"text", 'rejected'::"text"])))),
    CONSTRAINT "disputes_settlement_status_check" CHECK ((("settlement_status" IS NULL) OR ("settlement_status" = ANY (ARRAY['pending'::"text", 'settled'::"text"])))),
    CONSTRAINT "disputes_split_ratio_exclusive_chk" CHECK ((("split_ratio" IS NULL) OR (("split_ratio" > (0)::numeric) AND ("split_ratio" < (1)::numeric)))),
    CONSTRAINT "disputes_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'under_review'::"text", 'customer_waiting'::"text", 'provider_waiting'::"text", 'resolved'::"text", 'closed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."disputes" OWNER TO "postgres";


COMMENT ON COLUMN "public"."disputes"."settlement_status" IS 'Financial settlement state for terminal disputes. pending = decision made, money action not yet completed. settled = money action confirmed. NULL for non-terminal disputes.';



COMMENT ON COLUMN "public"."disputes"."context_snapshot" IS 'JSONB snapshot of job/payment state captured at dispute-open time. Used to reconstruct the dispute context for review and resolution. Null for disputes opened before this column was added.';



COMMENT ON COLUMN "public"."disputes"."default_applied_at" IS 'P4 Run 2: set by apply_dispute_default_refund when the AGB T+80 default fires. NULL = no auto-default applied. Idempotency anchor: once set, worker + RPC skip the row. Distinct from resolved_at (operator/consensus); default_applied_at = automated default path only.';



COMMENT ON COLUMN "public"."disputes"."default_refund_minor" IS 'P4 Batch 2 (75/25): held-remainder snapshot in MINOR units (EUR cents), set by apply_dispute_default_refund when the AGB T+80 default fires. Sum amount of the NON-released tranches (the shared held predicate) x 100. NULL = no auto-default applied. Makes the worker''s partial refund amount deterministic across retries.';



CREATE TABLE IF NOT EXISTS "public"."jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "customer_profile_id" "uuid",
    "provider_id" "uuid",
    "title" "text" NOT NULL,
    "description" "text",
    "city" "text",
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "budget_amount" numeric,
    "scheduled_for" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "dispute_id" "uuid",
    "dispute_status" "text",
    "assigned_team_member_id" "uuid",
    "assignment_status" "text",
    "assigned_provider_id" "uuid",
    "customer_user_id" "uuid",
    "work_started_at" bigint,
    "funding_requested_at" bigint,
    "source_offer_id" "uuid",
    "work_completed_at" bigint,
    "project_id" "text" DEFAULT ''::"text" NOT NULL,
    "customer" "text" DEFAULT ''::"text" NOT NULL,
    "location" "text" DEFAULT ''::"text" NOT NULL,
    "date_label" "text" DEFAULT 'Termin offen'::"text" NOT NULL,
    "amount" "text" DEFAULT ''::"text" NOT NULL,
    "payment_state" "text" DEFAULT 'deposit_required'::"text" NOT NULL,
    "documentation_status" "text" DEFAULT 'Noch keine Dokumentation'::"text" NOT NULL,
    "assigned_member_ids" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "notes" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "photo_count" integer DEFAULT 0 NOT NULL,
    "intake_context" "jsonb",
    "proposal_timing_note" "text",
    "proposal_sent_at" bigint,
    "proposal_accepted_at" bigint,
    "payment_released_at" bigint,
    "craftsman_user_id" "text",
    "source_conversation_id" "uuid",
    "commercial_origin" "text",
    "attribution_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "attribution_retry_count" integer DEFAULT 0 NOT NULL,
    "attribution_last_retry_at" timestamp with time zone,
    "job_kind" "text",
    "attribution_dlq_reason" "text",
    "work_marked_complete_at" bigint,
    "work_confirmed_complete_at" bigint,
    CONSTRAINT "jobs_assignment_status_check" CHECK ((("assignment_status" IS NULL) OR ("assignment_status" = ANY (ARRAY['unassigned'::"text", 'assigned'::"text", 'accepted'::"text", 'declined'::"text", 'in_progress'::"text", 'completed'::"text"])))),
    CONSTRAINT "jobs_attribution_dlq_reason_required" CHECK ((("attribution_status" <> 'dlq'::"text") OR ("attribution_dlq_reason" IS NOT NULL))),
    CONSTRAINT "jobs_attribution_finalized_origin_check" CHECK ((("attribution_status" <> 'finalized'::"text") OR ("commercial_origin" = ANY (ARRAY['merchant_brought'::"text", 'platform_acquired'::"text"])))),
    CONSTRAINT "jobs_attribution_status_check" CHECK (("attribution_status" = ANY (ARRAY['pending'::"text", 'finalized'::"text", 'retrying'::"text", 'dlq'::"text"]))),
    CONSTRAINT "jobs_commercial_origin_check" CHECK (("commercial_origin" = ANY (ARRAY['merchant_brought'::"text", 'platform_acquired'::"text", 'unknown_pending_resolution'::"text"]))),
    CONSTRAINT "jobs_job_kind_check" CHECK ((("job_kind" IS NULL) OR ("job_kind" = ANY (ARRAY['standard'::"text", 'estimate_tracking'::"text", 'cost_estimate_tracking'::"text", 'diagnosis'::"text"])))),
    CONSTRAINT "jobs_status_check" CHECK (("status" = ANY (ARRAY['new'::"text", 'booked'::"text", 'scheduled'::"text", 'in_progress'::"text", 'waiting_payment'::"text", 'completed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."jobs" OWNER TO "postgres";


COMMENT ON COLUMN "public"."jobs"."dispute_status" IS 'Current dispute lifecycle status for this job. Allowed: open | under_review | resolved_refund | resolved_release | resolved_split | rejected. NULL when no dispute has been opened.';



COMMENT ON COLUMN "public"."jobs"."work_completed_at" IS 'DEPRECATED — alias für work_confirmed_complete_at. Wird via confirmJobCompletionWorkflow gesetzt. Cleanup-Block entfernt diese Spalte sobald alle Konsumenten migriert sind.';



COMMENT ON COLUMN "public"."jobs"."job_kind" IS 'Commercial kind of this job — derived from the documentType of the Offer that created it (Paket 2+). ''standard'' (binding_offer origin, full execution + escrow) | ''estimate_tracking'' (estimate origin, tracking only) | ''cost_estimate_tracking'' (cost_estimate origin, tracking only, no payment) | ''diagnosis'' (diagnosis origin, own diagnosis instant-payment path). NULL = legacy pre-Paket-2 job, treated as ''standard''.';



COMMENT ON COLUMN "public"."jobs"."attribution_dlq_reason" IS 'Documented reason when attribution_status = ''dlq''. See finalize-attribution.ts for taxonomy.';



CREATE TABLE IF NOT EXISTS "public"."payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid",
    "project_id" "uuid",
    "provider_id" "uuid",
    "customer_profile_id" "uuid",
    "provider_stripe_account_id" "text",
    "stripe_payment_intent_id" "text",
    "stripe_checkout_session_id" "text",
    "stripe_refund_id" "text",
    "stripe_transfer_id" "text",
    "currency" "text" DEFAULT 'eur'::"text" NOT NULL,
    "amount_total" numeric DEFAULT 0 NOT NULL,
    "amount_captured" numeric DEFAULT 0 NOT NULL,
    "amount_refunded" numeric DEFAULT 0 NOT NULL,
    "platform_fee_amount" numeric DEFAULT 0 NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "payment_method_type" "text",
    "payment_provider" "text" DEFAULT 'stripe'::"text" NOT NULL,
    "escrow_created_at" timestamp with time zone,
    "captured_at" timestamp with time zone,
    "refunded_at" timestamp with time zone,
    "failed_at" timestamp with time zone,
    "cancelled_at" timestamp with time zone,
    "failure_reason" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_stripe_event_id" "text",
    "last_stripe_event_type" "text",
    "stripe_status" "text",
    "reconciled_at" timestamp with time zone,
    "dispute_id" "uuid",
    "dispute_status" "text",
    "release_blocked" boolean DEFAULT false NOT NULL,
    "amount_released" numeric DEFAULT 0 NOT NULL,
    "amount_held" numeric DEFAULT 0 NOT NULL,
    "amount_disputed" numeric DEFAULT 0 NOT NULL,
    "split_resolution_ratio" numeric,
    "split_resolution_note" "text",
    "client_secret" "text",
    "craftsman_user_id" "uuid",
    "customer_user_id" "uuid",
    "deposit_amount" numeric,
    "final_amount" numeric,
    "offer_id" "uuid",
    "provider_ref" "text",
    "total_amount" numeric,
    "refunded_amount" numeric(12,2),
    CONSTRAINT "payments_job_or_project_check" CHECK ((("job_id" IS NOT NULL) OR ("project_id" IS NOT NULL))),
    CONSTRAINT "payments_status_check" CHECK (("status" = ANY (ARRAY['none'::"text", 'deposit_required'::"text", 'deposit_paid'::"text", 'in_escrow'::"text", 'work_in_progress'::"text", 'release_pending'::"text", 'released'::"text", 'disputed'::"text", 'refunded'::"text", 'pending'::"text", 'requires_payment_method'::"text", 'requires_confirmation'::"text", 'processing'::"text", 'authorized'::"text", 'escrowed'::"text", 'captured'::"text", 'partially_refunded'::"text", 'failed'::"text", 'cancelled'::"text", 'diagnosis_payment_pending'::"text", 'diagnosis_payment_completed'::"text"])))
);


ALTER TABLE "public"."payments" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."dispute_details" WITH ("security_invoker"='true') AS
 SELECT "d"."id",
    "d"."job_id",
    "d"."payment_id",
    "d"."project_id",
    "d"."opened_by_profile_id",
    "d"."provider_id",
    "d"."customer_profile_id",
    "d"."status",
    "d"."reason",
    "d"."description",
    "d"."resolution_type",
    "d"."resolution_note",
    "d"."refund_amount",
    "d"."release_amount",
    "d"."opened_at",
    "d"."resolved_at",
    "d"."closed_at",
    "d"."metadata",
    "d"."created_at",
    "d"."updated_at",
    "j"."title" AS "job_title",
    "j"."status" AS "job_status",
    "p"."status" AS "payment_status",
    "p"."amount_total",
    "p"."amount_captured",
    "p"."amount_refunded",
    "pr"."company_name" AS "provider_company_name",
    "cp"."display_name" AS "customer_display_name"
   FROM (((("public"."disputes" "d"
     LEFT JOIN "public"."jobs" "j" ON (("d"."job_id" = "j"."id")))
     LEFT JOIN "public"."payments" "p" ON (("d"."payment_id" = "p"."id")))
     LEFT JOIN "public"."providers" "pr" ON (("d"."provider_id" = "pr"."id")))
     LEFT JOIN "public"."profiles" "cp" ON (("d"."customer_profile_id" = "cp"."id")));


ALTER VIEW "public"."dispute_details" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dispute_evidence" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "dispute_id" "uuid" NOT NULL,
    "uploaded_by_profile_id" "uuid",
    "kind" "text" DEFAULT 'image'::"text" NOT NULL,
    "storage_path" "text",
    "public_url" "text",
    "caption" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "dispute_evidence_kind_check" CHECK (("kind" = ANY (ARRAY['image'::"text", 'document'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."dispute_evidence" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."dispute_ops_overview" WITH ("security_invoker"='true') AS
 SELECT "id" AS "dispute_id",
    "job_id",
    "payment_id",
    "status",
    "reason",
    "resolution_type",
    "refund_amount",
    "release_amount",
    "opened_at",
    "resolved_at",
    (EXTRACT(day FROM ("now"() - "opened_at")))::integer AS "age_days",
        CASE
            WHEN (EXTRACT(day FROM ("now"() - "opened_at")) >= (7)::numeric) THEN 'critical'::"text"
            WHEN (EXTRACT(day FROM ("now"() - "opened_at")) >= (3)::numeric) THEN 'elevated'::"text"
            ELSE 'normal'::"text"
        END AS "urgency_level"
   FROM "public"."disputes" "d"
  WHERE ("status" = ANY (ARRAY['open'::"text", 'under_review'::"text", 'customer_waiting'::"text", 'provider_waiting'::"text"]));


ALTER VIEW "public"."dispute_ops_overview" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dispute_spatial_evidence" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "dispute_id" "uuid" NOT NULL,
    "scene_id" "uuid" NOT NULL,
    "node_id" "text" NOT NULL,
    "evidence_kind" "text" NOT NULL,
    "submitted_by" "uuid",
    "submitted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "dispute_spatial_evidence_kind_chk" CHECK (("evidence_kind" = ANY (ARRAY['damage_pin'::"text", 'photo'::"text", 'note'::"text", 'measurement'::"text"])))
);


ALTER TABLE "public"."dispute_spatial_evidence" OWNER TO "postgres";


COMMENT ON TABLE "public"."dispute_spatial_evidence" IS 'Spatial Canonical V1: append-only bridge from disputes to canonical scene pins. dispute_id FK to disputes.id (uuid PK, verified against prod 2026-05-20). Writes REVOKEd from anon/authenticated; SECURITY DEFINER RPC insert path (Day 7). Distinct from the dead dispute_evidence table path noted in FIXUP CLAUDE.md.';



COMMENT ON COLUMN "public"."dispute_spatial_evidence"."dispute_id" IS 'FK to disputes.id (uuid PRIMARY KEY, verified against prod 2026-05-20).';



COMMENT ON COLUMN "public"."dispute_spatial_evidence"."node_id" IS 'Canonical scene-graph node identifier (pin, wall, object) from parametric JSON blob. NOT a Postgres FK - nodes are embedded in Storage blob.';



COMMENT ON COLUMN "public"."dispute_spatial_evidence"."evidence_kind" IS 'damage_pin: spatial pin marking damage. photo: attached photo at pin. note: text annotation at node. measurement: verified dimension at node.';



CREATE TABLE IF NOT EXISTS "public"."dispute_split_proposals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "dispute_id" "uuid" NOT NULL,
    "job_id" "uuid" NOT NULL,
    "proposed_by" "uuid" NOT NULL,
    "proposed_ratio" numeric(5,4) NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "confirmed_by" "uuid",
    "proposal_round" smallint DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "dispute_split_proposals_proposal_round_check" CHECK (("proposal_round" >= 1)),
    CONSTRAINT "dispute_split_proposals_proposed_ratio_check" CHECK ((("proposed_ratio" > (0)::numeric) AND ("proposed_ratio" < (1)::numeric))),
    CONSTRAINT "dispute_split_proposals_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'accepted'::"text", 'rejected'::"text", 'superseded'::"text"])))
);

ALTER TABLE ONLY "public"."dispute_split_proposals" REPLICA IDENTITY FULL;


ALTER TABLE "public"."dispute_split_proposals" OWNER TO "postgres";


COMMENT ON TABLE "public"."dispute_split_proposals" IS 'P4B: two-party consensus split proposals. One pending proposal per dispute at a time. All writes via SECDEF RPCs (propose_split_atomic / confirm_split_proposal / reject_split_proposal). Dormant until PR B wires callers.';



CREATE TABLE IF NOT EXISTS "public"."dispute_status_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "dispute_id" "uuid" NOT NULL,
    "previous_status" "text",
    "next_status" "text" NOT NULL,
    "source" "text" NOT NULL,
    "note" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "job_id" "uuid",
    CONSTRAINT "dispute_status_history_source_check" CHECK (("source" = ANY (ARRAY['client'::"text", 'server'::"text", 'webhook'::"text", 'system'::"text", 'admin'::"text", 'consensus'::"text"])))
);


ALTER TABLE "public"."dispute_status_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."email_delivery_log" (
    "id" bigint NOT NULL,
    "job_id" "text" NOT NULL,
    "notification_type" "text" NOT NULL,
    "recipient_user_id" "text" NOT NULL,
    "recipient_role" "text" NOT NULL,
    "recipient_email" "text",
    "success" boolean NOT NULL,
    "error_message" "text",
    "provider_message_id" "text",
    "sent_at" bigint NOT NULL,
    CONSTRAINT "email_delivery_log_recipient_role_check" CHECK (("recipient_role" = ANY (ARRAY['customer'::"text", 'craftsman'::"text"])))
);


ALTER TABLE "public"."email_delivery_log" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."email_delivery_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."email_delivery_log_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."email_delivery_log_id_seq" OWNED BY "public"."email_delivery_log"."id";



CREATE TABLE IF NOT EXISTS "public"."escrow_payment_plans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source_offer_id" "uuid" NOT NULL,
    "job_id" "uuid" NOT NULL,
    "customer_user_id" "uuid" NOT NULL,
    "provider_id" "uuid",
    "currency" "text" DEFAULT 'EUR'::"text" NOT NULL,
    "total_amount" numeric(12,2) NOT NULL,
    "funding_mode" "text" DEFAULT 'full_upfront_escrow'::"text" NOT NULL,
    "release_model" "text" DEFAULT 'start_25_completion_75'::"text" NOT NULL,
    "status" "text" DEFAULT 'awaiting_customer_funding'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "funding_initiated_at" timestamp with time zone,
    "funded_at" timestamp with time zone,
    "external_funding_ref" "text",
    "funding_idempotency_key" "text",
    "platform_fee_rate" numeric(5,4),
    "platform_fee_amount" numeric(12,2),
    "commercial_origin" "text",
    CONSTRAINT "escrow_plans_funding_mode_check" CHECK (("funding_mode" = 'full_upfront_escrow'::"text")),
    CONSTRAINT "escrow_plans_release_model_check" CHECK (("release_model" = 'start_25_completion_75'::"text")),
    CONSTRAINT "escrow_plans_status_check" CHECK (("status" = ANY (ARRAY['awaiting_customer_funding'::"text", 'funding_initiated'::"text", 'funded_in_escrow'::"text", 'partially_released'::"text", 'fully_released'::"text", 'funding_failed'::"text", 'disputed'::"text", 'refunded'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."escrow_payment_plans" OWNER TO "postgres";


COMMENT ON COLUMN "public"."escrow_payment_plans"."platform_fee_rate" IS 'Platform commission rate applied at PI creation: 0.05 (merchant_brought) or 0.09 (platform_acquired). Null for plans created before fee-model wiring.';



COMMENT ON COLUMN "public"."escrow_payment_plans"."platform_fee_amount" IS 'Absolute platform fee in the plan currency, computed as total_amount * platform_fee_rate. Mirrors application_fee_amount sent to Stripe.';



COMMENT ON COLUMN "public"."escrow_payment_plans"."commercial_origin" IS 'Snapshot of jobs.commercial_origin at the moment the PaymentIntent was created. Immutable after first write.';



CREATE TABLE IF NOT EXISTS "public"."escrow_tranches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "plan_id" "uuid" NOT NULL,
    "kind" "text" NOT NULL,
    "percentage" numeric(5,2) NOT NULL,
    "amount" numeric(12,2) NOT NULL,
    "release_trigger" "text" NOT NULL,
    "status" "text" DEFAULT 'pending_funding'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "eligible_at" timestamp with time zone,
    "released_at" timestamp with time zone,
    "external_release_ref" "text",
    "triggered_by" "text",
    "released_by" "text",
    "transfer_reversal_ref" "text",
    "external_payout_ref" "text",
    "payout_attempt_count" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "escrow_tranches_kind_check" CHECK (("kind" = ANY (ARRAY['deposit_release'::"text", 'final_release'::"text"]))),
    CONSTRAINT "escrow_tranches_released_by_check" CHECK ((("released_by" IS NULL) OR ("released_by" = ANY (ARRAY['customer'::"text", 'provider'::"text", 'system'::"text"])))),
    CONSTRAINT "escrow_tranches_status_check" CHECK (("status" = ANY (ARRAY['pending_funding'::"text", 'funded'::"text", 'locked'::"text", 'eligible_for_release'::"text", 'release_pending'::"text", 'released'::"text", 'blocked'::"text", 'disputed'::"text", 'refunded'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "escrow_tranches_trigger_check" CHECK (("release_trigger" = ANY (ARRAY['work_started'::"text", 'work_completed'::"text"]))),
    CONSTRAINT "escrow_tranches_triggered_by_check" CHECK ((("triggered_by" IS NULL) OR ("triggered_by" = ANY (ARRAY['customer'::"text", 'provider'::"text", 'system'::"text"]))))
);


ALTER TABLE "public"."escrow_tranches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."failed_join_attempts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "attempted_by" "uuid",
    "code_input" "text",
    "reason" "text" NOT NULL,
    "attempted_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."failed_join_attempts" OWNER TO "postgres";


COMMENT ON TABLE "public"."failed_join_attempts" IS 'Append-only audit of failed join_company_with_code attempts. Default-deny — only the SECURITY DEFINER RPC writes here. Used for rate-limiting (10 failures / 1h / auth.uid) and operator forensics.';



CREATE TABLE IF NOT EXISTS "public"."funding_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source_offer_id" "uuid" NOT NULL,
    "job_id" "uuid" NOT NULL,
    "escrow_plan_id" "uuid" NOT NULL,
    "customer_user_id" "uuid" NOT NULL,
    "provider_id" "uuid",
    "provider_user_id" "uuid" NOT NULL,
    "type" "text" DEFAULT 'full_escrow'::"text" NOT NULL,
    "status" "text" DEFAULT 'created'::"text" NOT NULL,
    "amount" numeric(12,2) NOT NULL,
    "currency" "text" DEFAULT 'EUR'::"text" NOT NULL,
    "created_by" "text" DEFAULT 'provider'::"text" NOT NULL,
    "conversation_id" "uuid",
    "message_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "sent_at" timestamp with time zone,
    "funded_at" timestamp with time zone,
    "external_funding_ref" "text",
    "funding_idempotency_key" "text",
    "failure_reason" "text",
    "expires_at" bigint DEFAULT ((EXTRACT(epoch FROM ("now"() + '14 days'::interval)) * (1000)::numeric))::bigint,
    CONSTRAINT "funding_requests_created_by_check" CHECK (("created_by" = ANY (ARRAY['provider'::"text", 'system'::"text"]))),
    CONSTRAINT "funding_requests_status_check" CHECK (("status" = ANY (ARRAY['created'::"text", 'sent'::"text", 'funding_started'::"text", 'funding_initiated'::"text", 'funded'::"text", 'funding_failed'::"text", 'expired'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "funding_requests_type_check" CHECK (("type" = 'full_escrow'::"text"))
);


ALTER TABLE "public"."funding_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."internal_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "thread_id" "uuid" NOT NULL,
    "sender_team_member_id" "text",
    "body" "text" NOT NULL,
    "message_kind" "text" DEFAULT 'text'::"text" NOT NULL,
    "created_at" bigint DEFAULT ((EXTRACT(epoch FROM "now"()) * (1000)::numeric))::bigint NOT NULL,
    "updated_at" bigint DEFAULT ((EXTRACT(epoch FROM "now"()) * (1000)::numeric))::bigint NOT NULL,
    "sender_kind" "text" DEFAULT 'user'::"text" NOT NULL,
    CONSTRAINT "internal_messages_message_kind_check" CHECK (("message_kind" = 'text'::"text")),
    CONSTRAINT "internal_messages_sender_kind_check" CHECK (("sender_kind" = ANY (ARRAY['user'::"text", 'system'::"text"]))),
    CONSTRAINT "internal_messages_sender_kind_consistency" CHECK (((("sender_kind" = 'user'::"text") AND ("sender_team_member_id" IS NOT NULL)) OR (("sender_kind" = 'system'::"text") AND ("sender_team_member_id" IS NULL))))
);


ALTER TABLE "public"."internal_messages" OWNER TO "postgres";


COMMENT ON TABLE "public"."internal_messages" IS 'ARCHIVED 2026-05-17: internal_message_threads never shipped. Read-only. Drop after 2026-06-17.';



COMMENT ON COLUMN "public"."internal_messages"."sender_kind" IS 'user = posted by an authenticated team member (sender_team_member_id is set). system = posted by a server endpoint via service_role (sender_team_member_id is null).';



CREATE SEQUENCE IF NOT EXISTS "public"."invoice_number_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."invoice_number_seq" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."invoices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "invoice_number" "text" DEFAULT ''::"text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "parties" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "line_items" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "amounts" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "issued_at_label" "text" DEFAULT ''::"text" NOT NULL,
    "due_at_label" "text" DEFAULT ''::"text" NOT NULL,
    "created_at" bigint DEFAULT 0 NOT NULL,
    "updated_at" bigint DEFAULT 0 NOT NULL,
    "issued_at" bigint DEFAULT 0 NOT NULL,
    "sent_at" bigint DEFAULT 0 NOT NULL,
    "service_period_from" bigint,
    "service_period_to" bigint,
    "service_period_label" "text",
    "tax_breakdown" "jsonb",
    "tax_note" "text",
    "source_offer_id" "uuid",
    "source_change_order_ids" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "source_supplementary_payment_ids" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "provider_snapshot" "jsonb",
    "customer_snapshot" "jsonb",
    "kind" "text" DEFAULT 'invoice'::"text" NOT NULL,
    "original_invoice_id" "uuid",
    "correction_reason" "text",
    "correction_amount_cents" bigint,
    "original_invoice_number" "text",
    "original_invoice_issued_at_label" "text",
    "refund_event_id" "text",
    CONSTRAINT "invoices_correction_integrity_check" CHECK ((("kind" = 'invoice'::"text") OR (("original_invoice_id" IS NOT NULL) AND ("correction_reason" IS NOT NULL) AND ("length"("btrim"("correction_reason")) > 0) AND ("correction_amount_cents" IS NOT NULL) AND ("correction_amount_cents" <> 0)))),
    CONSTRAINT "invoices_kind_check" CHECK (("kind" = ANY (ARRAY['invoice'::"text", 'cancellation'::"text", 'credit_note'::"text"])))
);


ALTER TABLE "public"."invoices" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_assignments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "provider_id" "uuid" NOT NULL,
    "team_member_id" "uuid",
    "assignment_role" "text" DEFAULT 'primary'::"text" NOT NULL,
    "status" "text" DEFAULT 'assigned'::"text" NOT NULL,
    "note" "text",
    "assigned_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "accepted_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "job_assignments_assignment_role_check" CHECK (("assignment_role" = ANY (ARRAY['primary'::"text", 'support'::"text", 'viewer'::"text"]))),
    CONSTRAINT "job_assignments_status_check" CHECK (("status" = ANY (ARRAY['assigned'::"text", 'accepted'::"text", 'declined'::"text", 'removed'::"text", 'completed'::"text"])))
);


ALTER TABLE "public"."job_assignments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."team_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider_id" "uuid" NOT NULL,
    "profile_id" "uuid",
    "full_name" "text" NOT NULL,
    "role" "text" DEFAULT 'worker'::"text" NOT NULL,
    "phone" "text",
    "email" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "name" "text",
    "avatar_url" "text",
    "weekly_target_hours" numeric,
    "daily_target_hours" numeric,
    CONSTRAINT "team_members_daily_target_hours_range" CHECK ((("daily_target_hours" IS NULL) OR (("daily_target_hours" >= (0)::numeric) AND ("daily_target_hours" <= (24)::numeric)))),
    CONSTRAINT "team_members_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'manager'::"text", 'worker'::"text", 'subcontractor'::"text"]))),
    CONSTRAINT "team_members_weekly_target_hours_range" CHECK ((("weekly_target_hours" IS NULL) OR (("weekly_target_hours" >= (0)::numeric) AND ("weekly_target_hours" <= (168)::numeric))))
);


ALTER TABLE "public"."team_members" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."job_assignment_details" WITH ("security_invoker"='true') AS
 SELECT "ja"."id",
    "ja"."job_id",
    "ja"."provider_id",
    "ja"."team_member_id",
    "ja"."assignment_role",
    "ja"."status",
    "ja"."note",
    "ja"."assigned_at",
    "ja"."accepted_at",
    "ja"."completed_at",
    "ja"."created_at",
    "ja"."updated_at",
    "j"."title" AS "job_title",
    "j"."status" AS "job_status",
    "j"."city" AS "job_city",
    "tm"."full_name" AS "team_member_name",
    "tm"."role" AS "team_member_role",
    "tm"."phone" AS "team_member_phone",
    "p"."company_name" AS "provider_company_name"
   FROM ((("public"."job_assignments" "ja"
     LEFT JOIN "public"."jobs" "j" ON (("ja"."job_id" = "j"."id")))
     LEFT JOIN "public"."team_members" "tm" ON (("ja"."team_member_id" = "tm"."id")))
     LEFT JOIN "public"."providers" "p" ON (("ja"."provider_id" = "p"."id")));


ALTER VIEW "public"."job_assignment_details" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."job_details" WITH ("security_invoker"='true') AS
 SELECT "j"."id",
    "j"."customer_profile_id",
    "j"."provider_id",
    "j"."title",
    "j"."description",
    "j"."city",
    "j"."status",
    "j"."budget_amount",
    "j"."scheduled_for",
    "j"."created_at",
    "j"."updated_at",
    "customer"."display_name" AS "customer_display_name",
    "customer"."phone" AS "customer_phone",
    "p"."company_name" AS "provider_company_name",
    "p"."city" AS "provider_city",
    "p"."verified" AS "provider_verified",
    "p"."avatar_url" AS "provider_avatar_url",
    "provider_profile"."display_name" AS "provider_display_name",
    "provider_profile"."phone" AS "provider_phone",
    "provider_profile"."craftsman_role" AS "provider_craftsman_role"
   FROM ((("public"."jobs" "j"
     LEFT JOIN "public"."profiles" "customer" ON (("j"."customer_profile_id" = "customer"."id")))
     LEFT JOIN "public"."providers" "p" ON (("j"."provider_id" = "p"."id")))
     LEFT JOIN "public"."profiles" "provider_profile" ON (("p"."profile_id" = "provider_profile"."id")));


ALTER VIEW "public"."job_details" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_feedback" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "craftsman_user_id" "text" DEFAULT ''::"text" NOT NULL,
    "would_hire_again" boolean DEFAULT false NOT NULL,
    "note" "text",
    "created_at" bigint DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."job_feedback" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."job_integrity_overview" WITH ("security_invoker"='true') AS
 SELECT "j"."id" AS "job_id",
    "j"."title",
    "j"."status",
    "j"."city",
    "j"."provider_id",
    "j"."assigned_provider_id",
    "j"."assigned_team_member_id",
    "j"."assignment_status",
    "j"."dispute_id",
    "j"."dispute_status",
    "p"."id" AS "payment_id",
    "p"."status" AS "payment_status",
        CASE
            WHEN (("j"."status" = ANY (ARRAY['in_progress'::"text", 'completed'::"text"])) AND ("j"."assigned_provider_id" IS NULL)) THEN 'execution_without_provider'::"text"
            WHEN (("j"."assignment_status" = 'assigned'::"text") AND ("j"."assigned_team_member_id" IS NULL)) THEN 'assigned_without_team_member'::"text"
            WHEN (("j"."dispute_status" IS NOT NULL) AND ("j"."dispute_id" IS NULL)) THEN 'dispute_status_without_dispute'::"text"
            WHEN (("j"."status" = 'completed'::"text") AND ("p"."id" IS NULL)) THEN 'completed_without_payment'::"text"
            ELSE NULL::"text"
        END AS "integrity_flag"
   FROM ("public"."jobs" "j"
     LEFT JOIN "public"."payments" "p" ON (("p"."job_id" = "j"."id")));


ALTER VIEW "public"."job_integrity_overview" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_photos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "provider_id" "uuid" NOT NULL,
    "uploaded_by" "uuid" NOT NULL,
    "storage_path" "text" NOT NULL,
    "client_uuid" "uuid" NOT NULL,
    "width_px" integer,
    "height_px" integer,
    "size_bytes" bigint,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."job_photos" REPLICA IDENTITY FULL;


ALTER TABLE "public"."job_photos" OWNER TO "postgres";


COMMENT ON TABLE "public"."job_photos" IS 'Worker-Doku Foto-Capture Append-Only — REPLICA IDENTITY FULL für DELETE-Realtime-Filter auf job_id (siehe Migration 20260508000004).';



CREATE TABLE IF NOT EXISTS "public"."job_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "provider_id" "uuid" NOT NULL,
    "authored_by" "uuid" NOT NULL,
    "body" "text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "job_reports_body_length" CHECK ((("length"(TRIM(BOTH FROM "body")) >= 1) AND ("length"("body") <= 10000)))
);

ALTER TABLE ONLY "public"."job_reports" REPLICA IDENTITY FULL;


ALTER TABLE "public"."job_reports" OWNER TO "postgres";


COMMENT ON TABLE "public"."job_reports" IS 'Worker-Doku Berichte mit 24h-Edit-Window — REPLICA IDENTITY FULL für DELETE-Realtime-Filter auf job_id (siehe Migration 20260508000004).';



CREATE TABLE IF NOT EXISTS "public"."ledger_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "payment_id" "uuid",
    "job_id" "uuid",
    "dispute_id" "uuid",
    "entry_type" "text" NOT NULL,
    "amount" numeric NOT NULL,
    "currency" "text" DEFAULT 'EUR'::"text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "type" "text",
    "movement_ref" "text" DEFAULT ''::"text" NOT NULL,
    CONSTRAINT "ledger_entries_amount_positive" CHECK (("amount" >= (0)::numeric)),
    CONSTRAINT "ledger_entries_entry_type_check" CHECK (("entry_type" = ANY (ARRAY['escrow_deposit'::"text", 'platform_fee'::"text", 'payout'::"text", 'refund'::"text", 'dispute_hold'::"text", 'refund_partial'::"text", 'payout_adjustment'::"text", 'escrow_release'::"text", 'escrow_refund'::"text"])))
);


ALTER TABLE "public"."ledger_entries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."media_artifacts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "kind" "text" DEFAULT ''::"text" NOT NULL,
    "label" "text" DEFAULT ''::"text" NOT NULL,
    "filename" "text" DEFAULT ''::"text" NOT NULL,
    "mime_type" "text" DEFAULT ''::"text" NOT NULL,
    "uploaded_at" bigint DEFAULT 0 NOT NULL,
    "uploaded_by" "text" DEFAULT ''::"text" NOT NULL,
    "notes" "text",
    "dispute_id" "uuid",
    "timeline_event_id" "uuid"
);


ALTER TABLE "public"."media_artifacts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."media_uploads" (
    "id" "text" NOT NULL,
    "owner_user_id" "text" NOT NULL,
    "entity_type" "text" DEFAULT ''::"text" NOT NULL,
    "entity_id" "text" DEFAULT ''::"text" NOT NULL,
    "file_path" "text" DEFAULT ''::"text" NOT NULL,
    "public_url" "text" DEFAULT ''::"text" NOT NULL,
    "mime_type" "text" DEFAULT ''::"text" NOT NULL,
    "media_type" "text" DEFAULT 'image'::"text" NOT NULL,
    "created_at" bigint DEFAULT 0 NOT NULL,
    "media_role" "text" DEFAULT ''::"text" NOT NULL,
    "customer_visible" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."media_uploads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."message_thread_participants" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "thread_id" "uuid" NOT NULL,
    "team_member_id" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "last_read_at" bigint,
    "created_at" bigint DEFAULT ((EXTRACT(epoch FROM "now"()) * (1000)::numeric))::bigint NOT NULL
);


ALTER TABLE "public"."message_thread_participants" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."message_threads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider_id" "uuid" NOT NULL,
    "thread_type" "text" NOT NULL,
    "calendar_entry_id" "uuid",
    "created_by_team_member_id" "text" NOT NULL,
    "title" "text",
    "last_message_at" bigint,
    "last_message_body" "text",
    "created_at" bigint DEFAULT ((EXTRACT(epoch FROM "now"()) * (1000)::numeric))::bigint NOT NULL,
    "updated_at" bigint DEFAULT ((EXTRACT(epoch FROM "now"()) * (1000)::numeric))::bigint NOT NULL,
    CONSTRAINT "message_threads_thread_type_check" CHECK (("thread_type" = ANY (ARRAY['assignment'::"text", 'office'::"text", 'team'::"text"])))
);


ALTER TABLE "public"."message_threads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."messages" (
    "id" "text" NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "sender_user_id" "uuid" NOT NULL,
    "content" "text",
    "created_at" bigint NOT NULL,
    "media_url" "text"
);


ALTER TABLE "public"."messages" OWNER TO "postgres";


COMMENT ON TABLE "public"."messages" IS 'LEGACY (retired 2026-06-11, Chat-Cutover): read-only Archiv. Writes laufen auf chat_messages. DROP frühestens nach Safety-Window 2026-07-11, wenn Lazy-Message-Migration abgeschlossen ist.';



CREATE TABLE IF NOT EXISTS "public"."moderation_action_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "operator_id" "uuid",
    "report_id" "uuid",
    "action_type" "text" NOT NULL,
    "target_user_id" "uuid",
    "target_entity_type" "text",
    "target_entity_id" "text",
    "notes" "text",
    "suspension_until" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "moderation_action_log_action_type_check" CHECK (("action_type" = ANY (ARRAY['warn'::"text", 'hide_content'::"text", 'suspend'::"text", 'ban'::"text", 'dismiss'::"text"])))
);


ALTER TABLE "public"."moderation_action_log" OWNER TO "postgres";


COMMENT ON TABLE "public"."moderation_action_log" IS 'Append-only audit of every enforcement action. Writes only via operator_enforce_report() SECURITY DEFINER RPC.';



COMMENT ON COLUMN "public"."moderation_action_log"."operator_id" IS 'NULL = Operator-Konto geloescht (DSGVO Art. 17, FK ON DELETE SET NULL).';



COMMENT ON COLUMN "public"."moderation_action_log"."report_id" IS 'NULL = zugehoeriger user_reports-Eintrag via Account-Cascade geloescht.';



COMMENT ON COLUMN "public"."moderation_action_log"."target_user_id" IS 'NULL = Ziel-Konto geloescht (DSGVO Art. 17, FK ON DELETE SET NULL).';



CREATE TABLE IF NOT EXISTS "public"."notification_device_tokens" (
    "user_id" "text" NOT NULL,
    "token" "text" NOT NULL,
    "platform" "text" DEFAULT 'ios'::"text" NOT NULL,
    "updated_at" bigint DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."notification_device_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notification_signals" (
    "id" "text" DEFAULT ("gen_random_uuid"())::"text" NOT NULL,
    "job_id" "uuid" NOT NULL,
    "type" "text" DEFAULT ''::"text" NOT NULL,
    "priority" "text" DEFAULT 'low'::"text" NOT NULL,
    "read" boolean DEFAULT false NOT NULL,
    "occurred_at" bigint DEFAULT 0 NOT NULL,
    "recipient_role" "text" DEFAULT 'craftsman'::"text" NOT NULL,
    "entity_id" "text",
    "entity_type" "text",
    "action_type" "text",
    "role_target" "text",
    "expected_status" "text",
    "expires_at" bigint
);


ALTER TABLE "public"."notification_signals" OWNER TO "postgres";


COMMENT ON COLUMN "public"."notification_signals"."entity_id" IS 'A.2 — domain entity UUID targeted by an inline push action. NULL = no action button.';



COMMENT ON COLUMN "public"."notification_signals"."entity_type" IS 'A.2 — domain type of entity_id.';



COMMENT ON COLUMN "public"."notification_signals"."action_type" IS 'A.2 — logical class of the inline action.';



COMMENT ON COLUMN "public"."notification_signals"."role_target" IS 'A.2 — expected recipient role at action execution time.';



COMMENT ON COLUMN "public"."notification_signals"."expected_status" IS 'A.2 — expected entity status; dispatcher drops if stale.';



COMMENT ON COLUMN "public"."notification_signals"."expires_at" IS 'A.2 — Unix ms timestamp after which the lockscreen buttons should not be shown.';



CREATE TABLE IF NOT EXISTS "public"."operator_action_audit" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "operator_id" "uuid" NOT NULL,
    "action_type" "text" NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "uuid",
    "metadata" "jsonb",
    "created_at" bigint DEFAULT (EXTRACT(epoch FROM "now"()) * (1000)::numeric) NOT NULL
);


ALTER TABLE "public"."operator_action_audit" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."owner_notes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "authored_by" "uuid" NOT NULL,
    "body" "text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "owner_notes_body_length" CHECK ((("length"(TRIM(BOTH FROM "body")) >= 1) AND ("length"("body") <= 10000)))
);

ALTER TABLE ONLY "public"."owner_notes" REPLICA IDENTITY FULL;


ALTER TABLE "public"."owner_notes" OWNER TO "postgres";


COMMENT ON TABLE "public"."owner_notes" IS 'Block FU.5 · Owner-side documentation notes. 1:N to jobs. Owner writes (own-provider guard); workers read. Mirrors job_reports pattern. Replaces legacy Job.notes[] for owner documentation path.';



CREATE TABLE IF NOT EXISTS "public"."parametric_cleanup_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ran_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source" "text" NOT NULL,
    "files_deleted" integer DEFAULT 0 NOT NULL,
    "orphan_count" integer DEFAULT 0 NOT NULL,
    "grace_days" integer DEFAULT 7 NOT NULL,
    "duration_ms" integer,
    "error_detail" "text",
    CONSTRAINT "parametric_cleanup_log_source_check" CHECK (("source" = ANY (ARRAY['cron'::"text", 'manual'::"text"])))
);


ALTER TABLE "public"."parametric_cleanup_log" OWNER TO "postgres";


COMMENT ON TABLE "public"."parametric_cleanup_log" IS 'Spatial V1.6.1 L4.c · Append-only audit for spatial-parametric orphan-cleanup runs. Service-role only.';



CREATE OR REPLACE VIEW "public"."payment_details" WITH ("security_invoker"='true') AS
 SELECT "p"."id",
    "p"."job_id",
    "p"."project_id",
    "p"."provider_id",
    "p"."customer_profile_id",
    "p"."provider_stripe_account_id",
    "p"."stripe_payment_intent_id",
    "p"."stripe_checkout_session_id",
    "p"."stripe_refund_id",
    "p"."stripe_transfer_id",
    "p"."currency",
    "p"."amount_total",
    "p"."amount_captured",
    "p"."amount_refunded",
    "p"."platform_fee_amount",
    "p"."status",
    "p"."payment_method_type",
    "p"."payment_provider",
    "p"."escrow_created_at",
    "p"."captured_at",
    "p"."refunded_at",
    "p"."failed_at",
    "p"."cancelled_at",
    "p"."failure_reason",
    "p"."metadata",
    "p"."created_at",
    "p"."updated_at",
    "j"."title" AS "job_title",
    "j"."status" AS "job_status",
    "pr"."company_name" AS "provider_company_name",
    "cp"."display_name" AS "customer_display_name"
   FROM ((("public"."payments" "p"
     LEFT JOIN "public"."jobs" "j" ON (("p"."job_id" = "j"."id")))
     LEFT JOIN "public"."providers" "pr" ON (("p"."provider_id" = "pr"."id")))
     LEFT JOIN "public"."profiles" "cp" ON (("p"."customer_profile_id" = "cp"."id")));


ALTER VIEW "public"."payment_details" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."payment_lifecycle_overview" WITH ("security_invoker"='true') AS
 SELECT "p"."id" AS "payment_id",
    "p"."job_id",
    "p"."project_id",
    "p"."provider_id",
    "p"."customer_profile_id",
    "p"."status",
    "p"."payment_provider",
    "p"."amount_total",
    "p"."amount_captured",
    "p"."amount_released",
    "p"."amount_refunded",
    "p"."amount_disputed",
    "p"."amount_held",
    "p"."platform_fee_amount",
    "p"."split_resolution_ratio",
    "p"."last_stripe_event_id",
    "p"."last_stripe_event_type",
    "p"."reconciled_at",
    "j"."title" AS "job_title",
    "j"."status" AS "job_status",
    "d"."id" AS "dispute_id",
    "d"."status" AS "dispute_status"
   FROM (("public"."payments" "p"
     LEFT JOIN "public"."jobs" "j" ON (("p"."job_id" = "j"."id")))
     LEFT JOIN "public"."disputes" "d" ON (("p"."dispute_id" = "d"."id")));


ALTER VIEW "public"."payment_lifecycle_overview" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stripe_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "stripe_event_id" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "livemode" boolean,
    "api_version" "text",
    "object_id" "text",
    "payment_intent_id" "text",
    "checkout_session_id" "text",
    "refund_id" "text",
    "event_created_at" timestamp with time zone,
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "processed_at" timestamp with time zone,
    "processing_status" "text" DEFAULT 'received'::"text" NOT NULL,
    "processing_error" "text",
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "stripe_events_processing_status_check" CHECK (("processing_status" = ANY (ARRAY['received'::"text", 'processing'::"text", 'processed'::"text", 'ignored'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."stripe_events" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."payment_reconciliation_details" WITH ("security_invoker"='true') AS
 SELECT "p"."id" AS "payment_id",
    "p"."job_id",
    "p"."project_id",
    "p"."status" AS "payment_status",
    "p"."stripe_status",
    "p"."stripe_payment_intent_id",
    "p"."stripe_checkout_session_id",
    "p"."last_stripe_event_id",
    "p"."last_stripe_event_type",
    "p"."reconciled_at",
    "p"."amount_total",
    "p"."amount_captured",
    "p"."amount_refunded",
    "p"."created_at",
    "p"."updated_at",
    "se"."event_type" AS "latest_event_type",
    "se"."processing_status" AS "latest_event_processing_status",
    "se"."received_at" AS "latest_event_received_at",
    "se"."processed_at" AS "latest_event_processed_at"
   FROM ("public"."payments" "p"
     LEFT JOIN "public"."stripe_events" "se" ON (("se"."stripe_event_id" = "p"."last_stripe_event_id")));


ALTER VIEW "public"."payment_reconciliation_details" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."payment_risk_overview" WITH ("security_invoker"='true') AS
 SELECT "p"."id" AS "payment_id",
    "p"."job_id",
    "p"."project_id",
    "p"."provider_id",
    "p"."customer_profile_id",
    "p"."status" AS "payment_status",
    "p"."stripe_status",
    "p"."amount_total",
    "p"."amount_captured",
    "p"."amount_refunded",
    "p"."dispute_id",
    "p"."dispute_status",
    "p"."release_blocked",
    "p"."reconciled_at",
    "p"."last_stripe_event_type",
    "p"."last_stripe_event_id",
    "j"."title" AS "job_title",
    "j"."status" AS "job_status",
    "d"."status" AS "dispute_status_live",
        CASE
            WHEN (("p"."release_blocked" = true) AND ("d"."id" IS NULL)) THEN 'blocked_without_dispute'::"text"
            WHEN (("p"."status" = 'released'::"text") AND ("d"."status" = ANY (ARRAY['open'::"text", 'under_review'::"text", 'customer_waiting'::"text", 'provider_waiting'::"text"]))) THEN 'released_while_disputed'::"text"
            WHEN (("p"."status" = 'disputed'::"text") AND ("d"."id" IS NULL)) THEN 'disputed_without_dispute_record'::"text"
            WHEN (("p"."status" = ANY (ARRAY['escrowed'::"text", 'authorized'::"text"])) AND ("p"."reconciled_at" IS NULL)) THEN 'unreconciled_escrow'::"text"
            ELSE NULL::"text"
        END AS "risk_flag"
   FROM (("public"."payments" "p"
     LEFT JOIN "public"."jobs" "j" ON (("p"."job_id" = "j"."id")))
     LEFT JOIN "public"."disputes" "d" ON (("p"."dispute_id" = "d"."id")));


ALTER VIEW "public"."payment_risk_overview" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payment_status_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "payment_id" "uuid" NOT NULL,
    "previous_status" "text",
    "next_status" "text" NOT NULL,
    "source" "text" NOT NULL,
    "stripe_event_id" "text",
    "note" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "payment_status_history_source_check" CHECK (("source" = ANY (ARRAY['client'::"text", 'server'::"text", 'webhook'::"text", 'system'::"text", 'admin'::"text"])))
);


ALTER TABLE "public"."payment_status_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."projects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source_job_id" "uuid",
    "title" "text",
    "customer_profile_id" "uuid",
    "craftsman_user_id" "uuid",
    "location" "text",
    "status" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "customer_user_id" "uuid",
    "payment_state" "text" DEFAULT 'none'::"text" NOT NULL,
    "commercial_origin" "text",
    "source" "text",
    "category" "text",
    "description" "text",
    "requested_budget" "text",
    "requested_timing" "text",
    "room_scan_url" "text",
    "room_scan_metadata" "jsonb",
    CONSTRAINT "projects_commercial_origin_check" CHECK (("commercial_origin" = ANY (ARRAY['merchant_brought'::"text", 'platform_acquired'::"text", 'unknown_pending_resolution'::"text"])))
);


ALTER TABLE "public"."projects" OWNER TO "postgres";


COMMENT ON COLUMN "public"."projects"."source" IS '''builder'' | ''inquiry'' | ''direct''';



COMMENT ON COLUMN "public"."projects"."category" IS 'Trade category, e.g. ''Elektrik'', ''Bad''';



COMMENT ON COLUMN "public"."projects"."description" IS 'Free-text description of the required work';



COMMENT ON COLUMN "public"."projects"."requested_budget" IS 'Customer budget expectation, e.g. ''unter 2.000 €''';



COMMENT ON COLUMN "public"."projects"."requested_timing" IS 'Customer timing preference, e.g. ''Innerhalb 4 Wochen''';



COMMENT ON COLUMN "public"."projects"."room_scan_url" IS 'DEPRECATED 2026-05-17 (Spatial Block B): superseded by public.scans + public.scan_assets. 0 rows at deprecation time. Will be dropped in a post-V1 cleanup migration.';



COMMENT ON COLUMN "public"."projects"."room_scan_metadata" IS 'DEPRECATED 2026-05-17 (Spatial Block B): superseded by public.scans.device_meta + public.scan_quality_reports. 0 rows at deprecation time. Will be dropped in a post-V1 cleanup migration.';



CREATE TABLE IF NOT EXISTS "public"."provider_highlight_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "highlight_id" "uuid" NOT NULL,
    "portfolio_item_id" "uuid" NOT NULL,
    "position" smallint DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."provider_highlight_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."provider_highlights" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider_user_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "position" smallint DEFAULT 0 NOT NULL,
    "cover_portfolio_item_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "provider_highlights_title_check" CHECK ((("char_length"("title") >= 1) AND ("char_length"("title") <= 30)))
);


ALTER TABLE "public"."provider_highlights" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."provider_media" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider_id" "uuid" NOT NULL,
    "kind" "text" NOT NULL,
    "storage_path" "text",
    "public_url" "text",
    "caption" "text",
    "sort_order" bigint DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "media_type" "text" DEFAULT 'image'::"text" NOT NULL,
    "title" "text",
    "description" "text",
    "trade_tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "published" boolean DEFAULT true NOT NULL,
    "show_price" boolean DEFAULT false NOT NULL,
    "show_duration" boolean DEFAULT false NOT NULL,
    "source_job_id" "text",
    "project_title_snapshot" "text",
    "location_snapshot" "text",
    "duration_snapshot" "text",
    "amount_snapshot" "text",
    "trade_tags_snapshot" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "poster_url" "text",
    "h264_url" "text",
    CONSTRAINT "provider_media_kind_check" CHECK (("kind" = ANY (ARRAY['avatar'::"text", 'portfolio'::"text", 'cover'::"text"])))
);


ALTER TABLE "public"."provider_media" OWNER TO "postgres";


COMMENT ON COLUMN "public"."provider_media"."h264_url" IS 'Public URL of an H.264 .mp4 transcode of the source video. Set asynchronously by the transcode pipeline (Block 0); null while pending or for non-video items. Renderers prefer this URL on browsers that cannot decode the source codec.';



CREATE TABLE IF NOT EXISTS "public"."provider_media_assets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "portfolio_item_id" "uuid" NOT NULL,
    "provider_id" "uuid" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "media_type" "text" NOT NULL,
    "storage_path" "text",
    "public_url" "text" NOT NULL,
    "poster_url" "text",
    "h264_url" "text",
    "trim_start_ms" integer DEFAULT 0 NOT NULL,
    "trim_end_ms" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "provider_media_assets_media_type_check" CHECK (("media_type" = ANY (ARRAY['image'::"text", 'video'::"text"])))
);


ALTER TABLE "public"."provider_media_assets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."provider_media_comment_likes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "comment_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."provider_media_comment_likes" REPLICA IDENTITY FULL;


ALTER TABLE "public"."provider_media_comment_likes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."provider_media_comments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "media_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "parent_comment_id" "uuid",
    "edited_at" timestamp with time zone,
    CONSTRAINT "pmc_no_self_parent" CHECK ((("parent_comment_id" IS NULL) OR ("parent_comment_id" <> "id"))),
    CONSTRAINT "provider_media_comments_body_max_len" CHECK (("length"("body") <= 500)),
    CONSTRAINT "provider_media_comments_body_nonempty" CHECK (("length"("btrim"("body")) > 0))
);

ALTER TABLE ONLY "public"."provider_media_comments" REPLICA IDENTITY FULL;


ALTER TABLE "public"."provider_media_comments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."provider_media_likes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "media_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."provider_media_likes" REPLICA IDENTITY FULL;


ALTER TABLE "public"."provider_media_likes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."provider_media_saves" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "media_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "folder_id" "uuid"
);

ALTER TABLE ONLY "public"."provider_media_saves" REPLICA IDENTITY FULL;


ALTER TABLE "public"."provider_media_saves" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."provider_media_tag_cooccur" WITH ("security_invoker"='true') AS
 SELECT "t1"."tag" AS "tag_a",
    "t2"."tag" AS "tag_b",
    ("count"(*))::integer AS "cooccur_count"
   FROM (("public"."provider_media" "pm"
     CROSS JOIN LATERAL "unnest"("pm"."trade_tags") "t1"("tag"))
     CROSS JOIN LATERAL "unnest"("pm"."trade_tags") "t2"("tag"))
  WHERE (("pm"."kind" = 'portfolio'::"text") AND ("pm"."published" = true) AND ("t1"."tag" <> "t2"."tag") AND ("t1"."tag" IS NOT NULL) AND ("length"(TRIM(BOTH FROM "t1"."tag")) > 0) AND ("t2"."tag" IS NOT NULL) AND ("length"(TRIM(BOTH FROM "t2"."tag")) > 0))
  GROUP BY "t1"."tag", "t2"."tag";


ALTER VIEW "public"."provider_media_tag_cooccur" OWNER TO "postgres";


COMMENT ON VIEW "public"."provider_media_tag_cooccur" IS 'M3.2 ranking adjacency: counts of (tag_a, tag_b) co-occurrences across public published portfolio items. Read-only; no RLS bypass. The Reels for-you ranker queries tag_b values by tag_a sorted by count desc.';



CREATE TABLE IF NOT EXISTS "public"."provider_payout_accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider_user_id" "uuid" NOT NULL,
    "stripe_connect_account_id" "text",
    "onboarding_status" "text" DEFAULT 'not_started'::"text" NOT NULL,
    "charges_enabled" boolean DEFAULT false NOT NULL,
    "payouts_enabled" boolean DEFAULT false NOT NULL,
    "onboarding_completed_at" timestamp with time zone,
    "requirements_due" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "provider_payout_accounts_onboarding_status_check" CHECK (("onboarding_status" = ANY (ARRAY['not_started'::"text", 'onboarding_in_progress'::"text", 'onboarding_complete'::"text", 'payout_blocked'::"text"])))
);


ALTER TABLE "public"."provider_payout_accounts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."provider_presales_projects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider_org_id" "uuid" NOT NULL,
    "created_by_user_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "location_hint" "text",
    "customer_name_draft" "text",
    "customer_email_draft" "text",
    "customer_phone_draft" "text",
    "notes" "text",
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "scanned_at" timestamp with time zone,
    "quoted_at" timestamp with time zone,
    "converted_at" timestamp with time zone,
    "converted_to_job_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "presales_status_chk" CHECK (("status" = ANY (ARRAY['draft'::"text", 'scanned'::"text", 'quoted'::"text", 'converted'::"text", 'archived'::"text"])))
);


ALTER TABLE "public"."provider_presales_projects" OWNER TO "postgres";


COMMENT ON TABLE "public"."provider_presales_projects" IS 'Provider-initiated pre-sales 3D-project. Created before a customer-job exists. Converts to a real `jobs` row once the customer agrees. provider_org_id is the hard ownership anchor; created_by_user_id is the audit-attribution.';



CREATE TABLE IF NOT EXISTS "public"."provider_saves" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider_id" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."provider_saves" REPLICA IDENTITY FULL;


ALTER TABLE "public"."provider_saves" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."push_action_audit" (
    "notification_id" "uuid" NOT NULL,
    "action_id" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "performed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."push_action_audit" OWNER TO "postgres";


COMMENT ON TABLE "public"."push_action_audit" IS 'Append-only audit of push-inline-action taps (APPROVE/REJECT). PK on (notification_id, action_id) gives persistent idempotency across app restarts — a re-tap from Notification Center after app-kill is rejected here even though the in-memory 5 s window is gone. Default-deny RLS + REVOKE writes; the only writer is the SECURITY DEFINER record_push_action_attempt RPC.';



CREATE TABLE IF NOT EXISTS "public"."revenuecat_webhook_events" (
    "event_id" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "event_timestamp_ms" bigint NOT NULL,
    "app_user_id" "text",
    "payload" "jsonb" NOT NULL,
    "outcome" "text" NOT NULL,
    "outcome_reason" "text",
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "processed_at" timestamp with time zone,
    CONSTRAINT "rc_webhook_events_outcome_check" CHECK (("outcome" = ANY (ARRAY['processed'::"text", 'duplicate'::"text", 'failed'::"text", 'skipped'::"text"])))
);


ALTER TABLE "public"."revenuecat_webhook_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."saved_reel_folders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "sort_order" bigint DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "srf_name_length" CHECK ((("length"("btrim"("name")) >= 1) AND ("length"("btrim"("name")) <= 60)))
);

ALTER TABLE ONLY "public"."saved_reel_folders" REPLICA IDENTITY FULL;


ALTER TABLE "public"."saved_reel_folders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scan_annotations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "scan_id" "uuid" NOT NULL,
    "kind" "public"."scan_annotation_kind" NOT NULL,
    "anchor_uv" "jsonb",
    "anchor_world_cache" "jsonb",
    "anchor_ar_hint" "jsonb",
    "anchor_2d" "jsonb",
    "last_drift_check_at" timestamp with time zone,
    "last_drift_distance_m" numeric(8,4),
    "confidence" "public"."scan_anchor_confidence" DEFAULT 'high'::"public"."scan_anchor_confidence" NOT NULL,
    "photo_asset_id" "text",
    "note" "text",
    "status" "public"."scan_annotation_status" DEFAULT 'open'::"public"."scan_annotation_status" NOT NULL,
    "gewerk" "text",
    "offer_relevant" boolean DEFAULT false NOT NULL,
    "offer_line_item_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "customer_visible" boolean DEFAULT true NOT NULL,
    "customer_pin_type" "text",
    CONSTRAINT "scan_annotations_customer_pin_type_chk" CHECK ((("customer_pin_type" IS NULL) OR ("customer_pin_type" = ANY (ARRAY['door'::"text", 'window'::"text", 'heating'::"text", 'electrical'::"text"])))),
    CONSTRAINT "scan_annotations_has_some_anchor_chk" CHECK ((("anchor_uv" IS NOT NULL) OR ("anchor_2d" IS NOT NULL)))
);


ALTER TABLE "public"."scan_annotations" OWNER TO "postgres";


COMMENT ON TABLE "public"."scan_annotations" IS 'Spatial Core: pins with D2 Hybrid Anchor + Drift-Detection. CHECK requires at least anchor_uv OR anchor_2d.';



COMMENT ON COLUMN "public"."scan_annotations"."anchor_uv" IS 'D2 Layer 1 (SoT): {surface_external_id, uv:[u,v]}. UV always wins on conflict.';



COMMENT ON COLUMN "public"."scan_annotations"."anchor_world_cache" IS 'D2 Layer 2: per-format cached World-XYZ for 1ms render + drift comparison.';



COMMENT ON COLUMN "public"."scan_annotations"."anchor_ar_hint" IS 'D2 Layer 3 (iOS only): ARWorldMap-Anchor for re-scan Visual-SLAM cross-check.';



COMMENT ON COLUMN "public"."scan_annotations"."anchor_2d" IS 'D2 Layer 4: SVG-Floorplan fallback.';



COMMENT ON COLUMN "public"."scan_annotations"."confidence" IS 'high / medium / low / lost.';



COMMENT ON COLUMN "public"."scan_annotations"."offer_line_item_id" IS 'V2 deferred Block F. FK NOT enforced here.';



COMMENT ON COLUMN "public"."scan_annotations"."customer_visible" IS 'Lane 3 V1.6 Block 3: HW-toggled visibility per pin. true = customer sees this pin in shared scans. Default true except for note/gewerk_marker kinds (internal HW info). HW + workers + operators always see every pin; customer-viewers (HW-shared scan job customers, Self-Scan owners) only see customer_visible=true.';



COMMENT ON COLUMN "public"."scan_annotations"."customer_pin_type" IS 'V1.6 Phase 1d: Customer-UX pin classification. NULL = HW-only pin, no typification. door/window/heating/electrical = Customer-typed structural element. Orthogonal to kind — both can be set simultaneously (e.g. kind=damage + customer_pin_type=door). Phase 2: door/window populated automatically by LiDAR-RoomPlan detection.';



CREATE TABLE IF NOT EXISTS "public"."scan_assets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "scan_id" "uuid" NOT NULL,
    "kind" "public"."scan_asset_kind" NOT NULL,
    "storage_path" "text" NOT NULL,
    "bytes" bigint,
    "sha256" "text",
    "converted_from" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."scan_assets" OWNER TO "postgres";


COMMENT ON TABLE "public"."scan_assets" IS 'Spatial Core: files attached to a scan. UNIQUE(scan_id, kind) = one file per format per scan.';



COMMENT ON COLUMN "public"."scan_assets"."converted_from" IS 'D1: glTF row points to its source USDZ row. NULL for native captures.';



CREATE TABLE IF NOT EXISTS "public"."scan_cleanup_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ran_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source" "text" NOT NULL,
    "files_deleted" integer DEFAULT 0 NOT NULL,
    "bytes_freed" bigint DEFAULT 0 NOT NULL,
    "orphan_count" integer DEFAULT 0 NOT NULL,
    "expired_count" integer DEFAULT 0 NOT NULL,
    "rows_pruned" integer DEFAULT 0 NOT NULL,
    "duration_ms" integer,
    "error_detail" "text",
    CONSTRAINT "scan_cleanup_log_source_check" CHECK (("source" = ANY (ARRAY['cron'::"text", 'manual'::"text"])))
);


ALTER TABLE "public"."scan_cleanup_log" OWNER TO "postgres";


COMMENT ON TABLE "public"."scan_cleanup_log" IS 'Spatial · Append-only audit for project-scans storage GC runs (orphan + archived-expired). Service-role only (RLS default-deny + REVOKE writes). rows_pruned = scan_assets rows deleted in the expired pass. error_detail NULL on full success. source=cron when fired by pg_cron, manual otherwise.';



CREATE TABLE IF NOT EXISTS "public"."scan_measurements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "scan_id" "uuid" NOT NULL,
    "surface_id" "uuid",
    "label" "text",
    "value_estimated_m" numeric(8,4),
    "value_verified_m" numeric(8,4),
    "unit" "text" DEFAULT 'm'::"text" NOT NULL,
    "status" "public"."scan_measurement_status" DEFAULT 'estimated_roomplan'::"public"."scan_measurement_status" NOT NULL,
    "source" "public"."scan_measurement_source" DEFAULT 'roomplan'::"public"."scan_measurement_source" NOT NULL,
    "verified_by" "uuid",
    "verified_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "scan_measurements_unit_m_only_chk" CHECK (("unit" = 'm'::"text")),
    CONSTRAINT "scan_measurements_verified_consistency_chk" CHECK ((("status" <> 'provider_verified'::"public"."scan_measurement_status") OR (("value_verified_m" IS NOT NULL) AND ("verified_by" IS NOT NULL) AND ("verified_at" IS NOT NULL))))
);


ALTER TABLE "public"."scan_measurements" OWNER TO "postgres";


COMMENT ON TABLE "public"."scan_measurements" IS 'Spatial Core: atomic measurements with FSM estimated_* -> verified_*. CHECK enforces verified state has all three fields set.';



CREATE TABLE IF NOT EXISTS "public"."scan_rooms" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "scan_id" "uuid" NOT NULL,
    "name" "text",
    "area_m2_estimated" numeric(8,3),
    "area_m2_verified" numeric(8,3),
    "ceiling_h_estimated" numeric(5,3),
    "ceiling_h_verified" numeric(5,3),
    "floor_anchor" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."scan_rooms" OWNER TO "postgres";


COMMENT ON TABLE "public"."scan_rooms" IS 'Spatial Core: rooms within a scan. estimated_* = RoomPlan output, verified_* = handwerker truth.';



CREATE TABLE IF NOT EXISTS "public"."scan_status_transition_allowed" (
    "from_status" "public"."scan_status" NOT NULL,
    "to_status" "public"."scan_status" NOT NULL
);


ALTER TABLE "public"."scan_status_transition_allowed" OWNER TO "postgres";


COMMENT ON TABLE "public"."scan_status_transition_allowed" IS 'Spatial Core FSM: allowed (from -> to) edges for scans.status. Seed-driven, change via migration only. Mirror in src/lib/spatial/repository/fsm.ts.';



CREATE TABLE IF NOT EXISTS "public"."scan_status_transition_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "scan_id" "uuid" NOT NULL,
    "from_status" "public"."scan_status",
    "to_status" "public"."scan_status" NOT NULL,
    "actor_id" "uuid",
    "reason" "text",
    "occurred_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "scan_status_transition_log_actor_or_reason_chk" CHECK ((("actor_id" IS NOT NULL) OR ("reason" IS NOT NULL))),
    CONSTRAINT "scan_status_transition_log_progress_chk" CHECK (("from_status" IS DISTINCT FROM "to_status"))
);


ALTER TABLE "public"."scan_status_transition_log" OWNER TO "postgres";


COMMENT ON TABLE "public"."scan_status_transition_log" IS 'Spatial Core FSM: append-only transition history. Writes only via enforce_scan_fsm() (SECURITY DEFINER). Read via spatial_can_view_scan(scan_id).';



COMMENT ON CONSTRAINT "scan_status_transition_log_actor_or_reason_chk" ON "public"."scan_status_transition_log" IS 'No ghost transitions: cron/system writes pass NULL actor_id but MUST supply a reason.';



CREATE TABLE IF NOT EXISTS "public"."scan_surfaces" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "room_id" "uuid" NOT NULL,
    "surface_external_id" "text" NOT NULL,
    "kind" "public"."scan_surface_kind" NOT NULL,
    "dim_w_estimated" numeric(6,3),
    "dim_h_estimated" numeric(6,3),
    "dim_w_verified" numeric(6,3),
    "dim_h_verified" numeric(6,3),
    "transform" "jsonb",
    "status" "public"."scan_measurement_status" DEFAULT 'estimated_roomplan'::"public"."scan_measurement_status" NOT NULL,
    "confidence" numeric(3,2),
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "scan_surfaces_confidence_range_chk" CHECK ((("confidence" IS NULL) OR (("confidence" >= (0)::numeric) AND ("confidence" <= (1)::numeric))))
);


ALTER TABLE "public"."scan_surfaces" OWNER TO "postgres";


COMMENT ON TABLE "public"."scan_surfaces" IS 'Spatial Core: walls / doors / windows / openings / objects. No edited_geometry (D5 deferred V3+).';



COMMENT ON COLUMN "public"."scan_surfaces"."surface_external_id" IS 'D2 Layer 1: plugin-vergebene stabile ID for UV-anchor cross-format + re-scan migration.';



COMMENT ON COLUMN "public"."scan_surfaces"."confidence" IS '0.00 to 1.00 from mesh classification.';



CREATE TABLE IF NOT EXISTS "public"."scans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid",
    "project_id" "uuid",
    "parent_scan_id" "uuid",
    "status" "public"."scan_status" DEFAULT 'draft'::"public"."scan_status" NOT NULL,
    "source" "public"."scan_source" DEFAULT 'roomplan'::"public"."scan_source" NOT NULL,
    "captured_by" "uuid" NOT NULL,
    "device_meta" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "scan_started_at" timestamp with time zone,
    "scan_ended_at" timestamp with time zone,
    "archived_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "presales_project_id" "uuid",
    "owner_type" "text" DEFAULT 'craftsman'::"text" NOT NULL,
    "shared_with_customer" boolean DEFAULT false NOT NULL,
    "shared_at" timestamp with time zone,
    "shared_with_provider_id" "uuid",
    "shared_with_provider_at" timestamp with time zone,
    "quality_score" smallint,
    "quality_label" "text",
    CONSTRAINT "scans_owner_anchor_chk" CHECK ((("job_id" IS NOT NULL) OR ("project_id" IS NOT NULL) OR ("presales_project_id" IS NOT NULL) OR ("owner_type" = 'customer'::"text"))),
    CONSTRAINT "scans_owner_type_chk" CHECK (("owner_type" = ANY (ARRAY['craftsman'::"text", 'customer'::"text"]))),
    CONSTRAINT "scans_quality_label_chk" CHECK ((("quality_label" IS NULL) OR ("quality_label" = ANY (ARRAY['high'::"text", 'medium'::"text", 'low'::"text"])))),
    CONSTRAINT "scans_quality_score_chk" CHECK ((("quality_score" IS NULL) OR (("quality_score" >= 0) AND ("quality_score" <= 100)))),
    CONSTRAINT "scans_shared_with_provider_kind_chk" CHECK ((("shared_with_provider_id" IS NULL) OR ("owner_type" = 'customer'::"text"))),
    CONSTRAINT "scans_sharing_requires_job_chk" CHECK ((("shared_with_customer" = false) OR ("job_id" IS NOT NULL)))
);

ALTER TABLE ONLY "public"."scans" REPLICA IDENTITY FULL;


ALTER TABLE "public"."scans" OWNER TO "postgres";


COMMENT ON TABLE "public"."scans" IS 'Spatial Core: per-capture-session header. Versioned via parent_scan_id. CHECK requires job_id OR project_id.';



COMMENT ON COLUMN "public"."scans"."parent_scan_id" IS 'Self-FK for re-scan versioning. Pin migration uses D2 anchor matching.';



COMMENT ON COLUMN "public"."scans"."device_meta" IS 'Device + sensor info for forensics + quality scoring.';



COMMENT ON COLUMN "public"."scans"."presales_project_id" IS 'Optional anchor to a provider-presales-project (V1.5+). Mutually-exclusive conceptually with job_id+project_id but DB allows multiple for re-link scenarios; the owner_anchor_chk requires at least one of the three.';



COMMENT ON COLUMN "public"."scans"."owner_type" IS 'Lane 3 V1.6: craftsman = HW-owned capture (default), customer = Customer Self-Scan (Block 4). Discriminates sharing semantics.';



COMMENT ON COLUMN "public"."scans"."shared_with_customer" IS 'Lane 3 V1.6: HW-toggled sharing gate (Block 2 UI). true = job customer can view this scan. Only meaningful when job_id IS NOT NULL (enforced by CHECK).';



COMMENT ON COLUMN "public"."scans"."shared_at" IS 'Lane 3 V1.6: timestamp of last share action (set by sharing trigger, cleared on unshare).';



COMMENT ON COLUMN "public"."scans"."shared_with_provider_id" IS 'V1.5.1 Phase B: Customer-to-HW direct share target. NULL = not direct-shared. Only legal when owner_type=customer (enforced via scans_shared_with_provider_kind_chk). Orthogonal to scans.shared_with_customer (HW→Customer direction).';



COMMENT ON COLUMN "public"."scans"."shared_with_provider_at" IS 'V1.5.1 Phase B: timestamp the current shared_with_provider_id was set; cleared on unshare.';



COMMENT ON COLUMN "public"."scans"."quality_score" IS 'V1.6 Phase 2: computed scan quality on a 0-100 integer scale. NULL = not computed (Manual-Preset captures, legacy rows). Written at INSERT time for LiDAR captures; never recomputed in-place (new scan = new row per B4-D7). Thresholds: >=80 high / 50-79 medium / <50 low - canonical in scanQualityScore.ts.';



COMMENT ON COLUMN "public"."scans"."quality_label" IS 'V1.6 Phase 2: denormalised quality label derived from quality_score. NULL when quality_score IS NULL. Values: high (>=80) / medium (50-79) / low (<50). Kept in sync by application layer at INSERT time - never updated independently.';



CREATE TABLE IF NOT EXISTS "public"."schedules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "scheduled_start" bigint DEFAULT 0 NOT NULL,
    "scheduled_end" bigint DEFAULT 0 NOT NULL,
    "execution_window" bigint DEFAULT 0 NOT NULL,
    "scheduling_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" bigint DEFAULT 0 NOT NULL,
    "updated_at" bigint DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."schedules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."spatial_assets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "slug" "text" NOT NULL,
    "display_name" "text" NOT NULL,
    "category" "text" NOT NULL,
    "gltf_storage_path" "text",
    "thumbnail_storage_path" "text",
    "license" "text" NOT NULL,
    "attribution" "text",
    "vendor" "text",
    "published" boolean DEFAULT false NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "geometry_kind" "text" DEFAULT 'glb'::"text" NOT NULL,
    "object_category" "text",
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "is_counter_host" boolean DEFAULT false NOT NULL,
    CONSTRAINT "spatial_assets_geometry_kind_chk" CHECK (("geometry_kind" = ANY (ARRAY['glb'::"text", 'procedural'::"text"]))),
    CONSTRAINT "spatial_assets_glb_path_chk" CHECK (((("geometry_kind" = 'glb'::"text") AND ("gltf_storage_path" IS NOT NULL)) OR (("geometry_kind" = 'procedural'::"text") AND ("gltf_storage_path" IS NULL))))
);


ALTER TABLE "public"."spatial_assets" OWNER TO "postgres";


COMMENT ON TABLE "public"."spatial_assets" IS 'Spatial Canonical V1: CC0/managed 3D asset registry. Each row = one published glTF asset. BD-1: license + attribution MANDATORY. gltf_storage_path = KTX2-compressed .glb; POC uses public/spatial-assets/, Phase 1 moves to Supabase Storage (OD-5).';



COMMENT ON COLUMN "public"."spatial_assets"."slug" IS 'Stable programmatic identifier used in parametric JSON asset_ref fields. Must not change after a scene references this asset.';



COMMENT ON COLUMN "public"."spatial_assets"."license" IS 'SPDX license identifier. CC0-1.0 for Polyhaven/ambientCG; CC-BY-4.0 for attributed Sketchfab CC0 assets.';



COMMENT ON COLUMN "public"."spatial_assets"."attribution" IS 'Required attribution string for CC-BY licensed assets. Null for CC0-1.0. Tracked for LICENSES.md (Day 13 P3).';



COMMENT ON COLUMN "public"."spatial_assets"."geometry_kind" IS 'glb = downloaded CC0 model in Storage; procedural = L1 box-placeholder (Phase-1, no GLB file). Phase 2 swaps procedural to glb behind the same slug.';



COMMENT ON COLUMN "public"."spatial_assets"."object_category" IS 'Fine scene-graph ObjectCategory (toilet, oven, ...). NULL for architectural openings (doors/windows) which are WallOpening nodes, not SpatialObjects.';



COMMENT ON COLUMN "public"."spatial_assets"."is_counter_host" IS 'True when the asset is a counter / vanity that can host objects on its top surface.';



CREATE TABLE IF NOT EXISTS "public"."spatial_change_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "scene_id" "uuid" NOT NULL,
    "node_id" "text",
    "proposer_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'proposed'::"text" NOT NULL,
    "title" "text" NOT NULL,
    "body" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "spatial_change_orders_status_chk" CHECK (("status" = ANY (ARRAY['proposed'::"text", 'accepted'::"text", 'rejected'::"text", 'withdrawn'::"text"])))
);


ALTER TABLE "public"."spatial_change_orders" OWNER TO "postgres";


COMMENT ON TABLE "public"."spatial_change_orders" IS 'Spatial Canonical V1 schema / Phase 5 BoM: provider-proposed scope changes anchored to canonical scene nodes. Status FSM: proposed to accepted | rejected | withdrawn. Write policies (RLS) and workflow integration activated in Day 41-47 Phase 5.';



COMMENT ON COLUMN "public"."spatial_change_orders"."node_id" IS 'Canonical scene-graph node identifier (string from parametric blob). NULL for scene-level change orders not tied to a specific surface or object.';



COMMENT ON COLUMN "public"."spatial_change_orders"."status" IS 'FSM states: proposed (initial) to accepted | rejected | withdrawn. Day 8 spatialSceneFsm.ts will enforce valid transitions (XM-7 pattern).';



CREATE TABLE IF NOT EXISTS "public"."spatial_edit_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "scene_id" "uuid" NOT NULL,
    "actor_id" "uuid",
    "variant_id" "text" NOT NULL,
    "base_node_id" "text" NOT NULL,
    "override_fields" "jsonb" NOT NULL,
    "command" "text" NOT NULL,
    "parametric_sha256_before" "text",
    "parametric_sha256_after" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "semantic_op" "text",
    "provider_org_id" "uuid",
    CONSTRAINT "spatial_edit_history_command_chk" CHECK (("command" = ANY (ARRAY['set'::"text", 'delete'::"text", 'restore'::"text"]))),
    CONSTRAINT "spatial_edit_history_semantic_op_chk" CHECK ((("semantic_op" IS NULL) OR ("semantic_op" = ANY (ARRAY['move_node'::"text", 'resize_wall'::"text", 'add_door'::"text", 'add_pin'::"text", 'delete_node'::"text", 'snap_object'::"text", 'set_material'::"text", 'move_pin'::"text", 'set_room_height'::"text", 'add_wall'::"text", 'delete_wall'::"text"]))))
);


ALTER TABLE "public"."spatial_edit_history" OWNER TO "postgres";


COMMENT ON TABLE "public"."spatial_edit_history" IS 'Spatial Canonical V1: append-only audit log of parametric-scene override mutations. Writes REVOKEd from anon/authenticated (SECURITY DEFINER RPC path only, Day 7). before/after SHA-256 hashes allow external diff reconstruction.';



COMMENT ON COLUMN "public"."spatial_edit_history"."command" IS 'Override command: set (create/update) | delete (soft-delete in parametric blob) | restore.';



COMMENT ON COLUMN "public"."spatial_edit_history"."parametric_sha256_before" IS 'SHA-256 of the parametric blob immediately before this command was applied. NULL for the first write on a new scene.';



COMMENT ON COLUMN "public"."spatial_edit_history"."semantic_op" IS 'Fine-grained EditOperation discriminator (move_node | resize_wall | add_door | add_pin | delete_node | snap_object | set_material | move_pin | set_room_height). NULL for legacy / system-generated rows. The coarse override primitive stays in the command column (set | delete | restore).';



COMMENT ON COLUMN "public"."spatial_edit_history"."provider_org_id" IS 'Provider Spatial Hub (spec 2.4): the provider business this audit row belongs to. Stamped by spatial_edit_history_append() from the scene. Powers the org-scoped Activity-Feed.';



CREATE TABLE IF NOT EXISTS "public"."spatial_materials" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "slug" "text" NOT NULL,
    "display_name" "text" NOT NULL,
    "category" "text" NOT NULL,
    "albedo_path" "text",
    "normal_path" "text",
    "roughness_path" "text",
    "metallic_path" "text",
    "ao_path" "text",
    "tileable_meters" numeric(6,3),
    "license" "text" NOT NULL,
    "attribution" "text",
    "vendor" "text",
    "published" boolean DEFAULT false NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "surface_category" "text",
    "section" "text",
    "displacement_path" "text",
    "tile_scale_u_m" numeric(7,3),
    "tile_scale_v_m" numeric(7,3),
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "is_procedural" boolean DEFAULT false NOT NULL,
    CONSTRAINT "spatial_materials_category_chk" CHECK (("category" = ANY (ARRAY['tile'::"text", 'paint'::"text", 'wood'::"text", 'stone'::"text", 'metal'::"text", 'concrete'::"text", 'fabric'::"text", 'plaster'::"text", 'brick'::"text", 'ceramic'::"text", 'other'::"text"]))),
    CONSTRAINT "spatial_materials_surface_category_chk" CHECK ((("surface_category" IS NULL) OR ("surface_category" = ANY (ARRAY['wall'::"text", 'floor'::"text", 'counter'::"text", 'metal'::"text", 'decor'::"text"])))),
    CONSTRAINT "spatial_materials_texture_presence_chk" CHECK ((("is_procedural" = true) OR ("albedo_path" IS NOT NULL)))
);


ALTER TABLE "public"."spatial_materials" OWNER TO "postgres";


COMMENT ON TABLE "public"."spatial_materials" IS 'Spatial Canonical V1: PBR material registry. Each row = one tileable PBR material set (albedo/normal/roughness/metallic/AO). BD-1: license + attribution MANDATORY. ambientCG PBR textures = CC0-1.0. category CHECK: tile|paint|wood|stone|metal|concrete|fabric|plaster|other.';



COMMENT ON COLUMN "public"."spatial_materials"."albedo_path" IS 'Supabase Storage path to KTX2-compressed albedo texture. POC uses public/spatial-assets/poc-materials/ (Day 14).';



COMMENT ON COLUMN "public"."spatial_materials"."tileable_meters" IS 'Metres per UV tile repeat. Used by renderer to compute UV scale from surface dimensions. NULL for non-tileable materials (decals, logos).';



COMMENT ON COLUMN "public"."spatial_materials"."surface_category" IS 'Picker Category-Pill: wall|floor|counter|metal|decor. Which surface the material applies to - orthogonal to category (the physical material type).';



COMMENT ON COLUMN "public"."spatial_materials"."section" IS 'Human-readable Typ-Sektion label for the grouped picker grid (Mockup 42 3b).';



COMMENT ON COLUMN "public"."spatial_materials"."tile_scale_u_m" IS 'UV tile size along U in meters. Supersedes tileable_meters (square-only); tileable_meters is kept for back-compat but unused by V1 seeds.';



COMMENT ON COLUMN "public"."spatial_materials"."is_procedural" IS 'True for non-textured procedural materials (decor-mirror = MeshPhysicalMaterial).';



CREATE TABLE IF NOT EXISTS "public"."spatial_node_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "scene_id" "uuid" NOT NULL,
    "node_id" "text" NOT NULL,
    "link_type" "text" NOT NULL,
    "target_table" "text" NOT NULL,
    "target_id" "text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    CONSTRAINT "spatial_node_links_link_type_chk" CHECK (("link_type" = ANY (ARRAY['photo'::"text", 'note'::"text", 'task'::"text", 'material_request'::"text", 'dispute_evidence'::"text", 'change_order'::"text"])))
);


ALTER TABLE "public"."spatial_node_links" OWNER TO "postgres";


COMMENT ON TABLE "public"."spatial_node_links" IS 'Spatial Canonical V1: generic bridge from canonical scene-graph nodes (inside parametric JSON blob) to FixUp domain records in other tables. node_id is a canonical scene-graph string - NOT a Postgres FK. target_table + target_id are text pairs for cross-domain genericity. Phase 5 BoM / dispute-evidence use-cases activated in Day 41-47.';



COMMENT ON COLUMN "public"."spatial_node_links"."node_id" IS 'Canonical scene-graph node identifier (e.g. wall_id, object_id, pin_id). Stable string defined in the parametric JSON blob; not stored in a Postgres table.';



COMMENT ON COLUMN "public"."spatial_node_links"."target_table" IS 'Name of the Postgres table containing the linked domain record. Application layer enforces referential integrity (no DB-level FK by design).';



COMMENT ON COLUMN "public"."spatial_node_links"."target_id" IS 'Primary key of the target row cast to text. For uuid PKs: uuid::text. For text PKs (e.g. disputes.id): stored as-is.';



CREATE TABLE IF NOT EXISTS "public"."spatial_node_overrides" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "scene_id" "uuid" NOT NULL,
    "variant_id" "text" NOT NULL,
    "base_node_id" "text" NOT NULL,
    "override_fields" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "created_by_role" "text"
);


ALTER TABLE "public"."spatial_node_overrides" OWNER TO "postgres";


COMMENT ON TABLE "public"."spatial_node_overrides" IS 'Spatial Canonical V1.x preparation: per-node override rows for future DB-backed override storage. V1 writes are blocked by RLS (table is schema-present but inactive). V1 reads overrides from the parametric JSON blob in Storage (Decision #6). Activate in V1.x by adding INSERT/UPDATE policies in a follow-up RLS migration.';



COMMENT ON COLUMN "public"."spatial_node_overrides"."variant_id" IS 'Must match a variant_id in the scene-graph variant chain. V1 engine: overrides/variant-resolve.ts reads from parametric blob, not this table.';



COMMENT ON COLUMN "public"."spatial_node_overrides"."created_by_user_id" IS 'Provider Spatial Hub (spec 2.4): the team member who authored this override row. ON DELETE SET NULL — overrides survive user removal with attribution dropped. V1.x-active.';



COMMENT ON COLUMN "public"."spatial_node_overrides"."created_by_role" IS 'Provider Spatial Hub (spec 2.4): the author role at write time (owner | worker | office | read_only — free text, mirrors team_members.role). Snapshot for audit.';



CREATE TABLE IF NOT EXISTS "public"."spatial_pin_reviews" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "scene_id" "uuid" NOT NULL,
    "provider_org_id" "uuid" NOT NULL,
    "annotation_node_id" "text" NOT NULL,
    "reviewed_by_user_id" "uuid" NOT NULL,
    "reviewed_by_role" "text" NOT NULL,
    "review_status" "text" DEFAULT 'trusted'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "spatial_pin_reviews_role_chk" CHECK (("reviewed_by_role" = ANY (ARRAY['owner'::"text", 'worker'::"text"]))),
    CONSTRAINT "spatial_pin_reviews_status_chk" CHECK (("review_status" = ANY (ARRAY['trusted'::"text", 'flagged'::"text"])))
);


ALTER TABLE "public"."spatial_pin_reviews" OWNER TO "postgres";


COMMENT ON TABLE "public"."spatial_pin_reviews" IS 'Spatial Phase C (C-1): tracks which annotation pins a provider-org member has reviewed (trusted|flagged). Existence of a row = pin was reviewed. One row per (scene, pin, org) via UNIQUE constraint.';



COMMENT ON COLUMN "public"."spatial_pin_reviews"."provider_org_id" IS 'FK -> public.providers(id). The provider BUSINESS, not an individual user.';



COMMENT ON COLUMN "public"."spatial_pin_reviews"."annotation_node_id" IS 'Text slug / node-ID of the annotation pin inside the RoomScene parametric blob. No FK — pin nodes are not a relational table.';



COMMENT ON COLUMN "public"."spatial_pin_reviews"."reviewed_by_role" IS 'Role snapshot at review time (owner|worker). Immutable after insert.';



COMMENT ON COLUMN "public"."spatial_pin_reviews"."review_status" IS 'trusted = pin content accepted; flagged = pin content disputed internally. Directly togglable via UPDATE policy.';



CREATE TABLE IF NOT EXISTS "public"."spatial_rescan_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "scene_id" "uuid" NOT NULL,
    "provider_org_id" "uuid" NOT NULL,
    "requested_by_user_id" "uuid" NOT NULL,
    "requested_by_role" "text" NOT NULL,
    "reason" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "response_note" "text",
    "responded_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resulting_scene_id" "uuid",
    CONSTRAINT "spatial_rescan_requests_role_chk" CHECK (("requested_by_role" = ANY (ARRAY['owner'::"text", 'worker'::"text"]))),
    CONSTRAINT "spatial_rescan_requests_status_chk" CHECK (("status" = ANY (ARRAY['pending'::"text", 'accepted'::"text", 'rejected'::"text"])))
);

ALTER TABLE ONLY "public"."spatial_rescan_requests" REPLICA IDENTITY FULL;


ALTER TABLE "public"."spatial_rescan_requests" OWNER TO "postgres";


COMMENT ON TABLE "public"."spatial_rescan_requests" IS 'Spatial Phase C (C-1): persists provider re-scan requests sent to the customer. Status transitions (pending->accepted|rejected) are owned exclusively by spatial_rescan_request_respond() SECURITY DEFINER RPC.';



COMMENT ON COLUMN "public"."spatial_rescan_requests"."provider_org_id" IS 'FK -> public.providers(id). The provider BUSINESS, not an individual user.';



COMMENT ON COLUMN "public"."spatial_rescan_requests"."requested_by_role" IS 'Role snapshot at request-creation time (owner|worker). Immutable after insert.';



COMMENT ON COLUMN "public"."spatial_rescan_requests"."status" IS 'Lifecycle: pending -> accepted | rejected. Only spatial_rescan_request_respond() may write this column.';



COMMENT ON COLUMN "public"."spatial_rescan_requests"."resulting_scene_id" IS 'Spatial D2 (B7): the scene produced when the customer accepted this re-scan request and re-captured. NULL until the new scene exists. Written atomically by spatial_create_scene in the same TX that inserts the scene (SECURITY DEFINER bypasses the table''s default-deny UPDATE policy).';



CREATE TABLE IF NOT EXISTS "public"."spatial_share_audit" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "scan_id" "uuid" NOT NULL,
    "actor_user_id" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "job_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "spatial_share_audit_action_chk" CHECK (("action" = ANY (ARRAY['shared'::"text", 'unshared'::"text"])))
);


ALTER TABLE "public"."spatial_share_audit" OWNER TO "postgres";


COMMENT ON TABLE "public"."spatial_share_audit" IS 'Lane 3 V1.6: append-only log of HW share/unshare actions per scan. Writes only via SECURITY DEFINER trigger spatial_log_share_action. Two-layer protection: RLS default-deny + REVOKE writes from anon/authenticated.';



CREATE TABLE IF NOT EXISTS "public"."stripe_webhook_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "stripe_event_id" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "livemode" boolean,
    "object_id" "text",
    "payment_intent_id" "text",
    "checkout_session_id" "text",
    "refund_id" "text",
    "event_created_at" timestamp with time zone,
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "processed_at" timestamp with time zone,
    "processing_status" "text" DEFAULT 'received'::"text" NOT NULL,
    "processing_error" "text",
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "failure_reason" "text",
    "event_id" "text",
    "outcome" "text",
    "payment_id" "text",
    "job_id" "text",
    "previous_state" "text",
    "new_state" "text"
);


ALTER TABLE "public"."stripe_webhook_events" OWNER TO "postgres";


COMMENT ON COLUMN "public"."stripe_webhook_events"."failure_reason" IS 'Machine-readable failure reason when outcome is failed/invalid_transition. NULL for successful events. Used for operator recovery diagnostics.';



CREATE TABLE IF NOT EXISTS "public"."subscription_withdrawal_consents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "package_id" "text" NOT NULL,
    "consent_text_version" "text" DEFAULT 'v1'::"text" NOT NULL,
    "consented_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."subscription_withdrawal_consents" OWNER TO "postgres";


COMMENT ON TABLE "public"."subscription_withdrawal_consents" IS 'Append-only Audit-Trail der § 356 Abs. 4 Einwilligung (sofortiger Leistungsbeginn, Erlöschen des Widerrufsrechts) beim SaFix-Pro-Kauf. Nutzer schreibt/liest nur eigene Zeilen. Kein UPDATE/DELETE für App-Rollen.';



CREATE TABLE IF NOT EXISTS "public"."supplementary_payment_requests" (
    "id" "uuid" NOT NULL,
    "change_order_id" "uuid" NOT NULL,
    "job_id" "uuid" NOT NULL,
    "original_payment_id" "uuid" NOT NULL,
    "customer_user_id" "text" NOT NULL,
    "craftsman_user_id" "text" NOT NULL,
    "amount_cents" integer NOT NULL,
    "currency" "text" DEFAULT 'EUR'::"text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "acknowledged_at" bigint,
    "paid_at" bigint,
    "waived_at" bigint,
    "external_ref" "text",
    "funding_initiated_at" bigint,
    "funded_at" bigint,
    "released_at" bigint,
    "external_payout_ref" "text",
    "created_at" bigint NOT NULL,
    "updated_at" bigint NOT NULL,
    CONSTRAINT "supplementary_payment_requests_amount_cents_check" CHECK (("amount_cents" > 0)),
    CONSTRAINT "supplementary_payment_requests_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'acknowledged'::"text", 'funding_initiated'::"text", 'funded'::"text", 'released'::"text", 'paid'::"text", 'waived'::"text"])))
);


ALTER TABLE "public"."supplementary_payment_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."team_member_audit" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider_id" "uuid" NOT NULL,
    "member_id" "uuid" NOT NULL,
    "actor_id" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "old_values" "jsonb",
    "new_values" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "team_member_audit_action_check" CHECK (("action" = ANY (ARRAY['update'::"text", 'deactivate'::"text", 'reactivate'::"text"])))
);


ALTER TABLE "public"."team_member_audit" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."team_member_details" WITH ("security_invoker"='true') AS
 SELECT "tm"."id",
    "tm"."provider_id",
    "tm"."profile_id",
    "tm"."full_name",
    "tm"."role",
    "tm"."phone",
    "tm"."email",
    "tm"."is_active",
    "tm"."created_at",
    "tm"."updated_at",
    "p"."company_name" AS "provider_company_name",
    "pr"."display_name" AS "linked_profile_display_name",
    "pr"."phone" AS "linked_profile_phone"
   FROM (("public"."team_members" "tm"
     LEFT JOIN "public"."providers" "p" ON (("tm"."provider_id" = "p"."id")))
     LEFT JOIN "public"."profiles" "pr" ON (("tm"."profile_id" = "pr"."id")));


ALTER VIEW "public"."team_member_details" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."thread_artifacts" (
    "id" "text" NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "artifact_type" "text" NOT NULL,
    "project_id" "text",
    "offer_id" "text",
    "job_id" "text",
    "phase" "text",
    "customer_user_id" "uuid",
    "craftsman_user_id" "uuid",
    "created_at" bigint DEFAULT 0 NOT NULL,
    "updated_at" bigint DEFAULT 0 NOT NULL,
    "snapshot_title" "text",
    "snapshot_status" "text",
    "snapshot_price" "text",
    "snapshot_summary" "text",
    "snapshot_phase_label" "text",
    "snapshot_category" "text",
    "snapshot_location" "text",
    "snapshot_budget" "text",
    "snapshot_timing" "text",
    "funding_request_id" "uuid",
    "escrow_plan_id" "uuid",
    "snapshot_document_type" "text",
    "snapshot_version" integer,
    "snapshot_valid_until" "text",
    "change_order_id" "uuid",
    "version" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "thread_artifacts_artifact_type_check" CHECK (("artifact_type" = ANY (ARRAY['project'::"text", 'offer'::"text", 'payment_phase'::"text", 'funding_step'::"text", 'change_order'::"text"])))
);


ALTER TABLE "public"."thread_artifacts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."time_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider_id" "uuid" NOT NULL,
    "member_id" "uuid" NOT NULL,
    "kind" "public"."time_entry_kind" NOT NULL,
    "job_id" "uuid",
    "started_at" timestamp with time zone NOT NULL,
    "ended_at" timestamp with time zone,
    "duration_minutes" integer,
    "note" "text",
    "status" "public"."time_entry_status" DEFAULT 'active'::"public"."time_entry_status" NOT NULL,
    "rejected_reason" "text",
    "rejected_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "rejected_at" timestamp with time zone,
    CONSTRAINT "closed_has_end" CHECK ((("status" <> 'closed'::"public"."time_entry_status") OR (("ended_at" IS NOT NULL) AND ("duration_minutes" IS NOT NULL)))),
    CONSTRAINT "day_kind_no_job_id" CHECK ((("kind" = 'job'::"public"."time_entry_kind") OR ("job_id" IS NULL))),
    CONSTRAINT "duration_positive" CHECK ((("duration_minutes" IS NULL) OR ("duration_minutes" > 0))),
    CONSTRAINT "end_after_start" CHECK ((("ended_at" IS NULL) OR ("ended_at" > "started_at"))),
    CONSTRAINT "job_kind_requires_job_id" CHECK ((("kind" = 'day'::"public"."time_entry_kind") OR ("job_id" IS NOT NULL))),
    CONSTRAINT "rejected_has_reason" CHECK ((("status" <> 'rejected'::"public"."time_entry_status") OR ("rejected_reason" IS NOT NULL))),
    CONSTRAINT "time_entries_duration_max_24h" CHECK ((("duration_minutes" IS NULL) OR ("duration_minutes" <= (24 * 60))))
);

ALTER TABLE ONLY "public"."time_entries" REPLICA IDENTITY FULL;


ALTER TABLE "public"."time_entries" OWNER TO "postgres";


COMMENT ON TABLE "public"."time_entries" IS 'Worker time tracking: day-timer + per-job-timer rows. duration_minutes is the authoritative field for weekly aggregates.';



COMMENT ON COLUMN "public"."time_entries"."kind" IS 'day = full work day timer (no job_id). job = per-job timer (job_id required, must be assigned to member).';



COMMENT ON COLUMN "public"."time_entries"."duration_minutes" IS 'Authoritative duration. Set by close-workflow on status flip from active → closed. NULL while active.';



COMMENT ON COLUMN "public"."time_entries"."rejected_reason" IS 'Free-text reason from owner when status = rejected. Required by check constraint.';



COMMENT ON COLUMN "public"."time_entries"."rejected_at" IS 'Block 2.1 hardening (C3): timestamp of the active/closed→rejected transition. Stamped by trigger; never settable by client.';



COMMENT ON CONSTRAINT "time_entries_duration_max_24h" ON "public"."time_entries" IS 'Block 2.1 hardening: rejects timer spans longer than 24h. Catches clock skew + malicious inflation.';



CREATE TABLE IF NOT EXISTS "public"."timeline_signals" (
    "id" "text" DEFAULT ("gen_random_uuid"())::"text" NOT NULL,
    "job_id" "uuid" NOT NULL,
    "type" "text" DEFAULT ''::"text" NOT NULL,
    "occurred_at" bigint DEFAULT 0 NOT NULL,
    "entity_id" "text"
);


ALTER TABLE "public"."timeline_signals" OWNER TO "postgres";


COMMENT ON COLUMN "public"."timeline_signals"."entity_id" IS 'Optional poly-domain entity reference (e.g. offers.id for offer_sent). Propagated to notification_signals.entity_id by the FE bridge, then to push payload data.entityId by notification_signals_dispatch_push, then to deep-link route templates by the FE/edge pushRouteMap.';



CREATE TABLE IF NOT EXISTS "public"."user_blocks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "blocker_id" "uuid" NOT NULL,
    "blocked_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "blocks_no_self_block" CHECK (("blocker_id" <> "blocked_id"))
);


ALTER TABLE "public"."user_blocks" OWNER TO "postgres";


COMMENT ON TABLE "public"."user_blocks" IS 'Bidirectional block relationships between users.';



CREATE TABLE IF NOT EXISTS "public"."user_notification_preferences" (
    "user_id" "uuid" NOT NULL,
    "quiet_hours_start" smallint,
    "quiet_hours_end" smallint,
    "is_always_reachable" boolean DEFAULT false NOT NULL,
    "count_customer_chat_unread" boolean DEFAULT true NOT NULL,
    "count_office_chat_unread" boolean DEFAULT false NOT NULL,
    "count_team_chat_unread" boolean DEFAULT false NOT NULL,
    "count_assignment_chat_unread" boolean DEFAULT false NOT NULL,
    "count_dispute_chat_unread" boolean DEFAULT true NOT NULL,
    "created_at" bigint DEFAULT "public"."epoch_ms"() NOT NULL,
    "updated_at" bigint DEFAULT "public"."epoch_ms"() NOT NULL,
    CONSTRAINT "user_notification_preferences_quiet_hours_end_check" CHECK ((("quiet_hours_end" >= 0) AND ("quiet_hours_end" <= 23))),
    CONSTRAINT "user_notification_preferences_quiet_hours_start_check" CHECK ((("quiet_hours_start" >= 0) AND ("quiet_hours_start" <= 23)))
);


ALTER TABLE "public"."user_notification_preferences" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "reporter_id" "uuid" NOT NULL,
    "reported_id" "uuid" NOT NULL,
    "reason" "text" NOT NULL,
    "details" "text",
    "context_type" "text",
    "context_id" "uuid",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "operator_notes" "text",
    CONSTRAINT "reports_no_self_report" CHECK (("reporter_id" <> "reported_id")),
    CONSTRAINT "user_reports_status_chk" CHECK (("status" = ANY (ARRAY['pending'::"text", 'reviewed'::"text", 'resolved'::"text", 'dismissed'::"text", 'actioned'::"text"])))
);


ALTER TABLE "public"."user_reports" OWNER TO "postgres";


COMMENT ON TABLE "public"."user_reports" IS 'User-submitted reports against other users for safety review.';



CREATE OR REPLACE VIEW "public"."visible_discovery_providers" AS
 SELECT "provider_id",
    "profile_id",
    "company_name",
    "description",
    "city",
    "trade_categories",
    "avatar_url",
    "rating",
    "rating_count",
    "verified",
    "is_public",
    "provider_created_at",
    "provider_updated_at",
    "display_name",
    "craftsman_role",
    "onboarding_done",
    "is_operator",
    "handle"
   FROM "public"."discovery_providers"
  WHERE (("is_public" = true) AND ("onboarding_done" = true));


ALTER VIEW "public"."visible_discovery_providers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."widerruf_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "subject" "text" DEFAULT 'SaFix Pro Abonnement'::"text" NOT NULL,
    "contact_email" "text" NOT NULL,
    "status" "text" DEFAULT 'received'::"text" NOT NULL,
    "declared_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "widerruf_requests_status_chk" CHECK (("status" = ANY (ARRAY['received'::"text", 'processed'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."widerruf_requests" OWNER TO "postgres";


COMMENT ON TABLE "public"."widerruf_requests" IS 'Append-only Eingang von Widerrufserklärungen (§ 356a BGB) zum SaFix-Pro-Abo. Insert via api/submit-widerruf.ts (service-role); Nutzer dürfen eigene Zeilen lesen. Kein UPDATE/DELETE für App-Rollen.';



ALTER TABLE ONLY "public"."email_delivery_log" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."email_delivery_log_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."absences"
    ADD CONSTRAINT "absences_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."acceptances"
    ADD CONSTRAINT "acceptances_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."account_deletion_log"
    ADD CONSTRAINT "account_deletion_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."analytics_events"
    ADD CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("event_id");



ALTER TABLE ONLY "public"."attribution_audit_log"
    ADD CONSTRAINT "attribution_audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_blocks"
    ADD CONSTRAINT "blocks_unique_pair" UNIQUE ("blocker_id", "blocked_id");



ALTER TABLE ONLY "public"."calendar_entries"
    ADD CONSTRAINT "calendar_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."change_orders"
    ADD CONSTRAINT "change_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."chat_attachments"
    ADD CONSTRAINT "chat_attachments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."chat_messages"
    ADD CONSTRAINT "chat_messages_client_dedup_uq" UNIQUE ("sender_user_id", "client_message_id");



ALTER TABLE ONLY "public"."chat_messages"
    ADD CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."chat_participants"
    ADD CONSTRAINT "chat_participants_pkey" PRIMARY KEY ("thread_id", "user_id");



ALTER TABLE ONLY "public"."chat_thread_migration_status"
    ADD CONSTRAINT "chat_thread_migration_status_pkey" PRIMARY KEY ("thread_id");



ALTER TABLE ONLY "public"."chat_threads"
    ADD CONSTRAINT "chat_threads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."company_code_audit"
    ADD CONSTRAINT "company_code_audit_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."company_join_codes"
    ADD CONSTRAINT "company_join_codes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."correction_requests"
    ADD CONSTRAINT "correction_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."craftsman_profiles"
    ADD CONSTRAINT "craftsman_profiles_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."craftsman_subscriptions"
    ADD CONSTRAINT "craftsman_subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."craftsman_subscriptions"
    ADD CONSTRAINT "craftsman_subscriptions_profile_id_key" UNIQUE ("profile_id");



ALTER TABLE ONLY "public"."customer_billing_profiles"
    ADD CONSTRAINT "customer_billing_profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."customer_billing_profiles"
    ADD CONSTRAINT "customer_billing_profiles_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."customer_provider_relationships"
    ADD CONSTRAINT "customer_provider_relationships_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."customer_provider_relationships"
    ADD CONSTRAINT "customer_provider_relationships_unique" UNIQUE ("customer_user_id", "craftsman_user_id");



ALTER TABLE ONLY "public"."customer_request_sends"
    ADD CONSTRAINT "customer_request_sends_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dispute_evidence"
    ADD CONSTRAINT "dispute_evidence_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dispute_spatial_evidence"
    ADD CONSTRAINT "dispute_spatial_evidence_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dispute_split_proposals"
    ADD CONSTRAINT "dispute_split_proposals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dispute_status_history"
    ADD CONSTRAINT "dispute_status_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."disputes"
    ADD CONSTRAINT "disputes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."download_jobs"
    ADD CONSTRAINT "download_jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_delivery_log"
    ADD CONSTRAINT "email_delivery_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."escrow_payment_plans"
    ADD CONSTRAINT "escrow_payment_plans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."escrow_payment_plans"
    ADD CONSTRAINT "escrow_plans_source_offer_unique" UNIQUE ("source_offer_id");



ALTER TABLE ONLY "public"."escrow_tranches"
    ADD CONSTRAINT "escrow_tranches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."escrow_tranches"
    ADD CONSTRAINT "escrow_tranches_plan_kind_unique" UNIQUE ("plan_id", "kind");



ALTER TABLE ONLY "public"."failed_join_attempts"
    ADD CONSTRAINT "failed_join_attempts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."funding_requests"
    ADD CONSTRAINT "funding_requests_escrow_plan_unique" UNIQUE ("escrow_plan_id");



ALTER TABLE ONLY "public"."funding_requests"
    ADD CONSTRAINT "funding_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."internal_messages"
    ADD CONSTRAINT "internal_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_assignments"
    ADD CONSTRAINT "job_assignments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_feedback"
    ADD CONSTRAINT "job_feedback_job_id_key" UNIQUE ("job_id");



ALTER TABLE ONLY "public"."job_feedback"
    ADD CONSTRAINT "job_feedback_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_photos"
    ADD CONSTRAINT "job_photos_job_id_client_uuid_key" UNIQUE ("job_id", "client_uuid");



ALTER TABLE ONLY "public"."job_photos"
    ADD CONSTRAINT "job_photos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_reports"
    ADD CONSTRAINT "job_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ledger_entries"
    ADD CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."media_artifacts"
    ADD CONSTRAINT "media_artifacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."media_uploads"
    ADD CONSTRAINT "media_uploads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."message_thread_participants"
    ADD CONSTRAINT "message_thread_participants_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."message_thread_participants"
    ADD CONSTRAINT "message_thread_participants_thread_id_team_member_id_key" UNIQUE ("thread_id", "team_member_id");



ALTER TABLE ONLY "public"."message_threads"
    ADD CONSTRAINT "message_threads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."moderation_action_log"
    ADD CONSTRAINT "moderation_action_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notification_device_tokens"
    ADD CONSTRAINT "notification_device_tokens_pkey" PRIMARY KEY ("user_id", "token");



ALTER TABLE ONLY "public"."notification_signals"
    ADD CONSTRAINT "notification_signals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."offers"
    ADD CONSTRAINT "offers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."operator_action_audit"
    ADD CONSTRAINT "operator_action_audit_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."owner_notes"
    ADD CONSTRAINT "owner_notes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."parametric_cleanup_log"
    ADD CONSTRAINT "parametric_cleanup_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payment_status_history"
    ADD CONSTRAINT "payment_status_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."provider_highlight_items"
    ADD CONSTRAINT "provider_highlight_items_highlight_id_portfolio_item_id_key" UNIQUE ("highlight_id", "portfolio_item_id");



ALTER TABLE ONLY "public"."provider_highlight_items"
    ADD CONSTRAINT "provider_highlight_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."provider_highlights"
    ADD CONSTRAINT "provider_highlights_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."provider_media_assets"
    ADD CONSTRAINT "provider_media_assets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."provider_media_comment_likes"
    ADD CONSTRAINT "provider_media_comment_likes_comment_id_user_id_key" UNIQUE ("comment_id", "user_id");



ALTER TABLE ONLY "public"."provider_media_comment_likes"
    ADD CONSTRAINT "provider_media_comment_likes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."provider_media_comments"
    ADD CONSTRAINT "provider_media_comments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."provider_media_likes"
    ADD CONSTRAINT "provider_media_likes_media_id_user_id_key" UNIQUE ("media_id", "user_id");



ALTER TABLE ONLY "public"."provider_media_likes"
    ADD CONSTRAINT "provider_media_likes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."provider_media"
    ADD CONSTRAINT "provider_media_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."provider_media_saves"
    ADD CONSTRAINT "provider_media_saves_media_id_user_id_key" UNIQUE ("media_id", "user_id");



ALTER TABLE ONLY "public"."provider_media_saves"
    ADD CONSTRAINT "provider_media_saves_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."provider_payout_accounts"
    ADD CONSTRAINT "provider_payout_accounts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."provider_presales_projects"
    ADD CONSTRAINT "provider_presales_projects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."provider_saves"
    ADD CONSTRAINT "provider_saves_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."provider_saves"
    ADD CONSTRAINT "provider_saves_provider_id_user_id_key" UNIQUE ("provider_id", "user_id");



ALTER TABLE ONLY "public"."providers"
    ADD CONSTRAINT "providers_handle_unique" UNIQUE ("handle");



ALTER TABLE ONLY "public"."providers"
    ADD CONSTRAINT "providers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."providers"
    ADD CONSTRAINT "providers_profile_id_unique" UNIQUE ("profile_id");



ALTER TABLE ONLY "public"."push_action_audit"
    ADD CONSTRAINT "push_action_audit_pkey" PRIMARY KEY ("notification_id", "action_id");



ALTER TABLE ONLY "public"."ratings"
    ADD CONSTRAINT "ratings_job_id_key" UNIQUE ("job_id");



ALTER TABLE ONLY "public"."ratings"
    ADD CONSTRAINT "ratings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."revenuecat_webhook_events"
    ADD CONSTRAINT "revenuecat_webhook_events_pkey" PRIMARY KEY ("event_id");



ALTER TABLE ONLY "public"."saved_reel_folders"
    ADD CONSTRAINT "saved_reel_folders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scan_annotations"
    ADD CONSTRAINT "scan_annotations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scan_assets"
    ADD CONSTRAINT "scan_assets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scan_assets"
    ADD CONSTRAINT "scan_assets_scan_id_kind_key" UNIQUE ("scan_id", "kind");



ALTER TABLE ONLY "public"."scan_cleanup_log"
    ADD CONSTRAINT "scan_cleanup_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scan_events"
    ADD CONSTRAINT "scan_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scan_measurements"
    ADD CONSTRAINT "scan_measurements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scan_quality_reports"
    ADD CONSTRAINT "scan_quality_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scan_rooms"
    ADD CONSTRAINT "scan_rooms_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scan_status_transition_allowed"
    ADD CONSTRAINT "scan_status_transition_allowed_pkey" PRIMARY KEY ("from_status", "to_status");



ALTER TABLE ONLY "public"."scan_status_transition_log"
    ADD CONSTRAINT "scan_status_transition_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scan_surfaces"
    ADD CONSTRAINT "scan_surfaces_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scan_surfaces"
    ADD CONSTRAINT "scan_surfaces_room_id_surface_external_id_key" UNIQUE ("room_id", "surface_external_id");



ALTER TABLE ONLY "public"."scans"
    ADD CONSTRAINT "scans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."schedules"
    ADD CONSTRAINT "schedules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."spatial_assets"
    ADD CONSTRAINT "spatial_assets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."spatial_assets"
    ADD CONSTRAINT "spatial_assets_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."spatial_change_orders"
    ADD CONSTRAINT "spatial_change_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."spatial_edit_history"
    ADD CONSTRAINT "spatial_edit_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."spatial_materials"
    ADD CONSTRAINT "spatial_materials_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."spatial_materials"
    ADD CONSTRAINT "spatial_materials_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."spatial_node_links"
    ADD CONSTRAINT "spatial_node_links_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."spatial_node_overrides"
    ADD CONSTRAINT "spatial_node_overrides_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."spatial_node_overrides"
    ADD CONSTRAINT "spatial_node_overrides_scene_variant_node_uq" UNIQUE ("scene_id", "variant_id", "base_node_id");



ALTER TABLE ONLY "public"."spatial_pin_reviews"
    ADD CONSTRAINT "spatial_pin_reviews_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."spatial_pin_reviews"
    ADD CONSTRAINT "spatial_pin_reviews_uniq" UNIQUE ("scene_id", "annotation_node_id", "provider_org_id");



ALTER TABLE ONLY "public"."spatial_rescan_requests"
    ADD CONSTRAINT "spatial_rescan_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."spatial_scenes"
    ADD CONSTRAINT "spatial_scenes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."spatial_share_audit"
    ADD CONSTRAINT "spatial_share_audit_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stripe_events"
    ADD CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stripe_webhook_events"
    ADD CONSTRAINT "stripe_webhook_events_event_id_key" UNIQUE ("event_id");



ALTER TABLE ONLY "public"."stripe_webhook_events"
    ADD CONSTRAINT "stripe_webhook_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscription_withdrawal_consents"
    ADD CONSTRAINT "subscription_withdrawal_consents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."supplementary_payment_requests"
    ADD CONSTRAINT "supplementary_payment_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."team_member_audit"
    ADD CONSTRAINT "team_member_audit_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."team_members"
    ADD CONSTRAINT "team_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."thread_artifacts"
    ADD CONSTRAINT "thread_artifacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "time_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."timeline_signals"
    ADD CONSTRAINT "timeline_signals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."message_threads"
    ADD CONSTRAINT "uq_assignment_thread" UNIQUE ("calendar_entry_id");



ALTER TABLE ONLY "public"."user_blocks"
    ADD CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_notification_preferences"
    ADD CONSTRAINT "user_notification_preferences_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."user_reports"
    ADD CONSTRAINT "user_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."widerruf_requests"
    ADD CONSTRAINT "widerruf_requests_pkey" PRIMARY KEY ("id");



CREATE INDEX "absences_member_idx" ON "public"."absences" USING "btree" ("member_id", "start_date" DESC);



CREATE INDEX "absences_provider_active_idx" ON "public"."absences" USING "btree" ("provider_id", "start_date" DESC) WHERE ("status" = 'active'::"public"."absence_status");



CREATE INDEX "account_deletion_log_deleted_at_idx" ON "public"."account_deletion_log" USING "btree" ("deleted_at" DESC);



CREATE INDEX "account_deletion_log_user_id_idx" ON "public"."account_deletion_log" USING "btree" ("user_id");



CREATE INDEX "chat_attachments_asset_type_idx" ON "public"."chat_attachments" USING "btree" ("asset_type");



CREATE INDEX "chat_attachments_deleted_idx" ON "public"."chat_attachments" USING "btree" ("deleted_at") WHERE ("deleted_at" IS NOT NULL);



CREATE INDEX "chat_attachments_message_idx" ON "public"."chat_attachments" USING "btree" ("message_id");



CREATE INDEX "chat_messages_body_tsv_idx" ON "public"."chat_messages" USING "gin" ("body_tsv");



CREATE INDEX "chat_messages_deleted_idx" ON "public"."chat_messages" USING "btree" ("deleted_at") WHERE ("deleted_at" IS NOT NULL);



CREATE UNIQUE INDEX "chat_messages_idempotency_uq" ON "public"."chat_messages" USING "btree" ("idempotency_key") WHERE ("idempotency_key" IS NOT NULL);



CREATE INDEX "chat_messages_legacy_message_id_idx" ON "public"."chat_messages" USING "btree" ("legacy_message_id") WHERE ("legacy_message_id" IS NOT NULL);



CREATE INDEX "chat_messages_message_type_idx" ON "public"."chat_messages" USING "btree" ("message_type");



CREATE INDEX "chat_messages_project_artifact_idx" ON "public"."chat_messages" USING "btree" ("artifact_id") WHERE (("message_type" = 'artifact_card'::"text") AND ("artifact_type" = 'Project'::"text") AND ("deleted_at" IS NULL));



CREATE INDEX "chat_messages_thread_created_idx" ON "public"."chat_messages" USING "btree" ("thread_id", "created_at");



CREATE UNIQUE INDEX "chat_migration_legacy_unique_idx" ON "public"."chat_thread_migration_status" USING "btree" ("legacy_thread_id", "legacy_source");



CREATE INDEX "chat_migration_status_queue_idx" ON "public"."chat_thread_migration_status" USING "btree" ("status", "priority" DESC, "updated_at");



CREATE INDEX "chat_participants_thread_role_idx" ON "public"."chat_participants" USING "btree" ("thread_id", "role");



CREATE INDEX "chat_participants_user_active_idx" ON "public"."chat_participants" USING "btree" ("user_id", "left_at") WHERE ("left_at" IS NULL);



CREATE INDEX "chat_participants_user_visible_at_idx" ON "public"."chat_participants" USING "btree" ("user_id", "last_visible_message_at" DESC NULLS LAST) WHERE ("left_at" IS NULL);



CREATE INDEX "chat_threads_channel_last_msg_idx" ON "public"."chat_threads" USING "btree" ("channel_type", "last_message_at" DESC);



CREATE INDEX "chat_threads_craftsman_inbox_idx" ON "public"."chat_threads" USING "btree" ("craftsman_user_id", "last_message_at" DESC) WHERE (("channel_type" = 'customer'::"text") AND ("inquiry_origin" IS NOT NULL) AND ("declined_at" IS NULL));



CREATE INDEX "chat_threads_craftsman_user_idx" ON "public"."chat_threads" USING "btree" ("craftsman_user_id") WHERE ("craftsman_user_id" IS NOT NULL);



CREATE INDEX "chat_threads_customer_user_idx" ON "public"."chat_threads" USING "btree" ("customer_user_id") WHERE ("customer_user_id" IS NOT NULL);



CREATE UNIQUE INDEX "chat_threads_dispute_id_unique" ON "public"."chat_threads" USING "btree" ("dispute_id") WHERE (("channel_type" = 'dispute'::"text") AND ("dispute_id" IS NOT NULL));



CREATE INDEX "chat_threads_legacy_thread_id_idx" ON "public"."chat_threads" USING "btree" ("legacy_thread_id") WHERE ("legacy_thread_id" IS NOT NULL);



CREATE UNIQUE INDEX "chat_threads_provider_assignment_unique" ON "public"."chat_threads" USING "btree" ("provider_id", "assignment_calendar_entry_id") WHERE (("channel_type" = 'assignment'::"text") AND ("assignment_calendar_entry_id" IS NOT NULL));



CREATE INDEX "chat_threads_provider_channel_idx" ON "public"."chat_threads" USING "btree" ("provider_id", "channel_type");



CREATE UNIQUE INDEX "chat_threads_provider_internal_unique" ON "public"."chat_threads" USING "btree" ("provider_id", "channel_type") WHERE ("channel_type" = ANY (ARRAY['office'::"text", 'team'::"text"]));



CREATE UNIQUE INDEX "company_join_codes_code_active" ON "public"."company_join_codes" USING "btree" ("code") WHERE ("status" = 'active'::"text");



CREATE UNIQUE INDEX "company_join_codes_provider_active" ON "public"."company_join_codes" USING "btree" ("provider_id") WHERE ("status" = 'active'::"text");



CREATE INDEX "customer_request_sends_user_date_idx" ON "public"."customer_request_sends" USING "btree" ("user_id", "sent_date");



CREATE INDEX "dispute_evidence_dispute_id_idx" ON "public"."dispute_evidence" USING "btree" ("dispute_id");



CREATE INDEX "dispute_evidence_uploaded_by_profile_id_idx" ON "public"."dispute_evidence" USING "btree" ("uploaded_by_profile_id");



CREATE INDEX "dispute_spatial_evidence_dispute_id_idx" ON "public"."dispute_spatial_evidence" USING "btree" ("dispute_id");



CREATE INDEX "dispute_spatial_evidence_scene_id_idx" ON "public"."dispute_spatial_evidence" USING "btree" ("scene_id");



CREATE INDEX "dispute_spatial_evidence_submitted_at_idx" ON "public"."dispute_spatial_evidence" USING "btree" ("submitted_at" DESC);



CREATE INDEX "dispute_spatial_evidence_submitted_by_idx" ON "public"."dispute_spatial_evidence" USING "btree" ("submitted_by") WHERE ("submitted_by" IS NOT NULL);



CREATE INDEX "dispute_status_history_created_at_idx" ON "public"."dispute_status_history" USING "btree" ("created_at");



CREATE INDEX "dispute_status_history_dispute_id_idx" ON "public"."dispute_status_history" USING "btree" ("dispute_id");



CREATE INDEX "disputes_created_at_idx" ON "public"."disputes" USING "btree" ("created_at");



CREATE INDEX "disputes_customer_profile_id_idx" ON "public"."disputes" USING "btree" ("customer_profile_id");



CREATE INDEX "disputes_job_id_idx" ON "public"."disputes" USING "btree" ("job_id");



CREATE UNIQUE INDEX "disputes_one_active_per_job_idx" ON "public"."disputes" USING "btree" ("job_id") WHERE ("status" = ANY (ARRAY['open'::"text", 'under_review'::"text", 'customer_waiting'::"text", 'provider_waiting'::"text"]));



CREATE INDEX "disputes_opened_by_profile_id_idx" ON "public"."disputes" USING "btree" ("opened_by_profile_id");



CREATE INDEX "disputes_payment_id_idx" ON "public"."disputes" USING "btree" ("payment_id");



CREATE INDEX "disputes_project_id_idx" ON "public"."disputes" USING "btree" ("project_id");



CREATE INDEX "disputes_provider_id_idx" ON "public"."disputes" USING "btree" ("provider_id");



CREATE INDEX "disputes_status_idx" ON "public"."disputes" USING "btree" ("status");



CREATE INDEX "download_jobs_pending_idx" ON "public"."download_jobs" USING "btree" ("status", "requested_at") WHERE ("status" = ANY (ARRAY['pending'::"text", 'processing'::"text"]));



CREATE INDEX "download_jobs_scan_idx" ON "public"."download_jobs" USING "btree" ("scan_id", "requested_at" DESC);



CREATE INDEX "download_jobs_user_idx" ON "public"."download_jobs" USING "btree" ("requested_by", "requested_at" DESC);



CREATE INDEX "dsp_dispute_status_idx" ON "public"."dispute_split_proposals" USING "btree" ("dispute_id", "status");



CREATE UNIQUE INDEX "dsp_one_pending_per_dispute_idx" ON "public"."dispute_split_proposals" USING "btree" ("dispute_id") WHERE ("status" = 'pending'::"text");



CREATE INDEX "failed_join_attempts_time_idx" ON "public"."failed_join_attempts" USING "btree" ("attempted_at" DESC);



CREATE INDEX "failed_join_attempts_user_time_idx" ON "public"."failed_join_attempts" USING "btree" ("attempted_by", "attempted_at" DESC) WHERE ("attempted_by" IS NOT NULL);



CREATE INDEX "idx_acceptances_customer_user_id" ON "public"."acceptances" USING "btree" ("customer_user_id");



CREATE INDEX "idx_acceptances_job_id" ON "public"."acceptances" USING "btree" ("job_id");



CREATE INDEX "idx_acceptances_pending_expires" ON "public"."acceptances" USING "btree" ("expires_at") WHERE (("status" = 'pending'::"text") AND ("expires_at" IS NOT NULL));



CREATE INDEX "idx_analytics_events_created_at" ON "public"."analytics_events" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_analytics_events_event_type" ON "public"."analytics_events" USING "btree" ("event_type");



CREATE INDEX "idx_attribution_audit_log_event_type_created_at" ON "public"."attribution_audit_log" USING "btree" ("event_type", "created_at" DESC);



CREATE INDEX "idx_attribution_audit_log_job_id" ON "public"."attribution_audit_log" USING "btree" ("job_id", "created_at" DESC);



CREATE INDEX "idx_change_orders_craftsman_user_id" ON "public"."change_orders" USING "btree" ("craftsman_user_id");



CREATE INDEX "idx_change_orders_customer_user_id" ON "public"."change_orders" USING "btree" ("customer_user_id");



CREATE INDEX "idx_change_orders_job_id" ON "public"."change_orders" USING "btree" ("job_id");



CREATE INDEX "idx_company_code_audit_provider_rotated_at" ON "public"."company_code_audit" USING "btree" ("provider_id", "rotated_at" DESC);



CREATE INDEX "idx_company_join_codes_provider_id" ON "public"."company_join_codes" USING "btree" ("provider_id");



CREATE INDEX "idx_conversations_craftsman_user_id" ON "public"."conversations" USING "btree" ("craftsman_user_id") WHERE ("craftsman_user_id" IS NOT NULL);



CREATE INDEX "idx_conversations_created_at" ON "public"."conversations" USING "btree" ("created_at");



CREATE INDEX "idx_conversations_customer_user_id" ON "public"."conversations" USING "btree" ("customer_user_id") WHERE ("customer_user_id" IS NOT NULL);



CREATE INDEX "idx_correction_requests_provider_id" ON "public"."correction_requests" USING "btree" ("provider_id");



CREATE INDEX "idx_correction_requests_status" ON "public"."correction_requests" USING "btree" ("status");



CREATE INDEX "idx_correction_requests_worker_profile_id" ON "public"."correction_requests" USING "btree" ("worker_profile_id");



CREATE INDEX "idx_cpr_craftsman" ON "public"."customer_provider_relationships" USING "btree" ("craftsman_user_id");



CREATE INDEX "idx_cpr_customer" ON "public"."customer_provider_relationships" USING "btree" ("customer_user_id");



CREATE INDEX "idx_craftsman_subscriptions_profile_id" ON "public"."craftsman_subscriptions" USING "btree" ("profile_id");



CREATE INDEX "idx_craftsman_subscriptions_status" ON "public"."craftsman_subscriptions" USING "btree" ("status");



CREATE INDEX "idx_dispute_status_history_dispute_id" ON "public"."dispute_status_history" USING "btree" ("dispute_id");



CREATE INDEX "idx_dispute_status_history_job_id" ON "public"."dispute_status_history" USING "btree" ("job_id");



CREATE INDEX "idx_disputes_sla_waiting_updated_at" ON "public"."disputes" USING "btree" ("updated_at") WHERE ("status" = ANY (ARRAY['customer_waiting'::"text", 'provider_waiting'::"text"]));



COMMENT ON INDEX "public"."idx_disputes_sla_waiting_updated_at" IS 'N13.SLA-Cron: partial index over *_waiting disputes for the hourly SLA-reminder cron query (status IN (..._waiting) AND updated_at <= cutoff).';



CREATE INDEX "idx_email_delivery_log_job_id" ON "public"."email_delivery_log" USING "btree" ("job_id");



CREATE INDEX "idx_email_delivery_log_success" ON "public"."email_delivery_log" USING "btree" ("success") WHERE ("success" = false);



CREATE INDEX "idx_escrow_plans_customer" ON "public"."escrow_payment_plans" USING "btree" ("customer_user_id");



CREATE UNIQUE INDEX "idx_escrow_plans_idempotency_key" ON "public"."escrow_payment_plans" USING "btree" ("funding_idempotency_key") WHERE ("funding_idempotency_key" IS NOT NULL);



CREATE INDEX "idx_escrow_plans_job_id" ON "public"."escrow_payment_plans" USING "btree" ("job_id");



CREATE INDEX "idx_escrow_plans_provider" ON "public"."escrow_payment_plans" USING "btree" ("provider_id");



CREATE INDEX "idx_escrow_tranches_plan_id" ON "public"."escrow_tranches" USING "btree" ("plan_id");



CREATE INDEX "idx_funding_requests_active_expires" ON "public"."funding_requests" USING "btree" ("expires_at") WHERE ("status" <> ALL (ARRAY['funded'::"text", 'cancelled'::"text", 'expired'::"text"]));



CREATE INDEX "idx_funding_requests_customer" ON "public"."funding_requests" USING "btree" ("customer_user_id");



CREATE INDEX "idx_funding_requests_external_ref" ON "public"."funding_requests" USING "btree" ("external_funding_ref") WHERE ("external_funding_ref" IS NOT NULL);



CREATE UNIQUE INDEX "idx_funding_requests_idempotency_key" ON "public"."funding_requests" USING "btree" ("funding_idempotency_key") WHERE ("funding_idempotency_key" IS NOT NULL);



CREATE INDEX "idx_funding_requests_job_id" ON "public"."funding_requests" USING "btree" ("job_id");



CREATE INDEX "idx_funding_requests_provider" ON "public"."funding_requests" USING "btree" ("provider_id");



CREATE INDEX "idx_funding_requests_provider_id" ON "public"."funding_requests" USING "btree" ("provider_id") WHERE ("provider_id" IS NOT NULL);



CREATE INDEX "idx_funding_requests_source_offer_id" ON "public"."funding_requests" USING "btree" ("source_offer_id");



CREATE INDEX "idx_imsg_thread_time" ON "public"."internal_messages" USING "btree" ("thread_id", "created_at");



CREATE INDEX "idx_job_photos_job_id_created_at" ON "public"."job_photos" USING "btree" ("job_id", "created_at" DESC);



CREATE INDEX "idx_job_photos_provider_id_created_at" ON "public"."job_photos" USING "btree" ("provider_id", "created_at" DESC);



CREATE INDEX "idx_job_photos_uploaded_by_created_at" ON "public"."job_photos" USING "btree" ("uploaded_by", "created_at" DESC);



CREATE INDEX "idx_job_reports_authored_by_created_at" ON "public"."job_reports" USING "btree" ("authored_by", "created_at" DESC);



CREATE INDEX "idx_job_reports_job_id_created_at" ON "public"."job_reports" USING "btree" ("job_id", "created_at" DESC);



CREATE INDEX "idx_job_reports_provider_id_created_at" ON "public"."job_reports" USING "btree" ("provider_id", "created_at" DESC);



CREATE INDEX "idx_jobs_attribution_status" ON "public"."jobs" USING "btree" ("attribution_status") WHERE ("attribution_status" = ANY (ARRAY['pending'::"text", 'retrying'::"text", 'dlq'::"text"]));



CREATE INDEX "idx_jobs_commercial_origin" ON "public"."jobs" USING "btree" ("commercial_origin") WHERE ("commercial_origin" IS NOT NULL);



CREATE INDEX "idx_jobs_craftsman_user_id" ON "public"."jobs" USING "btree" ("craftsman_user_id");



CREATE INDEX "idx_jobs_funding_requested_at" ON "public"."jobs" USING "btree" ("funding_requested_at") WHERE ("funding_requested_at" IS NOT NULL);



CREATE INDEX "idx_jobs_project_id" ON "public"."jobs" USING "btree" ("project_id");



CREATE INDEX "idx_jobs_source_conversation_id" ON "public"."jobs" USING "btree" ("source_conversation_id");



CREATE INDEX "idx_jobs_source_offer_id" ON "public"."jobs" USING "btree" ("source_offer_id") WHERE ("source_offer_id" IS NOT NULL);



CREATE INDEX "idx_jobs_status" ON "public"."jobs" USING "btree" ("status");



CREATE INDEX "idx_jobs_work_completed_at" ON "public"."jobs" USING "btree" ("work_completed_at") WHERE ("work_completed_at" IS NOT NULL);



CREATE INDEX "idx_jobs_work_started_at" ON "public"."jobs" USING "btree" ("work_started_at") WHERE ("work_started_at" IS NOT NULL);



CREATE INDEX "idx_ledger_entries_dispute_id" ON "public"."ledger_entries" USING "btree" ("dispute_id") WHERE ("dispute_id" IS NOT NULL);



CREATE INDEX "idx_ledger_entries_job_id" ON "public"."ledger_entries" USING "btree" ("job_id");



CREATE INDEX "idx_ledger_entries_payment_id" ON "public"."ledger_entries" USING "btree" ("payment_id");



CREATE INDEX "idx_ledger_entries_type" ON "public"."ledger_entries" USING "btree" ("entry_type");



CREATE INDEX "idx_media_uploads_customer_visible_job" ON "public"."media_uploads" USING "btree" ("entity_id", "created_at" DESC) WHERE (("entity_type" = 'job'::"text") AND ("customer_visible" = true));



CREATE INDEX "idx_message_threads_calendar_entry" ON "public"."message_threads" USING "btree" ("calendar_entry_id") WHERE ("calendar_entry_id" IS NOT NULL);



CREATE INDEX "idx_message_threads_provider" ON "public"."message_threads" USING "btree" ("provider_id");



CREATE INDEX "idx_messages_conversation_id" ON "public"."messages" USING "btree" ("conversation_id");



CREATE INDEX "idx_messages_order" ON "public"."messages" USING "btree" ("conversation_id", "created_at");



CREATE INDEX "idx_moderation_action_log_created_at" ON "public"."moderation_action_log" USING "btree" ("created_at");



CREATE INDEX "idx_moderation_action_log_operator" ON "public"."moderation_action_log" USING "btree" ("operator_id");



CREATE INDEX "idx_moderation_action_log_report" ON "public"."moderation_action_log" USING "btree" ("report_id");



CREATE INDEX "idx_moderation_action_log_target_user" ON "public"."moderation_action_log" USING "btree" ("target_user_id");



CREATE INDEX "idx_mtp_member" ON "public"."message_thread_participants" USING "btree" ("team_member_id");



CREATE INDEX "idx_mtp_thread" ON "public"."message_thread_participants" USING "btree" ("thread_id");



CREATE INDEX "idx_notification_device_tokens_user_id" ON "public"."notification_device_tokens" USING "btree" ("user_id");



CREATE INDEX "idx_offers_conversation_id" ON "public"."offers" USING "btree" ("conversation_id");



CREATE INDEX "idx_offers_craftsman_user_id" ON "public"."offers" USING "btree" ("craftsman_user_id");



CREATE INDEX "idx_offers_customer_user_id" ON "public"."offers" USING "btree" ("customer_user_id");



CREATE INDEX "idx_owner_notes_authored_by_created_at" ON "public"."owner_notes" USING "btree" ("authored_by", "created_at" DESC);



CREATE INDEX "idx_owner_notes_job_id_created_at" ON "public"."owner_notes" USING "btree" ("job_id", "created_at" DESC);



CREATE INDEX "idx_payments_job_id" ON "public"."payments" USING "btree" ("job_id");



CREATE INDEX "idx_payments_provider_ref" ON "public"."payments" USING "btree" ("provider_ref") WHERE ("provider_ref" IS NOT NULL);



CREATE INDEX "idx_payments_provider_stripe_account" ON "public"."payments" USING "btree" ("provider_stripe_account_id") WHERE ("provider_stripe_account_id" IS NOT NULL);



CREATE INDEX "idx_payments_status" ON "public"."payments" USING "btree" ("status");



CREATE UNIQUE INDEX "idx_pma_cover_position" ON "public"."provider_media_assets" USING "btree" ("portfolio_item_id") WHERE ("sort_order" = 0);



CREATE UNIQUE INDEX "idx_pma_portfolio_item_sort" ON "public"."provider_media_assets" USING "btree" ("portfolio_item_id", "sort_order");



CREATE INDEX "idx_pma_provider_id" ON "public"."provider_media_assets" USING "btree" ("provider_id");



CREATE INDEX "idx_profiles_moderation_state" ON "public"."profiles" USING "btree" ("moderation_state") WHERE ("moderation_state" <> 'active'::"text");



CREATE INDEX "idx_projects_commercial_origin" ON "public"."projects" USING "btree" ("commercial_origin") WHERE ("commercial_origin" IS NOT NULL);



CREATE INDEX "idx_projects_source_job_id" ON "public"."projects" USING "btree" ("source_job_id");



CREATE INDEX "idx_projects_status" ON "public"."projects" USING "btree" ("status");



CREATE INDEX "idx_provider_highlight_items_highlight" ON "public"."provider_highlight_items" USING "btree" ("highlight_id", "position");



CREATE INDEX "idx_provider_highlights_provider" ON "public"."provider_highlights" USING "btree" ("provider_user_id", "position");



CREATE INDEX "idx_provider_media_comment_likes_comment" ON "public"."provider_media_comment_likes" USING "btree" ("comment_id");



CREATE INDEX "idx_provider_media_comment_likes_user" ON "public"."provider_media_comment_likes" USING "btree" ("user_id");



CREATE INDEX "idx_provider_media_comments_media_id_created_at" ON "public"."provider_media_comments" USING "btree" ("media_id", "created_at" DESC);



CREATE INDEX "idx_provider_media_comments_media_root" ON "public"."provider_media_comments" USING "btree" ("media_id", "created_at" DESC) WHERE ("parent_comment_id" IS NULL);



CREATE INDEX "idx_provider_media_comments_parent_created" ON "public"."provider_media_comments" USING "btree" ("parent_comment_id", "created_at");



CREATE INDEX "idx_provider_media_comments_user_id" ON "public"."provider_media_comments" USING "btree" ("user_id");



CREATE INDEX "idx_provider_media_likes_media_id" ON "public"."provider_media_likes" USING "btree" ("media_id");



CREATE INDEX "idx_provider_media_likes_user_id" ON "public"."provider_media_likes" USING "btree" ("user_id");



CREATE INDEX "idx_provider_media_portfolio" ON "public"."provider_media" USING "btree" ("provider_id", "kind", "sort_order") WHERE ("kind" = 'portfolio'::"text");



CREATE UNIQUE INDEX "idx_provider_media_provider_kind_singular" ON "public"."provider_media" USING "btree" ("provider_id", "kind") WHERE ("kind" <> 'portfolio'::"text");



CREATE INDEX "idx_provider_media_saves_media_id" ON "public"."provider_media_saves" USING "btree" ("media_id");



CREATE INDEX "idx_provider_media_saves_user_created" ON "public"."provider_media_saves" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_provider_media_saves_user_folder_created" ON "public"."provider_media_saves" USING "btree" ("user_id", "folder_id", "created_at" DESC);



CREATE INDEX "idx_provider_media_saves_user_id" ON "public"."provider_media_saves" USING "btree" ("user_id");



CREATE INDEX "idx_provider_saves_provider_id" ON "public"."provider_saves" USING "btree" ("provider_id");



CREATE INDEX "idx_provider_saves_user_created" ON "public"."provider_saves" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_provider_saves_user_id" ON "public"."provider_saves" USING "btree" ("user_id");



CREATE INDEX "idx_rc_webhook_events_outcome" ON "public"."revenuecat_webhook_events" USING "btree" ("outcome") WHERE ("outcome" = ANY (ARRAY['failed'::"text", 'skipped'::"text"]));



CREATE INDEX "idx_rc_webhook_events_user" ON "public"."revenuecat_webhook_events" USING "btree" ("app_user_id", "received_at" DESC);



CREATE UNIQUE INDEX "idx_saved_reel_folders_user_name_ci" ON "public"."saved_reel_folders" USING "btree" ("user_id", "lower"("btrim"("name")));



CREATE INDEX "idx_saved_reel_folders_user_sort" ON "public"."saved_reel_folders" USING "btree" ("user_id", "sort_order", "created_at" DESC);



CREATE INDEX "idx_spatial_scenes_origin" ON "public"."spatial_scenes" USING "btree" ("origin") WHERE ("origin" <> 'roomplan'::"text");



CREATE INDEX "idx_stripe_webhook_events_job_id" ON "public"."stripe_webhook_events" USING "btree" ("job_id") WHERE ("job_id" IS NOT NULL);



CREATE INDEX "idx_stripe_webhook_events_payment_intent_id" ON "public"."stripe_webhook_events" USING "btree" ("payment_intent_id") WHERE ("payment_intent_id" IS NOT NULL);



CREATE INDEX "idx_stripe_webhook_events_processed_at" ON "public"."stripe_webhook_events" USING "btree" ("processed_at" DESC);



CREATE INDEX "idx_subscription_withdrawal_consents_user" ON "public"."subscription_withdrawal_consents" USING "btree" ("user_id");



CREATE INDEX "idx_team_member_audit_member" ON "public"."team_member_audit" USING "btree" ("member_id", "created_at" DESC);



CREATE INDEX "idx_team_member_audit_provider_created" ON "public"."team_member_audit" USING "btree" ("provider_id", "created_at" DESC);



CREATE INDEX "idx_team_members_provider_email_stub" ON "public"."team_members" USING "btree" ("provider_id", "lower"("email")) WHERE (("profile_id" IS NULL) AND ("email" IS NOT NULL));



CREATE UNIQUE INDEX "idx_team_members_provider_profile_unique" ON "public"."team_members" USING "btree" ("provider_id", "profile_id") WHERE ("profile_id" IS NOT NULL);



CREATE INDEX "idx_thread_artifacts_change_order" ON "public"."thread_artifacts" USING "btree" ("change_order_id") WHERE ("change_order_id" IS NOT NULL);



CREATE INDEX "idx_thread_artifacts_conversation" ON "public"."thread_artifacts" USING "btree" ("conversation_id");



CREATE INDEX "idx_thread_artifacts_escrow_plan" ON "public"."thread_artifacts" USING "btree" ("escrow_plan_id") WHERE ("escrow_plan_id" IS NOT NULL);



CREATE INDEX "idx_thread_artifacts_funding_request" ON "public"."thread_artifacts" USING "btree" ("funding_request_id") WHERE ("funding_request_id" IS NOT NULL);



CREATE INDEX "idx_thread_artifacts_offer" ON "public"."thread_artifacts" USING "btree" ("offer_id") WHERE ("offer_id" IS NOT NULL);



CREATE UNIQUE INDEX "idx_thread_artifacts_offer_single" ON "public"."thread_artifacts" USING "btree" ("conversation_id", "artifact_type") WHERE ("artifact_type" = 'offer'::"text");



CREATE UNIQUE INDEX "idx_thread_artifacts_payment_phase_single" ON "public"."thread_artifacts" USING "btree" ("conversation_id", "artifact_type") WHERE ("artifact_type" = 'payment_phase'::"text");



CREATE INDEX "idx_thread_artifacts_project" ON "public"."thread_artifacts" USING "btree" ("project_id") WHERE ("project_id" IS NOT NULL);



CREATE INDEX "idx_user_blocks_blocked" ON "public"."user_blocks" USING "btree" ("blocked_id");



CREATE INDEX "idx_user_blocks_blocker" ON "public"."user_blocks" USING "btree" ("blocker_id");



CREATE INDEX "idx_user_reports_reported" ON "public"."user_reports" USING "btree" ("reported_id");



CREATE INDEX "idx_user_reports_reporter" ON "public"."user_reports" USING "btree" ("reporter_id");



CREATE INDEX "idx_user_reports_status" ON "public"."user_reports" USING "btree" ("status");



CREATE INDEX "idx_widerruf_requests_declared_at" ON "public"."widerruf_requests" USING "btree" ("declared_at");



CREATE INDEX "idx_widerruf_requests_user" ON "public"."widerruf_requests" USING "btree" ("user_id");



CREATE INDEX "index_operator_action_audit_created" ON "public"."operator_action_audit" USING "btree" ("created_at");



CREATE INDEX "index_operator_action_audit_operator" ON "public"."operator_action_audit" USING "btree" ("operator_id");



CREATE INDEX "invoices_original_invoice_id_idx" ON "public"."invoices" USING "btree" ("original_invoice_id") WHERE ("original_invoice_id" IS NOT NULL);



CREATE INDEX "job_assignments_job_id_idx" ON "public"."job_assignments" USING "btree" ("job_id");



CREATE UNIQUE INDEX "job_assignments_one_primary_per_job_idx" ON "public"."job_assignments" USING "btree" ("job_id") WHERE (("assignment_role" = 'primary'::"text") AND ("status" = ANY (ARRAY['assigned'::"text", 'accepted'::"text"])));



CREATE INDEX "job_assignments_provider_id_idx" ON "public"."job_assignments" USING "btree" ("provider_id");



CREATE INDEX "job_assignments_status_idx" ON "public"."job_assignments" USING "btree" ("status");



CREATE INDEX "job_assignments_team_member_id_idx" ON "public"."job_assignments" USING "btree" ("team_member_id");



CREATE INDEX "jobs_assigned_provider_id_idx" ON "public"."jobs" USING "btree" ("assigned_provider_id");



CREATE INDEX "jobs_assigned_team_member_id_idx" ON "public"."jobs" USING "btree" ("assigned_team_member_id");



CREATE INDEX "jobs_assignment_status_idx" ON "public"."jobs" USING "btree" ("assignment_status");



CREATE INDEX "jobs_city_idx" ON "public"."jobs" USING "btree" ("city");



CREATE INDEX "jobs_created_at_idx" ON "public"."jobs" USING "btree" ("created_at");



CREATE INDEX "jobs_customer_profile_id_idx" ON "public"."jobs" USING "btree" ("customer_profile_id");



CREATE INDEX "jobs_customer_user_id_idx" ON "public"."jobs" USING "btree" ("customer_user_id");



CREATE INDEX "jobs_dispute_id_idx" ON "public"."jobs" USING "btree" ("dispute_id");



CREATE INDEX "jobs_dispute_status_idx" ON "public"."jobs" USING "btree" ("dispute_status");



CREATE INDEX "jobs_provider_id_idx" ON "public"."jobs" USING "btree" ("provider_id");



CREATE INDEX "jobs_scheduled_for_idx" ON "public"."jobs" USING "btree" ("scheduled_for");



CREATE INDEX "jobs_status_idx" ON "public"."jobs" USING "btree" ("status");



CREATE INDEX "ledger_entries_dispute_idx" ON "public"."ledger_entries" USING "btree" ("dispute_id");



CREATE INDEX "ledger_entries_job_idx" ON "public"."ledger_entries" USING "btree" ("job_id");



CREATE UNIQUE INDEX "ledger_entries_payment_entrytype_movement_uidx" ON "public"."ledger_entries" USING "btree" ("payment_id", "entry_type", "movement_ref");



CREATE INDEX "ledger_entries_payment_idx" ON "public"."ledger_entries" USING "btree" ("payment_id");



CREATE INDEX "ledger_entries_type_idx" ON "public"."ledger_entries" USING "btree" ("entry_type");



CREATE INDEX "offers_is_stale_idx" ON "public"."offers" USING "btree" ("is_stale") WHERE ("is_stale" = true);



CREATE INDEX "offers_source_diagnosis_id_idx" ON "public"."offers" USING "btree" ("source_diagnosis_id") WHERE ("source_diagnosis_id" IS NOT NULL);



CREATE INDEX "offers_source_spatial_scene_idx" ON "public"."offers" USING "btree" ("source_spatial_scene_id") WHERE ("source_spatial_scene_id" IS NOT NULL);



COMMENT ON INDEX "public"."offers_source_spatial_scene_idx" IS 'Spatial C-10: partial index for findBySpatialScene reverse-lookups.';



CREATE INDEX "parametric_cleanup_log_ran_at_idx" ON "public"."parametric_cleanup_log" USING "btree" ("ran_at" DESC);



CREATE INDEX "payment_status_history_created_at_idx" ON "public"."payment_status_history" USING "btree" ("created_at");



CREATE INDEX "payment_status_history_payment_id_idx" ON "public"."payment_status_history" USING "btree" ("payment_id");



CREATE INDEX "payment_status_history_stripe_event_id_idx" ON "public"."payment_status_history" USING "btree" ("stripe_event_id");



CREATE INDEX "payments_amount_disputed_idx" ON "public"."payments" USING "btree" ("amount_disputed");



CREATE INDEX "payments_amount_released_idx" ON "public"."payments" USING "btree" ("amount_released");



CREATE INDEX "payments_created_at_idx" ON "public"."payments" USING "btree" ("created_at");



CREATE INDEX "payments_customer_profile_id_idx" ON "public"."payments" USING "btree" ("customer_profile_id");



CREATE INDEX "payments_dispute_id_idx" ON "public"."payments" USING "btree" ("dispute_id");



CREATE INDEX "payments_dispute_status_idx" ON "public"."payments" USING "btree" ("dispute_status");



CREATE INDEX "payments_job_id_idx" ON "public"."payments" USING "btree" ("job_id");



CREATE INDEX "payments_last_stripe_event_id_idx" ON "public"."payments" USING "btree" ("last_stripe_event_id");



CREATE INDEX "payments_project_id_idx" ON "public"."payments" USING "btree" ("project_id");



CREATE INDEX "payments_provider_id_idx" ON "public"."payments" USING "btree" ("provider_id");



CREATE INDEX "payments_provider_idx" ON "public"."payments" USING "btree" ("payment_provider");



CREATE INDEX "payments_reconciled_at_idx" ON "public"."payments" USING "btree" ("reconciled_at");



CREATE INDEX "payments_release_blocked_idx" ON "public"."payments" USING "btree" ("release_blocked");



CREATE INDEX "payments_status_idx" ON "public"."payments" USING "btree" ("status");



CREATE UNIQUE INDEX "payments_stripe_checkout_session_id_unique_idx" ON "public"."payments" USING "btree" ("stripe_checkout_session_id") WHERE ("stripe_checkout_session_id" IS NOT NULL);



CREATE INDEX "payments_stripe_payment_intent_id_idx" ON "public"."payments" USING "btree" ("stripe_payment_intent_id");



CREATE UNIQUE INDEX "payments_stripe_payment_intent_id_unique_idx" ON "public"."payments" USING "btree" ("stripe_payment_intent_id") WHERE ("stripe_payment_intent_id" IS NOT NULL);



CREATE INDEX "payments_stripe_status_idx" ON "public"."payments" USING "btree" ("stripe_status");



CREATE INDEX "profiles_craftsman_role_idx" ON "public"."profiles" USING "btree" ("craftsman_role");



CREATE INDEX "profiles_onboarding_done_idx" ON "public"."profiles" USING "btree" ("onboarding_done");



CREATE INDEX "profiles_role_idx" ON "public"."profiles" USING "btree" ("role");



CREATE INDEX "projects_craftsman_user_id_idx" ON "public"."projects" USING "btree" ("craftsman_user_id");



CREATE INDEX "projects_customer_profile_id_idx" ON "public"."projects" USING "btree" ("customer_profile_id");



CREATE INDEX "provider_media_kind_idx" ON "public"."provider_media" USING "btree" ("kind");



CREATE INDEX "provider_media_provider_id_idx" ON "public"."provider_media" USING "btree" ("provider_id");



CREATE INDEX "provider_media_sort_order_idx" ON "public"."provider_media" USING "btree" ("provider_id", "sort_order");



CREATE UNIQUE INDEX "provider_payout_accounts_provider_user_id_idx" ON "public"."provider_payout_accounts" USING "btree" ("provider_user_id");



CREATE INDEX "provider_presales_projects_converted_idx" ON "public"."provider_presales_projects" USING "btree" ("converted_to_job_id") WHERE ("converted_to_job_id" IS NOT NULL);



CREATE INDEX "provider_presales_projects_org_idx" ON "public"."provider_presales_projects" USING "btree" ("provider_org_id");



CREATE INDEX "provider_presales_projects_status_idx" ON "public"."provider_presales_projects" USING "btree" ("status");



CREATE INDEX "providers_city_idx" ON "public"."providers" USING "btree" ("city");



CREATE INDEX "providers_company_name_idx" ON "public"."providers" USING "btree" ("company_name");



CREATE UNIQUE INDEX "providers_handle_unique_idx" ON "public"."providers" USING "btree" ("handle") WHERE ("handle" IS NOT NULL);



CREATE INDEX "providers_is_public_idx" ON "public"."providers" USING "btree" ("is_public");



CREATE INDEX "providers_profile_id_idx" ON "public"."providers" USING "btree" ("profile_id");



CREATE INDEX "providers_search_idx" ON "public"."providers" USING "gin" ("search_vector");



CREATE INDEX "providers_search_vector_idx" ON "public"."providers" USING "gin" ("search_vector");



CREATE UNIQUE INDEX "providers_slug_unique_idx" ON "public"."providers" USING "btree" ("slug") WHERE ("slug" IS NOT NULL);



CREATE INDEX "push_action_audit_user_time_idx" ON "public"."push_action_audit" USING "btree" ("user_id", "performed_at" DESC);



CREATE INDEX "ratings_provider_user_id_idx" ON "public"."ratings" USING "btree" ("provider_user_id");



CREATE INDEX "scan_annotations_confidence_idx" ON "public"."scan_annotations" USING "btree" ("confidence") WHERE ("confidence" = ANY (ARRAY['low'::"public"."scan_anchor_confidence", 'lost'::"public"."scan_anchor_confidence"]));



CREATE INDEX "scan_annotations_customer_pin_type_idx" ON "public"."scan_annotations" USING "btree" ("scan_id", "customer_pin_type") WHERE ("customer_pin_type" IS NOT NULL);



CREATE INDEX "scan_annotations_customer_visible_idx" ON "public"."scan_annotations" USING "btree" ("scan_id", "customer_visible") WHERE ("customer_visible" = true);



CREATE INDEX "scan_annotations_kind_idx" ON "public"."scan_annotations" USING "btree" ("kind");



CREATE INDEX "scan_annotations_offer_relevant_idx" ON "public"."scan_annotations" USING "btree" ("scan_id") WHERE ("offer_relevant" = true);



CREATE INDEX "scan_annotations_scan_id_idx" ON "public"."scan_annotations" USING "btree" ("scan_id");



CREATE INDEX "scan_annotations_status_idx" ON "public"."scan_annotations" USING "btree" ("status");



CREATE INDEX "scan_assets_converted_from_idx" ON "public"."scan_assets" USING "btree" ("converted_from") WHERE ("converted_from" IS NOT NULL);



CREATE INDEX "scan_assets_kind_idx" ON "public"."scan_assets" USING "btree" ("kind");



CREATE INDEX "scan_assets_scan_id_idx" ON "public"."scan_assets" USING "btree" ("scan_id");



CREATE INDEX "scan_cleanup_log_ran_at_idx" ON "public"."scan_cleanup_log" USING "btree" ("ran_at" DESC);



CREATE INDEX "scan_events_action_idx" ON "public"."scan_events" USING "btree" ("action");



CREATE INDEX "scan_events_actor_id_idx" ON "public"."scan_events" USING "btree" ("actor_id") WHERE ("actor_id" IS NOT NULL);



CREATE UNIQUE INDEX "scan_events_idempotency_key_uidx" ON "public"."scan_events" USING "btree" ("scan_id", "idempotency_key") WHERE ("idempotency_key" IS NOT NULL);



CREATE INDEX "scan_events_scan_id_at_idx" ON "public"."scan_events" USING "btree" ("scan_id", "at" DESC);



CREATE INDEX "scan_measurements_scan_id_idx" ON "public"."scan_measurements" USING "btree" ("scan_id");



CREATE INDEX "scan_measurements_status_idx" ON "public"."scan_measurements" USING "btree" ("status");



CREATE INDEX "scan_measurements_surface_id_idx" ON "public"."scan_measurements" USING "btree" ("surface_id") WHERE ("surface_id" IS NOT NULL);



CREATE INDEX "scan_measurements_verified_by_idx" ON "public"."scan_measurements" USING "btree" ("verified_by") WHERE ("verified_by" IS NOT NULL);



CREATE INDEX "scan_quality_reports_bucket_idx" ON "public"."scan_quality_reports" USING "btree" ("bucket");



CREATE INDEX "scan_quality_reports_generated_at_idx" ON "public"."scan_quality_reports" USING "btree" ("generated_at" DESC);



CREATE INDEX "scan_quality_reports_scan_id_idx" ON "public"."scan_quality_reports" USING "btree" ("scan_id");



CREATE INDEX "scan_rooms_scan_id_idx" ON "public"."scan_rooms" USING "btree" ("scan_id");



CREATE INDEX "scan_status_transition_log_actor_id_idx" ON "public"."scan_status_transition_log" USING "btree" ("actor_id") WHERE ("actor_id" IS NOT NULL);



CREATE INDEX "scan_status_transition_log_scan_id_at_idx" ON "public"."scan_status_transition_log" USING "btree" ("scan_id", "occurred_at" DESC);



CREATE INDEX "scan_surfaces_kind_idx" ON "public"."scan_surfaces" USING "btree" ("kind");



CREATE INDEX "scan_surfaces_room_id_idx" ON "public"."scan_surfaces" USING "btree" ("room_id");



CREATE INDEX "scan_surfaces_status_idx" ON "public"."scan_surfaces" USING "btree" ("status");



CREATE INDEX "scan_surfaces_surface_external_id_idx" ON "public"."scan_surfaces" USING "btree" ("surface_external_id");



CREATE INDEX "scans_captured_by_idx" ON "public"."scans" USING "btree" ("captured_by");



CREATE INDEX "scans_job_id_idx" ON "public"."scans" USING "btree" ("job_id") WHERE ("job_id" IS NOT NULL);



CREATE INDEX "scans_owner_type_idx" ON "public"."scans" USING "btree" ("owner_type") WHERE ("owner_type" = 'customer'::"text");



CREATE INDEX "scans_parent_scan_id_idx" ON "public"."scans" USING "btree" ("parent_scan_id") WHERE ("parent_scan_id" IS NOT NULL);



CREATE INDEX "scans_presales_project_id_idx" ON "public"."scans" USING "btree" ("presales_project_id") WHERE ("presales_project_id" IS NOT NULL);



CREATE INDEX "scans_project_id_idx" ON "public"."scans" USING "btree" ("project_id") WHERE ("project_id" IS NOT NULL);



CREATE INDEX "scans_quality_label_idx" ON "public"."scans" USING "btree" ("job_id", "quality_label") WHERE ("quality_label" IS NOT NULL);



CREATE INDEX "scans_shared_with_customer_idx" ON "public"."scans" USING "btree" ("job_id", "shared_with_customer") WHERE ("shared_with_customer" = true);



CREATE INDEX "scans_shared_with_provider_idx" ON "public"."scans" USING "btree" ("shared_with_provider_id") WHERE ("shared_with_provider_id" IS NOT NULL);



CREATE INDEX "scans_status_idx" ON "public"."scans" USING "btree" ("status");



CREATE INDEX "spatial_assets_category_idx" ON "public"."spatial_assets" USING "btree" ("category");



CREATE INDEX "spatial_assets_geometry_kind_idx" ON "public"."spatial_assets" USING "btree" ("geometry_kind");



CREATE INDEX "spatial_assets_published_idx" ON "public"."spatial_assets" USING "btree" ("published") WHERE ("published" = true);



CREATE INDEX "spatial_assets_tags_gin_idx" ON "public"."spatial_assets" USING "gin" ("tags");



CREATE INDEX "spatial_change_orders_proposer_id_idx" ON "public"."spatial_change_orders" USING "btree" ("proposer_id");



CREATE INDEX "spatial_change_orders_scene_id_idx" ON "public"."spatial_change_orders" USING "btree" ("scene_id");



CREATE INDEX "spatial_change_orders_status_idx" ON "public"."spatial_change_orders" USING "btree" ("status");



CREATE INDEX "spatial_edit_history_actor_id_idx" ON "public"."spatial_edit_history" USING "btree" ("actor_id") WHERE ("actor_id" IS NOT NULL);



CREATE INDEX "spatial_edit_history_created_at_idx" ON "public"."spatial_edit_history" USING "btree" ("created_at" DESC);



CREATE INDEX "spatial_edit_history_provider_org_id_idx" ON "public"."spatial_edit_history" USING "btree" ("provider_org_id") WHERE ("provider_org_id" IS NOT NULL);



CREATE INDEX "spatial_edit_history_scene_id_idx" ON "public"."spatial_edit_history" USING "btree" ("scene_id");



CREATE INDEX "spatial_materials_category_idx" ON "public"."spatial_materials" USING "btree" ("category");



CREATE INDEX "spatial_materials_published_idx" ON "public"."spatial_materials" USING "btree" ("published") WHERE ("published" = true);



CREATE INDEX "spatial_materials_surface_category_idx" ON "public"."spatial_materials" USING "btree" ("surface_category");



CREATE INDEX "spatial_materials_tags_gin_idx" ON "public"."spatial_materials" USING "gin" ("tags");



CREATE INDEX "spatial_node_links_created_by_idx" ON "public"."spatial_node_links" USING "btree" ("created_by") WHERE ("created_by" IS NOT NULL);



CREATE INDEX "spatial_node_links_scene_node_link_idx" ON "public"."spatial_node_links" USING "btree" ("scene_id", "node_id", "link_type");



CREATE INDEX "spatial_node_links_target_idx" ON "public"."spatial_node_links" USING "btree" ("target_table", "target_id");



CREATE INDEX "spatial_node_overrides_created_by_user_id_idx" ON "public"."spatial_node_overrides" USING "btree" ("created_by_user_id") WHERE ("created_by_user_id" IS NOT NULL);



CREATE INDEX "spatial_node_overrides_scene_id_idx" ON "public"."spatial_node_overrides" USING "btree" ("scene_id");



CREATE INDEX "spatial_pin_reviews_scene_created_idx" ON "public"."spatial_pin_reviews" USING "btree" ("scene_id", "created_at" DESC);



CREATE INDEX "spatial_rescan_requests_org_created_idx" ON "public"."spatial_rescan_requests" USING "btree" ("provider_org_id", "created_at" DESC);



CREATE INDEX "spatial_rescan_requests_resulting_scene_id_idx" ON "public"."spatial_rescan_requests" USING "btree" ("resulting_scene_id") WHERE ("resulting_scene_id" IS NOT NULL);



COMMENT ON INDEX "public"."spatial_rescan_requests_resulting_scene_id_idx" IS 'Spatial D2 (B7): partial index supporting request -> resulting-scene lookups in the Hub Activity-Feed and rescan-completion badges.';



CREATE INDEX "spatial_rescan_requests_scene_created_idx" ON "public"."spatial_rescan_requests" USING "btree" ("scene_id", "created_at" DESC);



CREATE INDEX "spatial_scenes_customer_id_idx" ON "public"."spatial_scenes" USING "btree" ("customer_id") WHERE ("customer_id" IS NOT NULL);



CREATE INDEX "spatial_scenes_parent_scene_id_idx" ON "public"."spatial_scenes" USING "btree" ("parent_scene_id") WHERE ("parent_scene_id" IS NOT NULL);



COMMENT ON INDEX "public"."spatial_scenes_parent_scene_id_idx" IS 'Spatial D2 (B7): partial index supporting parent -> children lookups for JobSpatialRescanTab + JobSpatialCompareTab. WHERE-clause keeps root scenes out of the index.';



CREATE INDEX "spatial_scenes_polygon_outline_present_idx" ON "public"."spatial_scenes" USING "btree" ((("polygon_outline" IS NOT NULL))) WHERE ("polygon_outline" IS NOT NULL);



COMMENT ON INDEX "public"."spatial_scenes_polygon_outline_present_idx" IS 'V1.5 Hotfix E4: partial index supporting "has polygon outline" filters for renderer-eligibility checks.';



CREATE INDEX "spatial_scenes_provider_id_idx" ON "public"."spatial_scenes" USING "btree" ("provider_id") WHERE ("provider_id" IS NOT NULL);



CREATE INDEX "spatial_scenes_provider_org_id_idx" ON "public"."spatial_scenes" USING "btree" ("provider_org_id") WHERE ("provider_org_id" IS NOT NULL);



CREATE INDEX "spatial_scenes_source_job_id_idx" ON "public"."spatial_scenes" USING "btree" ("source_job_id") WHERE ("source_job_id" IS NOT NULL);



CREATE UNIQUE INDEX "spatial_scenes_source_scan_id_uidx" ON "public"."spatial_scenes" USING "btree" ("source_scan_id") WHERE ("source_scan_id" IS NOT NULL);



COMMENT ON INDEX "public"."spatial_scenes_source_scan_id_uidx" IS 'Idempotency guard for spatial_create_scene: one source scan maps to at most one scene. Partial (source_scan_id IS NOT NULL) so job-origin scenes are unconstrained. Replaces the non-unique spatial_scenes_source_scan_id_idx.';



CREATE INDEX "spatial_scenes_validation_state_idx" ON "public"."spatial_scenes" USING "btree" ("validation_state");



CREATE INDEX "spatial_share_audit_actor_idx" ON "public"."spatial_share_audit" USING "btree" ("actor_user_id");



CREATE INDEX "spatial_share_audit_created_at_idx" ON "public"."spatial_share_audit" USING "btree" ("created_at" DESC);



CREATE INDEX "spatial_share_audit_scan_id_idx" ON "public"."spatial_share_audit" USING "btree" ("scan_id");



CREATE INDEX "stripe_events_checkout_session_id_idx" ON "public"."stripe_events" USING "btree" ("checkout_session_id");



CREATE INDEX "stripe_events_event_type_idx" ON "public"."stripe_events" USING "btree" ("event_type");



CREATE INDEX "stripe_events_payment_intent_id_idx" ON "public"."stripe_events" USING "btree" ("payment_intent_id");



CREATE INDEX "stripe_events_processing_status_idx" ON "public"."stripe_events" USING "btree" ("processing_status");



CREATE INDEX "stripe_events_received_at_idx" ON "public"."stripe_events" USING "btree" ("received_at");



CREATE UNIQUE INDEX "stripe_events_stripe_event_id_unique_idx" ON "public"."stripe_events" USING "btree" ("stripe_event_id");



CREATE UNIQUE INDEX "stripe_webhook_events_event_id_unique_idx" ON "public"."stripe_webhook_events" USING "btree" ("stripe_event_id");



CREATE INDEX "stripe_webhook_events_payment_intent_idx" ON "public"."stripe_webhook_events" USING "btree" ("payment_intent_id");



CREATE INDEX "stripe_webhook_events_status_idx" ON "public"."stripe_webhook_events" USING "btree" ("processing_status");



CREATE UNIQUE INDEX "supplementary_payment_requests_change_order_id_key" ON "public"."supplementary_payment_requests" USING "btree" ("change_order_id");



CREATE INDEX "supplementary_payment_requests_craftsman_idx" ON "public"."supplementary_payment_requests" USING "btree" ("craftsman_user_id");



CREATE INDEX "supplementary_payment_requests_customer_idx" ON "public"."supplementary_payment_requests" USING "btree" ("customer_user_id");



CREATE INDEX "supplementary_payment_requests_external_ref_idx" ON "public"."supplementary_payment_requests" USING "btree" ("external_ref") WHERE ("external_ref" IS NOT NULL);



CREATE INDEX "supplementary_payment_requests_job_id_idx" ON "public"."supplementary_payment_requests" USING "btree" ("job_id");



CREATE INDEX "supplementary_payment_requests_payout_ref_idx" ON "public"."supplementary_payment_requests" USING "btree" ("external_payout_ref") WHERE ("external_payout_ref" IS NOT NULL);



CREATE INDEX "team_members_is_active_idx" ON "public"."team_members" USING "btree" ("is_active");



CREATE INDEX "team_members_profile_id_idx" ON "public"."team_members" USING "btree" ("profile_id");



CREATE INDEX "team_members_provider_id_idx" ON "public"."team_members" USING "btree" ("provider_id");



CREATE UNIQUE INDEX "team_members_unique_provider_profile_idx" ON "public"."team_members" USING "btree" ("provider_id", "profile_id") WHERE ("profile_id" IS NOT NULL);



CREATE UNIQUE INDEX "time_entries_active_day_unique" ON "public"."time_entries" USING "btree" ("member_id") WHERE (("kind" = 'day'::"public"."time_entry_kind") AND ("status" = 'active'::"public"."time_entry_status"));



CREATE UNIQUE INDEX "time_entries_active_job_unique" ON "public"."time_entries" USING "btree" ("member_id") WHERE (("kind" = 'job'::"public"."time_entry_kind") AND ("status" = 'active'::"public"."time_entry_status"));



CREATE INDEX "time_entries_member_started_idx" ON "public"."time_entries" USING "btree" ("member_id", "started_at" DESC);



CREATE INDEX "time_entries_provider_started_idx" ON "public"."time_entries" USING "btree" ("provider_id", "started_at" DESC);



CREATE INDEX "timeline_signals_entity_id_idx" ON "public"."timeline_signals" USING "btree" ("entity_id") WHERE ("entity_id" IS NOT NULL);



CREATE UNIQUE INDEX "uq_acceptances_job_accepted" ON "public"."acceptances" USING "btree" ("job_id") WHERE ("status" = 'accepted'::"text");



CREATE UNIQUE INDEX "uq_acceptances_job_pending" ON "public"."acceptances" USING "btree" ("job_id") WHERE ("status" = 'pending'::"text");



CREATE UNIQUE INDEX "uq_offers_one_pending_per_conversation" ON "public"."offers" USING "btree" ("conversation_id") WHERE ("status" = 'pending'::"text");



CREATE UNIQUE INDEX "uq_offers_one_pending_per_spatial_scene" ON "public"."offers" USING "btree" ("source_spatial_scene_id") WHERE (("source_spatial_scene_id" IS NOT NULL) AND ("status" = 'pending'::"text"));



COMMENT ON INDEX "public"."uq_offers_one_pending_per_spatial_scene" IS 'Spatial C-10: at most one pending offer per spatial scene — server-side idempotency for repeated Quote-Send taps.';



CREATE UNIQUE INDEX "uq_office_team_threads" ON "public"."message_threads" USING "btree" ("provider_id", "thread_type") WHERE ("thread_type" = ANY (ARRAY['office'::"text", 'team'::"text"]));



CREATE OR REPLACE TRIGGER "absences_set_updated_at" BEFORE UPDATE ON "public"."absences" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "assert_attribution_finalized_before_release_supplementary" BEFORE INSERT OR UPDATE ON "public"."supplementary_payment_requests" FOR EACH ROW EXECUTE FUNCTION "public"."assert_attribution_finalized_before_release"();



CREATE OR REPLACE TRIGGER "assert_attribution_finalized_before_release_tranche" BEFORE INSERT OR UPDATE ON "public"."escrow_tranches" FOR EACH ROW EXECUTE FUNCTION "public"."assert_attribution_finalized_before_release"();



CREATE OR REPLACE TRIGGER "assign_invoice_number" BEFORE INSERT OR UPDATE ON "public"."invoices" FOR EACH ROW EXECUTE FUNCTION "public"."generate_invoice_number"();



CREATE OR REPLACE TRIGGER "chat_attachments_after_insert" AFTER INSERT ON "public"."chat_attachments" FOR EACH ROW EXECUTE FUNCTION "public"."fn_chat_set_message_type_on_attachment"();



CREATE OR REPLACE TRIGGER "chat_messages_after_insert" AFTER INSERT ON "public"."chat_messages" FOR EACH ROW EXECUTE FUNCTION "public"."fn_chat_update_thread_last_message"();



CREATE OR REPLACE TRIGGER "chat_messages_dispatch_push_tg" AFTER INSERT ON "public"."chat_messages" FOR EACH ROW EXECUTE FUNCTION "public"."chat_messages_dispatch_push"();



CREATE OR REPLACE TRIGGER "chat_migration_status_set_updated_at" BEFORE UPDATE ON "public"."chat_thread_migration_status" FOR EACH ROW EXECUTE FUNCTION "public"."fn_chat_migration_status_set_updated_at"();



CREATE OR REPLACE TRIGGER "disputes_sla_reset_trigger" BEFORE UPDATE OF "status" ON "public"."disputes" FOR EACH ROW EXECUTE FUNCTION "public"."disputes_sla_reset_trigger_fn"();



CREATE OR REPLACE TRIGGER "disputes_status_change_guard_tg" BEFORE UPDATE ON "public"."disputes" FOR EACH ROW EXECUTE FUNCTION "public"."disputes_status_change_guard"();



CREATE OR REPLACE TRIGGER "enforce_invoice_immutability_trigger" BEFORE UPDATE ON "public"."invoices" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_invoice_immutability"();



CREATE OR REPLACE TRIGGER "job_reports_set_updated_at" BEFORE UPDATE ON "public"."job_reports" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "jobs_terminal_status_guard_tg" BEFORE UPDATE OF "status" ON "public"."jobs" FOR EACH ROW WHEN (("old"."status" IS DISTINCT FROM "new"."status")) EXECUTE FUNCTION "public"."jobs_terminal_status_guard"();



CREATE OR REPLACE TRIGGER "notification_signals_dispatch_push_tg" AFTER INSERT ON "public"."notification_signals" FOR EACH ROW EXECUTE FUNCTION "public"."notification_signals_dispatch_push"();



CREATE OR REPLACE TRIGGER "owner_notes_set_updated_at" BEFORE UPDATE ON "public"."owner_notes" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "pmc_enforce_depth" BEFORE INSERT OR UPDATE ON "public"."provider_media_comments" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_comment_depth"();



CREATE OR REPLACE TRIGGER "pmc_parent_immutable" BEFORE UPDATE ON "public"."provider_media_comments" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_parent_comment_id_immutable"();



CREATE OR REPLACE TRIGGER "provider_presales_projects_set_updated_at_trg" BEFORE UPDATE ON "public"."provider_presales_projects" FOR EACH ROW EXECUTE FUNCTION "public"."provider_presales_projects_set_updated_at"();



CREATE OR REPLACE TRIGGER "providers_search_vector_trigger" BEFORE INSERT OR UPDATE ON "public"."providers" FOR EACH ROW EXECUTE FUNCTION "public"."update_provider_search_vector"();



CREATE OR REPLACE TRIGGER "scan_annotations_dispute_lock_guard" BEFORE INSERT OR DELETE OR UPDATE ON "public"."scan_annotations" FOR EACH ROW EXECUTE FUNCTION "public"."spatial_dispute_lock_guard"();



CREATE OR REPLACE TRIGGER "scan_annotations_set_updated_at" BEFORE UPDATE ON "public"."scan_annotations" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "scan_assets_dispute_lock_guard" BEFORE INSERT OR DELETE OR UPDATE ON "public"."scan_assets" FOR EACH ROW EXECUTE FUNCTION "public"."spatial_dispute_lock_guard"();



CREATE OR REPLACE TRIGGER "scan_events_broadcast_ai" AFTER INSERT ON "public"."scan_events" FOR EACH ROW EXECUTE FUNCTION "public"."spatial_scan_event_broadcast"();



CREATE OR REPLACE TRIGGER "scan_measurements_dispute_lock_guard" BEFORE INSERT OR DELETE OR UPDATE ON "public"."scan_measurements" FOR EACH ROW EXECUTE FUNCTION "public"."spatial_dispute_lock_guard"();



CREATE OR REPLACE TRIGGER "scan_measurements_set_updated_at" BEFORE UPDATE ON "public"."scan_measurements" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "scan_quality_reports_broadcast_ai" AFTER INSERT ON "public"."scan_quality_reports" FOR EACH ROW EXECUTE FUNCTION "public"."spatial_scan_quality_broadcast"();



CREATE OR REPLACE TRIGGER "scan_rooms_dispute_lock_guard" BEFORE INSERT OR DELETE OR UPDATE ON "public"."scan_rooms" FOR EACH ROW EXECUTE FUNCTION "public"."spatial_dispute_lock_guard"();



CREATE OR REPLACE TRIGGER "scan_rooms_set_updated_at" BEFORE UPDATE ON "public"."scan_rooms" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "scan_surfaces_dispute_lock_guard" BEFORE INSERT OR DELETE OR UPDATE ON "public"."scan_surfaces" FOR EACH ROW EXECUTE FUNCTION "public"."spatial_dispute_lock_guard"();



CREATE OR REPLACE TRIGGER "scan_surfaces_set_updated_at" BEFORE UPDATE ON "public"."scan_surfaces" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "scans_broadcast_aiud" AFTER INSERT OR DELETE OR UPDATE ON "public"."scans" FOR EACH ROW EXECUTE FUNCTION "public"."spatial_scan_broadcast"();



CREATE OR REPLACE TRIGGER "scans_dispute_lock_guard" BEFORE DELETE OR UPDATE ON "public"."scans" FOR EACH ROW EXECUTE FUNCTION "public"."spatial_dispute_lock_guard"();



CREATE OR REPLACE TRIGGER "scans_enforce_fsm_insert" BEFORE INSERT ON "public"."scans" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_scan_fsm"();



CREATE OR REPLACE TRIGGER "scans_enforce_fsm_update" BEFORE UPDATE OF "status" ON "public"."scans" FOR EACH ROW WHEN (("new"."status" IS DISTINCT FROM "old"."status")) EXECUTE FUNCTION "public"."enforce_scan_fsm"();



CREATE OR REPLACE TRIGGER "scans_log_provider_share_action" BEFORE UPDATE OF "shared_with_provider_id" ON "public"."scans" FOR EACH ROW EXECUTE FUNCTION "public"."spatial_log_provider_share_action"();



CREATE OR REPLACE TRIGGER "scans_log_share_action" BEFORE UPDATE OF "shared_with_customer" ON "public"."scans" FOR EACH ROW EXECUTE FUNCTION "public"."spatial_log_share_action"();



CREATE OR REPLACE TRIGGER "scans_set_updated_at" BEFORE UPDATE ON "public"."scans" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "set_disputes_updated_at" BEFORE UPDATE ON "public"."disputes" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "set_job_assignments_updated_at" BEFORE UPDATE ON "public"."job_assignments" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "set_jobs_updated_at" BEFORE UPDATE ON "public"."jobs" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "set_payments_updated_at" BEFORE UPDATE ON "public"."payments" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "set_provider_media_updated_at" BEFORE UPDATE ON "public"."provider_media" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "set_providers_updated_at" BEFORE UPDATE ON "public"."providers" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "set_team_members_updated_at" BEFORE UPDATE ON "public"."team_members" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "spatial_assets_set_updated_at" BEFORE UPDATE ON "public"."spatial_assets" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "spatial_change_orders_aaa_immutable_cols" BEFORE UPDATE ON "public"."spatial_change_orders" FOR EACH ROW EXECUTE FUNCTION "public"."spatial_change_orders_immutable_cols_guard"();



CREATE OR REPLACE TRIGGER "spatial_change_orders_dispute_lock_guard" BEFORE INSERT OR DELETE OR UPDATE ON "public"."spatial_change_orders" FOR EACH ROW EXECUTE FUNCTION "public"."spatial_canonical_dispute_lock_guard"();



CREATE OR REPLACE TRIGGER "spatial_change_orders_set_updated_at" BEFORE UPDATE ON "public"."spatial_change_orders" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "spatial_change_orders_status_fsm" BEFORE UPDATE ON "public"."spatial_change_orders" FOR EACH ROW EXECUTE FUNCTION "public"."spatial_change_orders_status_fsm_guard"();



CREATE OR REPLACE TRIGGER "spatial_materials_set_updated_at" BEFORE UPDATE ON "public"."spatial_materials" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "spatial_node_overrides_dispute_lock_guard" BEFORE INSERT OR DELETE OR UPDATE ON "public"."spatial_node_overrides" FOR EACH ROW EXECUTE FUNCTION "public"."spatial_canonical_dispute_lock_guard"();



CREATE OR REPLACE TRIGGER "spatial_node_overrides_set_updated_at" BEFORE UPDATE ON "public"."spatial_node_overrides" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "spatial_notify_convert_done_trg" AFTER INSERT ON "public"."scan_assets" FOR EACH ROW WHEN (("new"."kind" = 'gltf'::"public"."scan_asset_kind")) EXECUTE FUNCTION "public"."spatial_notify_convert_done"();



CREATE OR REPLACE TRIGGER "spatial_pin_reviews_set_updated_at" BEFORE UPDATE ON "public"."spatial_pin_reviews" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "spatial_rescan_requests_set_updated_at" BEFORE UPDATE ON "public"."spatial_rescan_requests" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "spatial_scenes_aaa_immutable_cols" BEFORE UPDATE ON "public"."spatial_scenes" FOR EACH ROW EXECUTE FUNCTION "public"."spatial_scenes_immutable_cols_guard"();



CREATE OR REPLACE TRIGGER "spatial_scenes_customer_verify_fsm" BEFORE UPDATE ON "public"."spatial_scenes" FOR EACH ROW EXECUTE FUNCTION "public"."spatial_scenes_customer_verify_fsm_guard"();



CREATE OR REPLACE TRIGGER "spatial_scenes_dispute_lock_guard" BEFORE DELETE OR UPDATE ON "public"."spatial_scenes" FOR EACH ROW EXECUTE FUNCTION "public"."spatial_canonical_dispute_lock_guard"();



CREATE OR REPLACE TRIGGER "spatial_scenes_fill_provider_org_trg" BEFORE INSERT OR UPDATE OF "provider_id", "provider_org_id" ON "public"."spatial_scenes" FOR EACH ROW EXECUTE FUNCTION "public"."spatial_scenes_fill_provider_org"();



CREATE OR REPLACE TRIGGER "spatial_scenes_set_updated_at" BEFORE UPDATE ON "public"."spatial_scenes" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "spatial_scenes_validation_state_fsm" BEFORE UPDATE ON "public"."spatial_scenes" FOR EACH ROW EXECUTE FUNCTION "public"."spatial_scenes_validation_state_fsm_guard"();



CREATE OR REPLACE TRIGGER "srf_touch_updated_at" BEFORE UPDATE ON "public"."saved_reel_folders" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "time_entries_immutable_identity_check" BEFORE UPDATE ON "public"."time_entries" FOR EACH ROW EXECUTE FUNCTION "public"."time_entries_immutable_identity_trigger"();



CREATE OR REPLACE TRIGGER "time_entries_reject_stamp" BEFORE UPDATE ON "public"."time_entries" FOR EACH ROW EXECUTE FUNCTION "public"."time_entries_reject_stamp_trigger"();



CREATE OR REPLACE TRIGGER "time_entries_set_updated_at" BEFORE UPDATE ON "public"."time_entries" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_internal_message_last_message" AFTER INSERT ON "public"."internal_messages" FOR EACH ROW EXECUTE FUNCTION "public"."fn_update_thread_last_message"();



CREATE OR REPLACE TRIGGER "trg_profiles_privileged_columns_guard" BEFORE INSERT OR UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."_enforce_profile_privileged_columns"();



CREATE OR REPLACE TRIGGER "trg_sync_provider_media_cover" AFTER INSERT OR DELETE OR UPDATE ON "public"."provider_media_assets" FOR EACH ROW EXECUTE FUNCTION "public"."sync_provider_media_cover"();



CREATE OR REPLACE TRIGGER "user_notification_prefs_set_updated_at" BEFORE UPDATE ON "public"."user_notification_preferences" FOR EACH ROW EXECUTE FUNCTION "public"."fn_user_notification_prefs_set_updated_at"();



ALTER TABLE ONLY "public"."absences"
    ADD CONSTRAINT "absences_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "public"."team_members"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."absences"
    ADD CONSTRAINT "absences_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."acceptances"
    ADD CONSTRAINT "acceptances_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."acceptances"
    ADD CONSTRAINT "acceptances_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."acceptances"
    ADD CONSTRAINT "acceptances_source_offer_id_fkey" FOREIGN KEY ("source_offer_id") REFERENCES "public"."offers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."attribution_audit_log"
    ADD CONSTRAINT "attribution_audit_log_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."calendar_entries"
    ADD CONSTRAINT "calendar_entries_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."change_orders"
    ADD CONSTRAINT "change_orders_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."change_orders"
    ADD CONSTRAINT "change_orders_source_offer_id_fkey" FOREIGN KEY ("source_offer_id") REFERENCES "public"."offers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."chat_attachments"
    ADD CONSTRAINT "chat_attachments_message_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."chat_messages"
    ADD CONSTRAINT "chat_messages_reply_fk" FOREIGN KEY ("reply_to_message_id") REFERENCES "public"."chat_messages"("id");



ALTER TABLE ONLY "public"."chat_messages"
    ADD CONSTRAINT "chat_messages_thread_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."chat_participants"
    ADD CONSTRAINT "chat_participants_last_read_msg_fk" FOREIGN KEY ("last_read_message_id") REFERENCES "public"."chat_messages"("id");



ALTER TABLE ONLY "public"."chat_participants"
    ADD CONSTRAINT "chat_participants_last_visible_message_id_fkey" FOREIGN KEY ("last_visible_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."chat_participants"
    ADD CONSTRAINT "chat_participants_thread_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."chat_thread_migration_status"
    ADD CONSTRAINT "chat_thread_migration_status_thread_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."chat_threads"
    ADD CONSTRAINT "chat_threads_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id");



ALTER TABLE ONLY "public"."company_code_audit"
    ADD CONSTRAINT "company_code_audit_new_code_id_fkey" FOREIGN KEY ("new_code_id") REFERENCES "public"."company_join_codes"("id");



ALTER TABLE ONLY "public"."company_code_audit"
    ADD CONSTRAINT "company_code_audit_old_code_id_fkey" FOREIGN KEY ("old_code_id") REFERENCES "public"."company_join_codes"("id");



ALTER TABLE ONLY "public"."company_code_audit"
    ADD CONSTRAINT "company_code_audit_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."company_join_codes"
    ADD CONSTRAINT "company_join_codes_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."company_join_codes"
    ADD CONSTRAINT "company_join_codes_replaced_by_fkey" FOREIGN KEY ("replaced_by") REFERENCES "public"."company_join_codes"("id");



ALTER TABLE ONLY "public"."correction_requests"
    ADD CONSTRAINT "correction_requests_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."craftsman_subscriptions"
    ADD CONSTRAINT "craftsman_subscriptions_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."customer_billing_profiles"
    ADD CONSTRAINT "customer_billing_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."customer_provider_relationships"
    ADD CONSTRAINT "customer_provider_relationships_craftsman_user_id_fkey" FOREIGN KEY ("craftsman_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."customer_provider_relationships"
    ADD CONSTRAINT "customer_provider_relationships_customer_user_id_fkey" FOREIGN KEY ("customer_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."customer_request_sends"
    ADD CONSTRAINT "customer_request_sends_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dispute_evidence"
    ADD CONSTRAINT "dispute_evidence_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dispute_evidence"
    ADD CONSTRAINT "dispute_evidence_uploaded_by_profile_id_fkey" FOREIGN KEY ("uploaded_by_profile_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dispute_spatial_evidence"
    ADD CONSTRAINT "dispute_spatial_evidence_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dispute_spatial_evidence"
    ADD CONSTRAINT "dispute_spatial_evidence_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "public"."spatial_scenes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dispute_spatial_evidence"
    ADD CONSTRAINT "dispute_spatial_evidence_submitted_by_fkey" FOREIGN KEY ("submitted_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dispute_split_proposals"
    ADD CONSTRAINT "dispute_split_proposals_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dispute_status_history"
    ADD CONSTRAINT "dispute_status_history_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."disputes"
    ADD CONSTRAINT "disputes_customer_profile_id_fkey" FOREIGN KEY ("customer_profile_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."disputes"
    ADD CONSTRAINT "disputes_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."disputes"
    ADD CONSTRAINT "disputes_opened_by_profile_id_fkey" FOREIGN KEY ("opened_by_profile_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."disputes"
    ADD CONSTRAINT "disputes_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."disputes"
    ADD CONSTRAINT "disputes_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."disputes"
    ADD CONSTRAINT "disputes_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."download_jobs"
    ADD CONSTRAINT "download_jobs_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."download_jobs"
    ADD CONSTRAINT "download_jobs_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."escrow_payment_plans"
    ADD CONSTRAINT "escrow_payment_plans_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."escrow_payment_plans"
    ADD CONSTRAINT "escrow_payment_plans_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."escrow_payment_plans"
    ADD CONSTRAINT "escrow_payment_plans_source_offer_id_fkey" FOREIGN KEY ("source_offer_id") REFERENCES "public"."offers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."escrow_tranches"
    ADD CONSTRAINT "escrow_tranches_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."escrow_payment_plans"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."failed_join_attempts"
    ADD CONSTRAINT "failed_join_attempts_attempted_by_fkey" FOREIGN KEY ("attempted_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "fk_conversation" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."funding_requests"
    ADD CONSTRAINT "funding_requests_escrow_plan_id_fkey" FOREIGN KEY ("escrow_plan_id") REFERENCES "public"."escrow_payment_plans"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."funding_requests"
    ADD CONSTRAINT "funding_requests_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."funding_requests"
    ADD CONSTRAINT "funding_requests_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."funding_requests"
    ADD CONSTRAINT "funding_requests_source_offer_id_fkey" FOREIGN KEY ("source_offer_id") REFERENCES "public"."offers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."internal_messages"
    ADD CONSTRAINT "internal_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "public"."message_threads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_original_invoice_id_fkey" FOREIGN KEY ("original_invoice_id") REFERENCES "public"."invoices"("id");



ALTER TABLE ONLY "public"."job_assignments"
    ADD CONSTRAINT "job_assignments_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."job_assignments"
    ADD CONSTRAINT "job_assignments_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."job_assignments"
    ADD CONSTRAINT "job_assignments_team_member_id_fkey" FOREIGN KEY ("team_member_id") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."job_feedback"
    ADD CONSTRAINT "job_feedback_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."job_photos"
    ADD CONSTRAINT "job_photos_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."job_photos"
    ADD CONSTRAINT "job_photos_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."job_photos"
    ADD CONSTRAINT "job_photos_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."job_reports"
    ADD CONSTRAINT "job_reports_authored_by_fkey" FOREIGN KEY ("authored_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."job_reports"
    ADD CONSTRAINT "job_reports_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."job_reports"
    ADD CONSTRAINT "job_reports_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_assigned_provider_id_fkey" FOREIGN KEY ("assigned_provider_id") REFERENCES "public"."providers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_assigned_team_member_id_fkey" FOREIGN KEY ("assigned_team_member_id") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_customer_profile_id_fkey" FOREIGN KEY ("customer_profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_customer_user_id_fkey" FOREIGN KEY ("customer_user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_source_offer_id_fkey" FOREIGN KEY ("source_offer_id") REFERENCES "public"."offers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."media_artifacts"
    ADD CONSTRAINT "media_artifacts_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."message_thread_participants"
    ADD CONSTRAINT "message_thread_participants_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "public"."message_threads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."message_threads"
    ADD CONSTRAINT "message_threads_calendar_entry_id_fkey" FOREIGN KEY ("calendar_entry_id") REFERENCES "public"."calendar_entries"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."message_threads"
    ADD CONSTRAINT "message_threads_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."moderation_action_log"
    ADD CONSTRAINT "moderation_action_log_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."moderation_action_log"
    ADD CONSTRAINT "moderation_action_log_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "public"."user_reports"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."moderation_action_log"
    ADD CONSTRAINT "moderation_action_log_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."notification_signals"
    ADD CONSTRAINT "notification_signals_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."offers"
    ADD CONSTRAINT "offers_craftsman_user_id_fkey" FOREIGN KEY ("craftsman_user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."offers"
    ADD CONSTRAINT "offers_created_job_id_fkey" FOREIGN KEY ("created_job_id") REFERENCES "public"."jobs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."offers"
    ADD CONSTRAINT "offers_customer_user_id_fkey" FOREIGN KEY ("customer_user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."offers"
    ADD CONSTRAINT "offers_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id");



ALTER TABLE ONLY "public"."offers"
    ADD CONSTRAINT "offers_source_spatial_scene_id_fkey" FOREIGN KEY ("source_spatial_scene_id") REFERENCES "public"."spatial_scenes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."offers"
    ADD CONSTRAINT "offers_stale_source_scene_id_fkey" FOREIGN KEY ("stale_source_scene_id") REFERENCES "public"."spatial_scenes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."owner_notes"
    ADD CONSTRAINT "owner_notes_authored_by_fkey" FOREIGN KEY ("authored_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."owner_notes"
    ADD CONSTRAINT "owner_notes_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payment_status_history"
    ADD CONSTRAINT "payment_status_history_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_customer_profile_id_fkey" FOREIGN KEY ("customer_profile_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."provider_highlight_items"
    ADD CONSTRAINT "provider_highlight_items_highlight_id_fkey" FOREIGN KEY ("highlight_id") REFERENCES "public"."provider_highlights"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."provider_highlight_items"
    ADD CONSTRAINT "provider_highlight_items_portfolio_item_id_fkey" FOREIGN KEY ("portfolio_item_id") REFERENCES "public"."provider_media"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."provider_highlights"
    ADD CONSTRAINT "provider_highlights_cover_portfolio_item_id_fkey" FOREIGN KEY ("cover_portfolio_item_id") REFERENCES "public"."provider_media"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."provider_highlights"
    ADD CONSTRAINT "provider_highlights_provider_user_id_fkey" FOREIGN KEY ("provider_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."provider_media_assets"
    ADD CONSTRAINT "provider_media_assets_portfolio_item_id_fkey" FOREIGN KEY ("portfolio_item_id") REFERENCES "public"."provider_media"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."provider_media_assets"
    ADD CONSTRAINT "provider_media_assets_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id");



ALTER TABLE ONLY "public"."provider_media_comment_likes"
    ADD CONSTRAINT "provider_media_comment_likes_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "public"."provider_media_comments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."provider_media_comments"
    ADD CONSTRAINT "provider_media_comments_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "public"."provider_media"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."provider_media_comments"
    ADD CONSTRAINT "provider_media_comments_parent_comment_id_fkey" FOREIGN KEY ("parent_comment_id") REFERENCES "public"."provider_media_comments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."provider_media_comments"
    ADD CONSTRAINT "provider_media_comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."provider_media_likes"
    ADD CONSTRAINT "provider_media_likes_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "public"."provider_media"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."provider_media_likes"
    ADD CONSTRAINT "provider_media_likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."provider_media"
    ADD CONSTRAINT "provider_media_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."provider_media_saves"
    ADD CONSTRAINT "provider_media_saves_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "public"."saved_reel_folders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."provider_media_saves"
    ADD CONSTRAINT "provider_media_saves_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "public"."provider_media"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."provider_payout_accounts"
    ADD CONSTRAINT "provider_payout_accounts_provider_user_id_fkey" FOREIGN KEY ("provider_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."provider_presales_projects"
    ADD CONSTRAINT "provider_presales_projects_converted_to_job_id_fkey" FOREIGN KEY ("converted_to_job_id") REFERENCES "public"."jobs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."provider_presales_projects"
    ADD CONSTRAINT "provider_presales_projects_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."profiles"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."provider_presales_projects"
    ADD CONSTRAINT "provider_presales_projects_provider_org_id_fkey" FOREIGN KEY ("provider_org_id") REFERENCES "public"."providers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."providers"
    ADD CONSTRAINT "providers_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."push_action_audit"
    ADD CONSTRAINT "push_action_audit_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ratings"
    ADD CONSTRAINT "ratings_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."saved_reel_folders"
    ADD CONSTRAINT "saved_reel_folders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."scan_annotations"
    ADD CONSTRAINT "scan_annotations_photo_asset_id_fkey" FOREIGN KEY ("photo_asset_id") REFERENCES "public"."media_uploads"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."scan_annotations"
    ADD CONSTRAINT "scan_annotations_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."scan_assets"
    ADD CONSTRAINT "scan_assets_converted_from_fkey" FOREIGN KEY ("converted_from") REFERENCES "public"."scan_assets"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."scan_assets"
    ADD CONSTRAINT "scan_assets_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."scan_events"
    ADD CONSTRAINT "scan_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."scan_events"
    ADD CONSTRAINT "scan_events_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."scan_measurements"
    ADD CONSTRAINT "scan_measurements_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."scan_measurements"
    ADD CONSTRAINT "scan_measurements_surface_id_fkey" FOREIGN KEY ("surface_id") REFERENCES "public"."scan_surfaces"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."scan_measurements"
    ADD CONSTRAINT "scan_measurements_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."scan_quality_reports"
    ADD CONSTRAINT "scan_quality_reports_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."scan_rooms"
    ADD CONSTRAINT "scan_rooms_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."scan_status_transition_log"
    ADD CONSTRAINT "scan_status_transition_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."scan_status_transition_log"
    ADD CONSTRAINT "scan_status_transition_log_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."scan_surfaces"
    ADD CONSTRAINT "scan_surfaces_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "public"."scan_rooms"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."scans"
    ADD CONSTRAINT "scans_captured_by_fkey" FOREIGN KEY ("captured_by") REFERENCES "public"."profiles"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."scans"
    ADD CONSTRAINT "scans_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."scans"
    ADD CONSTRAINT "scans_parent_scan_id_fkey" FOREIGN KEY ("parent_scan_id") REFERENCES "public"."scans"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."scans"
    ADD CONSTRAINT "scans_presales_project_id_fkey" FOREIGN KEY ("presales_project_id") REFERENCES "public"."provider_presales_projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."scans"
    ADD CONSTRAINT "scans_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."scans"
    ADD CONSTRAINT "scans_shared_with_provider_fk" FOREIGN KEY ("shared_with_provider_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."schedules"
    ADD CONSTRAINT "schedules_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."spatial_change_orders"
    ADD CONSTRAINT "spatial_change_orders_proposer_id_fkey" FOREIGN KEY ("proposer_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."spatial_change_orders"
    ADD CONSTRAINT "spatial_change_orders_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "public"."spatial_scenes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."spatial_edit_history"
    ADD CONSTRAINT "spatial_edit_history_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."spatial_edit_history"
    ADD CONSTRAINT "spatial_edit_history_provider_org_id_fkey" FOREIGN KEY ("provider_org_id") REFERENCES "public"."providers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."spatial_edit_history"
    ADD CONSTRAINT "spatial_edit_history_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "public"."spatial_scenes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."spatial_node_links"
    ADD CONSTRAINT "spatial_node_links_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."spatial_node_links"
    ADD CONSTRAINT "spatial_node_links_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "public"."spatial_scenes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."spatial_node_overrides"
    ADD CONSTRAINT "spatial_node_overrides_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."spatial_node_overrides"
    ADD CONSTRAINT "spatial_node_overrides_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "public"."spatial_scenes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."spatial_pin_reviews"
    ADD CONSTRAINT "spatial_pin_reviews_provider_org_id_fkey" FOREIGN KEY ("provider_org_id") REFERENCES "public"."providers"("id");



ALTER TABLE ONLY "public"."spatial_pin_reviews"
    ADD CONSTRAINT "spatial_pin_reviews_reviewed_by_user_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."spatial_pin_reviews"
    ADD CONSTRAINT "spatial_pin_reviews_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "public"."spatial_scenes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."spatial_rescan_requests"
    ADD CONSTRAINT "spatial_rescan_requests_provider_org_id_fkey" FOREIGN KEY ("provider_org_id") REFERENCES "public"."providers"("id");



ALTER TABLE ONLY "public"."spatial_rescan_requests"
    ADD CONSTRAINT "spatial_rescan_requests_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."spatial_rescan_requests"
    ADD CONSTRAINT "spatial_rescan_requests_resulting_scene_id_fkey" FOREIGN KEY ("resulting_scene_id") REFERENCES "public"."spatial_scenes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."spatial_rescan_requests"
    ADD CONSTRAINT "spatial_rescan_requests_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "public"."spatial_scenes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."spatial_scenes"
    ADD CONSTRAINT "spatial_scenes_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."spatial_scenes"
    ADD CONSTRAINT "spatial_scenes_parent_scene_id_fkey" FOREIGN KEY ("parent_scene_id") REFERENCES "public"."spatial_scenes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."spatial_scenes"
    ADD CONSTRAINT "spatial_scenes_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."spatial_scenes"
    ADD CONSTRAINT "spatial_scenes_provider_org_id_fkey" FOREIGN KEY ("provider_org_id") REFERENCES "public"."providers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."spatial_scenes"
    ADD CONSTRAINT "spatial_scenes_source_job_id_fkey" FOREIGN KEY ("source_job_id") REFERENCES "public"."jobs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."spatial_scenes"
    ADD CONSTRAINT "spatial_scenes_source_scan_id_fkey" FOREIGN KEY ("source_scan_id") REFERENCES "public"."scans"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."spatial_share_audit"
    ADD CONSTRAINT "spatial_share_audit_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."spatial_share_audit"
    ADD CONSTRAINT "spatial_share_audit_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."spatial_share_audit"
    ADD CONSTRAINT "spatial_share_audit_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."subscription_withdrawal_consents"
    ADD CONSTRAINT "subscription_withdrawal_consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."supplementary_payment_requests"
    ADD CONSTRAINT "supplementary_payment_requests_change_order_id_fkey" FOREIGN KEY ("change_order_id") REFERENCES "public"."change_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."team_member_audit"
    ADD CONSTRAINT "team_member_audit_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "public"."team_members"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."team_member_audit"
    ADD CONSTRAINT "team_member_audit_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."team_members"
    ADD CONSTRAINT "team_members_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."team_members"
    ADD CONSTRAINT "team_members_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."thread_artifacts"
    ADD CONSTRAINT "thread_artifacts_change_order_id_fkey" FOREIGN KEY ("change_order_id") REFERENCES "public"."change_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."thread_artifacts"
    ADD CONSTRAINT "thread_artifacts_escrow_plan_id_fkey" FOREIGN KEY ("escrow_plan_id") REFERENCES "public"."escrow_payment_plans"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."thread_artifacts"
    ADD CONSTRAINT "thread_artifacts_funding_request_id_fkey" FOREIGN KEY ("funding_request_id") REFERENCES "public"."funding_requests"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "time_entries_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "time_entries_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "public"."team_members"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "time_entries_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "time_entries_rejected_by_fkey" FOREIGN KEY ("rejected_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."timeline_signals"
    ADD CONSTRAINT "timeline_signals_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_blocks"
    ADD CONSTRAINT "user_blocks_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_blocks"
    ADD CONSTRAINT "user_blocks_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_notification_preferences"
    ADD CONSTRAINT "user_notification_preferences_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_reports"
    ADD CONSTRAINT "user_reports_reported_id_fkey" FOREIGN KEY ("reported_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_reports"
    ADD CONSTRAINT "user_reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_reports"
    ADD CONSTRAINT "user_reports_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."widerruf_requests"
    ADD CONSTRAINT "widerruf_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



CREATE POLICY "Authenticated users can read dispute evidence" ON "public"."dispute_evidence" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can read payment status history" ON "public"."payment_status_history" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can read stripe events" ON "public"."stripe_events" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Job assignments: insert own provider" ON "public"."job_assignments" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "job_assignments"."provider_id") AND ("p"."profile_id" = "auth"."uid"())))));



CREATE POLICY "Job assignments: read own provider" ON "public"."job_assignments" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "job_assignments"."provider_id") AND ("p"."profile_id" = "auth"."uid"())))));



CREATE POLICY "Job assignments: update own provider" ON "public"."job_assignments" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "job_assignments"."provider_id") AND ("p"."profile_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "job_assignments"."provider_id") AND ("p"."profile_id" = "auth"."uid"())))));



CREATE POLICY "Jobs: insert own customer" ON "public"."jobs" FOR INSERT TO "authenticated" WITH CHECK (("customer_user_id" = "auth"."uid"()));



CREATE POLICY "Jobs: read own customer or provider" ON "public"."jobs" FOR SELECT TO "authenticated" USING ((("customer_user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "jobs"."provider_id") AND ("p"."profile_id" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "jobs"."assigned_provider_id") AND ("p"."profile_id" = "auth"."uid"()))))));



CREATE POLICY "Jobs: read own team member" ON "public"."jobs" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."team_members" "tm"
  WHERE (("tm"."provider_id" = "jobs"."provider_id") AND ("tm"."profile_id" = "auth"."uid"()) AND ("tm"."is_active" = true)))));



CREATE POLICY "Jobs: update own customer or provider" ON "public"."jobs" FOR UPDATE TO "authenticated" USING ((("customer_user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "jobs"."provider_id") AND ("p"."profile_id" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "jobs"."assigned_provider_id") AND ("p"."profile_id" = "auth"."uid"())))))) WITH CHECK ((("customer_user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "jobs"."provider_id") AND ("p"."profile_id" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "jobs"."assigned_provider_id") AND ("p"."profile_id" = "auth"."uid"()))))));



CREATE POLICY "Ledger: read own payment/job/dispute" ON "public"."ledger_entries" FOR SELECT TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM "public"."payments" "p"
  WHERE (("p"."id" = "ledger_entries"."payment_id") AND (("p"."customer_profile_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
           FROM "public"."providers" "pr"
          WHERE (("pr"."id" = "p"."provider_id") AND ("pr"."profile_id" = "auth"."uid"())))))))) OR (EXISTS ( SELECT 1
   FROM "public"."jobs" "j"
  WHERE (("j"."id" = "ledger_entries"."job_id") AND (("j"."customer_profile_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
           FROM "public"."providers" "pr"
          WHERE (("pr"."id" = "j"."provider_id") AND ("pr"."profile_id" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
           FROM "public"."providers" "pr"
          WHERE (("pr"."id" = "j"."assigned_provider_id") AND ("pr"."profile_id" = "auth"."uid"())))))))) OR (EXISTS ( SELECT 1
   FROM "public"."disputes" "d"
  WHERE (("d"."id" = "ledger_entries"."dispute_id") AND (("d"."opened_by_profile_id" = "auth"."uid"()) OR ("d"."customer_profile_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
           FROM "public"."providers" "pr"
          WHERE (("pr"."id" = "d"."provider_id") AND ("pr"."profile_id" = "auth"."uid"()))))))))));



CREATE POLICY "Operators can insert own audit entries" ON "public"."operator_action_audit" FOR INSERT WITH CHECK (("operator_id" = "auth"."uid"()));



CREATE POLICY "Operators can read analytics events" ON "public"."analytics_events" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."is_operator" = true)))));



CREATE POLICY "Payments: insert own customer or provider" ON "public"."payments" FOR INSERT TO "authenticated" WITH CHECK ((("customer_profile_id" = "auth"."uid"()) OR ("customer_user_id" = "auth"."uid"()) OR ("craftsman_user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "payments"."provider_id") AND ("p"."profile_id" = "auth"."uid"()))))));



CREATE POLICY "Payments: read own customer or provider" ON "public"."payments" FOR SELECT TO "authenticated" USING ((("customer_profile_id" = "auth"."uid"()) OR ("customer_user_id" = "auth"."uid"()) OR ("craftsman_user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "payments"."provider_id") AND ("p"."profile_id" = "auth"."uid"()))))));



CREATE POLICY "Payments: update own customer or provider" ON "public"."payments" FOR UPDATE TO "authenticated" USING ((("customer_profile_id" = "auth"."uid"()) OR ("customer_user_id" = "auth"."uid"()) OR ("craftsman_user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "payments"."provider_id") AND ("p"."profile_id" = "auth"."uid"())))))) WITH CHECK ((("customer_profile_id" = "auth"."uid"()) OR ("customer_user_id" = "auth"."uid"()) OR ("craftsman_user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "payments"."provider_id") AND ("p"."profile_id" = "auth"."uid"()))))));



CREATE POLICY "Profiles: read own" ON "public"."profiles" FOR SELECT TO "authenticated" USING (("id" = "auth"."uid"()));



CREATE POLICY "Profiles: update own" ON "public"."profiles" FOR UPDATE TO "authenticated" USING (("id" = "auth"."uid"())) WITH CHECK (("id" = "auth"."uid"()));



CREATE POLICY "Projects: insert own" ON "public"."projects" FOR INSERT WITH CHECK ((("craftsman_user_id" = "auth"."uid"()) OR ("customer_profile_id" = "auth"."uid"())));



CREATE POLICY "Projects: read own" ON "public"."projects" FOR SELECT USING ((("craftsman_user_id" = "auth"."uid"()) OR ("customer_profile_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM ("public"."jobs" "j"
     LEFT JOIN "public"."providers" "pr" ON (("pr"."id" = "j"."provider_id")))
  WHERE (("j"."id" = "projects"."source_job_id") AND (("j"."customer_user_id" = "auth"."uid"()) OR ("pr"."profile_id" = "auth"."uid"())))))));



CREATE POLICY "Projects: update own" ON "public"."projects" FOR UPDATE USING ((("craftsman_user_id" = "auth"."uid"()) OR ("customer_profile_id" = "auth"."uid"()))) WITH CHECK ((("craftsman_user_id" = "auth"."uid"()) OR ("customer_profile_id" = "auth"."uid"())));



CREATE POLICY "Provider media: insert own provider" ON "public"."provider_media" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "provider_media"."provider_id") AND ("p"."profile_id" = "auth"."uid"())))));



CREATE POLICY "Provider media: update own provider" ON "public"."provider_media" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "provider_media"."provider_id") AND ("p"."profile_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "provider_media"."provider_id") AND ("p"."profile_id" = "auth"."uid"())))));



CREATE POLICY "Providers: insert own" ON "public"."providers" FOR INSERT TO "authenticated" WITH CHECK (("profile_id" = "auth"."uid"()));



CREATE POLICY "Providers: read own" ON "public"."providers" FOR SELECT TO "authenticated" USING (("profile_id" = "auth"."uid"()));



CREATE POLICY "Providers: update own" ON "public"."providers" FOR UPDATE TO "authenticated" USING (("profile_id" = "auth"."uid"())) WITH CHECK (("profile_id" = "auth"."uid"()));



CREATE POLICY "Public can read onboarded profiles" ON "public"."profiles" FOR SELECT USING (("onboarding_done" = true));



CREATE POLICY "Public can read provider media" ON "public"."provider_media" FOR SELECT USING ("public"."provider_is_public"("provider_id"));



CREATE POLICY "Team members: insert own provider" ON "public"."team_members" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "team_members"."provider_id") AND ("p"."profile_id" = "auth"."uid"())))));



CREATE POLICY "Team members: read own profile_id" ON "public"."team_members" FOR SELECT TO "authenticated" USING (("profile_id" = "auth"."uid"()));



CREATE POLICY "Team members: read own provider" ON "public"."team_members" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "team_members"."provider_id") AND ("p"."profile_id" = "auth"."uid"())))));



CREATE POLICY "Team members: update own provider" ON "public"."team_members" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "team_members"."provider_id") AND ("p"."profile_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "team_members"."provider_id") AND ("p"."profile_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert own profile" ON "public"."profiles" FOR INSERT WITH CHECK (("auth"."uid"() = "id"));



CREATE POLICY "Users can read own profile" ON "public"."profiles" FOR SELECT USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can update own profile" ON "public"."profiles" FOR UPDATE USING (("auth"."uid"() = "id"));



ALTER TABLE "public"."absences" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "absences_owner_select" ON "public"."absences" FOR SELECT TO "authenticated" USING (("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"()))));



CREATE POLICY "absences_owner_update" ON "public"."absences" FOR UPDATE TO "authenticated" USING (("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"())))) WITH CHECK (("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"()))));



CREATE POLICY "absences_worker_cancel" ON "public"."absences" FOR UPDATE TO "authenticated" USING ((("status" = 'active'::"public"."absence_status") AND ("member_id" IN ( SELECT "team_members"."id"
   FROM "public"."team_members"
  WHERE ("team_members"."profile_id" = "auth"."uid"()))))) WITH CHECK ((("status" = 'cancelled'::"public"."absence_status") AND ("member_id" IN ( SELECT "team_members"."id"
   FROM "public"."team_members"
  WHERE ("team_members"."profile_id" = "auth"."uid"())))));



CREATE POLICY "absences_worker_insert" ON "public"."absences" FOR INSERT TO "authenticated" WITH CHECK ((("status" = 'active'::"public"."absence_status") AND (EXISTS ( SELECT 1
   FROM "public"."team_members" "tm"
  WHERE (("tm"."id" = "absences"."member_id") AND ("tm"."provider_id" = "absences"."provider_id") AND ("tm"."profile_id" = "auth"."uid"()) AND ("tm"."is_active" = true))))));



CREATE POLICY "absences_worker_select" ON "public"."absences" FOR SELECT TO "authenticated" USING (("member_id" IN ( SELECT "team_members"."id"
   FROM "public"."team_members"
  WHERE (("team_members"."profile_id" = "auth"."uid"()) AND ("team_members"."is_active" = true)))));



CREATE POLICY "absences_worker_sick_note_update" ON "public"."absences" FOR UPDATE TO "authenticated" USING ((("status" = 'active'::"public"."absence_status") AND ("member_id" IN ( SELECT "team_members"."id"
   FROM "public"."team_members"
  WHERE (("team_members"."profile_id" = "auth"."uid"()) AND ("team_members"."is_active" = true)))))) WITH CHECK ((("status" = 'active'::"public"."absence_status") AND ("member_id" IN ( SELECT "team_members"."id"
   FROM "public"."team_members"
  WHERE (("team_members"."profile_id" = "auth"."uid"()) AND ("team_members"."is_active" = true))))));



ALTER TABLE "public"."acceptances" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "acceptances_craftsman_read" ON "public"."acceptances" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."jobs" "j"
  WHERE (("j"."id" = "acceptances"."job_id") AND (("j"."craftsman_user_id")::"uuid" = "auth"."uid"())))));



CREATE POLICY "acceptances_customer_insert" ON "public"."acceptances" FOR INSERT WITH CHECK (("customer_user_id" = "auth"."uid"()));



CREATE POLICY "acceptances_customer_read" ON "public"."acceptances" FOR SELECT USING (("customer_user_id" = "auth"."uid"()));



CREATE POLICY "acceptances_customer_update" ON "public"."acceptances" FOR UPDATE USING (("customer_user_id" = "auth"."uid"()));



CREATE POLICY "acceptances_service_all" ON "public"."acceptances" USING (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."account_deletion_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."analytics_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "analytics_events_insert_self" ON "public"."analytics_events" FOR INSERT TO "authenticated" WITH CHECK ((("actor_user_id" = "auth"."uid"()) OR ("actor_user_id" IS NULL)));



ALTER TABLE "public"."attribution_audit_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "attribution_audit_log_operator_read" ON "public"."attribution_audit_log" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."is_operator" IS TRUE)))));



CREATE POLICY "authenticated_can_read_ratings" ON "public"."ratings" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "authenticated_insert_relationships" ON "public"."customer_provider_relationships" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "blocked_users_read_block_record" ON "public"."user_blocks" FOR SELECT USING (("auth"."uid"() = "blocked_id"));



ALTER TABLE "public"."calendar_entries" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "calendar_entries_owner_insert" ON "public"."calendar_entries" FOR INSERT WITH CHECK (((("provider_id" IS NOT NULL) AND ("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"())))) OR (("provider_id" IS NULL) AND ("job_id" IN ( SELECT "jobs"."id"
   FROM "public"."jobs"
  WHERE ("jobs"."craftsman_user_id" = ("auth"."uid"())::"text"))))));



CREATE POLICY "calendar_entries_owner_select" ON "public"."calendar_entries" FOR SELECT USING (((("provider_id" IS NOT NULL) AND ("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"())))) OR (("provider_id" IS NULL) AND ("job_id" IN ( SELECT "jobs"."id"
   FROM "public"."jobs"
  WHERE ("jobs"."craftsman_user_id" = ("auth"."uid"())::"text"))))));



CREATE POLICY "calendar_entries_owner_update" ON "public"."calendar_entries" FOR UPDATE USING (((("provider_id" IS NOT NULL) AND ("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"())))) OR (("provider_id" IS NULL) AND ("job_id" IN ( SELECT "jobs"."id"
   FROM "public"."jobs"
  WHERE ("jobs"."craftsman_user_id" = ("auth"."uid"())::"text")))))) WITH CHECK (((("provider_id" IS NOT NULL) AND ("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"())))) OR (("provider_id" IS NULL) AND ("job_id" IN ( SELECT "jobs"."id"
   FROM "public"."jobs"
  WHERE ("jobs"."craftsman_user_id" = ("auth"."uid"())::"text"))))));



CREATE POLICY "calendar_entries_worker_select" ON "public"."calendar_entries" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."team_members" "tm"
  WHERE (("tm"."profile_id" = "auth"."uid"()) AND ("tm"."provider_id" = "calendar_entries"."provider_id") AND ("calendar_entries"."assigned_member_ids" @> ARRAY[("tm"."id")::"text"])))));



CREATE POLICY "calendar_entries_worker_update" ON "public"."calendar_entries" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."team_members" "tm"
  WHERE (("tm"."profile_id" = "auth"."uid"()) AND ("tm"."provider_id" = "calendar_entries"."provider_id") AND ("calendar_entries"."assigned_member_ids" @> ARRAY[("tm"."id")::"text"])))));



ALTER TABLE "public"."change_orders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "change_orders_craftsman_insert" ON "public"."change_orders" FOR INSERT WITH CHECK (("craftsman_user_id" = "auth"."uid"()));



CREATE POLICY "change_orders_craftsman_read" ON "public"."change_orders" FOR SELECT USING (("craftsman_user_id" = "auth"."uid"()));



CREATE POLICY "change_orders_craftsman_update" ON "public"."change_orders" FOR UPDATE USING (("craftsman_user_id" = "auth"."uid"()));



CREATE POLICY "change_orders_customer_read" ON "public"."change_orders" FOR SELECT USING (("customer_user_id" = "auth"."uid"()));



CREATE POLICY "change_orders_customer_update" ON "public"."change_orders" FOR UPDATE USING (("customer_user_id" = "auth"."uid"()));



CREATE POLICY "change_orders_service_all" ON "public"."change_orders" USING (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."chat_attachments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "chat_attachments_insert_sender" ON "public"."chat_attachments" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM (("public"."chat_messages" "cm"
     JOIN "public"."chat_participants" "cp" ON (("cp"."thread_id" = "cm"."thread_id")))
     JOIN "public"."chat_threads" "ct" ON (("ct"."id" = "cm"."thread_id")))
  WHERE (("cm"."id" = "chat_attachments"."message_id") AND ("cm"."sender_user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("cp"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("cp"."left_at" IS NULL) AND (NOT (("ct"."channel_type" = 'customer'::"text") AND ("cp"."role" = 'worker'::"text")))))));



CREATE POLICY "chat_attachments_select_participant" ON "public"."chat_attachments" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM (("public"."chat_messages" "cm"
     JOIN "public"."chat_participants" "cp" ON (("cp"."thread_id" = "cm"."thread_id")))
     JOIN "public"."chat_threads" "ct" ON (("ct"."id" = "cm"."thread_id")))
  WHERE (("cm"."id" = "chat_attachments"."message_id") AND ("cp"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("cp"."left_at" IS NULL) AND (NOT (("ct"."channel_type" = 'customer'::"text") AND ("cp"."role" = 'worker'::"text")))))));



ALTER TABLE "public"."chat_messages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "chat_messages_insert_participant" ON "public"."chat_messages" FOR INSERT TO "authenticated" WITH CHECK ((("sender_user_id" = ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
   FROM ("public"."chat_participants" "cp"
     JOIN "public"."chat_threads" "ct" ON (("ct"."id" = "cp"."thread_id")))
  WHERE (("cp"."thread_id" = "chat_messages"."thread_id") AND ("cp"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("cp"."left_at" IS NULL) AND (NOT (("ct"."channel_type" = 'customer'::"text") AND ("cp"."role" = 'worker'::"text")))))) AND "public"."is_caller_moderation_write_allowed"()));



CREATE POLICY "chat_messages_select_participant" ON "public"."chat_messages" FOR SELECT TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM ("public"."chat_participants" "cp"
     JOIN "public"."chat_threads" "ct" ON (("ct"."id" = "cp"."thread_id")))
  WHERE (("cp"."thread_id" = "chat_messages"."thread_id") AND ("cp"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("cp"."left_at" IS NULL) AND (NOT (("ct"."channel_type" = 'customer'::"text") AND ("cp"."role" = 'worker'::"text")))))) AND (NOT "public"."is_blocked_by_me"("sender_user_id"))));



CREATE POLICY "chat_messages_update_own" ON "public"."chat_messages" FOR UPDATE TO "authenticated" USING (("sender_user_id" = ( SELECT "auth"."uid"() AS "uid"))) WITH CHECK (("sender_user_id" = ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."chat_participants" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "chat_participants_insert_owner_or_self" ON "public"."chat_participants" FOR INSERT TO "authenticated" WITH CHECK (("public"."chat_user_is_thread_admin"("thread_id", ( SELECT "auth"."uid"() AS "uid"), true) OR (("user_id" = ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
   FROM "public"."chat_threads" "ct"
  WHERE (("ct"."id" = "chat_participants"."thread_id") AND ("ct"."channel_type" = ANY (ARRAY['assignment'::"text", 'team'::"text"]))))))));



CREATE POLICY "chat_participants_select_self_or_owner" ON "public"."chat_participants" FOR SELECT TO "authenticated" USING ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) OR "public"."chat_user_is_thread_admin"("thread_id", ( SELECT "auth"."uid"() AS "uid"), false)));



CREATE POLICY "chat_participants_update_own" ON "public"."chat_participants" FOR UPDATE TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid"))) WITH CHECK (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."chat_thread_migration_status" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "chat_thread_migration_status_select_diagnostic" ON "public"."chat_thread_migration_status" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."chat_participants" "cp"
  WHERE (("cp"."thread_id" = "chat_thread_migration_status"."thread_id") AND ("cp"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("cp"."left_at" IS NULL)))));



ALTER TABLE "public"."chat_threads" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "chat_threads_insert_customer" ON "public"."chat_threads" FOR INSERT TO "authenticated" WITH CHECK ((("channel_type" = 'customer'::"text") AND ("customer_user_id" = ( SELECT "auth"."uid"() AS "uid"))));



CREATE POLICY "chat_threads_insert_provider" ON "public"."chat_threads" FOR INSERT TO "authenticated" WITH CHECK ((("channel_type" <> 'customer'::"text") AND ("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "chat_threads_select_participant" ON "public"."chat_threads" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."chat_participants" "cp"
  WHERE (("cp"."thread_id" = "chat_threads"."id") AND ("cp"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("cp"."left_at" IS NULL)))));



CREATE POLICY "chat_threads_update_participant" ON "public"."chat_threads" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."chat_participants" "cp"
  WHERE (("cp"."thread_id" = "chat_threads"."id") AND ("cp"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("cp"."left_at" IS NULL))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."chat_participants" "cp"
  WHERE (("cp"."thread_id" = "chat_threads"."id") AND ("cp"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("cp"."left_at" IS NULL)))));



ALTER TABLE "public"."company_code_audit" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "company_code_audit_select_owner" ON "public"."company_code_audit" FOR SELECT TO "authenticated" USING (("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"()))));



ALTER TABLE "public"."company_join_codes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."conversations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "conversations_insert_own" ON "public"."conversations" FOR INSERT TO "authenticated" WITH CHECK (("customer_user_id" = "auth"."uid"()));



CREATE POLICY "conversations_select_own" ON "public"."conversations" FOR SELECT TO "authenticated" USING ((("craftsman_user_id" = "auth"."uid"()) OR ("customer_user_id" = "auth"."uid"())));



CREATE POLICY "conversations_update_own" ON "public"."conversations" FOR UPDATE TO "authenticated" USING ((("craftsman_user_id" = "auth"."uid"()) OR ("customer_user_id" = "auth"."uid"()))) WITH CHECK ((("craftsman_user_id" = "auth"."uid"()) OR ("customer_user_id" = "auth"."uid"())));



ALTER TABLE "public"."correction_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "correction_requests_owner_select" ON "public"."correction_requests" FOR SELECT TO "authenticated" USING (("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"()))));



CREATE POLICY "correction_requests_owner_update" ON "public"."correction_requests" FOR UPDATE TO "authenticated" USING (("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"())))) WITH CHECK (("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"()))));



CREATE POLICY "correction_requests_worker_insert" ON "public"."correction_requests" FOR INSERT TO "authenticated" WITH CHECK (("worker_profile_id" = "auth"."uid"()));



CREATE POLICY "correction_requests_worker_select" ON "public"."correction_requests" FOR SELECT TO "authenticated" USING (("worker_profile_id" = "auth"."uid"()));



ALTER TABLE "public"."craftsman_profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "craftsman_profiles_delete_own" ON "public"."craftsman_profiles" FOR DELETE USING (("user_id" = ("auth"."uid"())::"text"));



CREATE POLICY "craftsman_profiles_insert_own" ON "public"."craftsman_profiles" FOR INSERT WITH CHECK (("user_id" = ("auth"."uid"())::"text"));



CREATE POLICY "craftsman_profiles_select_authenticated" ON "public"."craftsman_profiles" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "craftsman_profiles_update_own" ON "public"."craftsman_profiles" FOR UPDATE USING (("user_id" = ("auth"."uid"())::"text"));



CREATE POLICY "craftsman_read_own_relationships" ON "public"."customer_provider_relationships" FOR SELECT USING (("craftsman_user_id" = "auth"."uid"()));



ALTER TABLE "public"."craftsman_subscriptions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "craftsman_subscriptions_select_own" ON "public"."craftsman_subscriptions" FOR SELECT USING (("profile_id" = "auth"."uid"()));



ALTER TABLE "public"."customer_billing_profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "customer_billing_profiles_insert_own" ON "public"."customer_billing_profiles" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "customer_billing_profiles_select_own" ON "public"."customer_billing_profiles" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "customer_billing_profiles_update_own" ON "public"."customer_billing_profiles" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."customer_provider_relationships" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "customer_read_own_relationships" ON "public"."customer_provider_relationships" FOR SELECT USING (("customer_user_id" = "auth"."uid"()));



ALTER TABLE "public"."customer_request_sends" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "customer_request_sends_insert_own" ON "public"."customer_request_sends" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "customer_request_sends_select_own" ON "public"."customer_request_sends" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "customers_can_insert_own_ratings" ON "public"."ratings" FOR INSERT WITH CHECK (("customer_user_id" = "auth"."uid"()));



ALTER TABLE "public"."dispute_evidence" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dispute_evidence_insert_self" ON "public"."dispute_evidence" FOR INSERT TO "authenticated" WITH CHECK (("uploaded_by_profile_id" = "auth"."uid"()));



CREATE POLICY "dispute_history_insert_client_own_side" ON "public"."dispute_status_history" FOR INSERT TO "authenticated" WITH CHECK ((("source" = 'client'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."disputes" "d"
  WHERE (("d"."id" = "dispute_status_history"."dispute_id") AND (("d"."opened_by_profile_id" = "auth"."uid"()) OR ("d"."customer_profile_id" = "auth"."uid"()) OR ("d"."provider_id" IN ( SELECT "providers"."id"
           FROM "public"."providers"
          WHERE ("providers"."profile_id" = "auth"."uid"())))))))));



CREATE POLICY "dispute_history_select_own_side" ON "public"."dispute_status_history" FOR SELECT TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM "public"."disputes" "d"
  WHERE (("d"."id" = "dispute_status_history"."dispute_id") AND (("d"."opened_by_profile_id" = "auth"."uid"()) OR ("d"."customer_profile_id" = "auth"."uid"()) OR ("d"."provider_id" IN ( SELECT "providers"."id"
           FROM "public"."providers"
          WHERE ("providers"."profile_id" = "auth"."uid"()))))))) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."is_operator" = true))))));



ALTER TABLE "public"."dispute_spatial_evidence" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dispute_spatial_evidence_insert_deny" ON "public"."dispute_spatial_evidence" FOR INSERT TO "authenticated" WITH CHECK (false);



CREATE POLICY "dispute_spatial_evidence_select" ON "public"."dispute_spatial_evidence" FOR SELECT TO "authenticated" USING ("public"."spatial_can_view_scene"("scene_id", ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "dispute_spatial_evidence_service_role_all" ON "public"."dispute_spatial_evidence" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."dispute_split_proposals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dispute_status_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."disputes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "disputes_insert_own_side" ON "public"."disputes" FOR INSERT TO "authenticated" WITH CHECK ((("opened_by_profile_id" = "auth"."uid"()) AND ("job_id" IN ( SELECT "j"."id"
   FROM "public"."jobs" "j"
  WHERE (("j"."customer_user_id" = "auth"."uid"()) OR ("j"."customer_profile_id" = "auth"."uid"()) OR ("j"."craftsman_user_id" = ("auth"."uid"())::"text") OR ("j"."provider_id" IN ( SELECT "pr"."id"
           FROM "public"."providers" "pr"
          WHERE ("pr"."profile_id" = "auth"."uid"()))))))));



CREATE POLICY "disputes_select_own_side" ON "public"."disputes" FOR SELECT USING ((("opened_by_profile_id" = "auth"."uid"()) OR ("customer_profile_id" = "auth"."uid"()) OR ("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"()))) OR ("provider_id" IN ( SELECT "tm"."provider_id"
   FROM "public"."team_members" "tm"
  WHERE (("tm"."profile_id" = "auth"."uid"()) AND ("tm"."is_active" = true)))) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."is_operator" = true))))));



CREATE POLICY "disputes_update_own_side" ON "public"."disputes" FOR UPDATE USING ((("opened_by_profile_id" = "auth"."uid"()) OR ("customer_profile_id" = "auth"."uid"()) OR ("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"()))) OR ("provider_id" IN ( SELECT "tm"."provider_id"
   FROM "public"."team_members" "tm"
  WHERE (("tm"."profile_id" = "auth"."uid"()) AND ("tm"."is_active" = true)))) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."is_operator" = true)))))) WITH CHECK ((("opened_by_profile_id" = "auth"."uid"()) OR ("customer_profile_id" = "auth"."uid"()) OR ("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"()))) OR ("provider_id" IN ( SELECT "tm"."provider_id"
   FROM "public"."team_members" "tm"
  WHERE (("tm"."profile_id" = "auth"."uid"()) AND ("tm"."is_active" = true)))) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."is_operator" = true))))));



ALTER TABLE "public"."download_jobs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "download_jobs_view" ON "public"."download_jobs" FOR SELECT TO "authenticated" USING ((("requested_by" = "auth"."uid"()) OR "public"."spatial_can_view_scan"("scan_id", "auth"."uid"())));



CREATE POLICY "dsp_select_own" ON "public"."dispute_split_proposals" FOR SELECT TO "authenticated" USING ((("proposed_by" = "auth"."uid"()) OR (("confirmed_by" IS NOT NULL) AND ("confirmed_by" = "auth"."uid"())) OR (EXISTS ( SELECT 1
   FROM "public"."disputes" "d"
  WHERE (("d"."id" = "dispute_split_proposals"."dispute_id") AND ("d"."customer_profile_id" IS NOT NULL) AND ("d"."customer_profile_id" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
   FROM ("public"."disputes" "d"
     JOIN "public"."providers" "pr" ON (("pr"."id" = "d"."provider_id")))
  WHERE (("d"."id" = "dispute_split_proposals"."dispute_id") AND ("pr"."profile_id" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
   FROM "public"."disputes" "d"
  WHERE (("d"."id" = "dispute_split_proposals"."dispute_id") AND ("d"."opened_by_profile_id" IS NOT NULL) AND ("d"."opened_by_profile_id" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."is_operator" = true))))));



ALTER TABLE "public"."email_delivery_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."escrow_payment_plans" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "escrow_plans_customer_insert" ON "public"."escrow_payment_plans" FOR INSERT WITH CHECK (("auth"."uid"() = "customer_user_id"));



CREATE POLICY "escrow_plans_customer_read" ON "public"."escrow_payment_plans" FOR SELECT USING (("auth"."uid"() = "customer_user_id"));



CREATE POLICY "escrow_plans_customer_update" ON "public"."escrow_payment_plans" FOR UPDATE USING (("auth"."uid"() = "customer_user_id")) WITH CHECK (("auth"."uid"() = "customer_user_id"));



CREATE POLICY "escrow_plans_provider_read" ON "public"."escrow_payment_plans" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."providers"
  WHERE (("providers"."id" = "escrow_payment_plans"."provider_id") AND ("providers"."profile_id" = "auth"."uid"())))));



CREATE POLICY "escrow_plans_service_all" ON "public"."escrow_payment_plans" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."escrow_tranches" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "escrow_tranches_customer_insert" ON "public"."escrow_tranches" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."escrow_payment_plans"
  WHERE (("escrow_payment_plans"."id" = "escrow_tranches"."plan_id") AND ("escrow_payment_plans"."customer_user_id" = "auth"."uid"())))));



CREATE POLICY "escrow_tranches_customer_read" ON "public"."escrow_tranches" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."escrow_payment_plans"
  WHERE (("escrow_payment_plans"."id" = "escrow_tranches"."plan_id") AND ("escrow_payment_plans"."customer_user_id" = "auth"."uid"())))));



CREATE POLICY "escrow_tranches_customer_update" ON "public"."escrow_tranches" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."escrow_payment_plans"
  WHERE (("escrow_payment_plans"."id" = "escrow_tranches"."plan_id") AND ("escrow_payment_plans"."customer_user_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."escrow_payment_plans"
  WHERE (("escrow_payment_plans"."id" = "escrow_tranches"."plan_id") AND ("escrow_payment_plans"."customer_user_id" = "auth"."uid"())))));



CREATE POLICY "escrow_tranches_provider_read" ON "public"."escrow_tranches" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."escrow_payment_plans"
     JOIN "public"."providers" ON (("providers"."id" = "escrow_payment_plans"."provider_id")))
  WHERE (("escrow_payment_plans"."id" = "escrow_tranches"."plan_id") AND ("providers"."profile_id" = "auth"."uid"())))));



CREATE POLICY "escrow_tranches_service_all" ON "public"."escrow_tranches" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."failed_join_attempts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."funding_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "funding_requests_customer_read" ON "public"."funding_requests" FOR SELECT USING (("auth"."uid"() = "customer_user_id"));



CREATE POLICY "funding_requests_provider_insert" ON "public"."funding_requests" FOR INSERT WITH CHECK (("auth"."uid"() = "provider_user_id"));



CREATE POLICY "funding_requests_provider_read" ON "public"."funding_requests" FOR SELECT USING (("auth"."uid"() = "provider_user_id"));



CREATE POLICY "funding_requests_provider_update" ON "public"."funding_requests" FOR UPDATE USING (("auth"."uid"() = "provider_user_id")) WITH CHECK (("auth"."uid"() = "provider_user_id"));



CREATE POLICY "funding_requests_service_all" ON "public"."funding_requests" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "highlight_items_delete_own" ON "public"."provider_highlight_items" FOR DELETE USING ((( SELECT "provider_highlights"."provider_user_id"
   FROM "public"."provider_highlights"
  WHERE ("provider_highlights"."id" = "provider_highlight_items"."highlight_id")) = "auth"."uid"()));



CREATE POLICY "highlight_items_insert_own" ON "public"."provider_highlight_items" FOR INSERT WITH CHECK ((( SELECT "provider_highlights"."provider_user_id"
   FROM "public"."provider_highlights"
  WHERE ("provider_highlights"."id" = "provider_highlight_items"."highlight_id")) = "auth"."uid"()));



CREATE POLICY "highlight_items_select_all" ON "public"."provider_highlight_items" FOR SELECT USING (true);



CREATE POLICY "highlight_items_update_own" ON "public"."provider_highlight_items" FOR UPDATE USING ((( SELECT "provider_highlights"."provider_user_id"
   FROM "public"."provider_highlights"
  WHERE ("provider_highlights"."id" = "provider_highlight_items"."highlight_id")) = "auth"."uid"()));



CREATE POLICY "highlights_delete_own" ON "public"."provider_highlights" FOR DELETE USING (("provider_user_id" = "auth"."uid"()));



CREATE POLICY "highlights_insert_own" ON "public"."provider_highlights" FOR INSERT WITH CHECK (("provider_user_id" = "auth"."uid"()));



CREATE POLICY "highlights_select_all" ON "public"."provider_highlights" FOR SELECT USING (true);



CREATE POLICY "highlights_update_own" ON "public"."provider_highlights" FOR UPDATE USING (("provider_user_id" = "auth"."uid"())) WITH CHECK (("provider_user_id" = "auth"."uid"()));



CREATE POLICY "imsg_owner_select" ON "public"."internal_messages" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."message_threads" "mt"
  WHERE (("mt"."id" = "internal_messages"."thread_id") AND ("mt"."provider_id" IN ( SELECT "providers"."id"
           FROM "public"."providers"
          WHERE ("providers"."profile_id" = "auth"."uid"())))))));



CREATE POLICY "imsg_participant_insert" ON "public"."internal_messages" FOR INSERT TO "authenticated" WITH CHECK ((("sender_kind" = 'user'::"text") AND ("sender_team_member_id" IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM ("public"."message_thread_participants" "mtp"
     JOIN "public"."team_members" "tm" ON ((("tm"."id")::"text" = "mtp"."team_member_id")))
  WHERE (("mtp"."thread_id" = "internal_messages"."thread_id") AND ("mtp"."team_member_id" = "internal_messages"."sender_team_member_id") AND ("mtp"."is_active" = true) AND ("tm"."profile_id" = "auth"."uid"()))))));



CREATE POLICY "imsg_participant_select" ON "public"."internal_messages" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."message_thread_participants" "mtp"
     JOIN "public"."team_members" "tm" ON ((("tm"."id")::"text" = "mtp"."team_member_id")))
  WHERE (("mtp"."thread_id" = "internal_messages"."thread_id") AND ("mtp"."is_active" = true) AND ("tm"."profile_id" = "auth"."uid"())))));



ALTER TABLE "public"."internal_messages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "internal_messages_pro_gate_insert" ON "public"."internal_messages" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ("public"."is_pro_owner"("auth"."uid"()));



ALTER TABLE "public"."invoices" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "invoices_insert_own" ON "public"."invoices" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."jobs" "j"
     LEFT JOIN "public"."providers" "p" ON (("p"."id" = COALESCE("j"."assigned_provider_id", "j"."provider_id"))))
  WHERE (("j"."id" = "invoices"."job_id") AND ("p"."profile_id" = "auth"."uid"())))));



CREATE POLICY "invoices_select_own" ON "public"."invoices" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."jobs" "j"
     LEFT JOIN "public"."providers" "p" ON (("p"."id" = COALESCE("j"."assigned_provider_id", "j"."provider_id"))))
  WHERE (("j"."id" = "invoices"."job_id") AND (("j"."customer_user_id" = "auth"."uid"()) OR ("p"."profile_id" = "auth"."uid"()))))));



CREATE POLICY "invoices_update_own" ON "public"."invoices" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM ("public"."jobs" "j"
     LEFT JOIN "public"."providers" "p" ON (("p"."id" = COALESCE("j"."assigned_provider_id", "j"."provider_id"))))
  WHERE (("j"."id" = "invoices"."job_id") AND ("p"."profile_id" = "auth"."uid"())))));



ALTER TABLE "public"."job_assignments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_feedback" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "job_feedback_insert_authenticated" ON "public"."job_feedback" FOR INSERT WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "job_feedback_select_public" ON "public"."job_feedback" FOR SELECT USING (true);



CREATE POLICY "job_feedback_update_authenticated" ON "public"."job_feedback" FOR UPDATE USING (("auth"."role"() = 'authenticated'::"text"));



ALTER TABLE "public"."job_photos" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "job_photos_customer_select" ON "public"."job_photos" FOR SELECT TO "authenticated" USING (("job_id" IN ( SELECT "jobs"."id"
   FROM "public"."jobs"
  WHERE (("jobs"."customer_user_id" = "auth"."uid"()) OR ("jobs"."customer_profile_id" = "auth"."uid"())))));



CREATE POLICY "job_photos_owner_all" ON "public"."job_photos" TO "authenticated" USING (("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"())))) WITH CHECK (("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"()))));



CREATE POLICY "job_photos_worker_delete_recent" ON "public"."job_photos" FOR DELETE TO "authenticated" USING ((("uploaded_by" = "auth"."uid"()) AND ("created_at" > ("now"() - '24:00:00'::interval))));



CREATE POLICY "job_photos_worker_insert" ON "public"."job_photos" FOR INSERT TO "authenticated" WITH CHECK ((("uploaded_by" = "auth"."uid"()) AND ("provider_id" IN ( SELECT "tm"."provider_id"
   FROM "public"."team_members" "tm"
  WHERE (("tm"."profile_id" = "auth"."uid"()) AND ("tm"."is_active" = true)))) AND (EXISTS ( SELECT 1
   FROM ("public"."jobs" "j"
     JOIN "public"."team_members" "tm" ON ((("tm"."profile_id" = "auth"."uid"()) AND ("tm"."is_active" = true) AND ("tm"."provider_id" = "j"."provider_id"))))
  WHERE (("j"."id" = "job_photos"."job_id") AND (("j"."assigned_member_ids" ? ("tm"."id")::"text") OR ("j"."assigned_team_member_id" = "tm"."id")))))));



CREATE POLICY "job_photos_worker_select" ON "public"."job_photos" FOR SELECT TO "authenticated" USING (("provider_id" IN ( SELECT "team_members"."provider_id"
   FROM "public"."team_members"
  WHERE (("team_members"."profile_id" = "auth"."uid"()) AND ("team_members"."is_active" = true)))));



ALTER TABLE "public"."job_reports" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "job_reports_customer_select" ON "public"."job_reports" FOR SELECT TO "authenticated" USING (("job_id" IN ( SELECT "jobs"."id"
   FROM "public"."jobs"
  WHERE (("jobs"."customer_user_id" = "auth"."uid"()) OR ("jobs"."customer_profile_id" = "auth"."uid"())))));



CREATE POLICY "job_reports_owner_all" ON "public"."job_reports" TO "authenticated" USING (("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"())))) WITH CHECK (("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"()))));



CREATE POLICY "job_reports_worker_delete_recent" ON "public"."job_reports" FOR DELETE TO "authenticated" USING ((("authored_by" = "auth"."uid"()) AND ("created_at" > ("now"() - '24:00:00'::interval))));



CREATE POLICY "job_reports_worker_insert" ON "public"."job_reports" FOR INSERT TO "authenticated" WITH CHECK ((("authored_by" = "auth"."uid"()) AND ("provider_id" IN ( SELECT "tm"."provider_id"
   FROM "public"."team_members" "tm"
  WHERE (("tm"."profile_id" = "auth"."uid"()) AND ("tm"."is_active" = true)))) AND (EXISTS ( SELECT 1
   FROM ("public"."jobs" "j"
     JOIN "public"."team_members" "tm" ON ((("tm"."profile_id" = "auth"."uid"()) AND ("tm"."is_active" = true) AND ("tm"."provider_id" = "j"."provider_id"))))
  WHERE (("j"."id" = "job_reports"."job_id") AND (("j"."assigned_member_ids" ? ("tm"."id")::"text") OR ("j"."assigned_team_member_id" = "tm"."id")))))));



CREATE POLICY "job_reports_worker_select" ON "public"."job_reports" FOR SELECT TO "authenticated" USING (("provider_id" IN ( SELECT "team_members"."provider_id"
   FROM "public"."team_members"
  WHERE (("team_members"."profile_id" = "auth"."uid"()) AND ("team_members"."is_active" = true)))));



CREATE POLICY "job_reports_worker_update_own" ON "public"."job_reports" FOR UPDATE TO "authenticated" USING ((("authored_by" = "auth"."uid"()) AND ("created_at" > ("now"() - '24:00:00'::interval)))) WITH CHECK (("authored_by" = "auth"."uid"()));



ALTER TABLE "public"."jobs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "join_codes_owner_all" ON "public"."company_join_codes" TO "authenticated" USING (("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"())))) WITH CHECK (("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"()))));



ALTER TABLE "public"."ledger_entries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."media_artifacts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "media_artifacts_insert_own" ON "public"."media_artifacts" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."jobs" "j"
     LEFT JOIN "public"."providers" "p" ON (("p"."id" = COALESCE("j"."assigned_provider_id", "j"."provider_id"))))
  WHERE (("j"."id" = "media_artifacts"."job_id") AND ("p"."profile_id" = "auth"."uid"())))));



CREATE POLICY "media_artifacts_select_own" ON "public"."media_artifacts" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."jobs" "j"
     LEFT JOIN "public"."providers" "p" ON (("p"."id" = COALESCE("j"."assigned_provider_id", "j"."provider_id"))))
  WHERE (("j"."id" = "media_artifacts"."job_id") AND (("j"."customer_user_id" = "auth"."uid"()) OR ("p"."profile_id" = "auth"."uid"()))))));



ALTER TABLE "public"."media_uploads" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "media_uploads_delete_own" ON "public"."media_uploads" FOR DELETE TO "authenticated" USING (("owner_user_id" = ("auth"."uid"())::"text"));



CREATE POLICY "media_uploads_insert_party_scoped" ON "public"."media_uploads" FOR INSERT TO "authenticated" WITH CHECK ((("owner_user_id" = ("auth"."uid"())::"text") AND ((("entity_type" = 'profile'::"text") AND ("entity_id" = ("auth"."uid"())::"text")) OR (("entity_type" = ANY (ARRAY['showcase'::"text", 'portfolio'::"text"])) AND (EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE ((("p"."id")::"text" = "media_uploads"."entity_id") AND ("p"."profile_id" = "auth"."uid"()))))) OR (("entity_type" = 'job'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."jobs" "j"
  WHERE ((("j"."id")::"text" = "media_uploads"."entity_id") AND (("j"."customer_user_id" = "auth"."uid"()) OR ("j"."craftsman_user_id" = ("auth"."uid"())::"text")))))) OR (("entity_type" = 'project'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."projects" "pr"
  WHERE ((("pr"."id")::"text" = "media_uploads"."entity_id") AND (("pr"."craftsman_user_id" = "auth"."uid"()) OR ("pr"."customer_user_id" = "auth"."uid"())))))) OR (("entity_type" = 'dispute'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."disputes" "d"
  WHERE ((("d"."id")::"text" = "media_uploads"."entity_id") AND (("d"."opened_by_profile_id" = "auth"."uid"()) OR ("d"."customer_profile_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
           FROM "public"."providers" "pv"
          WHERE (("pv"."id" = "d"."provider_id") AND ("pv"."profile_id" = "auth"."uid"()))))))))))));



CREATE POLICY "media_uploads_select_customer_visible" ON "public"."media_uploads" FOR SELECT TO "authenticated" USING ((("entity_type" = 'job'::"text") AND ("customer_visible" = true) AND (EXISTS ( SELECT 1
   FROM "public"."jobs"
  WHERE (("jobs"."id" = ("media_uploads"."entity_id")::"uuid") AND ("jobs"."customer_user_id" = "auth"."uid"()))))));



CREATE POLICY "media_uploads_select_party_scoped" ON "public"."media_uploads" FOR SELECT TO "authenticated" USING ((("owner_user_id" = ("auth"."uid"())::"text") OR ("entity_type" = ANY (ARRAY['profile'::"text", 'showcase'::"text", 'portfolio'::"text"])) OR (("entity_type" = 'dispute'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."disputes" "d"
  WHERE ((("d"."id")::"text" = "media_uploads"."entity_id") AND (("d"."opened_by_profile_id" = "auth"."uid"()) OR ("d"."customer_profile_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
           FROM "public"."providers" "pv"
          WHERE (("pv"."id" = "d"."provider_id") AND ("pv"."profile_id" = "auth"."uid"()))))))))) OR (("entity_type" = 'project'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."projects" "pr"
  WHERE ((("pr"."id")::"text" = "media_uploads"."entity_id") AND (("pr"."craftsman_user_id" = "auth"."uid"()) OR ("pr"."customer_user_id" = "auth"."uid"()))))))));



CREATE POLICY "media_uploads_update_own" ON "public"."media_uploads" FOR UPDATE TO "authenticated" USING (("owner_user_id" = ("auth"."uid"())::"text")) WITH CHECK (("owner_user_id" = ("auth"."uid"())::"text"));



ALTER TABLE "public"."message_thread_participants" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."message_threads" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."messages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "messages_insert_own" ON "public"."messages" FOR INSERT TO "authenticated" WITH CHECK (("conversation_id" IN ( SELECT "conversations"."id"
   FROM "public"."conversations"
  WHERE (("conversations"."craftsman_user_id" = "auth"."uid"()) OR ("conversations"."customer_user_id" = "auth"."uid"())))));



CREATE POLICY "messages_select_own" ON "public"."messages" FOR SELECT TO "authenticated" USING (("conversation_id" IN ( SELECT "conversations"."id"
   FROM "public"."conversations"
  WHERE (("conversations"."craftsman_user_id" = "auth"."uid"()) OR ("conversations"."customer_user_id" = "auth"."uid"())))));



ALTER TABLE "public"."moderation_action_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "moderation_action_log_operators_select" ON "public"."moderation_action_log" FOR SELECT USING ("public"."is_current_user_operator"());



CREATE POLICY "mthread_owner_insert" ON "public"."message_threads" FOR INSERT WITH CHECK (("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"()))));



CREATE POLICY "mthread_owner_select" ON "public"."message_threads" FOR SELECT USING (("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"()))));



CREATE POLICY "mthread_owner_update" ON "public"."message_threads" FOR UPDATE USING (("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"()))));



CREATE POLICY "mthread_worker_select" ON "public"."message_threads" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."team_members" "tm"
  WHERE (("tm"."profile_id" = "auth"."uid"()) AND ("tm"."provider_id" = "message_threads"."provider_id") AND ("tm"."is_active" = true)))));



CREATE POLICY "mtp_own_update" ON "public"."message_thread_participants" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."team_members" "tm"
  WHERE ((("tm"."id")::"text" = "message_thread_participants"."team_member_id") AND ("tm"."profile_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."team_members" "tm"
  WHERE ((("tm"."id")::"text" = "message_thread_participants"."team_member_id") AND ("tm"."profile_id" = "auth"."uid"())))));



CREATE POLICY "mtp_select" ON "public"."message_thread_participants" FOR SELECT USING (((EXISTS ( SELECT 1
   FROM "public"."team_members" "tm"
  WHERE ((("tm"."id")::"text" = "message_thread_participants"."team_member_id") AND ("tm"."profile_id" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
   FROM ("public"."message_threads" "mt"
     JOIN "public"."providers" "p" ON (("p"."id" = "mt"."provider_id")))
  WHERE (("mt"."id" = "message_thread_participants"."thread_id") AND ("p"."profile_id" = "auth"."uid"()))))));



CREATE POLICY "ndt_delete_own" ON "public"."notification_device_tokens" FOR DELETE USING (("user_id" = ("auth"."uid"())::"text"));



CREATE POLICY "ndt_insert_own" ON "public"."notification_device_tokens" FOR INSERT WITH CHECK (("user_id" = ("auth"."uid"())::"text"));



CREATE POLICY "ndt_select_own" ON "public"."notification_device_tokens" FOR SELECT USING (("user_id" = ("auth"."uid"())::"text"));



CREATE POLICY "ndt_update_own" ON "public"."notification_device_tokens" FOR UPDATE USING (("user_id" = ("auth"."uid"())::"text"));



ALTER TABLE "public"."notification_device_tokens" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."notification_signals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "notification_signals_insert_own" ON "public"."notification_signals" FOR INSERT TO "authenticated" WITH CHECK (((EXISTS ( SELECT 1
   FROM "public"."jobs" "j"
  WHERE (("j"."id" = "notification_signals"."job_id") AND ("j"."customer_user_id" IS NOT NULL) AND ("j"."customer_user_id" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
   FROM ("public"."jobs" "j"
     JOIN "public"."providers" "p" ON ((("p"."id" = "j"."provider_id") OR ("p"."id" = "j"."assigned_provider_id"))))
  WHERE (("j"."id" = "notification_signals"."job_id") AND ("p"."profile_id" = "auth"."uid"()))))));



CREATE POLICY "notification_signals_select_own" ON "public"."notification_signals" FOR SELECT TO "authenticated" USING (((("recipient_role" = 'craftsman'::"text") AND (EXISTS ( SELECT 1
   FROM ("public"."jobs" "j"
     JOIN "public"."providers" "p" ON ((("p"."id" = "j"."provider_id") OR ("p"."id" = "j"."assigned_provider_id"))))
  WHERE (("j"."id" = "notification_signals"."job_id") AND ("p"."profile_id" = "auth"."uid"()))))) OR (("recipient_role" = 'customer'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."jobs" "j"
  WHERE (("j"."id" = "notification_signals"."job_id") AND ("j"."customer_user_id" IS NOT NULL) AND ("j"."customer_user_id" = "auth"."uid"())))))));



CREATE POLICY "notification_signals_update_own" ON "public"."notification_signals" FOR UPDATE TO "authenticated" USING (((("recipient_role" = 'craftsman'::"text") AND (EXISTS ( SELECT 1
   FROM ("public"."jobs" "j"
     JOIN "public"."providers" "p" ON ((("p"."id" = "j"."provider_id") OR ("p"."id" = "j"."assigned_provider_id"))))
  WHERE (("j"."id" = "notification_signals"."job_id") AND ("p"."profile_id" = "auth"."uid"()))))) OR (("recipient_role" = 'customer'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."jobs" "j"
  WHERE (("j"."id" = "notification_signals"."job_id") AND ("j"."customer_user_id" IS NOT NULL) AND ("j"."customer_user_id" = "auth"."uid"())))))));



ALTER TABLE "public"."offers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "offers_insert_craftsman" ON "public"."offers" FOR INSERT WITH CHECK (("auth"."uid"() = "craftsman_user_id"));



CREATE POLICY "offers_select_own" ON "public"."offers" FOR SELECT USING ((("auth"."uid"() = "craftsman_user_id") OR ("auth"."uid"() = "customer_user_id")));



CREATE POLICY "offers_select_team_member" ON "public"."offers" FOR SELECT TO "authenticated" USING (("craftsman_user_id" = "public"."spatial_user_org_owner_profile"("auth"."uid"())));



COMMENT ON POLICY "offers_select_team_member" ON "public"."offers" IS 'Active team members (workers + owner-direct) of a provider-org SELECT the offers belonging to that org (craftsman_user_id = org-owner.profile_id). Closes the worker-self-visibility gap introduced by the C-10 SECURITY DEFINER RPC create_spatial_offer. Companion to offers_select_own (OR-merged).';



CREATE POLICY "offers_update_own" ON "public"."offers" FOR UPDATE USING ((("auth"."uid"() = "craftsman_user_id") OR ("auth"."uid"() = "customer_user_id"))) WITH CHECK ((("auth"."uid"() = "craftsman_user_id") OR ("auth"."uid"() = "customer_user_id")));



ALTER TABLE "public"."operator_action_audit" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "operators_read_all_reports" ON "public"."user_reports" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."is_operator" = true)))));



CREATE POLICY "operators_update_reports" ON "public"."user_reports" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."is_operator" = true))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."is_operator" = true)))));



ALTER TABLE "public"."owner_notes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "owner_notes_owner_all" ON "public"."owner_notes" TO "authenticated" USING (("job_id" IN ( SELECT "j"."id"
   FROM ("public"."jobs" "j"
     JOIN "public"."providers" "p" ON (("p"."id" = "j"."provider_id")))
  WHERE ("p"."profile_id" = "auth"."uid"())))) WITH CHECK ((("authored_by" = "auth"."uid"()) AND ("job_id" IN ( SELECT "j"."id"
   FROM ("public"."jobs" "j"
     JOIN "public"."providers" "p" ON (("p"."id" = "j"."provider_id")))
  WHERE ("p"."profile_id" = "auth"."uid"())))));



CREATE POLICY "owner_notes_worker_select" ON "public"."owner_notes" FOR SELECT TO "authenticated" USING (("job_id" IN ( SELECT "j"."id"
   FROM ("public"."jobs" "j"
     JOIN "public"."team_members" "tm" ON ((("tm"."provider_id" = "j"."provider_id") AND ("tm"."profile_id" = "auth"."uid"()) AND ("tm"."is_active" = true)))))));



ALTER TABLE "public"."parametric_cleanup_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."payment_status_history" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payment_status_history_insert_block" ON "public"."payment_status_history" FOR INSERT TO "authenticated" WITH CHECK (false);



ALTER TABLE "public"."payments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pma_delete_own" ON "public"."provider_media_assets" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "provider_media_assets"."provider_id") AND ("p"."profile_id" = "auth"."uid"())))));



CREATE POLICY "pma_insert_own" ON "public"."provider_media_assets" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "provider_media_assets"."provider_id") AND ("p"."profile_id" = "auth"."uid"())))));



CREATE POLICY "pma_select_own" ON "public"."provider_media_assets" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "provider_media_assets"."provider_id") AND ("p"."profile_id" = "auth"."uid"())))));



CREATE POLICY "pma_select_public" ON "public"."provider_media_assets" FOR SELECT USING ("public"."provider_is_public"("provider_id"));



CREATE POLICY "pma_update_own" ON "public"."provider_media_assets" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "provider_media_assets"."provider_id") AND ("p"."profile_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "provider_media_assets"."provider_id") AND ("p"."profile_id" = "auth"."uid"())))));



CREATE POLICY "pmcl_delete" ON "public"."provider_media_comment_likes" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "pmcl_insert" ON "public"."provider_media_comment_likes" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "pmcl_select" ON "public"."provider_media_comment_likes" FOR SELECT USING (true);



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."projects" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "projects_select_shared_in_chat_thread" ON "public"."projects" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."chat_messages" "m"
     JOIN "public"."chat_participants" "p" ON (("p"."thread_id" = "m"."thread_id")))
  WHERE (("m"."message_type" = 'artifact_card'::"text") AND ("m"."artifact_type" = 'Project'::"text") AND ("m"."artifact_id" = ("projects"."id")::"text") AND ("m"."deleted_at" IS NULL) AND ("m"."sender_user_id" = "projects"."customer_profile_id") AND ("p"."user_id" = "auth"."uid"()) AND ("p"."left_at" IS NULL)))));



ALTER TABLE "public"."provider_highlight_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."provider_highlights" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."provider_media" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."provider_media_assets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."provider_media_comment_likes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."provider_media_comments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "provider_media_comments_delete" ON "public"."provider_media_comments" FOR DELETE USING ((("auth"."uid"() = "user_id") OR (EXISTS ( SELECT 1
   FROM ("public"."provider_media" "pm"
     JOIN "public"."providers" "p" ON (("p"."id" = "pm"."provider_id")))
  WHERE (("pm"."id" = "provider_media_comments"."media_id") AND ("p"."profile_id" = "auth"."uid"()))))));



CREATE POLICY "provider_media_comments_insert" ON "public"."provider_media_comments" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "provider_media_comments_select" ON "public"."provider_media_comments" FOR SELECT USING (true);



CREATE POLICY "provider_media_comments_update" ON "public"."provider_media_comments" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "provider_media_delete_own" ON "public"."provider_media" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "provider_media"."provider_id") AND ("p"."profile_id" = "auth"."uid"())))));



ALTER TABLE "public"."provider_media_likes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "provider_media_likes_delete" ON "public"."provider_media_likes" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "provider_media_likes_insert" ON "public"."provider_media_likes" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "provider_media_likes_select" ON "public"."provider_media_likes" FOR SELECT USING (true);



ALTER TABLE "public"."provider_media_saves" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "provider_media_saves_delete" ON "public"."provider_media_saves" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "provider_media_saves_insert" ON "public"."provider_media_saves" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "provider_media_saves_select" ON "public"."provider_media_saves" FOR SELECT USING (true);



CREATE POLICY "provider_media_select_own" ON "public"."provider_media" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."providers" "p"
  WHERE (("p"."id" = "provider_media"."provider_id") AND ("p"."profile_id" = "auth"."uid"())))));



ALTER TABLE "public"."provider_payout_accounts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "provider_payout_own_row" ON "public"."provider_payout_accounts" USING (("auth"."uid"() = "provider_user_id")) WITH CHECK (("auth"."uid"() = "provider_user_id"));



ALTER TABLE "public"."provider_presales_projects" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "provider_presales_projects_delete" ON "public"."provider_presales_projects" FOR DELETE TO "authenticated" USING (("public"."spatial_is_operator"(( SELECT "auth"."uid"() AS "uid")) OR (("created_by_user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("provider_org_id" = "public"."spatial_user_provider_org"(( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "provider_presales_projects_insert" ON "public"."provider_presales_projects" FOR INSERT TO "authenticated" WITH CHECK ((("provider_org_id" = "public"."spatial_user_provider_org"(( SELECT "auth"."uid"() AS "uid"))) AND ("created_by_user_id" = ( SELECT "auth"."uid"() AS "uid"))));



CREATE POLICY "provider_presales_projects_select" ON "public"."provider_presales_projects" FOR SELECT TO "authenticated" USING ((("provider_org_id" = "public"."spatial_user_provider_org"(( SELECT "auth"."uid"() AS "uid"))) OR "public"."spatial_is_operator"(( SELECT "auth"."uid"() AS "uid"))));



CREATE POLICY "provider_presales_projects_update" ON "public"."provider_presales_projects" FOR UPDATE TO "authenticated" USING ((("provider_org_id" = "public"."spatial_user_provider_org"(( SELECT "auth"."uid"() AS "uid"))) OR "public"."spatial_is_operator"(( SELECT "auth"."uid"() AS "uid")))) WITH CHECK ((("provider_org_id" = "public"."spatial_user_provider_org"(( SELECT "auth"."uid"() AS "uid"))) AND ("public"."spatial_is_operator"(( SELECT "auth"."uid"() AS "uid")) OR ("created_by_user_id" = ( SELECT "provider_presales_projects_1"."created_by_user_id"
   FROM "public"."provider_presales_projects" "provider_presales_projects_1"
  WHERE ("provider_presales_projects_1"."id" = "provider_presales_projects_1"."id"))))));



ALTER TABLE "public"."provider_saves" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "provider_saves_delete" ON "public"."provider_saves" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "provider_saves_insert" ON "public"."provider_saves" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "provider_saves_select" ON "public"."provider_saves" FOR SELECT USING (true);



ALTER TABLE "public"."providers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."push_action_audit" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ratings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."revenuecat_webhook_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."saved_reel_folders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."scan_annotations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "scan_annotations_delete" ON "public"."scan_annotations" FOR DELETE TO "authenticated" USING ("public"."spatial_can_edit_scan"("scan_id", ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "scan_annotations_insert" ON "public"."scan_annotations" FOR INSERT TO "authenticated" WITH CHECK ("public"."spatial_can_view_scan"("scan_id", ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "scan_annotations_select" ON "public"."scan_annotations" FOR SELECT TO "authenticated" USING (("public"."spatial_can_view_scan"("scan_id", ( SELECT "auth"."uid"() AS "uid")) AND ((NOT "public"."spatial_is_customer_viewer"("scan_id", ( SELECT "auth"."uid"() AS "uid"))) OR ("customer_visible" = true))));



COMMENT ON POLICY "scan_annotations_select" ON "public"."scan_annotations" IS 'Lane 3 V1.6 Block 3: scan-level view-gate + per-pin customer_visible filter for customer viewers. HW/Operator/Worker see all pins on accessible scans.';



CREATE POLICY "scan_annotations_update" ON "public"."scan_annotations" FOR UPDATE TO "authenticated" USING (("public"."spatial_can_edit_scan"("scan_id", ( SELECT "auth"."uid"() AS "uid")) OR "public"."spatial_is_job_craftsman"("scan_id", ( SELECT "auth"."uid"() AS "uid")))) WITH CHECK (("public"."spatial_can_edit_scan"("scan_id", ( SELECT "auth"."uid"() AS "uid")) OR "public"."spatial_is_job_craftsman"("scan_id", ( SELECT "auth"."uid"() AS "uid"))));



ALTER TABLE "public"."scan_assets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "scan_assets_delete" ON "public"."scan_assets" FOR DELETE TO "authenticated" USING ("public"."spatial_can_edit_scan"("scan_id", ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "scan_assets_insert" ON "public"."scan_assets" FOR INSERT TO "authenticated" WITH CHECK ("public"."spatial_can_edit_scan"("scan_id", ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "scan_assets_select" ON "public"."scan_assets" FOR SELECT TO "authenticated" USING ("public"."spatial_can_view_scan"("scan_id", ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "scan_assets_update" ON "public"."scan_assets" FOR UPDATE TO "authenticated" USING ("public"."spatial_can_edit_scan"("scan_id", ( SELECT "auth"."uid"() AS "uid"))) WITH CHECK ("public"."spatial_can_edit_scan"("scan_id", ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."scan_cleanup_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."scan_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "scan_events_operator_delete" ON "public"."scan_events" FOR DELETE TO "authenticated" USING ("public"."spatial_is_operator"(( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "scan_events_select" ON "public"."scan_events" FOR SELECT TO "authenticated" USING ("public"."spatial_can_view_scan"("scan_id", ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."scan_measurements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "scan_measurements_delete" ON "public"."scan_measurements" FOR DELETE TO "authenticated" USING ("public"."spatial_can_edit_scan"("scan_id", ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "scan_measurements_insert" ON "public"."scan_measurements" FOR INSERT TO "authenticated" WITH CHECK (("public"."spatial_can_edit_scan"("scan_id", ( SELECT "auth"."uid"() AS "uid")) OR "public"."spatial_is_job_craftsman"("scan_id", ( SELECT "auth"."uid"() AS "uid"))));



CREATE POLICY "scan_measurements_select" ON "public"."scan_measurements" FOR SELECT TO "authenticated" USING ("public"."spatial_can_view_scan"("scan_id", ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "scan_measurements_update" ON "public"."scan_measurements" FOR UPDATE TO "authenticated" USING (("public"."spatial_can_edit_scan"("scan_id", ( SELECT "auth"."uid"() AS "uid")) OR "public"."spatial_is_job_craftsman"("scan_id", ( SELECT "auth"."uid"() AS "uid")))) WITH CHECK (("public"."spatial_can_edit_scan"("scan_id", ( SELECT "auth"."uid"() AS "uid")) OR "public"."spatial_is_job_craftsman"("scan_id", ( SELECT "auth"."uid"() AS "uid"))));



ALTER TABLE "public"."scan_quality_reports" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "scan_quality_reports_operator_all" ON "public"."scan_quality_reports" TO "authenticated" USING ("public"."spatial_is_operator"(( SELECT "auth"."uid"() AS "uid"))) WITH CHECK ("public"."spatial_is_operator"(( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "scan_quality_reports_select" ON "public"."scan_quality_reports" FOR SELECT TO "authenticated" USING ("public"."spatial_can_view_scan"("scan_id", ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."scan_rooms" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "scan_rooms_delete" ON "public"."scan_rooms" FOR DELETE TO "authenticated" USING ("public"."spatial_can_edit_scan"("scan_id", ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "scan_rooms_insert" ON "public"."scan_rooms" FOR INSERT TO "authenticated" WITH CHECK ("public"."spatial_can_edit_scan"("scan_id", ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "scan_rooms_select" ON "public"."scan_rooms" FOR SELECT TO "authenticated" USING ("public"."spatial_can_view_scan"("scan_id", ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "scan_rooms_update" ON "public"."scan_rooms" FOR UPDATE TO "authenticated" USING (("public"."spatial_can_edit_scan"("scan_id", ( SELECT "auth"."uid"() AS "uid")) OR "public"."spatial_is_job_craftsman"("scan_id", ( SELECT "auth"."uid"() AS "uid")))) WITH CHECK (("public"."spatial_can_edit_scan"("scan_id", ( SELECT "auth"."uid"() AS "uid")) OR "public"."spatial_is_job_craftsman"("scan_id", ( SELECT "auth"."uid"() AS "uid"))));



ALTER TABLE "public"."scan_status_transition_allowed" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "scan_status_transition_allowed_select_authenticated" ON "public"."scan_status_transition_allowed" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."scan_status_transition_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "scan_status_transition_log_delete_operator" ON "public"."scan_status_transition_log" FOR DELETE TO "authenticated" USING ("public"."spatial_is_operator"(( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "scan_status_transition_log_select_viewer" ON "public"."scan_status_transition_log" FOR SELECT TO "authenticated" USING ("public"."spatial_can_view_scan"("scan_id", ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."scan_surfaces" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "scan_surfaces_delete" ON "public"."scan_surfaces" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."scan_rooms" "r"
  WHERE (("r"."id" = "scan_surfaces"."room_id") AND "public"."spatial_can_edit_scan"("r"."scan_id", ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "scan_surfaces_insert" ON "public"."scan_surfaces" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."scan_rooms" "r"
  WHERE (("r"."id" = "scan_surfaces"."room_id") AND "public"."spatial_can_edit_scan"("r"."scan_id", ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "scan_surfaces_select" ON "public"."scan_surfaces" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."scan_rooms" "r"
  WHERE (("r"."id" = "scan_surfaces"."room_id") AND "public"."spatial_can_view_scan"("r"."scan_id", ( SELECT "auth"."uid"() AS "uid"))))));



CREATE POLICY "scan_surfaces_update" ON "public"."scan_surfaces" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."scan_rooms" "r"
  WHERE (("r"."id" = "scan_surfaces"."room_id") AND ("public"."spatial_can_edit_scan"("r"."scan_id", ( SELECT "auth"."uid"() AS "uid")) OR "public"."spatial_is_job_craftsman"("r"."scan_id", ( SELECT "auth"."uid"() AS "uid"))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."scan_rooms" "r"
  WHERE (("r"."id" = "scan_surfaces"."room_id") AND ("public"."spatial_can_edit_scan"("r"."scan_id", ( SELECT "auth"."uid"() AS "uid")) OR "public"."spatial_is_job_craftsman"("r"."scan_id", ( SELECT "auth"."uid"() AS "uid")))))));



ALTER TABLE "public"."scans" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "scans_delete" ON "public"."scans" FOR DELETE TO "authenticated" USING ("public"."spatial_can_edit_scan"("id", ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "scans_insert" ON "public"."scans" FOR INSERT TO "authenticated" WITH CHECK ((("captured_by" = ( SELECT "auth"."uid"() AS "uid")) AND ("public"."spatial_is_operator"(( SELECT "auth"."uid"() AS "uid")) OR ("owner_type" = 'customer'::"text") OR (("project_id" IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "public"."projects" "pr"
  WHERE (("pr"."id" = "scans"."project_id") AND ("pr"."customer_user_id" = ( SELECT "auth"."uid"() AS "uid")))))) OR (("job_id" IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "public"."jobs" "j"
  WHERE (("j"."id" = "scans"."job_id") AND (("j"."craftsman_user_id" = (( SELECT "auth"."uid"() AS "uid"))::"text") OR ("j"."customer_user_id" = ( SELECT "auth"."uid"() AS "uid"))))))) OR (("presales_project_id" IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "public"."provider_presales_projects" "pp"
  WHERE (("pp"."id" = "scans"."presales_project_id") AND ("pp"."provider_org_id" = "public"."spatial_user_provider_org"(( SELECT "auth"."uid"() AS "uid"))))))))));



CREATE POLICY "scans_select" ON "public"."scans" FOR SELECT TO "authenticated" USING (("public"."spatial_is_operator"(( SELECT "auth"."uid"() AS "uid")) OR (("owner_type" = 'customer'::"text") AND ("captured_by" = ( SELECT "auth"."uid"() AS "uid"))) OR (("captured_by" = ( SELECT "auth"."uid"() AS "uid")) AND ("status" = ANY (ARRAY['draft'::"public"."scan_status", 'capturing'::"public"."scan_status"]))) OR ("shared_with_provider_id" = ( SELECT "auth"."uid"() AS "uid")) OR (("project_id" IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "public"."projects" "pr"
  WHERE (("pr"."id" = "scans"."project_id") AND ("pr"."customer_user_id" = ( SELECT "auth"."uid"() AS "uid")))))) OR (("job_id" IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "public"."jobs" "j"
  WHERE (("j"."id" = "scans"."job_id") AND (("j"."craftsman_user_id" = (( SELECT "auth"."uid"() AS "uid"))::"text") OR ("j"."customer_user_id" = ( SELECT "auth"."uid"() AS "uid"))))))) OR (("shared_with_customer" = true) AND ("job_id" IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "public"."jobs" "j"
  WHERE (("j"."id" = "scans"."job_id") AND ("j"."customer_user_id" = ( SELECT "auth"."uid"() AS "uid")))))) OR (("job_id" IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM ("public"."job_assignments" "ja"
     JOIN "public"."team_members" "tm" ON (("tm"."id" = "ja"."team_member_id")))
  WHERE (("ja"."job_id" = "scans"."job_id") AND ("tm"."profile_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("tm"."is_active" = true) AND ("ja"."status" = ANY (ARRAY['assigned'::"text", 'accepted'::"text", 'active'::"text", 'in_progress'::"text", 'completed'::"text"])))))) OR (("presales_project_id" IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "public"."provider_presales_projects" "pp"
  WHERE (("pp"."id" = "scans"."presales_project_id") AND ("pp"."provider_org_id" = "public"."spatial_user_provider_org"(( SELECT "auth"."uid"() AS "uid")))))))));



COMMENT ON POLICY "scans_select" ON "public"."scans" IS 'Spatial Lane 3 Hotfix 20260526: Inline-USING (kein Function-Indirektion) damit INSERT…RETURNING die NEW row sieht. Snapshot-Problem mit spatial_can_view_scan(SECDEF) maskierte sich als 42501 WITH-CHECK-Violation. Function bleibt erhalten fuer scenes-Subquery, da dort kein RETURNING-Pfad triggert.';



CREATE POLICY "scans_update" ON "public"."scans" FOR UPDATE TO "authenticated" USING ("public"."spatial_can_edit_scan"("id", ( SELECT "auth"."uid"() AS "uid"))) WITH CHECK (("public"."spatial_can_edit_scan"("id", ( SELECT "auth"."uid"() AS "uid")) AND ("public"."spatial_is_operator"(( SELECT "auth"."uid"() AS "uid")) OR ("captured_by" = ( SELECT "s2"."captured_by"
   FROM "public"."scans" "s2"
  WHERE ("s2"."id" = "scans"."id")))) AND (("shared_with_customer" = ( SELECT "s2"."shared_with_customer"
   FROM "public"."scans" "s2"
  WHERE ("s2"."id" = "scans"."id"))) OR "public"."spatial_is_operator"(( SELECT "auth"."uid"() AS "uid")) OR (("job_id" IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "public"."jobs" "j"
  WHERE (("j"."id" = "scans"."job_id") AND ("j"."craftsman_user_id" = (( SELECT "auth"."uid"() AS "uid"))::"text")))))) AND ((NOT ("shared_with_provider_id" IS DISTINCT FROM ( SELECT "s2"."shared_with_provider_id"
   FROM "public"."scans" "s2"
  WHERE ("s2"."id" = "scans"."id")))) OR "public"."spatial_is_operator"(( SELECT "auth"."uid"() AS "uid")) OR ((( SELECT "s2"."owner_type"
   FROM "public"."scans" "s2"
  WHERE ("s2"."id" = "scans"."id")) = 'customer'::"text") AND (( SELECT "s2"."captured_by"
   FROM "public"."scans" "s2"
  WHERE ("s2"."id" = "scans"."id")) = ( SELECT "auth"."uid"() AS "uid"))))));



ALTER TABLE "public"."schedules" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "schedules_insert_own" ON "public"."schedules" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."jobs" "j"
     LEFT JOIN "public"."providers" "p" ON (("p"."id" = COALESCE("j"."assigned_provider_id", "j"."provider_id"))))
  WHERE (("j"."id" = "schedules"."job_id") AND ("p"."profile_id" = "auth"."uid"())))));



CREATE POLICY "schedules_select_own" ON "public"."schedules" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."jobs" "j"
     LEFT JOIN "public"."providers" "p" ON (("p"."id" = COALESCE("j"."assigned_provider_id", "j"."provider_id"))))
  WHERE (("j"."id" = "schedules"."job_id") AND (("j"."customer_user_id" = "auth"."uid"()) OR ("p"."profile_id" = "auth"."uid"()))))));



CREATE POLICY "schedules_update_own" ON "public"."schedules" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM ("public"."jobs" "j"
     LEFT JOIN "public"."providers" "p" ON (("p"."id" = COALESCE("j"."assigned_provider_id", "j"."provider_id"))))
  WHERE (("j"."id" = "schedules"."job_id") AND ("p"."profile_id" = "auth"."uid"())))));



ALTER TABLE "public"."spatial_assets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "spatial_assets_select" ON "public"."spatial_assets" FOR SELECT TO "authenticated" USING (("published" = true));



CREATE POLICY "spatial_assets_service_role_all" ON "public"."spatial_assets" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."spatial_change_orders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "spatial_change_orders_insert" ON "public"."spatial_change_orders" FOR INSERT TO "authenticated" WITH CHECK ((("proposer_id" = ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
   FROM "public"."spatial_scenes" "s"
  WHERE (("s"."id" = "spatial_change_orders"."scene_id") AND ("s"."provider_id" = ( SELECT "auth"."uid"() AS "uid")))))));



CREATE POLICY "spatial_change_orders_select" ON "public"."spatial_change_orders" FOR SELECT TO "authenticated" USING ("public"."spatial_can_view_scene"("scene_id", ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "spatial_change_orders_service_role_all" ON "public"."spatial_change_orders" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "spatial_change_orders_update" ON "public"."spatial_change_orders" FOR UPDATE TO "authenticated" USING ((("proposer_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("status" = 'proposed'::"text"))) WITH CHECK (("proposer_id" = ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."spatial_edit_history" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "spatial_edit_history_insert_deny" ON "public"."spatial_edit_history" FOR INSERT TO "authenticated" WITH CHECK (false);



CREATE POLICY "spatial_edit_history_select" ON "public"."spatial_edit_history" FOR SELECT TO "authenticated" USING ("public"."spatial_can_view_scene"("scene_id", ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "spatial_edit_history_service_role_all" ON "public"."spatial_edit_history" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."spatial_materials" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "spatial_materials_select" ON "public"."spatial_materials" FOR SELECT TO "authenticated" USING (("published" = true));



CREATE POLICY "spatial_materials_service_role_all" ON "public"."spatial_materials" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."spatial_node_links" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "spatial_node_links_insert" ON "public"."spatial_node_links" FOR INSERT TO "authenticated" WITH CHECK (("public"."spatial_can_view_scene"("scene_id", ( SELECT "auth"."uid"() AS "uid")) AND ("created_by" = ( SELECT "auth"."uid"() AS "uid"))));



CREATE POLICY "spatial_node_links_select" ON "public"."spatial_node_links" FOR SELECT TO "authenticated" USING ("public"."spatial_can_view_scene"("scene_id", ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "spatial_node_links_service_role_all" ON "public"."spatial_node_links" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."spatial_node_overrides" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "spatial_node_overrides_service_role_all" ON "public"."spatial_node_overrides" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."spatial_pin_reviews" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "spatial_pin_reviews_delete" ON "public"."spatial_pin_reviews" FOR DELETE TO "authenticated" USING (("provider_org_id" = "public"."spatial_user_provider_org"("auth"."uid"())));



CREATE POLICY "spatial_pin_reviews_insert" ON "public"."spatial_pin_reviews" FOR INSERT TO "authenticated" WITH CHECK ((("provider_org_id" = "public"."spatial_user_provider_org"("auth"."uid"())) AND ("reviewed_by_user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."spatial_scenes" "s"
  WHERE (("s"."id" = "spatial_pin_reviews"."scene_id") AND ("s"."provider_org_id" = "public"."spatial_user_provider_org"("auth"."uid"())))))));



CREATE POLICY "spatial_pin_reviews_select" ON "public"."spatial_pin_reviews" FOR SELECT TO "authenticated" USING (("provider_org_id" = "public"."spatial_user_provider_org"("auth"."uid"())));



CREATE POLICY "spatial_pin_reviews_update" ON "public"."spatial_pin_reviews" FOR UPDATE TO "authenticated" USING (("provider_org_id" = "public"."spatial_user_provider_org"("auth"."uid"()))) WITH CHECK (("provider_org_id" = "public"."spatial_user_provider_org"("auth"."uid"())));



ALTER TABLE "public"."spatial_rescan_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "spatial_rescan_requests_customer_select" ON "public"."spatial_rescan_requests" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."spatial_scenes" "s"
  WHERE (("s"."id" = "spatial_rescan_requests"."scene_id") AND ("s"."customer_id" = "auth"."uid"())))));



CREATE POLICY "spatial_rescan_requests_insert" ON "public"."spatial_rescan_requests" FOR INSERT TO "authenticated" WITH CHECK ((("provider_org_id" = "public"."spatial_user_provider_org"("auth"."uid"())) AND ("requested_by_user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."spatial_scenes" "s"
  WHERE (("s"."id" = "spatial_rescan_requests"."scene_id") AND ("s"."provider_org_id" = "public"."spatial_user_provider_org"("auth"."uid"())))))));



CREATE POLICY "spatial_rescan_requests_select" ON "public"."spatial_rescan_requests" FOR SELECT TO "authenticated" USING (("provider_org_id" = "public"."spatial_user_provider_org"("auth"."uid"())));



ALTER TABLE "public"."spatial_scenes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "spatial_scenes_insert" ON "public"."spatial_scenes" FOR INSERT TO "authenticated" WITH CHECK (false);



CREATE POLICY "spatial_scenes_select" ON "public"."spatial_scenes" FOR SELECT TO "authenticated" USING ("public"."spatial_can_view_scene"("id", ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "spatial_scenes_service_role_all" ON "public"."spatial_scenes" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "spatial_scenes_update" ON "public"."spatial_scenes" FOR UPDATE TO "authenticated" USING ("public"."spatial_can_view_scene"("id", ( SELECT "auth"."uid"() AS "uid"))) WITH CHECK ("public"."spatial_can_edit_scene"("id", ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."spatial_share_audit" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "spatial_share_audit_select" ON "public"."spatial_share_audit" FOR SELECT TO "authenticated" USING (("public"."spatial_is_operator"(( SELECT "auth"."uid"() AS "uid")) OR (EXISTS ( SELECT 1
   FROM "public"."scans" "sc"
  WHERE (("sc"."id" = "spatial_share_audit"."scan_id") AND (("sc"."captured_by" = ( SELECT "auth"."uid"() AS "uid")) OR (("sc"."job_id" IS NOT NULL) AND (EXISTS ( SELECT 1
           FROM "public"."jobs" "j"
          WHERE (("j"."id" = "sc"."job_id") AND ("j"."customer_user_id" = ( SELECT "auth"."uid"() AS "uid"))))))))))));



CREATE POLICY "srf_delete" ON "public"."saved_reel_folders" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "srf_insert" ON "public"."saved_reel_folders" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "srf_select" ON "public"."saved_reel_folders" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "srf_update" ON "public"."saved_reel_folders" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."stripe_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."stripe_webhook_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "stripe_webhook_events_select_party" ON "public"."stripe_webhook_events" FOR SELECT TO "authenticated" USING ((("job_id" IS NOT NULL) AND ((EXISTS ( SELECT 1
   FROM "public"."jobs" "j"
  WHERE ((("j"."id")::"text" = "stripe_webhook_events"."job_id") AND (("j"."customer_user_id" = "auth"."uid"()) OR ("j"."provider_id" IN ( SELECT "pr"."id"
           FROM "public"."providers" "pr"
          WHERE ("pr"."profile_id" = "auth"."uid"()))) OR ("j"."assigned_provider_id" IN ( SELECT "pr"."id"
           FROM "public"."providers" "pr"
          WHERE ("pr"."profile_id" = "auth"."uid"()))))))) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."is_operator" = true)))))));



COMMENT ON POLICY "stripe_webhook_events_select_party" ON "public"."stripe_webhook_events" IS 'N13.RLS: Job parties (customer/provider/assigned-provider) and operators can read webhook events tied to their job. Other authenticated users see []. Service-role bypasses RLS for inserts.';



ALTER TABLE "public"."subscription_withdrawal_consents" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "subscription_withdrawal_consents_insert_own" ON "public"."subscription_withdrawal_consents" FOR INSERT WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "subscription_withdrawal_consents_select_own" ON "public"."subscription_withdrawal_consents" FOR SELECT USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



ALTER TABLE "public"."supplementary_payment_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "supplementary_payment_requests_craftsman_read" ON "public"."supplementary_payment_requests" FOR SELECT USING ((("auth"."uid"())::"text" = "craftsman_user_id"));



CREATE POLICY "supplementary_payment_requests_craftsman_update" ON "public"."supplementary_payment_requests" FOR UPDATE USING ((("auth"."uid"())::"text" = "craftsman_user_id"));



CREATE POLICY "supplementary_payment_requests_customer_read" ON "public"."supplementary_payment_requests" FOR SELECT USING ((("auth"."uid"())::"text" = "customer_user_id"));



CREATE POLICY "supplementary_payment_requests_customer_update" ON "public"."supplementary_payment_requests" FOR UPDATE USING ((("auth"."uid"())::"text" = "customer_user_id"));



CREATE POLICY "supplementary_payment_requests_insert" ON "public"."supplementary_payment_requests" FOR INSERT WITH CHECK (((("auth"."uid"())::"text" = "craftsman_user_id") OR (("auth"."uid"())::"text" = "customer_user_id")));



ALTER TABLE "public"."team_member_audit" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "team_member_audit_owner_select" ON "public"."team_member_audit" FOR SELECT TO "authenticated" USING (("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"()))));



ALTER TABLE "public"."team_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "team_members_pro_gate_insert" ON "public"."team_members" AS RESTRICTIVE FOR INSERT TO "authenticated" WITH CHECK ("public"."is_pro_owner"("auth"."uid"()));



ALTER TABLE "public"."thread_artifacts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "thread_artifacts_insert_own" ON "public"."thread_artifacts" FOR INSERT WITH CHECK ((("auth"."uid"() = "customer_user_id") OR ("auth"."uid"() = "craftsman_user_id")));



CREATE POLICY "thread_artifacts_select_own" ON "public"."thread_artifacts" FOR SELECT USING ((("auth"."uid"() = "customer_user_id") OR ("auth"."uid"() = "craftsman_user_id")));



CREATE POLICY "thread_artifacts_update_own" ON "public"."thread_artifacts" FOR UPDATE USING ((("auth"."uid"() = "customer_user_id") OR ("auth"."uid"() = "craftsman_user_id"))) WITH CHECK ((("auth"."uid"() = "customer_user_id") OR ("auth"."uid"() = "craftsman_user_id")));



ALTER TABLE "public"."time_entries" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "time_entries_owner_select" ON "public"."time_entries" FOR SELECT TO "authenticated" USING (("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"()))));



CREATE POLICY "time_entries_owner_update" ON "public"."time_entries" FOR UPDATE TO "authenticated" USING (("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"())))) WITH CHECK ((("provider_id" IN ( SELECT "providers"."id"
   FROM "public"."providers"
  WHERE ("providers"."profile_id" = "auth"."uid"()))) AND ("status" = ANY (ARRAY['closed'::"public"."time_entry_status", 'rejected'::"public"."time_entry_status"]))));



CREATE POLICY "time_entries_worker_close" ON "public"."time_entries" FOR UPDATE TO "authenticated" USING ((("status" = 'active'::"public"."time_entry_status") AND ("member_id" IN ( SELECT "team_members"."id"
   FROM "public"."team_members"
  WHERE (("team_members"."profile_id" = "auth"."uid"()) AND ("team_members"."is_active" = true)))))) WITH CHECK ((("status" = 'closed'::"public"."time_entry_status") AND ("member_id" IN ( SELECT "team_members"."id"
   FROM "public"."team_members"
  WHERE (("team_members"."profile_id" = "auth"."uid"()) AND ("team_members"."is_active" = true)))) AND ("duration_minutes" IS NOT NULL) AND ("duration_minutes" >= 1) AND ("duration_minutes" <= (24 * 60)) AND ("rejected_by" IS NULL) AND ("rejected_reason" IS NULL)));



CREATE POLICY "time_entries_worker_delete_active" ON "public"."time_entries" FOR DELETE TO "authenticated" USING ((("status" = 'active'::"public"."time_entry_status") AND ("member_id" IN ( SELECT "team_members"."id"
   FROM "public"."team_members"
  WHERE (("team_members"."profile_id" = "auth"."uid"()) AND ("team_members"."is_active" = true))))));



CREATE POLICY "time_entries_worker_insert" ON "public"."time_entries" FOR INSERT TO "authenticated" WITH CHECK (((EXISTS ( SELECT 1
   FROM "public"."team_members" "tm"
  WHERE (("tm"."id" = "time_entries"."member_id") AND ("tm"."provider_id" = "tm"."provider_id") AND ("tm"."profile_id" = "auth"."uid"()) AND ("tm"."is_active" = true)))) AND (("kind" = 'day'::"public"."time_entry_kind") OR (("job_id" IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "public"."jobs" "j"
  WHERE (("j"."id" = "time_entries"."job_id") AND ("j"."assigned_member_ids" ? ("time_entries"."member_id")::"text"))))))));



CREATE POLICY "time_entries_worker_select" ON "public"."time_entries" FOR SELECT TO "authenticated" USING (("member_id" IN ( SELECT "team_members"."id"
   FROM "public"."team_members"
  WHERE (("team_members"."profile_id" = "auth"."uid"()) AND ("team_members"."is_active" = true)))));



ALTER TABLE "public"."timeline_signals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "timeline_signals_insert_own" ON "public"."timeline_signals" FOR INSERT TO "authenticated" WITH CHECK (((EXISTS ( SELECT 1
   FROM "public"."jobs" "j"
  WHERE (("j"."id" = "timeline_signals"."job_id") AND ("j"."customer_user_id" IS NOT NULL) AND ("j"."customer_user_id" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
   FROM ("public"."jobs" "j"
     JOIN "public"."providers" "p" ON ((("p"."id" = "j"."provider_id") OR ("p"."id" = "j"."assigned_provider_id"))))
  WHERE (("j"."id" = "timeline_signals"."job_id") AND ("p"."profile_id" = "auth"."uid"()))))));



CREATE POLICY "timeline_signals_select_own" ON "public"."timeline_signals" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."jobs" "j"
     LEFT JOIN "public"."providers" "p" ON (("p"."id" = COALESCE("j"."assigned_provider_id", "j"."provider_id"))))
  WHERE (("j"."id" = "timeline_signals"."job_id") AND (("j"."customer_user_id" = "auth"."uid"()) OR ("p"."profile_id" = "auth"."uid"()))))));



ALTER TABLE "public"."user_blocks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_notification_preferences" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_notification_prefs_insert_self" ON "public"."user_notification_preferences" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "user_notification_prefs_select_self" ON "public"."user_notification_preferences" FOR SELECT TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "user_notification_prefs_update_self" ON "public"."user_notification_preferences" FOR UPDATE TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid"))) WITH CHECK (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."user_reports" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "users_delete_own_blocks" ON "public"."user_blocks" FOR DELETE USING (("auth"."uid"() = "blocker_id"));



CREATE POLICY "users_insert_own_blocks" ON "public"."user_blocks" FOR INSERT WITH CHECK (("auth"."uid"() = "blocker_id"));



CREATE POLICY "users_insert_own_reports" ON "public"."user_reports" FOR INSERT WITH CHECK (("auth"."uid"() = "reporter_id"));



CREATE POLICY "users_read_own_blocks" ON "public"."user_blocks" FOR SELECT USING (("auth"."uid"() = "blocker_id"));



CREATE POLICY "users_read_own_reports" ON "public"."user_reports" FOR SELECT USING (("auth"."uid"() = "reporter_id"));



ALTER TABLE "public"."widerruf_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "widerruf_requests_insert_own" ON "public"."widerruf_requests" FOR INSERT WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "widerruf_requests_select_own" ON "public"."widerruf_requests" FOR SELECT USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



REVOKE ALL ON FUNCTION "public"."_assert_caller_is_operator"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."_assert_caller_is_operator"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."_enforce_profile_privileged_columns"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."_enforce_profile_privileged_columns"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."_enforce_profile_privileged_columns"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."account_cascade_delete_owned_rows"("p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."account_cascade_delete_owned_rows"("p_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."account_cascade_list_storage"("p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."account_cascade_list_storage"("p_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."apply_dispute_default_refund"("p_dispute_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."apply_dispute_default_refund"("p_dispute_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."assert_attribution_finalized_before_release"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."assert_attribution_finalized_before_release"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."assert_attribution_finalized_before_release"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."become_provider"("p_company_name" "text", "p_description" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."become_provider"("p_company_name" "text", "p_description" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."chat_messages_dispatch_push"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."chat_messages_dispatch_push"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."chat_user_is_thread_admin"("p_thread_id" "uuid", "p_uid" "uuid", "p_include_craftsman" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."chat_user_is_thread_admin"("p_thread_id" "uuid", "p_uid" "uuid", "p_include_craftsman" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."chat_user_is_thread_admin"("p_thread_id" "uuid", "p_uid" "uuid", "p_include_craftsman" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."comment_reply_summary"("p_parent_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."comment_reply_summary"("p_parent_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."comment_reply_summary"("p_parent_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."comment_thread_summary"("p_media_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."comment_thread_summary"("p_media_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."comment_thread_summary"("p_media_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."complete_tranche_payout"("p_tranche_id" "text", "p_payout_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."complete_tranche_payout"("p_tranche_id" "text", "p_payout_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."confirm_funding_atomic"("p_funding_request_id" "uuid", "p_escrow_plan_id" "uuid", "p_payment_intent_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."confirm_funding_atomic"("p_funding_request_id" "uuid", "p_escrow_plan_id" "uuid", "p_payment_intent_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."confirm_split_proposal"("p_proposal_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."confirm_split_proposal"("p_proposal_id" "uuid") TO "service_role";



GRANT ALL ON TABLE "public"."offers" TO "anon";
GRANT ALL ON TABLE "public"."offers" TO "authenticated";
GRANT ALL ON TABLE "public"."offers" TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_spatial_offer"("p_id" "uuid", "p_scene_id" "uuid", "p_document_type" "text", "p_price" numeric, "p_net_total" numeric, "p_gross_total" numeric, "p_vat_amount" numeric, "p_vat_rate" integer, "p_currency" "text", "p_line_items" "jsonb", "p_spatial_metadata" "jsonb", "p_description" "text", "p_conversation_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_spatial_offer"("p_id" "uuid", "p_scene_id" "uuid", "p_document_type" "text", "p_price" numeric, "p_net_total" numeric, "p_gross_total" numeric, "p_vat_amount" numeric, "p_vat_rate" integer, "p_currency" "text", "p_line_items" "jsonb", "p_spatial_metadata" "jsonb", "p_description" "text", "p_conversation_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_spatial_offer"("p_id" "uuid", "p_scene_id" "uuid", "p_document_type" "text", "p_price" numeric, "p_net_total" numeric, "p_gross_total" numeric, "p_vat_amount" numeric, "p_vat_rate" integer, "p_currency" "text", "p_line_items" "jsonb", "p_spatial_metadata" "jsonb", "p_description" "text", "p_conversation_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_team_member_stub"("p_provider_id" "uuid", "p_full_name" "text", "p_role" "text", "p_phone" "text", "p_email" "text", "p_weekly_target_hours" numeric, "p_daily_target_hours" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_team_member_stub"("p_provider_id" "uuid", "p_full_name" "text", "p_role" "text", "p_phone" "text", "p_email" "text", "p_weekly_target_hours" numeric, "p_daily_target_hours" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_team_member_stub"("p_provider_id" "uuid", "p_full_name" "text", "p_role" "text", "p_phone" "text", "p_email" "text", "p_weekly_target_hours" numeric, "p_daily_target_hours" numeric) TO "service_role";



REVOKE ALL ON FUNCTION "public"."deactivate_team_member"("p_member_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."deactivate_team_member"("p_member_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deactivate_team_member"("p_member_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."dispute_spatial_evidence_append"("p_dispute_id" "uuid", "p_scene_id" "uuid", "p_node_id" "text", "p_evidence_kind" "text", "p_metadata" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."dispute_spatial_evidence_append"("p_dispute_id" "uuid", "p_scene_id" "uuid", "p_node_id" "text", "p_evidence_kind" "text", "p_metadata" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dispute_spatial_evidence_append"("p_dispute_id" "uuid", "p_scene_id" "uuid", "p_node_id" "text", "p_evidence_kind" "text", "p_metadata" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."disputes_sla_reset_trigger_fn"() TO "anon";
GRANT ALL ON FUNCTION "public"."disputes_sla_reset_trigger_fn"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."disputes_sla_reset_trigger_fn"() TO "service_role";



GRANT ALL ON FUNCTION "public"."disputes_status_change_guard"() TO "anon";
GRANT ALL ON FUNCTION "public"."disputes_status_change_guard"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."disputes_status_change_guard"() TO "service_role";



GRANT ALL ON FUNCTION "public"."enforce_comment_depth"() TO "anon";
GRANT ALL ON FUNCTION "public"."enforce_comment_depth"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."enforce_comment_depth"() TO "service_role";



GRANT ALL ON FUNCTION "public"."enforce_invoice_immutability"() TO "anon";
GRANT ALL ON FUNCTION "public"."enforce_invoice_immutability"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."enforce_invoice_immutability"() TO "service_role";



GRANT ALL ON FUNCTION "public"."enforce_parent_comment_id_immutable"() TO "anon";
GRANT ALL ON FUNCTION "public"."enforce_parent_comment_id_immutable"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."enforce_parent_comment_id_immutable"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."enforce_scan_fsm"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enforce_scan_fsm"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."ensure_subscription_row"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."ensure_subscription_row"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."ensure_subscription_row"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."epoch_ms"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."epoch_ms"() TO "service_role";
GRANT ALL ON FUNCTION "public"."epoch_ms"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."finalize_payment_state_atomic"("p_job_id" "text", "p_target_state" "text", "p_dispute_id" "text", "p_actor" "text", "p_refunded_amount" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."finalize_payment_state_atomic"("p_job_id" "text", "p_target_state" "text", "p_dispute_id" "text", "p_actor" "text", "p_refunded_amount" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."finalize_payment_state_atomic"("p_job_id" "text", "p_target_state" "text", "p_dispute_id" "text", "p_actor" "text", "p_refunded_amount" numeric) TO "service_role";



REVOKE ALL ON FUNCTION "public"."fn_chat_migration_status_set_updated_at"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fn_chat_migration_status_set_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."fn_chat_set_message_type_on_attachment"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fn_chat_set_message_type_on_attachment"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."fn_chat_update_thread_last_message"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fn_chat_update_thread_last_message"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."fn_resolve_provider_for_caller"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fn_resolve_provider_for_caller"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."fn_seed_chat_participants_for_provider"("p_thread_id" "uuid", "p_provider_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fn_seed_chat_participants_for_provider"("p_thread_id" "uuid", "p_provider_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."fn_update_thread_last_message"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fn_update_thread_last_message"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."fn_user_notification_prefs_set_updated_at"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fn_user_notification_prefs_set_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."generate_invoice_number"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."generate_invoice_number"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."generate_unique_company_code"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."generate_unique_company_code"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_customer_billing_for_invoice"("p_job_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_customer_billing_for_invoice"("p_job_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_customer_billing_for_invoice"("p_job_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_or_create_assignment_thread"("p_calendar_entry_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_or_create_assignment_thread"("p_calendar_entry_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_or_create_assignment_thread"("p_calendar_entry_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_or_create_office_thread"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_or_create_office_thread"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_or_create_office_thread"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_or_create_team_thread"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_or_create_team_thread"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_or_create_team_thread"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_provider_avatar"("p_provider_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_provider_avatar"("p_provider_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_provider_avatar"("p_provider_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_provider_media"("p_provider_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_provider_media"("p_provider_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_provider_media"("p_provider_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_provider_median_response_ms"("p_craftsman_user_id" "text", "p_window_days" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_provider_median_response_ms"("p_craftsman_user_id" "text", "p_window_days" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_provider_median_response_ms"("p_craftsman_user_id" "text", "p_window_days" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_provider_portfolio"("p_provider_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_provider_portfolio"("p_provider_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_provider_portfolio"("p_provider_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."handle_auth_user_delete_cascade"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."handle_auth_user_delete_cascade"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."handle_new_user"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."increment_craftsman_jobs_count"("p_craftsman_user_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."increment_craftsman_jobs_count"("p_craftsman_user_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."increment_craftsman_jobs_count"("p_craftsman_user_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_blocked"("user_a" "uuid", "user_b" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_blocked"("user_a" "uuid", "user_b" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_blocked"("user_a" "uuid", "user_b" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_blocked_by_me"("target_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_blocked_by_me"("target_user_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."is_caller_moderation_write_allowed"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_caller_moderation_write_allowed"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_caller_moderation_write_allowed"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_current_user_operator"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_current_user_operator"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_current_user_operator"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_pro_owner"("p_profile_id" "uuid", "p_now" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_pro_owner"("p_profile_id" "uuid", "p_now" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_pro_owner"("p_profile_id" "uuid", "p_now" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."jobs_terminal_status_guard"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."jobs_terminal_status_guard"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."join_company_with_code"("p_code" "text", "p_full_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."join_company_with_code"("p_code" "text", "p_full_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."join_company_with_code"("p_code" "text", "p_full_name" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."leave_company"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."leave_company"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."leave_company"() TO "service_role";



GRANT ALL ON FUNCTION "public"."notification_push_copy"("p_type" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."notification_push_copy"("p_type" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."notification_push_copy"("p_type" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."notification_push_recipient"("p_job_id" "uuid", "p_recipient_role" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."notification_push_recipient"("p_job_id" "uuid", "p_recipient_role" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."notification_signals_dispatch_push"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."notification_signals_dispatch_push"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."offers_mark_quote_stale"("p_offer_id" "uuid", "p_reason" "text", "p_source_scene_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."offers_mark_quote_stale"("p_offer_id" "uuid", "p_reason" "text", "p_source_scene_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."offers_mark_quote_stale"("p_offer_id" "uuid", "p_reason" "text", "p_source_scene_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."open_dispute_atomic"("p_job_id" "uuid", "p_dispute_id" "uuid", "p_reason" "text", "p_description" "text", "p_raised_by" "text", "p_payment_id" "uuid", "p_metadata" "jsonb", "p_context_snapshot" "jsonb", "p_opened_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_dispute_atomic"("p_job_id" "uuid", "p_dispute_id" "uuid", "p_reason" "text", "p_description" "text", "p_raised_by" "text", "p_payment_id" "uuid", "p_metadata" "jsonb", "p_context_snapshot" "jsonb", "p_opened_at" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."open_dispute_atomic"("p_job_id" "uuid", "p_dispute_id" "uuid", "p_reason" "text", "p_description" "text", "p_raised_by" "text", "p_payment_id" "uuid", "p_metadata" "jsonb", "p_context_snapshot" "jsonb", "p_opened_at" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."operator_enforce_report"("p_action" "text", "p_report_id" "uuid", "p_target_user_id" "uuid", "p_notes" "text", "p_suspend_hours" integer, "p_target_message_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."operator_enforce_report"("p_action" "text", "p_report_id" "uuid", "p_target_user_id" "uuid", "p_notes" "text", "p_suspend_hours" integer, "p_target_message_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."operator_enforce_report"("p_action" "text", "p_report_id" "uuid", "p_target_user_id" "uuid", "p_notes" "text", "p_suspend_hours" integer, "p_target_message_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."operator_mark_dispute_under_review"("p_dispute_id" "uuid", "p_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."operator_mark_dispute_under_review"("p_dispute_id" "uuid", "p_note" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."operator_mark_dispute_under_review"("p_dispute_id" "uuid", "p_note" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."operator_reject_dispute"("p_dispute_id" "uuid", "p_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."operator_reject_dispute"("p_dispute_id" "uuid", "p_note" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."operator_reject_dispute"("p_dispute_id" "uuid", "p_note" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."operator_request_customer_evidence_dispute"("p_dispute_id" "uuid", "p_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."operator_request_customer_evidence_dispute"("p_dispute_id" "uuid", "p_note" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."operator_request_customer_evidence_dispute"("p_dispute_id" "uuid", "p_note" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."operator_request_provider_evidence_dispute"("p_dispute_id" "uuid", "p_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."operator_request_provider_evidence_dispute"("p_dispute_id" "uuid", "p_note" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."operator_request_provider_evidence_dispute"("p_dispute_id" "uuid", "p_note" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."operator_resolve_attribution"("p_job_id" "uuid", "p_mode" "text", "p_to_origin" "text", "p_reason" "text", "p_operator_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."operator_resolve_attribution"("p_job_id" "uuid", "p_mode" "text", "p_to_origin" "text", "p_reason" "text", "p_operator_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."operator_resolve_dispute_refund"("p_dispute_id" "uuid", "p_note" "text", "p_refund_amount" numeric, "p_release_amount" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."operator_resolve_dispute_refund"("p_dispute_id" "uuid", "p_note" "text", "p_refund_amount" numeric, "p_release_amount" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."operator_resolve_dispute_refund"("p_dispute_id" "uuid", "p_note" "text", "p_refund_amount" numeric, "p_release_amount" numeric) TO "service_role";



REVOKE ALL ON FUNCTION "public"."operator_resolve_dispute_release"("p_dispute_id" "uuid", "p_note" "text", "p_release_amount" numeric, "p_refund_amount" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."operator_resolve_dispute_release"("p_dispute_id" "uuid", "p_note" "text", "p_release_amount" numeric, "p_refund_amount" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."operator_resolve_dispute_release"("p_dispute_id" "uuid", "p_note" "text", "p_release_amount" numeric, "p_refund_amount" numeric) TO "service_role";



REVOKE ALL ON FUNCTION "public"."operator_resolve_dispute_split"("p_dispute_id" "uuid", "p_split_ratio" numeric, "p_note" "text", "p_provider_award_amount" numeric, "p_customer_refund_amount" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."operator_resolve_dispute_split"("p_dispute_id" "uuid", "p_split_ratio" numeric, "p_note" "text", "p_provider_award_amount" numeric, "p_customer_refund_amount" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."operator_resolve_dispute_split"("p_dispute_id" "uuid", "p_split_ratio" numeric, "p_note" "text", "p_provider_award_amount" numeric, "p_customer_refund_amount" numeric) TO "service_role";



REVOKE ALL ON FUNCTION "public"."party_submit_dispute_statement"("p_dispute_id" "uuid", "p_evidence" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."party_submit_dispute_statement"("p_dispute_id" "uuid", "p_evidence" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."party_submit_dispute_statement"("p_dispute_id" "uuid", "p_evidence" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."propose_split_atomic"("p_dispute_id" "uuid", "p_ratio" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."propose_split_atomic"("p_dispute_id" "uuid", "p_ratio" numeric) TO "service_role";



REVOKE ALL ON FUNCTION "public"."provider_is_public"("p_provider_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."provider_is_public"("p_provider_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."provider_is_public"("p_provider_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."provider_is_public"("p_provider_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."provider_presales_projects_set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."provider_presales_projects_set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."provider_presales_projects_set_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."reactivate_team_member"("p_member_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reactivate_team_member"("p_member_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."reactivate_team_member"("p_member_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."reassign_job_member"("p_job_id" "uuid", "p_from" "text", "p_to" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reassign_job_member"("p_job_id" "uuid", "p_from" "text", "p_to" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."reassign_job_member"("p_job_id" "uuid", "p_from" "text", "p_to" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."reconcile_transfer_reversal_atomic"("p_tranche_id" "uuid", "p_plan_id" "uuid", "p_reversal_ref" "text", "p_reversed_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reconcile_transfer_reversal_atomic"("p_tranche_id" "uuid", "p_plan_id" "uuid", "p_reversal_ref" "text", "p_reversed_at" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_push_action_attempt"("p_notification_id" "uuid", "p_action_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_push_action_attempt"("p_notification_id" "uuid", "p_action_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_push_action_attempt"("p_notification_id" "uuid", "p_action_id" "text") TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."scan_events" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."scan_events" TO "authenticated";
GRANT ALL ON TABLE "public"."scan_events" TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_scan_event"("p_scan_id" "uuid", "p_action" "public"."scan_event_action", "p_payload" "jsonb", "p_idempotency_key" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_scan_event"("p_scan_id" "uuid", "p_action" "public"."scan_event_action", "p_payload" "jsonb", "p_idempotency_key" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_scan_event"("p_scan_id" "uuid", "p_action" "public"."scan_event_action", "p_payload" "jsonb", "p_idempotency_key" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."reject_split_proposal"("p_proposal_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reject_split_proposal"("p_proposal_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."release_tranche_atomic"("p_tranche_id" "uuid", "p_plan_id" "uuid", "p_transfer_id" "text", "p_actor" "text", "p_released_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."release_tranche_atomic"("p_tranche_id" "uuid", "p_plan_id" "uuid", "p_transfer_id" "text", "p_actor" "text", "p_released_at" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."release_tranche_with_ledger"("p_tranche_id" "text", "p_plan_id" "text", "p_transfer_id" "text", "p_actor" "text", "p_released_at" timestamp with time zone, "p_net_amount" numeric, "p_currency" "text", "p_payment_id" "text", "p_job_id" "text", "p_ledger_entry_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."release_tranche_with_ledger"("p_tranche_id" "text", "p_plan_id" "text", "p_transfer_id" "text", "p_actor" "text", "p_released_at" timestamp with time zone, "p_net_amount" numeric, "p_currency" "text", "p_payment_id" "text", "p_job_id" "text", "p_ledger_entry_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."request_scan_download"("p_scan_id" "uuid", "p_kind" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."request_scan_download"("p_scan_id" "uuid", "p_kind" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."request_scan_download"("p_scan_id" "uuid", "p_kind" "text") TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."download_jobs" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."download_jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."download_jobs" TO "service_role";



REVOKE ALL ON FUNCTION "public"."resign_download_url"("p_job_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."resign_download_url"("p_job_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."resign_download_url"("p_job_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."rotate_company_code"("p_provider_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rotate_company_code"("p_provider_id" "uuid", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."rotate_company_code"("p_provider_id" "uuid", "p_reason" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."rpc_enqueue_thread_migration"("p_legacy_thread_id" "text", "p_legacy_source" "text", "p_priority" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rpc_enqueue_thread_migration"("p_legacy_thread_id" "text", "p_legacy_source" "text", "p_priority" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."rpc_enqueue_thread_migration"("p_legacy_thread_id" "text", "p_legacy_source" "text", "p_priority" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."rpc_get_or_create_chat_assignment_thread"("p_calendar_entry_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rpc_get_or_create_chat_assignment_thread"("p_calendar_entry_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."rpc_get_or_create_chat_assignment_thread"("p_calendar_entry_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."rpc_get_or_create_chat_customer_thread"("p_craftsman_user_id" "uuid", "p_title" "text", "p_inquiry_origin" "text", "p_source_project_id" "text", "p_inquiry_criteria" "jsonb", "p_display_metadata" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rpc_get_or_create_chat_customer_thread"("p_craftsman_user_id" "uuid", "p_title" "text", "p_inquiry_origin" "text", "p_source_project_id" "text", "p_inquiry_criteria" "jsonb", "p_display_metadata" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."rpc_get_or_create_chat_customer_thread"("p_craftsman_user_id" "uuid", "p_title" "text", "p_inquiry_origin" "text", "p_source_project_id" "text", "p_inquiry_criteria" "jsonb", "p_display_metadata" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."rpc_get_or_create_chat_dispute_thread"("p_dispute_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rpc_get_or_create_chat_dispute_thread"("p_dispute_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."rpc_get_or_create_chat_dispute_thread"("p_dispute_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."rpc_get_or_create_chat_office_thread"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rpc_get_or_create_chat_office_thread"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."rpc_get_or_create_chat_office_thread"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."rpc_get_or_create_chat_team_thread"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rpc_get_or_create_chat_team_thread"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."rpc_get_or_create_chat_team_thread"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."rpc_send_chat_message_with_attachments"("p_thread_id" "uuid", "p_client_message_id" "uuid", "p_body" "text", "p_reply_to_message_id" "uuid", "p_attachments" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rpc_send_chat_message_with_attachments"("p_thread_id" "uuid", "p_client_message_id" "uuid", "p_body" "text", "p_reply_to_message_id" "uuid", "p_attachments" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."rpc_send_chat_message_with_attachments"("p_thread_id" "uuid", "p_client_message_id" "uuid", "p_body" "text", "p_reply_to_message_id" "uuid", "p_attachments" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."rpc_update_chat_thread_inquiry_state"("p_thread_id" "uuid", "p_reviewed_at" bigint, "p_declined_at" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rpc_update_chat_thread_inquiry_state"("p_thread_id" "uuid", "p_reviewed_at" bigint, "p_declined_at" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."rpc_update_chat_thread_inquiry_state"("p_thread_id" "uuid", "p_reviewed_at" bigint, "p_declined_at" bigint) TO "service_role";



GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,MAINTAIN,UPDATE ON TABLE "public"."scan_quality_reports" TO "anon";
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,MAINTAIN,UPDATE ON TABLE "public"."scan_quality_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."scan_quality_reports" TO "service_role";



REVOKE ALL ON FUNCTION "public"."run_quality_engine"("p_scan_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."run_quality_engine"("p_scan_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."run_quality_engine"("p_scan_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."saved_reels_count_by_folder"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."saved_reels_count_by_folder"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."saved_reels_count_by_folder"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."settle_consensus_split"("p_dispute_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."settle_consensus_split"("p_dispute_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."settle_dispute_default"("p_dispute_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."settle_dispute_default"("p_dispute_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."settle_dispute_resolution"("p_dispute_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."settle_dispute_resolution"("p_dispute_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_can_convert_scan"("p_scan_id" "uuid", "p_uid" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_can_convert_scan"("p_scan_id" "uuid", "p_uid" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spatial_can_convert_scan"("p_scan_id" "uuid", "p_uid" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_can_edit_scan"("p_scan_id" "uuid", "p_uid" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_can_edit_scan"("p_scan_id" "uuid", "p_uid" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spatial_can_edit_scan"("p_scan_id" "uuid", "p_uid" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_can_edit_scene"("p_scene_id" "uuid", "p_uid" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_can_edit_scene"("p_scene_id" "uuid", "p_uid" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spatial_can_edit_scene"("p_scene_id" "uuid", "p_uid" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_can_view_mesh_snapshot"("p_object_name" "text", "p_uid" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_can_view_mesh_snapshot"("p_object_name" "text", "p_uid" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spatial_can_view_mesh_snapshot"("p_object_name" "text", "p_uid" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_can_view_scan"("p_scan_id" "uuid", "p_uid" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_can_view_scan"("p_scan_id" "uuid", "p_uid" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spatial_can_view_scan"("p_scan_id" "uuid", "p_uid" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_can_view_scene"("p_scene_id" "uuid", "p_uid" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_can_view_scene"("p_scene_id" "uuid", "p_uid" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spatial_can_view_scene"("p_scene_id" "uuid", "p_uid" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."spatial_canonical_dispute_lock_guard"() TO "anon";
GRANT ALL ON FUNCTION "public"."spatial_canonical_dispute_lock_guard"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."spatial_canonical_dispute_lock_guard"() TO "service_role";



GRANT ALL ON FUNCTION "public"."spatial_change_orders_immutable_cols_guard"() TO "anon";
GRANT ALL ON FUNCTION "public"."spatial_change_orders_immutable_cols_guard"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."spatial_change_orders_immutable_cols_guard"() TO "service_role";



GRANT ALL ON FUNCTION "public"."spatial_change_orders_status_fsm_guard"() TO "anon";
GRANT ALL ON FUNCTION "public"."spatial_change_orders_status_fsm_guard"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."spatial_change_orders_status_fsm_guard"() TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."spatial_scenes" TO "anon";
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,MAINTAIN,UPDATE ON TABLE "public"."spatial_scenes" TO "authenticated";
GRANT ALL ON TABLE "public"."spatial_scenes" TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_create_manual_scene"("p_id" "uuid", "p_presales_project_id" "uuid", "p_parametric_storage_path" "text", "p_parametric_sha256" "text", "p_parametric_size_bytes" integer, "p_origin" "text", "p_metadata" "jsonb", "p_schema_version" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_create_manual_scene"("p_id" "uuid", "p_presales_project_id" "uuid", "p_parametric_storage_path" "text", "p_parametric_sha256" "text", "p_parametric_size_bytes" integer, "p_origin" "text", "p_metadata" "jsonb", "p_schema_version" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spatial_create_manual_scene"("p_id" "uuid", "p_presales_project_id" "uuid", "p_parametric_storage_path" "text", "p_parametric_sha256" "text", "p_parametric_size_bytes" integer, "p_origin" "text", "p_metadata" "jsonb", "p_schema_version" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_create_scene"("p_id" "uuid", "p_parametric_storage_path" "text", "p_parametric_sha256" "text", "p_parametric_size_bytes" integer, "p_source_scan_id" "uuid", "p_source_job_id" "uuid", "p_schema_version" "text", "p_validation_state" "text", "p_validation_report" "jsonb", "p_is_renderable" boolean, "p_requires_user_confirmation" boolean, "p_metadata" "jsonb", "p_parent_scene_id" "uuid", "p_rescan_request_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_create_scene"("p_id" "uuid", "p_parametric_storage_path" "text", "p_parametric_sha256" "text", "p_parametric_size_bytes" integer, "p_source_scan_id" "uuid", "p_source_job_id" "uuid", "p_schema_version" "text", "p_validation_state" "text", "p_validation_report" "jsonb", "p_is_renderable" boolean, "p_requires_user_confirmation" boolean, "p_metadata" "jsonb", "p_parent_scene_id" "uuid", "p_rescan_request_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spatial_create_scene"("p_id" "uuid", "p_parametric_storage_path" "text", "p_parametric_sha256" "text", "p_parametric_size_bytes" integer, "p_source_scan_id" "uuid", "p_source_job_id" "uuid", "p_schema_version" "text", "p_validation_state" "text", "p_validation_report" "jsonb", "p_is_renderable" boolean, "p_requires_user_confirmation" boolean, "p_metadata" "jsonb", "p_parent_scene_id" "uuid", "p_rescan_request_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."spatial_dispute_lock_guard"() TO "anon";
GRANT ALL ON FUNCTION "public"."spatial_dispute_lock_guard"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."spatial_dispute_lock_guard"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_edit_history_append"("p_scene_id" "uuid", "p_variant_id" "text", "p_base_node_id" "text", "p_override_fields" "jsonb", "p_command" "text", "p_sha_before" "text", "p_sha_after" "text", "p_semantic_op" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_edit_history_append"("p_scene_id" "uuid", "p_variant_id" "text", "p_base_node_id" "text", "p_override_fields" "jsonb", "p_command" "text", "p_sha_before" "text", "p_sha_after" "text", "p_semantic_op" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spatial_edit_history_append"("p_scene_id" "uuid", "p_variant_id" "text", "p_base_node_id" "text", "p_override_fields" "jsonb", "p_command" "text", "p_sha_before" "text", "p_sha_after" "text", "p_semantic_op" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_get_convert_push_secret"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_get_convert_push_secret"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_idempotency_cleanup"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_idempotency_cleanup"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_is_customer_viewer"("p_scan_id" "uuid", "p_uid" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_is_customer_viewer"("p_scan_id" "uuid", "p_uid" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spatial_is_customer_viewer"("p_scan_id" "uuid", "p_uid" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_is_job_craftsman"("p_scan_id" "uuid", "p_uid" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_is_job_craftsman"("p_scan_id" "uuid", "p_uid" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spatial_is_job_craftsman"("p_scan_id" "uuid", "p_uid" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_is_job_worker"("p_scan_id" "uuid", "p_uid" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_is_job_worker"("p_scan_id" "uuid", "p_uid" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spatial_is_job_worker"("p_scan_id" "uuid", "p_uid" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_is_operator"("p_uid" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_is_operator"("p_uid" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spatial_is_operator"("p_uid" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_log_provider_share_action"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_log_provider_share_action"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_log_share_action"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_log_share_action"() TO "service_role";



GRANT ALL ON FUNCTION "public"."spatial_mesh_snapshot_scan_id"("p_object_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."spatial_mesh_snapshot_scan_id"("p_object_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spatial_mesh_snapshot_scan_id"("p_object_name" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_notify_convert_done"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_notify_convert_done"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_parametric_cleanup_dispatch"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_parametric_cleanup_dispatch"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_parametric_cleanup_list_orphans"("p_grace_days" integer, "p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_parametric_cleanup_list_orphans"("p_grace_days" integer, "p_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."spatial_parametric_scene_id"("p_object_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."spatial_parametric_scene_id"("p_object_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spatial_parametric_scene_id"("p_object_name" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_realtime_uuid_pat"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_realtime_uuid_pat"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."spatial_realtime_uuid_pat"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_reap_stuck_download_jobs"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_reap_stuck_download_jobs"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_rescan_request_respond"("p_request_id" "uuid", "p_status" "text", "p_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_rescan_request_respond"("p_request_id" "uuid", "p_status" "text", "p_note" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spatial_rescan_request_respond"("p_request_id" "uuid", "p_status" "text", "p_note" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_scan_broadcast"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_scan_broadcast"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_scan_cleanup_dispatch"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_scan_cleanup_dispatch"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_scan_cleanup_list_expired"("p_retention_days" integer, "p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_scan_cleanup_list_expired"("p_retention_days" integer, "p_limit" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_scan_cleanup_list_orphans"("p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_scan_cleanup_list_orphans"("p_limit" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_scan_event_broadcast"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_scan_event_broadcast"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_scan_is_locked"("p_scan_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_scan_is_locked"("p_scan_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spatial_scan_is_locked"("p_scan_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_scan_quality_broadcast"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_scan_quality_broadcast"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_scan_storage_path_ok"("p_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_scan_storage_path_ok"("p_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spatial_scan_storage_path_ok"("p_name" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."spatial_scenes_customer_verify_fsm_guard"() TO "anon";
GRANT ALL ON FUNCTION "public"."spatial_scenes_customer_verify_fsm_guard"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."spatial_scenes_customer_verify_fsm_guard"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_scenes_fill_provider_org"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_scenes_fill_provider_org"() TO "service_role";



GRANT ALL ON FUNCTION "public"."spatial_scenes_immutable_cols_guard"() TO "anon";
GRANT ALL ON FUNCTION "public"."spatial_scenes_immutable_cols_guard"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."spatial_scenes_immutable_cols_guard"() TO "service_role";



GRANT ALL ON FUNCTION "public"."spatial_scenes_validation_state_fsm_guard"() TO "anon";
GRANT ALL ON FUNCTION "public"."spatial_scenes_validation_state_fsm_guard"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."spatial_scenes_validation_state_fsm_guard"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_set_customer_verify_state"("p_scene_id" "uuid", "p_state" "text", "p_stage" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_set_customer_verify_state"("p_scene_id" "uuid", "p_state" "text", "p_stage" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."spatial_set_customer_verify_state"("p_scene_id" "uuid", "p_state" "text", "p_stage" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_user_org_owner_profile"("p_uid" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_user_org_owner_profile"("p_uid" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spatial_user_org_owner_profile"("p_uid" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_user_provider_org"("p_uid" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_user_provider_org"("p_uid" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spatial_user_provider_org"("p_uid" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_user_team_role"("p_uid" "uuid", "p_provider_org_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_user_team_role"("p_uid" "uuid", "p_provider_org_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."spatial_user_team_role"("p_uid" "uuid", "p_provider_org_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."spatial_verify_reminder_tick"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."spatial_verify_reminder_tick"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."start_trial"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."start_trial"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."start_trial"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."sync_provider_media_cover"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_provider_media_cover"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_provider_media_cover"() TO "service_role";



GRANT ALL ON FUNCTION "public"."time_entries_immutable_identity_trigger"() TO "anon";
GRANT ALL ON FUNCTION "public"."time_entries_immutable_identity_trigger"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."time_entries_immutable_identity_trigger"() TO "service_role";



GRANT ALL ON FUNCTION "public"."time_entries_reject_stamp_trigger"() TO "anon";
GRANT ALL ON FUNCTION "public"."time_entries_reject_stamp_trigger"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."time_entries_reject_stamp_trigger"() TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_provider_search_vector"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_provider_search_vector"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_provider_search_vector"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."update_team_member"("p_member_id" "uuid", "p_full_name" "text", "p_role" "text", "p_phone" "text", "p_email" "text", "p_weekly_target_hours" numeric, "p_daily_target_hours" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_team_member"("p_member_id" "uuid", "p_full_name" "text", "p_role" "text", "p_phone" "text", "p_email" "text", "p_weekly_target_hours" numeric, "p_daily_target_hours" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_team_member"("p_member_id" "uuid", "p_full_name" "text", "p_role" "text", "p_phone" "text", "p_email" "text", "p_weekly_target_hours" numeric, "p_daily_target_hours" numeric) TO "service_role";



GRANT ALL ON TABLE "public"."absences" TO "anon";
GRANT ALL ON TABLE "public"."absences" TO "authenticated";
GRANT ALL ON TABLE "public"."absences" TO "service_role";



GRANT ALL ON TABLE "public"."acceptances" TO "anon";
GRANT ALL ON TABLE "public"."acceptances" TO "authenticated";
GRANT ALL ON TABLE "public"."acceptances" TO "service_role";



GRANT ALL ON TABLE "public"."account_deletion_log" TO "service_role";



GRANT ALL ON TABLE "public"."analytics_events" TO "anon";
GRANT ALL ON TABLE "public"."analytics_events" TO "authenticated";
GRANT ALL ON TABLE "public"."analytics_events" TO "service_role";



GRANT ALL ON TABLE "public"."attribution_audit_log" TO "anon";
GRANT ALL ON TABLE "public"."attribution_audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."attribution_audit_log" TO "service_role";



GRANT ALL ON TABLE "public"."calendar_entries" TO "anon";
GRANT ALL ON TABLE "public"."calendar_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."calendar_entries" TO "service_role";



GRANT ALL ON SEQUENCE "public"."cancellation_invoice_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."cancellation_invoice_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."cancellation_invoice_seq" TO "service_role";



GRANT ALL ON TABLE "public"."change_orders" TO "anon";
GRANT ALL ON TABLE "public"."change_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."change_orders" TO "service_role";



GRANT ALL ON TABLE "public"."chat_attachments" TO "service_role";
GRANT SELECT,INSERT ON TABLE "public"."chat_attachments" TO "authenticated";



GRANT ALL ON TABLE "public"."chat_messages" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."chat_messages" TO "authenticated";



GRANT ALL ON TABLE "public"."chat_participants" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."chat_participants" TO "authenticated";



GRANT ALL ON TABLE "public"."chat_thread_migration_status" TO "service_role";
GRANT SELECT ON TABLE "public"."chat_thread_migration_status" TO "authenticated";



GRANT ALL ON TABLE "public"."chat_threads" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."chat_threads" TO "authenticated";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."company_code_audit" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."company_code_audit" TO "authenticated";
GRANT ALL ON TABLE "public"."company_code_audit" TO "service_role";



GRANT ALL ON TABLE "public"."company_join_codes" TO "anon";
GRANT ALL ON TABLE "public"."company_join_codes" TO "authenticated";
GRANT ALL ON TABLE "public"."company_join_codes" TO "service_role";



GRANT MAINTAIN ON TABLE "public"."conversations" TO "anon";
GRANT SELECT,MAINTAIN ON TABLE "public"."conversations" TO "authenticated";
GRANT ALL ON TABLE "public"."conversations" TO "service_role";



GRANT ALL ON TABLE "public"."correction_requests" TO "anon";
GRANT ALL ON TABLE "public"."correction_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."correction_requests" TO "service_role";



GRANT ALL ON TABLE "public"."craftsman_profiles" TO "anon";
GRANT ALL ON TABLE "public"."craftsman_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."craftsman_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."craftsman_subscriptions" TO "anon";
GRANT ALL ON TABLE "public"."craftsman_subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."craftsman_subscriptions" TO "service_role";



GRANT ALL ON SEQUENCE "public"."credit_note_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."credit_note_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."credit_note_seq" TO "service_role";



GRANT ALL ON TABLE "public"."customer_billing_profiles" TO "anon";
GRANT ALL ON TABLE "public"."customer_billing_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."customer_billing_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."customer_provider_relationships" TO "anon";
GRANT ALL ON TABLE "public"."customer_provider_relationships" TO "authenticated";
GRANT ALL ON TABLE "public"."customer_provider_relationships" TO "service_role";



GRANT ALL ON TABLE "public"."customer_request_sends" TO "anon";
GRANT ALL ON TABLE "public"."customer_request_sends" TO "authenticated";
GRANT ALL ON TABLE "public"."customer_request_sends" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."providers" TO "anon";
GRANT ALL ON TABLE "public"."providers" TO "authenticated";
GRANT ALL ON TABLE "public"."providers" TO "service_role";



GRANT ALL ON TABLE "public"."ratings" TO "anon";
GRANT ALL ON TABLE "public"."ratings" TO "authenticated";
GRANT ALL ON TABLE "public"."ratings" TO "service_role";



GRANT SELECT,MAINTAIN ON TABLE "public"."discovery_providers" TO "anon";
GRANT SELECT,MAINTAIN ON TABLE "public"."discovery_providers" TO "authenticated";
GRANT ALL ON TABLE "public"."discovery_providers" TO "service_role";



GRANT ALL ON TABLE "public"."disputes" TO "anon";
GRANT ALL ON TABLE "public"."disputes" TO "authenticated";
GRANT ALL ON TABLE "public"."disputes" TO "service_role";



GRANT ALL ON TABLE "public"."jobs" TO "anon";
GRANT ALL ON TABLE "public"."jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."jobs" TO "service_role";



GRANT ALL ON TABLE "public"."payments" TO "anon";
GRANT ALL ON TABLE "public"."payments" TO "authenticated";
GRANT ALL ON TABLE "public"."payments" TO "service_role";



GRANT MAINTAIN ON TABLE "public"."dispute_details" TO "anon";
GRANT MAINTAIN ON TABLE "public"."dispute_details" TO "authenticated";
GRANT ALL ON TABLE "public"."dispute_details" TO "service_role";



GRANT ALL ON TABLE "public"."dispute_evidence" TO "anon";
GRANT ALL ON TABLE "public"."dispute_evidence" TO "authenticated";
GRANT ALL ON TABLE "public"."dispute_evidence" TO "service_role";



GRANT MAINTAIN ON TABLE "public"."dispute_ops_overview" TO "anon";
GRANT MAINTAIN ON TABLE "public"."dispute_ops_overview" TO "authenticated";
GRANT ALL ON TABLE "public"."dispute_ops_overview" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."dispute_spatial_evidence" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."dispute_spatial_evidence" TO "authenticated";
GRANT ALL ON TABLE "public"."dispute_spatial_evidence" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."dispute_split_proposals" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."dispute_split_proposals" TO "authenticated";
GRANT ALL ON TABLE "public"."dispute_split_proposals" TO "service_role";



GRANT ALL ON TABLE "public"."dispute_status_history" TO "anon";
GRANT ALL ON TABLE "public"."dispute_status_history" TO "authenticated";
GRANT ALL ON TABLE "public"."dispute_status_history" TO "service_role";



GRANT ALL ON TABLE "public"."email_delivery_log" TO "anon";
GRANT ALL ON TABLE "public"."email_delivery_log" TO "authenticated";
GRANT ALL ON TABLE "public"."email_delivery_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."email_delivery_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."email_delivery_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."email_delivery_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."escrow_payment_plans" TO "anon";
GRANT ALL ON TABLE "public"."escrow_payment_plans" TO "authenticated";
GRANT ALL ON TABLE "public"."escrow_payment_plans" TO "service_role";



GRANT ALL ON TABLE "public"."escrow_tranches" TO "anon";
GRANT ALL ON TABLE "public"."escrow_tranches" TO "authenticated";
GRANT ALL ON TABLE "public"."escrow_tranches" TO "service_role";



GRANT REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."failed_join_attempts" TO "anon";
GRANT REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."failed_join_attempts" TO "authenticated";
GRANT ALL ON TABLE "public"."failed_join_attempts" TO "service_role";



GRANT ALL ON TABLE "public"."funding_requests" TO "anon";
GRANT ALL ON TABLE "public"."funding_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."funding_requests" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."internal_messages" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."internal_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."internal_messages" TO "service_role";



GRANT ALL ON SEQUENCE "public"."invoice_number_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."invoice_number_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."invoice_number_seq" TO "service_role";



GRANT ALL ON TABLE "public"."invoices" TO "anon";
GRANT ALL ON TABLE "public"."invoices" TO "authenticated";
GRANT ALL ON TABLE "public"."invoices" TO "service_role";



GRANT ALL ON TABLE "public"."job_assignments" TO "anon";
GRANT ALL ON TABLE "public"."job_assignments" TO "authenticated";
GRANT ALL ON TABLE "public"."job_assignments" TO "service_role";



GRANT ALL ON TABLE "public"."team_members" TO "anon";
GRANT ALL ON TABLE "public"."team_members" TO "authenticated";
GRANT ALL ON TABLE "public"."team_members" TO "service_role";



GRANT MAINTAIN ON TABLE "public"."job_assignment_details" TO "anon";
GRANT MAINTAIN ON TABLE "public"."job_assignment_details" TO "authenticated";
GRANT ALL ON TABLE "public"."job_assignment_details" TO "service_role";



GRANT MAINTAIN ON TABLE "public"."job_details" TO "anon";
GRANT MAINTAIN ON TABLE "public"."job_details" TO "authenticated";
GRANT ALL ON TABLE "public"."job_details" TO "service_role";



GRANT ALL ON TABLE "public"."job_feedback" TO "anon";
GRANT ALL ON TABLE "public"."job_feedback" TO "authenticated";
GRANT ALL ON TABLE "public"."job_feedback" TO "service_role";



GRANT MAINTAIN ON TABLE "public"."job_integrity_overview" TO "anon";
GRANT MAINTAIN ON TABLE "public"."job_integrity_overview" TO "authenticated";
GRANT ALL ON TABLE "public"."job_integrity_overview" TO "service_role";



GRANT ALL ON TABLE "public"."job_photos" TO "anon";
GRANT ALL ON TABLE "public"."job_photos" TO "authenticated";
GRANT ALL ON TABLE "public"."job_photos" TO "service_role";



GRANT ALL ON TABLE "public"."job_reports" TO "anon";
GRANT ALL ON TABLE "public"."job_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."job_reports" TO "service_role";



GRANT ALL ON TABLE "public"."ledger_entries" TO "anon";
GRANT ALL ON TABLE "public"."ledger_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."ledger_entries" TO "service_role";



GRANT ALL ON TABLE "public"."media_artifacts" TO "anon";
GRANT ALL ON TABLE "public"."media_artifacts" TO "authenticated";
GRANT ALL ON TABLE "public"."media_artifacts" TO "service_role";



GRANT ALL ON TABLE "public"."media_uploads" TO "anon";
GRANT ALL ON TABLE "public"."media_uploads" TO "authenticated";
GRANT ALL ON TABLE "public"."media_uploads" TO "service_role";



GRANT ALL ON TABLE "public"."message_thread_participants" TO "anon";
GRANT ALL ON TABLE "public"."message_thread_participants" TO "authenticated";
GRANT ALL ON TABLE "public"."message_thread_participants" TO "service_role";



GRANT ALL ON TABLE "public"."message_threads" TO "anon";
GRANT ALL ON TABLE "public"."message_threads" TO "authenticated";
GRANT ALL ON TABLE "public"."message_threads" TO "service_role";



GRANT MAINTAIN ON TABLE "public"."messages" TO "anon";
GRANT SELECT,MAINTAIN ON TABLE "public"."messages" TO "authenticated";
GRANT ALL ON TABLE "public"."messages" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."moderation_action_log" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."moderation_action_log" TO "authenticated";
GRANT ALL ON TABLE "public"."moderation_action_log" TO "service_role";



GRANT ALL ON TABLE "public"."notification_device_tokens" TO "anon";
GRANT ALL ON TABLE "public"."notification_device_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_device_tokens" TO "service_role";



GRANT SELECT,INSERT,MAINTAIN,UPDATE ON TABLE "public"."notification_signals" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_signals" TO "service_role";



GRANT ALL ON TABLE "public"."operator_action_audit" TO "anon";
GRANT ALL ON TABLE "public"."operator_action_audit" TO "authenticated";
GRANT ALL ON TABLE "public"."operator_action_audit" TO "service_role";



GRANT ALL ON TABLE "public"."owner_notes" TO "anon";
GRANT ALL ON TABLE "public"."owner_notes" TO "authenticated";
GRANT ALL ON TABLE "public"."owner_notes" TO "service_role";



GRANT ALL ON TABLE "public"."parametric_cleanup_log" TO "service_role";



GRANT MAINTAIN ON TABLE "public"."payment_details" TO "anon";
GRANT MAINTAIN ON TABLE "public"."payment_details" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_details" TO "service_role";



GRANT MAINTAIN ON TABLE "public"."payment_lifecycle_overview" TO "anon";
GRANT MAINTAIN ON TABLE "public"."payment_lifecycle_overview" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_lifecycle_overview" TO "service_role";



GRANT ALL ON TABLE "public"."stripe_events" TO "anon";
GRANT ALL ON TABLE "public"."stripe_events" TO "authenticated";
GRANT ALL ON TABLE "public"."stripe_events" TO "service_role";



GRANT MAINTAIN ON TABLE "public"."payment_reconciliation_details" TO "anon";
GRANT MAINTAIN ON TABLE "public"."payment_reconciliation_details" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_reconciliation_details" TO "service_role";



GRANT MAINTAIN ON TABLE "public"."payment_risk_overview" TO "anon";
GRANT MAINTAIN ON TABLE "public"."payment_risk_overview" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_risk_overview" TO "service_role";



GRANT ALL ON TABLE "public"."payment_status_history" TO "anon";
GRANT ALL ON TABLE "public"."payment_status_history" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_status_history" TO "service_role";



GRANT ALL ON TABLE "public"."projects" TO "anon";
GRANT ALL ON TABLE "public"."projects" TO "authenticated";
GRANT ALL ON TABLE "public"."projects" TO "service_role";



GRANT ALL ON TABLE "public"."provider_highlight_items" TO "anon";
GRANT ALL ON TABLE "public"."provider_highlight_items" TO "authenticated";
GRANT ALL ON TABLE "public"."provider_highlight_items" TO "service_role";



GRANT ALL ON TABLE "public"."provider_highlights" TO "anon";
GRANT ALL ON TABLE "public"."provider_highlights" TO "authenticated";
GRANT ALL ON TABLE "public"."provider_highlights" TO "service_role";



GRANT ALL ON TABLE "public"."provider_media" TO "anon";
GRANT ALL ON TABLE "public"."provider_media" TO "authenticated";
GRANT ALL ON TABLE "public"."provider_media" TO "service_role";



GRANT ALL ON TABLE "public"."provider_media_assets" TO "anon";
GRANT ALL ON TABLE "public"."provider_media_assets" TO "authenticated";
GRANT ALL ON TABLE "public"."provider_media_assets" TO "service_role";



GRANT ALL ON TABLE "public"."provider_media_comment_likes" TO "anon";
GRANT ALL ON TABLE "public"."provider_media_comment_likes" TO "authenticated";
GRANT ALL ON TABLE "public"."provider_media_comment_likes" TO "service_role";



GRANT ALL ON TABLE "public"."provider_media_comments" TO "anon";
GRANT ALL ON TABLE "public"."provider_media_comments" TO "authenticated";
GRANT ALL ON TABLE "public"."provider_media_comments" TO "service_role";



GRANT ALL ON TABLE "public"."provider_media_likes" TO "anon";
GRANT ALL ON TABLE "public"."provider_media_likes" TO "authenticated";
GRANT ALL ON TABLE "public"."provider_media_likes" TO "service_role";



GRANT ALL ON TABLE "public"."provider_media_saves" TO "anon";
GRANT ALL ON TABLE "public"."provider_media_saves" TO "authenticated";
GRANT ALL ON TABLE "public"."provider_media_saves" TO "service_role";



GRANT SELECT,MAINTAIN ON TABLE "public"."provider_media_tag_cooccur" TO "anon";
GRANT SELECT,MAINTAIN ON TABLE "public"."provider_media_tag_cooccur" TO "authenticated";
GRANT ALL ON TABLE "public"."provider_media_tag_cooccur" TO "service_role";



GRANT ALL ON TABLE "public"."provider_payout_accounts" TO "anon";
GRANT ALL ON TABLE "public"."provider_payout_accounts" TO "authenticated";
GRANT ALL ON TABLE "public"."provider_payout_accounts" TO "service_role";



GRANT ALL ON TABLE "public"."provider_presales_projects" TO "authenticated";
GRANT ALL ON TABLE "public"."provider_presales_projects" TO "service_role";



GRANT ALL ON TABLE "public"."provider_saves" TO "anon";
GRANT ALL ON TABLE "public"."provider_saves" TO "authenticated";
GRANT ALL ON TABLE "public"."provider_saves" TO "service_role";



GRANT REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."push_action_audit" TO "anon";
GRANT REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."push_action_audit" TO "authenticated";
GRANT ALL ON TABLE "public"."push_action_audit" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."revenuecat_webhook_events" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."revenuecat_webhook_events" TO "authenticated";
GRANT ALL ON TABLE "public"."revenuecat_webhook_events" TO "service_role";



GRANT ALL ON TABLE "public"."saved_reel_folders" TO "anon";
GRANT ALL ON TABLE "public"."saved_reel_folders" TO "authenticated";
GRANT ALL ON TABLE "public"."saved_reel_folders" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,MAINTAIN,UPDATE ON TABLE "public"."scan_annotations" TO "anon";
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,MAINTAIN,UPDATE ON TABLE "public"."scan_annotations" TO "authenticated";
GRANT ALL ON TABLE "public"."scan_annotations" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,MAINTAIN,UPDATE ON TABLE "public"."scan_assets" TO "anon";
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,MAINTAIN,UPDATE ON TABLE "public"."scan_assets" TO "authenticated";
GRANT ALL ON TABLE "public"."scan_assets" TO "service_role";



GRANT ALL ON TABLE "public"."scan_cleanup_log" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,MAINTAIN,UPDATE ON TABLE "public"."scan_measurements" TO "anon";
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,MAINTAIN,UPDATE ON TABLE "public"."scan_measurements" TO "authenticated";
GRANT ALL ON TABLE "public"."scan_measurements" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,MAINTAIN,UPDATE ON TABLE "public"."scan_rooms" TO "anon";
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,MAINTAIN,UPDATE ON TABLE "public"."scan_rooms" TO "authenticated";
GRANT ALL ON TABLE "public"."scan_rooms" TO "service_role";



GRANT ALL ON TABLE "public"."scan_status_transition_allowed" TO "service_role";
GRANT SELECT ON TABLE "public"."scan_status_transition_allowed" TO "authenticated";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."scan_status_transition_log" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."scan_status_transition_log" TO "authenticated";
GRANT ALL ON TABLE "public"."scan_status_transition_log" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,MAINTAIN,UPDATE ON TABLE "public"."scan_surfaces" TO "anon";
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,MAINTAIN,UPDATE ON TABLE "public"."scan_surfaces" TO "authenticated";
GRANT ALL ON TABLE "public"."scan_surfaces" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,MAINTAIN,UPDATE ON TABLE "public"."scans" TO "anon";
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,MAINTAIN,UPDATE ON TABLE "public"."scans" TO "authenticated";
GRANT ALL ON TABLE "public"."scans" TO "service_role";



GRANT ALL ON TABLE "public"."schedules" TO "anon";
GRANT ALL ON TABLE "public"."schedules" TO "authenticated";
GRANT ALL ON TABLE "public"."schedules" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."spatial_assets" TO "anon";
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,MAINTAIN,UPDATE ON TABLE "public"."spatial_assets" TO "authenticated";
GRANT ALL ON TABLE "public"."spatial_assets" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."spatial_change_orders" TO "anon";
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,MAINTAIN,UPDATE ON TABLE "public"."spatial_change_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."spatial_change_orders" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."spatial_edit_history" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."spatial_edit_history" TO "authenticated";
GRANT ALL ON TABLE "public"."spatial_edit_history" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."spatial_materials" TO "anon";
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,MAINTAIN,UPDATE ON TABLE "public"."spatial_materials" TO "authenticated";
GRANT ALL ON TABLE "public"."spatial_materials" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."spatial_node_links" TO "anon";
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,MAINTAIN,UPDATE ON TABLE "public"."spatial_node_links" TO "authenticated";
GRANT ALL ON TABLE "public"."spatial_node_links" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."spatial_node_overrides" TO "anon";
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,MAINTAIN,UPDATE ON TABLE "public"."spatial_node_overrides" TO "authenticated";
GRANT ALL ON TABLE "public"."spatial_node_overrides" TO "service_role";



GRANT ALL ON TABLE "public"."spatial_pin_reviews" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."spatial_pin_reviews" TO "authenticated";



GRANT ALL ON TABLE "public"."spatial_rescan_requests" TO "service_role";
GRANT SELECT,INSERT ON TABLE "public"."spatial_rescan_requests" TO "authenticated";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."spatial_share_audit" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."spatial_share_audit" TO "authenticated";
GRANT ALL ON TABLE "public"."spatial_share_audit" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."stripe_webhook_events" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."stripe_webhook_events" TO "authenticated";
GRANT ALL ON TABLE "public"."stripe_webhook_events" TO "service_role";



GRANT ALL ON TABLE "public"."subscription_withdrawal_consents" TO "service_role";
GRANT SELECT,INSERT ON TABLE "public"."subscription_withdrawal_consents" TO "authenticated";



GRANT ALL ON TABLE "public"."supplementary_payment_requests" TO "anon";
GRANT ALL ON TABLE "public"."supplementary_payment_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."supplementary_payment_requests" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."team_member_audit" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."team_member_audit" TO "authenticated";
GRANT ALL ON TABLE "public"."team_member_audit" TO "service_role";



GRANT MAINTAIN ON TABLE "public"."team_member_details" TO "anon";
GRANT MAINTAIN ON TABLE "public"."team_member_details" TO "authenticated";
GRANT ALL ON TABLE "public"."team_member_details" TO "service_role";



GRANT ALL ON TABLE "public"."thread_artifacts" TO "anon";
GRANT ALL ON TABLE "public"."thread_artifacts" TO "authenticated";
GRANT ALL ON TABLE "public"."thread_artifacts" TO "service_role";



GRANT ALL ON TABLE "public"."time_entries" TO "anon";
GRANT ALL ON TABLE "public"."time_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."time_entries" TO "service_role";



GRANT SELECT,INSERT,MAINTAIN,UPDATE ON TABLE "public"."timeline_signals" TO "authenticated";
GRANT ALL ON TABLE "public"."timeline_signals" TO "service_role";



GRANT ALL ON TABLE "public"."user_blocks" TO "anon";
GRANT ALL ON TABLE "public"."user_blocks" TO "authenticated";
GRANT ALL ON TABLE "public"."user_blocks" TO "service_role";



GRANT ALL ON TABLE "public"."user_notification_preferences" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."user_notification_preferences" TO "authenticated";



GRANT ALL ON TABLE "public"."user_reports" TO "anon";
GRANT ALL ON TABLE "public"."user_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."user_reports" TO "service_role";



GRANT SELECT,MAINTAIN ON TABLE "public"."visible_discovery_providers" TO "anon";
GRANT SELECT,MAINTAIN ON TABLE "public"."visible_discovery_providers" TO "authenticated";
GRANT ALL ON TABLE "public"."visible_discovery_providers" TO "service_role";



GRANT ALL ON TABLE "public"."widerruf_requests" TO "service_role";
GRANT SELECT,INSERT ON TABLE "public"."widerruf_requests" TO "authenticated";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







