-- Block 7.2.1d · defense-in-depth on the audit table
--
-- The audit row INSERTs are written by `rotate_company_code` (SECURITY DEFINER,
-- runs as postgres) — direct authenticated/anon writes were already blocked by
-- the lack of an INSERT/UPDATE/DELETE policy under RLS, but the Supabase default
-- column GRANTs for those roles were still present.
--
-- Removing the GRANTs makes the audit table append-only at two layers (grant +
-- RLS) so a future policy mistake cannot accidentally open the write path.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.company_code_audit FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.company_code_audit FROM authenticated;
