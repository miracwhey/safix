/**
 * AuthGate — warm-session transient error must NOT unmount children.
 *
 * Resume-robustness Block 1 (chat-resume-crash, Fix C):
 *
 * A validated warm session (user && sessionValidated) can pick up a
 * transient error from refreshSession() — e.g. supabase.auth.getUser()
 * failing with network_error on app resume (session.ts keeps user +
 * sessionValidated intact on that path). Previously AuthGate replaced the
 * mounted children with a full ScreenError in that state, destroying
 * in-progress screen state such as a half-typed chat draft.
 *
 * Contract under test:
 *   1. Cold start (never validated) + error  → full-screen ScreenError (unchanged).
 *   2. Cold start loading                    → ScreenSkeleton (unchanged).
 *   3. Warm validated session + error        → children stay mounted; error
 *      communication is owned by SyncStatusBar / the recovery cycle.
 *   4. error + sessionValidated but no user  → login redirect, no ScreenError.
 *
 * Rendered via react-dom/server (node env, no @testing-library/react —
 * same convention as tests/ui/bottomSheet.test.ts).
 */

import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'

const sessionHolder = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}))

vi.mock('../../src/hooks/useSession', () => ({
  useSession: () => sessionHolder.current,
}))

vi.mock('../../src/lib/session', () => ({
  refreshSession: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/lib/auth', () => ({
  signOut: vi.fn().mockResolvedValue(undefined),
}))

import AuthGate from '../../src/components/AuthGate'

const CHILD_MARKER = 'GATE_CHILDREN_CONTENT'
// ScreenError retry CTA label — unique to the error surface.
const ERROR_MARKER = 'Erneut versuchen'

type SessionOverrides = Record<string, unknown>

function makeState(overrides: SessionOverrides): Record<string, unknown> {
  return {
    user: { id: 'user-1', email: 'user@example.com' },
    role: 'customer',
    craftsmanRole: null,
    isOperator: false,
    tosAcceptedAt: 1700000000000,
    loading: false,
    sessionValidated: true,
    error: null,
    errorKind: null,
    ...overrides,
  }
}

function render(state: Record<string, unknown>): string {
  sessionHolder.current = state
  return renderToString(
    React.createElement(
      MemoryRouter,
      { initialEntries: ['/messages/thread-1'] },
      React.createElement(
        AuthGate,
        null,
        React.createElement('div', null, CHILD_MARKER),
      ),
    ),
  )
}

describe('AuthGate — warm session keeps children mounted on transient error', () => {
  it('renders the skeleton during cold start (loading && !sessionValidated)', () => {
    const html = render(makeState({ loading: true, sessionValidated: false, user: null }))
    expect(html).toContain('fx-skeleton')
    expect(html).not.toContain(CHILD_MARKER)
    expect(html).not.toContain(ERROR_MARKER)
  })

  it('renders the full-screen error on cold start failure (!sessionValidated + error) — unchanged', () => {
    const html = render(
      makeState({
        loading: false,
        sessionValidated: false,
        user: null,
        error: 'Session-Laden fehlgeschlagen',
        errorKind: 'network_error',
      }),
    )
    expect(html).toContain(ERROR_MARKER)
    expect(html).not.toContain(CHILD_MARKER)
  })

  it('keeps children mounted when a validated warm session hits a network_error', () => {
    const html = render(makeState({ error: 'Session-Laden fehlgeschlagen', errorKind: 'network_error' }))
    expect(html).toContain(CHILD_MARKER)
    expect(html).not.toContain(ERROR_MARKER)
  })

  it('keeps children mounted for transient errorKinds while the session is validated', () => {
    // Only the kinds whose session.ts path PRESERVES role/tosAcceptedAt may
    // bypass the error screen on a warm session (state-spread paths).
    const kinds = ['network_error', 'unknown_error']
    for (const errorKind of kinds) {
      const html = render(makeState({ error: 'Fehler', errorKind }))
      expect(html, `errorKind=${errorKind}`).toContain(CHILD_MARKER)
      expect(html, `errorKind=${errorKind}`).not.toContain(ERROR_MARKER)
    }
  })

  it('shows the full-screen error for profile errorKinds even when sessionValidated (real session shape: role/tos null)', () => {
    // session.ts hard-sets sessionValidated:true together with role:null AND
    // tosAcceptedAt:null for these kinds. Without the unconditional error
    // branch the gate would fall through to the /tos-gate redirect and send
    // a user with a broken/missing profile row into ToS onboarding.
    const kinds = ['profile_create_failed', 'profile_load_failed', 'profile_schema_mismatch']
    for (const errorKind of kinds) {
      const html = render(
        makeState({
          role: null,
          tosAcceptedAt: null,
          error: 'Profil konnte nicht geladen werden',
          errorKind,
        }),
      )
      expect(html, `errorKind=${errorKind}`).toContain(ERROR_MARKER)
      expect(html, `errorKind=${errorKind}`).not.toContain(CHILD_MARKER)
    }
  })

  it('renders children normally without an error (sanity)', () => {
    const html = render(makeState({}))
    expect(html).toContain(CHILD_MARKER)
    expect(html).not.toContain(ERROR_MARKER)
  })

  it('redirects (renders neither children nor error) when error is set but no user exists despite sessionValidated', () => {
    const html = render(
      makeState({
        user: null,
        error: 'Session-Laden fehlgeschlagen',
        errorKind: 'network_error',
      }),
    )
    // Navigate renders null on the server — the gate must not fall back to
    // the full-screen error nor leak children to an unauthenticated state.
    expect(html).not.toContain(CHILD_MARKER)
    expect(html).not.toContain(ERROR_MARKER)
  })
})
