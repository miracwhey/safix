-- =============================================================================
-- feature_flags overlay — remote feature flags + kill-switch (prod 2026-06-29)
-- =============================================================================
-- Project: SaFix backend (ref itdntawwuzqfwmcwnwjr), Postgres 17.
--
-- WHY THIS OVERLAY: the pgTAP CI builds its test DB from the prod-schema dump
-- (supabase/baseline/00_schema.sql), not the incremental migration chain
-- (systemic repo<->prod drift). public.feature_flags was added to prod AFTER
-- that dump (migration 20260629000000_feature_flags.sql), so the dump lacks it
-- and test 11 (feature_flags RLS) would fail with "relation does not exist".
-- Replayed as a baseline overlay so test 11 runs against the real table+RLS.
-- Mirrors the migration's table + grants + RLS (operator-only write, public
-- read); omits the realtime publication + NOTIFY (CI-irrelevant).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.feature_flags (
  key            text PRIMARY KEY,
  enabled        boolean NOT NULL DEFAULT false,
  rollout_pct    integer NOT NULL DEFAULT 100 CHECK (rollout_pct BETWEEN 0 AND 100),
  target_roles   text[]  NOT NULL DEFAULT '{}',
  target_regions text[]  NOT NULL DEFAULT '{}',
  description    text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.feature_flags TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.feature_flags TO authenticated;

DROP POLICY IF EXISTS feature_flags_select_public ON public.feature_flags;
CREATE POLICY feature_flags_select_public ON public.feature_flags
  FOR SELECT TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS feature_flags_insert_operator ON public.feature_flags;
CREATE POLICY feature_flags_insert_operator ON public.feature_flags
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.id = auth.uid() AND profiles.is_operator = true
  ));

DROP POLICY IF EXISTS feature_flags_update_operator ON public.feature_flags;
CREATE POLICY feature_flags_update_operator ON public.feature_flags
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.id = auth.uid() AND profiles.is_operator = true
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.id = auth.uid() AND profiles.is_operator = true
  ));

DROP POLICY IF EXISTS feature_flags_delete_operator ON public.feature_flags;
CREATE POLICY feature_flags_delete_operator ON public.feature_flags
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.id = auth.uid() AND profiles.is_operator = true
  ));

CREATE OR REPLACE FUNCTION public.feature_flags_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS feature_flags_set_updated_at ON public.feature_flags;
CREATE TRIGGER feature_flags_set_updated_at
  BEFORE UPDATE ON public.feature_flags
  FOR EACH ROW
  EXECUTE FUNCTION public.feature_flags_set_updated_at();
