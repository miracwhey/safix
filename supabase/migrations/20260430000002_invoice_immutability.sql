-- Block 7.1G — Invoice DB-Immutability
--
-- §14 UStG verlangt, dass eine erteilte Rechnung nicht nachträglich in
-- rechnungsrelevanten Daten verändert wird. Korrekturen entstehen als
-- eigenständige Belege (Storno = kind='cancellation', Gutschrift =
-- kind='credit_note') und werden per INSERT angelegt; die Originalrechnung
-- bleibt unangetastet.
--
-- Engine + Workflow setzen das App-seitig durch. Dieser Trigger zieht das
-- Invariant auf die DB-Ebene, damit kein direkter Repository-Bypass und kein
-- versehentlicher Spalten-Update die Snapshot-/Betragsfelder einer bereits
-- ausgestellten Rechnung modifiziert.
--
-- Erlaubte Status-Übergänge auf einer ausgestellten Rechnung:
--   issued → sent
--   issued → paid
--   sent   → paid
-- Alles andere (insbesondere * → cancelled auf der Originalrechnung sowie
-- jeder Rückwärtsgang) ist blockiert. Cancellation läuft ausschließlich über
-- INSERT eines neuen Belegs mit kind='cancellation'.
--
-- sent_at darf einmalig 0 → >0 gesetzt werden (Setzpunkt beim issued→sent
-- Übergang) und ist danach immutable.
--
-- refund_event_id darf nach Issuance gesetzt werden (Stripe-/Audit-Anker auf
-- Korrekturbelegen); Beträge und Snapshots bleiben immutable.
--
-- updated_at darf jederzeit mutieren (technisches Feld).
--
-- Drafts (status='draft') bleiben frei editierbar.

CREATE OR REPLACE FUNCTION public.enforce_invoice_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  immutable_violations text[] := ARRAY[]::text[];
BEGIN
  -- Drafts: keine Beschränkung. Issuance-Flow überschreibt Felder im selben UPDATE.
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  -- Status-Whitelist erzwingen, sobald Rechnung das Draft-Stadium verlassen hat.
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

  -- Snapshot-/§14-/Amount-Felder: nach Issuance immutable.
  IF OLD.invoice_number IS DISTINCT FROM NEW.invoice_number THEN
    immutable_violations := array_append(immutable_violations, 'invoice_number');
  END IF;
  IF OLD.issued_at IS DISTINCT FROM NEW.issued_at THEN
    immutable_violations := array_append(immutable_violations, 'issued_at');
  END IF;
  IF OLD.issued_at_label IS DISTINCT FROM NEW.issued_at_label THEN
    immutable_violations := array_append(immutable_violations, 'issued_at_label');
  END IF;
  IF OLD.due_at_label IS DISTINCT FROM NEW.due_at_label THEN
    immutable_violations := array_append(immutable_violations, 'due_at_label');
  END IF;
  -- sent_at: einmalig 0 → >0 setzbar, danach immutable.
  IF OLD.sent_at <> 0 AND OLD.sent_at IS DISTINCT FROM NEW.sent_at THEN
    immutable_violations := array_append(immutable_violations, 'sent_at');
  END IF;
  IF OLD.parties IS DISTINCT FROM NEW.parties THEN
    immutable_violations := array_append(immutable_violations, 'parties');
  END IF;
  IF OLD.provider_snapshot IS DISTINCT FROM NEW.provider_snapshot THEN
    immutable_violations := array_append(immutable_violations, 'provider_snapshot');
  END IF;
  IF OLD.customer_snapshot IS DISTINCT FROM NEW.customer_snapshot THEN
    immutable_violations := array_append(immutable_violations, 'customer_snapshot');
  END IF;
  IF OLD.line_items IS DISTINCT FROM NEW.line_items THEN
    immutable_violations := array_append(immutable_violations, 'line_items');
  END IF;
  IF OLD.amounts IS DISTINCT FROM NEW.amounts THEN
    immutable_violations := array_append(immutable_violations, 'amounts');
  END IF;
  IF OLD.tax_breakdown IS DISTINCT FROM NEW.tax_breakdown THEN
    immutable_violations := array_append(immutable_violations, 'tax_breakdown');
  END IF;
  IF OLD.tax_note IS DISTINCT FROM NEW.tax_note THEN
    immutable_violations := array_append(immutable_violations, 'tax_note');
  END IF;
  IF OLD.service_period_from IS DISTINCT FROM NEW.service_period_from THEN
    immutable_violations := array_append(immutable_violations, 'service_period_from');
  END IF;
  IF OLD.service_period_to IS DISTINCT FROM NEW.service_period_to THEN
    immutable_violations := array_append(immutable_violations, 'service_period_to');
  END IF;
  IF OLD.service_period_label IS DISTINCT FROM NEW.service_period_label THEN
    immutable_violations := array_append(immutable_violations, 'service_period_label');
  END IF;
  IF OLD.source_offer_id IS DISTINCT FROM NEW.source_offer_id THEN
    immutable_violations := array_append(immutable_violations, 'source_offer_id');
  END IF;
  IF OLD.source_change_order_ids IS DISTINCT FROM NEW.source_change_order_ids THEN
    immutable_violations := array_append(immutable_violations, 'source_change_order_ids');
  END IF;
  IF OLD.source_supplementary_payment_ids IS DISTINCT FROM NEW.source_supplementary_payment_ids THEN
    immutable_violations := array_append(immutable_violations, 'source_supplementary_payment_ids');
  END IF;
  IF OLD.kind IS DISTINCT FROM NEW.kind THEN
    immutable_violations := array_append(immutable_violations, 'kind');
  END IF;
  IF OLD.original_invoice_id IS DISTINCT FROM NEW.original_invoice_id THEN
    immutable_violations := array_append(immutable_violations, 'original_invoice_id');
  END IF;
  IF OLD.correction_reason IS DISTINCT FROM NEW.correction_reason THEN
    immutable_violations := array_append(immutable_violations, 'correction_reason');
  END IF;
  IF OLD.correction_amount_cents IS DISTINCT FROM NEW.correction_amount_cents THEN
    immutable_violations := array_append(immutable_violations, 'correction_amount_cents');
  END IF;
  IF OLD.original_invoice_number IS DISTINCT FROM NEW.original_invoice_number THEN
    immutable_violations := array_append(immutable_violations, 'original_invoice_number');
  END IF;
  IF OLD.original_invoice_issued_at_label IS DISTINCT FROM NEW.original_invoice_issued_at_label THEN
    immutable_violations := array_append(immutable_violations, 'original_invoice_issued_at_label');
  END IF;
  IF OLD.job_id IS DISTINCT FROM NEW.job_id THEN
    immutable_violations := array_append(immutable_violations, 'job_id');
  END IF;
  IF OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    immutable_violations := array_append(immutable_violations, 'created_at');
  END IF;

  IF array_length(immutable_violations, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'invoice immutable fields modified after issuance (id=%, status=%, fields=%)',
      OLD.id, OLD.status, array_to_string(immutable_violations, ',')
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_invoice_immutability_trigger ON public.invoices;

-- Läuft als zweiter BEFORE UPDATE Trigger (alphabetisch nach assign_invoice_number),
-- so dass die Nummerierung beim draft→issued Übergang vergeben wird, bevor die
-- Immutability-Prüfung greift.
CREATE TRIGGER enforce_invoice_immutability_trigger
  BEFORE UPDATE ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_invoice_immutability();

COMMENT ON FUNCTION public.enforce_invoice_immutability() IS
  'Block 7.1G: §14-Immutability für ausgestellte Rechnungen. Erlaubt nur issued→sent, issued→paid, sent→paid sowie technische Updates (sent_at one-shot, refund_event_id, updated_at). Cancellation läuft per INSERT von kind=cancellation.';
