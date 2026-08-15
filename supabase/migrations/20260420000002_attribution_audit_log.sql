-- Attribution Audit Log — durable, operator-visible history of every
-- attribution-related state transition.
--
-- Purpose:
--   - Forensic trail for DLQ-resolved jobs (why it was stuck, who resolved).
--   - Signal for operator dashboards + Sentry cross-reference.
--   - Distinct from timeline_signals: this is attribution-internal, not a
--     user-visible lifecycle event.  Operator-scoped only.
--
-- Writers (ALL via SERVICE_ROLE only — no direct authenticated writes):
--   - finalize-attribution.ts (cron)          event types: finalize_auto, finalize_absent,
--                                                           retry_incremented, dlq_entered
--   - api/operator/resolve-attribution (Stage 4) event types: operator_resolve, operator_reclassify
--
-- Readers:
--   - Operators (via is_operator flag on profiles)
--   - SERVICE_ROLE (admin tooling)

CREATE TABLE IF NOT EXISTS public.attribution_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,

  event_type TEXT NOT NULL CHECK (event_type IN (
    'finalize_auto',        -- Finalizer resolved via customer_provider_relationships record
    'finalize_absent',      -- Finalizer finalized with platform_acquired (no record, no error)
    'retry_incremented',    -- Transient DB error → retry_count++, stays 'retrying'
    'dlq_entered',          -- Max retry exceeded OR missing IDs — terminal until operator acts
    'operator_resolve',     -- Operator finalized a DLQ job via RPC (Stage 4)
    'operator_reclassify'   -- Operator changed commercial_origin on an already-finalized job (Stage 4)
  )),

  from_status TEXT,
  to_status   TEXT,
  from_origin TEXT,
  to_origin   TEXT,
  retry_count INT,
  reason      TEXT,           -- DLQ reason code OR operator note OR finalizer diagnostic
  operator_id UUID,           -- non-null when event_type starts with 'operator_'
  metadata    JSONB,          -- worker or operator extras (error messages, IP, etc.)

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes tuned for the two primary access patterns:
--   1. Operator opens job detail → SELECT … WHERE job_id = $1 ORDER BY created_at DESC
--   2. Operator DLQ dashboard   → SELECT … WHERE event_type = 'dlq_entered' ORDER BY created_at DESC

CREATE INDEX IF NOT EXISTS idx_attribution_audit_log_job_id
  ON public.attribution_audit_log (job_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_attribution_audit_log_event_type_created_at
  ON public.attribution_audit_log (event_type, created_at DESC);

-- ── Operator-id requirement for operator events ──────────────────────────────
ALTER TABLE public.attribution_audit_log
  ADD CONSTRAINT attribution_audit_log_operator_id_required
  CHECK (
    event_type NOT IN ('operator_resolve', 'operator_reclassify')
    OR operator_id IS NOT NULL
  );

-- ── Reason requirement for DLQ entry ─────────────────────────────────────────
-- The DLQ transition must always document why — matches jobs.attribution_dlq_reason NOT NULL.
ALTER TABLE public.attribution_audit_log
  ADD CONSTRAINT attribution_audit_log_dlq_reason_required
  CHECK (event_type <> 'dlq_entered' OR reason IS NOT NULL);

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.attribution_audit_log ENABLE ROW LEVEL SECURITY;

-- Writes: SERVICE_ROLE only.  No policy for authenticated users → they cannot INSERT.
-- (RLS denies by default when no policy grants access.)

-- Reads: operators can see all rows; everyone else is denied.
-- Operators are identified via profiles.is_operator = true (same pattern as other
-- operator-scoped tables in this repo).
CREATE POLICY "attribution_audit_log_operator_read"
  ON public.attribution_audit_log
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.is_operator IS TRUE
    )
  );

-- ── Grants ───────────────────────────────────────────────────────────────────
-- SERVICE_ROLE: full access for worker + operator RPCs.
-- authenticated: SELECT only (gated by the operator RLS policy above).
GRANT SELECT ON public.attribution_audit_log TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.attribution_audit_log TO service_role;

COMMENT ON TABLE public.attribution_audit_log IS
  'Operator-visible forensic history of attribution lifecycle transitions. Written by finalize-attribution cron and operator RPCs only.';
