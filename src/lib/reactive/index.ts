/**
 * Reactive UI hooks
 *
 * A focused set of hooks that unify the repeated multi-store subscription
 * pattern used across screens.  They eliminate boilerplate `useEffect` /
 * unsubscribe chains while keeping domain stores, workflows, and business
 * logic exactly where they are.
 *
 * Usage
 * -----
 * • `useStoreSync`          — one sync callback triggered by any of N stores
 * • `useStoreSubscriptions` — per-store callbacks when each store drives
 *                             different state updates
 */
export { useStoreSync } from './useStoreSync'
export { useStoreSubscriptions, type StoreEntry } from './useStoreSubscriptions'
