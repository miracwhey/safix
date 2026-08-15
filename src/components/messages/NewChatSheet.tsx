import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search } from 'lucide-react'
import BottomSheet from '../ui/BottomSheet'
import Avatar from './Avatar'
import HandleClaimField from './HandleClaimField'
import {
  searchProfiles,
  getMyHandleSettings,
  type PersonSearchResult,
} from '../../lib/profile'
import { getOrCreateChatDirectThread } from '../../lib/chat'

type Props = {
  open: boolean
  onClose: () => void
  /** Base path of the current messages surface ('/messages' | '/craftsman/messages'). */
  detailBasePath: string
}

const DEBOUNCE_MS = 300

function mapStartError(msg: string): string {
  if (msg.startsWith('rate_limited')) return 'Zu viele neue Chats heute. Versuch es später erneut.'
  if (msg === 'not_available') return 'Diese Person ist gerade nicht erreichbar.'
  if (msg.startsWith('invalid_argument')) return 'Ungültige Auswahl.'
  return 'Chat konnte nicht gestartet werden. Bitte erneut versuchen.'
}

function roleBadge(p: PersonSearchResult): { label: string; className: string } {
  if (p.providerHandle || p.role === 'craftsman') {
    return { label: 'Handwerker', className: 'bg-amber-50 text-amber-700' }
  }
  return { label: 'Kunde', className: 'bg-emerald-50 text-emerald-700' }
}

/**
 * „Neuer Chat"-Sheet: Personensuche per @Handle/Name → Direktnachricht starten.
 * Nutzt die SECDEF-RPCs (Suche + get-or-create direct-Thread). Wenn der eigene
 * Handle noch fehlt, zeigt es einen (nicht blockierenden) Claim-Prompt — suchen
 * geht auch ohne, nur gefunden wird man erst mit Handle.
 */
export default function NewChatSheet({ open, onClose, detailBasePath }: Props) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [results, setResults] = useState<PersonSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [startingId, setStartingId] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)

  const [ownHandle, setOwnHandle] = useState<string | null>(null)
  const [handleLoaded, setHandleLoaded] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus the search field AFTER the slide-up animation (280ms) rather than via
  // `autoFocus`. `autoFocus` fires in React's commit phase — before the shared
  // keyboard rig (useKeyboardInset, mounted by BottomSheet) has registered its
  // async `keyboardWillShow` listener — so the keyboard would open unobserved,
  // `--keyboard-height` would stay 0, and the sheet would sit entirely behind
  // the keyboard. By the time this timer fires the rig is armed, so the sheet
  // rides above the keyboard. Only auto-focus when the search field is the first
  // thing shown (i.e. the user already has a handle); otherwise the inline
  // claim prompt takes precedence and we don't steal focus.
  useEffect(() => {
    if (!open || !handleLoaded || !ownHandle) return
    const t = setTimeout(() => inputRef.current?.focus(), 320)
    return () => clearTimeout(t)
  }, [open, handleLoaded, ownHandle])

  // Reset all transient state whenever the sheet closes.
  useEffect(() => {
    if (open) return
    setQuery('')
    setDebounced('')
    setResults([])
    setSearchError(null)
    setStartError(null)
    setStartingId(null)
  }, [open])

  // Load the user's own handle on open (for the inline claim prompt).
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void getMyHandleSettings()
      .then((s) => {
        if (cancelled) return
        setOwnHandle(s?.handle ?? null)
        setHandleLoaded(true)
      })
      .catch(() => {
        if (!cancelled) setHandleLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  // Debounce the query.
  useEffect(() => {
    const h = setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS)
    return () => clearTimeout(h)
  }, [query])

  // Run the search when the debounced query changes.
  useEffect(() => {
    if (debounced.length < 2) {
      setResults([])
      setLoading(false)
      setSearchError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setSearchError(null)
    void searchProfiles(debounced)
      .then((r) => {
        if (cancelled) return
        setResults(r)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setSearchError('Suche fehlgeschlagen. Bitte erneut versuchen.')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [debounced])

  async function handleSelect(p: PersonSearchResult) {
    if (startingId) return // multi-click guard (server pair-unique is the backstop)
    setStartingId(p.profileId)
    setStartError(null)
    try {
      const threadId = await getOrCreateChatDirectThread(p.profileId)
      onClose()
      navigate(`${detailBasePath}/${threadId}`)
    } catch (e) {
      setStartError(mapStartError(e instanceof Error ? e.message : ''))
    } finally {
      setStartingId(null)
    }
  }

  const showEmpty = debounced.length >= 2 && !loading && !searchError && results.length === 0

  return (
    <BottomSheet open={open} onClose={onClose} title="Neuer Chat">
      {handleLoaded && !ownHandle && (
        <div className="mb-4 rounded-2xl bg-brand/5 p-4 ring-1 ring-brand/15">
          <p className="text-[14px] font-semibold text-ink">Wähle deinen @Namen</p>
          <p className="mb-3 mt-0.5 text-[12px] text-ink-muted">
            Andere finden dich erst, wenn du einen @Handle hast. Suchen kannst du auch ohne.
          </p>
          <HandleClaimField onClaimed={(h) => setOwnHandle(h)} />
        </div>
      )}

      <div className="flex items-center gap-2 rounded-xl bg-surface px-3 py-3 ring-1 ring-edge">
        <Search size={16} className="shrink-0 text-ink-muted" aria-hidden />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="@name oder Name…"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-muted"
        />
      </div>
      <p className="mt-1.5 px-1 text-[12px] text-ink-muted">Suche nach @Handle oder Name.</p>

      {startError && (
        <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[13px] font-medium text-danger">{startError}</p>
      )}

      <div className="mt-2 max-h-[46dvh] overflow-y-auto">
        {loading && (
          <>
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3 px-1 py-3">
                <div className="h-11 w-11 shrink-0 animate-pulse rounded-full bg-edge" />
                <div className="flex-1">
                  <div className="mb-2 h-3 w-1/2 animate-pulse rounded bg-edge" />
                  <div className="h-3 w-1/3 animate-pulse rounded bg-edge" />
                </div>
              </div>
            ))}
          </>
        )}

        {searchError && <p className="px-1 py-6 text-center text-[13px] text-danger">{searchError}</p>}

        {showEmpty && (
          <div className="px-6 py-10 text-center">
            <p className="text-[15px] font-semibold text-ink">Keine Treffer</p>
            <p className="mt-1 text-[13px] text-ink-muted">
              Kein Profil zu „{debounced}". Prüfe die Schreibweise des @Handles.
            </p>
          </div>
        )}

        {!loading &&
          !searchError &&
          results.map((p) => {
            const badge = roleBadge(p)
            const busy = startingId === p.profileId
            const name = p.displayName || `@${p.handle}`
            return (
              <button
                key={p.profileId}
                type="button"
                disabled={startingId !== null}
                onClick={() => void handleSelect(p)}
                className="flex w-full items-center gap-3 rounded-xl px-1 py-2.5 text-left transition active:bg-slate-50 disabled:opacity-60"
              >
                <Avatar name={name} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[15px] font-semibold text-ink">{name}</span>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${badge.className}`}>
                      {badge.label}
                    </span>
                  </div>
                  <div className="truncate text-[13px] text-brand">
                    @{p.handle}
                    {p.providerHandle ? <span className="text-ink-muted"> · {p.providerHandle}</span> : null}
                  </div>
                </div>
                {busy && <span className="shrink-0 text-[12px] text-ink-muted">…</span>}
              </button>
            )
          })}
      </div>
    </BottomSheet>
  )
}
