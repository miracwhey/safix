#!/usr/bin/env node
/**
 * Spatial V1.6.1 · self-contained behavioral RLS / RPC prod-repro.
 *
 * Creates its OWN throwaway fixtures (2 users + a customer self-scan scene),
 * exercises the two SECURITY DEFINER auth-gates with REAL authenticated
 * sessions (the thing MCP `execute_sql` cannot do — it runs privileged so
 * `auth.uid()` never fires), then deletes everything. Idempotent-ish: a unique
 * run-id namespaces the users so re-runs never collide; teardown runs in a
 * `finally` so a mid-run failure still cleans up.
 *
 * Gates verified (both REJECTION paths — raise BEFORE any write):
 *   A · M3 recipient gate     — non-recipient → spatial_set_customer_verify_state → 42501
 *   C · M2 variant-spoof guard — customer → spatial_edit_history_append(spoofed variant) → 42501
 *   B · M3 happy path          — customer → own verify-state legal edge → allowed (then reverted)
 *
 * Requires (service_role does setup/teardown; anon drives the gate sessions):
 *   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage:
 *   set -a; source .env.local; set +a   # if the keys live there
 *   SUPABASE_SERVICE_ROLE_KEY=… node scripts/dev/spatial-v161-rls-fixture-and-repro.mjs
 *
 * Exit 0 = every gate held; 1 = a gate did NOT hold (security regression) or setup failed.
 */

import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

const url = process.env.VITE_SUPABASE_URL
const anon = process.env.VITE_SUPABASE_ANON_KEY
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY

function die(msg) {
  console.error(`\n[rls-repro] FATAL: ${msg}\n`)
  process.exit(1)
}
if (!url || !anon) die('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY required')
if (!serviceRole) die('SUPABASE_SERVICE_ROLE_KEY required (setup/teardown + read-only claim-check)')

const admin = createClient(url, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } })
const runId = randomUUID().slice(0, 8)
const PASSWORD = `Rls-Repro-${runId}!`
const customerEmail = `rls-repro-customer-${runId}@fixup-test.invalid`
const otherEmail = `rls-repro-other-${runId}@fixup-test.invalid`

let pass = 0, fail = 0
function assert(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  ✅ PASS · ${name}`) }
  else { fail += 1; console.log(`  ❌ FAIL · ${name} — ${detail}`) }
}
/** A Postgres RAISE…USING ERRCODE='42501' surfaces as error.code on the PostgrestError. */
function is42501(error) {
  if (!error) return false
  return error.code === '42501' || /42501|not the scene customer|may not write variant/i.test(error.message ?? '')
}
async function freshSignIn(email, password, label) {
  const sb = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await sb.auth.signInWithPassword({ email, password })
  if (error || !data.session) die(`signIn(${label}) failed: ${error?.message ?? 'no session'}`)
  return sb
}

let customerId = null, otherId = null, scanId = null, sceneId = null

try {
  // ── 0 · Read-only claim-check (independent of the migration's own assertions) ──
  console.log('── 0 · Prod claim-check (pre-fixture clean window) ──────────────')
  const scenesBefore = await admin.from('spatial_scenes').select('id', { count: 'exact', head: true })
  const historyBefore = await admin.from('spatial_edit_history').select('id', { count: 'exact', head: true })
  console.log(`  spatial_scenes count       = ${scenesBefore.count ?? '?'}`)
  console.log(`  spatial_edit_history count = ${historyBefore.count ?? '?'} (clean window expects 0)`)
  const sceneBaseline = scenesBefore.count ?? 0
  const historyBaseline = historyBefore.count ?? 0

  // ── 1 · Create two throwaway users (email-confirmed) ─────────────────────────
  console.log('\n── 1 · Create fixture users ─────────────────────────────────────')
  const cu = await admin.auth.admin.createUser({ email: customerEmail, password: PASSWORD, email_confirm: true })
  if (cu.error || !cu.data.user) die(`createUser(customer) failed: ${cu.error?.message}`)
  customerId = cu.data.user.id
  const ou = await admin.auth.admin.createUser({ email: otherEmail, password: PASSWORD, email_confirm: true })
  if (ou.error || !ou.data.user) die(`createUser(other) failed: ${ou.error?.message}`)
  otherId = ou.data.user.id
  console.log(`  customer=${customerId}  other=${otherId}`)

  // profiles are created by the on_auth_user_created trigger; wait + verify.
  let profileOk = false
  for (let i = 0; i < 10 && !profileOk; i += 1) {
    const p = await admin.from('profiles').select('id').eq('id', customerId).maybeSingle()
    profileOk = !!p.data
    if (!profileOk) await new Promise((r) => setTimeout(r, 250))
  }
  if (!profileOk) die('customer profiles row not created by trigger — cannot anchor scan (captured_by → profiles)')

  // ── 2 · Customer self-scan scene fixture (service_role bypasses RLS) ─────────
  console.log('\n── 2 · Create self-scan + scene fixture ─────────────────────────')
  const scan = await admin.from('scans').insert({
    captured_by: customerId,
    owner_type: 'customer',          // relaxed anchor: no job/project needed
    source: 'roomplan',
    status: 'draft',
    device_meta: {},
  }).select('id').single()
  if (scan.error) die(`scan insert failed: ${scan.error.message}`)
  scanId = scan.data.id
  const scene = await admin.from('spatial_scenes').insert({
    source_scan_id: scanId,
    parametric_storage_path: `fixture/rls-repro/${runId}.bin`, // dummy — never read by the gates
  }).select('id').single()
  if (scene.error) die(`scene insert failed: ${scene.error.message}`)
  sceneId = scene.data.id
  console.log(`  scan=${scanId}  scene=${sceneId}`)

  const customer = await freshSignIn(customerEmail, PASSWORD, 'customer')
  const other = await freshSignIn(otherEmail, PASSWORD, 'other')

  // ── A · M3 recipient gate ────────────────────────────────────────────────────
  console.log('\n── A · M3 recipient gate (other → 42501) ────────────────────────')
  {
    const { data, error } = await other.rpc('spatial_set_customer_verify_state', {
      p_scene_id: sceneId, p_state: 'in_progress', p_stage: 2,
    })
    assert('non-recipient set_customer_verify_state → 42501', is42501(error) && !data,
      error ? `code=${error.code} msg="${error.message}"` : `NO error — write allowed! data=${JSON.stringify(data)}`)
  }

  // ── C · M2 variant-spoof guard ───────────────────────────────────────────────
  console.log('\n── C · M2 variant-spoof guard (customer spoof → 42501) ──────────')
  {
    const { data, error } = await customer.rpc('spatial_edit_history_append', {
      p_scene_id: sceneId,
      p_variant_id: 'operator_review',   // SPOOF — customer's writable variant is customer_corrections
      p_base_node_id: 'rls-repro-node',
      p_override_fields: {},
      p_command: 'set',
      p_sha_before: null,
      p_sha_after: null,
      p_semantic_op: 'move_node',
    })
    assert('customer spoof variant=operator_review → 42501', is42501(error) && !data,
      error ? `code=${error.code} msg="${error.message}"` : `NO error — spoofed append allowed! data=${JSON.stringify(data)}`)
  }

  // ── B · M3 happy path (customer self, reverted) ──────────────────────────────
  console.log('\n── B · M3 happy path (customer self-scan, then revert) ──────────')
  {
    const up = await customer.rpc('spatial_set_customer_verify_state', {
      p_scene_id: sceneId, p_state: 'in_progress', p_stage: 1,   // not_started → in_progress = legal edge
    })
    assert('customer set own verify-state → allowed', !up.error && !!up.data,
      up.error ? `code=${up.error.code} msg="${up.error.message}"` : 'no row returned')
    // Best-effort revert (in_progress → not_started is NOT a legal FSM edge, so this
    // is expected to fail; the fixture is deleted in teardown regardless).
    const rev = await customer.rpc('spatial_set_customer_verify_state', {
      p_scene_id: sceneId, p_state: 'not_started', p_stage: 1,
    })
    console.log(`  revert→not_started: ${rev.error ? `rejected (${rev.error.code}, expected — illegal edge)` : 'ok'}`)
  }

  // ── Assert the clean window is intact (no rejected write leaked through) ──────
  console.log('\n── Clean-window integrity re-check ──────────────────────────────')
  const historyAfter = await admin.from('spatial_edit_history').select('id', { count: 'exact', head: true })
  assert('edit_history unchanged by rejected appends', (historyAfter.count ?? -1) === historyBaseline,
    `baseline=${historyBaseline} now=${historyAfter.count}`)
  void sceneBaseline
} finally {
  // ── Teardown (FK order: scene → scan → users; profiles cascade on user delete) ─
  // NOTE: a `scans` DELETE fires the AFTER-DELETE trigger spatial_purge_scan_storage,
  // whose `DELETE FROM storage.objects` is rejected by Supabase storage protection
  // ("Direct deletion from storage tables is not allowed") even with 0 objects — so
  // the scan (and, via captured_by RESTRICT, the customer user) cannot be removed
  // over PostgREST. On failure we print the exact SQL-editor cleanup block.
  console.log('\n── Teardown ─────────────────────────────────────────────────────')
  if (sceneId) { const r = await admin.from('spatial_scenes').delete().eq('id', sceneId); console.log(`  scene delete: ${r.error?.message ?? 'ok'}`) }
  let scanGone = !scanId
  if (scanId) { const r = await admin.from('scans').delete().eq('id', scanId); scanGone = !r.error; console.log(`  scan delete:  ${r.error?.message ?? 'ok'}`) }
  if (otherId) { const r = await admin.auth.admin.deleteUser(otherId); console.log(`  user other delete:    ${r.error?.message ?? 'ok'}`) }
  let customerGone = !customerId
  if (customerId && scanGone) { const r = await admin.auth.admin.deleteUser(customerId); customerGone = !r.error; console.log(`  user customer delete: ${r.error?.message ?? 'ok'}`) }
  if (!scanGone || !customerGone) {
    console.log('\n  ⚠️  LEFTOVER fixtures could not be removed over PostgREST. Run in the SQL editor:')
    console.log('  ┌─────────────────────────────────────────────────────────────')
    console.log('  │ BEGIN;')
    if (!scanGone) {
      console.log('  │ ALTER TABLE public.scans DISABLE TRIGGER scans_purge_storage_after_delete;')
      console.log(`  │ DELETE FROM public.scans WHERE id = '${scanId}';`)
      console.log('  │ ALTER TABLE public.scans ENABLE TRIGGER scans_purge_storage_after_delete;')
    }
    if (!customerGone) console.log(`  │ DELETE FROM auth.users WHERE id = '${customerId}';  -- cascades profile`)
    console.log('  │ COMMIT;')
    console.log('  └─────────────────────────────────────────────────────────────')
  }
}

console.log(`\n[rls-repro] ${pass} passed, ${fail} failed.`)
process.exit(fail === 0 ? 0 : 1)
