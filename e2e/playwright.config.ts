/**
 * Playwright Smoke-Harness — Layer 1 (Web-Journeys).
 *
 * Design (bindend, 2026-06-12):
 *   - Session-Reuse: das `setup`-Projekt loggt 1× pro Rolle ein und speichert
 *     storageState (Supabase-Session im localStorage-Key `fixup.auth`).
 *     Journey-Specs starten eingeloggt direkt im Ziel-Flow.
 *   - Specs sind Journeys (zusammenhängende Abläufe), keine atomaren Klick-Tests.
 *   - Split-Server (vercel dev kann das Vite-Frontend nicht serven, Detail im
 *     webServer-Kommentar unten): vite :3210 servt das Frontend, vercel dev
 *     :3211 NUR die /api-Functions. npm run dev (Vite-only) servt /api NICHT —
 *     die Webhook-/Funding-Strecke braucht den vercel-dev-Teil.
 *
 * Env:
 *   PLAYWRIGHT_BASE_URL  — Ziel-Origin (default http://localhost:3210, das
 *                          Vite-Frontend). Externe URL (z.B. Vercel-Preview)
 *                          ⇒ kein lokaler webServer.
 *   SMOKE_*              — Smoke-Account-Creds, Defaults siehe fixtures/smoke.ts.
 *
 * WICHTIG: der vite-webServer erzwingt VITE_API_BASE_URL='' +
 * VITE_STRIPE_BACKEND_URL='' (same-origin /api → Vite-Proxy → vercel dev :3211),
 * sonst zeigt .env.local die API-Calls auf das Prod-Deployment und der lokale
 * Webhook-Loop ist tot (siehe src/lib/api/baseUrl.ts: explicit → legacy-Fallback,
 * beide müssen leer sein). Zusätzlich erzwingt er die VITE_CHAT_UI_CUTOVER_*-Flags
 * (siehe webServer-env-Kommentar).
 */
import { defineConfig, devices } from 'playwright/test'
import path from 'node:path'

// Port 3210 statt 3000: auf 3000 läuft auf dieser Maschine häufig ein fremder
// Next-Dev-Server — reuseExistingServer würde ihn übernehmen und alles ist 404.
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3210'
const isLocalTarget = baseURL.includes('localhost') || baseURL.includes('127.0.0.1')

export default defineConfig({
  testDir: '.',
  outputDir: './test-results',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Prod-DB ohne Isolation: Journeys mutieren echte (Smoke-)Rows → niemals parallel.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL,
    // Mobile-first App (max-w-420) — Desktop-Viewport testet ein Layout, das kein User sieht.
    ...devices['iPhone 14'],
    // WebKit-Device-Preset auf Chromium zwingen (ein Browser-Binary, weniger Flake-Fläche).
    defaultBrowserType: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    { name: 'setup', testMatch: /fixtures\/auth\.setup\.ts/ },
    {
      name: 'journeys',
      testMatch: /journeys\/.*\.spec\.ts/,
      dependencies: ['setup'],
    },
  ],

  // Split-Architektur (vercel dev kann das Vite-Frontend nicht serven — der
  // SPA-Catch-all-Rewrite aus vercel.json rewritet /@vite/* und /src/* auf
  // index.html → Vite-Transform-500):
  //   1. vercel dev :3211 — NUR /api-Functions (sein Frontend wird nie aufgerufen)
  //   2. vite :3210       — Frontend; /api wird via server.proxy an :3211 gereicht
  // ulimit: macOS-Default-FD-Limit (256 soft) reicht nicht für die Watcher
  // in diesem Repo → EMFILE-Crash (zusätzlich: Watch-Ignores in vite.config.ts
  // + .vercelignore halten .claude/ raus).
  ...(isLocalTarget
    ? {
        webServer: [
          {
            // stdio MUSS in eine Datei (echte fds) statt in Playwrights Pipes:
            // vercel dev forkt pro /api-Invocation einen @vercel/node-Worker
            // mit stdio-Inheritance. Erbt er Playwrights Capture-Pipes, schlägt
            // der Fork unter macOS mit `spawn EBADF` fehl → jeder /api-Call gibt
            // 502 (FUNCTION_INVOCATION_FAILED). Frontend-only-Journeys (core-flow,
            // alles direkt gegen Supabase) merken davon nichts; sobald eine
            // Journey eine Serverless-Function trifft (funding → initiate-funding)
            // kippt sie. Redirect auf eine Datei gibt dem Worker valide fds.
            // Readiness erkennt Playwright via `url`-Poll, nicht über stdout.
            command:
              'ulimit -n 65536 && vercel dev --listen 3211 --yes > /tmp/fixup-e2e-vercel-dev.log 2>&1',
            cwd: path.resolve(process.cwd()),
            url: 'http://localhost:3211/',
            timeout: 180_000,
            reuseExistingServer: !process.env.CI,
          },
          {
            command: 'ulimit -n 65536 && npx vite --port 3210 --strictPort',
            cwd: path.resolve(process.cwd()),
            url: baseURL,
            timeout: 120_000,
            // Fail-fast statt stilles Reuse: ein fremder/leftover-Vite auf :3210
            // (manuell `npx vite --port 3210`, oder Rest eines hart-gekillten
            // Laufs) trägt die VITE_CHAT_UI_CUTOVER_*-Injektion unten NICHT →
            // die Kunden-Erstkontakt-Strecke schriebe still in die stillgelegte
            // legacy `conversations`-Tabelle (Writes revoked → 42501, „Anfrage
            // konnte nicht gestartet werden"). Mit --strictPort bricht der Lauf
            // hier laut ab, statt einen flag-off-Server zu erben.
            reuseExistingServer: false,
            env: {
              ...process.env,
              // Leer = same-origin /api → landet im Vite-Proxy → vercel dev :3211.
              // Beide Variablen, weil baseUrl.ts explicit → legacy fallbackt.
              VITE_API_BASE_URL: '',
              VITE_STRIPE_BACKEND_URL: '',
              // Chat-Cutover erzwingen: Vite exponiert VITE_-Prefix-Vars aus
              // process.env an import.meta.env (Vorrang vor .env-Dateien). Im
              // Dev-Mode lädt Vite NICHT .env.production (wo die Flags stehen) →
              // ohne diese beiden Zeilen läuft die Kunden-Erstkontakt-Strecke in
              // die stillgelegte legacy `conversations`-Tabelle (Writes revoked →
              // 42501, „Anfrage konnte nicht gestartet werden"). Nicht von einer
              // handgepflegten .env.local abhängig machen.
              VITE_CHAT_UI_CUTOVER_CUSTOMER: 'true',
              VITE_CHAT_UI_CUTOVER_CRAFTSMAN: 'true',
            },
          },
        ],
      }
    : {}),
})
