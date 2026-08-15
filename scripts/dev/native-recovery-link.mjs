#!/usr/bin/env node
/**
 * Local-only native password-recovery test driver.
 *
 * Builds a real Supabase recovery deep link for the FixUp custom URL scheme
 * (app.fixup.main://) and opens it in the booted iOS simulator. Bypasses
 * Vercel / Universal Links / Supabase redirect-allowlist completely:
 *
 *   1. Sign the test user in via signInWithPassword (anon key, no admin role).
 *   2. Take the resulting access_token + refresh_token.
 *   3. Hand-craft the custom-scheme URL with `type=recovery` in the hash.
 *      Supabase JS detects `type=recovery` purely client-side and fires the
 *      PASSWORD_RECOVERY event the app already handles.
 *   4. xcrun simctl openurl booted → iOS routes the URL to the installed app.
 *
 * Prereqs: a booted iOS simulator with the FixUp app installed (npm run cap:build
 * + Run from Xcode at least once).
 *
 * Usage:
 *   VITE_SUPABASE_URL=... \
 *   VITE_SUPABASE_ANON_KEY=... \
 *   RECOVERY_TEST_EMAIL=test@example.com \
 *   RECOVERY_TEST_PASSWORD=current-password \
 *     node scripts/dev/native-recovery-link.mjs [--print-only]
 */

import { spawnSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'

const url = process.env.VITE_SUPABASE_URL
const anon = process.env.VITE_SUPABASE_ANON_KEY
const email = process.env.RECOVERY_TEST_EMAIL
const password = process.env.RECOVERY_TEST_PASSWORD
const printOnly = process.argv.includes('--print-only')

function fail(msg) {
  console.error(`\n[native-recovery-link] ${msg}\n`)
  process.exit(1)
}

if (!url || !anon) fail('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY required')
if (!email || !password) fail('RECOVERY_TEST_EMAIL and RECOVERY_TEST_PASSWORD required')

const sb = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } })

const { data, error } = await sb.auth.signInWithPassword({ email, password })
if (error || !data.session) fail(`signInWithPassword failed: ${error?.message ?? 'no session'}`)

const { access_token, refresh_token, expires_in } = data.session

const link =
  'app.fixup.main://auth/reset-password' +
  `#access_token=${encodeURIComponent(access_token)}` +
  `&refresh_token=${encodeURIComponent(refresh_token)}` +
  `&expires_in=${expires_in ?? 3600}` +
  '&token_type=bearer' +
  '&type=recovery'

console.log('\nRecovery deep link:\n')
console.log(link)
console.log('\nsimctl command:\n')
console.log(`xcrun simctl openurl booted '${link}'\n`)

if (printOnly) process.exit(0)

const r = spawnSync('xcrun', ['simctl', 'openurl', 'booted', link], { stdio: 'inherit' })
if (r.status !== 0) fail(`xcrun simctl openurl exited with status ${r.status}`)

console.log('[native-recovery-link] sent to booted simulator')
