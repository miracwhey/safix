/**
 * Spatial Core · Block E3 · Quality-Engine Card
 *
 * Renders the latest Quality-Engine V1 report (Block C) for a scan:
 * coloured bucket badge, the underlying score, and a wrap-around list of
 * warnings translated into user-facing German copy.
 *
 * Pure presentation — fetch happens in `useScanQualityReport`. The card
 * keeps a `Re-Run`-CTA that re-invokes the engine; the row stays disabled
 * while the rerun is in-flight so a double-tap doesn't fire two RPCs.
 */

import type {
  ScanQualityBucket,
  ScanQualityReport,
  ScanQualityWarning,
} from '../../lib/spatial/types'

export interface SpatialQualityCardProps {
  report: ScanQualityReport | null
  isHydrated: boolean
  /** Provided by `useScanQualityReport().rerun`. */
  onRerun?: () => Promise<void> | void
  /** Hide the rerun action — Customer surface shouldn't trigger compute. */
  showRerun?: boolean
}

export function SpatialQualityCard(props: SpatialQualityCardProps) {
  if (!props.isHydrated) {
    return (
      <div
        className="flex h-24 animate-pulse items-center rounded-lg bg-neutral-100 px-4"
        aria-busy="true"
      />
    )
  }
  if (!props.report) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-4 text-sm text-neutral-500">
        Qualitätsanalyse läuft noch oder wurde nicht gestartet.
      </div>
    )
  }
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <BucketBadge bucket={props.report.bucket} />
          <p className="mt-2 text-sm text-neutral-600">
            Aufmaß-Qualität · {props.report.score}/100
          </p>
        </div>
        {props.showRerun !== false && props.onRerun ? (
          <button
            type="button"
            onClick={() => {
              void props.onRerun?.()
            }}
            className="rounded-md border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
          >
            Neu bewerten
          </button>
        ) : null}
      </div>
      {props.report.warnings.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {props.report.warnings.map(warning => (
            <li
              key={warning}
              className="flex items-start gap-2 text-sm text-amber-700"
            >
              <span aria-hidden="true">⚠</span>
              <span>{describeWarning(warning)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-neutral-500">
          Keine Auffälligkeiten — der Scan kann ohne Re-Scan weiterverwendet
          werden.
        </p>
      )}
    </div>
  )
}

const BUCKET_LABEL: Record<ScanQualityBucket, { copy: string; className: string }> = {
  excellent: {
    copy: 'Hervorragend',
    className: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  },
  good: {
    copy: 'Gut',
    className: 'bg-sky-100 text-sky-700 border-sky-200',
  },
  fair: {
    copy: 'Akzeptabel',
    className: 'bg-amber-100 text-amber-700 border-amber-200',
  },
  poor: {
    copy: 'Schwach – Re-Scan empfohlen',
    className: 'bg-rose-100 text-rose-700 border-rose-200',
  },
}

function BucketBadge({ bucket }: { bucket: ScanQualityBucket }) {
  const entry = BUCKET_LABEL[bucket]
  return (
    <span
      className={
        'inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ' +
        entry.className
      }
    >
      {entry.copy}
    </span>
  )
}

function describeWarning(warning: ScanQualityWarning): string {
  switch (warning) {
    case 'too_few_walls':
      return 'Weniger als drei Wände erkannt — Raum erneut scannen.'
    case 'area_implausible':
      return 'Berechnete Grundfläche wirkt unplausibel.'
    case 'ceiling_implausible':
      return 'Deckenhöhe scheint außerhalb des üblichen Bereichs.'
    case 'wall_coverage_low':
      return 'Wandabdeckung zu gering — bitte mehr Wandflächen mitschwenken.'
    case 'low_confidence':
      return 'LiDAR-Vertrauen niedrig — Beleuchtung oder Texturen verbessern.'
    case 'door_dimensions_unusual':
      return 'Türmaße weichen vom Standard ab — Maße bitte verifizieren.'
    case 'window_dimensions_unusual':
      return 'Fenstermaße weichen vom Standard ab — Maße bitte verifizieren.'
  }
}
