/**
 * Three angled 3D paper-cards for the Pro subscription hero (A+ v5).
 * Positioned absolutely inside a 244px-tall container.
 * Pure decorative — aria-hidden.
 *
 * Layout (matches design A+ v5):
 *   Team card     — top-left,   rotate -3.5°, cream  rgb(239,233,220), z 2
 *   Finanz card   — top-right,  rotate +4.5°, lighter rgb(245,240,228), z 3
 *   Kalender      — bottom-full, rotate -1°,   cream                      , z 4
 */

const CARD_BASE_SHADOW = [
  'rgba(255,255,255,0.85) 0 1px 0 0 inset',
  'rgba(15,20,38,0.10) 0 1px 2px',
  'rgba(15,20,38,0.18) 0 12px 24px -10px',
  'rgba(15,20,38,0.20) 0 28px 40px -18px',
  'rgba(15,20,38,0.08) 0 0 0 0.5px',
].join(', ')

const SERIF =
  '"Instrument Serif", "Cormorant Garamond", Georgia, "Times New Roman", serif'
const MONO =
  '"SF Mono", ui-monospace, "Menlo", "Roboto Mono", monospace'

const CREAM = 'rgb(239,233,220)'
const CREAM_LIGHT = 'rgb(245,240,228)'
const INK = 'rgb(14,20,38)'
const SUB = 'rgb(90,97,120)'
const RED_BROWN = 'rgb(122,42,36)'
const ACCENT = 'rgb(31,70,200)'
const ACCENT_TINT = 'rgba(31,70,200,0.10)'

function TeamCard() {
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: '-2%',
        width: '54%',
        height: 124,
        padding: '11px 12px',
        background: CREAM,
        borderRadius: 8,
        boxShadow: CARD_BASE_SHADOW,
        transform: 'rotate(-3.5deg)',
        transformOrigin: 'center center',
        zIndex: 2,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <span style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 600, letterSpacing: '0.6px', textTransform: 'uppercase', color: SUB }}>
          Team
        </span>
        <span style={{ fontFamily: MONO, fontSize: 8.5, color: SUB, letterSpacing: '0.3px' }}>
          4 aktiv
        </span>
      </div>
      <div style={{ marginTop: 6, fontFamily: SERIF, fontSize: 16, lineHeight: 1.05, color: INK, letterSpacing: '-0.2px' }}>
        Mitarbeiter
      </div>
      <div style={{ fontFamily: SERIF, fontSize: 14, lineHeight: 1.05, color: INK, marginTop: 1, letterSpacing: '-0.2px' }}>
        Stunden & Schichten
      </div>
      <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 6 }}>
        <span style={{ fontSize: 9.5, color: SUB }}>Diese Woche</span>
        <span style={{ fontFamily: SERIF, fontSize: 14, fontWeight: 500, color: INK, letterSpacing: '-0.3px' }}>
          156 Std.
        </span>
      </div>
      <div style={{ marginTop: 4, fontFamily: MONO, fontSize: 7.5, fontWeight: 600, letterSpacing: '0.6px', textTransform: 'uppercase', color: RED_BROWN, display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ width: 4, height: 4, background: RED_BROWN }} aria-hidden />
        Schicht · 09:14
      </div>
    </div>
  )
}

function FinanzCard() {
  return (
    <div
      style={{
        position: 'absolute',
        top: 28,
        right: '-3%',
        width: '50%',
        height: 110,
        padding: '11px 13px',
        background: CREAM_LIGHT,
        borderRadius: 8,
        boxShadow: CARD_BASE_SHADOW,
        transform: 'rotate(4.5deg)',
        transformOrigin: 'center center',
        zIndex: 3,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <span style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 600, letterSpacing: '0.6px', textTransform: 'uppercase', color: SUB }}>
          Cockpit
        </span>
        <span style={{ fontFamily: MONO, fontSize: 8.5, color: SUB }}>Mai</span>
      </div>
      <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span
          style={{
            fontFamily: SERIF,
            fontSize: 28,
            lineHeight: 1,
            color: INK,
            letterSpacing: '-0.8px',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          38.4
        </span>
        <span style={{ fontFamily: SERIF, fontSize: 18, color: INK }}>k €</span>
      </div>
      <div style={{ marginTop: 4, fontSize: 9.5, color: SUB }}>
        Umsatz im Monat
      </div>
    </div>
  )
}

const ENTRIES = [
  { time: '09:00', title: 'Ortsbegehung Müller', badge: null },
  { time: '14:00', title: 'Abnahme Schmidt', badge: 'fix' },
  { time: '17:30', title: '+ 2 weitere Termine', badge: null, muted: true },
] as const

function KalenderCard() {
  return (
    <div
      style={{
        position: 'absolute',
        top: 150,
        left: '1%',
        right: '1%',
        height: 92,
        padding: '10px 14px',
        background: CREAM,
        borderRadius: 8,
        boxShadow: CARD_BASE_SHADOW,
        transform: 'rotate(-1deg)',
        transformOrigin: 'center center',
        zIndex: 4,
        display: 'flex',
        gap: 14,
        alignItems: 'stretch',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          paddingRight: 12,
          borderRight: '1px solid rgba(14,20,38,0.10)',
          minWidth: 36,
        }}
      >
        <span style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 600, letterSpacing: '0.6px', textTransform: 'uppercase', color: SUB }}>
          Mi
        </span>
        <span style={{ fontFamily: SERIF, fontSize: 26, lineHeight: 1, color: INK, marginTop: 2 }}>
          22
        </span>
        <span style={{ fontFamily: MONO, fontSize: 8, fontWeight: 600, letterSpacing: '0.6px', textTransform: 'uppercase', color: SUB, marginTop: 2 }}>
          Mai
        </span>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3 }}>
        {ENTRIES.map((e) => (
          <div
            key={e.time}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              opacity: 'muted' in e && e.muted ? 0.55 : 1,
            }}
          >
            <span style={{ fontFamily: MONO, fontSize: 9, color: SUB, fontVariantNumeric: 'tabular-nums', minWidth: 28 }}>
              {e.time}
            </span>
            <span style={{ fontSize: 10.5, fontWeight: 500, color: INK, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {e.title}
            </span>
            {e.badge && (
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 7.5,
                  fontWeight: 700,
                  letterSpacing: '0.6px',
                  textTransform: 'uppercase',
                  color: ACCENT,
                  background: ACCENT_TINT,
                  borderRadius: 3,
                  padding: '1px 4px',
                }}
              >
                {e.badge}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

export default function SubscriptionPreviewCards() {
  return (
    <div
      aria-hidden
      style={{ position: 'relative', width: '100%', height: 244 }}
    >
      <TeamCard />
      <FinanzCard />
      <KalenderCard />
    </div>
  )
}
