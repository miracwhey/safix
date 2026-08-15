/**
 * Auth-Setup — läuft als eigenes Playwright-Projekt VOR allen Journeys.
 *
 * Loggt 1× pro Rolle ein und persistiert die Session als storageState
 * (Supabase-Session liegt im localStorage-Key `fixup.auth`, siehe
 * src/lib/supabase.ts). Journeys laden den State und starten eingeloggt.
 *
 * Login bleibt damit trotzdem abgedeckt: bricht /login, failt das Setup
 * und damit der gesamte Lauf — mit klarer Ursache statt 12 roten Journeys.
 */
import { test as setup, expect, type Page } from 'playwright/test'
import { SMOKE } from './smoke'

async function login(page: Page, email: string, password: string, storageState: string) {
  await page.goto('/login')
  await page.locator('#login-email').fill(email)
  await page.locator('#login-password').fill(password)
  await page.getByRole('button', { name: 'Anmelden' }).click()

  // Redirect: /login → /gate → rollenspezifischer Home. Nicht auf eine konkrete
  // Ziel-Route asserten (rollenabhängig + änderbar) — nur: weg von /login,
  // Session im Storage.
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 })
  await page.waitForFunction(() => window.localStorage.getItem('fixup.auth') !== null, undefined, {
    timeout: 20_000,
  })
  expect(await page.evaluate(() => window.localStorage.getItem('fixup.auth'))).toBeTruthy()

  await page.context().storageState({ path: storageState })
}

setup('login: smoke-customer', async ({ page }) => {
  await login(page, SMOKE.customer.email, SMOKE.customer.password, SMOKE.customer.storageState)
})

setup('login: smoke-craftsman', async ({ page }) => {
  await login(page, SMOKE.craftsman.email, SMOKE.craftsman.password, SMOKE.craftsman.storageState)
})
