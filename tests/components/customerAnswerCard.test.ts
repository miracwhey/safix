// @vitest-environment jsdom
/**
 * CustomerAnswerCard — presentational render tests (Block 2).
 *
 * Written as .test.ts with createElement (the vitest glob scopes .test.tsx to
 * the spatial tree). Models are hand-built here on purpose: the BUILDER that
 * produces them is independently behaviorally tested in
 * tests/hooks/customerAnswerCard.test.ts — this suite only asserts the card
 * renders a given model faithfully.
 */

import { afterEach, describe, it, expect } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import CustomerAnswerCard, {
  CustomerAnswerCardSkeleton,
} from '../../src/components/customer/CustomerAnswerCard'
import type { CustomerAnswerCardModel } from '../../src/lib/viewmodel/customerAnswerCard'

// Emojis the NextAction view-model carries — the card must NEVER render them.
const NEXT_ACTION_EMOJIS = ['⚖️', '✅', '💳', '⏳', '⌛', '🔒', '🔨', '📋', '📅', '💰', '↩️', '⚠️']

function renderCard(model: CustomerAnswerCardModel): HTMLElement {
  const { container } = render(
    createElement(MemoryRouter, null, createElement(CustomerAnswerCard, { model })),
  )
  return container
}

function model(overrides: Partial<CustomerAnswerCardModel> = {}): CustomerAnswerCardModel {
  return {
    tone: 'calm',
    iconKey: 'pending',
    chip: 'In Prüfung',
    label: 'Anfrage in Prüfung',
    text: 'Deine Anfrage wird aktuell geprüft.',
    projectTitle: 'Bad sanieren',
    ctaLabel: 'Zum Projekt',
    route: { to: '/projects/p1' },
    escrowConfirmed: false,
    meta: { gewerk: 'Elektrik', adresse: 'Limmerstr. 83' },
    ...overrides,
  }
}

afterEach(cleanup)

describe('CustomerAnswerCard — icon is Lucide, never the NextAction emoji', () => {
  it('renders an <svg> icon and no emoji codepoint', () => {
    const container = renderCard(model({ iconKey: 'pay', label: 'Zahlung leisten' }))
    expect(container.querySelector('svg')).toBeTruthy()
    const text = container.textContent ?? ''
    for (const emoji of NEXT_ACTION_EMOJIS) {
      expect(text.includes(emoji)).toBe(false)
    }
  })
})

describe('CustomerAnswerCard — tones + CTA', () => {
  it('loud → filled CTA links to the route', () => {
    renderCard(
      model({
        tone: 'loud',
        iconKey: 'pay',
        label: 'Zahlung leisten',
        ctaLabel: 'Auftrag bezahlen',
        route: { to: '/funding/fr-1' },
      }),
    )
    const cta = screen.getByRole('link', { name: /Auftrag bezahlen/ })
    expect(cta.getAttribute('href')).toBe('/funding/fr-1')
  })

  it('calm → quiet "Zum Projekt" link to project', () => {
    renderCard(model())
    const cta = screen.getByRole('link', { name: /Zum Projekt/ })
    expect(cta.getAttribute('href')).toBe('/projects/p1')
  })

  it('nudge → "Handwerker finden" links to /search', () => {
    renderCard(
      model({
        tone: 'nudge',
        iconKey: 'nudge',
        label: 'Finde Handwerker für dein Projekt',
        ctaLabel: 'Handwerker finden',
        route: { to: '/search', state: { mode: 'project', projectId: 'p1' } },
      }),
    )
    const cta = screen.getByRole('link', { name: /Handwerker finden/ })
    expect(cta.getAttribute('href')).toBe('/search')
  })
})

describe('CustomerAnswerCard — chip + project context', () => {
  it('renders the status chip word and the project title', () => {
    renderCard(model({ chip: 'Streitfall', projectTitle: 'Bad sanieren' }))
    expect(screen.queryByText('Streitfall')).toBeTruthy()
    expect(screen.queryByText('Bad sanieren')).toBeTruthy()
  })
})

describe('CustomerAnswerCard — escrow honesty', () => {
  it('shows the escrow badge only when escrowConfirmed', () => {
    renderCard(model({ escrowConfirmed: true }))
    expect(screen.queryByText('Zahlung gesichert')).toBeTruthy()
  })

  it('hides the escrow badge when not confirmed', () => {
    renderCard(model({ escrowConfirmed: false }))
    expect(screen.queryByText('Zahlung gesichert')).toBeNull()
  })
})

describe('CustomerAnswerCardSkeleton', () => {
  it('renders a fixed-height placeholder (no CLS) with no link', () => {
    const { container } = render(createElement(CustomerAnswerCardSkeleton))
    expect(container.querySelector('.min-h-\\[156px\\]')).toBeTruthy()
    expect(container.querySelector('a')).toBeNull()
  })
})
