import type { Scan } from '../../../lib/spatial/types'

/**
 * Display-Name-Resolution für Scans im Customer-Room-Picker.
 *
 * `Scan` selbst trägt keine `metadata` (die liegt auf `spatial_scenes`, ein
 * separater Fetch). Für V1.6.1 reicht ein owner-bucket-Label mit Sequenz-
 * Suffix. Eine echte `scan_rooms`-Anbindung folgt in einer separaten Welle.
 *
 * Pure Funktion, deshalb in eigenem File: react-refresh erlaubt im Component-
 * File nur Component-Exports — der frühere `__testBuildRoomLabels`-Re-export
 * hat den Fast-Refresh-Lint gebrochen.
 */
export function buildRoomLabels(
  scans: ReadonlyArray<Scan>,
): Record<string, string> {
  const ownTotal = scans.filter(s => s.ownerType === 'customer').length
  const hwTotal = scans.filter(
    s => s.ownerType === 'craftsman' && s.sharedWithCustomer,
  ).length

  const ownSeq = new Map<string, number>()
  const hwSeq = new Map<string, number>()
  const labels: Record<string, string> = {}

  const sorted = [...scans].sort((a, b) => a.createdAt - b.createdAt)
  for (const scan of sorted) {
    if (scan.ownerType === 'customer') {
      const next = (ownSeq.get('own') ?? 0) + 1
      ownSeq.set('own', next)
      labels[scan.id] = ownTotal > 1 ? `Eigener Raum ${next}` : 'Eigener Raum'
    } else {
      const next = (hwSeq.get('hw') ?? 0) + 1
      hwSeq.set('hw', next)
      labels[scan.id] = hwTotal > 1 ? `Vom HW · Raum ${next}` : 'Vom HW'
    }
  }
  return labels
}
