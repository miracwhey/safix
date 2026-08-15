-- =============================================================================
-- Migration: Block P · P1.5 — realign ledger_entries write shape to PROD
-- =============================================================================
-- WHY
--   The ledger_entries surface drifted hard from prod. The release RPC and the
--   TS webhook/supplementary writers all emit a SHAPE that prod rejects on the
--   first real escrow movement:
--     - prod column is entry_type (NOT NULL, CHECK enum) — writers set legacy
--       nullable `type`, leaving entry_type NULL -> 23502
--     - 'tranche_release' / 'transfer_reversal' / 'supplementary_*' are NOT in
--       the prod entry_type enum -> 23514
--     - prod has NO `note` column — writers target a column that does not exist
--     - created_at is timestamptz — the RPC wrote epoch-ms bigint into it
--     - id/payment_id/job_id are uuid — the text params need ::uuid casts
--
--   Source of truth = PROD DB (project itdntawwuzqfwmcwnwjr), verified live
--   2026-06-13 (0 rows). Repo migration files for this table are drifted and are
--   NOT authoritative. This migration supersedes the broken body of
--   20260420000008_release_tranche_with_ledger.sql via CREATE OR REPLACE.
--
-- WHAT
--   1. PROD-EFFECTIVE schema change: add a real discriminator column
--      `movement_ref text NOT NULL DEFAULT ''` and replace the too-narrow
--      UNIQUE(payment_id, entry_type) with UNIQUE(payment_id, entry_type,
--      movement_ref). One payment has N tranches (deposit_release + final_release)
--      and N supplementary movements; all of them legitimately share a
--      (payment_id, entry_type) pair (e.g. both tranche releases map to 'payout').
--      The old aggregate unique cannot represent that — the second tranche release
--      would 23505 *after* Stripe already moved the money (split-brain). The
--      movement_ref discriminator (tranche_id / sprId / reversalId / '') lets every
--      distinct movement coexist while still deduping retries on the real business
--      key. A plain column (not an expression index) is required because PostgREST
--      `.upsert(onConflict:...)` can only target NAMED columns.
--   2. LOCAL-CONVERGENCE guards (idempotent; no-op on prod where these already
--      exist) so the drifted repo-chain local schema also accepts the realigned
--      writes and the pgTAP shape test (09) runs.
--   3. CREATE OR REPLACE release_tranche_with_ledger with the prod-valid ledger
--      INSERT (entry_type='payout', metadata jsonb carrying the note, ::uuid casts,
--      id + created_at omitted -> column DEFAULTs, ON CONFLICT on the widened key).
--
-- 0-row-safe: prod and a fresh local boot both have 0 ledger_entries rows, so the
-- ALTER ... SET NOT NULL and the unique-index swap are non-destructive.
--
-- DOES NOT touch prod. Gated — apply is a separate, explicitly-confirmed step.
-- =============================================================================

-- ── 1. PROD-EFFECTIVE: discriminator column + widened unique ─────────────────
ALTER TABLE public.ledger_entries
  ADD COLUMN IF NOT EXISTS movement_ref text NOT NULL DEFAULT '';

-- Drop the too-narrow aggregate unique (prod has it as a CONSTRAINT backing an
-- index of the same name; dropping the constraint drops the index).
ALTER TABLE public.ledger_entries
  DROP CONSTRAINT IF EXISTS ledger_entries_payment_entrytype_unique;

-- Legacy local partial unique on (payment_id, type) from the drifted repo chain.
DROP INDEX IF EXISTS public.idx_ledger_entries_payment_type_nonrepeating;

-- The real business key: one row per (payment, movement-class, movement-instance).
CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_payment_entrytype_movement_uidx
  ON public.ledger_entries (payment_id, entry_type, movement_ref);

-- ── 2. LOCAL-CONVERGENCE (idempotent; no-op on prod) ─────────────────────────
-- Bridge the drifted repo-chain schema (text id PK, type NOT NULL, no
-- entry_type/metadata/currency/created_at/dispute_id) up to the prod shape so the
-- realigned writers + the pgTAP test work on a fresh local stack too. None of
-- these fire on prod, where every column/constraint already exists.
ALTER TABLE public.ledger_entries ADD COLUMN IF NOT EXISTS entry_type text;
ALTER TABLE public.ledger_entries ADD COLUMN IF NOT EXISTS currency text DEFAULT 'EUR';
ALTER TABLE public.ledger_entries ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.ledger_entries ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;
ALTER TABLE public.ledger_entries ADD COLUMN IF NOT EXISTS dispute_id uuid;
ALTER TABLE public.ledger_entries ALTER COLUMN id SET DEFAULT gen_random_uuid();

-- Repo chain has `type` NOT NULL; the realigned writers omit it (legacy column).
ALTER TABLE public.ledger_entries ALTER COLUMN type DROP NOT NULL;

-- entry_type must be NOT NULL (prod). Safe: 0 rows on prod and a fresh local boot.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='ledger_entries'
      AND column_name='entry_type' AND is_nullable='NO'
  ) THEN
    ALTER TABLE public.ledger_entries ALTER COLUMN entry_type SET NOT NULL;
  END IF;
END $$;

-- entry_type enum CHECK (prod values).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='ledger_entries_entry_type_check'
  ) THEN
    ALTER TABLE public.ledger_entries
      ADD CONSTRAINT ledger_entries_entry_type_check
      CHECK (entry_type IN (
        'escrow_deposit','platform_fee','payout','refund','dispute_hold',
        'refund_partial','payout_adjustment','escrow_release','escrow_refund'
      ));
  END IF;
END $$;

-- amount >= 0 CHECK (prod).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='ledger_entries_amount_positive'
  ) THEN
    ALTER TABLE public.ledger_entries
      ADD CONSTRAINT ledger_entries_amount_positive CHECK (amount >= 0);
  END IF;
END $$;

-- ── 3. CREATE OR REPLACE the release RPC with the prod-valid ledger INSERT ────
-- Body preserved VERBATIM from prod except section 5 (the ledger write). The
-- column ALTERs above precede this so check_function_bodies validates the new
-- entry_type / metadata / movement_ref references at CREATE time.
CREATE OR REPLACE FUNCTION public.release_tranche_with_ledger(
  p_tranche_id       text,
  p_plan_id          text,
  p_transfer_id      text,
  p_actor            text,
  p_released_at      timestamptz,
  p_net_amount       numeric,
  p_currency         text    DEFAULT 'EUR',
  p_payment_id       text    DEFAULT NULL,
  p_job_id           text    DEFAULT NULL,
  p_ledger_entry_id  text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tranche          RECORD;
  v_total            bigint;
  v_released_count   bigint;
  v_plan_status      text;
  v_outcome          text;
BEGIN
  -- ── 1. Lock tranche row ────────────────────────────────────────────────────
  SELECT id, status, external_release_ref, kind
  INTO v_tranche
  FROM escrow_tranches
  WHERE id = p_tranche_id::uuid
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'outcome',          'not_found',
      'plan_status',      null,
      'total_tranches',   0,
      'released_tranches',0
    );
  END IF;

  -- ── 2. Idempotency check ───────────────────────────────────────────────────
  IF v_tranche.external_release_ref IS NOT NULL
     AND v_tranche.external_release_ref = p_transfer_id
  THEN
    -- Already recorded this exact transfer — safe no-op
    SELECT COUNT(*) INTO v_total
    FROM escrow_tranches WHERE plan_id = p_plan_id::uuid;
    SELECT COUNT(*) INTO v_released_count
    FROM escrow_tranches WHERE plan_id = p_plan_id::uuid AND status = 'released';
    RETURN jsonb_build_object(
      'outcome',           'already_recorded',
      'plan_status',       (SELECT status FROM escrow_payment_plans WHERE id = p_plan_id::uuid),
      'total_tranches',    v_total,
      'released_tranches', v_released_count
    );
  END IF;

  -- ── 3. Update tranche ─────────────────────────────────────────────────────
  UPDATE escrow_tranches
  SET
    status               = 'released',
    external_release_ref = p_transfer_id,
    released_by          = p_actor,
    released_at          = p_released_at,
    updated_at           = now()
  WHERE id = p_tranche_id::uuid;

  v_outcome := 'released';

  -- ── 4. Plan status rollup ─────────────────────────────────────────────────
  SELECT COUNT(*) INTO v_total
  FROM escrow_tranches WHERE plan_id = p_plan_id::uuid;

  -- Exclude reversed tranches — mirrors the fix in 20260417000002_reversal_model.sql
  SELECT COUNT(*) INTO v_released_count
  FROM escrow_tranches
  WHERE plan_id = p_plan_id::uuid
    AND status = 'released'
    AND transfer_reversal_ref IS NULL;

  v_plan_status := CASE
    WHEN v_released_count >= v_total THEN 'fully_released'
    WHEN v_released_count > 0        THEN 'partially_released'
    ELSE                                  'funded_in_escrow'
  END;

  UPDATE escrow_payment_plans
  SET status = v_plan_status, updated_at = now()
  WHERE id = p_plan_id::uuid;

  -- ── 5. Ledger entry (prod-valid shape; best-effort within same tx) ─────────
  -- A tranche release moves NET escrowed money OUT to the provider via a Stripe
  -- transfer = the canonical 'payout' movement. Both deposit_release and
  -- final_release map to 'payout'; the (payment_id,'payout') collision is solved
  -- structurally by movement_ref = p_tranche_id (each tranche is a distinct row).
  -- id omitted  -> DEFAULT gen_random_uuid()
  -- created_at omitted -> DEFAULT now() (timestamptz; never epoch-ms)
  -- legacy 'type' left NULL; the note string moves into metadata jsonb.
  -- Guard unchanged: the caller always passes both p_payment_id + p_ledger_entry_id.
  IF p_payment_id IS NOT NULL AND p_ledger_entry_id IS NOT NULL THEN
    INSERT INTO ledger_entries (
      payment_id, job_id, entry_type, amount, currency, metadata, movement_ref
    )
    VALUES (
      p_payment_id::uuid,
      COALESCE(
        NULLIF(p_job_id, '')::uuid,
        (SELECT job_id FROM escrow_payment_plans WHERE id = p_plan_id::uuid)
      ),
      'payout',
      p_net_amount,
      p_currency,
      jsonb_build_object(
        'note',        'Tranche released via Stripe transfer ' || p_transfer_id,
        'transfer_id', p_transfer_id,
        'actor',       p_actor,
        'tranche_id',  p_tranche_id
      ),
      p_tranche_id
    )
    ON CONFLICT (payment_id, entry_type, movement_ref) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'outcome',           v_outcome,
    'plan_status',       v_plan_status,
    'total_tranches',    v_total,
    'released_tranches', v_released_count
  );
END;
$$;

-- Restrict to service_role only (re-issued verbatim on the same signature).
REVOKE ALL     ON FUNCTION public.release_tranche_with_ledger(text,text,text,text,timestamptz,numeric,text,text,text,text) FROM PUBLIC;
REVOKE ALL     ON FUNCTION public.release_tranche_with_ledger(text,text,text,text,timestamptz,numeric,text,text,text,text) FROM anon;
REVOKE ALL     ON FUNCTION public.release_tranche_with_ledger(text,text,text,text,timestamptz,numeric,text,text,text,text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.release_tranche_with_ledger(text,text,text,text,timestamptz,numeric,text,text,text,text) TO service_role;

-- ── 4. Defensive PostgREST schema-cache reload ───────────────────────────────
NOTIFY pgrst, 'reload schema';
