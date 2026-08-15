import { useEffect, useState } from 'react'
import { Check, X } from 'lucide-react'
import { checkHandleAvailable, claimHandle } from '../../lib/profile'

type Props = {
  /** Current handle of the user (null if never claimed). Prefills + treated as no-op target. */
  initialHandle?: string | null
  /** Called with the normalised handle after a successful claim. */
  onClaimed?: (handle: string) => void
}

type Status = 'idle' | 'checking' | 'ok' | 'invalid' | 'reserved' | 'taken'

const DEBOUNCE_MS = 400

/**
 * Handle-Claim-Feld mit Live-Verfügbarkeitsprüfung. Wiederverwendet in
 * NewChatSheet (Inline-Prompt) und ProfileScreen (Einstellungen). Normalisiert
 * die Eingabe clientseitig (lowercase, @ strippen, nur [a-z0-9_.]) — die harte
 * Erzwingung bleibt server-seitig (CHECK + reserved-Guard + Unique).
 */
export default function HandleClaimField({ initialHandle, onClaimed }: Props) {
  const [value, setValue] = useState(initialHandle ?? '')
  const [debounced, setDebounced] = useState(initialHandle ?? '')
  const [status, setStatus] = useState<Status>('idle')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<string | null>(initialHandle ?? null)
  const [error, setError] = useState<string | null>(null)

  function onChange(raw: string) {
    const norm = raw.replace(/^@/, '').toLowerCase().replace(/[^a-z0-9_.]/g, '')
    setValue(norm)
    setError(null)
  }

  useEffect(() => {
    const h = setTimeout(() => setDebounced(value), DEBOUNCE_MS)
    return () => clearTimeout(h)
  }, [value])

  useEffect(() => {
    const v = debounced.trim()
    if (v.length === 0) {
      setStatus('idle')
      return
    }
    if (v.length < 3) {
      setStatus('invalid')
      return
    }
    if (v === saved) {
      setStatus('idle')
      return
    }
    let cancelled = false
    setStatus('checking')
    void checkHandleAvailable(v)
      .then((r) => {
        if (cancelled) return
        if (!r.validFormat) setStatus('invalid')
        else if (r.reserved) setStatus('reserved')
        else if (r.available) setStatus('ok')
        else setStatus('taken')
      })
      .catch(() => {
        if (!cancelled) setStatus('idle')
      })
    return () => {
      cancelled = true
    }
  }, [debounced, saved])

  async function onSave() {
    if (saving || status !== 'ok') return
    setSaving(true)
    setError(null)
    try {
      const h = await claimHandle(value)
      setSaved(h)
      setValue(h)
      setStatus('idle')
      onClaimed?.(h)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Handle konnte nicht gesetzt werden.')
    } finally {
      setSaving(false)
    }
  }

  const statusText: Record<Status, string> = {
    idle: '',
    checking: 'Prüfe Verfügbarkeit…',
    ok: 'frei',
    invalid: 'Ungültig — 3–30 Zeichen, a–z 0–9 . _',
    reserved: 'Dieser Handle ist reserviert',
    taken: 'Bereits vergeben',
  }
  const isPositive = status === 'ok'
  const isNegative = status === 'invalid' || status === 'reserved' || status === 'taken'

  return (
    <div>
      <div
        className={`flex items-center gap-1 rounded-xl bg-surface px-3 py-3 ring-1 transition ${
          isNegative ? 'ring-danger/60' : isPositive ? 'ring-emerald-400' : 'ring-edge'
        }`}
      >
        <span className="text-[15px] text-ink-muted">@</span>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="deinname"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[15px] font-medium text-ink outline-none placeholder:font-normal placeholder:text-ink-muted"
        />
        {status === 'ok' && (
          <span className="flex shrink-0 items-center gap-1 text-[12px] font-semibold text-emerald-600">
            <Check size={14} aria-hidden /> frei
          </span>
        )}
        {isNegative && (
          <span className="flex shrink-0 items-center text-[12px] font-semibold text-danger">
            <X size={14} aria-hidden />
          </span>
        )}
      </div>

      {(status !== 'idle' || error) && (
        <p
          className={`mt-1.5 px-1 text-[12px] font-medium ${
            error || isNegative ? 'text-danger' : isPositive ? 'text-emerald-600' : 'text-ink-muted'
          }`}
        >
          {error ?? statusText[status]}
        </p>
      )}

      <button
        type="button"
        onClick={() => void onSave()}
        disabled={status !== 'ok' || saving}
        className={`mt-3 flex h-11 w-full items-center justify-center rounded-xl text-[15px] font-semibold transition ${
          status === 'ok' && !saving
            ? 'bg-brand text-white active:scale-[0.99]'
            : 'cursor-not-allowed bg-edge text-ink-muted'
        }`}
      >
        {saving ? 'Wird gesichert…' : value ? `@${value} sichern` : 'Handle wählen'}
      </button>
    </div>
  )
}
