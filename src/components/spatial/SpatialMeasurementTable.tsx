/**
 * Spatial Core · Block E3 · Measurement Table
 *
 * Read-only table of `ScanMeasurement` rows ordered by surface + label.
 * Highlights the estimated-vs-verified split per D5 (Source-of-Truth =
 * verified when present, otherwise estimated with a "~" prefix).
 *
 * Edit handlers live in Block F (BottomSheet numeric keypad). This
 * component surfaces a click callback so the parent can hand off into
 * that sheet when the user is in `craftsman` role.
 */

import type { ScanMeasurement } from '../../lib/spatial/types'

export interface SpatialMeasurementTableProps {
  measurements: ScanMeasurement[]
  isHydrated: boolean
  /** Triggered when the user taps a row — Block F opens the edit sheet. */
  onEdit?: (measurementId: string) => void
  /** Hide the edit affordance for customer / read-only surfaces. */
  editable?: boolean
}

export function SpatialMeasurementTable(props: SpatialMeasurementTableProps) {
  if (!props.isHydrated) {
    return (
      <div
        className="h-32 animate-pulse rounded-lg bg-neutral-100"
        aria-busy="true"
      />
    )
  }
  if (props.measurements.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-4 text-sm text-neutral-500">
        Noch keine Maße erfasst.
      </p>
    )
  }
  const editable = props.editable ?? false
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
      <table className="min-w-full text-sm">
        <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
          <tr>
            <th scope="col" className="px-3 py-2 text-left">
              Position
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Wert
            </th>
            <th scope="col" className="px-3 py-2 text-left">
              Status
            </th>
            {editable ? <th aria-label="Bearbeiten" /> : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {props.measurements.map(m => {
            const display = resolveMeasurementDisplay(m)
            return (
              <tr key={m.id}>
                <td className="px-3 py-2 text-neutral-900">
                  {m.label ?? 'Unbenannt'}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-neutral-900">
                  {display.valueText}
                  {display.manualOverride ? (
                    <span
                      className="ml-1 inline-flex items-center rounded-full bg-emerald-50 px-1.5 text-[10px] font-semibold text-emerald-700"
                      title="Manuell überschrieben — Re-Scan überschreibt diesen Wert nicht."
                    >
                      M✓
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-neutral-600">
                  <StatusBadge status={display.status} />
                </td>
                {editable ? (
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => props.onEdit?.(m.id)}
                      className="text-xs font-medium text-emerald-700 hover:text-emerald-900"
                    >
                      Bearbeiten
                    </button>
                  </td>
                ) : null}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

interface MeasurementDisplay {
  valueText: string
  status: 'estimated' | 'verified' | 'missing'
  /** Block F.7 — true when the verified value came from an operator override
   *  (manual entry through the BottomSheet keypad), not from a depth-checked
   *  auto-verify. Surfaces a small "M✓" badge that the craftsman can scan to
   *  remember which measurements they own personally. */
  manualOverride: boolean
}

function resolveMeasurementDisplay(m: ScanMeasurement): MeasurementDisplay {
  if (m.valueVerifiedM != null) {
    return {
      valueText: `${m.valueVerifiedM.toFixed(2)} m`,
      status: 'verified',
      manualOverride: m.verifiedBy != null && m.source === 'manual',
    }
  }
  if (m.valueEstimatedM != null) {
    return {
      valueText: `~ ${m.valueEstimatedM.toFixed(2)} m`,
      status: 'estimated',
      manualOverride: false,
    }
  }
  return { valueText: '—', status: 'missing', manualOverride: false }
}

function StatusBadge({ status }: { status: MeasurementDisplay['status'] }) {
  const map: Record<MeasurementDisplay['status'], { copy: string; className: string }> = {
    verified: {
      copy: 'verifiziert',
      className: 'bg-emerald-100 text-emerald-700',
    },
    estimated: {
      copy: 'geschätzt',
      className: 'bg-amber-100 text-amber-700',
    },
    missing: {
      copy: 'fehlend',
      className: 'bg-neutral-100 text-neutral-500',
    },
  }
  const entry = map[status]
  return (
    <span
      className={
        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ' +
        entry.className
      }
    >
      {entry.copy}
    </span>
  )
}
