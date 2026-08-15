-- APPLY HELD: run only after explicit ja apply
-- =============================================================================
-- FixUp Review Seed — RESTORE (un-hide providers)
-- =============================================================================
-- Inverse of section 4 ("HIDE OLD TEST PROVIDERS") in seed-review-accounts.sql.
-- That seed sets is_public=false on every non-review provider so the Apple
-- reviewer's Explore feed only shows the clean demo profiles. Run THIS script
-- after the review window to re-publish everyone it hid, so real craftsmen's
-- reels are visible to other accounts again.
--
-- Assumption: providers.is_public DEFAULT is true and the hide flips
-- previously-public providers to false, so the correct inverse is to flip all
-- currently-hidden providers back to true. If you have providers that should
-- stay hidden intentionally (a craftsman who toggled themselves private),
-- exclude their id from the WHERE clause before running.
--
-- Idempotent: safe to run multiple times.
-- =============================================================================

UPDATE public.providers
SET is_public = true, updated_at = now()
WHERE is_public = false;

-- Report what was re-published (psql \echo-friendly; harmless via MCP).
-- SELECT id, company_name, handle FROM public.providers WHERE is_public = true ORDER BY updated_at DESC;
