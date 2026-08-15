import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import AppShell from '../components/AppShell'
import WelcomeCodeSheet from '../components/team/WelcomeCodeSheet'
import { useSession } from '../hooks/useSession'
import { getMyCompanyJoinCode } from '../lib/company/joinCode'
import { sendCodeByEmail } from '../lib/company/codeRotation'

export default function CraftsmanOnboardingSuccessScreen() {
  const navigate = useNavigate()
  const { user } = useSession()
  const [joinCode, setJoinCode] = useState<string | null>(null)

  useEffect(() => {
    if (!user) return
    getMyCompanyJoinCode(user.id).then((result) => {
      if (result) setJoinCode(result.code)
    })
  }, [user])

  return (
    <AppShell hideBottomNav>
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[420px]">
          <div className="flex flex-col items-center text-center">
            <div className="h-16 w-16 rounded-[18px] bg-[#2563EB] shadow-[0_10px_30px_rgba(37,99,235,0.25)] flex items-center justify-center">
              <span className="text-[28px]">✅</span>
            </div>

            <h1 className="mt-4 text-[22px] font-semibold text-slate-900">
              Profil eingerichtet
            </h1>
            <p className="mt-2 text-[14px] leading-relaxed text-slate-500">
              Dein Betriebsprofil ist aktiv. Kunden können dich jetzt auf SaFix finden.
            </p>
          </div>

          <div className="mt-6 space-y-3">
            <div className="rounded-3xl bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_8px_24px_-16px_rgba(2,6,23,0.18)] flex items-start gap-3">
              <div className="h-8 w-8 rounded-xl bg-[#DCFCE7] flex items-center justify-center shrink-0">
                <span className="text-[16px]">🔍</span>
              </div>
              <div>
                <div className="text-[14px] font-semibold text-slate-900">Sichtbar für Kunden</div>
                <div className="mt-0.5 text-[13px] text-slate-500">
                  Dein Betrieb erscheint in der Suche und im Explore-Feed.
                </div>
              </div>
            </div>

            <div className="rounded-3xl bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_8px_24px_-16px_rgba(2,6,23,0.18)] flex items-start gap-3">
              <div className="h-8 w-8 rounded-xl bg-[#DCFCE7] flex items-center justify-center shrink-0">
                <span className="text-[16px]">📩</span>
              </div>
              <div>
                <div className="text-[14px] font-semibold text-slate-900">Anfragen empfangen</div>
                <div className="mt-0.5 text-[13px] text-slate-500">
                  Kunden können dir direkt Jobanfragen schicken.
                </div>
              </div>
            </div>

            <div className="rounded-3xl bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_8px_24px_-16px_rgba(2,6,23,0.18)] flex items-start gap-3">
              <div className="h-8 w-8 rounded-xl bg-[#DCFCE7] flex items-center justify-center shrink-0">
                <span className="text-[16px]">🏢</span>
              </div>
              <div>
                <div className="text-[14px] font-semibold text-slate-900">Backoffice bereit</div>
                <div className="mt-0.5 text-[13px] text-slate-500">
                  Verwalte Jobs, Finanzen, Kalender und dein Team im Dashboard.
                </div>
              </div>
            </div>

            {joinCode ? <WelcomeCodeSheet code={joinCode} onSendEmail={sendCodeByEmail} /> : null}
          </div>

          <button
            type="button"
            onClick={() => navigate('/craftsman/dashboard', { replace: true })}
            className="mt-6 w-full rounded-full bg-[#2563EB] py-3.5 text-[15px] font-semibold text-white shadow-[0_12px_28px_-18px_rgba(37,99,235,0.7)] transition"
          >
            Zum Dashboard
          </button>
        </div>
      </section>
    </AppShell>
  )
}
