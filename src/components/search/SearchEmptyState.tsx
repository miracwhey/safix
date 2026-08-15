/**
 * SearchEmptyState – contextual empty-state display for provider search.
 *
 * Shows a helpful message depending on *why* there are no results:
 *
 *   - `no_results`  – the data source returned zero providers at all.
 *   - `no_match`    – providers exist but none match the current filters.
 *   - `no_area`     – no providers found in the specified location/area.
 *
 * Design follows the existing Explore surface (white cards, slate palette,
 * Tailwind utility classes).
 */

type Variant = 'no_results' | 'no_match' | 'no_area'

type Props = {
  /** Controls the heading and body copy shown. */
  variant: Variant
  /** Optional location label to insert into the `no_area` message. */
  location?: string
}

const CONTENT: Record<Variant, { emoji: string; heading: string; body: string }> = {
  no_results: {
    emoji: '🔍',
    heading: 'Keine Handwerker gefunden',
    body: 'Aktuell sind noch keine Handwerker in SaFix registriert. Schau bald wieder vorbei – unser Netzwerk wächst täglich.',
  },
  no_match: {
    emoji: '😕',
    heading: 'Keine Treffer für deine Filter',
    body: 'Mit diesen Filtereinstellungen konnten wir keinen passenden Handwerker finden. Versuche es mit weniger Filtern oder einem anderen Suchbegriff.',
  },
  no_area: {
    emoji: '📍',
    heading: 'In diesem Bereich noch nicht verfügbar',
    body: '', // filled dynamically
  },
}

export default function SearchEmptyState({ variant, location }: Props) {
  const content = CONTENT[variant]

  const body =
    variant === 'no_area'
      ? `In ${location ? `„${location}"` : 'diesem Bereich'} haben wir noch keinen passenden Handwerker gefunden. Erweitere deinen Suchbereich oder entferne den Ortsfilter.`
      : content.body

  return (
    <div className="mx-auto w-full max-w-[420px]">
      <div className="rounded-[22px] bg-white px-5 py-6 ring-1 ring-slate-200/70 shadow-[0_16px_32px_-26px_rgba(2,6,23,0.18)]">
        {/* Emoji illustration */}
        <div className="mb-3 text-[40px] leading-none">{content.emoji}</div>

        {/* Heading */}
        <div className="text-[16px] font-semibold text-slate-900">{content.heading}</div>

        {/* Body copy */}
        <div className="mt-2 text-[14px] leading-relaxed text-slate-500">{body}</div>

        {/* Hint pills for no_match */}
        {variant === 'no_match' && (
          <div className="mt-4 flex flex-wrap gap-2">
            <span className="rounded-full bg-slate-100 px-3 py-1.5 text-[12px] font-medium text-slate-600">
              Weniger Filter
            </span>
            <span className="rounded-full bg-slate-100 px-3 py-1.5 text-[12px] font-medium text-slate-600">
              Anderen Ort versuchen
            </span>
            <span className="rounded-full bg-slate-100 px-3 py-1.5 text-[12px] font-medium text-slate-600">
              Andere Bewertung
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
