/**
 * useCorridorAction — corridor-grade async action hook with full feedback contract.
 *
 * Wraps async actions and integrates with the ToastProvider to deliver:
 *   - pending state (isLoading + button disabling)
 *   - success feedback (auto-dismiss toast)
 *   - failure feedback (longer-duration error toast + inline error)
 *   - double-trigger protection (execute is a no-op while loading)
 *
 * Usage:
 * ```tsx
 * const { execute, isLoading, error, clearError } = useCorridorAction(
 *   async () => { await someWorkflow() },
 *   {
 *     successMessage: 'Nachricht gesendet',
 *     errorMessage: 'Nachricht konnte nicht gesendet werden',
 *   }
 * )
 * ```
 *
 * The `successMessage` is shown as a transient toast.
 * The `errorMessage` is shown as an error toast AND available via `error` for
 * inline display if the screen prefers that pattern.
 *
 * If no `errorMessage` is provided, the hook falls back to the error's own
 * message or a generic German string.
 */
import { useState, useCallback, useRef } from 'react'
import { useToast } from './useToast'
import { useHaptics } from './useHaptics'

type CorridorActionOptions = {
  /** Toast message on success.  Omit to suppress the success toast (for
   *  actions where the UI change itself is sufficient confirmation). */
  successMessage?: string
  /** Toast message on failure.  Falls back to error.message or generic. */
  errorMessage?: string
  /** Called after successful execution (before toast). */
  onSuccess?: () => void
}

export function useCorridorAction<T>(
  action: () => Promise<T>,
  options: CorridorActionOptions = {}
): {
  execute: () => Promise<T | undefined>
  isLoading: boolean
  error: string | null
  clearError: () => void
} {
  const toast = useToast()
  const haptics = useHaptics()
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inflightRef = useRef(false)

  // Ref-capture options so execute doesn't re-create when callers pass
  // inline object literals (which is every call site).
  const optionsRef = useRef(options)
  optionsRef.current = options

  const clearError = useCallback(() => setError(null), [])

  const execute = useCallback(async (): Promise<T | undefined> => {
    // Double-trigger guard using ref to avoid stale closure on isLoading
    if (inflightRef.current) return undefined
    inflightRef.current = true

    setIsLoading(true)
    setError(null)

    try {
      const result = await action()
      optionsRef.current.onSuccess?.()
      if (optionsRef.current.successMessage) {
        toast.success(optionsRef.current.successMessage)
        haptics.success()
      }
      return result
    } catch (e) {
      const msg =
        optionsRef.current.errorMessage ??
        (e instanceof Error ? e.message : 'Aktion fehlgeschlagen')
      setError(msg)
      toast.error(msg)
      haptics.error()
      return undefined
    } finally {
      inflightRef.current = false
      setIsLoading(false)
    }
  }, [action, toast, haptics])

  return { execute, isLoading, error, clearError }
}
