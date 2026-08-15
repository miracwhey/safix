/**
 * Spatial V1.6 · Phase 3 · CustomerReScanConfirmSheet
 *
 * Confirm-sheet that fires after the Customer taps the Re-Scan floating-pill
 * on `CustomerSpatialDetailScreen`. Mockup 11 State 2 binding
 * (`~/.claude/plans/mockups/spatial-v16-customer/11-rescan-confirm.html`).
 *
 * Wording-lock (binding per Mockup 11 design-note):
 *   - NEVER use "ersetzen", "überschreiben", "löschen", "verlieren".
 *   - ALWAYS frame the three outcomes as "bleibt erhalten", "wird aktiv",
 *     "umschaltbar".
 *
 * Primary CTA reads "Neuen Scan starten" — an action-verb, not "OK" / "Ja".
 */

import BottomSheet from '../../ui/BottomSheet'

export interface CustomerReScanConfirmSheetProps {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  /** True while the parent LiDAR pipeline is in-flight after confirm. The
   *  sheet stays open and the primary CTA shows a busy state until the
   *  caller closes the sheet on success. */
  busy?: boolean
}

export default function CustomerReScanConfirmSheet({
  open,
  onClose,
  onConfirm,
  busy = false,
}: CustomerReScanConfirmSheetProps) {
  return (
    <BottomSheet
      open={open}
      onClose={busy ? () => undefined : onClose}
      maxWidth={460}
      className="!bg-slate-900/95 !text-white border border-white/10 backdrop-blur-2xl"
    >
      <div aria-labelledby="rescan-confirm-title">
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-sky-400/35 bg-sky-500/20 text-sky-200"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 0115-6.7L21 8M21 3v5h-5M21 12a9 9 0 01-15 6.7L3 16M3 21v-5h5" />
            </svg>
          </span>
          <div className="flex-1">
            <h3 id="rescan-confirm-title" className="text-base font-bold text-white">
              Raum erneut scannen?
            </h3>
            <p className="mt-1 text-xs text-white/65">
              Dein aktueller Scan bleibt erhalten. Der neue wird der aktive.
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-white/55">
            Was passiert
          </div>
          <ul className="mt-2.5 space-y-3">
            <ConsequenceRow
              icon="check"
              headline={
                <>
                  Dein aktueller Scan <strong className="font-bold text-white">bleibt erhalten</strong>
                </>
              }
              body="Du kannst jederzeit dorthin zurück — nichts geht verloren."
            />
            <ConsequenceRow
              icon="new"
              headline={
                <>
                  Neuer Scan wird <em className="not-italic font-semibold text-white">der aktive</em>
                </>
              }
              body="In der App und beim Handwerker erscheint ab jetzt der neue Scan."
            />
            <ConsequenceRow
              icon="swap"
              headline="Du kannst zwischen beiden umschalten"
              body={'In „Mein 3D-Bereich“ tippst du den Scan, den du sehen willst.'}
            />
          </ul>
        </div>

        <div className="mt-3 flex items-start gap-2 rounded-2xl border border-amber-400/20 bg-amber-500/[0.08] px-3.5 py-2.5 text-[12px] text-amber-100/85">
          <span aria-hidden className="text-amber-300">💡</span>
          <p>
            <strong className="font-semibold text-amber-100">Tipp:</strong>{' '}
            Nur erneut scannen, wenn sich was geändert hat — z.B. nach Renovierung oder wenn Möbel umgestellt wurden.
          </p>
        </div>

        <div className="mt-4 flex flex-col gap-2.5">
          <button
            type="button"
            // Explicit guard alongside `disabled` — iOS WebView in some
            // gesture states still fires onClick on a disabled button
            // (touch-start/end split). Mirror the ReScanCta pattern.
            onClick={busy ? undefined : onConfirm}
            disabled={busy}
            aria-disabled={busy}
            aria-busy={busy}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-br from-sky-500 to-blue-600 px-4 py-3.5 text-sm font-bold text-white shadow-lg shadow-sky-900/40 transition hover:from-sky-400 hover:to-blue-500 focus:outline-none focus:ring-2 focus:ring-sky-300/60 disabled:cursor-not-allowed disabled:from-slate-600 disabled:to-slate-700"
          >
            {busy ? 'Wird gestartet…' : 'Neuen Scan starten'}
            {!busy && (
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                <path d="M9 6l6 6-6 6" />
              </svg>
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-semibold text-white/80 transition hover:bg-white/[0.08] disabled:opacity-40"
          >
            Abbrechen
          </button>
        </div>
      </div>
    </BottomSheet>
  )
}

function ConsequenceRow({
  icon,
  headline,
  body,
}: {
  icon: 'check' | 'new' | 'swap'
  headline: React.ReactNode
  body: string
}) {
  return (
    <li className="flex items-start gap-2.5">
      <span
        aria-hidden
        className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-[12px]"
        style={{
          background:
            icon === 'check'
              ? 'rgba(34,197,94,0.18)'
              : icon === 'new'
                ? 'rgba(96,165,250,0.18)'
                : 'rgba(244,114,182,0.18)',
          color:
            icon === 'check'
              ? '#86efac'
              : icon === 'new'
                ? '#93c5fd'
                : '#f9a8d4',
        }}
      >
        {icon === 'check' ? '✓' : icon === 'new' ? '🆕' : '🔁'}
      </span>
      <div className="flex-1">
        <div className="text-[13px] leading-tight text-white">{headline}</div>
        <div className="mt-0.5 text-[11.5px] leading-relaxed text-white/55">{body}</div>
      </div>
    </li>
  )
}
