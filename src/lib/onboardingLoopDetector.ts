const KEY = 'fixup.nav.onboarding_loop'
const WINDOW_MS = 15_000
const THRESHOLD = 4

type Entry = { ts: number }

/**
 * Records an onboarding gate redirect and returns true if a redirect loop is
 * detected (more than THRESHOLD redirects within WINDOW_MS milliseconds).
 *
 * Call this immediately before any gate issues a <Navigate> to an onboarding
 * screen. When it returns true, render an escape hatch (sign-out screen)
 * instead of the redirect so the user cannot be permanently trapped.
 */
export function recordOnboardingRedirect(): boolean {
  let entries: Entry[] = []
  try {
    const raw = sessionStorage.getItem(KEY)
    if (raw) entries = JSON.parse(raw) as Entry[]
  } catch {
    // sessionStorage unavailable or corrupted — fail open (no loop detected)
    return false
  }

  const now = Date.now()
  const recent = entries.filter((e) => now - e.ts < WINDOW_MS)
  recent.push({ ts: now })

  try {
    sessionStorage.setItem(KEY, JSON.stringify(recent))
  } catch {
    // Storage full — not critical
  }

  return recent.length > THRESHOLD
}

export function clearOnboardingRedirectLoop(): void {
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    // ignore
  }
}
