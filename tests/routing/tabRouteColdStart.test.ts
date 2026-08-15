// @vitest-environment jsdom
/**
 * Cold-start tab-URL hold — resume robustness Block 2, Posten 4.
 *
 * After a WebView content-process kill Capacitor reloads the CURRENT URL,
 * but on the first renders the session is not yet validated (`onTab` false;
 * for owners the profile-readiness module cache is empty after every
 * reload). Previously the 6 deep tab paths ('/explore', '/messages',
 * '/profile', '/craftsman/dashboard', '/craftsman/backoffice',
 * '/craftsman/messages') had no <Route> in the non-tab block, so the '*'
 * catch-all replaced the URL with '/' before validation settled — the user
 * landed on Home instead of e.g. their chat list.
 *
 * Contract under test (App.tsx TabRouteColdStartGate + TAB_COLD_START_HOLD_PATHS):
 *   1. Tab path + pending validation      → ScreenSkeleton, URL preserved.
 *   2. Validation settles on a tab route  → non-tab block unmounts, the
 *      persistent tab shell takes over, URL preserved (no redirect fired).
 *   3. Owner: validated but profile-readiness still loading → URL held
 *      (invisible hold on owner tab paths where the tab shell already shows
 *      content, skeleton elsewhere); 'ready' → tab shell; 'incomplete' →
 *      '/' (HomeGate owns onboarding).
 *   4. Unknown (404) paths keep redirecting to '/' IMMEDIATELY, even while
 *      validation is pending — catch-all behavior unchanged.
 *   5. Logged-out / network-error settle → '/' where HomeGate owns the
 *      login-redirect / error-recovery flow (exact pre-existing behavior).
 *
 * Session states mirror the real producer (src/lib/session.ts) — see the
 * line references on each fixture. Rendered with @testing-library/react in
 * a MemoryRouter; heavy App collaborators are stubbed, the routing units
 * under test (tabRoutes, lib/access, ScreenSkeleton, react-router) are real.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'

const h = React.createElement

// ---------------------------------------------------------------------------
// Stores driving the mocked hooks — useSyncExternalStore-backed so state
// changes re-render the tree exactly like the real subscription hooks do.
// ---------------------------------------------------------------------------

const sessionStore = vi.hoisted(() => {
  let current: Record<string, unknown> = {}
  const listeners = new Set<() => void>()
  return {
    get: () => current,
    set(next: Record<string, unknown>) {
      current = next
      listeners.forEach((l) => l())
    },
    subscribe(l: () => void) {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
  }
})

const profileReadyStore = vi.hoisted(() => {
  let current = 'loading'
  const listeners = new Set<() => void>()
  return {
    get: () => current,
    set(next: string) {
      current = next
      listeners.forEach((l) => l())
    },
    subscribe(l: () => void) {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
  }
})

// ---------------------------------------------------------------------------
// Mocks — hooks are store-backed; heavy components become inert markers.
// ---------------------------------------------------------------------------

vi.mock('../../src/hooks/useSession', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useSession: () => useSyncExternalStore(sessionStore.subscribe, sessionStore.get),
  }
})

vi.mock('../../src/hooks/useCraftsmanProfileReady', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    // Mirrors the real hook contract (useCraftsmanProfileReady.ts:90-92):
    // 'disabled' when not enabled, otherwise the module-cache state which is
    // 'loading' after every reload until the fetch resolves.
    useCraftsmanProfileReady: (enabled: boolean = true) => {
      const state = useSyncExternalStore(profileReadyStore.subscribe, profileReadyStore.get)
      return [enabled ? state : 'disabled', () => {}]
    },
    invalidateCraftsmanProfileCache: () => {},
  }
})

// App only pulls isPasswordRecoveryActive from lib/session; the
// recovery-redirect early return is upstream of this change and stays off.
vi.mock('../../src/lib/session', () => ({
  isPasswordRecoveryActive: () => false,
}))

vi.mock('../../src/components/PersistentTabs', async () => {
  const { useSyncExternalStore, createElement } = await import('react')
  // Shape-faithful stand-in: mirrors the real mount gate
  // (PersistentTabs.tsx:83 — `if (!user || !sessionValidated) return null`)
  // without dragging in the seven tab screens. The marker therefore only
  // appears when the real tab shell would actually render content.
  function PersistentTabsStub() {
    const s = useSyncExternalStore(sessionStore.subscribe, sessionStore.get) as {
      user: unknown
      sessionValidated: boolean
    }
    if (!s.user || !s.sessionValidated) return null
    return createElement('div', { 'data-testid': 'persistent-tabs' })
  }
  return { default: PersistentTabsStub }
})

vi.mock('../../src/components/HomeGate', async () => {
  const { createElement } = await import('react')
  return { default: () => createElement('div', { 'data-testid': 'home-gate' }) }
})

vi.mock('../../src/screens/TosGateScreen', async () => {
  const { createElement } = await import('react')
  return { default: () => createElement('div', { 'data-testid': 'tos-gate' }) }
})

vi.mock('../../src/components/system/SyncStatusBar', () => ({ default: () => null }))
vi.mock('../../src/components/notifications/PushActionReplayModal', () => ({ default: () => null }))
vi.mock('../../src/components/RoleGate', () => ({ default: () => null }))
vi.mock('../../src/components/AuthGate', () => ({
  default: ({ children }: { children?: React.ReactNode }) => children ?? null,
}))
vi.mock('../../src/components/OwnerRouteGate', () => ({
  default: ({ children }: { children?: React.ReactNode }) => children ?? null,
}))
vi.mock('../../src/components/subscription/ProScreenGuard', () => ({
  default: ({ children }: { children?: React.ReactNode }) => children ?? null,
}))
vi.mock('../../src/components/EmployeeRouteGate', () => ({
  default: ({ children }: { children?: React.ReactNode }) => children ?? null,
}))
vi.mock('../../src/components/usePendingPushRouteConsume', () => ({
  usePendingPushRouteConsume: () => {},
}))
vi.mock('../../src/lib/notifications/pushNotificationBridge', () => ({
  setBridgeSessionProvider: () => {},
}))
vi.mock('../../src/lib/worker/photoUploadQueueRunner', () => ({
  startPhotoUploadQueueRunner: () => () => {},
}))
vi.mock('../../src/lib/subscription/revenueCat', () => ({
  initializeRevenueCat: () => Promise.resolve(),
}))

import App from '../../src/App'
import { TAB_COLD_START_HOLD_PATHS } from '../../src/lib/navigation/tabRoutes'

// ---------------------------------------------------------------------------
// Producer-faithful session fixtures (src/lib/session.ts)
// ---------------------------------------------------------------------------

const USER = { id: 'user-1', email: 'user@example.com' }
const TOS = '2026-01-01T00:00:00.000Z'

// session.ts:535-548 — cached-snapshot hydration on cold start: ONLY the
// user object is restored; role/craftsmanRole/isOperator stay empty and
// loading=true until refreshSession() validates against the server.
const coldStartCachedUser = {
  user: USER,
  role: null,
  craftsmanRole: null,
  isOperator: false,
  tosAcceptedAt: null,
  loading: true,
  sessionValidated: false,
  error: null,
  errorKind: null,
}

// session.ts:353-356 — initial module state without a cached snapshot.
const coldStartNoCache = { ...coldStartCachedUser, user: null }

// session.ts success path (~750-823) — fully validated sessions.
const validatedCustomer = {
  user: USER,
  role: 'customer',
  craftsmanRole: null,
  isOperator: false,
  tosAcceptedAt: TOS,
  loading: false,
  sessionValidated: true,
  error: null,
  errorKind: null,
}

const validatedOwner = {
  ...validatedCustomer,
  role: 'craftsman',
  craftsmanRole: 'owner',
}

// session.ts:647-651 — getSession() returned no user → EMPTY_SESSION.
const loggedOutSettled = {
  user: null,
  role: null,
  craftsmanRole: null,
  isOperator: false,
  tosAcceptedAt: null,
  loading: false,
  sessionValidated: false,
  error: null,
  errorKind: null,
}

// session.ts:664-672 — getUser() network failure on cold start: state-spread
// keeps the cached user and sessionValidated:false, flips loading off and
// surfaces a retry-able error.
const networkErrorSettled = {
  ...coldStartCachedUser,
  loading: false,
  error: 'Session-Laden fehlgeschlagen',
  errorKind: 'network_error',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function LocationProbe() {
  const location = useLocation()
  return h('div', { 'data-testid': 'location-probe' }, location.pathname)
}

function renderAt(path: string) {
  return render(
    h(MemoryRouter, { initialEntries: [path] }, h(App), h(LocationProbe)),
  )
}

function currentPath(): string {
  return screen.getByTestId('location-probe').textContent ?? ''
}

function hasSkeleton(): boolean {
  // Canonical ScreenSkeleton shimmer container (ScreenSkeleton.tsx).
  return document.querySelector('.fx-skeleton') !== null
}

afterEach(() => {
  cleanup()
  sessionStore.set({})
  profileReadyStore.set('loading')
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TAB_COLD_START_HOLD_PATHS — exact route set', () => {
  it('covers every tab path of both contexts except "/" (HomeGate keeps its own route)', () => {
    expect([...TAB_COLD_START_HOLD_PATHS].sort()).toEqual(
      [
        '/explore',
        '/messages',
        '/profile',
        '/craftsman/dashboard',
        '/craftsman/backoffice',
        '/craftsman/messages',
      ].sort(),
    )
    expect(TAB_COLD_START_HOLD_PATHS).not.toContain('/')
  })
})

describe('cold-start tab-URL hold', () => {
  it('customer tab path: pending validation shows skeleton and preserves the URL; settle hands over to the tab shell', () => {
    sessionStore.set(coldStartCachedUser)
    renderAt('/messages')

    // Pending: skeleton, URL intact, no redirect, tab shell still gated off.
    expect(currentPath()).toBe('/messages')
    expect(hasSkeleton()).toBe(true)
    expect(screen.queryByTestId('persistent-tabs')).toBeNull()

    // Validation settles → onTab flips true, non-tab block unmounts.
    act(() => sessionStore.set(validatedCustomer))
    expect(currentPath()).toBe('/messages')
    expect(hasSkeleton()).toBe(false)
    expect(screen.getByTestId('persistent-tabs')).toBeTruthy()
  })

  it('owner tab path: URL survives BOTH pending phases (session validation, then profile readiness)', () => {
    sessionStore.set(coldStartCachedUser)
    profileReadyStore.set('loading')
    renderAt('/craftsman/messages')

    // Phase 1 — validation in flight: tab shell gated off, skeleton holds.
    expect(currentPath()).toBe('/craftsman/messages')
    expect(hasSkeleton()).toBe(true)
    expect(screen.queryByTestId('persistent-tabs')).toBeNull()

    // Phase 2 — session validates, but the profile-readiness module cache
    // is empty after every reload (the deterministic owner case). The real
    // PersistentTabs already renders the active tab content here (it gates
    // only on user + sessionValidated), so the hold goes invisible: no
    // skeleton stacking below the content, no redirect, URL intact.
    act(() => sessionStore.set(validatedOwner))
    expect(currentPath()).toBe('/craftsman/messages')
    expect(hasSkeleton()).toBe(false)
    expect(screen.getByTestId('persistent-tabs')).toBeTruthy()

    // Settled ready → onTab flips true, the non-tab block unmounts; the URL
    // never moved.
    act(() => profileReadyStore.set('ready'))
    expect(currentPath()).toBe('/craftsman/messages')
    expect(hasSkeleton()).toBe(false)
    expect(screen.getByTestId('persistent-tabs')).toBeTruthy()
  })

  it('owner deep-linked to a customer-only tab path: skeleton during profile readiness, then "/" fallback', () => {
    // '/messages' is a customer tab — for an owner the tab shell shows
    // nothing there, so the hold keeps the skeleton during phase 2 and
    // falls back to '/' (HomeGate owns the context redirect) once settled.
    sessionStore.set(validatedOwner)
    profileReadyStore.set('loading')
    renderAt('/messages')

    expect(currentPath()).toBe('/messages')
    expect(hasSkeleton()).toBe(true)

    act(() => profileReadyStore.set('ready'))
    expect(currentPath()).toBe('/')
    expect(screen.getByTestId('home-gate')).toBeTruthy()
    expect(hasSkeleton()).toBe(false)
  })

  it('owner with incomplete profile falls back to "/" where HomeGate owns the onboarding redirect', () => {
    sessionStore.set(validatedOwner)
    profileReadyStore.set('incomplete')
    renderAt('/craftsman/dashboard')

    expect(currentPath()).toBe('/')
    expect(screen.getByTestId('home-gate')).toBeTruthy()
    expect(hasSkeleton()).toBe(false)
  })

  it('unknown 404 path still redirects to "/" immediately, even while validation is pending', () => {
    sessionStore.set(coldStartCachedUser)
    renderAt('/definitely/not/a/route')

    expect(currentPath()).toBe('/')
    expect(screen.getByTestId('home-gate')).toBeTruthy()
  })

  it('logged-out deep link: skeleton while pending, then "/" where HomeGate owns the /login redirect', () => {
    sessionStore.set(coldStartNoCache)
    renderAt('/messages')

    expect(currentPath()).toBe('/messages')
    expect(hasSkeleton()).toBe(true)

    act(() => sessionStore.set(loggedOutSettled))
    expect(currentPath()).toBe('/')
    expect(screen.getByTestId('home-gate')).toBeTruthy()
    expect(hasSkeleton()).toBe(false)
  })

  it('cold-start network error settles into the "/" recovery flow instead of hanging on the skeleton', () => {
    sessionStore.set(coldStartCachedUser)
    renderAt('/profile')

    expect(currentPath()).toBe('/profile')
    expect(hasSkeleton()).toBe(true)

    act(() => sessionStore.set(networkErrorSettled))
    expect(currentPath()).toBe('/')
    expect(screen.getByTestId('home-gate')).toBeTruthy()
    expect(hasSkeleton()).toBe(false)
  })

  it('validated customer on an owner-only tab path is sent to "/" (wrong-context fallback, same as the old catch-all)', () => {
    sessionStore.set(validatedCustomer)
    renderAt('/craftsman/backoffice')

    // At '/' a validated customer is onTab — the tab shell renders
    // CustomerHomeScreen and the non-tab block (incl. HomeGate) unmounts,
    // exactly like the pre-existing catch-all end state.
    expect(currentPath()).toBe('/')
    expect(screen.getByTestId('persistent-tabs')).toBeTruthy()
    expect(screen.queryByTestId('home-gate')).toBeNull()
  })

  it('ToS gate still short-circuits the whole Routes block — tab URL untouched, no redirect', () => {
    sessionStore.set({ ...validatedCustomer, tosAcceptedAt: null })
    renderAt('/messages')

    expect(screen.getByTestId('tos-gate')).toBeTruthy()
    expect(currentPath()).toBe('/messages')
    expect(hasSkeleton()).toBe(false)
  })
})
