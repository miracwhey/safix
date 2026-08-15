import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../supabase'
import { listSavedReels, type SavedReelEntry } from './savedFolderService'

type State = {
  entries: SavedReelEntry[]
  loading: boolean
  error: string | null
  hydrated: boolean
}

const INITIAL: State = { entries: [], loading: false, error: null, hydrated: false }

export type UseSavedReelsResult = State & {
  refresh: () => Promise<void>
}

/**
 * Watches the list of saved reels for one folder (or the virtual default
 * folder when `folderId === null`). Uses the user-scoped Realtime
 * channel on `provider_media_saves` to refresh when saves are added,
 * removed, or moved between folders.
 *
 * Note: we filter by user_id at the channel level (not folder_id),
 * because folder_id can change via UPDATE — relying on a folder-scoped
 * filter would miss the move-out event.
 */
export function useSavedReels(folderId: string | null): UseSavedReelsResult {
  const [state, setState] = useState<State>(INITIAL)
  const generationRef = useRef(0)

  const fetchAll = useCallback(async () => {
    const generation = ++generationRef.current
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const entries = await listSavedReels(folderId)
      if (generation !== generationRef.current) return
      setState({ entries, loading: false, error: null, hydrated: true })
    } catch {
      if (generation !== generationRef.current) return
      setState((s) => ({
        ...s,
        loading: false,
        error: 'Gespeicherte Reels konnten nicht geladen werden.',
        hydrated: true,
      }))
    }
  }, [folderId])

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
        .channel(`saved-reels-${userId}-${folderId ?? 'default'}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'provider_media_saves', filter: `user_id=eq.${userId}` },
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
  }, [fetchAll, folderId])

  return { ...state, refresh: fetchAll }
}
