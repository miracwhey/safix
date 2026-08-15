/**
 * Spatial V1.6 · Phase 4 · ScanErrorRecoverySheet
 *
 * Three-state recovery sheet shown after a LiDAR scan fails or the user
 * cancels mid-capture. Mockup 12 binding
 * (`~/.claude/plans/mockups/spatial-v16-customer/12-error-recovery.html`).
 *
 * Variants (P4-3 binding):
 *   - `'cancelled'` — Orange. User-initiated stop. Two equal CTAs
 *     ("Nochmal scannen" · "Stattdessen selbst messen").
 *   - `'loop-fail'` — Orange. Technical fail (insufficient data, timeout,
 *     backgrounded). Three coaching bullets ("Geh langsam" · "Sorge für
 *     gute Beleuchtung" · "Umrunde komplett") + two CTAs ("Nochmal" ·
 *     "Mit Vorlage starten").
 *   - `'max-retries'` — Red. After 3 failed attempts. Primary CTA
 *     "Mit Vorlage messen", text-link "Trotzdem nochmal versuchen" so
 *     persistent users have an escape hatch.
 *
 * Wording-lock per Mockup 12 design note: "Unterbrochen" — never
 * "Fehler" / "Versagt" / "Crash". Tone is reassuring + actionable.
 *
 * Retry-counter is owned by the parent (Hub): per-session, ref-based,
 * resets on Hub unmount. The sheet only displays `attempt / 3`.
 */

import BottomSheet from '../../ui/BottomSheet'

export type ScanErrorRecoveryVariant = 'cancelled' | 'loop-fail' | 'max-retries'

export interface ScanErrorRecoverySheetProps {
  open: boolean
  variant: ScanErrorRecoveryVariant
  /** Current attempt counter (1-based). The sheet renders `n/3`. Capped at 3. */
  attempt: number
  /** Total budget — always 3 per P4-3. Surface for tests / future tweaks. */
  maxAttempts?: number
  onClose: () => void
  /** Primary "Nochmal scannen" / "Trotzdem nochmal versuchen" — fires LiDAR
   *  startScan again. Only present on `'cancelled'` and `'loop-fail'`;
   *  on `'max-retries'` it is the text-link below the primary CTA. */
  onRetry: () => void
  /** "Stattdessen selbst messen" / "Mit Vorlage starten" / "Mit Vorlage
   *  messen" — primary on `'max-retries'`. Routes the user to the preset
   *  picker (parent opens `CustomerNewRoomSheet`). */
  onSwitchToPreset: () => void
}

interface CopyBundle {
  stripeClass: string
  badgeClass: string
  headline: string
  body: string
  bullets?: string[]
  primary: { label: string; action: 'retry' | 'preset' }
  secondary?: { label: string; action: 'retry' | 'preset'; variant: 'button' | 'text' }
}

function copyFor(variant: ScanErrorRecoveryVariant): CopyBundle {
  switch (variant) {
    case 'cancelled':
      return {
        stripeClass: 'bg-amber-500',
        badgeClass:
          'border-amber-400/40 bg-amber-500/15 text-amber-200',
        headline: 'Scan unterbrochen',
        body: 'Du hast den Scan gestoppt. Möchtest du nochmal versuchen oder lieber selbst messen?',
        primary: { label: 'Nochmal scannen', action: 'retry' },
        secondary: { label: 'Stattdessen selbst messen', action: 'preset', variant: 'button' },
      }
    case 'loop-fail':
      return {
        stripeClass: 'bg-amber-500',
        badgeClass:
          'border-amber-400/40 bg-amber-500/15 text-amber-200',
        headline: 'Raum nicht ganz erfasst',
        body: 'Das iPhone konnte Anfangs- und Endpunkt nicht zusammenführen. Häufig hilft langsamer gehen und mehr Licht.',
        bullets: [
          'Geh langsam — gleichmäßige Bewegung hilft.',
          'Sorge für gute Beleuchtung in jedem Eck.',
          'Umrunde den Raum komplett, lass nichts aus.',
        ],
        primary: { label: 'Nochmal scannen', action: 'retry' },
        secondary: { label: 'Mit Vorlage starten', action: 'preset', variant: 'button' },
      }
    case 'max-retries':
      return {
        stripeClass: 'bg-rose-500',
        badgeClass:
          'border-rose-400/40 bg-rose-500/15 text-rose-200',
        headline: 'Klappt heute nicht',
        body: 'Nach 3 Versuchen konnten wir den Raum nicht erfassen. Wir empfehlen den Weg mit Vorlage — geht auf jedem Gerät.',
        primary: { label: 'Mit Vorlage messen', action: 'preset' },
        secondary: { label: 'Trotzdem nochmal versuchen', action: 'retry', variant: 'text' },
      }
  }
}

export default function ScanErrorRecoverySheet({
  open,
  variant,
  attempt,
  maxAttempts = 3,
  onClose,
  onRetry,
  onSwitchToPreset,
}: ScanErrorRecoverySheetProps) {
  const copy = copyFor(variant)
  const displayAttempt = Math.min(Math.max(attempt, 1), maxAttempts)

  const runAction = (action: 'retry' | 'preset') => {
    if (action === 'retry') onRetry()
    else onSwitchToPreset()
  }

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      maxWidth={460}
      className="!bg-slate-900/95 !text-white border border-white/10 backdrop-blur-2xl"
    >
      <div aria-labelledby="recovery-sheet-title">
        <div className="relative">
          <div className={`absolute -top-5 left-0 right-0 h-1 rounded-b ${copy.stripeClass}`} aria-hidden />
          <div className="flex items-center justify-between">
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest ${copy.badgeClass}`}
              data-testid="recovery-retry-badge"
            >
              Versuch <span>{displayAttempt}</span><span aria-hidden>/</span><span>{maxAttempts}</span>
            </span>
          </div>
          <h3
            id="recovery-sheet-title"
            className="mt-3 text-[19px] font-bold leading-tight text-white"
          >
            {copy.headline}
          </h3>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-white/70">
            {copy.body}
          </p>
        </div>

        {copy.bullets && (
          <ul className="mt-4 space-y-2.5 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
            {copy.bullets.map((b) => (
              <li
                key={b}
                className="flex items-start gap-2.5 text-[13px] leading-relaxed text-white/80"
              >
                <span
                  aria-hidden
                  className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-amber-400/25 text-amber-200"
                >
                  <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </span>
                <span>{b}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-5 flex flex-col gap-2.5">
          <button
            type="button"
            onClick={() => runAction(copy.primary.action)}
            className={`w-full rounded-2xl px-4 py-3.5 text-sm font-bold text-white shadow-lg transition focus:outline-none focus:ring-2 focus:ring-sky-300/60 ${
              variant === 'max-retries'
                ? 'bg-gradient-to-br from-emerald-500 to-emerald-600 shadow-emerald-900/40 hover:from-emerald-400 hover:to-emerald-500'
                : 'bg-gradient-to-br from-sky-500 to-blue-600 shadow-sky-900/40 hover:from-sky-400 hover:to-blue-500'
            }`}
            data-testid="recovery-primary-cta"
          >
            {copy.primary.label}
          </button>
          {copy.secondary && copy.secondary.variant === 'button' && (
            <button
              type="button"
              onClick={() => runAction(copy.secondary!.action)}
              className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-semibold text-white/80 transition hover:bg-white/[0.08]"
              data-testid="recovery-secondary-cta"
            >
              {copy.secondary.label}
            </button>
          )}
          {copy.secondary && copy.secondary.variant === 'text' && (
            <button
              type="button"
              onClick={() => runAction(copy.secondary!.action)}
              className="mx-auto rounded-full px-3 py-1.5 text-[12.5px] font-medium text-white/55 transition hover:text-white/80"
              data-testid="recovery-secondary-cta"
            >
              {copy.secondary.label}
            </button>
          )}
        </div>
      </div>
    </BottomSheet>
  )
}
