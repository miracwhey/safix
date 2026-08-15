import { useEffect, useState } from 'react'
import { AtSign, Eye, EyeOff } from 'lucide-react'
import HandleClaimField from './HandleClaimField'
import {
  getMyHandleSettings,
  setDiscoverable as persistDiscoverable,
  setDmPrivacy as persistDmPrivacy,
} from '../../lib/profile'

/**
 * „Öffentliche Identität"-Abschnitt für den Profil-/Konto-Screen (beide Rollen):
 * @Handle-Claim (Live-Check), Auffindbarkeit-Toggle und Direktnachrichten-
 * Privatsphäre. Lädt die aktuellen Werte einmalig und schreibt optimistisch mit
 * Rollback bei Fehler.
 */
export default function IdentitySettingsSection() {
  const [loaded, setLoaded] = useState(false)
  const [handle, setHandle] = useState<string | null>(null)
  const [discoverable, setDiscoverable] = useState(true)
  const [dmPrivacy, setDmPrivacy] = useState<'everyone' | 'nobody'>('everyone')
  const [savingDisc, setSavingDisc] = useState(false)
  const [savingDm, setSavingDm] = useState(false)

  useEffect(() => {
    let cancelled = false
    void getMyHandleSettings()
      .then((s) => {
        if (cancelled || !s) {
          if (!cancelled) setLoaded(true)
          return
        }
        setHandle(s.handle)
        setDiscoverable(s.discoverable)
        setDmPrivacy(s.dmPrivacy)
        setLoaded(true)
      })
      .catch(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function toggleDiscoverable() {
    if (savingDisc) return
    const next = !discoverable
    setDiscoverable(next)
    setSavingDisc(true)
    try {
      await persistDiscoverable(next)
    } catch {
      setDiscoverable(!next) // rollback
    } finally {
      setSavingDisc(false)
    }
  }

  async function chooseDmPrivacy(value: 'everyone' | 'nobody') {
    if (savingDm || value === dmPrivacy) return
    const prev = dmPrivacy
    setDmPrivacy(value)
    setSavingDm(true)
    try {
      await persistDmPrivacy(value)
    } catch {
      setDmPrivacy(prev) // rollback
    } finally {
      setSavingDm(false)
    }
  }

  if (!loaded) return null

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 px-1">
        <AtSign size={14} className="text-ink-muted" aria-hidden />
        <h2 className="text-[12px] font-semibold uppercase tracking-wide text-ink-muted">Öffentliche Identität</h2>
      </div>

      {/* Handle */}
      <div className="rounded-container bg-surface p-4 ring-1 ring-edge shadow-subtle">
        <p className="mb-2 text-[13px] font-semibold text-ink">Dein @Handle</p>
        <HandleClaimField initialHandle={handle} onClaimed={(h) => setHandle(h)} />
        <p className="mt-2 px-1 text-[11px] text-ink-muted">
          Damit finden dich andere. Änderung max. 1× / 30 Tage. Reservierte Namen sind gesperrt.
        </p>
      </div>

      {/* Discoverable */}
      <div className="rounded-container bg-surface px-4 py-3.5 ring-1 ring-edge shadow-subtle">
        <div className="flex items-center gap-3">
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
              discoverable ? 'bg-brand/10 text-brand' : 'bg-danger/10 text-danger'
            }`}
            aria-hidden
          >
            {discoverable ? <Eye size={18} /> : <EyeOff size={18} />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold text-ink">Auffindbar</p>
            <p className="mt-0.5 text-[12px] text-ink-muted">
              {discoverable ? 'Andere dürfen dich per @Handle finden.' : 'Du erscheinst nicht in der Suche.'}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={discoverable}
            aria-label="Auffindbar"
            disabled={savingDisc}
            onClick={() => void toggleDiscoverable()}
            className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${discoverable ? 'bg-brand' : 'bg-edge'}`}
          >
            <span
              className={`absolute top-[2px] h-6 w-6 rounded-full bg-white shadow transition-all ${
                discoverable ? 'left-[22px]' : 'left-[2px]'
              }`}
            />
          </button>
        </div>
      </div>

      {/* DM privacy */}
      <div className="rounded-container bg-surface px-4 py-3.5 ring-1 ring-edge shadow-subtle">
        <p className="text-[14px] font-semibold text-ink">Direktnachrichten</p>
        <p className="mb-3 mt-0.5 text-[12px] text-ink-muted">Wer dir schreiben darf.</p>
        <div className="flex gap-2">
          {(
            [
              { value: 'everyone', label: 'Alle' },
              { value: 'nobody', label: 'Niemand' },
            ] as const
          ).map((opt) => {
            const active = dmPrivacy === opt.value
            return (
              <button
                key={opt.value}
                type="button"
                disabled={savingDm}
                onClick={() => void chooseDmPrivacy(opt.value)}
                className={`flex-1 rounded-full px-4 py-2 text-[13px] font-semibold ring-1 transition ${
                  active ? 'bg-brand text-white ring-brand' : 'bg-surface text-ink-muted ring-edge'
                }`}
              >
                {opt.label}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
