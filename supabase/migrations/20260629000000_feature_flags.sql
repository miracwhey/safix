-- ─────────────────────────────────────────────────────────────────────────────
-- feature_flags — remote feature flags + kill-switch
--
-- A single config table the client hydrates at bootstrap (critical) and keeps
-- live via a realtime channel, so a broken flow can be turned OFF remotely
-- without an App-Store release. Read by everyone (incl. logged-out, for
-- pre-login flag checks); written only by operators (mirrors the
-- analytics_events operator gate: EXISTS profiles.is_operator).
--
-- Columns:
--   key            stable flag identifier (pk), e.g. 'chat_ui_cutover_customer'
--   enabled        master on/off — the kill-switch
--   rollout_pct    0..100 staged rollout; client buckets deterministically by
--                  hash(key + user id) so a given user is stable across reloads
--   target_roles   optional app-context role allowlist ('customer'|'owner'|
--                  'employee'); empty = all roles
--   target_regions RESERVED — profiles has no region column yet, so the client
--                  resolver ignores this until a region lands on the session.
--                  Kept here so enabling region targeting later is data-only.
--   description    human note for the operator dashboard
--   updated_at     audit; auto-touched on update
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE public.feature_flags (
  key            text PRIMARY KEY,
  enabled        boolean NOT NULL DEFAULT false,
  rollout_pct    integer NOT NULL DEFAULT 100 CHECK (rollout_pct BETWEEN 0 AND 100),
  target_roles   text[]  NOT NULL DEFAULT '{}',
  target_regions text[]  NOT NULL DEFAULT '{}',
  description    text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;

-- Base privileges (RLS still gates rows). Read for everyone, writes for
-- authenticated (further narrowed to operators by the policies below).
GRANT SELECT ON public.feature_flags TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.feature_flags TO authenticated;

-- Public read: flags must resolve for logged-out sessions too (app_open,
-- chat-cutover) and carry no secrets.
CREATE POLICY feature_flags_select_public ON public.feature_flags
  FOR SELECT TO anon, authenticated
  USING (true);

-- Operator-only writes (mirror analytics_events "Operators can read" gate).
CREATE POLICY feature_flags_insert_operator ON public.feature_flags
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.id = auth.uid() AND profiles.is_operator = true
  ));

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

CREATE POLICY feature_flags_delete_operator ON public.feature_flags
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.id = auth.uid() AND profiles.is_operator = true
  ));

-- updated_at auto-touch (per-table convention, e.g.
-- provider_presales_projects_set_updated_at).
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

CREATE TRIGGER feature_flags_set_updated_at
  BEFORE UPDATE ON public.feature_flags
  FOR EACH ROW
  EXECUTE FUNCTION public.feature_flags_set_updated_at();

-- Live kill-switch: stream changes to subscribed clients. The client refetches
-- all flags on any event, so DEFAULT replica identity (PK-only OLD on DELETE)
-- is sufficient — no non-PK filter is used.
ALTER PUBLICATION supabase_realtime ADD TABLE public.feature_flags;

-- PostgREST schema cache reload so the new table is queryable immediately.
NOTIFY pgrst, 'reload schema';
