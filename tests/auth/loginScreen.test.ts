import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import React from 'react'
import LoginScreen from '../../src/screens/LoginScreen'

describe('LoginScreen autofill comfort', () => {
  it('renders mobile-friendly autofill attributes for the email field', () => {
    const tree = React.createElement(
      MemoryRouter,
      null,
      React.createElement(LoginScreen, null),
    )

    const html = renderToString(tree).toLowerCase()

    expect(html).toContain('autocomplete="email"')
    expect(html).toContain('inputmode="email"')
    expect(html).toContain('autocapitalize="none"')
    expect(html).toContain('autocorrect="off"')
    expect(html).toContain('name="email"')
    expect(html).toContain('id="login-email"')
    expect(html).toContain('enterkeyhint="send"')
  })

  it('renders password field with correct autofill attributes in login mode', () => {
    const tree = React.createElement(
      MemoryRouter,
      null,
      React.createElement(LoginScreen, null),
    )

    const html = renderToString(tree).toLowerCase()

    expect(html).toContain('type="password"')
    expect(html).toContain('autocomplete="current-password"')
    expect(html).toContain('name="password"')
    expect(html).toContain('id="login-password"')
    expect(html).toContain('minlength="6"')
  })

  it('defaults to email/password login as primary auth method', () => {
    const tree = React.createElement(
      MemoryRouter,
      null,
      React.createElement(LoginScreen, null),
    )

    const html = renderToString(tree)

    // Primary heading should indicate login
    expect(html).toContain('Bei SaFix anmelden')
    // Subtitle should reference email and password
    expect(html).toContain('E-Mail und Passwort')
    // Submit button should say "Anmelden" (login)
    expect(html).toContain('Anmelden')
    // Magic link should be available as secondary option
    expect(html).toContain('Magic Link')
  })

  it('shows signup toggle', () => {
    const tree = React.createElement(
      MemoryRouter,
      null,
      React.createElement(LoginScreen, null),
    )

    const html = renderToString(tree)

    expect(html).toContain('Noch kein Konto?')
    expect(html).toContain('Jetzt registrieren')
  })
})
