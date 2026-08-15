-- Spatial Canonical · Phase 3 · Block 3.12 · Verify-State Resume Columns
--
-- Purpose:
--   Additive, passive follow-on migration for the Customer-Verify-Flow
--   (Implementation-Spec §5.1 / §5.2). The base `spatial_scenes` migration
--   `20260520120001` shipped `customer_verify_state` but NOT the two columns
--   the App-Kill / Re-Enter resume needs:
--     - `customer_verify_last_stage`     — the 1-5 sub-stage the customer last
--        saw (drives `resolveResumeStage`).
--     - `customer_verify_last_active_at` — last activity timestamp (drives the
--        VF-4 verify-reminder 24h/72h cadence + the "Du warst bei … — weiter?"
--        re-prompt).
--
-- Removed-block note (2026-05-20 · EXT-1 prod-apply drift sweep):
--   An earlier revision also carried a §2 block running
--   `ALTER TABLE public.spatial_scene_job_links ADD COLUMN provider_verify_*`.
--   That table is created by NO migration and referenced by NO TypeScript —
--   it never existed in repo or prod, so the ALTER failed the prod apply.
--   The block was dead and unused (zero `provider_verify_state` refs in src/)
--   and has been dropped. If Provider-Verify tracking lands later it must
--   first introduce the scene↔job link table in its own migration.
--
-- Why passive (no extra confirm · CLAUDE.md "Passive steps · schema migrations"):
--   every column is NULLABLE with a safe default; no column is dropped, no
--   shipped column is altered, no data is backfilled. The migration is
--   forward-only (R9) and applies cleanly to an empty or populated table.
--
-- NOT applied to prod in Phase 3 — Phase 1-4 run on the InMemory repository.
--   This file is numbered into the canonical sequence; the Phase-5-Apply step
--   lands it together with `20260520120001-…120031`.
--
-- Plan reference: spatial-v1-verify-flow-implementation-spec.md §5.1 / §5.2 / §6 #2-3.

-- ── 1. spatial_scenes · resume columns (Block 3.12) ──────────────────────────

ALTER TABLE public.spatial_scenes
  ADD COLUMN IF NOT EXISTS customer_verify_last_stage      integer     NULL,
  ADD COLUMN IF NOT EXISTS customer_verify_last_active_at  timestamptz NULL;

-- The stage index is the 1-based VerifyStage value (1=Welcome … 5=Confirm).
-- A CHECK keeps a corrupt write out of the resume path; the TS resolver
-- (`resolveResumeStage`) also clamps defensively so an out-of-range value can
-- never crash an old client.
ALTER TABLE public.spatial_scenes
  DROP CONSTRAINT IF EXISTS spatial_scenes_customer_verify_last_stage_chk;
ALTER TABLE public.spatial_scenes
  ADD  CONSTRAINT spatial_scenes_customer_verify_last_stage_chk
    CHECK (customer_verify_last_stage IS NULL
           OR customer_verify_last_stage BETWEEN 1 AND 5);

COMMENT ON COLUMN public.spatial_scenes.customer_verify_last_stage IS
  'Verify-Flow Block 3.12: 1-5 sub-stage index the customer last saw '
  '(1=Welcome, 2=Maße, 3=Layout, 4=Pins, 5=Confirm). Drives App-Kill/Re-Enter '
  'resume via resolveResumeStage(). NULL = never entered verify.';

COMMENT ON COLUMN public.spatial_scenes.customer_verify_last_active_at IS
  'Verify-Flow Block 3.12: timestamp of the customer''s last verify activity '
  '(sheet-open or stage mutation). Drives the VF-4 verify-reminder cadence '
  '(24h push / 72h email) and the re-prompt copy. NULL = never entered verify.';

-- ── 1b. spatial_scenes · verify-reminder de-dup columns (Block 3.11 · VF-4) ──
-- The VF-4 reminder cadence (`verifyReminder.ts` · resolveVerifyReminderChannel)
-- is purely time-driven: between 24h and 72h since last activity it returns
-- 'push', and at/after 72h it returns 'email'. An hourly cron would therefore
-- re-fire the SAME channel on every run for the whole window. These two columns
-- give the per-scene logic the de-dup state it needs: the resolver returns
-- 'none' for a channel that was already sent for the current activity anchor.
-- The cron deploy itself stays deferred (Phase 5) — only the per-scene logic
-- becomes dedup-correct here.

ALTER TABLE public.spatial_scenes
  ADD COLUMN IF NOT EXISTS customer_verify_last_reminder_sent_at  timestamptz NULL,
  ADD COLUMN IF NOT EXISTS customer_verify_last_reminder_channel  text        NULL;

ALTER TABLE public.spatial_scenes
  DROP CONSTRAINT IF EXISTS spatial_scenes_customer_verify_last_reminder_channel_chk;
ALTER TABLE public.spatial_scenes
  ADD  CONSTRAINT spatial_scenes_customer_verify_last_reminder_channel_chk
    CHECK (customer_verify_last_reminder_channel IS NULL
           OR customer_verify_last_reminder_channel IN ('push', 'email'));

COMMENT ON COLUMN public.spatial_scenes.customer_verify_last_reminder_sent_at IS
  'Verify-Flow Block 3.11 (VF-4): timestamp the last verify-reminder was sent '
  'for this scene. De-dup anchor for resolveVerifyReminderChannel — a channel '
  'already sent after the current customer_verify_last_active_at is not '
  're-fired. NULL = no reminder sent yet.';

COMMENT ON COLUMN public.spatial_scenes.customer_verify_last_reminder_channel IS
  'Verify-Flow Block 3.11 (VF-4): channel of the last verify-reminder sent '
  '(push | email). Lets the resolver suppress a duplicate same-channel push '
  'while still allowing the 72h email escalation. NULL = no reminder sent yet.';

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- ALTER TABLE public.spatial_scenes
--   DROP CONSTRAINT IF EXISTS spatial_scenes_customer_verify_last_stage_chk,
--   DROP CONSTRAINT IF EXISTS spatial_scenes_customer_verify_last_reminder_channel_chk,
--   DROP COLUMN IF EXISTS customer_verify_last_stage,
--   DROP COLUMN IF EXISTS customer_verify_last_active_at,
--   DROP COLUMN IF EXISTS customer_verify_last_reminder_sent_at,
--   DROP COLUMN IF EXISTS customer_verify_last_reminder_channel;
