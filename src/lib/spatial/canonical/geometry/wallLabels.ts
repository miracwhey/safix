/**
 * Spatial · Canonical · Wall Labels (Customer UX · R12.5)
 *
 * Pro Scan-Walls Cardinal-Labels berechnen ("Nord", "Süd 1", "Süd 2", …)
 * statt UUID-Strings in der Customer-UI zu zeigen. Algorithmus:
 *
 *   1. Pro Wand outward-Normal = right-hand-perp von (end - start).
 *      Gleicher Pattern wie WallAdapter.useFrame (sin(angle), -cos(angle))
 *      — siehe `adapters/WallAdapter.tsx:108`.
 *   2. Dominante Komponente bestimmt cardinal:
 *      - |nz| ≥ |nx| und nz > 0 → Nord (+Z)
 *      - |nz| ≥ |nx| und nz < 0 → Süd  (-Z)
 *      - sonst nx > 0           → Ost  (+X)
 *      - sonst                   → West (-X)
 *      (Convention: +Z = north im Floorplan, gleich wie 3D-Floorplan-Render.)
 *   3. Pro Cardinal-Direction sortieren nach orthogonaler Position
 *      (Nord/Süd → x ascending = westmost first; Ost/West → z ascending =
 *      northmost first). Durchnummerieren ab 1.
 *   4. Wenn nur eine Wand pro Direction existiert, weglassen der Nummer.
 *
 * Reines TS, kein three.js — unit-testbar mit synthetischen Wall-Literals.
 */

export type CardinalDirection = 'Nord' | 'Süd' | 'Ost' | 'West'

/** Minimal-Shape — die Algorithmus braucht nur diese Felder. */
export interface WallLabelInput {
  id: string
  start_point: { x: number; z: number }
  end_point: { x: number; z: number }
}

export interface WallLabel {
  cardinal: CardinalDirection
  /** Index within the cardinal group, 1-based. */
  index: number
  /** Display string. e.g. "Nord", "Süd 2". */
  label: string
}

function wallCardinal(wall: WallLabelInput): CardinalDirection {
  const dx = wall.end_point.x - wall.start_point.x
  const dz = wall.end_point.z - wall.start_point.z
  // Outward normal: right-hand perpendicular of (end - start), normalized
  // by length implicit. Sign matters, not magnitude.
  const nx = dz
  const nz = -dx
  if (Math.abs(nz) >= Math.abs(nx)) {
    return nz > 0 ? 'Nord' : 'Süd'
  }
  return nx > 0 ? 'Ost' : 'West'
}

/**
 * Sortier-Schlüssel pro Wand für Numerierung innerhalb einer Cardinal-Gruppe.
 * Nord/Süd: westmost first (kleinerer x = 1). Ost/West: northmost first
 * (kleinerer z = 1, weil +Z = nord, also nord-most = größeres z … invertiert
 * über (-z) damit ascending = nord-most first).
 */
function sortKey(wall: WallLabelInput, cardinal: CardinalDirection): number {
  const cx = (wall.start_point.x + wall.end_point.x) / 2
  const cz = (wall.start_point.z + wall.end_point.z) / 2
  if (cardinal === 'Nord' || cardinal === 'Süd') return cx
  // Ost/West nach z DESC (nordmost first) → return -cz
  return -cz
}

/**
 * Build a Map wallId → WallLabel for the given wall list.
 *
 * Reihenfolge stabil: gleiche Wall-Konstellation → gleiches Label-Mapping.
 * Falls zwei Wände exakt denselben Sort-Key haben (kollinear), fällt der
 * Tie-Break auf die ID-Sortierung (lexikographisch).
 */
export function buildWallLabels(
  walls: ReadonlyArray<WallLabelInput>,
): Map<string, WallLabel> {
  const byCardinal: Record<CardinalDirection, Array<{ wall: WallLabelInput; key: number }>> = {
    Nord: [],
    Süd: [],
    Ost: [],
    West: [],
  }
  for (const wall of walls) {
    const cardinal = wallCardinal(wall)
    byCardinal[cardinal].push({ wall, key: sortKey(wall, cardinal) })
  }
  const result = new Map<string, WallLabel>()
  ;(Object.keys(byCardinal) as CardinalDirection[]).forEach((cardinal) => {
    const group = byCardinal[cardinal]
    group.sort((a, b) => a.key - b.key || a.wall.id.localeCompare(b.wall.id))
    const skipNumber = group.length === 1
    group.forEach(({ wall }, i) => {
      const index = i + 1
      const label = skipNumber ? cardinal : `${cardinal} ${index}`
      result.set(wall.id, { cardinal, index, label })
    })
  })
  return result
}
