/**
 * Spatial Core · Block F · Pin Annotation Workflow
 *
 * One-call helpers for the Pin-Editor flows. Wraps the repository so the
 * UI never has to compose multi-step writes itself:
 *
 *   * `createPinFromPlacement` — fresh `scan_annotations` row from a
 *     placement event (UV + surface id + optional world-XYZ cache).
 *   * `attachPinPhoto` — uploads via `tryUploadOrEnqueue` and writes
 *     `photoAssetId` back onto the annotation. Returns "queued" for
 *     offline-safe handling.
 *   * `attachPinVoiceMemo` — same shape as photo, but for an audio blob.
 *   * `updatePinNote` — note + status update through the repo.
 *
 * Each helper records an audit event via `recordScanEvent` so the
 * append-only scan_events table reflects the full pin lifecycle.
 */

import { getSpatialRepository } from '../repository/registry'
import { supabase } from '../../supabase'
import { stripImageExifIfPossible } from '../../media/preUploadPipeline'
import type {
  AnchorUv,
  AnchorWorldCache,
  CreateScanAnnotationInput,
  CustomerPinType,
  ScanAnnotation,
  ScanAnnotationKind,
  ScanAnnotationStatus,
} from '../types'

const BUCKET = 'project-scans'

export interface CreatePinFromPlacementInput {
  scanId: string
  userId: string
  kind: ScanAnnotationKind
  anchorUv: AnchorUv | null
  worldXyz?: { x: number; y: number; z: number } | null
  /** Optional 2D fallback when neither UV nor world-XYZ is meaningful. */
  anchor2d?: { svgX: number; svgY: number } | null
  note?: string | null
  gewerk?: string | null
  /** Lane 3 V1.6 Block 3 / Phase G: customer visibility for this pin. Omit to
   *  use the kind default (`defaultCustomerVisibleForKind`). */
  customerVisible?: boolean
  /** Lane 3 V1.6 Phase 1d: Customer structural classification (door / window /
   *  heating / electrical). `null` / omitted = HW-only pin (no customer
   *  typification). Orthogonal to `kind` — both can be set on the same row. */
  customerPinType?: CustomerPinType | null
}

export async function createPinFromPlacement(
  input: CreatePinFromPlacementInput,
): Promise<ScanAnnotation> {
  const repo = getSpatialRepository()
  const anchorWorldCache: AnchorWorldCache | null = input.worldXyz
    ? {
        gltf: input.worldXyz,
        computedAt: new Date().toISOString(),
      }
    : null
  const payload: CreateScanAnnotationInput = {
    scanId: input.scanId,
    kind: input.kind,
    anchorUv: input.anchorUv ?? null,
    anchorWorldCache,
    anchor2d: input.anchor2d ?? null,
    note: input.note ?? null,
    gewerk: input.gewerk ?? null,
    customerVisible: input.customerVisible,
    customerPinType: input.customerPinType ?? null,
  }
  const created = await repo.createScanAnnotation(payload)
  await repo.recordScanEvent(input.scanId, 'annotation_added', {
    annotationId: created.id,
    kind: created.kind,
    actor: input.userId,
    customer_visible: created.customerVisible,
    customer_pin_type: created.customerPinType,
  })
  return created
}

/**
 * Lane 3 V1.6 Phase 1d · Customer-typed pin from a SpatialViewer placement.
 *
 * Single entry point the Customer Hub (and any future deep-link / push-route)
 * uses to persist a `door`/`window`/`heating`/`electrical` pin. Defaults:
 *
 *   - `kind='note'`  — the HW-RBAC bucket that carries customer notes. The
 *     structural meaning lives in `customerPinType` (CHECK-constrained
 *     server-side). Both columns can be set on a single row.
 *   - `customerVisible=true` — customer-typed pins are inherently customer-
 *     visible. The HW always sees every pin on their own jobs via RLS.
 *
 * Keeping these defaults in one workflow function prevents drift if a second
 * caller is added (push-notification deep-link, share-link, etc.). The UI
 * never sets them inline.
 */
export interface CreateCustomerPinInput {
  scanId: string
  userId: string
  customerPinType: CustomerPinType
  placement: {
    surfaceExternalId: string
    uv: [number, number]
    worldXyz?: { x: number; y: number; z: number }
  }
  note?: string | null
}

export async function createCustomerPin(
  input: CreateCustomerPinInput,
): Promise<ScanAnnotation> {
  return createPinFromPlacement({
    scanId: input.scanId,
    userId: input.userId,
    kind: 'note',
    anchorUv: {
      surfaceExternalId: input.placement.surfaceExternalId,
      uv: input.placement.uv,
    },
    worldXyz: input.placement.worldXyz ?? null,
    note: input.note ?? null,
    customerVisible: true,
    customerPinType: input.customerPinType,
  })
}

/**
 * Lane 3 V1.6 Block 3 / Phase G — one-tap HW visibility toggle from the
 * pin list. Wraps `updateScanAnnotation` + writes an audit event so the
 * share-history of a pin is reconstructable.
 */
export async function setPinCustomerVisible(input: {
  scanId: string
  annotationId: string
  customerVisible: boolean
}): Promise<ScanAnnotation> {
  const repo = getSpatialRepository()
  const annotation = await repo.updateScanAnnotation(input.annotationId, {
    customerVisible: input.customerVisible,
  })
  await repo.recordScanEvent(input.scanId, 'annotation_added', {
    annotationId: input.annotationId,
    asset: 'visibility',
    customer_visible: input.customerVisible,
  })
  return annotation
}

export interface AttachPinAssetResult {
  /** Whether the upload completed online; offline retry is a V1.5 follow-up. */
  uploaded: boolean
  storagePath: string
}

export interface AttachPinPhotoInput {
  scanId: string
  annotationId: string
  userId: string
  file: File
}

export async function attachPinPhoto(input: AttachPinPhotoInput): Promise<{
  annotation: ScanAnnotation
  upload: AttachPinAssetResult
}> {
  // Strip EXIF/GPS before upload — pin photos are shot on the jobsite (inside
  // a customer's home), so the raw camera roll carries the address as GPS.
  // The full media pipeline is the wrong layer (it wires job/message entity
  // metadata), so we use the fail-open image-only strip helper directly.
  const safeFile = await stripImageExifIfPossible(input.file)
  const path = pinAssetPath({
    userId: input.userId,
    scanId: input.scanId,
    pinId: input.annotationId,
    kind: 'photo',
    file: safeFile,
  })
  // Direct Storage upload — pin annotation assets are scoped to the
  // project-scans bucket with the path discipline enforced by RLS
  // (Block A.1 storage policies).
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, safeFile, {
      cacheControl: '3600',
      upsert: false,
      contentType: safeFile.type || undefined,
    })
  if (error) {
    throw new Error(error.message)
  }
  const repo = getSpatialRepository()
  const annotation = await repo.updateScanAnnotation(input.annotationId, {
    photoAssetId: path,
  })
  await repo.recordScanEvent(input.scanId, 'annotation_added', {
    annotationId: input.annotationId,
    asset: 'photo',
    storage_path: path,
  })
  return { annotation, upload: { uploaded: true, storagePath: path } }
}

export interface AttachPinVoiceMemoInput {
  scanId: string
  annotationId: string
  userId: string
  file: File
  durationMs: number
}

export async function attachPinVoiceMemo(
  input: AttachPinVoiceMemoInput,
): Promise<{
  annotation: ScanAnnotation
  upload: AttachPinAssetResult
}> {
  const path = pinAssetPath({
    userId: input.userId,
    scanId: input.scanId,
    pinId: input.annotationId,
    kind: 'voice',
    file: input.file,
  })
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, input.file, {
      cacheControl: '3600',
      upsert: false,
      contentType: input.file.type || 'audio/mp4',
    })
  if (error) {
    throw new Error(error.message)
  }
  const repo = getSpatialRepository()
  // We store the voice asset on the annotation note metadata to keep the
  // schema lean — `photoAssetId` is reserved for photo; voice rides in the
  // free-form note prefix until V1.5 introduces a `voiceAssetPath` column.
  // Preserve any existing user-typed display portion so attaching a voice
  // memo does not silently wipe the prior note text.
  const { data: existing } = await supabase
    .from('scan_annotations')
    .select('note')
    .eq('id', input.annotationId)
    .maybeSingle()
  const existingDisplay = noteDisplayPortion((existing?.note ?? null) as string | null)
  const updatedNote = annotateNoteWithVoice(path, input.durationMs, existingDisplay || null)
  const annotation = await repo.updateScanAnnotation(input.annotationId, {
    note: updatedNote,
  })
  await repo.recordScanEvent(input.scanId, 'annotation_added', {
    annotationId: input.annotationId,
    asset: 'voice',
    storage_path: path,
    duration_ms: input.durationMs,
  })
  return { annotation, upload: { uploaded: true, storagePath: path } }
}

export interface UpdatePinNoteInput {
  scanId: string
  annotationId: string
  note: string | null
  status?: ScanAnnotationStatus
  gewerk?: string | null
  offerRelevant?: boolean
}

export async function updatePinNote(input: UpdatePinNoteInput): Promise<ScanAnnotation> {
  const repo = getSpatialRepository()
  const annotation = await repo.updateScanAnnotation(input.annotationId, {
    note: input.note,
    status: input.status,
    gewerk: input.gewerk,
    offerRelevant: input.offerRelevant,
  })
  await repo.recordScanEvent(input.scanId, 'annotation_added', {
    annotationId: input.annotationId,
    asset: 'note',
    note_length: input.note?.length ?? 0,
  })
  return annotation
}

/** Storage-path discipline matches Block A.1 RLS-validator
 *  (`{user}/{scan}/{kind}/{filename.ext}`); deviating breaks insert + read. */
function pinAssetPath(input: {
  userId: string
  scanId: string
  pinId: string
  kind: 'photo' | 'voice'
  file: File
}): string {
  const safeExt = (input.file.name.split('.').pop() ?? 'bin').replace(
    /[^a-z0-9]/gi,
    '',
  )
  const filename = `${input.pinId}_${Date.now()}.${safeExt}`
  return `${input.userId}/${input.scanId}/${input.kind}/${filename}`
}

const VOICE_NOTE_TAG = '[voice]'
const VOICE_NOTE_SEPARATOR = '\n'

/** Marker we drop into `annotation.note` so the timeline player can find
 *  the storage path back without a new schema column (V1.5 will add one).
 *  `displayNote` is the user-visible portion that survives edits; the
 *  marker line is always the first line so a one-line strip recovers it. */
export function annotateNoteWithVoice(
  storagePath: string,
  durationMs: number,
  displayNote?: string | null,
): string {
  const marker = `${VOICE_NOTE_TAG} ${storagePath} ${durationMs}`
  const trimmed = displayNote?.trim()
  return trimmed ? `${marker}${VOICE_NOTE_SEPARATOR}${trimmed}` : marker
}

export interface ExtractedVoiceMemo {
  storagePath: string
  durationMs: number
  /** Portion of the note after the marker line — the human-typed text. */
  displayNote: string
}

export function extractVoiceMemoFromNote(note: string | null): ExtractedVoiceMemo | null {
  if (!note) return null
  if (!note.startsWith(VOICE_NOTE_TAG)) return null
  const newlineIdx = note.indexOf(VOICE_NOTE_SEPARATOR)
  const markerLine = newlineIdx >= 0 ? note.slice(0, newlineIdx) : note
  const displayNote = newlineIdx >= 0 ? note.slice(newlineIdx + 1).trim() : ''
  const parts = markerLine.slice(VOICE_NOTE_TAG.length).trim().split(/\s+/)
  if (parts.length < 2) return null
  const durationMs = Number(parts[1])
  if (!Number.isFinite(durationMs)) return null
  return { storagePath: parts[0], durationMs, displayNote }
}

/** Returns the visible portion of a note for edit-fields. Strips any voice
 *  marker prefix; for plain notes, returns the note unchanged. */
export function noteDisplayPortion(note: string | null): string {
  if (!note) return ''
  const voice = extractVoiceMemoFromNote(note)
  if (voice) return voice.displayNote
  return note
}
