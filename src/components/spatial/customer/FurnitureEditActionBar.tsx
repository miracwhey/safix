/**
 * Spatial · Customer · FurnitureEditActionBar (V1.6.1 Möbel-Place-Flow Phase 6)
 *
 * Schwebende Liquid-Glass-Aktionsleiste im Möbel-Bearbeiten-Modus (ersetzt die
 * Tool-Bar solange ein Möbel selektiert ist). Item-Chip oben (Name · Maß ·
 * Winkel) + Aktionen: Drehen (45°-Schritt) · Größe −/+ · Duplizieren · Löschen
 * (2-Tap-Confirm) · Fertig.
 *
 * Verschieben passiert per Boden-Tap (tap-to-move im Hub) bzw. später per
 * Finger-Drag — daher kein Move-Control hier. Die Buttons sind die robuste
 * Basis; Dreh-Dial / Pinch sind optionale Gesten-Upgrades.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'

export interface FurnitureEditActionBarProps {
  open: boolean
  /** Anzeigename des Objekts (z.B. "3-Sitzer-Sofa"). */
  name: string
  /** Footprint-Label inkl. aktueller Skalierung (z.B. "2,1 × 0,9 m"). */
  footprintLabel: string
  /** Aktuelle Y-Drehung in Grad [0,360). Weglassen → kein Winkel im Chip + kein
   *  Dreh-Button (z.B. Decken-Objekte, deren Y-Rotation nicht greift). */
  rotationDeg?: number
  /** Aktuelle Skalierung in Prozent (100 = Originalmaß). Weglassen → kein %-Chip. */
  scalePct?: number
  /** true wenn die Skalierung das Minimum/Maximum erreicht hat. */
  canScaleDown?: boolean
  canScaleUp?: boolean
  /** Persist-Hinweis ("Speichert…" / "Gespeichert"). */
  saveHint?: string
  /** Optionale Aktionen — fehlt ein Handler, wird der Button ausgeblendet (so
   *  teilt sich die Bar zwischen Boden-Möbeln (alle Aktionen) und Decken-
   *  Objekten (nur Löschen/Fertig, Verschieben per Drag)). */
  onRotate?: () => void
  onScaleDown?: () => void
  onScaleUp?: () => void
  onDuplicate?: () => void
  onDelete: () => void
  onDone: () => void
}

function ActionButton({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  children: ReactElement
}): ReactElement {
  // iOS-WebView feuert pro Touch `pointerup` UND einen synthetisierten `click`
  // → ohne Dedupe doppelt (Drehen 90° statt 45°, 2 Klone, Löschen skippt
  // Confirm). Pattern aus CustomerSpatialToolBar: pointerup führt aus + stempelt,
  // der nachfolgende click wird im 600ms-Fenster verworfen. Der Guard sitzt NUR
  // auf click — jeder physische Tap (auch der 2. Confirm-Tap) läuft über
  // pointerup zuverlässig durch.
  const lastTouchHandledAt = useRef(0)
  return (
    <button
      type="button"
      onClick={() => {
        if (performance.now() - lastTouchHandledAt.current < 600) return
        onClick()
      }}
      onPointerUp={(e) => {
        if (e.pointerType === 'mouse') return
        lastTouchHandledAt.current = performance.now()
        onClick()
      }}
      disabled={disabled}
      aria-label={label}
      className={[
        'flex h-[52px] min-w-[52px] flex-col items-center justify-center gap-1 rounded-2xl px-3',
        'text-[10px] font-semibold transition active:scale-[0.94] disabled:opacity-35',
        danger ? 'text-[#ffb3bf]' : 'text-white/75',
        'bg-white/[0.08] hover:bg-white/[0.14]',
      ].join(' ')}
    >
      {children}
      <span className="leading-none">{label}</span>
    </button>
  )
}

export function FurnitureEditActionBar({
  open,
  name,
  footprintLabel,
  rotationDeg,
  scalePct,
  canScaleDown,
  canScaleUp,
  saveHint,
  onRotate,
  onScaleDown,
  onScaleUp,
  onDuplicate,
  onDelete,
  onDone,
}: FurnitureEditActionBarProps): ReactElement | null {
  const [confirmDelete, setConfirmDelete] = useState(false)
  // Eigenes Dedupe-Fenster für den (inline) Fertig-Button — siehe ActionButton.
  const lastDoneTouchAt = useRef(0)
  // a11y: Fokus auf die Aktionsleiste wenn sie erscheint (Selektion), sodass
  // VoiceOver im Edit-Kontext landet statt im Canvas-Nichts.
  const barRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) barRef.current?.focus()
  }, [open])

  if (!open) return null

  const handleDelete = () => {
    if (confirmDelete) {
      onDelete()
      setConfirmDelete(false)
      return
    }
    setConfirmDelete(true)
    // Auto-reset the confirm after 3s so it never sticks.
    window.setTimeout(() => setConfirmDelete(false), 3000)
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[55] flex flex-col items-center gap-2 px-3 pb-[calc(env(safe-area-inset-bottom,0px)+18px)]">
      {/* a11y: Live-Region kündigt Save-Status + Lösch-Confirm für Screenreader
          an (die visuellen Label-Wechsel allein werden von VoiceOver nicht
          re-announced). */}
      <span aria-live="polite" className="sr-only">
        {confirmDelete ? 'Zum Löschen erneut tippen, um zu bestätigen' : (saveHint ?? '')}
      </span>
      {/* Item chip */}
      <div
        className="pointer-events-auto inline-flex items-center gap-2 rounded-2xl px-3.5 py-2 text-[13px] font-semibold text-white"
        style={{
          background: 'rgba(15,21,37,0.82)',
          backdropFilter: 'blur(20px) saturate(180%)',
          WebkitBackdropFilter: 'blur(20px) saturate(180%)',
          border: '1px solid rgba(255,255,255,0.14)',
        }}
      >
        {name}
        <span className="font-medium text-white/55">
          {` · ${footprintLabel}${rotationDeg != null ? ` · ${Math.round(rotationDeg)}°` : ''}${
            scalePct != null && scalePct !== 100 ? ` · ${scalePct}%` : ''
          }`}
        </span>
        {saveHint && <span className="font-medium text-emerald-300/80">· {saveHint}</span>}
      </div>

      {/* Action bar */}
      <div
        ref={barRef}
        tabIndex={-1}
        role="toolbar"
        aria-label="Objekt bearbeiten"
        className="pointer-events-auto flex items-center gap-1.5 rounded-[22px] p-2 outline-none"
        style={{
          background: 'rgba(15,21,37,0.8)',
          backdropFilter: 'blur(28px) saturate(200%)',
          WebkitBackdropFilter: 'blur(28px) saturate(200%)',
          border: '1px solid rgba(255,255,255,0.14)',
          boxShadow: '0 16px 40px rgba(0,0,0,0.5)',
        }}
      >
        {onRotate && (
          <ActionButton label="Drehen" onClick={onRotate}>
            <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" />
            </svg>
          </ActionButton>
        )}
        {onScaleDown && onScaleUp && (
          <>
            <ActionButton label="Kleiner" onClick={onScaleDown} disabled={!canScaleDown}>
              <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M5 12h14" />
              </svg>
            </ActionButton>
            <ActionButton label="Größer" onClick={onScaleUp} disabled={!canScaleUp}>
              <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 5v14M5 12h14" />
              </svg>
            </ActionButton>
          </>
        )}
        {onDuplicate && (
          <ActionButton label="Duplizieren" onClick={onDuplicate}>
            <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15V5a2 2 0 0 1 2-2h10" />
            </svg>
          </ActionButton>
        )}
        <ActionButton label={confirmDelete ? 'Sicher?' : 'Löschen'} onClick={handleDelete} danger>
          <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
          </svg>
        </ActionButton>
        {/* „Abwählen" (X, neutral) — hebt NUR die Objekt-Selektion auf, der
            Einrichten-Modus bleibt. Bewusst visuell verschieden vom blauen
            „Fertig"-Toggle oben links (der den ganzen Edit-Modus verlässt): Wort,
            Icon und Farbe trennen die zwei Ebenen, damit kein „welches Fertig?". */}
        <button
          type="button"
          onClick={() => {
            if (performance.now() - lastDoneTouchAt.current < 600) return
            onDone()
          }}
          onPointerUp={(e) => {
            if (e.pointerType === 'mouse') return
            lastDoneTouchAt.current = performance.now()
            onDone()
          }}
          aria-label="Auswahl aufheben"
          className="flex h-[52px] items-center justify-center gap-1.5 rounded-2xl bg-white/[0.10] px-4 text-[13px] font-bold text-white/90 transition active:scale-[0.96] hover:bg-white/[0.16]"
          style={{ border: '1px solid rgba(255,255,255,0.16)' }}
        >
          <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
          Abwählen
        </button>
      </div>
    </div>
  )
}
