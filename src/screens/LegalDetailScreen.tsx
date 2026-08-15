import { useParams } from 'react-router-dom'
import AppShell from '../components/AppShell'
import { LEGAL_CONTENT } from '../lib/legal/legalContent'
import { LEGAL_TITLES, isLegalSection } from '../lib/legal/legalSections'
import { useSmartBack } from '../hooks/useSmartBack'

/**
 * Full-screen detail for a single legal document. Mounted under
 * `/legal/:section` for the three known sections (`agb`, `datenschutz`,
 * `impressum`).
 *
 * Unknown sections fall back to the index `/legal` rather than 404 — keeps
 * shareable deep-links forgiving and avoids dead-ends inside Capacitor.
 */
export default function LegalDetailScreen() {
  const { section } = useParams<{ section: string }>()
  const goBack = useSmartBack('/legal')

  if (!isLegalSection(section)) {
    return (
      <AppShell hideBottomNav>
        <section className="px-4 py-6">
          <div className="mx-auto w-full max-w-[420px] space-y-4">
            <button
              type="button"
              onClick={goBack}
              className="text-[14px] font-medium text-blue-600"
            >
              ← Rechtliches
            </button>
            <h1 className="text-[20px] font-semibold text-slate-900">
              Dokument nicht gefunden
            </h1>
            <p className="text-[13px] text-slate-600">
              Bitte wähle ein Dokument aus der Übersicht.
            </p>
          </div>
        </section>
      </AppShell>
    )
  }

  const Content = LEGAL_CONTENT[section]
  const title = LEGAL_TITLES[section]

  return (
    <AppShell hideBottomNav>
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[420px] space-y-5">
          <button
            type="button"
            onClick={goBack}
            className="flex items-center gap-1 text-[14px] font-medium text-blue-600"
          >
            ← Rechtliches
          </button>

          <h1 className="text-[22px] font-semibold text-slate-900">{title}</h1>

          <div className="rounded-[24px] bg-white p-5 ring-1 ring-slate-200/70 shadow-sm">
            <Content />
          </div>

          <div className="h-4" />
        </div>
      </section>
    </AppShell>
  )
}
