import React from 'react'
import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'

import TosGateScreen from '../../src/screens/TosGateScreen'

/**
 * After Block M4 the TosGate no longer holds inline copies of the legal
 * texts — it imports the same modules that LegalDetailScreen uses. This
 * test pins the unification: distinctive sub-strings from the canonical
 * AGB / Datenschutz / Community-Richtlinien content must appear inside the gate.
 *
 * If somebody re-introduces a parallel copy and the canonical text drifts
 * from the gate, this assertion will fail.
 */
describe('TosGateScreen — Block M4 content unified with /legal', () => {
  it('renders all three sections sourced from legalContent', () => {
    const html = renderToString(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/tos-gate'] },
        React.createElement(TosGateScreen),
      ),
    )

    // Section headings
    expect(html).toContain('Allgemeine Geschäftsbedingungen')
    expect(html).toContain('Datenschutzerklärung')
    expect(html).toContain('Nutzungs- und Community-Richtlinien')

    // AGB-canonical phrase
    expect(html).toContain('Vermittlungsplattform')

    // Datenschutz-canonical: numbered DSGVO sections from legalContent
    expect(html).toContain('1. Verantwortlicher')
    expect(html).toContain('Supabase')
    expect(html).toContain('Stripe')

    // Impressum-canonical address line
    expect(html).toContain('Ihmepassage 6')

    // Acceptance UI still present
    expect(html).toContain('Akzeptieren und fortfahren')
  })
})
