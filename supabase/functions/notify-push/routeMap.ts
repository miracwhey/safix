/**
 * Push-Route-Map (Edge-Function-Mirror) · Block 7.2 / B3
 *
 * Byte-identische Spiegelung von `src/lib/notifications/pushRouteMap.ts`.
 * Drift-Lock: `tests/notifications/pushRouteMapEdgeParity.test.ts`
 * importiert beide Dateien und vergleicht JSON-stringified Maps.
 *
 * Deno-Side-Pflege ist nötig, weil `supabase/functions/` ein eigener
 * TS-Tree ist und `src/`-Imports zur Build-Zeit nicht erreichbar sind.
 * Doppelte Pflege < cross-tree-Build-Hack.
 *
 * Pro neuem Notification-Event-Type:
 *   1. `src/lib/notifications/pushRouteMap.ts` aktualisieren
 *   2. Diese Datei spiegeln
 *   3. `npm test -- pushRouteMap` muss grün bleiben
 */

export const PUSH_ROUTE_SCHEMA_VERSION = 1

export interface PushRouteMapEntry {
  route: string
  focus?: string
  fallbackRoute: string
  /**
   * APNs-Category-Identifier — Edge-Function setzt es in `aps.category` damit
   * iOS Inline-Action-Buttons aus der `pushActionRegistry` rendert. Mirror
   * von src/lib/notifications/pushRouteMap.ts.
   */
  category?: string
}

export const PUSH_ROUTE_MAP: Readonly<Record<string, PushRouteMapEntry>> = {
  correction_created: {
    route: '/craftsman/jobs/{jobId}',
    focus: 'timeline',
    fallbackRoute: '/craftsman/korrekturen',
    category: 'CORRECTION_DECISION',
  },
  correction_rejected: {
    route: '/craftsman/korrekturen',
    fallbackRoute: '/craftsman/korrekturen',
  },
  correction_resolved: {
    route: '/craftsman/korrekturen',
    fallbackRoute: '/craftsman/korrekturen',
  },
  worker_marked_complete: {
    route: '/craftsman/jobs/{jobId}',
    focus: 'timeline',
    fallbackRoute: '/craftsman/korrekturen',
  },
  admin_confirmed_complete: {
    route: '/craftsman/jobs/{jobId}',
    focus: 'timeline',
    fallbackRoute: '/craftsman/korrekturen',
  },
  dispute_under_review: {
    route: '/craftsman/jobs/{jobId}',
    focus: 'dispute',
    fallbackRoute: '/craftsman/korrekturen',
  },
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
 * Liefert die APNs-Category für einen Notification-Type, falls registriert.
 * Block A · M1 — Edge-Function ruft das in `buildApnsPayload`, um
 * `aps.category` zu setzen, damit iOS Inline-Action-Buttons aus
 * `pushActionRegistry.PUSH_ACTION_CATEGORIES` rendert.
 */
export function getInlineActionCategoryForType(type: string): string | undefined {
  return PUSH_ROUTE_MAP[type]?.category
}

/**
 * Reichert `data` eines PushItems mit Routing-Feldern an, wenn der `type`
 * in der Map liegt. Pure: gleicher Input → gleicher Output. Lässt `data`
 * unverändert wenn type unbekannt oder jobId fehlt — Frontend droppt
 * solche Pushes mit reason `no_route`, was zu Default-Home (Capacitor-
 * Default) führt. Akzeptiert für MVP, weil das alte Verhalten ist.
 */
export function enrichPushDataWithRoute(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data || typeof data !== 'object') return data
  const type = typeof data.type === 'string' ? data.type : null
  const jobId = typeof data.jobId === 'string' ? data.jobId : null
  if (!type || !jobId) return data

  const entry = PUSH_ROUTE_MAP[type]
  if (!entry) return data

  // Spatial deep-links carry {workerId}/{pinId} tokens in the route query;
  // offer-sent carries {entityId} = offer.id. Non-tokenized types ignore all
  // optional fields.
  const workerId = typeof data.workerId === 'string' ? data.workerId : undefined
  const pinId = typeof data.pinId === 'string' ? data.pinId : undefined
  const entityId = typeof data.entityId === 'string' ? data.entityId : undefined

  return {
    ...data,
    route: interpolateRoute(entry.route, { jobId, workerId, pinId, entityId }),
    fallbackRoute: entry.fallbackRoute,
    actionVersion: PUSH_ROUTE_SCHEMA_VERSION,
    ...(entry.focus ? { focus: entry.focus } : {}),
  }
}
