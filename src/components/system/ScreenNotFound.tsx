import { Link } from 'react-router-dom'

type Props = {
  /** Explicit title — takes precedence over entity-derived title. */
  title?: string
  /** Explicit subtitle — takes precedence over entity-derived description. */
  subtitle?: string
  /** Entity name for auto-generated title/subtitle, e.g. "Projekt", "Auftrag". */
  entity?: string
  backTo?: string
  backLabel?: string
}

function deriveArticle(entity: string): string {
  if (entity === 'Chat' || entity === 'Auftrag') return 'Der'
  if (entity === 'Angebot' || entity === 'Projekt') return 'Das'
  return 'Der'
}

/**
 * Not-found state for corridor screens.
 *
 * Supports both explicit `title`/`subtitle` and shorthand `entity` prop.
 * Always provides a back-navigation link — never a dead end.
 *
 * Does NOT wrap in AppShell — the calling screen provides that.
 */
export default function ScreenNotFound({
  title,
  subtitle,
  entity,
  backTo = '/',
  backLabel = 'Zurück',
}: Props) {
  const resolvedTitle = title ?? (entity ? `${entity} nicht gefunden` : 'Nicht gefunden')
  const resolvedSubtitle = subtitle ?? (entity
    ? `${deriveArticle(entity)} gesuchte ${entity} existiert nicht oder wurde entfernt.`
    : 'Die angeforderte Seite konnte nicht gefunden werden.')

  return (
    <section className="px-4 py-6">
      <div className="mx-auto w-full max-w-[420px] space-y-4">
        <div className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
          <div className="text-[18px] font-semibold text-slate-900">
            {resolvedTitle}
          </div>
          <div className="mt-2 text-[14px] text-slate-500">{resolvedSubtitle}</div>
          <Link
            to={backTo}
            className="mt-4 inline-flex items-center rounded-full bg-slate-100 px-4 py-2 text-[14px] font-semibold text-slate-700 transition active:scale-[0.98]"
          >
            ← {backLabel}
          </Link>
        </div>
      </div>
    </section>
  )
}
