-- Block 7.2.3 · Phase 4 M2b — strukturierte Korrektur-Felder
-- Mockup-Vorgabe: Korrektur-Record enthält field/current_value/proposed_value/reason
-- statt nur Freitext, damit Owner Vorschlag und Begründung strukturiert sieht.
--
-- Pre-State verified 2026-05-01: 4 columns NICHT vorhanden, 1 row in Tabelle,
-- 4 RLS-Policies decken alles. Forward-only additive Migration.

ALTER TABLE public.correction_requests
  ADD COLUMN IF NOT EXISTS field text,
  ADD COLUMN IF NOT EXISTS current_value text,
  ADD COLUMN IF NOT EXISTS proposed_value text,
  ADD COLUMN IF NOT EXISTS reason text;
