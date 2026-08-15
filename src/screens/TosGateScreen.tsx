import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { acceptTos } from '../lib/profile'
import { refreshSession } from '../lib/session'
import { LEGAL_CONTENT } from '../lib/legal/legalContent'
import { TOS_GATE_SECTIONS, LEGAL_TITLES } from '../lib/legal/legalSections'

export default function TosGateScreen() {
  const navigate = useNavigate()
  const location = useLocation()
  const [accepted, setAccepted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleAccept = async () => {
    if (!accepted || loading) return
    setLoading(true)
    setError(null)
    try {
      await acceptTos()
      await refreshSession()
      // Preserve deep-link: the structural gate never changes the URL, so
      // location.pathname is the original destination. Fall back to /gate for
      // degenerate paths that have no content of their own.
      const returnTo = location.pathname === '/tos-gate' || location.pathname === '/login'
        ? '/gate'
        : location.pathname + location.search
      navigate(returnTo, { replace: true })
    } catch {
      setError('Akzeptanz konnte nicht gespeichert werden. Bitte versuche es erneut.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto w-full max-w-[440px] space-y-6">
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-[16px] bg-[#2563EB] shadow-[0_8px_24px_rgba(37,99,235,0.25)]">
            <span className="text-xl font-extrabold text-white">F</span>
          </div>
          <h1 className="text-[22px] font-semibold text-slate-900">Nutzungsbedingungen</h1>
          <p className="mt-1 text-[14px] text-slate-500">
            Bitte lies und akzeptiere unsere Bedingungen, um SaFix zu nutzen.
          </p>
        </div>

        <div className="max-h-[55dvh] overflow-y-auto rounded-[20px] bg-white p-5 ring-1 ring-slate-200/70 shadow-sm space-y-5 text-[13px] leading-relaxed text-slate-600">
          {TOS_GATE_SECTIONS.map((section) => {
            const Content = LEGAL_CONTENT[section.id]
            return (
              <div key={section.id}>
                <h2 className="text-[15px] font-semibold text-slate-900">
                  {LEGAL_TITLES[section.id]}
                </h2>
                <div className="mt-2">
                  <Content />
                </div>
              </div>
            )
          })}
        </div>

        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 accent-blue-600"
          />
          <span className="text-[13px] leading-relaxed text-slate-600">
            Ich habe die AGB, die Datenschutzerklärung und die Community-Richtlinien gelesen und akzeptiere sie verbindlich.
          </span>
        </label>

        {error && <p className="text-[12px] text-red-600">{error}</p>}

        <button
          onClick={() => void handleAccept()}
          disabled={!accepted || loading}
          className="w-full rounded-2xl bg-[#2563EB] px-4 py-3 text-[15px] font-semibold text-white disabled:opacity-50"
        >
          {loading ? 'Wird gespeichert...' : 'Akzeptieren und fortfahren'}
        </button>
      </div>
    </section>
  )
}
