import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import { initBackButton } from '../lib/native/backButton'
import { isTabRoute } from '../lib/navigation/tabRoutes'
import type { AppContext } from '../lib/access'

/**
 * Mounts the single Android hardware/gesture back-button handler at the app
 * root. On a bottom-tab root route the press minimizes the app (Android
 * convention — never kill it); on any deeper screen it navigates one step back
 * through router history. iOS/web are no-ops (`App.backButton` never fires
 * there). Overlays that must swallow back (e.g. spatial fullscreen viewers)
 * register via `registerBackInterceptor` from `lib/native/backButton`, which
 * takes priority over this default handler.
 */
export function useAndroidBackButton(context: AppContext): void {
  const navigate = useNavigate()
  const location = useLocation()

  // Latest path + context without re-running the effect (which would detach and
  // re-attach the native listener on every navigation).
  const stateRef = useRef({ path: location.pathname, context })
  stateRef.current = { path: location.pathname, context }

  useEffect(() => {
    if (Capacitor.getPlatform() !== 'android') return
    return initBackButton(() => {
      const { path, context: ctx } = stateRef.current
      if (isTabRoute(path, ctx)) {
        void (async () => {
          try {
            const { App } = await import('@capacitor/app')
            await App.minimizeApp()
          } catch {
            // minimizeApp is Android-only and always present there; ignore.
          }
        })()
      } else {
        navigate(-1)
      }
    })
    // `navigate` is a stable react-router ref; path/context flow via stateRef.
  }, [navigate])
}
