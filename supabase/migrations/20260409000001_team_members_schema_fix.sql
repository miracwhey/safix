-- =============================================================================
-- Migration: team_members schema fix — full_name + is_active columns
-- =============================================================================
-- The join_company_with_code() RPC in 20260408000001_company_join_codes.sql
-- inserts into `full_name` and `is_active` columns, but those columns were
-- never added to the base table via ALTER TABLE. This migration corrects that
-- gap idempotently.
--
-- ADD COLUMN IF NOT EXISTS is safe to run even if the columns already exist
-- (PostgreSQL no-ops in that case).
-- =============================================================================

ALTER TABLE public.team_members
  ADD COLUMN IF NOT EXISTS full_name  text    NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS is_active  boolean NOT NULL DEFAULT true;

-- Backfill: copy legacy `name` → `full_name` for existing seed rows that
-- were inserted before this column existed.
UPDATE public.team_members
  SET full_name = name
  WHERE full_name = '' AND name <> '';
