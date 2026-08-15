/**
 * Push-Route-Map (FE-Side) · Block 7.2 / B3
 *
 * Single Source of Truth für die Frontend-Sicht der Route-Anreicherung.
 * Mappt einen Notification-Event-Type auf das Route-Schema, das die
 * Edge-Function (`supabase/functions/notify-push/routeMap.ts`) in den
 * APNs-Payload reinschreibt.
 *
 * Drift-Lock: `tests/notifications/pushRouteMapEdgeParity.test.ts`
 * vergleicht diese Map byte-identisch mit der Deno-seitigen Mirror-Datei.
 * Jede Erweiterung muss in beiden Dateien spiegeln + Test bleibt grün.
 *
 * Whitelist-Lock: `tests/notifications/pushRouteMap.test.ts` substituiert
 * `{jobId}` mit einem Mock und prüft, dass jede `route` und
 * `fallbackRoute` gegen `PUSH_ROUTE_WHITELIST` matcht. Verhindert, dass
 * eine Map-Route zu einem Pfad zeigt, den der Resolver später droppt.
 *
 * Einschränkungen MVP:
 * - Nur job-id-basierte Routes (correction-id und project-id liegen heute
 *   nicht im `notification_signals`-Schema). Customer-Pushes mit
 *   project-spezifischen Tiefen-Routes kommen in einem Folge-Block, der
 *   das Schema erweitert.
 * - 5 Event-Types initial — pro neuem Type: hier + Edge-Function-Mirror
 *   eintragen, Drift-Test bleibt grün.
 */

import { PUSH_ROUTE_SCHEMA_VERSION, type AttentionFocus } from './pushRoutes'

export interface PushRouteMapEntry {
  /**
   * Pfad-Template. Token `{jobId}` wird durch `data.jobId` ersetzt.
   * Andere Tokens werden in MVP nicht unterstützt.
   */
  route: string
  /** Optionaler Focus-Anchor — muss in `FOCUS_SECTION_IDS` existieren. */
  focus?: AttentionFocus
  /** Sicherer Fallback wenn route oder Entity nicht erreichbar — muss whitelisted sein. */
  fallbackRoute: string
  /**
   * APNs-Category-Identifier — wird vom Edge-Function `notify-push` in
   * `aps.category` gesetzt, sodass iOS die in `pushActionRegistry`
   * registrierten Inline-Action-Buttons (Approve/Reject) auf dem Lockscreen
   * rendert. Nur Types mit reversibler, kontextarmer Entscheidung dürfen
   * eine Category bekommen — siehe Block A · M1 Plan §3.
   */
  category?: string
}

/**
 * Mapping `notification_signals.type` → Route-Anreicherung.
 *
 * Pro Eintrag setzt die Edge-Function:
 *   data.route          (mit {jobId} substituiert)
 *   data.focus          (wenn gesetzt)
 *   data.fallbackRoute
 *   data.actionVersion  (= PUSH_ROUTE_SCHEMA_VERSION)
 *
 * Types ohne Eintrag: Edge-Function lässt `data` unverändert, Push routet
 * zur Default-Home (Bridge-Drop mit reason `no_route`).
 */
export const PUSH_ROUTE_MAP: Readonly<Record<string, PushRouteMapEntry>> = {
  // Worker reicht eine Korrektur-Anfrage ein → Owner soll im Job-Detail
  // landen und die Timeline (mit Korrektur-Banner) sehen.
  // Block A · M1 — Category 'CORRECTION_DECISION' setzt iOS-Inline-Buttons
  // (Annehmen / Ablehnen) auf dem Lockscreen.
  correction_created: {
    route: '/craftsman/jobs/{jobId}',
    focus: 'timeline',
    fallbackRoute: '/craftsman/korrekturen',
    category: 'CORRECTION_DECISION',
  },
  // Owner hat eine Korrektur abgelehnt → Worker sieht den Eintrag in der
  // Korrekturen-Liste rot mit Reject-Note.
  correction_rejected: {
    route: '/craftsman/korrekturen',
    fallbackRoute: '/craftsman/korrekturen',
  },
  // Owner hat eine Korrektur angenommen → Worker sieht den Eintrag in der
  // Korrekturen-Liste mit angenommen-Status. Block A · Tangential — der
  // Worker-facing Status-Push hatte vorher keinen Route-Map-Eintrag und
  // wurde als no_route gedroppt.
  correction_resolved: {
    route: '/craftsman/korrekturen',
    fallbackRoute: '/craftsman/korrekturen',
  },
  // Worker hat Arbeit als fertig gemeldet (vor Admin-Confirm-Gate, Block
  // 7.2.1b) → Owner soll im Job-Detail die Timeline + Confirm-CTA sehen.
  worker_marked_complete: {
    route: '/craftsman/jobs/{jobId}',
    focus: 'timeline',
    fallbackRoute: '/craftsman/korrekturen',
  },
  // Owner hat Arbeit final bestätigt → Push geht an Customer. Customer-
  // Routes (`/projects/...`) sind aktuell nicht in der Whitelist auf
  // jobId-Basis abbildbar; Fallback auf Korrekturen-Liste ist
  // un-customer-relevant — diese Map-Entry liefert deshalb bewusst eine
  // craftsman-route (für mehrrolige Logins) und fallback im selben Tree.
  // Customer-spezifische Tiefe folgt in einem Schema-Erweiterungs-Block.
  admin_confirmed_complete: {
    route: '/craftsman/jobs/{jobId}',
    focus: 'timeline',
    fallbackRoute: '/craftsman/korrekturen',
  },
  // Dispute-Status-Update → Owner+Customer sollen Dispute-Section sehen.
  dispute_under_review: {
    route: '/craftsman/jobs/{jobId}',
    focus: 'dispute',
    fallbackRoute: '/craftsman/korrekturen',
  },
  // Block G/J/Phase 2 hotfix — Cloud Run convert finished, craftsman wants
  // to open the job to see the new 3D-Modell card. Map-Schema is jobId-only;
  // the spatial section is rendered inside JobDetail so landing on
  // /craftsman/jobs/{jobId} surfaces the new glTF + opens AR Quick Look
  // affordance. scanId-specific deep linking deferred to schema-extension
  // block (see header MVP note above).
  spatial_convert_ready: {
    route: '/craftsman/jobs/{jobId}',
    focus: 'timeline',
    fallbackRoute: '/craftsman/korrekturen',
  },
  // ── Spatial deep-links · Phase C · C-9 · provider-hub-spec §10.4 ──────────
  // The query (?tab= / ?author= / ?pin=) lives in `route`; the resolver splits
  // it off before the whitelist test (path-only match). `{workerId}`/`{pinId}`
  // are interpolated from the push `data` alongside `{jobId}`.
  spatial_worker_pins_added: {
    route: '/craftsman/jobs/{jobId}/spatial?tab=pins&author={workerId}',
    fallbackRoute: '/craftsman/korrekturen',
  },
  spatial_customer_pin_high: {
    route: '/craftsman/jobs/{jobId}/spatial?tab=pins&pin={pinId}',
    fallbackRoute: '/craftsman/korrekturen',
  },
  spatial_quote_deadline_soon: {
    route: '/craftsman/jobs/{jobId}/spatial?tab=bom',
    fallbackRoute: '/craftsman/korrekturen',
  },
  spatial_validator_warning: {
    route: '/craftsman/jobs/{jobId}/spatial',
    fallbackRoute: '/craftsman/korrekturen',
  },
  spatial_rescan_response: {
    route: '/craftsman/jobs/{jobId}/spatial?tab=rescan',
    fallbackRoute: '/craftsman/korrekturen',
  },
  // Customer push when a provider sends a spatial quote (C-10). The trigger
  // embeds `entityId = offer.id` (timeline_signals.entity_id → notification_
  // signals.entity_id → push payload data.entityId), the resolver
  // substitutes `{entityId}` here. Customer-facing only — fallback to the
  // projects list because /projects/{projectId} is not derivable from a
  // jobId-anchored timeline event in V1.
  offer_sent: {
    route: '/quotes/{entityId}',
    fallbackRoute: '/projects',
  },
  // Spatial Lane 3 V1.6 Block 3 — HW has flipped scans.shared_with_customer
  // for one of the customer's job scans. `entityId = scan.id` (HW Toggle UI
  // writes a timeline_signals row with entity_id when sharing). Deep links
  // straight into the read-only customer viewer.
  spatial_shared_with_customer: {
    route: '/customer/spatial/scan/{entityId}',
    fallbackRoute: '/customer/spatial/list',
  },
}

/**
 * Substituiert `{jobId}` (immer) sowie `{workerId}` / `{pinId}` (wenn im
 * `data` vorhanden) in einer Route-Vorlage. Pure, keine Side-Effects.
 *
 * String-Replace statt Template-Engine: jeder Token wird höchstens einmal
 * ersetzt; ein nicht gesetzter optionaler Token bleibt als `{token}` stehen
 * NUR wenn die Vorlage ihn enthält — die spatialen Vorlagen liefern den Wert
 * stets mit, alle anderen Vorlagen tragen die Tokens gar nicht.
 */
export function interpolateRoute(
  template: string,
  params: { jobId: string; workerId?: string; pinId?: string; entityId?: string },
): string {
  let route = template.replace('{jobId}', params.jobId)
  if (params.workerId) route = route.replace('{workerId}', params.workerId)
  if (params.pinId) route = route.replace('{pinId}', params.pinId)
  if (params.entityId) route = route.replace('{entityId}', params.entityId)
  return route
}

/**
 * Erweiterte Form von `PUSH_ROUTE_SCHEMA_VERSION` für Konsumenten, die nur
 * die Map-Datei importieren wollen — sparet einen extra Re-Export.
 */
export { PUSH_ROUTE_SCHEMA_VERSION }
