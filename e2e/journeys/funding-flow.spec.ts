/**
 * Journey 2 — Funding-Flow: Accept → Anzahlung in den Escrow.
 *
 * Baut auf der core-flow-Strecke auf (Anfrage → Angebot → Annahme) und treibt
 * sie über den Accept hinaus bis `escrow_payment_plans.status='funded_in_escrow'`:
 * der Kunde zahlt den vollen Betrag mit einer Stripe-Test-Karte in den Escrow.
 *
 * Scope = KUNDEN-Funding-Leg. Die Provider-Request-Strecke (api/request-funding)
 * wird hier nicht über die UI gefahren — der funding_request wird per
 * Service-Client geseedet (prepareFundingForSmokeJob), Shape-treu zu
 * api/request-funding.ts. Eigene Smoke-Journey für request-funding ist offen.
 *
 * Stripe-Sicherheit: läuft ausschließlich gegen Test-Mode-Keys. Der Frontend-
 * pk ist `pk_test_` (vite lädt .env.local) → selbst bei einem versehentlichen
 * Live-Secret-Key würde Stripe.js den Live-clientSecret gegen den Test-pk
 * ablehnen; eine echte Abbuchung ist mit Test-pk strukturell unmöglich.
 * Non-SCA-Karte 4242 → confirmPayment(redirect:'if_required') resolved ohne
 * 3DS. Die SCA-Karte 4000 0027 6000 3184 bleibt Device-Smoke (Block A.3).
 *
 * Webhook: nicht erforderlich. Der Browser-confirm-funding-Pfad
 * (CustomerEscrowFundingCard → /api/confirm-funding → confirm_funding_atomic)
 * transitioniert den Plan synchron; der Stripe-Webhook ist nur der idempotente
 * Zweitpfad (Tab-Close mid-flow) und wird hier nicht gebraucht.
 *
 * Asserts: DB-Wahrheit (escrow_payment_plans.status) als primäres Signal +
 * User-sichtbarer Erfolg ("Einzahlung gesichert").
 */
import { test, expect, type BrowserContext, type Page } from 'playwright/test'
import {
  SMOKE,
  cleanupSmokeData,
  ensureSmokeSeed,
  ensureProviderPayoutAccount,
  ensureCustomerBillingProfile,
  prepareFundingForSmokeJob,
  smokeServiceClient,
} from '../fixtures/smoke'

const RUN_ID = `fund-${Date.now().toString(36)}`

test.describe('Funding-Flow: Accept → Anzahlung in Escrow', () => {
  let customerCtx: BrowserContext
  let craftsmanCtx: BrowserContext
  let customer: Page
  let craftsman: Page

  test.beforeAll(async ({ browser }) => {
    // Reste abgestürzter Runs wegräumen + stabile Funding-Gates seeden
    // (payout-account + billing-profile bleiben über Cleanup hinweg bestehen).
    try {
      const db = smokeServiceClient()
      await cleanupSmokeData(db)
      await ensureSmokeSeed(db)
      await ensureProviderPayoutAccount(db)
      await ensureCustomerBillingProfile(db)
    } catch (err) {
      console.warn('[smoke-cleanup] übersprungen:', (err as Error).message)
    }
    customerCtx = await browser.newContext({ storageState: SMOKE.customer.storageState })
    craftsmanCtx = await browser.newContext({ storageState: SMOKE.craftsman.storageState })
    customer = await customerCtx.newPage()
    craftsman = await craftsmanCtx.newPage()
  })

  test.afterAll(async () => {
    await customerCtx?.close()
    await craftsmanCtx?.close()
    try {
      await cleanupSmokeData(smokeServiceClient())
    } catch (err) {
      console.warn('[smoke-cleanup] übersprungen:', (err as Error).message)
    }
  })

  test('Kunde zahlt Anzahlung in den Escrow', async () => {
    // Accept-Korridor + initiate/confirm-funding über zwei Browser-Contexts +
    // Stripe-iframe — das 60s-Default-Budget ist zu eng.
    test.setTimeout(180_000)

    // ───────────────────────────────────────────────────────────────────────
    // Accept-Strecke (Verhalten gespiegelt aus core-flow.spec — die robusten
    // Locator/Retry-Muster sind dort device-bewährt; hier nur Voraussetzung,
    // nicht der eigentliche Test).
    // ───────────────────────────────────────────────────────────────────────
    await test.step('Kunde: Profil öffnen + Anfrage starten', async () => {
      await customer.goto(`/explore/craftsman/${SMOKE.craftsman.userId}`)
      await expect(customer.getByText(SMOKE.companyName).first()).toBeVisible()
      await customer.getByRole('button', { name: /Anfragen/ }).first().click()
      await customer.waitForURL(/\/messages\//, { timeout: 20_000 })
    })

    await test.step('Kunde: erste Nachricht senden', async () => {
      const composer = customer.getByPlaceholder(/Nachricht schreiben/)
      await expect(composer).toBeEnabled({ timeout: 15_000 })
      await composer.fill(`Hallo, bitte um ein Angebot. [${RUN_ID}]`)
      await customer.getByRole('button', { name: 'Senden', exact: true }).click()
      await expect(composer).toHaveValue('', { timeout: 15_000 })
      await expect(customer.getByRole('main').getByText(`[${RUN_ID}]`)).toBeVisible()
    })

    await test.step('Handwerker: Thread öffnen', async () => {
      await craftsman.goto('/craftsman/messages')
      await craftsman.getByRole('button', { name: /^Anfragen/ }).click()
      await craftsman.getByRole('button', { name: 'Antworten' }).first().click()
      await craftsman.waitForURL(/\/craftsman\/messages\//, { timeout: 20_000 })
      await expect(craftsman.getByRole('main').getByText(`[${RUN_ID}]`)).toBeVisible({
        timeout: 15_000,
      })
    })

    await test.step('Handwerker: Verbindliches Angebot senden', async () => {
      await expect(async () => {
        await craftsman.getByRole('button', { name: 'Anhang hinzufügen' }).click()
        await craftsman.getByText('Verbindliches Angebot', { exact: true }).click()
        await expect(craftsman.getByTestId('quote-price-input')).toBeVisible({ timeout: 3_000 })
      }).toPass({ timeout: 30_000 })

      await craftsman.getByTestId('quote-price-input').fill('1500')
      await craftsman.getByTestId('quote-summary-input').fill(`Smoke-Leistung [${RUN_ID}]`)
      await craftsman.getByTestId('quote-excluded-input').fill('Materialbeschaffung durch Kunde')

      const validUntil = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)
      await craftsman.getByTestId('quote-validity-input').fill(validUntil)

      await craftsman.getByTestId('quote-preview-button').click()
      await craftsman.getByTestId('quote-submit-button').click()
      await expect(craftsman.getByTestId('quote-detail-link').last()).toBeVisible({
        timeout: 20_000,
      })
    })

    await test.step('Kunde: Angebot öffnen + annehmen', async () => {
      await customer.reload()
      await customer.getByTestId('quote-detail-link').last().click()
      await customer.waitForURL(/\/quotes\//, { timeout: 20_000 })
      await expect(customer.getByTestId('quote-detail-view')).toBeVisible()
      await customer.getByTestId('quote-action-accept').click()
      await expect(customer.getByTestId('quote-accepted-binding')).toBeVisible({ timeout: 20_000 })
    })

    // ───────────────────────────────────────────────────────────────────────
    // Funding-Gates seeden (nach Accept existieren job + escrow_payment_plan):
    //   Gate 3 Attribution finalisieren · Gate 4 funding_request anlegen.
    //   Gate 1 (payout) + Gate 2 (billing) liegen aus beforeAll vor.
    // ───────────────────────────────────────────────────────────────────────
    const { fundingRequestId, escrowPlanId } = await prepareFundingForSmokeJob(smokeServiceClient())

    await test.step('Kunde: Funding-Screen → Zahlung initiieren', async () => {
      await customer.goto(`/funding/${fundingRequestId}`)
      // FundingEntryScreen lädt server-autoritativ; die Karte zeigt zuerst die
      // Initiate-CTA, die initiate-funding aufruft und den PaymentElement mountet.
      await expect(customer.getByTestId('customer-escrow-funding-card')).toBeVisible({
        timeout: 30_000,
      })
      await customer.getByRole('button', { name: /Jetzt einzahlen/ }).click()
      await expect(customer.getByTestId('stripe-payment-form-mount')).toBeVisible({
        timeout: 30_000,
      })
    })

    await test.step('Kunde: Test-Karte eingeben + bezahlen', async () => {
      // Stripe PaymentElement rendert die Kartenfelder in einem genesteten
      // iframe (Name __privateStripeFrame…). payment_method_types:['card'] →
      // kein Accordion, Felder direkt sichtbar.
      const stripeFrame = customer.frameLocator('iframe[name^="__privateStripeFrame"]').first()
      const cardNumber = stripeFrame.locator('[name="number"]')
      await expect(cardNumber).toBeVisible({ timeout: 20_000 })
      await cardNumber.fill('4242424242424242')
      await stripeFrame.locator('[name="expiry"]').fill('12 / 34')
      await stripeFrame.locator('[name="cvc"]').fill('123')
      // Postleitzahl nur, wenn das Stripe-Konto/Locale sie anzeigt.
      const postal = stripeFrame.locator('[name="postalCode"]')
      if ((await postal.count()) > 0) {
        await postal.fill('30159')
      }

      await customer.getByRole('button', { name: /Jetzt bezahlen/ }).click()
    })

    await test.step('Escrow ist funded_in_escrow', async () => {
      // 1) User-sichtbarer Erfolg: FundingEntryScreen swappt auf den Funded-State.
      await expect(customer.getByText('Einzahlung gesichert')).toBeVisible({ timeout: 60_000 })

      // 2) DB-Wahrheit (primäres Signal): confirm_funding_atomic hat den Plan
      // transitioniert. Poll, weil confirm-funding clientseitig nachläuft.
      const db = smokeServiceClient()
      await expect
        .poll(
          async () => {
            const { data } = await db
              .from('escrow_payment_plans')
              .select('status')
              .eq('id', escrowPlanId)
              .maybeSingle()
            return data?.status
          },
          { timeout: 30_000, intervals: [1_000, 2_000, 3_000] },
        )
        .toBe('funded_in_escrow')
    })
  })
})
