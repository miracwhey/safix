-- =============================================================================
-- Migration: Block 0 – craftsman_profiles Row Level Security
-- =============================================================================
-- craftsman_profiles is the extended-fields legacy table for craftsmen.
-- It holds servicesOffered, serviceRadiusKm, yearsInBusiness,
-- completedJobsCount, phone, website, onboardingCompleted — fields that
-- do not exist on the canonical providers table.
--
-- Current state: RLS not enabled → any authenticated user can read, write,
-- or delete any craftsman's row. This is a P0 data integrity gap.
--
-- Fix:
--   SELECT  → any authenticated user (explore/discovery reads other craftsmen)
--   INSERT  → own row only (user_id = auth.uid())
--   UPDATE  → own row only (user_id = auth.uid())
--   DELETE  → own row only (user_id = auth.uid())
--
-- Exception: the payment release workflow calls incrementCompletedJobsCount
-- with the craftsman's user_id from a customer or system auth context, so a
-- plain UPDATE would be rejected by craftsman_profiles_update_own.  We replace
-- the client-side read-then-write with an atomic SECURITY DEFINER RPC defined
-- below — the function runs as the DB owner, bypassing RLS, while the function
-- body is narrowly scoped to a single counter increment.
-- =============================================================================

ALTER TABLE public.craftsman_profiles ENABLE ROW LEVEL SECURITY;

-- SELECT: visible to any authenticated user (explore reads other craftsmen)
DROP POLICY IF EXISTS craftsman_profiles_select_authenticated ON public.craftsman_profiles;

CREATE POLICY craftsman_profiles_select_authenticated
  ON public.craftsman_profiles
  FOR SELECT
  USING (auth.role() = 'authenticated');

-- INSERT: own row only
DROP POLICY IF EXISTS craftsman_profiles_insert_own ON public.craftsman_profiles;

CREATE POLICY craftsman_profiles_insert_own
  ON public.craftsman_profiles
  FOR INSERT
  WITH CHECK (user_id = auth.uid()::text);

-- UPDATE: own row only
DROP POLICY IF EXISTS craftsman_profiles_update_own ON public.craftsman_profiles;

CREATE POLICY craftsman_profiles_update_own
  ON public.craftsman_profiles
  FOR UPDATE
  USING (user_id = auth.uid()::text);

-- DELETE: own row only
DROP POLICY IF EXISTS craftsman_profiles_delete_own ON public.craftsman_profiles;

CREATE POLICY craftsman_profiles_delete_own
  ON public.craftsman_profiles
  FOR DELETE
  USING (user_id = auth.uid()::text);

-- =============================================================================
-- Atomic counter increment RPC
-- =============================================================================
-- Called from the client-side payment release workflow to increment
-- completed_jobs_count on the craftsman's profile after a successful release.
-- The caller's auth context is the customer (or system), not the craftsman,
-- so a direct UPDATE is blocked by craftsman_profiles_update_own.
--
-- SECURITY DEFINER: runs as the function owner (postgres), bypassing RLS.
-- The function body is intentionally minimal — it only increments one counter
-- on the row identified by the caller-supplied user ID, with no data leak.
--
-- REVOKE / GRANT: removes the default PUBLIC execute grant and restricts
-- invocation to the authenticated PostgREST role only.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.increment_craftsman_jobs_count(
  p_craftsman_user_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Caller must be the craftsman themselves, or a customer on an active/completed
  -- job with this craftsman.  Prevents arbitrary authenticated users from inflating
  -- any craftsman's counter via direct RPC calls.
  IF auth.uid()::text <> p_craftsman_user_id AND NOT EXISTS (
    SELECT 1 FROM public.jobs
    WHERE craftsman_user_id = p_craftsman_user_id
      AND customer_user_id  = auth.uid()::text
      AND status IN ('waiting_payment', 'in_progress', 'completed')
  ) THEN
    RAISE EXCEPTION 'Not authorized to increment jobs count for this craftsman';
  END IF;

  UPDATE public.craftsman_profiles
  SET completed_jobs_count = COALESCE(completed_jobs_count, 0) + 1
  WHERE user_id = p_craftsman_user_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.increment_craftsman_jobs_count(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.increment_craftsman_jobs_count(text) TO authenticated;
