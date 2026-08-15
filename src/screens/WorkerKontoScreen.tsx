import { useState } from 'react'
import { ChevronRight, LogOut, Stethoscope, UserMinus } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import AppShell from '../components/AppShell'
import { useSession } from '../hooks/useSession'
import { useWorkerKonto } from '../hooks/useWorkerKonto'
import { useWorkerCorrections } from '../hooks/useCorrections'
import { leaveCompany } from '../lib/company/membership'
import type { KontoHeaderViewModel, KontoZeitübersichtViewModel } from '../lib/worker/workerKontoProjection'

// ── Header ────────────────────────────────────────────────────────────────────

function KontoHeader({ vm }: { vm: KontoHeaderViewModel }) {
  return (
    <div className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.22)]">
      <div className="flex items-center gap-4">
        {/* Avatar */}
        <div className="h-[52px] w-[52px] shrink-0 rounded-full bg-slate-900 flex items-center justify-center">
          <span className="text-[16px] font-bold tracking-tight text-white">
            {vm.initials}
          </span>
        </div>

        {/* Identity */}
        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-semibold text-slate-900 leading-tight truncate">
            {vm.displayName}
          </div>
          <div className="mt-0.5 flex items-center gap-2 flex-wrap">
            <span className="rounded-[6px] bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
              {vm.roleLabel}
            </span>
            {vm.companyName && (
              <span className="text-[11px] text-slate-400 truncate">
                {vm.companyName}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Email */}
      {vm.email && (
        <div className="mt-4 rounded-[14px] bg-slate-50 px-3.5 py-2.5 ring-1 ring-slate-100">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
            E-Mail
          </div>
          <div className="mt-0.5 text-[13px] text-slate-600 truncate">{vm.email}</div>
        </div>
      )}
    </div>
  )
}

// ── Arbeit: Zeitübersicht ─────────────────────────────────────────────────────

function ZeitübersichtCard({ vm }: { vm: KontoZeitübersichtViewModel }) {
  if (vm.isEmpty) {
    return (
      <div className="rounded-[24px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_14px_32px_-20px_rgba(2,6,23,0.22)]">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
          Zeitübersicht
        </div>
        <div className="mt-3 text-[13px] text-slate-400">
          Keine geplanten Einsätze diese Woche.
        </div>
        <div className="mt-1.5 text-[11px] text-slate-300">{vm.weekRange}</div>
      </div>
    )
  }

  return (
    <div className="rounded-[24px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_14px_32px_-20px_rgba(2,6,23,0.22)]">
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
          Zeitübersicht
        </div>
        <span className="rounded-[6px] bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-400 uppercase tracking-[0.10em]">
          geplant
        </span>
      </div>

      {/* Week hours — primary number */}
      <div className="mt-3.5 flex items-baseline justify-between">
        <div className="text-[22px] font-bold text-slate-900 tabular-nums">
          {vm.weekHoursLabel}{' '}
          <span className="text-[15px] font-semibold text-slate-400">Std.</span>
        </div>
        <div className="text-[12px] text-slate-400 tabular-nums">
          {vm.weekCount} {vm.weekCount === 1 ? 'Einsatz' : 'Einsätze'}
        </div>
      </div>

      <div className="mt-1.5 flex items-center justify-between">
        <div className="text-[11px] text-slate-400">{vm.weekRange}</div>
        <div className="text-[11px] font-medium text-slate-500 tabular-nums">
          Heute: {vm.todayHoursLabel} Std.
        </div>
      </div>
    </div>
  )
}

// ── Arbeit: Korrekturen ───────────────────────────────────────────────────────

function KorrekturenCard() {
  const navigate = useNavigate()
  const { requests } = useWorkerCorrections()

  const openCount = requests.filter((r) => r.status === 'open').length
  const inReviewCount = requests.filter((r) => r.status === 'in_review').length

  return (
    <button
      type="button"
      onClick={() => navigate('/worker/korrekturen')}
      className="w-full text-left rounded-[24px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_14px_32px_-20px_rgba(2,6,23,0.18)] active:bg-slate-50/60 transition-colors"
    >
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
          Korrekturen
        </div>
        <ChevronRight size={14} strokeWidth={2} className="text-slate-300" />
      </div>

      {requests.length === 0 ? (
        <div className="mt-3 text-[13px] text-slate-400">Keine Korrekturen eingereicht.</div>
      ) : (
        <div className="mt-3 flex items-center gap-3 flex-wrap">
          {openCount > 0 && (
            <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-600">
              {openCount} offen
            </span>
          )}
          {inReviewCount > 0 && (
            <span className="inline-flex items-center rounded-full bg-blue-50 px-2.5 py-0.5 text-[11px] font-semibold text-blue-600">
              {inReviewCount} in Prüfung
            </span>
          )}
          {openCount === 0 && inReviewCount === 0 && (
            <span className="text-[13px] text-slate-400">Alle erledigt.</span>
          )}
        </div>
      )}
    </button>
  )
}

// ── Arbeit: Krankmeldungen ────────────────────────────────────────────────────

function KrankmeldungenCard() {
  const navigate = useNavigate()
  return (
    <button
      type="button"
      onClick={() => navigate('/worker/konto/krankmeldungen')}
      className="w-full text-left rounded-[24px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_14px_32px_-20px_rgba(2,6,23,0.18)] active:bg-slate-50/60 transition-colors"
    >
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
          Krankmeldungen
        </div>
        <ChevronRight size={14} strokeWidth={2} className="text-slate-300" />
      </div>
      <div className="mt-3 flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-amber-50 text-amber-700">
          <Stethoscope className="h-4 w-4" />
        </div>
        <div className="text-[13px] text-slate-600">
          Verlauf ansehen oder Krankmeldung zurücknehmen
        </div>
      </div>
    </button>
  )
}

// ── Einstellungen ─────────────────────────────────────────────────────────────

function EinstellungenRow({
  icon,
  label,
  danger = false,
  onPress,
  disabled = false,
}: {
  icon: React.ReactNode
  label: string
  danger?: boolean
  onPress?: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      className="flex w-full items-center gap-3.5 py-3.5 active:bg-slate-50/60 transition-colors disabled:opacity-50"
    >
      <span className={danger ? 'text-red-400' : 'text-slate-400'}>{icon}</span>
      <span
        className={`flex-1 text-left text-[14px] font-medium ${
          danger ? 'text-red-500' : 'text-slate-700'
        }`}
      >
        {label}
      </span>
      {!danger && (
        <ChevronRight size={14} strokeWidth={2} className="shrink-0 text-slate-300" />
      )}
    </button>
  )
}

function EinstellungenSection({
  onLeave,
  onSignOut,
}: {
  onLeave: () => void
  onSignOut: () => Promise<void>
}) {
  return (
    <section>
      <div className="mb-3 px-1">
        <h2 className="text-[13px] font-semibold text-slate-400">Einstellungen</h2>
      </div>

      <div className="rounded-[22px] bg-white px-5 ring-1 ring-slate-200/60 shadow-[0_6px_16px_-10px_rgba(2,6,23,0.10)] divide-y divide-slate-100">
        <EinstellungenRow
          icon={<UserMinus size={16} strokeWidth={1.75} />}
          label="Aus Team austreten"
          danger
          onPress={onLeave}
        />
        <EinstellungenRow
          icon={<LogOut size={16} strokeWidth={1.75} />}
          label="Abmelden"
          danger
          onPress={onSignOut}
        />
      </div>
    </section>
  )
}

// ── Leave-Team Dialog ─────────────────────────────────────────────────────────

function LeaveTeamDialog({
  companyName,
  pending,
  errorText,
  onConfirm,
  onCancel,
}: {
  companyName: string | null
  pending: boolean
  errorText: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center">
      <div className="w-full max-w-[420px] rounded-[28px] bg-white p-5 shadow-2xl">
        <h2 className="text-[18px] font-semibold text-slate-900">Team verlassen?</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-slate-600">
          {companyName
            ? `Du verlässt das Team von ${companyName}. `
            : 'Du verlässt dein aktuelles Team. '}
          Du verlierst sofort den Zugriff auf zugewiesene Aufträge und Termine. Um wieder
          beizutreten, brauchst du einen aktuellen Beitritts-Code des Inhabers.
        </p>

        {errorText ? (
          <p className="mt-3 rounded-[12px] bg-rose-50 px-3 py-2 text-[12px] text-rose-700 ring-1 ring-rose-200">
            {errorText}
          </p>
        ) : null}

        <div className="mt-5 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-full bg-slate-100 py-3 text-[14px] font-semibold text-slate-700 disabled:opacity-50"
          >
            Abbrechen
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            data-testid="leave-team-confirm"
            className="rounded-full bg-rose-600 py-3 text-[14px] font-semibold text-white disabled:bg-slate-300"
          >
            {pending ? 'Wird verlassen…' : 'Verlassen'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function WorkerKontoScreen() {
  const navigate = useNavigate()
  const { user } = useSession()
  const { vm, handleSignOut } = useWorkerKonto(user?.id ?? null, user?.email ?? null)

  const [leaveOpen, setLeaveOpen] = useState(false)
  const [leavePending, setLeavePending] = useState(false)
  const [leaveError, setLeaveError] = useState<string | null>(null)

  async function handleLeaveConfirm(): Promise<void> {
    setLeavePending(true)
    setLeaveError(null)
    try {
      const result = await leaveCompany()
      if (result.ok) {
        setLeaveOpen(false)
        navigate('/onboarding/worker', { replace: true })
        return
      }
      setLeaveError(result.error)
    } catch {
      setLeaveError('Austritt fehlgeschlagen. Bitte versuche es erneut.')
    } finally {
      setLeavePending(false)
    }
  }

  return (
    <AppShell active="worker-konto" noSafeTop>
      <div className="px-4 pt-[max(56px,env(safe-area-inset-top))] pb-12">
        <div className="mx-auto w-full max-w-[420px] space-y-7">

          {/* Page title */}
          <div className="px-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
              Persönlicher Bereich
            </p>
            <h1 className="mt-1 text-[26px] font-bold tracking-tight text-slate-900">
              Konto
            </h1>
          </div>

          {/* 1. Header / Profile — real worker identity */}
          <KontoHeader vm={vm.header} />

          {/* 2. Arbeit — dominant block */}
          <section>
            <div className="mb-3 px-1 flex items-baseline justify-between">
              <h2 className="text-[17px] font-bold text-slate-900">Arbeit</h2>
              <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-[0.12em]">
                Mein Rahmen
              </span>
            </div>

            <div className="space-y-3">
              <ZeitübersichtCard vm={vm.zeitubersicht} />
              <KorrekturenCard />
              <KrankmeldungenCard />
            </div>
          </section>

          {/* 3. Einstellungen — leave team + sign out */}
          <EinstellungenSection
            onLeave={() => {
              setLeaveError(null)
              setLeaveOpen(true)
            }}
            onSignOut={handleSignOut}
          />

        </div>
      </div>

      {leaveOpen && (
        <LeaveTeamDialog
          companyName={vm.header.companyName ?? null}
          pending={leavePending}
          errorText={leaveError}
          onConfirm={() => { void handleLeaveConfirm() }}
          onCancel={() => {
            if (leavePending) return
            setLeaveOpen(false)
            setLeaveError(null)
          }}
        />
      )}
    </AppShell>
  )
}
