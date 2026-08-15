import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../supabase'
import {
  countSavedByFolder,
  createFolder as createFolderApi,
  deleteFolder as deleteFolderApi,
  FolderNameInvalidError,
  FolderNameTakenError,
  listFolders,
  renameFolder as renameFolderApi,
  type SavedFolder,
} from './savedFolderService'

type State = {
  folders: SavedFolder[]
  /** Save-count keyed by folder id; `null` key = virtual default folder. */
  countsByFolder: Map<string | null, number>
  /** Sum across all folders incl. default. */
  totalSaved: number
  loading: boolean
  error: string | null
  hydrated: boolean
}

const INITIAL: State = {
  folders: [],
  countsByFolder: new Map(),
  totalSaved: 0,
  loading: false,
  error: null,
  hydrated: false,
}

export type UseSavedFoldersResult = State & {
  refresh: () => Promise<void>
  createFolder: (name: string) => Promise<SavedFolder>
  renameFolder: (folderId: string, name: string) => Promise<SavedFolder>
  deleteFolder: (folderId: string) => Promise<void>
}

/**
 * Watches the current user's folder list + per-folder save-counts. Lives
 * for the lifetime of the consumer (Profile section + saved-reels root
 * screen). Uses two Realtime channels:
 *   - `saved_reel_folders` filtered by `user_id=eq.<self>` to react to
 *     creates/renames/deletes (incl. cross-device).
 *   - `provider_media_saves` filtered by `user_id=eq.<self>` to refresh
 *     the per-folder counter when the user saves/unsaves/moves on any
 *     surface (feed-card, lightbox, sheet).
 *
 * Returns `hydrated=false` until the first fetch resolves so consumers
 * can distinguish "loading" from "really empty".
 */
export function useSavedFolders(): UseSavedFoldersResult {
  const [state, setState] = useState<State>(INITIAL)
  const userIdRef = useRef<string | null>(null)
  const generationRef = useRef(0)

  const fetchAll = useCallback(async () => {
    const generation = ++generationRef.current
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const [folders, counts] = await Promise.all([listFolders(), countSavedByFolder()])
      if (generation !== generationRef.current) return
      let total = 0
      for (const v of counts.values()) total += v
      setState({
        folders,
        countsByFolder: counts,
        totalSaved: total,
        loading: false,
        error: null,
        hydrated: true,
      })
    } catch {
      if (generation !== generationRef.current) return
      setState((s) => ({
        ...s,
        loading: false,
        error: 'Ordner konnten nicht geladen werden.',
        hydrated: true,
      }))
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let foldersChannel: ReturnType<typeof supabase.channel> | null = null
    let savesChannel: ReturnType<typeof supabase.channel> | null = null

    const init = async () => {
      const { data } = await supabase.auth.getSession()
      const userId = data.session?.user?.id ?? null
      if (cancelled) return
      userIdRef.current = userId
      if (!userId) {
        setState({ ...INITIAL, hydrated: true })
        return
      }
      await fetchAll()
      if (cancelled) return

      const refresh = () => {
        if (cancelled) return
        void fetchAll()
      }

      foldersChannel = supabase
        .channel(`saved-folders-${userId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'saved_reel_folders', filter: `user_id=eq.${userId}` },
          refresh,
        )
        .subscribe()

      savesChannel = supabase
        .channel(`saved-folder-counts-${userId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'provider_media_saves', filter: `user_id=eq.${userId}` },
          refresh,
        )
        .subscribe()
    }

    void init()

    return () => {
      cancelled = true
      if (foldersChannel) void supabase.removeChannel(foldersChannel)
      if (savesChannel) void supabase.removeChannel(savesChannel)
    }
  }, [fetchAll])

  const createFolder = useCallback(async (name: string) => {
    try {
      const folder = await createFolderApi(name)
      // Optimistic insert; Realtime echo will re-fetch and idempotently
      // align state. If the realtime channel is slow we still feel snappy.
      setState((s) => ({
        ...s,
        folders: [...s.folders, folder].sort((a, b) =>
          a.sortOrder === b.sortOrder ? b.createdAt - a.createdAt : a.sortOrder - b.sortOrder,
        ),
      }))
      return folder
    } catch (err) {
      if (err instanceof FolderNameTakenError) {
        setState((s) => ({ ...s, error: 'Ein Ordner mit diesem Namen existiert bereits.' }))
      } else if (err instanceof FolderNameInvalidError) {
        setState((s) => ({ ...s, error: 'Ordnername muss 1–60 Zeichen lang sein.' }))
      } else {
        setState((s) => ({ ...s, error: 'Ordner konnte nicht angelegt werden.' }))
      }
      throw err
    }
  }, [])

  const renameFolder = useCallback(async (folderId: string, name: string) => {
    try {
      const folder = await renameFolderApi(folderId, name)
      setState((s) => ({
        ...s,
        folders: s.folders.map((f) => (f.id === folderId ? folder : f)),
      }))
      return folder
    } catch (err) {
      if (err instanceof FolderNameTakenError) {
        setState((s) => ({ ...s, error: 'Ein Ordner mit diesem Namen existiert bereits.' }))
      } else if (err instanceof FolderNameInvalidError) {
        setState((s) => ({ ...s, error: 'Ordnername muss 1–60 Zeichen lang sein.' }))
      } else {
        setState((s) => ({ ...s, error: 'Ordner konnte nicht umbenannt werden.' }))
      }
      throw err
    }
  }, [])

  const deleteFolder = useCallback(async (folderId: string) => {
    try {
      await deleteFolderApi(folderId)
      setState((s) => ({
        ...s,
        folders: s.folders.filter((f) => f.id !== folderId),
      }))
    } catch (err) {
      setState((s) => ({ ...s, error: 'Ordner konnte nicht gelöscht werden.' }))
      throw err
    }
  }, [])

  return {
    ...state,
    refresh: fetchAll,
    createFolder,
    renameFolder,
    deleteFolder,
  }
}
