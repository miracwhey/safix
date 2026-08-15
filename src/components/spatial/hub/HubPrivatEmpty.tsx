/**
 * L2-C · Privat-Tab Empty-State.
 *
 * Lane-2.5 · Stream B expands the empty-state with two Manual-Start CTAs
 * — "Vorlage 2×2 m" and "Leerer Raum" — so the user can build an Aufmaß
 * without a LiDAR scan. The original LiDAR-Scan CTA stays primary; the
 * manual CTAs sit below it as secondary actions.
 *
 * Once L2-D (real iPad-LiDAR-Beispiel-Räume Bad/Küche/Wohn) lands, the
 * hero becomes the Beispiel-Raum-Picker (Mockup 01) — the three CTAs
 * remain as secondary affordances. The Beispiel-Raum-Picker is gated on
 * real asset availability, which is why the hero stays here for now.
 */

import { Box, PencilRuler, Plus, Square } from 'lucide-react'

export interface HubPrivatEmptyProps {
  onStartScan: () => void
  /** Lane-2.5 · Stream B — "Vorlage 2×2 m anlegen" CTA. */
  onStartTemplate: () => void
  /** Lane-2.5 · Stream B — "Leerer Raum" CTA. */
  onStartCanvas: () => void
  busy: boolean
  /** When `false` the device lacks LiDAR — block the SCAN CTA + explain. The
   *  Manual-Start CTAs stay enabled because they do not need a scanner. */
  lidarAvailable: boolean | null
  /** Spinner-state for the Manual-Start workflows (createEmptyRoomProject). */
  manualBusy?: boolean
}

export function HubPrivatEmpty({
  onStartScan,
  onStartTemplate,
  onStartCanvas,
  busy,
  lidarAvailable,
  manualBusy = false,
}: HubPrivatEmptyProps) {
  const noLidar = lidarAvailable === false
  return (
    <div className="flex flex-col px-5">
      <div className="mt-9 flex flex-col items-center text-center">
        <div className="mb-5 flex h-[132px] w-[132px] items-center justify-center rounded-[32px] border border-[#D4E0F7] bg-gradient-to-br from-[#EEF2FB] to-[#E0E9FB]">
          <Box size={58} className="text-brand" strokeWidth={1.6} />
        </div>
        <h2 className="text-[21px] font-bold tracking-tight text-ink">
          Eigenes Aufmaß starten
        </h2>
        <p className="mt-2 max-w-[300px] text-[13.5px] text-ink-sub">
          Im Privat-Bereich nimmst du Räume nur für dich auf — zum Üben oder als
          schnelle Notiz. Sobald ein Kunde dazu kommt, wandert das Aufmaß in
          „Anfragen".
        </p>
      </div>

      <div className="mt-6 space-y-2.5">
        <button
          type="button"
          onClick={onStartScan}
          disabled={busy || noLidar}
          className="flex w-full items-center justify-center gap-2 rounded-[13px] bg-brand py-3.5 text-[14.5px] font-bold text-white shadow-brand-glow disabled:opacity-50"
        >
          <Plus size={16} />
          {busy ? 'Starte Aufmaß …' : 'Aufmaß aufnehmen'}
        </button>

        {/* Lane-2.5 · Stream B · Manual-Start CTAs */}
        <button
          type="button"
          onClick={onStartTemplate}
          disabled={manualBusy}
          className="flex w-full items-center justify-center gap-2 rounded-[13px] border border-edge bg-surface py-3 text-[13.5px] font-semibold text-ink active:scale-[0.98] disabled:opacity-50"
        >
          <Square size={15} strokeWidth={1.8} />
          {manualBusy ? 'Lege an …' : 'Vorlage 2×2 m anlegen'}
        </button>
        <button
          type="button"
          onClick={onStartCanvas}
          disabled={manualBusy}
          className="flex w-full items-center justify-center gap-2 rounded-[13px] border border-edge bg-surface py-3 text-[13.5px] font-semibold text-ink active:scale-[0.98] disabled:opacity-50"
        >
          <PencilRuler size={15} strokeWidth={1.8} />
          {manualBusy ? 'Lege an …' : 'Leerer Raum'}
        </button>

        {noLidar && (
          <p className="text-center text-[11.5px] text-amber-700">
            Aufmaß-Scan benötigt iPad Pro / iPhone Pro mit LiDAR.
            <br />
            Vorlage + Leerer Raum funktionieren auf jedem Gerät.
          </p>
        )}
      </div>
    </div>
  )
}
