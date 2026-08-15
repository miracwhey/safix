// @vitest-environment jsdom
/**
 * CustomerHomeScreen — hydration gate repro (Block 6, spec §5).
 *
 * Spec-mandated "Cold-Start kein lautes 'Zahlung leisten'-Flash vor Funding-
 * Hydration": when the answer card is not yet hydrated, the screen MUST render
 * the skeleton — never the loud card — so a payable-deposit state can't flash
 * before funding truth has loaded. Then once hydrated it shows the real card.
 *
 * The hook + heavy children are mocked so the gate branch is driven
 * deterministically; CustomerAnswerCard + its skeleton render for real.
 */

import { afterEach, describe, it, expect, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import type { UseCustomerAnswerCard } from '../../src/hooks/useHomeState'
import type { CustomerAnswerCardModel } from '../../src/lib/viewmodel/customerAnswerCard'

const gate = vi.hoisted(() => ({ current: null as unknown as UseCustomerAnswerCard }))

vi.mock('../../src/hooks/useHomeState', () => ({ useCustomerAnswerCard: () => gate.current }))
vi.mock('../../src/hooks/useSession', () => ({ useSession: () => ({ user: null }) }))
vi.mock('../../src/components/AppShell', () => ({
  default: ({ children }: { children: unknown }) => createElement('div', null, children),
}))
vi.mock('../../src/components/customer/GuidedEntryCard', () => ({
  default: () => createElement('div', { 'data-testid': 'guided-entry' }, 'guided'),
}))
vi.mock('../../src/components/home/CustomerSpatialHomeCard', () => ({
  CustomerSpatialHomeCard: () => null,
}))
vi.mock('../../src/lib/explore/exploreProfileService', () => ({
  getExploreProviderCards: () => Promise.resolve([]),
}))
vi.mock('../../src/lib/discovery', () => ({ setDiscoveryProviderCache: () => {} }))

import CustomerHomeScreen from '../../src/screens/CustomerHomeScreen'

const LOUD: CustomerAnswerCardModel = {
  tone: 'loud',
  iconKey: 'pay',
  label: 'Zahlung leisten',
  text: 'Leiste die Zahlung, damit der Handwerker beginnen kann.',
  ctaLabel: 'Auftrag bezahlen',
  route: { to: '/funding/fr-1' },
  escrowConfirmed: false,
  meta: {},
}

function renderScreen() {
  return render(createElement(MemoryRouter, null, createElement(CustomerHomeScreen)))
}

afterEach(cleanup)

describe('CustomerHomeScreen — hydration gate (no loud flash)', () => {
  it('not hydrated → skeleton, NEVER the loud card (even with a payable model)', () => {
    gate.current = { topProject: {} as never, model: LOUD, activeProjectCount: 1, isHydrated: false }
    const { container } = renderScreen()
    expect(container.querySelector('.min-h-\\[156px\\]')).toBeTruthy() // skeleton
    expect(screen.queryByText('Zahlung leisten')).toBeNull() // no loud flash
  })

  it('hydrated + payable project → the loud card appears', () => {
    gate.current = { topProject: {} as never, model: LOUD, activeProjectCount: 1, isHydrated: true }
    const { container } = renderScreen()
    expect(screen.getByText('Zahlung leisten')).toBeTruthy()
    expect(container.querySelector('.min-h-\\[156px\\]')).toBeNull() // no skeleton
  })

  it('hydrated + no active project → GuidedEntry (new customer)', () => {
    gate.current = { topProject: null, model: null, activeProjectCount: 0, isHydrated: true }
    renderScreen()
    expect(screen.getByTestId('guided-entry')).toBeTruthy()
    expect(screen.queryByText('Zahlung leisten')).toBeNull()
  })
})
