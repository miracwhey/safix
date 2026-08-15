-- Spatial V1.5 · Provider-Pre-Sales-Spatial · Phase B-P1
--
-- Adds a dedicated table for provider-initiated pre-sales 3D-projects.
-- A pre-sales project is created BEFORE a customer-job exists: the provider
-- walks into a site, scans the room, prepares a quote, then converts the
-- project to a real `jobs` row once the customer agrees.
--
-- Design choices (documented in plan-doc §2):
--   - Eigene Tabelle (nicht `projects.source = 'provider_presales'`) weil
--     ProjectCase customer-zentriert bleibt + presales hat eigenen Lifecycle.
--   - provider_org_id ist Hard-Anchor (ON DELETE CASCADE) — kein Orphan möglich.
--   - created_by_user_id ist RESTRICT damit Audit-Attribution bleibt.
--   - converted_to_job_id ist SET NULL — wenn Job später gelöscht wird, bleibt
--     der presales-record als history-anchor.
--
-- RLS:
--   - SELECT / INSERT / UPDATE / DELETE nur für provider-org-member.
--   - Anon hat keinen Access (REVOKE EXECUTE auf future RPCs ebenso).
--
-- External steps after apply:
--   - Run `supabase gen types` to regenerate TS types.
--   - Verify `mcp__claude_ai_Supabase__list_tables` shows the new table.

-- ── 1. Table ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.provider_presales_projects (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_org_id          uuid NOT NULL REFERENCES public.providers(id) ON DELETE CASCADE,
  created_by_user_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,

  title                    text NOT NULL,
  location_hint            text,
  customer_name_draft      text,
  customer_email_draft     text,
  customer_phone_draft     text,
  notes                    text,

  status                   text NOT NULL DEFAULT 'draft',

  scanned_at               timestamptz,
  quoted_at                timestamptz,
  converted_at             timestamptz,
  converted_to_job_id      uuid REFERENCES public.jobs(id) ON DELETE SET NULL,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT presales_status_chk CHECK (
    status IN ('draft', 'scanned', 'quoted', 'converted', 'archived')
  )
);

COMMENT ON TABLE public.provider_presales_projects IS
  'Provider-initiated pre-sales 3D-project. Created before a customer-job exists. '
  'Converts to a real `jobs` row once the customer agrees. provider_org_id is the '
  'hard ownership anchor; created_by_user_id is the audit-attribution.';

-- ── 2. Indices ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS provider_presales_projects_org_idx
  ON public.provider_presales_projects(provider_org_id);

CREATE INDEX IF NOT EXISTS provider_presales_projects_status_idx
  ON public.provider_presales_projects(status);

CREATE INDEX IF NOT EXISTS provider_presales_projects_converted_idx
  ON public.provider_presales_projects(converted_to_job_id)
  WHERE converted_to_job_id IS NOT NULL;

-- ── 3. updated_at trigger ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.provider_presales_projects_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS provider_presales_projects_set_updated_at_trg
  ON public.provider_presales_projects;

CREATE TRIGGER provider_presales_projects_set_updated_at_trg
  BEFORE UPDATE ON public.provider_presales_projects
  FOR EACH ROW EXECUTE FUNCTION public.provider_presales_projects_set_updated_at();

-- ── 4. RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE public.provider_presales_projects ENABLE ROW LEVEL SECURITY;

-- SELECT: any active member of the provider org
DROP POLICY IF EXISTS provider_presales_projects_select ON public.provider_presales_projects;
CREATE POLICY provider_presales_projects_select ON public.provider_presales_projects
  FOR SELECT TO authenticated
  USING (
    provider_org_id = public.spatial_user_provider_org((SELECT auth.uid()))
    OR public.spatial_is_operator((SELECT auth.uid()))
  );

-- INSERT: caller must be a member of the provider org AND created_by_user_id = self
DROP POLICY IF EXISTS provider_presales_projects_insert ON public.provider_presales_projects;
CREATE POLICY provider_presales_projects_insert ON public.provider_presales_projects
  FOR INSERT TO authenticated
  WITH CHECK (
    provider_org_id = public.spatial_user_provider_org((SELECT auth.uid()))
    AND created_by_user_id = (SELECT auth.uid())
  );

-- UPDATE: any member of the provider org; created_by_user_id immutable for non-operators
DROP POLICY IF EXISTS provider_presales_projects_update ON public.provider_presales_projects;
CREATE POLICY provider_presales_projects_update ON public.provider_presales_projects
  FOR UPDATE TO authenticated
  USING (
    provider_org_id = public.spatial_user_provider_org((SELECT auth.uid()))
    OR public.spatial_is_operator((SELECT auth.uid()))
  )
  WITH CHECK (
    provider_org_id = public.spatial_user_provider_org((SELECT auth.uid()))
    AND (
      public.spatial_is_operator((SELECT auth.uid()))
      OR created_by_user_id = (
        SELECT created_by_user_id FROM public.provider_presales_projects
        WHERE id = provider_presales_projects.id
      )
    )
  );

-- DELETE: created_by_user_id self or operator (keine arbiträren members)
DROP POLICY IF EXISTS provider_presales_projects_delete ON public.provider_presales_projects;
CREATE POLICY provider_presales_projects_delete ON public.provider_presales_projects
  FOR DELETE TO authenticated
  USING (
    public.spatial_is_operator((SELECT auth.uid()))
    OR (
      created_by_user_id = (SELECT auth.uid())
      AND provider_org_id = public.spatial_user_provider_org((SELECT auth.uid()))
    )
  );

-- ── 5. Grants (write-protected — only via RLS) ───────────────────────────────
REVOKE ALL ON public.provider_presales_projects FROM PUBLIC;
REVOKE ALL ON public.provider_presales_projects FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.provider_presales_projects TO authenticated;
GRANT ALL ON public.provider_presales_projects TO service_role;
