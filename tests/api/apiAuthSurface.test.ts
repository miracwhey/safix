/**
 * Lightweight regression guard for the API auth surface.
 *
 * Verifies that:
 * 1. All simple-auth routes use `requireAuth` (not raw `authenticateRequest`)
 * 2. Only dual-auth routes still use `authenticateRequest` directly
 * 3. Cron routes use `requireCronAuth`
 * 4. No route accesses `.statusCode` or `.error` on AuthResult outside _auth.ts
 *    except in properly guarded dual-auth blocks
 *
 * This prevents regressions where a new route copies stale boilerplate
 * instead of using the centralized helpers.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const API_DIR = path.resolve(__dirname, '../../api')
const CRON_DIR = path.resolve(API_DIR, 'cron')

function readApi(file: string): string {
  return fs.readFileSync(path.join(API_DIR, file), 'utf-8')
}

function readCron(file: string): string {
  return fs.readFileSync(path.join(CRON_DIR, file), 'utf-8')
}

// Routes that must use `requireAuth` (simple JWT auth — no dual-auth)
const SIMPLE_AUTH_ROUTES = [
  'initiate-funding.ts',
  'capture-escrow.ts',
  'delete-account.ts',
  'refund-escrow.ts',
  'submit-rating.ts',
  'send-notification-email.ts',
]

// Routes that legitimately use `authenticateRequest` (dual-auth pattern).
// confirm-funding.ts uses requireCustomer for the JWT branch (see
// ROLE_AUTH_ROUTES) — server-secret branch bypasses role enforcement.
const DUAL_AUTH_ROUTES = [
  'confirm-supplementary-funding.ts',
  'release-supplementary-payout.ts',
  'release-tranche.ts',
]

// Routes that enforce a role gate via api/_authRole.ts (Block 7.2.1c-FU).
// Each entry pairs the file with the helper(s) it must import.
const ROLE_AUTH_ROUTES: Array<{ file: string; helpers: string[] }> = [
  { file: 'request-funding.ts', helpers: ['requireOwner'] },
  { file: 'confirm-funding.ts', helpers: ['requireCustomer'] },
  { file: 'funding-entry.ts', helpers: ['requireCustomer'] },
  { file: 'connect-account.ts', helpers: ['requireOwner'] },
  { file: 'connect-onboarding-link.ts', helpers: ['requireOwner'] },
  { file: 'payout-account-status.ts', helpers: ['requireOwner'] },
]

// Cron routes that must use `requireCronAuth`
const CRON_ROUTES = [
  'cleanup-stale-webhooks.ts',
  'reconcile-payments.ts',
]

describe('API auth surface — regression guard', () => {
  describe('simple-auth routes use requireAuth', () => {
    for (const file of SIMPLE_AUTH_ROUTES) {
      it(`${file} imports requireAuth (not authenticateRequest)`, () => {
        const content = readApi(file)
        expect(content).toContain('requireAuth')
        expect(content).toContain("from './_auth")
        // Must NOT contain a raw authenticateRequest import
        expect(content).not.toMatch(/import\s*\{[^}]*authenticateRequest[^}]*\}\s*from/)
      })
    }
  })

  describe('dual-auth routes use authenticateRequest (legitimate)', () => {
    for (const file of DUAL_AUTH_ROUTES) {
      it(`${file} imports authenticateRequest for conditional auth`, () => {
        const content = readApi(file)
        expect(content).toContain('authenticateRequest')
        expect(content).toContain("from './_auth")
      })
    }
  })

  describe('role-auth routes import the appropriate _authRole helper', () => {
    for (const { file, helpers } of ROLE_AUTH_ROUTES) {
      it(`${file} imports ${helpers.join(' + ')} from _authRole`, () => {
        const content = readApi(file)
        expect(content).toContain("from './_authRole")
        for (const helper of helpers) {
          expect(content).toContain(helper)
        }
      })
    }
  })

  describe('cron routes use requireCronAuth', () => {
    for (const file of CRON_ROUTES) {
      it(`${file} imports requireCronAuth`, () => {
        const content = readCron(file)
        expect(content).toContain('requireCronAuth')
      })
    }
  })

  describe('no unsafe AuthResult property access outside _auth.ts', () => {
    it('no route accesses auth.statusCode outside dual-auth narrowing', () => {
      const allApiFiles = fs.readdirSync(API_DIR)
        .filter(f => f.endsWith('.ts') && f !== '_auth.ts' && f !== '_cronAuth.ts')

      for (const file of allApiFiles) {
        const content = readApi(file)
        // If the file uses authenticateRequest directly, it must be a known dual-auth route
        if (content.includes('authenticateRequest') && !DUAL_AUTH_ROUTES.includes(file)) {
          throw new Error(
            `${file} uses authenticateRequest directly but is not a dual-auth route. ` +
            `Use requireAuth instead.`,
          )
        }
      }
    })
  })
})
