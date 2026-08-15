-- Spatial V1.5 · Provider-Pre-Sales-Spatial · Post-apply advisor fix
--
-- Advisor WARN (lint=0011_function_search_path_mutable): the BEFORE-UPDATE
-- trigger function from migration 20260523181353 had a mutable search_path.
-- Pin to `public` to match the FixUp convention for SECURITY-sensitive helpers.

CREATE OR REPLACE FUNCTION public.provider_presales_projects_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
