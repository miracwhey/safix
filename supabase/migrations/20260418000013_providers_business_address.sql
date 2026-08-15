-- Add business_address to the canonical providers table.
-- Required for invoices and KYC: the onboarding screen already collects this
-- field and writes it to craftsman_profiles (legacy), but it must also live
-- in providers (canonical) so downstream billing and trust surfaces read from
-- a single authoritative row without joining the legacy table.
--
-- IF NOT EXISTS is safe to apply multiple times (idempotent).

ALTER TABLE providers
  ADD COLUMN IF NOT EXISTS business_address TEXT;
