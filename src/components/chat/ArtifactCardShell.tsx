import {
  type ArtifactCardView,
  STATUS_TONE_CLASS,
  THEME,
  FOOTER_LABEL,
} from './artifactCardVocab'

/**
 * ArtifactCardShell — the ONE presentational shell for every artifact card in
 * the chat stream (V5 redesign 2026-06-23).
 *
 * Replaces the divergent looks of the previously-separate renderers
 * (ChatArtifactCardCompact, ProjectSendEventCard, QuoteSendEventCard,
 * ThreadArtifactFundingCard). All of them build an `ArtifactCardView` and render
 * through this shell, so the stream has ONE card shell, ONE status vocabulary,
 * ONE icon system, and ONE footer-action language.
 *
 * Visual contract (per chat-artifact-redesign-spec.md):
 *   • Header row: brand-tinted type label (+ optional badge) + status pill.
 *   • Body: brand icon tile + prominent line (title OR Betrag) + optional subtitle.
 *       - Zahlung / Nachtrag → the Betrag is prominent (negative delta → rose).
 *         Projekt / Angebot → the title is prominent, NO amount.
 *   • Footer: a labelled action ("Zahlung ansehen ›"). The WHOLE card is the tap
 *     target — the wrapper (Link / role=button) owns navigation; this shell is
 *     pure presentation (no router import, SSR-safe).
 *
 * Shared vocabulary / theme / formatting lives in `artifactCardVocab.ts`.
 */

/** Inline stroke glyphs — one consistent line-icon set (no emoji). */
function ArtifactGlyph({ iconKey }: { iconKey: string }): React.ReactElement {
  const common = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
  switch (iconKey) {
    case 'Project': // building
      return (
        <svg {...common}>
          <path d="M3 21h18" />
          <path d="M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16" />
          <path d="M10 8h0M14 8h0M10 12h0M14 12h0M10 16h4" />
        </svg>
      )
    case 'OfferPayment': // document
      return (
        <svg {...common}>
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
          <path d="M14 3v5h5" />
          <path d="M9 13h6M9 17h6" />
        </svg>
      )
    case 'FundingStep': // euro
      return (
        <svg {...common}>
          <path d="M4 10h11M4 14h9" />
          <path d="M18.5 6.2A7 7 0 0 0 13.5 4 7.5 7.5 0 0 0 6 12a7.5 7.5 0 0 0 7.5 8 7 7 0 0 0 5-2.2" />
        </svg>
      )
    case 'ChangeOrder': // pencil
      return (
        <svg {...common}>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
        </svg>
      )
    case 'Invoice': // receipt / invoice
      return (
        <svg {...common}>
          <path d="M6 3h12v18l-2-1.2-2 1.2-2-1.2-2 1.2-2-1.2-2 1.2z" />
          <path d="M9 8h6" />
          <path d="M9 11.5h5" />
        </svg>
      )
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
        </svg>
      )
  }
}

export interface ArtifactCardShellProps {
  view: ArtifactCardView
  /** Optional badge rendered after the type label (e.g. ★ Hauptprojekt). */
  badge?: React.ReactNode
  /** Test id for the card root. */
  testid?: string
}

/**
 * Pure presentational card. Interactivity (tap → navigate) is owned by the
 * wrapper (a Link or a role=button div) so this stays router-agnostic + SSR-safe.
 */
export function ArtifactCardShell({ view, badge, testid }: ArtifactCardShellProps): React.ReactElement {
  const theme = THEME[view.iconKey]
  const footerLabel = FOOTER_LABEL[view.iconKey] ?? 'Öffnen'
  const prominentClass = view.prominentKind === 'amount'
    ? `text-[19px] font-bold leading-tight tracking-tight ${view.amountNegative ? 'text-rose-600' : 'text-slate-900'}`
    : 'text-[15px] font-bold leading-tight text-slate-900'

  return (
    <div
      data-testid={testid}
      className="overflow-hidden rounded-[14px] bg-white ring-1 ring-slate-200/70 shadow-[0_4px_14px_-8px_rgba(2,6,23,0.10)]"
    >
      <div className="px-3.5 pt-3 pb-2.5">
        {/* Header row: type label (+ badge) + status pill */}
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-extrabold uppercase tracking-[0.08em] ${theme.label}`}>
            {view.typeLabel}
          </span>
          {badge}
          <span
            data-testid="artifact-card-status"
            className={[
              'ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide ring-1',
              STATUS_TONE_CLASS[view.statusTone],
            ].join(' ')}
          >
            {view.statusLabel}
          </span>
        </div>

        {/* Icon tile + prominent line + subtitle */}
        <div className="mt-2 flex items-center gap-3">
          <div
            className={['flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1', theme.iconBg, theme.icon].join(' ')}
          >
            <ArtifactGlyph iconKey={view.iconKey} />
          </div>
          <div className="min-w-0 flex-1">
            <p className={`truncate ${prominentClass}`}>{view.prominent}</p>
            {view.subtitle ? (
              <p className="mt-0.5 truncate text-[12.5px] text-slate-500">{view.subtitle}</p>
            ) : null}
          </div>
        </div>
      </div>

      {/* Footer action (labelled affordance; whole card is the tap target) */}
      <div className="flex items-center justify-between border-t border-slate-100 px-3.5 py-2.5">
        <span className={`text-[13px] font-semibold ${theme.label}`}>{footerLabel}</span>
        <span className={`text-[16px] leading-none ${theme.label}`} aria-hidden>
          ›
        </span>
      </div>
    </div>
  )
}
