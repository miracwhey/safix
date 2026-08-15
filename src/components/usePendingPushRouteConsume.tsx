/**
 * usePendingPushRouteConsume · Block 7.2 / B2
 *
 * Mountet React-Router an die Push-Bridge (über `attachNavigationAdapter`)
 * und konsumiert eventuell während Cold-Start gequeuete Push-Routes,
 * sobald Session-Restore + ToS-Gate durch sind.
 *
 * Auch reagiert auf Push-Sets WÄHREND der App offen ist (Subscriber):
 * sollte ein Push während eines noch laufenden Auth-Flows (z.B. User auf
 * `/login`) reinkommen, wird der Subscriber getriggert, der nächste
 * effect-pass nach `sessionValidated` konsumiert dann.
 *
 * Nicht-Scope:
 * - Pending-ACTION (mit Confirm-Sheet, IndexedDB, Replay-Modal) liegt in
 *   Block A2 in `usePendingPushActionConsume` — bewusst getrennt.
 * - LoginScreen ruft zusätzlich post-`signInWithPassword` direkt
 *   `pendingPushRoute.consume()` auf, damit ein Push, der WÄHREND der
 *   Login-Submission gequeued wurde, nicht auf den nächsten Render warten
 *   muss (siehe `LoginScreen.tsx`).
 */

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSession } from '../hooks/useSession'
import {
  attachNavigationAdapter,
  detachNavigationAdapter,
} from '../lib/notifications/pushBridgeNavigationAdapter'
import * as pendingPushRoute from '../lib/notifications/pendingPushRoute'

export function usePendingPushRouteConsume(): void {
  const navigate = useNavigate()
  const session = useSession()
  // Subscriber-Tick: bumpt bei jedem `set`/`clear` aus der Bridge,
  // damit der consume-Effect re-evaluiert wird.
  const [setTick, setSetTick] = useState(0)

  // Adapter-Attach für Warm-Navigate-Pfad. Solange dieser Hook gemountet
  // ist, kann `tryNavigate` direkt React-Router-`navigate` aufrufen.
  useEffect(() => {
    attachNavigationAdapter((to, options) => navigate(to, options))
    return () => {
      detachNavigationAdapter()
    }
  }, [navigate])

  // Subscriber für Re-Evaluation bei externem `set`.
  useEffect(() => {
    const unsubscribe = pendingPushRoute.subscribe(() => {
      setSetTick((tick) => tick + 1)
    })
    return unsubscribe
  }, [])

  // Consume-Effect: läuft nach Auth-Ready und bei jedem Subscriber-Tick.
  useEffect(() => {
    if (!session.user || !session.sessionValidated) return
    const route = pendingPushRoute.consume()
    if (!route) return
    navigate(`${route.path}${route.search}`, { replace: false })
  }, [session.user, session.sessionValidated, navigate, setTick])
}
