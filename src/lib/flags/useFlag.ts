import { useSyncExternalStore } from 'react'
import { useSession } from '../../hooks/useSession'
import { getFeatureFlagsRepository } from './repository/registry'
import { isFlagEnabled } from './isFlagEnabled'

/**
 * React hook: resolves a feature flag for the current session and re-renders
 * when the flag changes remotely (the live kill-switch) or the session changes.
 *
 * The external store is the flags repository: getSnapshot returns the cached
 * flag object, whose identity changes only when a realtime refetch replaces the
 * cache — so a remote toggle re-renders subscribers, and steady state does not.
 */
export function useFlag(key: string): boolean {
  const session = useSession()
  useSyncExternalStore(
    (onChange) => getFeatureFlagsRepository().subscribe(onChange),
    () => getFeatureFlagsRepository().getFlag(key),
  )
  return isFlagEnabled(key, session)
}
