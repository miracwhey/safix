-- is_pro_owner(profile_id) — server-side entitlement check
--
-- Mirrors client-side resolveEffectiveState logic.
-- Returns true when the profile has an active Pro entitlement:
--   active/grace → always
--   trial_active → if trial_ends_at has not passed
--   canceled     → if still within current_period_end
--
-- Used as SECURITY DEFINER so RLS policies can call it without
-- exposing craftsman_subscriptions to broader roles.

CREATE OR REPLACE FUNCTION public.is_pro_owner(
  p_profile_id uuid,
  p_now        timestamptz DEFAULT now()
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.craftsman_subscriptions cs
    WHERE cs.profile_id = p_profile_id
      AND (
        cs.status IN ('active', 'grace')
        OR (cs.status = 'trial_active' AND cs.trial_ends_at > p_now)
        OR (cs.status = 'canceled'     AND cs.current_period_end > p_now)
      )
  );
$$;

REVOKE ALL ON FUNCTION public.is_pro_owner(uuid, timestamptz) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.is_pro_owner(uuid, timestamptz) TO authenticated, service_role;
