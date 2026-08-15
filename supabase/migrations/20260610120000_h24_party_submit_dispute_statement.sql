-- H24 (Variante A'): party_submit_dispute_statement SECDEF-RPC + Sentinel-GUC im Trigger-Guard
-- Geschrieben gegen LIVE-Prod-Definitionen vom 2026-06-10 (itdntawwuzqfwmcwnwjr).
--
-- Problem: disputes_status_change_guard_tg (BEFORE UPDATE) wirft 42501 für jede
-- Party, die ihr Statement submitted und dabei *_waiting → under_review flippen
-- will. RLS (disputes_update_own_side) erlaubt das UPDATE — der Trigger ist der
-- einzige Blocker. Plain SECURITY DEFINER hilft nicht: auth.uid() liest das
-- JWT-GUC und bleibt auch unter SECDEF die Party-UID.
--
-- Fix: transaction-locales Sentinel-GUC `fixup.dispute_party_transition`,
-- gesetzt AUSSCHLIESSLICH von der neuen RPC, akzeptiert vom Guard NUR für
-- exakt customer_waiting/provider_waiting → under_review ohne Bewegung
-- anderer Lifecycle-Felder.

-- 1) Trigger-Guard erweitern: Sentinel-Branch NUR für *_waiting → under_review,
--    alle anderen Lifecycle-Felder müssen unbewegt sein. Allow-Gate (kein IF NOT):
--    current_setting(..., true) liefert NULL wenn unset → COALESCE('') ≠ 'allow'
--    → Branch nicht genommen → safe deny. Kein NULL-Poisoning möglich.
CREATE OR REPLACE FUNCTION public.disputes_status_change_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status            IS NOT DISTINCT FROM OLD.status
     AND NEW.decision        IS NOT DISTINCT FROM OLD.decision
     AND NEW.resolution_type IS NOT DISTINCT FROM OLD.resolution_type
     AND NEW.split_ratio     IS NOT DISTINCT FROM OLD.split_ratio
     AND NEW.settlement_status IS NOT DISTINCT FROM OLD.settlement_status
     AND NEW.resolved_at     IS NOT DISTINCT FROM OLD.resolved_at
     AND NEW.closed_at       IS NOT DISTINCT FROM OLD.closed_at
  THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF public.is_current_user_operator() THEN
    RETURN NEW;
  END IF;

  -- H24: party statement submit. Admitted ONLY when the SECURITY DEFINER RPC
  -- party_submit_dispute_statement armed the transaction-local sentinel AND
  -- the change is exactly customer_waiting/provider_waiting -> under_review
  -- with every other lifecycle field untouched.
  IF COALESCE(current_setting('fixup.dispute_party_transition', true), '') = 'allow'
     AND OLD.status IN ('customer_waiting', 'provider_waiting')
     AND NEW.status = 'under_review'
     AND NEW.decision          IS NOT DISTINCT FROM OLD.decision
     AND NEW.resolution_type   IS NOT DISTINCT FROM OLD.resolution_type
     AND NEW.split_ratio       IS NOT DISTINCT FROM OLD.split_ratio
     AND NEW.settlement_status IS NOT DISTINCT FROM OLD.settlement_status
     AND NEW.resolved_at       IS NOT DISTINCT FROM OLD.resolved_at
     AND NEW.closed_at         IS NOT DISTINCT FROM OLD.closed_at
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'unauthorized: only operators can change dispute lifecycle fields'
    USING ERRCODE = '42501';
END;
$function$;

-- 2) Party-RPC: Ownership-Check IN der RPC (auth.uid() = die Party deren
--    Statement aussteht), Evidence-Append in metadata.evidence, Status-Flip,
--    History (source='client'), jobs-Mirror. Naming folgt operator_*-Bestand.
CREATE OR REPLACE FUNCTION public.party_submit_dispute_statement(
  p_dispute_id uuid,
  p_evidence   jsonb
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

-- CREATE FUNCTION grantet default EXECUTE an PUBLIC/anon -> explizit dichtmachen.
REVOKE ALL ON FUNCTION public.party_submit_dispute_statement(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.party_submit_dispute_statement(uuid, jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
