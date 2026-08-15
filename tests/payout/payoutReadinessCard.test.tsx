import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import PayoutReadinessCard from '../../src/components/payout/PayoutReadinessCard'

function render(
  status: Parameters<typeof PayoutReadinessCard>[0]['status'],
  disabled?: boolean,
): string {
  return renderToString(
    React.createElement(PayoutReadinessCard, {
      status,
      onSetup: () => {},
      ...(disabled !== undefined ? { disabled } : {}),
    }),
  )
}

// React SSR serialises the disabled attribute as disabled="" when true,
// and omits it entirely when false. Tailwind utility classes like
// disabled:opacity-50 contain "disabled" as a substring, so asserting
// on the plain string "disabled" is unreliable. We assert on disabled=""
// which is only present when the HTML attribute is actually set.
const DISABLED_ATTR = 'disabled=""'

describe('PayoutReadinessCard CTA clarity', () => {
  it('shows a start button when no account exists', () => {
    const html = render('no_account')
    expect(html).toContain('Jetzt starten')
  })

  it('shows a continue CTA when onboarding is in progress', () => {
    const html = render('onboarding_in_progress')
    expect(html).toContain('Bei Stripe fortsetzen')
  })

  it('renders no CTA when payout is ready', () => {
    const html = render('payout_ready')
    expect(html).not.toContain('button')
  })
})

describe('PayoutReadinessCard disabled state', () => {
  it('button carries disabled attribute when disabled=true', () => {
    const html = render('no_account', true)
    expect(html).toContain(DISABLED_ATTR)
  })

  it('button does not carry disabled attribute by default', () => {
    const html = render('no_account')
    expect(html).not.toContain(DISABLED_ATTR)
  })

  it('button does not carry disabled attribute when disabled=false', () => {
    const html = render('no_account', false)
    expect(html).not.toContain(DISABLED_ATTR)
  })

  it('button is disabled for onboarding_in_progress when disabled=true', () => {
    const html = render('onboarding_in_progress', true)
    expect(html).toContain(DISABLED_ATTR)
    expect(html).toContain('Bei Stripe fortsetzen')
  })

  it('button is not disabled for onboarding_in_progress by default', () => {
    const html = render('onboarding_in_progress')
    expect(html).not.toContain(DISABLED_ATTR)
  })

  it('button is disabled for payout_blocked when disabled=true', () => {
    const html = render('payout_blocked', true)
    expect(html).toContain(DISABLED_ATTR)
    expect(html).toContain('Anforderungen öffnen')
  })

  it('pending_verification shows status-check button', () => {
    const html = render('pending_verification')
    expect(html).toContain('Status prüfen')
  })

  it('pending_verification button carries disabled attribute when disabled=true', () => {
    const html = render('pending_verification', true)
    expect(html).toContain(DISABLED_ATTR)
    expect(html).toContain('Status prüfen')
  })

  it('pending_verification button is not disabled by default', () => {
    const html = render('pending_verification')
    expect(html).not.toContain(DISABLED_ATTR)
  })

  it('payout_ready renders no button regardless of disabled prop', () => {
    const html = render('payout_ready', true)
    expect(html).not.toContain('button')
  })
})
