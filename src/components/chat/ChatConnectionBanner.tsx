/**
 * Chat-Härtung Cluster 1 — Verbindungs-Leiste unter dem Thread-Header.
 *
 * Dezente, schmale Statuszeile. WhatsApp-Semantik:
 *   - offline    → "Keine Verbindung — Nachrichten werden gesendet, sobald du
 *                   wieder online bist" (Sends laufen still in die Media-Outbox).
 *   - connecting → "Verbinde …" (Netz da, Realtime-Socket noch nicht SUBSCRIBED).
 *   - connected  → eingeklappt (keine sichtbare Leiste).
 *
 * Prop-driven Anzeige (Layer-Regel: Business-Logik in lib/chat). Die Quelle
 * ist B2s Connection-State (`useChatConnectionState`), den der Screen liest und
 * als `state`-Prop reicht. Ein-/Ausblendung ausschließlich via
 * max-height/opacity/transform — kein AI-Slop (keine Glows/Pills), ruhige Typo.
 *
 * 'connecting' erscheint erst nach einer Grace-Zeit: der Realtime-Socket
 * braucht bei jedem Thread-Open/Cold-Start ~0,3–2s bis SUBSCRIBED — ohne Grace
 * würde bei JEDEM Öffnen kurz "Verbinde …" aufflackern, obwohl Senden längst
 * funktioniert. Nur echte Reconnect-Hänger (> Grace) werden sichtbar; offline
 * erscheint sofort.
 */

import { useEffect, useState } from 'react'
import type { ChatConnectionState } from '../../lib/chat'

const COPY: Record<Exclude<ChatConnectionState, 'connected'>, string> = {
  offline: 'Keine Verbindung — Nachrichten werden gesendet, sobald du wieder online bist',
  connecting: 'Verbinde …',
}

const CONNECTING_GRACE_MS = 1_500

type Props = {
  state: ChatConnectionState
}

export function ChatConnectionBanner({ state }: Props) {
  const [connectingHeld, setConnectingHeld] = useState(false)
  // setState only from timer callbacks (never sync in the effect body — the
  // react-hooks lint forbids the cascading-render pattern). The 0ms reset
  // clears a stale `held` long before the next 1.5s grace can elapse.
  useEffect(() => {
    const timer =
      state === 'connecting'
        ? setTimeout(() => setConnectingHeld(true), CONNECTING_GRACE_MS)
        : setTimeout(() => setConnectingHeld(false), 0)
    return () => clearTimeout(timer)
  }, [state])

  const visible = state === 'offline' || (state === 'connecting' && connectingHeld)
  const isOffline = state === 'offline'
  const label = state === 'connected' ? '' : COPY[state]

  return (
    <div
      className="overflow-hidden transition-all duration-300 ease-out"
      style={{
        maxHeight: visible ? 34 : 0,
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(-6px)',
      }}
      aria-hidden={!visible}
      data-connection-state={state}
    >
      <div
        role="status"
        aria-live="polite"
        className="mx-auto flex w-full max-w-[420px] items-center justify-center gap-2 rounded-b-lg px-4 py-1.5"
        // Solid-ish page-colored backdrop: the bar is sticky and slides over
        // the message stream — without it, bubbles shine through the text.
        style={{ background: 'rgba(239, 233, 224, 0.94)' }}
      >
        <span
          aria-hidden
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: isOffline ? '#B45309' : '#64748B' }}
        />
        <span className="truncate text-[12px] font-medium leading-tight text-slate-500">
          {label}
        </span>
      </div>
    </div>
  )
}
