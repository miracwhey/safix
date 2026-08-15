/**
 * Push-Route Whitelist + Schema-Konstanten · Block 7.2 / B1
 *
 * Single source of truth für die Routes, zu denen ein iOS-Push deep-linken
 * darf. Server-side (`api/notifications/dispatch-push.ts`,
 * `supabase/functions/notify-push/`) reichert `data.route` per Event-Type an;
 * client-side (`pushRouteResolver`) validiert eingehende Routes gegen genau
 * diese Whitelist, bevor React-Router-Navigate getriggert wird.
 *
 * Defense-in-Depth: Backend-Mapping und Frontend-Whitelist werden in PR #3
 * (Block B3) durch einen invariant Drift-Test verkoppelt — jede Route in
 * `_pushRouteMap.ts` MUSS hier matchen.
 */

import { isAttentionFocus, type AttentionFocus } from './focusAnchors'

/**
 * Schema-Version für Push-Payloads.
 *
 * Wird gebumped, sobald sich `PushRouteData` (oder die Action-Payload in
 * Block A) inkompatibel ändert. Resolver droppt Pushes mit unbekannter
 * Version und triggert eine Local-Notification „Update verfügbar" — kein
 * silent fail, kein Crash.
 */
export const PUSH_ROUTE_SCHEMA_VERSION = 1

/**
 * Erlaubte Routes für Push-Deep-Links (MVP, Block 7.2).
 *
 * Reihenfolge: spezifischste zuerst (vermeidet Prefix-Kollisionen). Pro
 * Pattern entscheidet `RegExp.test()` gegen den Pfad-Anteil ohne Query —
 * Query-/Fragment-Suffix wird im Resolver vor Pattern-Match abgetrennt.
 *
 * Erweiterung: pro neuem Push-Ziel hier ein Pattern + identische Spiegelung
 * in `api/notifications/_pushRouteMap.ts` (Block B3) hinzufügen.
 */
export const PUSH_ROUTE_WHITELIST: ReadonlyArray<RegExp> = [
  /^\/craftsman\/korrekturen$/,
  /^\/craftsman\/korrekturen\/[a-zA-Z0-9_-]+$/,
  // Provider Job-Spatial-Detail shell (Phase C · C-9). Mirrors
  // SPATIAL_PUSH_ROUTE_WHITELIST_PATTERN in spatialPushRoutes.ts — the
  // ?tab=/?author=/?pin= query is split off by the resolver before this test.
  /^\/craftsman\/jobs\/[a-zA-Z0-9_-]+\/spatial$/,
  /^\/craftsman\/jobs\/[a-zA-Z0-9_-]+$/,
  // CHAT-3 — chat-message push deep-links (threadId = chat_threads.id).
  // Routes are PRE-ENRICHED by the chat_messages_dispatch_push DB-trigger
  // (no PUSH_ROUTE_MAP entry — Edge enrichment passes unknown types through).
  // Craftsman thread mount: /craftsman/messages/:threadId (OwnerRouteGate,
  // App.tsx); customer thread mount: /messages/:threadId (customer AuthGate).
  // MessageThreadScreen resolves chat-only thread ids via its useChatThread
  // fallback. List tabs (= fallbackRoute targets) live in PersistentTabs.
  /^\/craftsman\/messages\/[a-zA-Z0-9_-]+$/,
  /^\/craftsman\/messages$/,
  /^\/messages\/[a-zA-Z0-9_-]+$/,
  /^\/messages$/,
  /^\/projects\/[a-zA-Z0-9_-]+$/,
  // Customer-facing quote/offer detail (C-10 customer push deep-link).
  // Mounted at `/quotes/:offerId` under the customer AuthGate in App.tsx.
  /^\/quotes\/[a-zA-Z0-9_-]+$/,
  // Customer projects list — safe fallback for offer-sent pushes when the
  // offer id is missing from the payload or the deep-link target is no
  // longer reachable.
  /^\/projects$/,
  // Spatial Lane 3 V1.6 Block 3 — customer "Aufmaß freigegeben" deep link.
  // Mounted at `/customer/spatial/scan/:scanId` under the customer AuthGate.
  /^\/customer\/spatial\/scan\/[a-zA-Z0-9_-]+$/,
  // Spatial Lane 3 V1.6 Block 3 — customer spatial list fallback.
  /^\/customer\/spatial\/list$/,
] as const

/**
 * Eingehender `data`-Block aus dem APNs-Payload, soweit ihn der Resolver
 * konsumiert. Felder sind nullable, weil Pushes aus älteren Backend-Versionen
 * (vor B3-Deploy) sie nicht setzen — Resolver ist tolerant beim Lesen,
 * strikt beim Validieren.
 *
 * Block A erweitert dieses Interface (entityType, actionType, roleTarget,
 * expectedStatus, requiresForeground, requiresConfirmation, createdAt) ohne
 * Breaking Change.
 */
export interface PushRouteData {
  route?: string | null
  focus?: string | null
  fallbackRoute?: string | null
  actionVersion?: number | null
  expiresAt?: number | null
}

/**
 * Resolver-Outcome als discriminated union.
 *
 * - `ok`: Navigation soll stattfinden auf `path` mit `search`.
 * - `fallback`: Originale Route nicht (mehr) erreichbar, aber `fallbackRoute`
 *   liefert ein sicheres Ziel — User wird hingeleitet, App zeigt eine
 *   sichtbare Hinweis-Card (siehe E2E-Mockup Frame 4).
 * - `drop`: Push ist strukturell unbrauchbar (expired, unknown_version,
 *   malformed). Bridge zeigt Local-Notification „App öffnen für aktuellen
 *   Stand" — kein silent drop.
 */
export type PushRouteResolution =
  | { kind: 'ok'; path: string; search: string }
  | { kind: 'fallback'; reason: FallbackReason; path: string; search: string }
  | { kind: 'drop'; reason: DropReason }

export type FallbackReason =
  | 'route_not_whitelisted'
  | 'invalid_focus'
  | 'no_safe_route'

export type DropReason =
  | 'expired'
  | 'unknown_version'
  | 'malformed'
  | 'no_route'

/**
 * Re-Export für Resolver + Tests, damit Konsumenten `AttentionFocus` aus
 * einer Datei beziehen können statt aus `focusAnchors` und `pushRoutes`
 * separat.
 */
export type { AttentionFocus }
export { isAttentionFocus }

/**
 * Prüft, ob ein Pfad gegen mindestens ein Whitelist-Pattern matcht. Pure,
 * keine Side-Effects.
 */
export function isWhitelistedRoute(path: string): boolean {
  return PUSH_ROUTE_WHITELIST.some((pattern) => pattern.test(path))
}
