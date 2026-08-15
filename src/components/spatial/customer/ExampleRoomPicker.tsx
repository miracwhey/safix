/**
 * Spatial · V1.6.1 · Customer Beispiel-Raum-Picker
 *
 * Renders the picker surface defined in Mockup 02 v3:
 *   - Hero card for the Bad-Beispiel (Empfohlen-Badge)
 *   - Two sub-cards (Küche · Wohnen)
 *   - Outline-icon plates instead of fake-3D previews
 *     (per feedback_mockup_wording_function_logic.md — never simulate an
 *     asset that isn't actually there). Every tile is built from the same
 *     `EXAMPLE_ROOMS_META` list so adding / re-ordering examples is a
 *     one-place change.
 *
 * The component is layer-pure: it takes the meta list + the tap handler and
 * dispatches a `kind`. The parent (route screen) owns navigation + persisted
 * "seen" state. No localStorage / network calls in here.
 */

import type { ReactElement } from 'react'

import {
  EXAMPLE_ROOMS_META,
  type ExampleRoomKind,
  type ExampleRoomMeta,
} from '../../../lib/spatial/canonical/presets/exampleRooms'

export interface ExampleRoomPickerProps {
  /** Fires when the customer taps a tile. */
  onPick: (kind: ExampleRoomKind) => void
  /**
   * Tile-kind that is currently new-to-this-customer. Renders a NEW dot in
   * the corner of every tile that has NOT been opened yet. Pass an empty
   * set when every example has been seen.
   */
  unseenKinds?: ReadonlySet<ExampleRoomKind>
}

export function ExampleRoomPicker({
  onPick,
  unseenKinds = EMPTY_UNSEEN,
}: ExampleRoomPickerProps): ReactElement {
  const [hero, ...rest] = EXAMPLE_ROOMS_META

  return (
    <section
      aria-label="Beispiel-Räume"
      data-testid="example-room-picker"
      className="flex flex-col gap-3"
    >
      {hero && (
        <HeroCard
          meta={hero}
          showNewDot={unseenKinds.has(hero.kind)}
          onPick={() => onPick(hero.kind)}
        />
      )}

      <div className="grid grid-cols-2 gap-3">
        {rest.map(meta => (
          <SubCard
            key={meta.kind}
            meta={meta}
            showNewDot={unseenKinds.has(meta.kind)}
            onPick={() => onPick(meta.kind)}
          />
        ))}
      </div>

      <p className="mt-1 text-center text-[11.5px] text-white/45">
        Alle Räume liegen lokal — kein Daten-Upload.
      </p>
    </section>
  )
}

const EMPTY_UNSEEN: ReadonlySet<ExampleRoomKind> = new Set()

// ──────────────────────────────────────────────────────────────────────────
//  Hero (Bad · Empfohlen)
// ──────────────────────────────────────────────────────────────────────────

interface CardProps {
  meta: ExampleRoomMeta
  showNewDot: boolean
  onPick: () => void
}

function HeroCard({ meta, showNewDot, onPick }: CardProps): ReactElement {
  return (
    <button
      type="button"
      data-testid={`example-room-tile-${meta.kind}`}
      onClick={onPick}
      aria-label={`${meta.title} öffnen`}
      className="relative flex h-[168px] overflow-hidden rounded-3xl border border-white/20 bg-white/10 text-left shadow-[0_20px_50px_rgba(0,0,0,0.36)] backdrop-blur-2xl backdrop-saturate-200 transition active:scale-[0.985] focus:outline-none focus:ring-2 focus:ring-sky-300/60"
    >
      {/* brand-tinted glow blob — matches Mockup 02 v3 hero pseudo-element */}
      <span
        aria-hidden
        className="pointer-events-none absolute right-[-10%] top-[20%] h-[200px] w-[200px] rounded-full"
        style={{
          background: 'radial-gradient(circle, rgba(37,99,235,0.36) 0%, transparent 70%)',
          filter: 'blur(24px)',
        }}
      />

      {/* outline icon plate — no fake-3D preview per feedback_mockup_wording_function_logic */}
      <span
        className="relative z-10 flex w-[140px] shrink-0 items-center justify-center border-r border-white/10 bg-gradient-to-br from-white/5 to-white/[0.02]"
        aria-hidden
      >
        <ExampleRoomIcon kind={meta.kind} size={56} />
      </span>

      <span className="relative z-10 flex flex-1 flex-col justify-center px-[18px] py-4 text-white">
        {meta.recommended && (
          <span className="absolute right-[14px] top-[14px] flex items-center gap-1.5 rounded-[9px] bg-brand/90 px-2 py-1.5 text-[9.5px] font-bold uppercase tracking-[0.08em] text-white shadow-brand-glow">
            <span aria-hidden>★</span>
            Empfohlen
          </span>
        )}
        <span className="mb-2 flex items-center gap-1.5 text-[9.5px] font-bold uppercase tracking-[0.1em] text-white/55">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-white/45" />
          {meta.tag}
        </span>
        <span className="mb-1.5 block text-[22px] font-bold leading-[1.1] tracking-tight">
          {meta.title}
        </span>
        <span className="mb-1.5 block text-[13px] leading-snug text-white/70">
          {meta.subtitle}
        </span>
        <span className="flex items-center gap-2 text-[12px] text-white/45">
          <span>{meta.hotspots} Hotspots</span>
          <span aria-hidden className="h-[3px] w-[3px] rounded-full bg-white/32" />
          <span>{meta.durationLabel}</span>
        </span>
      </span>

      {showNewDot && (
        <NewDot className="absolute left-3 top-3 z-20" label={`${meta.title} ist neu`} />
      )}
    </button>
  )
}

// ──────────────────────────────────────────────────────────────────────────
//  Sub-card (Küche · Wohnen)
// ──────────────────────────────────────────────────────────────────────────

function SubCard({ meta, showNewDot, onPick }: CardProps): ReactElement {
  return (
    <button
      type="button"
      data-testid={`example-room-tile-${meta.kind}`}
      onClick={onPick}
      aria-label={`${meta.title} öffnen`}
      className="relative flex min-h-[138px] flex-col gap-3 rounded-2xl border border-white/12 bg-white/[0.06] p-[14px] pt-4 text-left shadow-[0_8px_20px_rgba(0,0,0,0.22)] backdrop-blur-xl backdrop-saturate-150 transition active:scale-[0.97] focus:outline-none focus:ring-2 focus:ring-sky-300/60"
    >
      <span
        className="grid h-14 w-14 place-items-center rounded-2xl border border-white/10 bg-gradient-to-br from-white/10 to-white/[0.04]"
        aria-hidden
      >
        <ExampleRoomIcon kind={meta.kind} size={28} />
      </span>

      <span className="block text-white">
        <span className="mb-1 block text-[9px] font-bold uppercase tracking-[0.1em] text-white/45">
          {meta.tag}
        </span>
        <span className="mb-0.5 block text-[16px] font-bold leading-tight tracking-tight">
          {meta.title}
        </span>
        <span className="block text-[11.5px] leading-tight text-white/55">
          {meta.subtitle}
        </span>
      </span>

      {showNewDot && (
        <NewDot className="absolute right-2.5 top-2.5" label={`${meta.title} ist neu`} />
      )}
    </button>
  )
}

// ──────────────────────────────────────────────────────────────────────────
//  Outline-icon glyphs — drawn line-art per Mockup 02 v3, no fake-3D
// ──────────────────────────────────────────────────────────────────────────

interface IconProps {
  kind: ExampleRoomKind
  size: number
}

function ExampleRoomIcon({ kind, size }: IconProps): ReactElement {
  // Inline SVG keeps the icon style consistent (1.7 stroke, round caps + joins,
  // 92% white-ish stroke) without dragging an icon library into the picker.
  // Replace with a real `<RoomThumbnail>` later if/when we ship rendered
  // thumbnails — but never with an Emoji-gradient placeholder.
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="rgba(255,255,255,0.92)"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size}
      height={size}
      aria-hidden
      style={{ filter: 'drop-shadow(0 4px 12px rgba(0,0,0,0.4))' }}
      data-testid={`example-room-icon-${kind}`}
    >
      {kind === 'bath' && (
        <>
          <path d="M5 12V5a2 2 0 012-2h0a2 2 0 012 2v0" />
          <path d="M2 12h20" />
          <path d="M4 12v3a4 4 0 004 4h8a4 4 0 004-4v-3" />
          <path d="M6 19l-1 2M18 19l1 2" />
          <circle cx="7" cy="7" r="1.5" />
        </>
      )}
      {kind === 'kitchen' && (
        <>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.6" />
          <circle cx="15.5" cy="8.5" r="1.6" />
          <circle cx="8.5" cy="15.5" r="1.6" />
          <circle cx="15.5" cy="15.5" r="1.6" />
        </>
      )}
      {kind === 'living' && (
        <>
          <path d="M4 12V8a2 2 0 012-2h12a2 2 0 012 2v4" />
          <path d="M2 14a2 2 0 012-2h16a2 2 0 012 2v3H2v-3z" />
          <path d="M5 17v2M19 17v2" />
        </>
      )}
    </svg>
  )
}

function NewDot({ className, label }: { className?: string; label: string }): ReactElement {
  return (
    <span
      aria-label={label}
      data-testid="example-room-new-dot"
      className={`flex items-center gap-1 rounded-full bg-rose-500 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white shadow-[0_0_8px_rgba(244,63,94,0.6)] ${className ?? ''}`}
    >
      NEU
    </span>
  )
}

export default ExampleRoomPicker
