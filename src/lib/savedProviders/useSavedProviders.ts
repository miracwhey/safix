import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../supabase'
import { listSavedProviders, type SavedProviderEntry } from './savedProviderService'

type State = {
  entries: SavedProviderEntry[]
  loading: boolean
  error: string | null
  hydrated: boolean
}

const INITIAL: State = { entries: [], loading: false, error: null, hydrated: false }

export type UseSavedProvidersResult = State & {
  refresh: () => Promise<void>
}

/**
 * Watches the full list of saved providers for the current user.
 * Realtime channel on `provider_saves` refreshes the list on any change.
 */
export function useSavedProviders(): UseSavedProvidersResult {
  const [state, setState] = useState<State>(INITIAL)
  const generationRef = useRef(0)

  const fetchAll = useCallback(async () => {
    const generation = ++generationRef.current
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const entries = await listSavedProviders()
      if (generation !== generationRef.current) return
      setState({ entries, loading: false, error: null, hydrated: true })
    } catch {
      if (generation !== generationRef.current) return
      setState((s) => ({
        ...s,
        loading: false,
        error: 'Gespeicherte Handwerker konnten nicht geladen werden.',
        hydrated: true,
      }))
    }
  }, [])

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
      await fetchAll()
      if (cancelled) return

      channel = supabase
        .channel(`provider-saves-list-${userId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'provider_saves', filter: `user_id=eq.${userId}` },
          () => {
            if (cancelled) return
            void fetchAll()
          },
        )
        .subscribe()
    }

    void init()

    return () => {
      cancelled = true
      if (channel) void supabase.removeChannel(channel)
    }
  }, [fetchAll])

  return { ...state, refresh: fetchAll }
}
