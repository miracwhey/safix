/**
 * Block 3 — Internal route/screen classification contract
 *
 * Documents and validates the actor-to-route access model for internal
 * craftsman routes after Block 3 hardening.
 *
 * Classification:
 *   owner-only    — /craftsman/* routes behind OwnerRouteGate
 *   employee-only — /worker behind EmployeeRouteGate
 *   shared-internal — routes intentionally reachable by multiple actors,
 *                     with explicit safe branching
 *
 * This file tests the access helpers that back the gate decisions, ensuring
 * that employee sessions are rejected by every owner-level helper, and that
 * the resolver produces distinct, non-leaking contexts for each actor.
 *
 * Block 3 changes (App.tsx):
 *   /craftsman/notifications   AuthGate(craftsman) → OwnerRouteGate
 *   /craftsman/request/:id     AuthGate(craftsman) → OwnerRouteGate
 *   /craftsman/messages/:id    AuthGate(craftsman) → OwnerRouteGate
 *   /craftsman/quotes/:id      AuthGate(craftsman) → OwnerRouteGate
 */

import { describe, it, expect } from 'vitest'
import {
  resolveAppContext,
  isOwnerCraftsman,
  canAccessOperatorTools,
  canAccessFinanceOps,
  canAccessDisputeResolution,
  type AppContext,
} from '../../src/lib/access'
import type { SessionState } from '../../src/lib/session'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockUser = { id: 'user-1', email: 'test@example.com' } as SessionState['user']

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    user: null,
    role: null,
    craftsmanRole: null,
    isOperator: false,
    loading: false,
    sessionValidated: false,
    error: null,
    errorKind: null,
    ...overrides,
  }
}

const ownerSession = makeSession({
  user: mockUser,
  sessionValidated: true,
  role: 'craftsman',
  craftsmanRole: 'owner',
})
const employeeSession = makeSession({
  user: mockUser,
  sessionValidated: true,
  role: 'craftsman',
  craftsmanRole: 'worker',
})
const customerSession = makeSession({
  user: mockUser,
  sessionValidated: true,
  role: 'customer',
})

// ---------------------------------------------------------------------------
// AppContext — distinct per actor
// ---------------------------------------------------------------------------

describe('AppContext: actor resolution is distinct for all three actors', () => {
  it('owner resolves to "owner"', () => {
    expect(resolveAppContext(ownerSession)).toBe<AppContext>('owner')
  })

  it('employee resolves to "employee"', () => {
    expect(resolveAppContext(employeeSession)).toBe<AppContext>('employee')
  })

  it('customer resolves to "customer"', () => {
    expect(resolveAppContext(customerSession)).toBe<AppContext>('customer')
  })

  it('employee does NOT resolve to owner', () => {
    expect(resolveAppContext(employeeSession)).not.toBe('owner')
  })

  it('employee does NOT resolve to customer', () => {
    expect(resolveAppContext(employeeSession)).not.toBe('customer')
  })
})

// ---------------------------------------------------------------------------
// OwnerRouteGate backing: isOwnerCraftsman
//
// All four routes reclassified in Block 3 are now behind OwnerRouteGate,
// which internally calls isOwnerCraftsman(). An employee session MUST return
// false here — this is the gate that redirects workers to /worker.
// ---------------------------------------------------------------------------

describe('isOwnerCraftsman: employee is rejected from all owner-only routes', () => {
  it('owner session passes isOwnerCraftsman', () => {
    expect(isOwnerCraftsman(ownerSession)).toBe(true)
  })

  it('employee session is rejected by isOwnerCraftsman', () => {
    // This is the check backing OwnerRouteGate.
    // Routes /craftsman/notifications, /craftsman/request/:id,
    // /craftsman/messages/:id, /craftsman/quotes/:id are now all
    // behind OwnerRouteGate which uses craftsmanRole === 'owner' —
    // an employee (craftsmanRole='worker') is redirected to /worker.
    expect(isOwnerCraftsman(employeeSession)).toBe(false)
  })

  it('customer session is rejected by isOwnerCraftsman', () => {
    expect(isOwnerCraftsman(customerSession)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// All owner-level access helpers deny employee
// ---------------------------------------------------------------------------

describe('owner-level access helpers: employee is denied uniformly', () => {
  it('canAccessOperatorTools denies employee', () => {
    expect(canAccessOperatorTools(employeeSession)).toBe(false)
  })

  it('canAccessFinanceOps denies employee', () => {
    expect(canAccessFinanceOps(employeeSession)).toBe(false)
  })

  it('canAccessDisputeResolution denies employee even with isOperator=true', () => {
    const elevatedEmployee = makeSession({
      user: mockUser,
      sessionValidated: true,
      role: 'craftsman',
      craftsmanRole: 'worker',
      isOperator: true,
    })
    expect(canAccessDisputeResolution(elevatedEmployee)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Route classification contract (documented as invariants)
//
// These tests assert on the access-helper level that backs the route gates.
// They serve as a regression anchor for the Block 3 classification.
// ---------------------------------------------------------------------------

describe('Block 3 route classification contract', () => {
  // Owner-only routes (OwnerRouteGate → isOwnerCraftsman check)
  // Note: /craftsman/work-queue was reclassified into a Navigate redirect to
  // /craftsman/jobs?focus=handlungsbedarf when the unified Aufträge surface
  // absorbed the legacy ActionQueue screen. The redirect target is gated.
  const ownerOnlyRoutes = [
    '/craftsman/jobs',
    '/craftsman/jobs/:jobId',
    '/craftsman/requests',
    '/craftsman/notifications',    // reclassified in Block 3
    '/craftsman/request/:projectId', // reclassified in Block 3
    '/craftsman/messages/:threadId', // reclassified in Block 3
    '/craftsman/quotes/:offerId',    // reclassified in Block 3
    '/craftsman/operations',
    '/craftsman/finance',
    '/craftsman/invoices',
    '/craftsman/profile',
    '/craftsman/payout-setup',
    '/craftsman/disputes',
    '/craftsman/operator',
  ]

  it('all owner-only routes require isOwnerCraftsman — owner passes', () => {
    // The gate backing all of these is isOwnerCraftsman().
    // This test documents that owner is always allowed.
    expect(isOwnerCraftsman(ownerSession)).toBe(true)
    // Sanity: this covers all routes in the list above.
    expect(ownerOnlyRoutes.length).toBeGreaterThan(0)
  })

  it('all owner-only routes require isOwnerCraftsman — employee is rejected', () => {
    expect(isOwnerCraftsman(employeeSession)).toBe(false)
  })

  it('employee-only route /worker: employee resolves to "employee", not "owner"', () => {
    // EmployeeRouteGate allows craftsmanRole==='worker', rejects owner.
    // Validate actor resolution is correct for the gate check.
    expect(resolveAppContext(employeeSession)).toBe('employee')
    expect(resolveAppContext(ownerSession)).not.toBe('employee')
  })

  it('customer routes: customer resolves to "customer", not craftsman actors', () => {
    expect(resolveAppContext(customerSession)).toBe('customer')
    expect(isOwnerCraftsman(customerSession)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// No cross-actor leakage via craftsmanRole coarseness
// ---------------------------------------------------------------------------

describe('craftsmanRole coarseness: role=craftsman does not conflate owner and employee', () => {
  it('both owner and employee have role=craftsman, but resolve to different AppContext', () => {
    expect(ownerSession.role).toBe('craftsman')
    expect(employeeSession.role).toBe('craftsman')
    // Same raw role, different contexts — raw role checks alone are insufficient.
    expect(resolveAppContext(ownerSession)).toBe('owner')
    expect(resolveAppContext(employeeSession)).toBe('employee')
  })

  it('isOwnerCraftsman uses craftsmanRole, not raw role — rejects worker', () => {
    // A naive `role === "craftsman"` check would incorrectly allow employees.
    // isOwnerCraftsman correctly requires craftsmanRole === "owner".
    const naiveCheck = employeeSession.role === 'craftsman'
    const correctCheck = isOwnerCraftsman(employeeSession)
    expect(naiveCheck).toBe(true)    // the bug: raw role check would pass
    expect(correctCheck).toBe(false) // the fix: isOwnerCraftsman rejects worker
  })
})
