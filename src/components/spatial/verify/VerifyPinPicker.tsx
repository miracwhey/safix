/**
 * Spatial · Verify · VerifyPinPicker (Phase 3 · Block 3.6)
 *
 * The Stage-4 Pin-Type picker — a dark bottom-sheet card with a 2×2 grid of
 * the 4 customer pin kinds (Mockup 15 · Phone 4). Color-coded per the
 * Mockup-15 palette; the symbol is primary and the colour secondary so the
 * tiles stay distinguishable for colour-blind users (verify-flow-spec §7).
 *
 * Pure presentation — the selected type is owned by the parent stage.
 */

import type { ReactElement } from 'react'

/** A customer-settable pin kind — the 4-kind Stage-4 subset. */
export type VerifyPinKind = 'damage' | 'wish' | 'note' | 'photo'

interface PinTile {
  kind: VerifyPinKind
  symbol: string
  label: string
  hint: string
  /** Tailwind dot colour class for the tile glyph. */
  dotClass: string
}

/** The 4 picker tiles in their Mockup-15 grid order. */
const PIN_TILES: readonly PinTile[] = [
  { kind: 'damage', symbol: '▲', label: 'Schaden', hint: 'Schimmel · Riss · Wasser', dotClass: 'text-rose-400' },
  { kind: 'wish', symbol: '★', label: 'Wunsch', hint: 'Neue Dusche · Heizung weg', dotClass: 'text-green-400' },
  { kind: 'note', symbol: '●', label: 'Notiz', hint: 'Bleibt so · Kontext', dotClass: 'text-sky-400' },
  { kind: 'photo', symbol: '◆', label: 'Foto', hint: 'Foto an Stelle', dotClass: 'text-amber-400' },
]

export interface VerifyPinPickerProps {
  /** The currently armed pin kind — the next dropped pin uses this type. */
  selected: VerifyPinKind
  /** Change the armed pin kind. */
  onSelect: (kind: VerifyPinKind) => void
}

export function VerifyPinPicker({ selected, onSelect }: VerifyPinPickerProps): ReactElement {
  return (
    <div
      className="mb-3 rounded-[18px] bg-slate-900 p-4"
      data-testid="verify-pin-picker"
    >
      <p className="mb-3 text-[13px] font-bold text-white/85">
        Was hier markieren?
      </p>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Art der Markierung">
        {PIN_TILES.map((tile) => {
          const isActive = tile.kind === selected
          return (
            <button
              key={tile.kind}
              type="button"
              role="radio"
              aria-checked={isActive}
              onClick={() => onSelect(tile.kind)}
              data-testid={`verify-pin-tile-${tile.kind}`}
              className={[
                'rounded-[12px] border p-3 text-center transition active:scale-[0.98]',
                isActive
                  ? 'border-orange-500 bg-orange-500/15'
                  : 'border-white/[0.08] bg-white/[0.05]',
              ].join(' ')}
            >
              <div className={`mb-1 text-[20px] leading-none ${tile.dotClass}`} aria-hidden="true">
                {tile.symbol}
              </div>
              <div className="text-[11px] font-bold text-white">{tile.label}</div>
              <div className="mt-0.5 text-[9px] text-white/45">{tile.hint}</div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
