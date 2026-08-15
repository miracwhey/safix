-- =============================================================================
-- Hardening M13 (Audit 2026-07-06): Account-Loeschung PII-Freitext-Redaktion.
-- Redaktions-Scope finalisiert (Leon 2026-07-06):
--   SCRUB: jobs(description/notes/intake_context/proposal_timing_note),
--          projects(description/room_scan_metadata),
--          disputes(description/reason/context_snapshot), job_feedback(note)
--   KEEP:  disputes(metadata=Evidence, resolution_note=Operator-Entscheidung),
--          ratings(rating_comment + customer_user_id, pseudonym),
--          Rechnungs-Snapshots (§14 UStG), grobe Location, Money-Diagnostik.
-- Live-verifiziert: alle Spalten existieren; disputes.reason ist Freitext.
-- Applied to prod itdntawwuzqfwmcwnwjr as 20260706093208.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.account_anonymize_owned_pii(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v jsonb := '{}'::jsonb;
  n integer;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'account_anonymize_owned_pii: p_user_id is required' USING errcode = '22023';
  END IF;

  -- job_feedback ZUERST -- solange der jobs->customer-Link noch lebt.
  UPDATE public.job_feedback
    SET note = NULL
    WHERE note IS NOT NULL AND job_id IN (
      SELECT id FROM public.jobs
      WHERE customer_profile_id = p_user_id OR customer_user_id = p_user_id);
  GET DIAGNOSTICS n = row_count; v := v || jsonb_build_object('job_feedback_scrubbed', n);

  -- jobs -- SCRUB customer-Name + Freitext/jsonb; KEEP title + location (grob).
  UPDATE public.jobs
    SET customer = 'Gelöschter Nutzer',
        customer_profile_id = NULL,
        customer_user_id = NULL,
        description = CASE WHEN description IS NOT NULL THEN 'Gelöscht (Nutzerkonto entfernt)' END,
        notes = CASE WHEN notes IS NOT NULL THEN '{}'::jsonb END,
        intake_context = CASE WHEN intake_context IS NOT NULL THEN '{}'::jsonb END,
        proposal_timing_note = CASE WHEN proposal_timing_note IS NOT NULL THEN NULL END
    WHERE customer_profile_id = p_user_id OR customer_user_id = p_user_id;
  GET DIAGNOSTICS n = row_count; v := v || jsonb_build_object('jobs_anonymized', n);

  -- projects -- SCRUB description + room_scan_metadata; KEEP title/location grob.
  UPDATE public.projects
    SET customer_profile_id = NULL,
        customer_user_id = NULL,
        description = CASE WHEN description IS NOT NULL THEN 'Gelöscht (Nutzerkonto entfernt)' END,
        room_scan_metadata = CASE WHEN room_scan_metadata IS NOT NULL THEN '{}'::jsonb END
    WHERE customer_profile_id = p_user_id OR customer_user_id = p_user_id;
  GET DIAGNOSTICS n = row_count; v := v || jsonb_build_object('projects_anonymized', n);

  -- disputes -- SCRUB Kunden-Freitext; KEEP metadata (Evidence) + resolution_note.
  UPDATE public.disputes
    SET description = CASE WHEN description IS NOT NULL THEN 'Gelöscht (Nutzerkonto entfernt)' END,
        reason = CASE WHEN reason IS NOT NULL THEN 'deleted_account' END,
        context_snapshot = CASE WHEN context_snapshot IS NOT NULL THEN '{}'::jsonb END
    WHERE customer_profile_id = p_user_id;
  GET DIAGNOSTICS n = row_count; v := v || jsonb_build_object('disputes_anonymized', n);

  -- ratings -- KEEP (kein UPDATE): rating_comment = Betriebs-Interesse;
  -- customer_user_id NOT NULL + kein FK -> nach Profil-Loeschung pseudonym.

  RETURN v;
END;
$$;

COMMENT ON FUNCTION public.account_anonymize_owned_pii(uuid) IS
  'Block 2 + M13 · Skrubbt denormalisierte Kunden-PII (Name + Freitext/jsonb) auf '
  'RETAINED Records (job_feedback/jobs/projects/disputes-Kundenfreitext) bei Account-'
  'Loeschung. KEEP: dispute-Evidence+Entscheidung (Beweisakte), ratings (Betriebs-'
  'Reputation, pseudonym), Rechnungs-Snapshots (§14 UStG), grobe Location, Money-Diagnostik.';

REVOKE ALL ON FUNCTION public.account_anonymize_owned_pii(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_anonymize_owned_pii(uuid) TO service_role;

-- Backfill bestehende retained 'Geloeschter Nutzer'-Rows (Impact 06.07.: 1 job).
UPDATE public.jobs
  SET description = CASE WHEN description IS NOT NULL AND description <> 'Gelöscht (Nutzerkonto entfernt)'
                        THEN 'Gelöscht (Nutzerkonto entfernt)' ELSE description END,
      notes = CASE WHEN notes IS NOT NULL AND notes <> '{}'::jsonb THEN '{}'::jsonb ELSE notes END,
      intake_context = CASE WHEN intake_context IS NOT NULL AND intake_context <> '{}'::jsonb THEN '{}'::jsonb ELSE intake_context END,
      proposal_timing_note = NULL
  WHERE customer_profile_id IS NULL AND customer = 'Gelöschter Nutzer';

NOTIFY pgrst, 'reload schema';
