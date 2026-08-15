import { useState, useCallback, useEffect, useRef } from 'react'

/**
 * Reusable hook for async actions with loading/error/success states.
 *
 * Usage:
 * ```tsx
 * const { execute, isLoading, error, clearError } = useAsyncAction(async () => {
 *   await someWorkflow()
 * })
 * ```
 *
 * Note: `action` should be wrapped with `useCallback` at the call site to
 * prevent unnecessary recreation of `execute` on every render.
 */
export function useAsyncAction<T>(action: () => Promise<T>): {
  execute: () => Promise<T | undefined>
  isLoading: boolean
  error: string | null
  clearError: () => void
} {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const clearError = useCallback(() => {
    setError(null)
  }, [])

  const execute = useCallback(async (): Promise<T | undefined> => {
    setIsLoading(true)
    setError(null)
    try {
      const result = await action()
      return result
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Aktion fehlgeschlagen')
      return undefined
    } finally {
      setIsLoading(false)
    }
  }, [action])

  return { execute, isLoading, error, clearError }
}

/**
 * Corridor-scoped wrapper around useAsyncAction that adds brief
 * success feedback (auto-cleared after 3 s).
 *
 * Only for actions in the core corridor where the user needs calm
 * local success/error reassurance.
 */
export function useActionWithFeedback<T>(
  action: () => Promise<T>,
  successText = 'Erledigt',
): {
  execute: () => Promise<T | undefined>
  isLoading: boolean
  error: string | null
  clearError: () => void
  successMessage: string | null
  clearSuccess: () => void
} {
  const { execute: innerExecute, isLoading, error, clearError } =
    useAsyncAction(action)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const clearSuccess = useCallback(() => setSuccessMessage(null), [])

  const execute = useCallback(async (): Promise<T | undefined> => {
    setSuccessMessage(null)
    const result = await innerExecute()
    if (result !== undefined) {
      setSuccessMessage(successText)
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setSuccessMessage(null), 3000)
    }
    return result
  }, [innerExecute, successText])

  useEffect(() => () => clearTimeout(timerRef.current), [])

  return { execute, isLoading, error, clearError, successMessage, clearSuccess }
}
