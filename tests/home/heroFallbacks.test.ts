import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import OwnerHomeHero from '../../src/components/home/OwnerHomeHero'
import CustomerHomeHero from '../../src/components/home/CustomerHomeHero'
import type { OwnerHomeState, CustomerHomeState, HomeAction } from '../../src/lib/viewmodel/homeState'

function ownerOnboardingState(action: HomeAction | null): OwnerHomeState {
  return {
    kind: 'onboarding_incomplete',
    priorityReason: null,
    severity: 'action',
    primaryAction: action,
    followUps: [],
    notificationDot: false,
  }
}

function customerWaitingState(action: HomeAction | null): CustomerHomeState {
  return {
    kind: 'waiting',
    priorityReason: 'awaiting_offers',
    severity: 'action',
    primaryAction: action,
    followUps: [],
    notificationDot: false,
  }
}

function renderOwner(state: OwnerHomeState): string {
  return renderToString(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(OwnerHomeHero, { vm: state }),
    ),
  )
}

function renderCustomer(state: CustomerHomeState): string {
  return renderToString(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(CustomerHomeHero, { vm: state }),
    ),
  )
}

describe('OwnerHomeHero · onboarding_incomplete fallback (P6)', () => {
  it('renders an actionable button when primaryAction is provided', () => {
    const html = renderOwner(
      ownerOnboardingState({
        actionId: 'complete_profile',
        label: 'Profil vervollständigen',
        route: '/onboarding/craftsman-profile',
      }),
    )
    expect(html).toContain('Profil vervollständigen')
    expect(html).toContain('<button')
  })

  it('renders a non-clickable status card when primaryAction is null', () => {
    const html = renderOwner(ownerOnboardingState(null))
    // No misleading primary CTA label
    expect(html).not.toContain('Profil vervollständigen')
    // Honest fallback wording
    expect(html).toContain('Setup wird geprüft')
    // Profile hub fallback affordance is present (handler not in SSR output,
    // assert on the button label which is unique to the fallback path)
    expect(html).toContain('Profil öffnen')
  })
})

describe('CustomerHomeHero · waiting fallback (P7)', () => {
  it('renders a navigable button when primaryAction is provided', () => {
    const html = renderCustomer(
      customerWaitingState({
        actionId: 'view_project',
        label: 'Projekt öffnen',
        route: '/projects/abc',
      }),
    )
    expect(html).toContain('<button')
    expect(html).toContain('Projekt öffnen')
  })

  it('renders a static status card when primaryAction is null — no fake button, no navigate-to-home', () => {
    const html = renderCustomer(customerWaitingState(null))
    // No outer <button> wrapper
    expect(html).not.toContain('<button')
    // Status copy is still shown
    expect(html).toContain('Anfrage läuft')
    // Inner CTA pill must not be rendered without action
    expect(html).not.toContain('rounded-[14px] py-3 font-bold')
  })
})
