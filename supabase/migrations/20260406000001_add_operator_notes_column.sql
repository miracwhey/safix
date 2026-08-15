-- Migration: Add operator_notes column to user_reports
-- The operatorModerationService.resolveReport() writes operator notes when
-- resolving a report, but the column was missing from the original schema.

ALTER TABLE public.user_reports
  ADD COLUMN IF NOT EXISTS operator_notes text;
