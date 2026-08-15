import { Capacitor } from '@capacitor/core'
import { logError } from '../observability'

/**
 * Android hardware/gesture back-button coordinator.
 *
 * Capacitor fires EVERY registered `App.backButton` listener with no priority
 * (core `notifyListeners` → `listeners.forEach`). One raw listener per overlay
 * therefore double-fires: an open modal's close handler AND the app's
 * navigation handler both run on a single press. This module funnels every
 * consumer through ONE native `App.backButton` listener plus a LIFO
 * interceptor stack, so the topmost open overlay consumes the press and the
 * default navigation only runs when no overlay claims it.
 *
 * Android-only: `App.backButton` never fires on iOS or web, so `initBackButton`
 * is a no-op there and interceptors registered on those platforms simply never
 * run — callers can register unconditionally.
 */

/** Returns true when the press was consumed (suppresses default navigation). */
type BackInterceptor = () => boolean

const interceptors: BackInterceptor[] = []
let listenerHandle: { remove: () => Promise<void> } | null = null
let attaching = false
let defaultHandler: (() => void) | null = null

/**
 * Register an overlay's back handler (typically "close this modal"). Returns an
 * unregister function to call on unmount. The handler returns `true` when it
 * consumed the press so the default navigation does not also run.
 */
export function registerBackInterceptor(handler: BackInterceptor): () => void {
  interceptors.push(handler)
  return () => {
    const idx = interceptors.lastIndexOf(handler)
    if (idx !== -1) interceptors.splice(idx, 1)
  }
}

/**
 * Install the single `App.backButton` listener and set the default (no-overlay)
 * handler — typically router-back / minimize. Idempotent: the native listener
 * is attached once; later calls only swap the default handler. Returns a
 * teardown that clears the default handler and removes the native listener.
 */
export function initBackButton(handler: () => void): () => void {
  defaultHandler = handler

  if (Capacitor.getPlatform() !== 'android') {
    return () => {
      if (defaultHandler === handler) defaultHandler = null
    }
  }

  if (!listenerHandle && !attaching) {
    attaching = true
    void (async () => {
      try {
        const { App } = await import('@capacitor/app')
        listenerHandle = await App.addListener('backButton', () => {
          // Top of stack first: the most recently opened overlay wins.
          for (let i = interceptors.length - 1; i >= 0; i--) {
            try {
              if (interceptors[i]()) return
            } catch (err) {
              logError('backButton.interceptor_failed', err)
            }
          }
          defaultHandler?.()
        })
      } catch (err) {
        logError('backButton.attach_failed', err)
      } finally {
        attaching = false
      }
    })()
  }

  return () => {
    if (defaultHandler === handler) defaultHandler = null
    void listenerHandle?.remove()
    listenerHandle = null
  }
}
