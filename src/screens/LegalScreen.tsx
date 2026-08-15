import { Link } from 'react-router-dom'
import AppShell from '../components/AppShell'
import { LEGAL_SECTIONS } from '../lib/legal/legalSections'
import { useSmartBack } from '../hooks/useSmartBack'

/**
 * Standalone index over the three legal documents. Acts as the destination
 * for the pre-login `target="_blank"` link in LoginScreen and as a fallback
 * landing for direct hits on `/legal`. Post-login the same three items are
 * surfaced via LegalSheet from ProfileActionsCard.
 */
export default function LegalScreen() {
  const goBack = useSmartBack('/profile')

  return (
    <AppShell hideBottomNav>
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[420px] space-y-5">
          <button
            type="button"
            onClick={goBack}
            className="flex items-center gap-1 text-[14px] font-medium text-blue-600"
          >
            ← Zurück
          </button>

          <h1 className="text-[22px] font-semibold text-slate-900">
            Rechtliches
          </h1>

          <div className="space-y-2">
            {LEGAL_SECTIONS.map((section) => (
              <Link
                key={section.id}
                to={`/legal/${section.id}`}
                className="flex items-center justify-between rounded-2xl bg-white px-4 py-4 text-left ring-1 ring-slate-200/70 transition active:scale-[0.98] hover:bg-slate-50"
              >
                <span className="text-[14px] font-semibold text-slate-900">
                  {section.title}
                </span>
                <span className="text-slate-400">›</span>
              </Link>
            ))}
          </div>

          <div className="h-4" />
        </div>
      </section>
    </AppShell>
  )
}
