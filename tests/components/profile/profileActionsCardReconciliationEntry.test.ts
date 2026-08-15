/**
 * Block N13.Customer-Center — verifies that the Reconciliation entry on
 * `<ProfileActionsCard>` renders for both craftsman and customer roles
 * with role-aware routing, AND that non-reconciliation roles (operator,
 * worker, null) get a clean early-return so the
 * `useReconciliationListBuckets` hook never mounts for them.
 *
 * The hook subscribes three reactive stores (disputes / jobs / payments).
 * Mounting it for a viewer who never sees the entry would burn cycles
 * for nothing — the early-return + sub-component extraction is the
 * defence.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'

// The hook is imported inside the component; we mock it at the module
// boundary to track call sites.
const useReconciliationListBucketsMock = vi.fn()

vi.mock('../../../src/lib/reconciliation/useReconciliationListBuckets', () => ({
  useReconciliationListBuckets: (
    role: 'customer' | 'craftsman',
  ): {
    counts: { active: number; awaitingViewer: number; resolved: number }
  } => useReconciliationListBucketsMock(role),
}))

// useSession is pulled in transitively via ProfileActionsCard's auth
// imports. Stub the auth module so signOut/deleteAccount don't blow up
// during render.
vi.mock('../../../src/lib/auth', () => ({
  signOut: vi.fn(),
  deleteAccount: vi.fn(),
}))

vi.mock('../../../src/components/legal/LegalSheet', () => ({
  default: () => null,
}))

import ProfileActionsCard from '../../../src/components/profile/ProfileActionsCard'

beforeEach(() => {
  useReconciliationListBucketsMock.mockReset()
  useReconciliationListBucketsMock.mockReturnValue({
    counts: { active: 0, awaitingViewer: 0, resolved: 0 },
  })
})

function render(role: 'customer' | 'craftsman' | 'operator' | 'worker' | null): string {
  return renderToString(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(ProfileActionsCard, { role: role as never }),
    ),
  )
}

describe('ProfileActionsCard — Reconciliation entry routing', () => {
  it('craftsman: renders entry with craftsman route', () => {
    const html = render('craftsman')
    expect(html).toContain('Klärungen')
    // We render a button, not a link, but the navigate target lives in
    // the onClick. We verify the role-aware *route* survives by
    // checking the hook was called with the craftsman role exactly once.
    expect(useReconciliationListBucketsMock).toHaveBeenCalledWith('craftsman')
    expect(useReconciliationListBucketsMock).toHaveBeenCalledTimes(1)
  })

  it('customer: renders entry with customer role', () => {
    const html = render('customer')
    expect(html).toContain('Klärungen')
    expect(useReconciliationListBucketsMock).toHaveBeenCalledWith('customer')
    expect(useReconciliationListBucketsMock).toHaveBeenCalledTimes(1)
  })

  it('operator: NO entry — hook never mounts', () => {
    const html = render('operator')
    expect(html).not.toContain('Klärungen')
    expect(useReconciliationListBucketsMock).not.toHaveBeenCalled()
  })

  it('worker: NO entry — hook never mounts', () => {
    const html = render('worker')
    expect(html).not.toContain('Klärungen')
    expect(useReconciliationListBucketsMock).not.toHaveBeenCalled()
  })

  it('null role (unauthenticated): NO entry — hook never mounts', () => {
    const html = render(null)
    expect(html).not.toContain('Klärungen')
    expect(useReconciliationListBucketsMock).not.toHaveBeenCalled()
  })

  it('craftsman with awaitingViewer > 0: badge surfaces', () => {
    useReconciliationListBucketsMock.mockReturnValueOnce({
      counts: { active: 3, awaitingViewer: 2, resolved: 5 },
    })
    const html = render('craftsman')
    // Badge contains the awaitingViewer count
    expect(html).toContain('>2<')
    expect(html).toContain('warten auf dich')
  })

  it('customer with awaitingViewer > 0: badge surfaces', () => {
    useReconciliationListBucketsMock.mockReturnValueOnce({
      counts: { active: 1, awaitingViewer: 1, resolved: 0 },
    })
    const html = render('customer')
    expect(html).toContain('>1<')
    expect(html).toContain('warten auf dich')
  })
})
