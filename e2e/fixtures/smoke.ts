/**
 * Smoke-Harness Konstanten + Helpers.
 *
 * Smoke-Accounts: dedizierte Prod-DB-Accounts (Seed: supabase/seed-smoke-accounts.sql),
 * strikt getrennt von den App-Store-Review-Accounts (review-*@fixup.app — NIE für
 * destruktive Flows benutzen). Fixe UUIDs mit Präfix a9/b9, damit Cleanup und
 * Idempotenz ohne Lookups funktionieren.
 *
 * Es gibt KEINE lokale Supabase — alles läuft gegen die Prod-DB. Deshalb:
 *   - Specs erzeugen Daten nur unter den Smoke-UUIDs
 *   - cleanupSmokeData() räumt best-effort per UUID auf (FK-Reihenfolge: Kinder zuerst)
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const SMOKE = {
  customer: {
    userId: 'a9000000-0000-4000-8000-000000000001',
    email: process.env.SMOKE_CUSTOMER_EMAIL ?? 'smoke-customer@fixup.app',
    password: process.env.SMOKE_CUSTOMER_PASSWORD ?? 'smoke-password',
    displayName: 'Smoke Kunde',
    storageState: 'e2e/storageState/customer.json',
  },
  craftsman: {
    userId: 'a9000000-0000-4000-8000-000000000002',
    email: process.env.SMOKE_CRAFTSMAN_EMAIL ?? 'smoke-craftsman@fixup.app',
    password: process.env.SMOKE_CRAFTSMAN_PASSWORD ?? 'smoke-password',
    displayName: 'Smoke Werker',
    storageState: 'e2e/storageState/craftsman.json',
  },
  providerId: 'b9000000-0000-4000-8000-000000000001',
  companyName: 'SmokeWerk Elektro',
} as const

/**
 * Minimaler .env.local-Parser — nur die Keys, die das Harness braucht.
 * Kein dotenv-Dep; .env.local ist gitignored und lokal via `vercel env pull` gefüllt.
 * In CI kommen die Werte als echte Env-Vars (GitHub Secrets), Datei fehlt dann.
 */
function envLocal(key: string): string | undefined {
  if (process.env[key]) return process.env[key]
  try {
    const raw = fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    const m = raw.match(new RegExp(`^${key}="?([^"\\n]*)"?$`, 'm'))
    return m?.[1] || undefined
  } catch {
    return undefined
  }
}

/** Service-Role-Client für Seeding-Checks + Cleanup. Nur im Test-Harness, nie im App-Code. */
export function smokeServiceClient(): SupabaseClient {
  const url = envLocal('VITE_SUPABASE_URL') ?? envLocal('SUPABASE_URL')
  const key = envLocal('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) {
    throw new Error(
      'Smoke-Harness: VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY fehlen (vercel env pull .env.local)',
    )
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

/**
 * Stellt sicher, dass der Smoke-Handwerker ein aktives Pro-Abo hat.
 * Der Quote-Composer ist via ProActionGuard (open_quote_composer) Pro-gated —
 * ohne aktives Abo öffnet der Tile die Paywall statt des QuoteCreationSheet.
 * Idempotent; läuft im beforeAll. Cleanup fasst Subscriptions nicht an.
 */
export async function ensureSmokeSeed(db: SupabaseClient): Promise<void> {
  const { data, error } = await db
    .from('craftsman_subscriptions')
    .select('id,status')
    .eq('profile_id', SMOKE.craftsman.userId)
    .maybeSingle()
  if (error) throw error
  if (data?.status === 'active') return
  if (data) {
    const { error: updateError } = await db
      .from('craftsman_subscriptions')
      .update({ status: 'active' })
      .eq('id', data.id)
    if (updateError) throw updateError
  } else {
    const { error: insertError } = await db
      .from('craftsman_subscriptions')
      .insert({ profile_id: SMOKE.craftsman.userId, status: 'active' })
    if (insertError) throw insertError
  }
}

/**
 * Funding-Gate 1 — provider_payout_accounts.
 *
 * api/initiate-funding.ts hard-gated: ohne Row mit charges_enabled=true UND
 * payouts_enabled=true für die provider_user_id antwortet es
 * PROVIDER_PAYOUT_NOT_READY und es entsteht nie ein PaymentIntent.
 *
 * Insert-if-absent (NICHT überschreiben): sobald hier einmal ein echter
 * Stripe-TEST-Connect-Account geseedet ist (für die spätere Release-Journey),
 * lässt dieser Helper ihn unangetastet. Der Dummy-acct trägt nur bis
 * funded_in_escrow — ein echter Tranche-Release (Stripe-Transfer) braucht
 * einen echten Connect-Account. Cleanup fasst diese Row nicht an (stabiler Seed).
 */
export async function ensureProviderPayoutAccount(db: SupabaseClient): Promise<void> {
  const { data, error } = await db
    .from('provider_payout_accounts')
    .select('provider_user_id, charges_enabled, payouts_enabled, stripe_connect_account_id')
    .eq('provider_user_id', SMOKE.craftsman.userId)
    .maybeSingle()
  if (error) throw error
  if (data) {
    // Existierende Row nur „ready" machen, falls ein früherer Teil-Seed sie
    // disabled hinterließ — stripe_connect_account_id bleibt unangetastet.
    if (!data.charges_enabled || !data.payouts_enabled) {
      const { error: upErr } = await db
        .from('provider_payout_accounts')
        .update({ charges_enabled: true, payouts_enabled: true, onboarding_status: 'onboarding_complete' })
        .eq('provider_user_id', SMOKE.craftsman.userId)
      if (upErr) throw upErr
    }
    return
  }
  const { error: insErr } = await db.from('provider_payout_accounts').insert({
    provider_user_id: SMOKE.craftsman.userId,
    stripe_connect_account_id: 'acct_smokeTestConnect000',
    onboarding_status: 'onboarding_complete',
    charges_enabled: true,
    payouts_enabled: true,
    onboarding_completed_at: new Date().toISOString(),
  })
  if (insErr) throw insErr
}

/**
 * Funding-Gate 2 — customer_billing_profiles.
 *
 * FundingEntryScreen mountet die Stripe-Form nur, wenn das Customer-Billing-
 * Profil vollständig ist (deriveFundingBillingGate → show-card); sonst zeigt es
 * die „Rechnungsdaten ergänzen"-Gate-Card (testid funding-billing-gate).
 * Vollständig = billing_name + address_line1 + postal_code + city + country.
 * Upsert auf user_id (genau eine Row pro user_id, UNIQUE).
 */
export async function ensureCustomerBillingProfile(db: SupabaseClient): Promise<void> {
  const { error } = await db.from('customer_billing_profiles').upsert(
    {
      user_id: SMOKE.customer.userId,
      billing_name: 'Smoke Kunde',
      billing_address_line1: 'Teststraße 1',
      billing_postal_code: '30159',
      billing_city: 'Hannover',
      billing_country: 'DE',
      is_business: false,
    },
    { onConflict: 'user_id' },
  )
  if (error) throw error
}

/**
 * Funding-Gate 3+4 — Attribution finalisieren + funding_request anlegen.
 *
 * Läuft NACH dem Accept (core-flow-Strecke), wenn job + escrow_payment_plan
 * existieren. Liefert die Felder, die der Kunde zum Funden braucht.
 *
 *  - Gate 3: assertAttributionFinalized (api/_attributionGuard) blockt funding
 *    mit 402, solange jobs.attribution_status != 'finalized'. Der Accept legt
 *    den Job ggf. mit pending/async-Attribution an → hier deterministisch auf
 *    'finalized' + commercial_origin setzen.
 *  - Gate 4: funding_requests-Row (Provider-Aktion normalerweise via
 *    api/request-funding) — hier direkt geseedet, weil der Smoke die KUNDEN-
 *    Funding-Strecke testet, nicht die Provider-Request-Strecke. Shape spiegelt
 *    api/request-funding.ts (status 'sent', type 'full_escrow', epoch-ms expiry).
 *
 * Gibt fundingRequestId/escrowPlanId/jobId für die Navigation zurück.
 */
export async function prepareFundingForSmokeJob(
  db: SupabaseClient,
): Promise<{ fundingRequestId: string; escrowPlanId: string; jobId: string }> {
  // Den vom Accept erzeugten Escrow-Plan finden (genau einer pro Smoke-Lauf).
  const { data: plan, error: planErr } = await db
    .from('escrow_payment_plans')
    .select('id, job_id, source_offer_id, provider_id, total_amount, currency, status')
    .eq('customer_user_id', SMOKE.customer.userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (planErr) throw planErr
  if (!plan) throw new Error('prepareFundingForSmokeJob: kein escrow_payment_plan für Smoke-Kunde gefunden (Accept gelaufen?)')

  // Gate 3 — Attribution finalisieren (idempotent).
  const { error: jobErr } = await db
    .from('jobs')
    .update({ attribution_status: 'finalized', commercial_origin: 'platform_acquired' })
    .eq('id', plan.job_id)
  if (jobErr) throw jobErr

  // Gate 4 — funding_request (insert-if-absent: re-run-fest, falls Cleanup ausfiel).
  const { data: existing } = await db
    .from('funding_requests')
    .select('id')
    .eq('escrow_plan_id', plan.id)
    .in('status', ['created', 'sent', 'funding_started', 'funding_initiated'])
    .maybeSingle()
  if (existing) {
    return { fundingRequestId: existing.id, escrowPlanId: plan.id, jobId: plan.job_id }
  }

  const fundingRequestId = randomUUID()
  const nowIso = new Date().toISOString()
  const { error: frErr } = await db.from('funding_requests').insert({
    id: fundingRequestId,
    source_offer_id: plan.source_offer_id,
    job_id: plan.job_id,
    escrow_plan_id: plan.id,
    customer_user_id: SMOKE.customer.userId,
    provider_id: plan.provider_id ?? SMOKE.providerId,
    provider_user_id: SMOKE.craftsman.userId,
    type: 'full_escrow',
    status: 'sent',
    amount: plan.total_amount,
    currency: (plan.currency ?? 'EUR').toUpperCase(),
    created_by: 'provider',
    sent_at: nowIso,
    created_at: nowIso,
    updated_at: nowIso,
    expires_at: Date.now() + 14 * 24 * 60 * 60 * 1000,
  })
  if (frErr) throw frErr
  return { fundingRequestId, escrowPlanId: plan.id, jobId: plan.job_id }
}

/**
 * Best-effort Cleanup aller von Smoke-Accounts erzeugten Rows (Kinder → Eltern).
 * Fehler pro Tabelle werden geloggt, brechen aber nicht ab — ein halb
 * fehlgeschlagener Cleanup darf den Test-Report nicht rot machen.
 */
export async function cleanupSmokeData(db: SupabaseClient): Promise<void> {
  const ids = [SMOKE.customer.userId, SMOKE.craftsman.userId]

  const log = (table: string, error: { message: string } | null) => {
    if (error) console.warn(`[smoke-cleanup] ${table}: ${error.message}`)
  }

  // Rate-Limit-Zähler (max 3 Anfragen/Tag) — sonst blockt Run 4+ am Tageslimit
  log(
    'customer_request_sends',
    (await db.from('customer_request_sends').delete().eq('user_id', SMOKE.customer.userId)).error,
  )

  // Chat-Domäne (neu)
  const { data: threads } = await db
    .from('chat_threads')
    .select('id')
    .eq('customer_user_id', SMOKE.customer.userId)
  const threadIds = (threads ?? []).map((t: { id: string }) => t.id)
  if (threadIds.length > 0) {
    // participants zuerst: chat_participants.last_read_msg → FK auf chat_messages
    log(
      'chat_participants',
      (await db.from('chat_participants').delete().in('thread_id', threadIds)).error,
    )
    log('chat_messages', (await db.from('chat_messages').delete().in('thread_id', threadIds)).error)
    log('chat_threads', (await db.from('chat_threads').delete().in('id', threadIds)).error)
  }

  // Legacy-Conversations
  const { data: convs } = await db
    .from('conversations')
    .select('id')
    .eq('customer_user_id', SMOKE.customer.userId)
  const convIds = (convs ?? []).map((c: { id: string }) => c.id)
  if (convIds.length > 0) {
    log('messages', (await db.from('messages').delete().in('conversation_id', convIds)).error)
  }

  // Payment-Korridor (Block PA): ein erfolgreicher Accept legt jetzt payment +
  // escrow_payment_plan + tranches an. escrow_payment_plans.job_id → jobs ist
  // ON DELETE CASCADE (tranches cascaden via plan_id), aber payments.job_id /
  // .project_id sind ON DELETE SET NULL und kollidieren mit dem CHECK
  // (job_id IS NOT NULL OR project_id IS NOT NULL): sind nach dem jobs- UND
  // projects-Delete beide NULL, bricht der jobs-Delete. Deshalb payments + plans
  // per job_id explizit vor den Geschäfts-Objekten entfernen — job_id ist der
  // einzige verlässliche Anker, weil customer_profile_id / provider_id auf
  // Alt-Rows aus fehlgeschlagenen Vor-PA-Läufen NULL sind.
  // funding_requests referenzieren escrow_plan_id + job_id + source_offer_id →
  // VOR escrow_payment_plans/offers/jobs löschen. customer_user_id ist der
  // direkte Anker (kein Job-Lookup nötig). provider_payout_accounts +
  // customer_billing_profiles bleiben (stabiler Seed, wie subscriptions).
  log(
    'funding_requests',
    (await db.from('funding_requests').delete().eq('customer_user_id', SMOKE.customer.userId)).error,
  )

  const { data: smokeJobs } = await db.from('jobs').select('id').in('customer_user_id', ids)
  const jobIds = (smokeJobs ?? []).map((j: { id: string }) => j.id)
  if (jobIds.length > 0) {
    log('payments', (await db.from('payments').delete().in('job_id', jobIds)).error)
    log('escrow_payment_plans', (await db.from('escrow_payment_plans').delete().in('job_id', jobIds)).error)
  }

  // Geschäfts-Objekte (offers referenzieren jobs via created_job_id → offers zuerst)
  log('offers', (await db.from('offers').delete().eq('customer_user_id', SMOKE.customer.userId)).error)
  log('projects', (await db.from('projects').delete().eq('customer_user_id', SMOKE.customer.userId)).error)
  log('jobs', (await db.from('jobs').delete().in('customer_user_id', ids)).error)

  if (convIds.length > 0) {
    log('conversations', (await db.from('conversations').delete().in('id', convIds)).error)
  }
}
