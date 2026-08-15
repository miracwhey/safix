import type { InvoiceKind, InvoiceStatus } from '../lib/invoices'

type Props = {
  status: InvoiceStatus
  /**
   * Block 7.1B4 — Belegart. Wenn gesetzt, wird der Badge an die Korrekturart
   * angepasst (Stornorechnung / Gutschrift). Wenn gleichzeitig
   * `cancelledByCorrection` true ist, surface „Storniert".
   */
  kind?: InvoiceKind
  /**
   * Block 7.1B4 — Originalrechnung wird durch eine existierende Stornorechnung
   * buchhalterisch nichtig. Engine-DB-Status bleibt erhalten — der Badge
   * surfaced den abgeleiteten Zustand für die UI.
   */
  cancelledByCorrection?: boolean
}

function getLabel(
  status: InvoiceStatus,
  kind: InvoiceKind | undefined,
  cancelledByCorrection: boolean,
) {
  if (kind === 'cancellation') return 'Stornorechnung'
  if (kind === 'credit_note') return 'Gutschrift'
  if (cancelledByCorrection) return 'Storniert'
  if (status === 'draft') return 'Entwurf'
  if (status === 'issued') return 'Ausgestellt'
  if (status === 'sent') return 'Versendet'
  if (status === 'paid') return 'Bezahlt'
  return 'Storniert'
}

function getClassName(
  status: InvoiceStatus,
  kind: InvoiceKind | undefined,
  cancelledByCorrection: boolean,
) {
  if (kind === 'cancellation' || cancelledByCorrection) {
    return 'bg-rose-50 text-rose-700'
  }
  if (kind === 'credit_note') {
    return 'bg-amber-50 text-amber-700'
  }
  if (status === 'draft') {
    return 'bg-slate-100 text-slate-700'
  }

  if (status === 'issued') {
    return 'bg-blue-50 text-blue-700'
  }

  if (status === 'sent') {
    return 'bg-amber-50 text-amber-700'
  }

  if (status === 'paid') {
    return 'bg-emerald-50 text-emerald-700'
  }

  return 'bg-rose-50 text-rose-700'
}

export default function InvoiceStatusBadge({
  status,
  kind,
  cancelledByCorrection = false,
}: Props) {
  return (
    <div
      className={[
        'inline-flex rounded-full px-3 py-1 text-[12px] font-semibold',
        getClassName(status, kind, cancelledByCorrection),
      ].join(' ')}
    >
      {getLabel(status, kind, cancelledByCorrection)}
    </div>
  )
}
