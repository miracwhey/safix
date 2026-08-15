-- Block 9: Add business_address to craftsman_profiles
-- Stores the full invoice issuance address (e.g. "Hauptstraße 5, 10115 Berlin").
-- Nullable so existing rows are unaffected; the application defaults to '' on read.

ALTER TABLE craftsman_profiles
  ADD COLUMN IF NOT EXISTS business_address TEXT;

-- Backfill: copy location into business_address for existing rows where:
--   1. business_address is not yet set (NULL or empty)
--   2. location looks like a full address (contains a comma — same check used by
--      invoiceValidation.ts and resolveIssuerData before the comma guard)
--
-- City-only location values (no comma) are intentionally left NULL because they
-- would fail invoice issuance validation anyway. The craftsman must provide a
-- full address through the profile edit screen.
UPDATE craftsman_profiles
SET business_address = location
WHERE (business_address IS NULL OR business_address = '')
  AND location IS NOT NULL
  AND location <> ''
  AND location LIKE '%,%';
