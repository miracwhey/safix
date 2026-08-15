-- 20260527000000 · Phase 5 Spatial V1.6 · DSGVO account_deletion_log audit table
--
-- Append-only audit trail for account deletions. Records what Storage was
-- cleared, how long the cleanup took, and which path (Vercel-Route /
-- safety-net trigger / admin-console) triggered the deletion. Required by
-- DSGVO Art. 5(1)(f) / 30 for accountability and breach detection.
--
-- Sources:
--   vercel        — api/delete-account.ts pre-deleteUser path (primary)
--   trigger       — handle_auth_user_delete_cascade safety-net (alt paths)
--   admin_console — manual Apple-Support / Dashboard / direct-SQL ops
--
-- Access:
--   service-role-only. DSGVO auditor reads via direct SQL with service key.
--   anon/authenticated have no read or write rights.
--   RLS enabled with default-deny (no policies) — only service_role bypasses.
--   INSERT/UPDATE/DELETE/TRUNCATE explicitly revoked for defense-in-depth.

CREATE TABLE public.account_deletion_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('vercel', 'trigger', 'admin_console')),
  buckets_cleared jsonb NOT NULL DEFAULT '[]'::jsonb,
  files_removed integer NOT NULL DEFAULT 0,
  duration_ms integer,
  error_detail text NULL
);

CREATE INDEX account_deletion_log_user_id_idx
  ON public.account_deletion_log (user_id);

CREATE INDEX account_deletion_log_deleted_at_idx
  ON public.account_deletion_log (deleted_at DESC);

ALTER TABLE public.account_deletion_log ENABLE ROW LEVEL SECURITY;

-- Append-only audit: REVOKE writes from non-service roles. RLS default-deny
-- already blocks anon/authenticated, but explicit REVOKE is defense-in-depth
-- against future policy mistakes (see ~/.claude/CLAUDE.md feedback note
-- "audit_table_revoke_writes").
REVOKE ALL ON public.account_deletion_log FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON public.account_deletion_log FROM anon, authenticated;

-- No CREATE POLICY statements — RLS default-deny means service_role is the
-- only role with access. authenticated callers cannot read their own log
-- entry; for in-app "your data was deleted" UX use a dedicated read-RPC.

COMMENT ON TABLE public.account_deletion_log IS
  'Phase 5 Spatial V1.6 · Append-only DSGVO audit trail for account '
  'deletions. Service-role only (RLS default-deny + REVOKE writes). '
  'Sources: vercel (api/delete-account.ts pre-deleteUser path), trigger '
  '(handle_auth_user_delete_cascade safety-net), admin_console (manual '
  'ASC/Dashboard ops).';

COMMENT ON COLUMN public.account_deletion_log.buckets_cleared IS
  'JSONB array of bucket names that were processed during cleanup, e.g. '
  '["project-scans","spatial-mesh-snapshots",...]. spatial-public-assets '
  'MUST NEVER appear here (shared assets, not user-owned).';

COMMENT ON COLUMN public.account_deletion_log.files_removed IS
  'Total count of storage.objects rows removed across all buckets in this '
  'cleanup run. 0 is valid (user had no uploads).';

COMMENT ON COLUMN public.account_deletion_log.error_detail IS
  'NULL on success. Semicolon-separated per-bucket errors when partial '
  'failure occurred. If non-NULL the corresponding source path must have '
  'returned 500 and NOT called admin.auth.admin.deleteUser.';

NOTIFY pgrst, 'reload schema';

-- ── Rollback (manual) ─────────────────────────────────────────────────
-- DROP TABLE public.account_deletion_log;
