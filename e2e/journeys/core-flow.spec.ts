/**
 * Journey 1 — Core-Flow: Anfrage → Angebot → Annahme.
 *
 * Kunde findet Smoke-Handwerker, startet Anfrage, schreibt Nachricht.
 * Handwerker öffnet Thread, sendet Verbindliches Angebot.
 * Kunde nimmt an. Handwerker sieht den Auftrag.
 *
 * Beide Rollen laufen im selben Test (ein zusammenhängender Ablauf), je
 * eigener Browser-Context mit vorbereitetem storageState aus auth.setup.ts.
 *
 * Asserts nur auf User-sichtbares Verhalten (Texte, Routen, testids) —
 * keine internen IDs, keine Stripe-Details (ZAG-Umbau-sicher).
 */
import { test, expect, type BrowserContext, type Page } from 'playwright/test'
import { SMOKE, cleanupSmokeData, ensureSmokeSeed, smokeServiceClient } from '../fixtures/smoke'

// Pro Lauf eindeutiger Marker — macht Nachricht + Angebot im UI auffindbar
// und verhindert False-Positives durch Reste früherer Läufe.
const RUN_ID = `smoke-${Date.now().toString(36)}`

test.describe('Core-Flow: Anfrage → Angebot → Annahme', () => {
  let customerCtx: BrowserContext
  let craftsmanCtx: BrowserContext
  let customer: Page
  let craftsman: Page

  test.beforeAll(async ({ browser }) => {
    // Reste abgestürzter Runs wegräumen (z. B. Rate-Limit-Rows) — afterAll allein
    // reicht nicht, wenn der vorherige Run hart abgebrochen wurde.
    try {
      const db = smokeServiceClient()
      await cleanupSmokeData(db)
      await ensureSmokeSeed(db)
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
    // Prod-DB: Smoke-Reste immer wegräumen, auch bei rotem Test.
    try {
      await cleanupSmokeData(smokeServiceClient())
    } catch (err) {
      console.warn('[smoke-cleanup] übersprungen:', (err as Error).message)
    }
  })

  test('Kunde fragt an, Handwerker bietet, Kunde nimmt an', async () => {
    // Multi-actor end-to-end flow with a Pro-gate hydration retry — the default
    // 60s per-test budget is too tight; give the full corridor room.
    test.setTimeout(120_000)
    await test.step('Kunde: Profil öffnen + Anfrage starten', async () => {
      // Route-Param ist die Profile/User-ID des Handwerkers
      // (vgl. ExploreSearchOverlay → navigate(`/explore/craftsman/${provider.profileId}`)).
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
      // Auf main scopen — Text rendert sonst mehrfach (Composer-Textarea, Thread-Listen-Preview)
      await expect(composer).toHaveValue('', { timeout: 15_000 })
      await expect(customer.getByRole('main').getByText(`[${RUN_ID}]`)).toBeVisible()
    })

    await test.step('Handwerker: Thread öffnen', async () => {
      await craftsman.goto('/craftsman/messages')
      // Neue Inquiries liegen im Segment „Anfragen", nicht im Default-Tab „Kunden".
      // Karte zeigt KEINEN Klarnamen (anonymisiert „Kunde") → über Antworten-Button öffnen.
      await craftsman.getByRole('button', { name: /^Anfragen/ }).click()
      await craftsman.getByRole('button', { name: 'Antworten' }).first().click()
      await craftsman.waitForURL(/\/craftsman\/messages\//, { timeout: 20_000 })
      await expect(craftsman.getByRole('main').getByText(`[${RUN_ID}]`)).toBeVisible({
        timeout: 15_000,
      })
    })

    await test.step('Handwerker: Verbindliches Angebot senden', async () => {
      // Composer expandieren („+") → Workflow-Tile „Verbindliches Angebot".
      // Retry the open: the open_quote_composer Pro-gate blocks silently while
      // the owner subscription is still hydrating (scope=owner +
      // effectiveState=null → sheet collapses, no-op). That race is not what
      // this journey tests — re-open until the composer mounts so the offer
      // corridor itself is exercised deterministically.
      await expect(async () => {
        await craftsman.getByRole('button', { name: 'Anhang hinzufügen' }).click()
        await craftsman.getByText('Verbindliches Angebot', { exact: true }).click()
        await expect(craftsman.getByTestId('quote-price-input')).toBeVisible({ timeout: 3_000 })
      }).toPass({ timeout: 30_000 })

      // QuoteCreationSheet — required fields for binding_offer: price,
      // scopeSummary, scopeExcluded, validUntil. paymentTerms is NOT required
      // (platform escrow is the payment truth) and lives in the collapsed
      // "Optionale Details" accordion — don't fill it (it isn't visible and
      // isn't needed for a valid document).
      await craftsman.getByTestId('quote-price-input').fill('1500')
      await craftsman.getByTestId('quote-summary-input').fill(`Smoke-Leistung [${RUN_ID}]`)
      await craftsman.getByTestId('quote-excluded-input').fill('Materialbeschaffung durch Kunde')

      const validUntil = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)
      await craftsman.getByTestId('quote-validity-input').fill(validUntil)

      // Form → Vorschau → senden. The submit button lives on the preview step;
      // the form step only exposes the preview action.
      await craftsman.getByTestId('quote-preview-button').click()
      await craftsman.getByTestId('quote-submit-button').click()
      // Artefakt-Karte erscheint im Thread
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

      // `quote-accepted-binding` is the canonical accept signal: it renders only
      // when offer.status === 'accepted' (QuoteDetailView), so its visibility
      // proves the accept persisted. A bare getByText('Angenommen') is not usable
      // here — that status badge is emitted by ~10 components (thread cards,
      // timeline, status badge) so the page holds dozens of copies, and .first()
      // resolves to one in an off-screen container.
      await expect(customer.getByTestId('quote-accepted-binding')).toBeVisible({ timeout: 20_000 })
    })

    await test.step('Handwerker: Auftrag sichtbar', async () => {
      await craftsman.goto('/craftsman/jobs')
      // The craftsman job card renders the inquiry title ("Anfrage an <company>")
      // as a heading — deterministic from SMOKE.companyName. Target the heading
      // role specifically: a bare getByText also matches a hidden message-preview
      // div ("… • Neue Anfrage") whose .first() resolves before the visible card.
      // The card's visibility proves the accept created a job that reached the
      // craftsman side (provider_id resolved, escrow plan persisted).
      await expect(
        craftsman.getByRole('heading', { name: `Anfrage an ${SMOKE.companyName}` }).first(),
      ).toBeVisible({ timeout: 20_000 })
    })
  })
})
