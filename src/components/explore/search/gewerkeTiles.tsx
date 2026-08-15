/**
 * The six trade tiles shown in the search discovery ("Nach Gewerk stöbern") and
 * empty states. Icon path strings are taken verbatim from the Claude-Design
 * mock (each tile's full path is split on " M" into discrete <path> segments).
 */

export type GewerkeTile = {
  /** Canonical trade key — also the label and the query injected on tap. */
  key: string
  /** Display label (identical to `key` for these six). */
  label: string
  /** Full SVG path string; multiple sub-paths are joined with " M". */
  iconPath: string
}

export const GEWERKE_TILES: GewerkeTile[] = [
  { key: 'Sanitär', label: 'Sanitär', iconPath: 'M7 3v6a3 3 0 0 0 6 0V3 M10 12v9 M7 21h6 M16 4l4 4-3 3-4-4z' },
  { key: 'Elektrik', label: 'Elektrik', iconPath: 'M13 2 4 14h7l-1 8 9-12h-7z' },
  { key: 'Fliesen', label: 'Fliesen', iconPath: 'M3 3h8v8H3z M13 3h8v8h-8z M3 13h8v8H3z M13 13h8v8h-8z' },
  { key: 'Maler', label: 'Maler', iconPath: 'M3 7h14V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1z M17 7v4H8 M11 11v4a2 2 0 0 0 2 2v3' },
  { key: 'Schreiner', label: 'Schreiner', iconPath: 'M4 5h16v5H4z M6 10v9 M18 10v9 M9 10v4h6v-4' },
  { key: 'Dach', label: 'Dach', iconPath: 'M3 12 12 4l9 8 M6 12v8h12v-8' },
]

/** Splits a tile `iconPath` back into the individual <path> `d` strings. */
export function splitIconPath(iconPath: string): string[] {
  return iconPath.split(' M').map((d, i) => (i === 0 ? d : `M${d}`))
}
