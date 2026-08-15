-- Migration: Invoice sequential numbering + issued_at timestamp
-- Block 2 / Sub-block 2.2 — Sequential Invoice Numbers

-- 1. Global sequence for invoice numbers.
--    Sequential across all years; the year is embedded in the format.
--    Format: FX-YYYY-NNNN (e.g. FX-2026-0001)
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START 1;

-- 2. Machine-readable issued timestamp.
--    Set by the application at the moment of draft → issued transition.
--    0 means not yet issued (draft state).
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS issued_at bigint NOT NULL DEFAULT 0;

-- 3. Trigger function: atomically assigns invoice_number on draft → issued.
--    Only fires when:
--      - NEW.status = 'issued'        (target state is issued)
--      - OLD.status = 'draft'         (source state is draft)
--      - invoice_number is not yet set (prevents re-assignment on further updates)
--    Uses nextval() which is transactional and collision-free under concurrent load.
CREATE OR REPLACE FUNCTION generate_invoice_number()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'issued'
    AND OLD.status = 'draft'
    AND (OLD.invoice_number IS NULL OR OLD.invoice_number = '')
  THEN
    NEW.invoice_number :=
      'FX-' ||
      EXTRACT(YEAR FROM NOW())::int ||
      '-' ||
      LPAD(nextval('invoice_number_seq')::text, 4, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Attach trigger (replace if it already exists from a prior attempt).
DROP TRIGGER IF EXISTS assign_invoice_number ON public.invoices;
CREATE TRIGGER assign_invoice_number
  BEFORE UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION generate_invoice_number();
