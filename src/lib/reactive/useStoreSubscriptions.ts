import { useEffect, useRef } from 'react'

/**
 * A function that registers a no-argument listener and returns an unsubscribe function.
 * This matches the subscribe signature used by all domain stores in this codebase.
 */
type SubscribeFn = (listener: () => void) => () => void

/**
 * Pairs a store's subscribe function with the callback to run on that store's changes.
 */
export type StoreEntry = {
  subscribe: SubscribeFn
  onChange: () => void
}

/**
 * Subscribes to multiple stores where each store triggers its own specific callback.
 *
 * - Subscriptions are set up once on mount and torn down on unmount.
 * - Every `onChange` callback is looked up by its `subscribe` reference on each
 *   invocation, so it always reflects the latest version even when it closes over
 *   state or props that change between renders (e.g. a `jobId` route param).
 * - All `subscribe` functions are expected to be stable references
 *   (module-level exports) — they are used as Map keys to resolve callbacks.
 *
 * @example
 * // CraftsmanJobDetailScreen – four stores, each updating different state slices
 * useStoreSubscriptions([
 *   {
 *     subscribe: subscribeJobs,
 *     onChange: () => { setJob(getJobById(jobId)); setTeamMembers(getTeamMembers()) },
 *   },
 *   { subscribe: subscribeMessages, onChange: () => setConversationMessages(...) },
 *   { subscribe: subscribeOperations, onChange: () => setSchedule(...) },
 *   { subscribe: subscribeMedia, onChange: () => setArtifacts(...) },
 * ])
 */
export function useStoreSubscriptions(entries: ReadonlyArray<StoreEntry>): void {
  // Map keyed by the stable subscribe function so lookups are order-independent.
  const callbackMapRef = useRef<Map<SubscribeFn, () => void>>(new Map())

  // Refresh the map on every render so handlers always call the latest onChange.
  callbackMapRef.current = new Map(entries.map((e) => [e.subscribe, e.onChange]))

  useEffect(
    () => {
      if (entries.length === 0) return

      const unsubs = entries.map(({ subscribe }) =>
        subscribe(() => callbackMapRef.current.get(subscribe)?.()),
      )
      return () => {
        unsubs.forEach((unsub) => unsub())
      }
    },
    // Stores are module-level stable imports; we intentionally subscribe once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
}
