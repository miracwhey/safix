-- =============================================================================
-- Migration: profiles – guided_entry_state JSONB column
-- =============================================================================
-- Adds a JSONB column to the profiles table to persist the customer guided-entry
-- state machine.  This makes Supabase the canonical source of truth for guided
-- entry progress instead of browser localStorage.
--
-- The column stores the full guided-entry state object:
--   { step, path, selectedProviderId, projectId }
--
-- NULL means "no guided-entry state yet" (equivalent to 'initial' step).
-- The column is nullable so existing profiles are not affected.
--
-- No RLS changes needed: profiles already has row-level security by user ID.
-- The guided_entry_state column is read/written through the existing profiles
-- upsert pattern used by setMyRole / getMyProfile.
-- =============================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS guided_entry_state jsonb;
