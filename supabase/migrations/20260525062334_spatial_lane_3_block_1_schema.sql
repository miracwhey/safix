-- Spatial Lane 3 · Block 1 · Schema Extension
-- Adds ownership + customer-sharing columns to public.scans.
-- Existing captures: owner_type = 'craftsman', shared_with_customer = false (auto via DEFAULT).
-- Self-Scan captures (Block 4): owner_type = 'customer', job_id nullable via relaxed CHECK.

ALTER TABLE public.scans
  ADD COLUMN IF NOT EXISTS owner_type text NOT NULL DEFAULT 'craftsman',
  ADD COLUMN IF NOT EXISTS shared_with_customer boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shared_at timestamptz NULL;

ALTER TABLE public.scans
  DROP CONSTRAINT IF EXISTS scans_owner_type_chk;
ALTER TABLE public.scans
  ADD CONSTRAINT scans_owner_type_chk
  CHECK (owner_type IN ('craftsman', 'customer'));

-- Relax anchor CHECK for customer Self-Scan
ALTER TABLE public.scans
  DROP CONSTRAINT IF EXISTS scans_owner_anchor_chk;
ALTER TABLE public.scans
  ADD CONSTRAINT scans_owner_anchor_chk
  CHECK (
    job_id IS NOT NULL
    OR project_id IS NOT NULL
    OR presales_project_id IS NOT NULL
    OR owner_type = 'customer'
  );

-- Sharing coherence: shared_with_customer = true only valid with job_id
ALTER TABLE public.scans
  DROP CONSTRAINT IF EXISTS scans_sharing_requires_job_chk;
ALTER TABLE public.scans
  ADD CONSTRAINT scans_sharing_requires_job_chk
  CHECK (
    shared_with_customer = false
    OR job_id IS NOT NULL
  );

CREATE INDEX IF NOT EXISTS scans_owner_type_idx
  ON public.scans (owner_type)
  WHERE owner_type = 'customer';

CREATE INDEX IF NOT EXISTS scans_shared_with_customer_idx
  ON public.scans (job_id, shared_with_customer)
  WHERE shared_with_customer = true;

ALTER TABLE public.scans REPLICA IDENTITY FULL;

COMMENT ON COLUMN public.scans.owner_type IS
  'Lane 3 V1.6: craftsman = HW-owned capture (default), customer = Customer Self-Scan (Block 4). Discriminates sharing semantics.';
COMMENT ON COLUMN public.scans.shared_with_customer IS
  'Lane 3 V1.6: HW-toggled sharing gate (Block 2 UI). true = job customer can view this scan. Only meaningful when job_id IS NOT NULL (enforced by CHECK).';
COMMENT ON COLUMN public.scans.shared_at IS
  'Lane 3 V1.6: timestamp of last share action (set by sharing trigger, cleared on unshare).';
