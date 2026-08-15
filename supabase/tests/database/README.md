# pgTAP behavioral tests (`supabase/tests/database/`)

Behavioral DB tests that exercise **real** RLS enforcement and a **real** DB-level
fee-tier invariant against actual FixUp tables. These satisfy the CLAUDE.md
contract: _"auth / RLS / FSM / Money brauchen Behavioral-Repro (pgTAP oder echte
Session) — Review-Lesen allein reicht nicht."_

## Files

| File | Proves | Target table (verified-real) |
|------|--------|-------------------------------|
| `01_rls_notification_device_tokens_cross_tenant.sql` | Tenant B cannot SELECT/UPDATE/DELETE/forge tenant A's row; tenant A's allowed read+insert path works | `public.notification_device_tokens` — `supabase/migrations/20260420000010_notification_device_tokens.sql` |
| `02_commercial_fee_origin_invariant.sql` | Only `merchant_brought` (5% tier) and `platform_acquired` (9% tier) persist; any other origin (the would-be 12% tier) is rejected with CHECK violation `23514` | `public.customer_provider_relationships` — `supabase/migrations/20260409000004_commercial_attribution.sql` |
| `03_dsgvo1_moderation_log_account_delete.sql` | Account-delete survives moderation-log FKs (SET NULL), row stays anonymized, append-only `42501` | `public.moderation_action_log` — `supabase/migrations/20260610000000_dsgvo1_moderation_log_fk_set_null.sql` |
| `04_rls_signals_symmetric_insert.sql` | Customer + provider + assigned-provider can INSERT/SELECT/UPDATE their job's signals (text ids, no `22P02`/`42501`); foreign provider + anon fenced | `public.notification_signals` / `public.timeline_signals` — `supabase/migrations/20260610155500_chat4_signals_symmetric_insert_text_ids.sql` |
| `05_c5_dispute_decision_immutability.sql` | Resolved dispute cannot be re-resolved with another decision (`P0001 decision_immutable`); settled is a no-op; reject settles as `pending` (C4) | dispute operator RPCs — `supabase/migrations/20260610090000_c4_c5_dispute_decision_immutability.sql` |
| `06_h12_jobs_terminal_status_immutability.sql` | Non-operator cannot leave terminal `completed`/`cancelled` (`23514`); no-op writes pass (WHEN-gated); service-role/operator exempt; `finalize_payment_state_atomic` safe on completed jobs | `public.jobs` trigger — `supabase/migrations/20260610154500_h12_jobs_terminal_status_immutability.sql` |
| `07_chat_inquiry_rpc_metadata.sql` | Inquiry columns/index exist; extended `rpc_get_or_create_chat_customer_thread` persists inquiry+display metadata, old 2-param overload gone, pair-reuse never overwrites; `rpc_update_chat_thread_inquiry_state` is craftsman-only + set-only-if-null; anon revoked on both | `public.chat_threads` — `supabase/migrations/20260611000000_chat_inquiry_metadata.sql` |
| `08_legacy_anon_hygiene.sql` | After the final retire: anon fully revoked on `conversations`/`messages`; authenticated read-only (bridge grants gone); service_role keeps full access. RED until `20260611200000` is applied (Slice-E gate) | `public.conversations` / `public.messages` — `supabase/migrations/20260611200000_legacy_conversations_final_retire.sql` |
| `12_funding_cancel_split_atomicity.sql` | Incompatible funding plans write nothing; cancel-vs-confirm serializes on the job; funded jobs cannot be cancelled; sibling split reservations cannot double-spend provider quota | funding/job cancellation triggers + `confirm_funding_atomic` + split reservation RPCs — migrations `20260713002430` / `20260713002434` |

Files 03–08 target migrations that are **written but not yet applied to prod**
(release gate 2026-06-10); they only pass on a DB where those migrations ran
(post-apply / prod-near stack). See `~/.claude/plans/release-gate-2026-06-10/gate-d-runbook.md`.

Both tests reference **verified-real, current** schema. Confirmed against the
migration ledger that no later migration breaks the assumptions:
- `notification_device_tokens`: later migrations only add an index + read it; no
  column/policy change (`20260503000003`, `20260509000002`).
- `customer_provider_relationships.commercial_origin` CHECK is **unchanged** —
  `20260410000001` widens the `'unknown_pending_resolution'` state on **`jobs`/
  `projects` only** ("never stored in customer_provider_relationships");
  `20260410000002` adds `jobs`-only columns; no triggers exist on CPR.

## Run command

```bash
cd /Users/leonvalentin/FixUp
supabase start        # one-time per machine session (boots local Postgres, applies all migrations)
supabase test db      # runs pg_prove -r over supabase/tests/**/*.sql (auto-discovers this dir)
```

Debug a failure: `supabase test db --debug`.

The CLI invokes `pg_prove --ext .pg --ext .sql -r supabase/tests` (recursive), so
files in `supabase/tests/database/` are auto-discovered — no path argument needed.

## Helper-install approach (no prod pollution)

The `tests.create_supabase_user` / `get_supabase_uid` / `authenticate_as` /
`authenticate_as_service_role` functions follow the **basejump
`supabase-test-helpers`** patterns, but are **vendored INLINE** inside each test's
`BEGIN … ROLLBACK`:

- **Deliberately NOT a migration.** `create_supabase_user` inserts into
  `auth.users`; shipping that helper to prod via `supabase/migrations/` is a real
  security smell on a money+PII app. Inlining inside a rolled-back transaction
  means the helpers — and the `auth.users` rows, and pgTAP itself — **never
  persist** to any database.
- **No separate `.sql` helper file under this directory.** `pg_prove -r` would
  pick up any `*.sql`/`*.pg` file here and run it as a standalone test (no plan →
  failure). Inlining sidesteps that entirely and makes each file runnable on its
  own.
- **pgTAP** is enabled transiently per file (`create extension if not exists pgtap
  with schema extensions;` inside the rolled-back tx). It is available in the
  Supabase local Postgres image but is **not** enabled by any of the repo
  migrations, and we keep it that way.

Canonical alternative (if you later want shared helpers): vendor
`usebasejump/supabase-test-helpers` (release `0.0.6`) as a file with a
**non-`.sql`/`.pg` extension** (e.g. `_helpers.psql`) and `\ir` it from each test,
or install via `dbdev`. Not used here to keep the harness self-contained.

## External setup dependencies

Running these is **EXTERNAL** — they are wired and self-contained, but cannot run
in this environment as-is:

1. **supabase CLI** — present (`/opt/homebrew/bin/supabase`, v2.95.4). ✅
2. **Docker** — daemon must be running. ✅ available locally.
3. **`supabase start`** — the local stack is **down** and must be started first.
   This applies the full migration chain (~319 files) to an ephemeral local
   Postgres. Note: per the project's documented systemic migration-ledger drift,
   a full local apply can fail somewhere in the chain even though prod is healthy;
   if `supabase start` aborts, fix the offending local migration before tests can
   run. The two target tables' own migrations apply cleanly in isolation.
4. **pgTAP / pg_prove** — bundled in the Supabase local Postgres + pg_prove
   container images; nothing to install. (`pg_prove` is **not** installed on the
   host, but `supabase test db` runs it in Docker, so the host binary is not
   needed.)

Nothing here touches prod, money, or PII: the linked prod project
(`itdntawwuzqfwmcwnwjr`) is never contacted by `supabase test db --local`
(the default), and every test rolls back.

## CI

These are **not** part of the required `ci.yml` pipeline (`type-check + lint +
vitest`) — pg_prove needs Docker/Postgres and would slow/destabilize the gate.
If wanted in CI later, add a **separate, non-required** workflow (named anything
other than `CI` to stay decoupled from the Pages deploy chain) using
`supabase/setup-cli` → `supabase db start` → `supabase test db`. See the draft
`quality-gates.yml` from the CI-grounding analysis.
