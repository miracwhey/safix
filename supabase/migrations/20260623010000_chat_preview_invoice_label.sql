-- =============================================================================
-- chat last-message preview: add the Invoice (Rechnung) artifact label
-- =============================================================================
--
-- Block 2 adds an 'Invoice' artifact_card producer (markInvoiceSent →
-- emitInvoiceArtifactOnIssue). Without a preview branch, an invoice card as the
-- latest thread message renders the generic '[Anhang]' fallback in the
-- thread-list last-message line instead of '[Rechnung]'.
--
-- The preview logic was refactored on prod into the single shared, IMMUTABLE
-- SQL helper public.fn_chat_message_preview_body(...), which BOTH the INSERT
-- trigger (fn_chat_update_thread_last_message) and the on-update trigger
-- delegate to. So a one-line change here fixes both paths.
--
-- Body reproduced byte-for-byte from the LIVE prod definition (pg_get_functiondef,
-- NOT the drifted migration files), with only the '[Rechnung]' branch added —
-- mirroring ChatArtifactCardCompact's TYPE_LABEL.Invoice = 'Rechnung'.
--
-- Idempotent: CREATE OR REPLACE. Rollback = re-create without the Invoice branch
-- (invoice cards revert to '[Anhang]').
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_chat_message_preview_body(p_message_type text, p_artifact_type text, p_body text, p_deleted_at bigint, p_redacted boolean)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN p_deleted_at IS NOT NULL      THEN NULL
    WHEN p_redacted                    THEN NULL
    WHEN p_message_type = 'image'      THEN '[Bild]'
    WHEN p_message_type = 'document'   THEN '[Dokument]'
    WHEN p_message_type = 'voice'      THEN '[Sprachnachricht]'
    WHEN p_message_type = 'video'      THEN '[Video]'
    WHEN p_message_type = 'mixed'      THEN '[Anhang]'
    WHEN p_message_type = 'artifact_card' THEN
      CASE p_artifact_type
        WHEN 'Project'      THEN '[Projekt]'
        WHEN 'OfferPayment' THEN '[Angebot]'
        WHEN 'FundingStep'  THEN '[Zahlung]'
        WHEN 'ChangeOrder'  THEN '[Nachtrag]'
        WHEN 'Invoice'      THEN '[Rechnung]'
        ELSE '[Anhang]'
      END
    WHEN p_message_type = 'system'     THEN p_body
    ELSE p_body
  END;
$function$;
