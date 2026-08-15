import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import WelcomeCodeSheet from '../../src/components/team/WelcomeCodeSheet'

function render(code: string): string {
  return renderToString(
    React.createElement(WelcomeCodeSheet, {
      code,
      onSendEmail: async () => ({ ok: true, maskedEmail: 'o***@example.com' }),
    }),
  )
}

describe('WelcomeCodeSheet', () => {
  it('renders the code in the hero block', () => {
    const html = render('ABCDEF')
    expect(html).toContain('ABCDEF')
  })

  it('renders both copy and email CTAs by default', () => {
    const html = render('ZYXWVU')
    expect(html).toContain('Code kopieren')
    expect(html).toContain('Per E-Mail senden')
  })

  it('uses the German invitation header copy', () => {
    const html = render('ABCDEF')
    expect(html).toContain('Mitarbeiter einladen')
  })

  it('exposes data-testids the integration test can target', () => {
    const html = render('ABCDEF')
    expect(html).toContain('data-testid="welcome-code-sheet"')
    expect(html).toContain('data-testid="welcome-code-copy"')
    expect(html).toContain('data-testid="welcome-code-email"')
  })
})
