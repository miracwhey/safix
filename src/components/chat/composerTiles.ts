/**
 * Composer v3 trigger-tile definitions (ADR D-9).
 *
 * Each persona gets a different tile-set, grouped into two sub-sections:
 *   • "Vorgänge"  — money-/project-flow handoffs to existing workflows
 *   • "Anhängen"  — media attachments (image / document)
 *
 * The Composer component is a pure picker — it never owns a workflow.
 * Tile callbacks resolve to the canonical existing workflows
 * (createOfferWorkflow with documentType, changeOrderWorkflow, etc.).
 */

import type { ChatRole } from '../../lib/chat'
import type { OfferDocumentType } from '../../lib/offers/types'

export type ComposerTileSection = 'workflow' | 'attachment'

export type ComposerTileKind =
  | { type: 'offer'; documentType: OfferDocumentType }
  | { type: 'change_order' }
  | { type: 'project_attach' }
  | { type: 'photo' }
  | { type: 'document' }
  | { type: 'video' }

export interface ComposerTile {
  id: string
  section: ComposerTileSection
  kind: ComposerTileKind
  label: string
  hint: string
  iconKey: ComposerIconKey
}

export type ComposerIconKey =
  | 'binding-offer'
  | 'estimate'
  | 'diagnosis'
  | 'change-order'
  | 'project'
  | 'photo'
  | 'document'
  | 'video'

const TILE_BINDING_OFFER: ComposerTile = {
  id: 'offer-binding',
  section: 'workflow',
  kind: { type: 'offer', documentType: 'binding_offer' },
  label: 'Verbindliches Angebot',
  hint: 'Festpreis, Kunde kann annehmen',
  iconKey: 'binding-offer',
}

const TILE_ESTIMATE: ComposerTile = {
  id: 'offer-estimate',
  section: 'workflow',
  kind: { type: 'offer', documentType: 'estimate' },
  label: 'Kostenvoranschlag',
  hint: 'Unverbindliche Schätzung',
  iconKey: 'estimate',
}

const TILE_DIAGNOSIS: ComposerTile = {
  id: 'offer-diagnosis',
  section: 'workflow',
  kind: { type: 'offer', documentType: 'diagnosis' },
  label: 'Diagnose',
  hint: 'Erstbesuch · Befundpauschale',
  iconKey: 'diagnosis',
}

const TILE_CHANGE_ORDER: ComposerTile = {
  id: 'change-order',
  section: 'workflow',
  kind: { type: 'change_order' },
  label: 'Nachtrag',
  hint: 'Zusätzliche Leistung berechnen',
  iconKey: 'change-order',
}

const TILE_PROJECT_ATTACH: ComposerTile = {
  id: 'project-attach',
  section: 'workflow',
  kind: { type: 'project_attach' },
  label: 'Projekt anhängen',
  hint: 'Mit bestehendem Projekt verknüpfen',
  iconKey: 'project',
}

const TILE_PHOTO: ComposerTile = {
  id: 'photo',
  section: 'attachment',
  kind: { type: 'photo' },
  label: 'Foto',
  hint: 'Aus Galerie oder Kamera',
  iconKey: 'photo',
}

const TILE_DOCUMENT: ComposerTile = {
  id: 'document',
  section: 'attachment',
  kind: { type: 'document' },
  label: 'Dokument',
  hint: 'PDF, Office, Bild',
  iconKey: 'document',
}

const TILE_VIDEO: ComposerTile = {
  id: 'video',
  section: 'attachment',
  kind: { type: 'video' },
  label: 'Video',
  hint: 'Aufnehmen oder aus Galerie',
  iconKey: 'video',
}

const CRAFTSMAN_TILES: ComposerTile[] = [
  TILE_BINDING_OFFER,
  TILE_ESTIMATE,
  TILE_DIAGNOSIS,
  TILE_CHANGE_ORDER,
  TILE_PHOTO,
  TILE_DOCUMENT,
  TILE_VIDEO,
]

const CUSTOMER_TILES: ComposerTile[] = [
  TILE_PROJECT_ATTACH,
  TILE_PHOTO,
  TILE_DOCUMENT,
  TILE_VIDEO,
]

const WORKER_TILES: ComposerTile[] = [TILE_PHOTO, TILE_DOCUMENT, TILE_VIDEO]

const OWNER_TILES: ComposerTile[] = CRAFTSMAN_TILES
const ADMIN_TILES: ComposerTile[] = CRAFTSMAN_TILES

// TODO Slice 2 — channelType-aware tile filter. Today the tile-set is
// pure-role: a craftsman in an internal channel (office/team/assignment)
// would still see Offer/Project tiles, which is wrong for those channels.
// Stage 3b uses ChatComposer only in `customer` channels (MessageThreadScreen);
// internal-channel screens (CraftsmanNachrichten/WorkerNachrichten) keep
// their inline composer. When ChatComposer ramps to internal channels, add
// composerTilesForContext(role, channelType) that filters workflow tiles.
// See: ~/.claude/plans/chat-architecture-block-d-deferred.md §2.
const TILES_FOR_ROLE: Record<ChatRole, ComposerTile[]> = {
  craftsman: CRAFTSMAN_TILES,
  customer: CUSTOMER_TILES,
  worker: WORKER_TILES,
  owner: OWNER_TILES,
  admin: ADMIN_TILES,
}

export function composerTilesFor(role: ChatRole): ComposerTile[] {
  return TILES_FOR_ROLE[role] ?? []
}

export interface ComposerTileSections {
  workflow: ComposerTile[]
  attachment: ComposerTile[]
}

export function groupComposerTiles(tiles: ComposerTile[]): ComposerTileSections {
  const workflow: ComposerTile[] = []
  const attachment: ComposerTile[] = []
  for (const t of tiles) {
    if (t.section === 'workflow') workflow.push(t)
    else attachment.push(t)
  }
  return { workflow, attachment }
}
