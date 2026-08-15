/**
 * Payout-Corridor E2E Harness (P7-Test, Test-Mode).
 *
 * Treibt den VOLLEN Destination-Charge-Korridor headless gegen den lokalen
 * vercel-dev (:3211) + Stripe TEST + Prod-DB (Smoke-UUIDs):
 *
 *   seed → initiate-funding (Destination Charge) → confirm → funded_in_escrow
 *        → release 25% (payouts.create) → payout.paid → released
 *        → release 75% → payout.paid → fully_released
 *        → A1-Repro: Job-Completion / payment_released_at beobachten
 *
 * Voraussetzungen (extern orchestriert, NICHT von diesem Script gestartet):
 *   - vercel dev --listen 3211   (stdio→Datei, EBADF-Fix)
 *   - stripe listen --forward-to localhost:3211/api/stripe-webhook
 *                   --forward-connect-to localhost:3211/api/stripe-webhook
 *   - .env.local: FUNDING_DESTINATION_CHARGE_ENABLED=true + STRIPE_WEBHOOK_SECRET
 *                 == `stripe listen`-Secret
 *
 * Geld-Sicherheit: ausschließlich Test-Mode-Keys (sk_test). Echter Connect-Test-
 * Account acct_1TTjMMBDdn6tSDtx (manual schedule, debit_negative_balances=true).
 *
 * Lauf:  node e2e/corridor/run-corridor.mjs
 */
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// ── env ─────────────────────────────────────────────────────────────────────
function loadEnvLocal() {
  const raw = fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
  const env = {}
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) env[m[1]] = m[2].replace(/^"(.*)"$/, '$1')
  }
  return env
}
const E = loadEnvLocal()
const BASE = process.env.CORRIDOR_BASE_URL ?? 'http://localhost:3211'
const CONNECT_ACCT = 'acct_1TTjMMBDdn6tSDtx'

const SMOKE = {
  customer: { id: 'a9000000-0000-4000-8000-000000000001', email: 'smoke-customer@fixup.app', password: 'smoke-password' },
  craftsman: { id: 'a9000000-0000-4000-8000-000000000002' },
  providerId: 'b9000000-0000-4000-8000-000000000001',
}
const AMOUNT = 20.0 // EUR — 25%/75% = 5€/15€, beide ≥ Stripe-Payout-Minimum (1€)
const FEE_ORIGIN_RATE = 0.09 // default 9%

const stripe = new Stripe(E.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' })
const db = createClient(E.SUPABASE_URL ?? E.VITE_SUPABASE_URL, E.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})
const anon = createClient(E.VITE_SUPABASE_URL ?? E.SUPABASE_URL, E.VITE_SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// ── tiny test harness ────────────────────────────────────────────────────────
let PASS = 0, FAIL = 0
const results = []
function log(msg) { console.log(msg) }
function stage(name) { console.log(`\n━━ ${name} ━━`) }
function check(label, cond, detail = '') {
  if (cond) { PASS++; console.log(`  ✅ ${label}`) }
  else { FAIL++; console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); results.push(`FAIL: ${label} ${detail}`) }
  return cond
}
function info(label, val) { console.log(`  · ${label}: ${typeof val === 'object' ? JSON.stringify(val) : val}`) }
let GAPS = 0
// Erwarteter Audit-Gap: PASS = Fix vorhanden (post-fix), ⚠️ = Gap reproduziert (pre-fix).
// Zählt NICHT als echter Fail — trennt „Money-Legs kaputt" von „bekannter Gap".
function gap(label, fixedCond, detail = '') {
  if (fixedCond) { PASS++; console.log(`  ✅ ${label} (Gap behoben)`) }
  else { GAPS++; console.log(`  ⚠️  GAP reproduziert: ${label}${detail ? ' — ' + detail : ''}`) }
}

async function api(pathname, { method = 'POST', body, headers = {} } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  let json = null
  try { json = await res.json() } catch { /* non-json */ }
  return { status: res.status, json }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function pollTranche(id, want, timeoutMs = 45000) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < timeoutMs) {
    const { data } = await db.from('escrow_tranches').select('status, external_payout_ref, released_at, payout_attempt_count').eq('id', id).maybeSingle()
    last = data
    if (data && data.status === want) return data
    await sleep(2000)
  }
  return last
}

// ── cleanup ───────────────────────────────────────────────────────────────────
async function cleanup() {
  const cust = SMOKE.customer.id
  // children → parents
  const { data: plans } = await db.from('escrow_payment_plans').select('id, job_id').eq('customer_user_id', cust)
  const planIds = (plans ?? []).map((p) => p.id)
  if (planIds.length) {
    await db.from('ledger_entries').delete().in('plan_id', planIds).then(() => {}, () => {})
    await db.from('escrow_tranches').delete().in('plan_id', planIds)
  }
  await db.from('funding_requests').delete().eq('customer_user_id', cust)
  const { data: jobs } = await db.from('jobs').select('id').eq('customer_user_id', cust)
  const jobIds = (jobs ?? []).map((j) => j.id)
  if (jobIds.length) {
    await db.from('ledger_entries').delete().in('job_id', jobIds).then(() => {}, () => {})
    await db.from('payments').delete().in('job_id', jobIds)
    await db.from('escrow_payment_plans').delete().in('job_id', jobIds)
  }
  await db.from('offers').delete().eq('customer_user_id', cust)
  await db.from('jobs').delete().eq('customer_user_id', cust)
}

// ── seed ───────────────────────────────────────────────────────────────────────
async function seedInsert(table, row) {
  const { data, error } = await db.from(table).insert(row).select().maybeSingle()
  if (error) throw new Error(`seed ${table}: ${error.message} | row=${JSON.stringify(row)}`)
  return data
}
async function seed() {
  // Gate 1 — real connect account
  await db.from('provider_payout_accounts').upsert({
    provider_user_id: SMOKE.craftsman.id,
    stripe_connect_account_id: CONNECT_ACCT,
    onboarding_status: 'onboarding_complete',
    charges_enabled: true,
    payouts_enabled: true,
    onboarding_completed_at: new Date().toISOString(),
  }, { onConflict: 'provider_user_id' })

  // Gate 2 — billing profile
  await db.from('customer_billing_profiles').upsert({
    user_id: SMOKE.customer.id,
    billing_name: 'Smoke Kunde', billing_address_line1: 'Teststraße 1',
    billing_postal_code: '30159', billing_city: 'Hannover', billing_country: 'DE', is_business: false,
  }, { onConflict: 'user_id' })

  const offer = await seedInsert('offers', {
    id: randomUUID(),
    customer_user_id: SMOKE.customer.id, craftsman_user_id: SMOKE.craftsman.id,
    price: AMOUNT, status: 'accepted',
  })
  const job = await seedInsert('jobs', {
    title: 'Corridor Smoke Job', customer_user_id: SMOKE.customer.id, craftsman_user_id: SMOKE.craftsman.id,
    status: 'waiting_payment', payment_state: 'in_escrow',
    attribution_status: 'finalized', commercial_origin: 'platform_acquired',
  })
  const plan = await seedInsert('escrow_payment_plans', {
    source_offer_id: offer.id, job_id: job.id, customer_user_id: SMOKE.customer.id,
    provider_id: SMOKE.providerId, total_amount: AMOUNT, currency: 'EUR',
    status: 'awaiting_customer_funding', platform_fee_rate: null, commercial_origin: 'platform_acquired',
  })
  const deposit = await seedInsert('escrow_tranches', {
    plan_id: plan.id, kind: 'deposit_release', percentage: 25, amount: Math.round(AMOUNT * 0.25 * 100) / 100,
    release_trigger: 'work_started', status: 'pending_funding',
  })
  const final = await seedInsert('escrow_tranches', {
    plan_id: plan.id, kind: 'final_release', percentage: 75, amount: Math.round(AMOUNT * 0.75 * 100) / 100,
    release_trigger: 'work_completed', status: 'pending_funding',
  })
  await seedInsert('payments', {
    job_id: job.id, customer_user_id: SMOKE.customer.id, craftsman_user_id: SMOKE.craftsman.id,
    provider_id: SMOKE.providerId, amount_total: AMOUNT, total_amount: AMOUNT, currency: 'eur', status: 'in_escrow',
  })
  const fundingRequestId = randomUUID()
  await seedInsert('funding_requests', {
    id: fundingRequestId, source_offer_id: offer.id, job_id: job.id, escrow_plan_id: plan.id,
    customer_user_id: SMOKE.customer.id, provider_id: SMOKE.providerId, provider_user_id: SMOKE.craftsman.id,
    type: 'full_escrow', status: 'sent', amount: AMOUNT, currency: 'EUR', created_by: 'provider',
    sent_at: new Date().toISOString(), expires_at: Date.now() + 14 * 86400000,
  })
  return { offer, job, plan, deposit, final, fundingRequestId }
}

async function signInCustomer() {
  const { data, error } = await anon.auth.signInWithPassword({ email: SMOKE.customer.email, password: SMOKE.customer.password })
  if (error) throw new Error(`customer sign-in: ${error.message}`)
  return data.session.access_token
}

async function makePaymentMethod() {
  // bypass-pending card → funds land AVAILABLE on the connected account (so
  // payouts.create succeeds instead of balance_insufficient). Falls raw-card
  // API im Test-Mode gesperrt ist, Fallback auf pm_card_visa (→ pending → 202).
  try {
    // Test-Token tok_bypassPending (kein raw-card) → Funds landen AVAILABLE.
    const pm = await stripe.paymentMethods.create({ type: 'card', card: { token: 'tok_bypassPending' } })
    return { pm: pm.id, kind: 'bypass_pending' }
  } catch (e) {
    log(`  · tok_bypassPending nicht möglich (${e.message}) → pm_card_visa (pending)`)
    return { pm: 'pm_card_visa', kind: 'pending' }
  }
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  log(`Corridor E2E gegen ${BASE} · connect ${CONNECT_ACCT} · flag=${E.FUNDING_DESTINATION_CHARGE_ENABLED}`)
  if (E.FUNDING_DESTINATION_CHARGE_ENABLED !== 'true') throw new Error('FUNDING_DESTINATION_CHARGE_ENABLED != true in .env.local')

  stage('0 · Cleanup + Seed')
  await cleanup()
  const s = await seed()
  info('plan', s.plan.id); info('deposit', s.deposit.id); info('final', s.final.id); info('fundingRequest', s.fundingRequestId)
  check('seed complete', true)

  stage('1 · initiate-funding (Destination Charge)')
  const token = await signInCustomer()
  const init = await api('/api/initiate-funding', { body: { fundingRequestId: s.fundingRequestId, escrowPlanId: s.plan.id, jobId: s.job.id }, headers: { Authorization: `Bearer ${token}` } })
  info('http', init.status); info('outcome', init.json?.outcome)
  check('initiate 200 + PAYMENT_FORM_READY', init.status === 200 && init.json?.outcome === 'PAYMENT_FORM_READY', JSON.stringify(init.json))
  const piId = init.json?.paymentIntentId
  if (!piId) throw new Error('no paymentIntentId — abort')

  const pi = await stripe.paymentIntents.retrieve(piId)
  const feeCents = Math.round(AMOUNT * FEE_ORIGIN_RATE * 100)
  check('PI is destination charge (transfer_data.destination)', pi.transfer_data?.destination === CONNECT_ACCT, `dest=${pi.transfer_data?.destination}`)
  check('PI application_fee_amount == fee', pi.application_fee_amount === feeCents, `got=${pi.application_fee_amount} want=${feeCents}`)
  info('PI amount', pi.amount); info('PI status', pi.status)

  stage('2 · confirm → funded_in_escrow')
  const { pm, kind } = await makePaymentMethod()
  info('payment_method', `${pm} (${kind})`)
  await stripe.paymentIntents.confirm(piId, { payment_method: pm })
  const conf = await api('/api/confirm-funding', { body: { paymentIntentId: piId, fundingRequestId: s.fundingRequestId, escrowPlanId: s.plan.id, jobId: s.job.id }, headers: { 'x-funding-confirm-secret': E.FUNDING_CONFIRM_SECRET } })
  info('confirm http', conf.status); info('confirm body', conf.json)
  // poll plan
  let planStatus = null
  for (let i = 0; i < 15; i++) { const { data } = await db.from('escrow_payment_plans').select('status, platform_fee_amount, platform_fee_rate, external_funding_ref').eq('id', s.plan.id).maybeSingle(); planStatus = data; if (data?.status === 'funded_in_escrow') break; await sleep(1500) }
  check('plan funded_in_escrow', planStatus?.status === 'funded_in_escrow', `status=${planStatus?.status}`)
  check('fee snapshot written (rate+amount)', planStatus?.platform_fee_rate != null && planStatus?.platform_fee_amount != null, JSON.stringify(planStatus))

  // C1 repro — ledger deposit/fee rows
  const { data: depLedger } = await db.from('ledger_entries').select('entry_type').eq('plan_id', s.plan.id).in('entry_type', ['escrow_deposit', 'platform_fee'])
  gap('[C1] escrow_deposit+platform_fee Ledger geschrieben', (depLedger?.length ?? 0) >= 2, `found=${depLedger?.length ?? 0}`)

  // tranches should be eligible after funding (work_started auto-eligible? else flip)
  const { data: trAfterFund } = await db.from('escrow_tranches').select('id, kind, status').eq('plan_id', s.plan.id)
  info('tranches after fund', trAfterFund)

  stage('3 · release 25% (deposit, payouts.create)')
  // make deposit eligible if funding left it 'funded'
  await db.from('escrow_tranches').update({ status: 'eligible_for_release', eligible_at: new Date().toISOString() }).eq('id', s.deposit.id).eq('status', 'funded')
  const rel = await api('/api/release-tranche', { body: { trancheId: s.deposit.id, planId: s.plan.id, actor: 'provider' }, headers: { 'x-release-confirm-secret': E.RELEASE_CONFIRM_SECRET } })
  info('release http', rel.status); info('release body', rel.json)
  const relStatus = rel.json?.status
  check('release returns corridor state (release_pending|release_deferred, NOT released)', relStatus === 'release_pending' || relStatus === 'release_deferred', `got=${relStatus}`)
  check('[A1] server is honest: status != released for async payout', relStatus !== 'released', `got=${relStatus}`)

  if (relStatus === 'release_pending') {
    info('external_payout_ref', rel.json?.externalPayoutRef)
    const done = await pollTranche(s.deposit.id, 'released', 60000)
    check('deposit released via payout.paid webhook', done?.status === 'released', `status=${done?.status} po=${done?.external_payout_ref}`)
  } else if (relStatus === 'release_deferred') {
    const { data: t } = await db.from('escrow_tranches').select('payout_attempt_count, status').eq('id', s.deposit.id).maybeSingle()
    check('deferred bumps payout_attempt_count + stays eligible', (t?.payout_attempt_count ?? 0) >= 1 && t?.status === 'eligible_for_release', JSON.stringify(t))
    log('  ⚠️  deposit DEFERRED (balance pending). Paid-path braucht available balance (bypass-pending card).')
  }

  stage('4 · release 75% (final) + fully_released + [A1] job-completion')
  await db.from('escrow_tranches').update({ status: 'eligible_for_release', eligible_at: new Date().toISOString() }).eq('id', s.final.id).in('status', ['funded', 'pending_funding'])
  const rel2 = await api('/api/release-tranche', { body: { trancheId: s.final.id, planId: s.plan.id, actor: 'system' }, headers: { 'x-release-confirm-secret': E.RELEASE_CONFIRM_SECRET } })
  info('release2 http', rel2.status); info('release2 body', rel2.json)
  if (rel2.json?.status === 'release_pending') await pollTranche(s.final.id, 'released', 60000)

  const { data: planFinal } = await db.from('escrow_payment_plans').select('status').eq('id', s.plan.id).maybeSingle()
  // Webhook-Settlement läuft NACH dem tranche-Release im selben payout.paid-Handler → Job pollen.
  let jobFinal = null
  for (let i = 0; i < 15; i++) {
    const { data } = await db.from('jobs').select('status, payment_state, payment_released_at').eq('id', s.job.id).maybeSingle()
    jobFinal = data
    if (data?.status === 'completed') break
    await sleep(2000)
  }
  info('plan final', planFinal?.status); info('job final', jobFinal)
  // A1 gap: under corridor the webhook does NOT complete the job / stamp payment_released_at
  gap('[A1-server] job→completed nach fully_released (Webhook-Settlement)', jobFinal?.status === 'completed', `status=${jobFinal?.status}`)
  gap('[A1-server] payment_released_at gestempelt nach fully_released', jobFinal?.payment_released_at != null, 'NULL')

  stage('RESULT')
  log(`  ${PASS} pass · ${FAIL} fail · ${GAPS} Gap(s) reproduziert`)
  log(`  FAIL = Money-Leg/Harness kaputt (muss 0 sein). Gap = bekannter Audit-Befund, wird durch Fix grün.`)
}

main()
  .then(() => { console.log('\ndone'); process.exit(FAIL > 0 ? 1 : 0) })
  .catch((e) => { console.error('\nHARNESS ERROR:', e.message); process.exit(2) })
