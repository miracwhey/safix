import React from 'react'
import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import LegalScreen from '../../src/screens/LegalScreen'
import LegalDetailScreen from '../../src/screens/LegalDetailScreen'

function render(initial: string): string {
  return renderToString(
    React.createElement(
      MemoryRouter,
      { initialEntries: [initial] },
      React.createElement(
        Routes,
        null,
        React.createElement(Route, { path: '/legal', element: React.createElement(LegalScreen) }),
        React.createElement(Route, {
          path: '/legal/:section',
          element: React.createElement(LegalDetailScreen),
        }),
      ),
    ),
  )
}

describe('Legal — Block M4 Sheet-Index + Full-Screen-Detail', () => {
  it('index renders all seven section links to the detail routes', () => {
    const html = render('/legal')
    expect(html).toContain('href="/legal/agb"')
    expect(html).toContain('href="/legal/anbieter_agb"')
    expect(html).toContain('href="/legal/avv"')
    expect(html).toContain('href="/legal/datenschutz"')
    expect(html).toContain('href="/legal/widerruf"')
    expect(html).toContain('href="/legal/eula"')
    expect(html).toContain('href="/legal/impressum"')
    expect(html).toContain('AGB')
    expect(html).toContain('Datenschutz')
    expect(html).toContain('Impressum')
    expect(html).toContain('Widerruf')
    expect(html).toContain('Community-Richtlinien')
    expect(html).toContain('Anbieterbedingungen')
    expect(html).toContain('Auftragsverarbeitung')
  })

  it('detail screen for AGB renders the AGB title and Zahlung wording', () => {
    const html = render('/legal/agb')
    expect(html).toContain('Allgemeine Geschäftsbedingungen')
    expect(html).toContain('Zahlungsdienstleister Stripe')
    // Back link to the index
    expect(html).toContain('Rechtliches')
  })

  it('detail screen for Datenschutz renders DSGVO sections', () => {
    const html = render('/legal/datenschutz')
    expect(html).toContain('Datenschutzerklärung')
    expect(html).toContain('Verantwortlicher')
    expect(html).toContain('DSGVO')
    expect(html).toContain('Supabase')
    expect(html).toContain('Stripe')
  })

  it('detail screen for Impressum renders the address block', () => {
    const html = render('/legal/impressum')
    expect(html).toContain('Impressum')
    expect(html).toContain('Ihmepassage 6')
    expect(html).toContain('30449 Hannover')
  })

  it('detail screen for Widerruf renders the withdrawal notice + in-app button hint', () => {
    const html = render('/legal/widerruf')
    expect(html).toContain('Widerrufsbelehrung')
    expect(html).toContain('vierzehn Tagen')
    expect(html).toContain('Muster-Widerrufsformular')
    expect(html).toContain('Vertrag widerrufen')
  })

  it('detail screen for EULA renders the community guidelines', () => {
    const html = render('/legal/eula')
    expect(html).toContain('Nutzungs- und Community-Richtlinien')
    expect(html).toContain('24 Stunden')
    expect(html).toContain('blockieren')
  })

  it('detail screen for Anbieterbedingungen renders the B2B commission terms', () => {
    const html = render('/legal/anbieter_agb')
    expect(html).toContain('Anbieterbedingungen für Handwerksbetriebe')
    expect(html).toContain('Provision')
    expect(html).toContain('5 %')
    expect(html).toContain('9 %')
  })

  it('detail screen for AVV renders the Art. 28 processing agreement', () => {
    const html = render('/legal/avv')
    expect(html).toContain('Auftragsverarbeitung')
    expect(html).toContain('Art. 28 DSGVO')
    expect(html).toContain('Weisung')
  })

  it('unknown section falls back to a not-found state with link back to index', () => {
    const html = render('/legal/unknown')
    expect(html).toContain('Dokument nicht gefunden')
    expect(html).toContain('Rechtliches')
  })
})
