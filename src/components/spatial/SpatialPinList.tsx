/**
 * Spatial Core · Block E3 · Annotation / Pin List
 *
 * Side-panel list of `ScanAnnotation` rows. Kept as a separate component
 * because Block F's BottomSheet pin-editor opens *from* this list (tap →
 * sheet → save → list re-hydrates via the subscribe-realtime hook).
 *
 * Customer surfaces hide the gewerk + assignment metadata; craftsman
 * surfaces show everything.
 *
 * Lane 3 V1.6 Block 3 / Phase G:
 *  - HW surfaces render a per-row visibility toggle (eye / lock) and an
 *    optional filter ('all' | 'visible' | 'private').
 *  - Customer surfaces never see the toggle, never see private pins (RLS
 *    already filters those server-side — the prop hides the indicator).
 */

import type {
  ScanAnnotation,
  ScanAnnotationKind,
  ScanAnnotationStatus,
} from '../../lib/spatial/types'

export type PinVisibilityFilter = 'all' | 'visible' | 'private'

export interface SpatialPinListProps {
  annotations: ScanAnnotation[]
  isHydrated: boolean
  selectedId?: string | null
  onSelect?: (annotationId: string) => void
  /** Customer view hides gewerk + offer-relevant chip. */
  showWorkTrade?: boolean
  /** HW only — when set, renders an eye/lock toggle per row. */
  onToggleVisibility?: (annotationId: string, nextValue: boolean) => void
  /** HW only — client-side filter applied before render. */
  filter?: PinVisibilityFilter
  /** HW only — render the lock indicator beside the row title for private
   *  pins (so HW can scan the list and spot what is not shared). Customer
   *  surfaces should pass `false` or omit. */
  showVisibilityIndicator?: boolean
}

const KIND_LABEL: Record<ScanAnnotationKind, string> = {
  damage: 'Schaden',
  note: 'Notiz',
  photo: 'Foto',
  measurement_ref: 'Maßverweis',
  gewerk_marker: 'Gewerk',
}

const STATUS_LABEL: Record<ScanAnnotationStatus, string> = {
  open: 'offen',
  needs_photo: 'Foto fehlt',
  needs_measurement: 'Maß fehlt',
  offer_relevant: 'angebotsrelevant',
  included_in_offer: 'im Angebot',
  resolved: 'erledigt',
  dispute_relevant: 'streitrelevant',
}

const KIND_COLOR_DOT: Record<ScanAnnotationKind, string> = {
  damage: 'bg-rose-500',
  note: 'bg-amber-400',
  photo: 'bg-cyan-400',
  measurement_ref: 'bg-violet-400',
  gewerk_marker: 'bg-emerald-400',
}

function applyFilter(annotations: ScanAnnotation[], filter: PinVisibilityFilter): ScanAnnotation[] {
  if (filter === 'all') return annotations
  if (filter === 'visible') return annotations.filter(a => a.customerVisible)
  return annotations.filter(a => !a.customerVisible)
}

export function SpatialPinList(props: SpatialPinListProps) {
  if (!props.isHydrated) {
    return (
      <div
        className="h-32 animate-pulse rounded-lg bg-neutral-100"
        aria-busy="true"
      />
    )
  }
  const filter = props.filter ?? 'all'
  const filtered = applyFilter(props.annotations, filter)
  if (filtered.length === 0) {
    const empty =
      filter === 'visible'
        ? 'Keine für die Kundin sichtbaren Pins.'
        : filter === 'private'
          ? 'Keine privaten (nur Team) Pins.'
          : 'Noch keine Pins gesetzt.'
    return (
      <p className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-4 text-sm text-neutral-500">
        {empty}
      </p>
    )
  }
  const showWorkTrade = props.showWorkTrade ?? true
  const showIndicator = props.showVisibilityIndicator ?? !!props.onToggleVisibility
  return (
    <ul className="space-y-2">
      {filtered.map(a => {
        const selected = a.id === props.selectedId
        const isPrivate = !a.customerVisible
        return (
          <li key={a.id}>
            <div
              className={
                'flex items-stretch gap-2 rounded-lg border transition ' +
                (selected
                  ? 'border-emerald-300 bg-emerald-50'
                  : 'border-neutral-200 bg-white')
              }
            >
              <button
                type="button"
                onClick={() => props.onSelect?.(a.id)}
                className="flex flex-1 items-start gap-3 px-3 py-2 text-left hover:bg-neutral-50 rounded-l-lg"
                aria-pressed={selected}
              >
                <span
                  aria-hidden="true"
                  className={'mt-1 h-2.5 w-2.5 rounded-full ' + KIND_COLOR_DOT[a.kind]}
                />
                <span className="flex-1">
                  <span className="block text-sm font-medium text-neutral-900">
                    <span>{KIND_LABEL[a.kind]}</span>
                    {showIndicator && isPrivate ? (
                      <span
                        className="ml-1.5 inline-flex items-center rounded-full bg-neutral-900 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white"
                        title="Nur Team — Kundin sieht diesen Pin nicht"
                      >
                        <span aria-hidden="true">🔒</span>
                        <span className="ml-0.5">privat</span>
                      </span>
                    ) : null}
                    {a.note ? <span className="text-neutral-500"> — {a.note}</span> : null}
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500">
                    <span className="rounded-full bg-neutral-100 px-2 py-0.5">
                      {STATUS_LABEL[a.status]}
                    </span>
                    {showWorkTrade && a.gewerk ? (
                      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700">
                        {a.gewerk}
                      </span>
                    ) : null}
                    {showWorkTrade && a.offerRelevant ? (
                      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-700">
                        angebot
                      </span>
                    ) : null}
                  </span>
                </span>
              </button>
              {props.onToggleVisibility ? (
                <button
                  type="button"
                  onClick={() => props.onToggleVisibility?.(a.id, !a.customerVisible)}
                  aria-pressed={!a.customerVisible}
                  title={
                    a.customerVisible
                      ? 'Für Kundin sichtbar — tippen, um privat zu setzen'
                      : 'Privat — tippen, um für Kundin freizugeben'
                  }
                  className={
                    'flex w-12 shrink-0 items-center justify-center rounded-r-lg text-lg transition ' +
                    (a.customerVisible
                      ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                      : 'bg-neutral-900 text-white hover:bg-neutral-800')
                  }
                >
                  <span aria-hidden="true">{a.customerVisible ? '👁' : '🔒'}</span>
                  <span className="sr-only">
                    {a.customerVisible ? 'Sichtbarkeit aufheben' : 'Für Kundin freigeben'}
                  </span>
                </button>
              ) : null}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
