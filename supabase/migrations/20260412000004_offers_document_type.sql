-- =============================================================================
-- Migration: Offer.documentType + Offer.contextType — Paket 1 Commercial Domain Core
-- =============================================================================
--
-- Introduces two new columns to the `offers` table:
--
--   document_type  — Leading commercial document type (Paket 1 leading typing).
--                    Replaces offer_mode as the authoritative commercial
--                    classification field.
--                    Values: 'estimate' | 'binding_offer' | 'diagnosis'
--                    NULL for rows created before this migration; domain layer
--                    resolves NULL via resolveEffectiveDocumentType() using
--                    offer_mode as fallback.
--
--   context_type   — Classification of the context entity this Offer is bound to.
--                    Values: 'conversation' | 'inquiry' | 'project'
--                    NULL for rows before Paket 1; treated as 'conversation'.
--
-- Backward compatibility:
--   - offer_mode column is retained for compatibility with pre-Paket-1 readers.
--   - NULL document_type rows resolve to 'binding_offer' (same as NULL offer_mode).
--   - Existing offer acceptance, gating, and payment logic is unaffected because
--     the domain layer resolves documentType from offer_mode when document_type is NULL.
--
-- Backfill:
--   Existing rows are backfilled synchronously in this migration.
--   Mapping: offer_mode = 'estimate' → document_type = 'estimate'
--            offer_mode = 'binding' or NULL → document_type = 'binding_offer'
--   All existing rows get context_type = 'conversation'.
--
-- Applied: 2026-04-12 (Paket 1 — Commercial Domain Core)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Add document_type column
-- ---------------------------------------------------------------------------
ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS document_type text;

COMMENT ON COLUMN public.offers.document_type IS
  'Leading commercial document type (Paket 1). '
  '''binding_offer'' (verbindliches Angebot) | ''estimate'' (unverbindliche Schätzung) | ''diagnosis'' (Diagnose). '
  'NULL rows are resolved to ''binding_offer'' by the domain layer for backward compatibility. '
  'Replaces offer_mode as authoritative commercial typing field.';

-- ---------------------------------------------------------------------------
-- 2. Add context_type column
-- ---------------------------------------------------------------------------
ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS context_type text;

COMMENT ON COLUMN public.offers.context_type IS
  'Context classification for this commercial document (Paket 1). '
  '''conversation'' (default) | ''inquiry'' | ''project''. '
  'The actual context anchor is conversation_id. context_type classifies it.';

-- ---------------------------------------------------------------------------
-- 3. Backfill document_type from offer_mode for all existing rows
--    Safe: offer_mode was already backfilled to 'binding' in migration
--    20260411000005_offers_offer_mode.sql, so only NULL or 'estimate' remain.
-- ---------------------------------------------------------------------------
UPDATE public.offers
  SET document_type = CASE
    WHEN offer_mode = 'estimate' THEN 'estimate'
    ELSE 'binding_offer'
  END
  WHERE document_type IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Backfill context_type — all existing offers are conversation-bound
-- ---------------------------------------------------------------------------
UPDATE public.offers
  SET context_type = 'conversation'
  WHERE context_type IS NULL;

-- ---------------------------------------------------------------------------
-- 5. Add CHECK constraint for document_type (allows NULL for forward compat)
-- ---------------------------------------------------------------------------
ALTER TABLE public.offers
  ADD CONSTRAINT offers_document_type_check
    CHECK (document_type IS NULL OR document_type IN ('estimate', 'binding_offer', 'diagnosis'));

-- ---------------------------------------------------------------------------
-- 6. Add CHECK constraint for context_type
-- ---------------------------------------------------------------------------
ALTER TABLE public.offers
  ADD CONSTRAINT offers_context_type_check
    CHECK (context_type IS NULL OR context_type IN ('conversation', 'inquiry', 'project'));
