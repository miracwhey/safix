/**
 * Pending-Push-Route · Block 7.2 / B2
 *
 * Modul-scoped Variable + Subscriber-Set für Push-Routes, die zum Zeitpunkt
 * des Push-Empfangs noch nicht direkt navigiert werden können (z.B. weil App
 * gerade im Cold-Start ist und die Session noch nicht restored, oder weil
 * der User auf der Login-Maske steht und sich erst noch authentifizieren
 * muss).
 *
 * Semantik
 * ─────────────────────────────────────────────────────────────────────────
 * - `set(route)`         · überschreibt die aktuell gequeuete Route (letzter
 *                          Push gewinnt — verhindert Stale-Pending bei
 *                          mehreren Pushes in kurzer Folge)
 * - `peek()`             · liest ohne zu konsumieren (für UI-Hints
 *                          „Aktion „Korrektur c-1" wartet auf dich")
 * - `consume()`          · liest UND clear (atomic, kein Doppel-Navigate)
 * - `clear()`            · explizit verwerfen (User „Verwerfen" im Modal)
 * - `subscribe(handler)` · Hook in App.tsx wird informiert sobald `set` läuft,
 *                          damit warm-Pushes nach Auth-Ready sofort
 *                          aufgefangen werden statt erst beim nächsten
 *                          Render
 *
 * Persistenz
 * ─────────────────────────────────────────────────────────────────────────
 * In-memory ist für Block B2 ausreichend: Default-Push-Tap überlebt App-Kill
 * sowieso nicht (iOS würde den Push neu antippen lassen). Action-Replay
 * (Block A2) braucht IndexedDB-Persistenz und liegt in einem separaten
 * Modul `pendingPushAction.ts` — bewusst getrennt von Pending-Route.
 */

export interface PendingPushRoute {
  /** Pfad ohne Query, z.B. `/craftsman/korrekturen/c-123` */
  path: string
  /** Search-String inklusive `?`, z.B. `?focus=documents` oder `''` */
  search: string
}

let current: PendingPushRoute | null = null
const subscribers = new Set<(route: PendingPushRoute | null) => void>()

/**
 * Setzt eine neue Pending-Route. Letzter Push gewinnt — bestehende
 * gequeuete Route wird überschrieben (kein Pending-Queue-Stack, weil
 * Default-Tap-Pushes auf den letzten Stand zeigen sollen).
 */
export function set(route: PendingPushRoute): void {
  current = route
  for (const handler of subscribers) {
    try {
      handler(current)
    } catch {
      // Subscriber-Fehler dürfen das Set nicht abbrechen — nächste
      // Subscriber laufen weiter, Bridge bleibt funktionsfähig.
    }
  }
}

/**
 * Liest die Pending-Route ohne sie zu konsumieren. Nützlich für UI-Hints
 * (Login-Screen „danach geht's zu …", Replay-Modal-Header).
 */
export function peek(): PendingPushRoute | null {
  return current
}

/**
 * Liest die Pending-Route und löscht sie atomar — verhindert
 * Doppel-Navigate bei React-StrictMode-Doppel-Render.
 */
export function consume(): PendingPushRoute | null {
  const route = current
  current = null
  if (route) {
    for (const handler of subscribers) {
      try {
        handler(null)
      } catch {
        // siehe set()
      }
    }
  }
  return route
}

/**
 * Verwirft eine eventuell gequeuete Route ohne zu navigieren — z.B. wenn
 * User „Verwerfen" im Replay-Modal wählt.
 */
export function clear(): void {
  if (current === null) return
  current = null
  for (const handler of subscribers) {
    try {
      handler(null)
    } catch {
      // siehe set()
    }
  }
}

/**
 * Registriert einen Subscriber, der bei jedem `set`/`consume`/`clear`
 * gerufen wird. Liefert eine Unsubscribe-Funktion zurück.
 *
 * Verbraucher (`usePendingPushRouteConsume`) registriert sich beim Mount,
 * cleanup beim Unmount.
 */
export function subscribe(
  handler: (route: PendingPushRoute | null) => void,
): () => void {
  subscribers.add(handler)
  return () => {
    subscribers.delete(handler)
  }
}

/**
 * Test-only reset. Setzt das Modul auf den Initialzustand zurück, damit
 * Tests ohne Cross-Test-Kontamination laufen können. NICHT im Produktiv-
 * Code aufrufen.
 */
export function __testOnly_reset(): void {
  current = null
  subscribers.clear()
}
