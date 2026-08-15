import { useEffect, useRef } from 'react'

/**
 * A function that registers a no-argument listener and returns an unsubscribe function.
 * This matches the subscribe signature used by all domain stores in this codebase.
 */
type SubscribeFn = (listener: () => void) => () => void

/**
 * Subscribes to one or more stores and calls a single `sync` function whenever
 * any of them emits a change.
 *
 * - Subscriptions are set up once on mount and torn down on unmount.
 * - `sync` is captured via a ref so it always reflects the latest version,
 *   even when it closes over state or props that change between renders.
 * - All `stores` are expected to be stable references (module-level exports).
 *   If you need to conditionally subscribe, guard with an empty array.
 *
 * @example
 * // CraftsmanFinanceScreen – six stores, one refresh
 * useStoreSync(
 *   [subscribeJobs, subscribeMessages, subscribePayments,
 *    subscribeInvoices, subscribeDisputes, subscribeLedger],
 *   () => setVm(getFinanceDashboardViewModel()),
 * )
 */
export function useStoreSync(
  stores: ReadonlyArray<SubscribeFn>,
  sync: () => void,
): void {
  const syncRef = useRef<() => void>(sync)
  syncRef.current = sync

  useEffect(
    () => {
      if (stores.length === 0) return

      const handler = () => syncRef.current()
      const unsubs = stores.map((sub) => sub(handler))
      return () => {
        unsubs.forEach((unsub) => unsub())
      }
    },
    // Stores are module-level stable imports; we intentionally subscribe once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
}
