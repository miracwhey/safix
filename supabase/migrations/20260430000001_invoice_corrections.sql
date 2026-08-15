-- =============================================================================
-- Block 7.1B4 — Invoice Corrections (Storno-Rechnung / Gutschrift)
-- =============================================================================
-- Erweitert die `invoices`-Tabelle um Korrektur-Belege gemäß §14 Abs. 6 UStG.
--
-- Architektur-Entscheidung:
-- ─────────────────────────
-- Originalrechnungen werden nach Issuance NIE retroaktiv mutiert. Die
-- Engine-Invariante `paid:[]` / `cancelled:[]` bleibt unverändert. Stattdessen
-- führen wir den `kind`-Diskriminator ein: jede Korrektur ist eine eigene
-- Invoice-Row mit `kind = 'cancellation'` oder `kind = 'credit_note'`,
-- referenziert das Original via `original_invoice_id`, trägt eine
-- nachvollziehbare `correction_reason` und einen Δ-Betrag.
--
-- Logical-Status-Derivation: das Original bleibt `paid` / `issued`, eine UI
-- kann es über die Existenz eines kind='cancellation'-Belegs als „storniert
-- durch X" surfacen — ohne den Original-Status zu kippen.
--
-- Rechtssichere Belegnummern: separate Sequenzen pro Belegart, damit
-- Stornorechnungen und Gutschriften eigene lückenlose Reihen haben.
--
-- Pre-Deploy-Schema-Verifikation Pflicht:
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'invoices' AND table_schema = 'public';
--   → keine der hier hinzugefügten Spalten darf bereits existieren.
--   SELECT 1 FROM pg_class WHERE relname IN
--     ('cancellation_invoice_seq','credit_note_seq');
--   → keine der Sequenzen darf bereits existieren.
-- =============================================================================

-- 1. kind-Diskriminator. Existing-Row-Default bleibt 'invoice', neue
--    Korrekturbelege müssen 'cancellation' oder 'credit_note' explizit setzen.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'invoice';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'invoices'
      AND table_schema = 'public'
      AND constraint_name = 'invoices_kind_check'
  ) THEN
    ALTER TABLE public.invoices
      ADD CONSTRAINT invoices_kind_check
      CHECK (kind IN ('invoice', 'cancellation', 'credit_note'));
  END IF;
END $$;

-- 2. Self-FK auf die Originalrechnung. NULL für kind='invoice'.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS original_invoice_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'invoices'
      AND table_schema = 'public'
      AND constraint_name = 'invoices_original_invoice_id_fkey'
  ) THEN
    ALTER TABLE public.invoices
      ADD CONSTRAINT invoices_original_invoice_id_fkey
      FOREIGN KEY (original_invoice_id) REFERENCES public.invoices(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS invoices_original_invoice_id_idx
  ON public.invoices (original_invoice_id)
  WHERE original_invoice_id IS NOT NULL;

-- 3. Korrektur-Metadaten. Pflicht für kind != 'invoice'.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS correction_reason text;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS correction_amount_cents bigint;

-- Snapshot der Originalbelegnummer (bequemer Render-Pfad fürs PDF-Footer:
-- „Bezug auf Rechnung FX-2026-0007 vom 22.04.2026"). Wird vom Workflow zur
-- Erstellung des Korrekturbelegs gesetzt und nie nachträglich verändert.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS original_invoice_number text;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS original_invoice_issued_at_label text;

-- Audit-Anker: optionaler Bezug zum auslösenden Refund-/Dispute-Event.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS refund_event_id text;

-- 4. Integritäts-Constraint. Korrekturbelege MÜSSEN Original-Bezug,
--    Begründung und einen Δ-Betrag != 0 tragen.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'invoices'
      AND table_schema = 'public'
      AND constraint_name = 'invoices_correction_integrity_check'
  ) THEN
    ALTER TABLE public.invoices
      ADD CONSTRAINT invoices_correction_integrity_check
      CHECK (
        kind = 'invoice'
        OR (
          original_invoice_id IS NOT NULL
          AND correction_reason IS NOT NULL
          AND length(btrim(correction_reason)) > 0
          AND correction_amount_cents IS NOT NULL
          AND correction_amount_cents <> 0
        )
      );
  END IF;
END $$;

-- 5. Separate Sequenzen pro Belegart (lückenlose Reihen, getrennt auditierbar).
CREATE SEQUENCE IF NOT EXISTS cancellation_invoice_seq START 1;
CREATE SEQUENCE IF NOT EXISTS credit_note_seq START 1;

-- 6. Trigger-Erweiterung: kind-aware Belegnummern, jetzt auch BEFORE INSERT
--    (Korrekturbelege werden direkt mit status='issued' eingefügt; das
--    bisherige UPDATE-only Trigger-Schema ist dafür zu eng).
--
--    Format:
--      kind = 'invoice'      → FX-YYYY-NNNN
--      kind = 'cancellation' → FX-S-YYYY-NNNN  (Stornorechnung)
--      kind = 'credit_note'  → FX-G-YYYY-NNNN  (Gutschrift)
CREATE OR REPLACE FUNCTION generate_invoice_number()
RETURNS TRIGGER AS $$
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS assign_invoice_number ON public.invoices;
CREATE TRIGGER assign_invoice_number
  BEFORE INSERT OR UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION generate_invoice_number();

-- 7. RLS bleibt unverändert. Korrekturbelege teilen die gleiche `job_id` wie
--    das Original und werden damit automatisch von den vorhandenen Policies
--    `invoices_select_own` / `invoices_insert_own` / `invoices_update_own`
--    abgedeckt (Block 8a Secondary Tables RLS).
