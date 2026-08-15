/**
 * Number formatter for Insta-Profile stat tiles.
 * 1234 → "1.2k", 12_345 → "12k", 1_200_000 → "1.2M".
 *
 * Lives separately from `InstaProfileHeader.tsx` so the React component
 * file stays component-only (`react-refresh/only-export-components`).
 */
export function formatStatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.0', '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace('.0', '')}k`
  return String(n)
}
