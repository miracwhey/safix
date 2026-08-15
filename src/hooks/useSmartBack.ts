import { useCallback } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'

/**
 * Robust "back" for every screen — no dead-ends.
 *
 * `navigate(-1)` alone is fragile: when a screen is the FIRST history entry
 * (cold deep-link, a shared link, a hard refresh, or the first screen after a
 * `replace` redirect), stepping back leaves the SPA — on native iOS the
 * WKWebView lands on a blank page / exits, so the user is stuck.
 *
 * `useSmartBack(fallback)` returns a `goBack` that:
 *   - goes back in history when there IS in-app history to go back to
 *     (`location.key !== 'default'` — React Router stamps every pushed entry
 *     with a non-default key; only the initial entry is `'default'`), so
 *     A→B→back lands on A and A⇄B toggling works as expected;
 *   - otherwise navigates to `fallback` (a sensible parent route) with
 *     `replace`, so the user always escapes the screen instead of dead-ending.
 *
 * Pass the screen's logical parent as `fallback` (e.g. a job detail → its list
 * route). Defaults to `'/'` (HomeGate, which role-routes) when omitted.
 */
export function useSmartBack(fallback: string = '/'): () => void {
  const navigate = useNavigate()
  const location = useLocation()

  return useCallback(() => {
    if (location.key !== 'default') {
      navigate(-1)
    } else {
      navigate(fallback, { replace: true })
    }
  }, [navigate, location.key, fallback])
}
