-- =============================================================================
-- Migration: profiles – canonical role enforcement
-- =============================================================================
-- Enforces that profiles.role is always one of the canonical values
-- ('customer', 'craftsman') or NULL.
--
-- ROOT CAUSE:
--   The profiles.role column had a DEFAULT value that caused new profile rows
--   (created by the handle_new_user trigger or ensureProfileExists) to receive
--   a role value before the user explicitly selected one.  Malformed values
--   such as "'customer'" (with literal quotes) were observed in production.
--
-- This migration:
--   1. Normalizes existing malformed role values to canonical form where safe
--   2. NULLs out any role value that cannot be safely normalized
--   3. Drops any existing DEFAULT on the role column
--   4. Adds a CHECK constraint ensuring role is NULL or a canonical value
--
-- All statements are idempotent and safe to run on existing data.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Backfill: normalize malformed role values to canonical form
-- ---------------------------------------------------------------------------
-- Strip surrounding single/double quotes, trim whitespace, lowercase.
-- Only values that normalize to 'customer' or 'craftsman' are kept;
-- everything else is set to NULL (user must re-select their role).

UPDATE public.profiles
SET role = lower(trim(both '''' from trim(both '"' from trim(role))))
WHERE role IS NOT NULL
  AND role NOT IN ('customer', 'craftsman')
  AND lower(trim(both '''' from trim(both '"' from trim(role)))) IN ('customer', 'craftsman');

-- Any remaining non-canonical values are set to NULL
UPDATE public.profiles
SET role = NULL
WHERE role IS NOT NULL
  AND role NOT IN ('customer', 'craftsman');

-- ---------------------------------------------------------------------------
-- 2. Drop any existing DEFAULT on the role column
-- ---------------------------------------------------------------------------
-- This ensures INSERT INTO profiles (id) does NOT auto-assign a role.

ALTER TABLE public.profiles
  ALTER COLUMN role DROP DEFAULT;

-- ---------------------------------------------------------------------------
-- 3. Add CHECK constraint for canonical role values
-- ---------------------------------------------------------------------------
-- Only NULL, 'customer', or 'craftsman' are allowed.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'profiles_role_canonical'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_role_canonical
      CHECK (role IS NULL OR role IN ('customer', 'craftsman'));
  END IF;
END $$;

-- =============================================================================
-- After this migration:
--   • All existing malformed role values are cleaned up
--   • New profile rows have role = NULL by default (no column DEFAULT)
--   • The CHECK constraint prevents non-canonical values from being written
--   • Users with NULL role will be routed to /onboarding/role by the app gates
-- =============================================================================
