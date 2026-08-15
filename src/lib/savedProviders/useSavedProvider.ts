import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../supabase'
import { useToast } from '../../hooks/useToast'
import { isSavedProvider, toggleSavedProvider } from './savedProviderService'

type State = {
  saved: boolean
  loading: boolean
  toggling: boolean
  hydrated: boolean
}

const INITIAL: State = { saved: false, loading: false, toggling: false, hydrated: false }

export type UseSavedProviderResult = State & {
  toggle: () => Promise<void>
}

/**
 * Per-profile bookmark toggle hook. Subscribes to Realtime on
 * `provider_saves` filtered by (user_id + provider_id) so multi-device
 * save state stays in sync.
 */
export function useSavedProvider(providerId: string): UseSavedProviderResult {
  const [state, setState] = useState<State>(INITIAL)
  const generationRef = useRef(0)
  const togglingRef = useRef(false)
  // Mirrors the committed `saved` so the optimistic toggle can roll back to the
  // pre-flip value without an impure state-updater (StrictMode-safe).
  const savedRef = useRef(false)
  const toast = useToast()

  useEffect(() => {
    savedRef.current = state.saved
  }, [state.saved])

  const fetchState = useCallback(async () => {
    const generation = ++generationRef.current
    setState((s) => ({ ...s, loading: true }))
    try {
      const saved = await isSavedProvider(providerId)
      if (generation !== generationRef.current) return
      setState((s) => ({ ...s, saved, loading: false, hydrated: true }))
    } catch {
      if (generation !== generationRef.current) return
      setState((s) => ({ ...s, loading: false, hydrated: true }))
    }
  }, [providerId])

  useEffect(() => {
    let cancelled = false
    let channel: ReturnType<typeof supabase.channel> | null = null

    const init = async () => {
      const { data } = await supabase.auth.getSession()
      const userId = data.session?.user?.id ?? null
      if (cancelled) return
      if (!userId) {
        setState({ ...INITIAL, hydrated: true })
        return
      }
      await fetchState()
      if (cancelled) return

      channel = supabase
        .channel(`provider-save-${userId}-${providerId}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'provider_saves',
            filter: `user_id=eq.${userId}`,
          },
          (payload) => {
            if (cancelled) return
            const row = (payload.new ?? payload.old) as { provider_id?: string } | undefined
            if (row?.provider_id !== providerId) return
            void fetchState()
          },
        )
        .subscribe()
    }

    void init()

    return () => {
      cancelled = true
      if (channel) void supabase.removeChannel(channel)
    }
  }, [fetchState, providerId])

  const toggle = useCallback(async () => {
    if (togglingRef.current) return
    togglingRef.current = true
    // Optimistic flip: the bookmark icon reflects the new state instantly
    // instead of lagging the round-trip. The awaited server result reconciles
    // (and realtime keeps multi-device in sync); a throw rolls back to the
    // pre-flip value. Save/bookmark only — money actions keep their FSM-backed
    // rollback and must never flip optimistically.
    const previousSaved = savedRef.current
    setState((s) => ({ ...s, saved: !previousSaved, toggling: true }))
    try {
      const newSaved = await toggleSavedProvider(providerId)
      setState((s) => ({ ...s, saved: newSaved, toggling: false }))
    } catch {
      setState((s) => ({ ...s, saved: previousSaved, toggling: false }))
      toast.error('Konnte nicht gespeichert werden.')
    } finally {
      togglingRef.current = false
    }
  }, [providerId, toast])

  return { ...state, toggle }
}
