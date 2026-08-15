/**
 * Spatial V1.6 · Phase 4 · MeasureWithRulerSheet
 *
 * One-time coaching sheet that appears when a customer picks a Preset
 * (Bad / Küche / Wohnzimmer / Schlafzimmer) for the first time and is
 * about to land on the manual measurement editor. Walks the user through
 * how to measure with a Zollstock so the stepper values mean something.
 *
 * Friction contract (P4-4 binding):
 *   - **Auto-skip** when the persisted flag is set — the sheet never
 *     re-renders for experienced customers.
 *   - **Skip-Button** always visible (never trap a returning user).
 *   - **"Verstanden, los geht's"** primary CTA persists the flag and
 *     hands control back to the caller via `onDone`.
 *
 * The caller (CustomerNewRoomSheet) renders this sheet **before** flipping
 * to the editor state. On `onDone` or `onSkip` the picker transitions to
 * the editor. Both paths set the flag so a Skip is not punished by a
 * re-show on the next preset tap.
 */

import { useEffect } from 'react'

import BottomSheet from '../../ui/BottomSheet'
import { useSpatialFirstRunFlag } from '../../../hooks/useSpatialFirstRunFlag'

export const MEASURE_RULER_STORAGE_KEY = 'spatial-customer-ruler-tip-seen-v1'

const STEPS = [
  {
    eyebrow: '1. Breite messen',
    body: 'Zollstock an der breitesten Stelle des Raums anlegen — von Wand zu Wand.',
  },
  {
    eyebrow: '2. Länge messen',
    body: 'Entlang der längsten Wand. Möbel zur Seite, falls sie im Weg sind.',
  },
  {
    eyebrow: '3. Höhe messen',
    body: 'Vom Boden bis zur Decke. Bei Schrägen den niedrigsten Punkt nehmen.',
  },
]

export interface MeasureWithRulerSheetProps {
  /** Whether the parent surface wants the sheet eligible to open. The hook
   *  still auto-skips via the persisted flag — `open={true}` + `seen=true`
   *  renders nothing AND fires `onDone()` on the next microtask so the
   *  caller can observe completion symmetrically. */
  open: boolean
  /** Informational callback fired after the sheet has persisted the flag
   *  on user-accept. The sheet owns its dismissal (renders null after
   *  markSeen flips local state); the caller does NOT need to flip
   *  visibility — pass a no-op if the editor is already rendered behind. */
  onDone: () => void
  /** Informational callback fired after the sheet has persisted the flag
   *  on user-skip / ESC / backdrop. Same self-dismissal contract as
   *  `onDone` — caller does NOT need to manage visibility. */
  onSkip: () => void
}

export default function MeasureWithRulerSheet({
  open,
  onDone,
  onSkip,
}: MeasureWithRulerSheetProps) {
  const { seen, markSeen } = useSpatialFirstRunFlag(MEASURE_RULER_STORAGE_KEY)

  // Auto-skip path — if the customer has already seen this sheet, never
  // mount it. The effect fires once `open` flips to true with the flag
  // already set; we hand control back immediately so the picker can
  // proceed to the editor without a render glitch.
  useEffect(() => {
    if (!open) return
    if (!seen) return
    let alive = true
    void Promise.resolve().then(() => {
      if (alive) onDone()
    })
    return () => {
      alive = false
    }
  }, [open, seen, onDone])

  const handleDone = () => {
    markSeen()
    onDone()
  }

  const handleSkip = () => {
    markSeen()
    onSkip()
  }

  // Render nothing when the flag is already set — the auto-skip effect
  // calls onDone() on its own. This keeps the sheet from flashing on
  // re-opens during the microtask between mount and effect-flush.
  if (!open || seen) return null

  return (
    <BottomSheet
      open={open}
      onClose={handleSkip}
      maxWidth={460}
      className="!bg-slate-900/95 !text-white border border-white/10 backdrop-blur-2xl"
    >
      <div aria-labelledby="ruler-tip-title">
        <div className="flex items-start justify-between">
          <div>
            <span className="text-[11px] font-semibold uppercase tracking-widest text-amber-300/80">
              Maße eingeben
            </span>
            <h3
              id="ruler-tip-title"
              className="mt-1 text-[19px] font-bold leading-tight text-white"
            >
              So misst du mit dem Zollstock
            </h3>
          </div>
          <button
            type="button"
            onClick={handleSkip}
            className="rounded-full px-2.5 py-1 text-[11px] font-semibold text-white/55 transition hover:bg-white/5 hover:text-white/80 focus:outline-none focus:ring-2 focus:ring-sky-400/60"
          >
            Überspringen
          </button>
        </div>

        <div
          className="mt-4 grid h-[140px] place-items-center overflow-hidden rounded-2xl border border-amber-400/20 bg-gradient-to-br from-amber-500/10 to-orange-600/5"
          aria-hidden
        >
          <svg viewBox="0 0 240 100" className="h-full w-auto">
            <rect x="20" y="40" width="200" height="22" rx="3" fill="#fbbf24" />
            {Array.from({ length: 11 }).map((_, i) => (
              <line
                key={i}
                x1={20 + i * 20}
                y1={40}
                x2={20 + i * 20}
                y2={i % 5 === 0 ? 55 : 50}
                stroke="#0f172a"
                strokeWidth="2"
              />
            ))}
            <text x="120" y="85" fill="#fcd34d" fontSize="11" fontWeight="bold" textAnchor="middle">
              Zollstock
            </text>
          </svg>
        </div>

        <ul className="mt-4 space-y-2.5 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
          {STEPS.map((s) => (
            <li key={s.eyebrow} className="flex flex-col">
              <span className="text-[10.5px] font-semibold uppercase tracking-wider text-amber-300/85">
                {s.eyebrow}
              </span>
              <span className="mt-0.5 text-[13px] leading-relaxed text-white/80">
                {s.body}
              </span>
            </li>
          ))}
        </ul>

        <p className="mt-3 text-[11.5px] leading-snug text-white/45">
          Du kannst die Maße im nächsten Schritt direkt anpassen — alle Werte sind editierbar.
        </p>

        <div className="mt-4 flex flex-col gap-2.5">
          <button
            type="button"
            onClick={handleDone}
            className="w-full rounded-2xl bg-gradient-to-br from-sky-500 to-blue-600 px-4 py-3.5 text-sm font-bold text-white shadow-lg shadow-sky-900/40 transition hover:from-sky-400 hover:to-blue-500 focus:outline-none focus:ring-2 focus:ring-sky-300/60"
          >
            Verstanden, los geht's
          </button>
        </div>
      </div>
    </BottomSheet>
  )
}
