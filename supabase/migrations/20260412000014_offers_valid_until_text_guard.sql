-- =============================================================================
-- Migration: Guard — ensure offers.valid_until is TEXT
-- =============================================================================
--
-- Defensive migration: the valid_until column was defined as TEXT in migration
-- 20260324000001. This migration explicitly re-asserts TEXT type to guard
-- against any accidental schema drift (manual ALTER, partial migration, etc.).
--
-- If the column is already TEXT this is a no-op.
-- If the column was accidentally set to BIGINT (causing the reported
-- "invalid input syntax for type bigint" error on date strings), this
-- corrects it back to TEXT and converts any existing bigint values.
-- =============================================================================

DO $$
BEGIN
  -- Check if valid_until column exists and is not already TEXT
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'offers'
      AND column_name = 'valid_until'
      AND data_type != 'text'
  ) THEN
    -- Convert: if the column holds bigint timestamps, preserve them as ISO strings
    ALTER TABLE public.offers
      ALTER COLUMN valid_until TYPE TEXT
      USING CASE
        WHEN valid_until IS NULL THEN NULL
        ELSE valid_until::TEXT
      END;

    RAISE NOTICE 'offers.valid_until converted to TEXT';
  END IF;

  -- Same guard for thread_artifacts.snapshot_valid_until
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'thread_artifacts'
      AND column_name = 'snapshot_valid_until'
      AND data_type != 'text'
  ) THEN
    ALTER TABLE thread_artifacts
      ALTER COLUMN snapshot_valid_until TYPE TEXT
      USING CASE
        WHEN snapshot_valid_until IS NULL THEN NULL
        ELSE snapshot_valid_until::TEXT
      END;

    RAISE NOTICE 'thread_artifacts.snapshot_valid_until converted to TEXT';
  END IF;
END $$;
