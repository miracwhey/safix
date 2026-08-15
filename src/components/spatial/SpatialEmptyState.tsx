/**
 * Spatial Core · Block G.5 · Empty-state for Detail Surfaces
 *
 * Surfaces a friendly empty-state when a job/project has no scan yet.
 * Hand-drawn-feel SVG illustration kept inline — keeps the chunk small
 * and avoids the static-asset round-trip (one less Storage fetch on
 * empty surfaces).
 *
 * The primary CTA is wired by the parent so the customer + craftsman
 * variants can route to different actions (customer: "Handwerker
 * fragen", craftsman: "Raum scannen").
 */

export interface SpatialEmptyStateProps {
  primaryCtaLabel?: string
  onPrimaryCta?: () => void
  /** Hide the CTA entirely — useful for the customer customer surface
   *  where there's no scan-trigger action. */
  hideCta?: boolean
}

export function SpatialEmptyState(props: SpatialEmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-neutral-300 bg-neutral-50 px-6 py-8 text-center">
      <CraftsmanIllustration />
      <h2 className="text-base font-semibold text-neutral-900">
        Noch kein 3D-Aufmaß
      </h2>
      <p className="max-w-sm text-sm text-neutral-600">
        Mit einem iPhone- oder iPad-LiDAR-Scan misst Du in 2 Minuten den Raum
        — alle Wände, Türen und Fenster werden automatisch erfasst.
      </p>
      {!props.hideCta && props.onPrimaryCta ? (
        <button
          type="button"
          onClick={props.onPrimaryCta}
          className="mt-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
        >
          {props.primaryCtaLabel ?? 'Raum scannen'}
        </button>
      ) : null}
    </div>
  )
}

function CraftsmanIllustration() {
  return (
    <svg
      viewBox="0 0 200 120"
      className="h-28 w-44"
      role="img"
      aria-label="Handwerker mit iPhone vor einer Baustelle"
    >
      {/* baseline */}
      <line
        x1="10"
        y1="105"
        x2="190"
        y2="105"
        stroke="#94a3b8"
        strokeWidth="1.4"
      />
      {/* building outline */}
      <path
        d="M120 105 V55 L155 35 L190 55 V105 Z"
        fill="#e2e8f0"
        stroke="#475569"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <rect x="135" y="68" width="14" height="20" fill="#94a3b8" />
      <rect x="158" y="68" width="14" height="20" fill="#94a3b8" />
      {/* craftsman silhouette */}
      <circle cx="55" cy="60" r="10" fill="#0f172a" />
      <path
        d="M40 105 L40 80 Q55 65 70 80 L70 105 Z"
        fill="#1e3a8a"
      />
      {/* phone in hand */}
      <rect
        x="72"
        y="78"
        width="12"
        height="20"
        rx="2"
        fill="#10b981"
        stroke="#065f46"
        strokeWidth="1.2"
      />
      {/* dotted scan arc */}
      <path
        d="M85 88 Q105 60 130 75"
        stroke="#10b981"
        strokeWidth="1.4"
        strokeDasharray="3 3"
        fill="none"
      />
    </svg>
  )
}
