import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'

import LegalSheet from '../../src/components/legal/LegalSheet'

describe('LegalSheet — Block M4 sheet-index', () => {
  it('renders three section buttons when open', () => {
    const html = renderToString(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(LegalSheet, { open: true, onClose: vi.fn() }),
      ),
    )
    expect(html).toContain('Rechtliches')
    expect(html).toContain('AGB')
    expect(html).toContain('Datenschutz')
    expect(html).toContain('Impressum')
    // role=dialog comes from BottomSheet wrapper
    expect(html).toContain('role="dialog"')
  })

  it('renders nothing when closed', () => {
    const html = renderToString(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(LegalSheet, { open: false, onClose: vi.fn() }),
      ),
    )
    expect(html).not.toContain('Rechtliches')
    expect(html).not.toContain('role="dialog"')
  })
})
