-- ============================================================================
-- Block 6: craftsman_subscriptions — Owner-first Subscription Skeleton
-- ============================================================================

-- ── Table ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS craftsman_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) UNIQUE,
  status text NOT NULL DEFAULT 'trial_available'
    CHECK (status IN (
      'trial_available',
      'trial_active',
      'active',
      'grace',
      'canceled',
      'expired'
    )),
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  canceled_at timestamptz,
  grace_started_at timestamptz,
  billing_provider text CHECK (billing_provider IN ('apple', 'stripe') OR billing_provider IS NULL),
  billing_provider_subscription_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_craftsman_subscriptions_profile_id
  ON craftsman_subscriptions (profile_id);

CREATE INDEX IF NOT EXISTS idx_craftsman_subscriptions_status
  ON craftsman_subscriptions (status);

-- ── Backfill existing owners ────────────────────────────────────────────────
-- Idempotent: ON CONFLICT DO NOTHING prevents duplicates on re-run.

INSERT INTO craftsman_subscriptions (profile_id, status)
SELECT p.id, 'trial_available'
FROM profiles p
WHERE p.role = 'craftsman'
  AND p.craftsman_role = 'owner'
  AND NOT EXISTS (
    SELECT 1 FROM craftsman_subscriptions cs WHERE cs.profile_id = p.id
  )
ON CONFLICT (profile_id) DO NOTHING;

-- ── RPC: start_trial() ─────────────────────────────────────────────────────
-- Caller identity from auth.uid(). No client-supplied profile_id.
-- Atomic: FOR UPDATE lock prevents race conditions.
-- Idempotent rejection: returns JSON error on invalid state, never throws for
-- expected business rejections.

CREATE OR REPLACE FUNCTION start_trial()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_role text;
  v_craftsman_role text;
  v_row craftsman_subscriptions%ROWTYPE;
  v_now timestamptz := now();
BEGIN
  -- Auth check
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  -- Role guard
  SELECT role, craftsman_role INTO v_role, v_craftsman_role
  FROM profiles
  WHERE id = v_caller;

  IF v_role IS DISTINCT FROM 'craftsman' OR v_craftsman_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'not_owner';
  END IF;

  -- Lock the subscription row
  SELECT * INTO v_row
  FROM craftsman_subscriptions
  WHERE profile_id = v_caller
  FOR UPDATE;

  IF v_row IS NULL THEN
    RAISE EXCEPTION 'no_subscription_row';
  END IF;

  -- State guard: only trial_available can transition
  IF v_row.status != 'trial_available' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_state', 'current', v_row.status);
  END IF;

  -- Double-start guard
  IF v_row.trial_started_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'trial_already_used');
  END IF;

  -- Transition
  UPDATE craftsman_subscriptions
  SET
    status = 'trial_active',
    trial_started_at = v_now,
    trial_ends_at = v_now + interval '14 days',
    updated_at = v_now
  WHERE id = v_row.id;

  RETURN jsonb_build_object(
    'ok', true,
    'trial_ends_at', (v_now + interval '14 days')::text
  );
END;
$$;

REVOKE ALL ON FUNCTION start_trial() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION start_trial() TO authenticated;

-- ── RPC: ensure_subscription_row() ─────────────────────────────────────────
-- Called during onboarding completion to guarantee row existence.
-- Idempotent: ON CONFLICT DO NOTHING.
-- No client-supplied profile_id — identity from auth.uid().

CREATE OR REPLACE FUNCTION ensure_subscription_row()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_role text;
  v_craftsman_role text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT role, craftsman_role INTO v_role, v_craftsman_role
  FROM profiles
  WHERE id = v_caller;

  IF v_role IS DISTINCT FROM 'craftsman' OR v_craftsman_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'not_owner';
  END IF;

  INSERT INTO craftsman_subscriptions (profile_id, status)
  VALUES (v_caller, 'trial_available')
  ON CONFLICT (profile_id) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION ensure_subscription_row() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_subscription_row() TO authenticated;

-- ── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE craftsman_subscriptions ENABLE ROW LEVEL SECURITY;

-- Owners can read their own subscription row
CREATE POLICY craftsman_subscriptions_select_own
  ON craftsman_subscriptions
  FOR SELECT
  USING (profile_id = auth.uid());

-- No direct client writes — all mutations go through RPCs (SECURITY DEFINER)
-- No INSERT/UPDATE/DELETE policies needed for authenticated users.
