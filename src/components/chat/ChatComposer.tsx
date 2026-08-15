import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatRole } from '../../lib/chat'
import {
  composerTilesFor,
  groupComposerTiles,
  type ComposerIconKey,
  type ComposerTile,
  type ComposerTileKind,
} from './composerTiles'
import { useVoiceRecorder } from '../../hooks/useVoiceRecorder'
import type { VoiceRecording } from '../../lib/chat/voice/types'
import { useToast } from '../../hooks/useToast'
import { useHaptics } from '../../hooks/useHaptics'
import { useDraftPersistence } from '../../hooks/useDraftPersistence'
import { VoiceComposerOverlay } from './VoiceComposerOverlay'
import { LockIndicator } from './LockIndicator'

/**
 * Resume robustness: maximum age of the synchronous send-lock before it is
 * treated as free again. If a send-promise never settles (iOS WebKit can
 * drop in-flight fetches on app suspension without ever rejecting), the
 * finally-release never runs and a boolean lock would brick the composer
 * until remount. Chosen ABOVE the repository-side 15s send timeout so that
 * timeout (which settles the promise and releases via finally) wins in the
 * normal case — this is only the screen-side backstop.
 */
const SEND_LOCK_MAX_MS = 20_000
// Press shorter than this = a tap → lock into recording (hands-free, tap to
// send). Longer = a hold → finalize + send on release.
const TAP_TO_LOCK_MS = 400

type Props = {
  role: ChatRole
  /** Disable input + send while a network call is in-flight. */
  disabled?: boolean
  placeholder?: string
  /** Send the typed text body. Composer clears the input after success. */
  onSendText: (body: string) => void | Promise<void>
  /** Triggered when any tile from the picker is tapped. */
  onTrigger: (kind: ComposerTileKind, tile: ComposerTile) => void
  /**
   * Optional pre-flight gate for the send button. Return `false` to abort
   * the send (e.g. expired subscription → caller renders an upgrade modal).
   * The composer keeps the draft text on abort.
   */
  beforeSend?: () => boolean | Promise<boolean>
  /**
   * Optional pre-flight gate for tile triggers. Return `false` to abort the
   * tile flow (e.g. trial-required offer composer). The composer collapses
   * the tile picker on abort to mirror permit-flow visual.
   */
  beforeTile?: (kind: ComposerTileKind, tile: ComposerTile) => boolean | Promise<boolean>
  /** Optional reply-to context shown above the input. */
  replyTo?: { senderName: string; preview: string; onCancel: () => void } | null
  /**
   * Voice-note send callback. When provided AND the text-input is empty,
   * the composer renders a hold-to-record mic button in place of the send
   * button. Caller wires this to `sendVoiceNoteWorkflow` and the IDB cache
   * lifecycle (`recordingCache`).
   */
  onSendVoice?: (recording: VoiceRecording) => void | Promise<void>
  /**
   * Pre-flight gate fired BEFORE the recording is forwarded to onSendVoice.
   * Mirrors `beforeSend` for the text path. On `false`, the composer keeps
   * the captured recording in a "failed-pending" state so the user can
   * retry or explicitly discard — same UX guarantee as text-drafts surviving
   * a gate denial.
   */
  beforeVoiceSend?: () => boolean | Promise<boolean>
  /**
   * Stable client-message-id factory for each new recording. Caller controls
   * the id so the same id can be reused when re-trying a failed send.
   */
  voiceClientMessageIdFactory?: () => string
  /**
   * localStorage key for text-draft persistence (convention:
   * `fixup.chat.draft.<chatThreadId>`). When set, the typed draft survives
   * unmount/remount cycles (in-flow navigation, AuthGate error-swap) and
   * WebView memory kills. Cleared ONLY after a successful send dispatch —
   * never on unmount. `null`/omitted → in-memory only (back-compat).
   */
  draftKey?: string | null
}

/**
 * Block D Slice 1b-B Stage 2 — Composer v3 (ADR D-9).
 *
 * Persona-aware trigger-tile picker with a 1-line text input. Pure UI: it
 * never calls a workflow itself — Screen wires `onTrigger` to existing
 * workflows (createOfferWorkflow with documentType, changeOrderWorkflow,
 * ProjectPickerSheet, chatAttachmentUploader, …).
 *
 * Layout
 *   • collapsed → "+" trigger + 1-line input + send
 *   • expanded  → tile-grid above input, "Vorgänge" and "Anhängen" sections
 */
export function ChatComposer({
  role,
  disabled = false,
  placeholder = 'Nachricht schreiben…',
  onSendText,
  onTrigger,
  beforeSend,
  beforeTile,
  replyTo = null,
  onSendVoice,
  beforeVoiceSend,
  voiceClientMessageIdFactory,
  draftKey = null,
}: Props) {
  const voiceIdFactory = useMemo(() => {
    return voiceClientMessageIdFactory ?? (() => crypto.randomUUID())
  }, [voiceClientMessageIdFactory])
  const recorder = useVoiceRecorder(voiceIdFactory)
  const dragOriginRef = useRef<{ x: number; y: number } | null>(null)
  const pointerDownAtRef = useRef(0)
  const [pullPx, setPullPx] = useState(0)
  const [cancelPullPx, setCancelPullPx] = useState(0)
  const voiceSendingRef = useRef(0)
  const voiceEnabled = typeof onSendVoice === 'function'
  // Captures the most recent recording when send/gate fails so the user can
  // retry from the cached audio or explicitly discard. Without this the
  // recorder.reset() finally would silently throw the take away — text
  // drafts survive a beforeSend denial, voice drafts must too.
  const [pendingFailedVoice, setPendingFailedVoice] = useState<VoiceRecording | null>(null)
  const [voiceRetrying, setVoiceRetrying] = useState(false)
  const toast = useToast()
  const haptics = useHaptics()
  // Single-shot 4:50 pre-stop warning — fires once when the recorder flips
  // `warningVisible` true. Resets when the user starts a fresh take so the
  // next overlong recording can warn again.
  const warningToastedRef = useRef(false)
  useEffect(() => {
    if (recorder.warningVisible && !warningToastedRef.current) {
      warningToastedRef.current = true
      toast.info('Aufnahme stoppt automatisch in 10 Sekunden.')
    }
    if (!recorder.warningVisible) {
      warningToastedRef.current = false
    }
  }, [recorder.warningVisible, toast])
  // Surface recorder failures loudly. A finalize / permission / mic error
  // otherwise only renders as a small inline line under the composer, which
  // reads as a silent break — the exact symptom reported for voice notes.
  const lastVoiceErrorRef = useRef<string | null>(null)
  useEffect(() => {
    const code = recorder.error?.code ?? null
    if (code && code !== lastVoiceErrorRef.current) {
      lastVoiceErrorRef.current = code
      toast.error(voiceErrorLabel(code))
    }
    if (!code) lastVoiceErrorRef.current = null
  }, [recorder.error, toast])
  const tiles = useMemo(() => composerTilesFor(role), [role])
  const sections = useMemo(() => groupComposerTiles(tiles), [tiles])
  const hasAnyTile = tiles.length > 0
  // Draft text — persisted per thread (`draftKey`) so it survives in-flow
  // navigation, AuthGate error-swaps and WebView memory kills. Cleared only
  // after a successful send dispatch, never on unmount.
  const { value: text, setValue: setText, clear: clearDraft } = useDraftPersistence(draftKey)
  const [expanded, setExpanded] = useState(false)
  const [sending, setSending] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Synchronous re-entry lock. Stores the acquisition timestamp (0 = free)
  // instead of a boolean so a never-settling send-promise cannot brick the
  // composer permanently — the guard treats locks older than
  // SEND_LOCK_MAX_MS as free (see const doc above).
  const sendingRef = useRef(0)
  // Failsafe that force-releases the `sending` UI state when the promise
  // never settles. Token-guarded so a stale timer/finally never releases a
  // newer send's lock.
  const unstickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (unstickTimerRef.current !== null) clearTimeout(unstickTimerRef.current)
    }
  }, [])
  const send = useCallback(async () => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    // Synchronous re-entry guard. `sending` state is queued by React, so
    // two touches in the same tick can both pass a state gate. The ref is
    // set synchronously and catches the second invocation immediately —
    // same pattern as the screen's handleChatSend sendingRef.
    const now = Date.now()
    if (sendingRef.current !== 0 && now - sendingRef.current < SEND_LOCK_MAX_MS) return
    const lockToken = now
    sendingRef.current = lockToken
    haptics.light()
    try {
      if (beforeSend) {
        const permitted = await beforeSend()
        if (!permitted) return
      }
      setSending(true)
      if (unstickTimerRef.current !== null) clearTimeout(unstickTimerRef.current)
      unstickTimerRef.current = setTimeout(() => {
        unstickTimerRef.current = null
        if (sendingRef.current === lockToken) {
          sendingRef.current = 0
          setSending(false)
        }
      }, SEND_LOCK_MAX_MS)
      try {
        await onSendText(trimmed)
        // Success side-effects only while this invocation still owns the
        // lock: a hung send whose lock expired (unstick) may settle AFTER
        // the user typed a fresh draft — clearing then would destroy it.
        if (sendingRef.current === lockToken) {
          clearDraft()
          setExpanded(false)
          requestAnimationFrame(() => textareaRef.current?.focus())
        }
      } catch {
        // Caller surfaces the error (toast/log). Keep `text` so the user
        // can retry without re-typing.
      }
    } finally {
      // Only release when this invocation still owns the lock — a hung send
      // whose lock already expired (and was re-acquired by a newer send)
      // must not free the newer send's lock or clear its unstick timer.
      if (sendingRef.current === lockToken) {
        sendingRef.current = 0
        setSending(false)
        if (unstickTimerRef.current !== null) {
          clearTimeout(unstickTimerRef.current)
          unstickTimerRef.current = null
        }
      }
    }
  }, [text, disabled, onSendText, beforeSend, clearDraft, haptics])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void send()
      }
    },
    [send],
  )

  const handleTrigger = useCallback(
    async (tile: ComposerTile) => {
      if (beforeTile) {
        const permitted = await beforeTile(tile.kind, tile)
        if (!permitted) {
          setExpanded(false)
          return
        }
      }
      setExpanded(false)
      onTrigger(tile.kind, tile)
    },
    [onTrigger, beforeTile],
  )

  const inputDisabled = disabled || sending
  const sendActive = text.trim().length > 0 && !inputDisabled
  const recorderState = recorder.state
  const recordingActive =
    recorderState !== 'idle' && recorderState !== 'requesting-permission'

  // Forward completed recording to the caller. Terminal paths:
  //   • success                → clear any pending-failed entry, reset recorder
  //   • gate denied            → preserve recording in pendingFailedVoice (no bubble was shown)
  //   • offline / validation   → preserve recording in pendingFailedVoice (no bubble was shown)
  //   • upload / RPC failure   → do NOT set pendingFailedVoice; the failed bubble in the
  //                              stream (inserted by sendVoiceNoteWorkflow) handles retry.
  //                              Errors after the optimistic insert carry `bubbleInserted = true`.
  useEffect(() => {
    const completed = recorder.recording
    if (!completed || !onSendVoice) return
    // Timestamped re-entry lock (mirrors the screen's sendingRef). A plain
    // boolean would brick all future voice notes if a single onSendVoice never
    // settles — iOS WebKit can drop an in-flight fetch/IDB op on app suspension
    // WITHOUT rejecting, so the finally would never run. Self-heal after
    // SEND_LOCK_MAX_MS instead.
    const nowTs = Date.now()
    if (voiceSendingRef.current !== 0 && nowTs - voiceSendingRef.current < SEND_LOCK_MAX_MS) return
    voiceSendingRef.current = nowTs
    void (async () => {
      try {
        if (beforeVoiceSend) {
          const permitted = await beforeVoiceSend()
          if (!permitted) {
            setPendingFailedVoice(completed)
            return
          }
        }
        try {
          await onSendVoice(completed)
          setPendingFailedVoice(null)
        } catch (err) {
          // If the error occurred after the optimistic row was inserted (upload / RPC failure),
          // the failed bubble in the stream handles retry — no banner needed.
          const bubbleInserted =
            err !== null &&
            typeof err === 'object' &&
            'bubbleInserted' in err &&
            (err as Record<string, unknown>).bubbleInserted === true
          if (!bubbleInserted) {
            setPendingFailedVoice(completed)
          }
        }
      } finally {
        voiceSendingRef.current = 0
        recorder.reset()
      }
    })()
  }, [recorder, onSendVoice, beforeVoiceSend])

  const retryPendingVoice = useCallback(async () => {
    if (!pendingFailedVoice || !onSendVoice || voiceRetrying) return
    setVoiceRetrying(true)
    try {
      if (beforeVoiceSend) {
        const permitted = await beforeVoiceSend()
        if (!permitted) return
      }
      await onSendVoice(pendingFailedVoice)
      setPendingFailedVoice(null)
    } catch {
      // Keep the pending entry; user can retry again or discard.
    } finally {
      setVoiceRetrying(false)
    }
  }, [pendingFailedVoice, onSendVoice, beforeVoiceSend, voiceRetrying])

  const discardPendingVoice = useCallback(() => {
    setPendingFailedVoice(null)
  }, [])

  const onVoicePointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (!voiceEnabled || inputDisabled) return
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        // ignore — older WebKit may throw on already-captured pointer
      }
      dragOriginRef.current = { x: e.clientX, y: e.clientY }
      pointerDownAtRef.current = Date.now()
      setPullPx(0)
      void recorder.start()
    },
    [voiceEnabled, inputDisabled, recorder],
  )

  const onVoicePointerMove = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (!recordingActive || !dragOriginRef.current) return
      const dx = e.clientX - dragOriginRef.current.x
      const dy = e.clientY - dragOriginRef.current.y
      recorder.updateDrag(dx, dy)
      setPullPx(Math.max(0, -dy))
      setCancelPullPx(Math.max(0, Math.min(80, -dx)))
    },
    [recordingActive, recorder],
  )

  const onVoicePointerEnd = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      // Guard on the gesture, NOT on recordingActive: start() is async, so on
      // release the recorder may still be in 'requesting-permission' (not yet
      // 'recording'). Gating on recordingActive here skipped release() and
      // silently orphaned the in-flight take — the no-bubble/no-error voice bug.
      if (!dragOriginRef.current) return
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        // ignore
      }
      const heldMs = Date.now() - pointerDownAtRef.current
      dragOriginRef.current = null
      setPullPx(0)
      setCancelPullPx(0)
      // Quick tap → lock into recording (hands-free, tap send in the overlay).
      // Sustained hold → finalize + send on release. release() also discards a
      // cancel-armed drag.
      if (heldMs < TAP_TO_LOCK_MS) {
        void recorder.lockFromTap()
      } else {
        void recorder.release()
      }
    },
    [recorder],
  )

  return (
    <div className="chat-composer-root bg-gradient-to-t from-[#EFE9E0] via-[#EFE9E0]/80 to-transparent px-3 pt-3 pb-[max(8px,env(safe-area-inset-bottom))]">
      {replyTo ? (
        <div className="mb-2 flex items-start gap-2 rounded-lg bg-slate-50 px-2 py-1.5 ring-1 ring-slate-200/70">
          <span className="mt-0.5 w-[3px] self-stretch rounded-full bg-blue-400" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] font-semibold text-slate-700">
              Antwort an {replyTo.senderName}
            </div>
            <div className="truncate text-[12px] text-slate-500">{replyTo.preview}</div>
          </div>
          <button
            type="button"
            onClick={replyTo.onCancel}
            className="shrink-0 rounded-full p-1 text-slate-400 hover:text-slate-600"
            aria-label="Antwort verwerfen"
          >
            ×
          </button>
        </div>
      ) : null}

      {pendingFailedVoice ? (
        <div
          className="mb-2 flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 ring-1 ring-amber-200"
          role="status"
          aria-live="polite"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700">
            <PendingVoiceIcon />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-semibold text-amber-900">
              Sprachnachricht nicht gesendet
            </div>
            <div className="truncate text-[11px] text-amber-700">
              Aufnahme behalten — Wiederholen oder Verwerfen.
            </div>
          </div>
          <button
            type="button"
            onClick={() => void retryPendingVoice()}
            disabled={voiceRetrying}
            className="shrink-0 rounded-full bg-amber-600 px-3 py-1 text-[12px] font-semibold text-white transition active:scale-95 disabled:opacity-60"
          >
            {voiceRetrying ? 'Sende…' : 'Wiederholen'}
          </button>
          <button
            type="button"
            onClick={discardPendingVoice}
            disabled={voiceRetrying}
            className="shrink-0 rounded-full bg-white px-2 py-1 text-[12px] text-amber-700 ring-1 ring-amber-300 transition active:scale-95 disabled:opacity-60"
            aria-label="Aufnahme verwerfen"
          >
            Verwerfen
          </button>
        </div>
      ) : null}

      {expanded && hasAnyTile ? (
        <div className="mb-2 rounded-2xl bg-slate-50/80 p-2 ring-1 ring-slate-200/70">
          {sections.workflow.length > 0 ? (
            <TileSection title="Vorgänge" tiles={sections.workflow} onTrigger={handleTrigger} />
          ) : null}
          {sections.attachment.length > 0 ? (
            <TileSection
              title="Anhängen"
              tiles={sections.attachment}
              onTrigger={handleTrigger}
              compact={sections.workflow.length > 0}
            />
          ) : null}
        </div>
      ) : null}

      <div className="relative flex items-end gap-2">
        {recordingActive ? (
          <LockIndicator pullPx={pullPx} armThresholdPx={80} />
        ) : null}
        {/* Plus + textarea row — faded out during recording but always mounted
            so the textarea ref + focus state survive a take/discard cycle. */}
        <div
          className={`flex flex-1 items-end gap-2 ${recordingActive ? 'pointer-events-none' : ''}`}
          style={{
            opacity: recordingActive ? 0 : 1,
            transition: 'opacity 180ms ease-out',
          }}
          aria-hidden={recordingActive}
        >
          {hasAnyTile ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[18px] text-white shadow-[0_6px_14px_-5px_rgba(29,56,102,0.6)] transition before:absolute before:-inset-1 before:content-[''] active:scale-95 ${
                expanded ? 'bg-[#0F2147]' : 'bg-[#1D3866]'
              }`}
              aria-label={expanded ? 'Anhang-Auswahl schließen' : 'Anhang hinzufügen'}
              aria-expanded={expanded}
              disabled={inputDisabled || recordingActive}
              tabIndex={recordingActive ? -1 : 0}
            >
              <span aria-hidden style={{ transform: `rotate(${expanded ? '45deg' : '0deg'})`, transition: 'transform 140ms ease-out' }}>
                +
              </span>
            </button>
          ) : null}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            rows={1}
            disabled={inputDisabled || recordingActive}
            tabIndex={recordingActive ? -1 : 0}
            className="max-h-32 min-h-[36px] flex-1 resize-none rounded-[20px] bg-white px-3.5 py-2 text-[14.5px] text-slate-900 shadow-[0_3px_14px_-4px_rgba(15,23,42,0.22)] outline-none ring-1 ring-slate-900/5 placeholder:text-slate-400 disabled:opacity-60"
          />
        </div>
        {/* Voice overlay layer — absolutely positioned over the input row so
            both layers share the same horizontal slot during the 180ms
            cross-fade. Only interactive when recording. */}
        {voiceEnabled ? (
          <div
            className={`voice-no-select absolute inset-0 flex items-end gap-2 ${recordingActive ? '' : 'pointer-events-none'}`}
            style={{
              opacity: recordingActive ? 1 : 0,
              transition: 'opacity 180ms ease-out',
            }}
            aria-hidden={!recordingActive}
          >
            <VoiceComposerOverlay
              state={recorder.state}
              elapsedMs={recorder.elapsedMs}
              liveBars={recorder.liveBars}
              warningVisible={recorder.warningVisible}
              cancelPullPx={cancelPullPx}
              onSend={() => void recorder.sendFromLocked()}
              onDiscard={() => recorder.discardFromLocked()}
            />
          </div>
        ) : null}
        {/* Right-side button — always mounted so setPointerCapture on the mic
            survives the cross-fade. Variant flips between send/mic icons. */}
        {sendActive || !voiceEnabled ? (
          <button
            type="button"
            onClick={() => void send()}
            disabled={!sendActive || recordingActive}
            tabIndex={recordingActive ? -1 : 0}
            className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white transition before:absolute before:-inset-1 before:content-[''] active:scale-95 ${
              sendActive ? 'bg-[#1D3866] shadow-[0_6px_14px_-5px_rgba(29,56,102,0.6)]' : 'bg-slate-200 text-slate-400'
            }`}
            style={{
              opacity: recordingActive ? 0 : 1,
              transition: 'opacity 180ms ease-out',
            }}
            aria-label="Senden"
            aria-hidden={recordingActive}
          >
            <SendIcon />
          </button>
        ) : (
          <button
            type="button"
            onPointerDown={onVoicePointerDown}
            onPointerMove={onVoicePointerMove}
            onPointerUp={onVoicePointerEnd}
            onPointerCancel={onVoicePointerEnd}
            disabled={inputDisabled}
            className="voice-no-select relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-[#1D3866] shadow-[0_3px_10px_-4px_rgba(15,23,42,0.25)] ring-1 ring-slate-900/5 transition before:absolute before:-inset-1 before:content-[''] active:scale-95"
            aria-label="Sprachnachricht aufnehmen — tippen oder halten zum Aufnehmen, hoch ziehen zum Sperren, links ziehen zum Abbrechen"
            style={{
              touchAction: 'none',
              opacity: recordingActive ? 0 : 1,
              transition: 'opacity 180ms ease-out',
            }}
            aria-hidden={recordingActive}
          >
            <MicIcon />
          </button>
        )}
      </div>
      {recorder.error ? (
        <div className="mt-1 px-1 text-[11px] text-rose-600">
          {voiceErrorLabel(recorder.error.code)}
        </div>
      ) : null}
    </div>
  )
}

function voiceErrorLabel(code: string): string {
  switch (code) {
    case 'permission_denied':
      return 'Mikrofon-Zugriff verweigert. Bitte in den iOS-Einstellungen freigeben.'
    case 'device_unsupported':
      return 'Dein Gerät unterstützt keine Sprachaufnahme.'
    case 'mic_busy':
      return 'Mikrofon wird gerade von einer anderen App genutzt.'
    case 'empty_recording':
      return 'Aufnahme war zu kurz — etwas länger halten.'
    default:
      return 'Aufnahme fehlgeschlagen. Bitte erneut versuchen.'
  }
}

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="6" y="2" width="4" height="8" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4 8a4 4 0 0 0 8 0M8 12v2.5M5.5 14.5h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function PendingVoiceIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="6" y="2.5" width="4" height="7.5" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4 8a4 4 0 0 0 8 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M3 13.5h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeDasharray="1.5 1.5" />
    </svg>
  )
}

function TileSection({
  title,
  tiles,
  onTrigger,
  compact = false,
}: {
  title: string
  tiles: ComposerTile[]
  onTrigger: (tile: ComposerTile) => void
  compact?: boolean
}) {
  return (
    <div className={compact ? 'mt-2 border-t border-slate-200/70 pt-2' : ''}>
      <div className="mb-1 px-1 text-[10.5px] font-semibold uppercase tracking-wider text-slate-400">
        {title}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {tiles.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onTrigger(t)}
            className="flex min-h-[68px] flex-col items-start gap-1 rounded-xl bg-white px-2.5 py-2 text-left ring-1 ring-slate-200/70 transition active:scale-[0.97]"
          >
            <TileIcon iconKey={t.iconKey} />
            <span className="line-clamp-2 text-[11px] font-semibold leading-tight text-slate-900">
              {t.label}
            </span>
            <span className="line-clamp-2 text-[10px] leading-tight text-slate-500">
              {t.hint}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function TileIcon({ iconKey }: { iconKey: ComposerIconKey }) {
  const className = iconKeyClass(iconKey)
  return (
    <span
      className={`flex h-7 w-7 items-center justify-center rounded-lg ${className}`}
      aria-hidden
    >
      {iconKeyGlyph(iconKey)}
    </span>
  )
}

function iconKeyClass(key: ComposerIconKey): string {
  switch (key) {
    case 'binding-offer':
      return 'bg-blue-50 text-blue-700'
    case 'estimate':
      return 'bg-indigo-50 text-indigo-700'
    case 'diagnosis':
      return 'bg-amber-50 text-amber-700'
    case 'change-order':
      return 'bg-violet-50 text-violet-700'
    case 'project':
      return 'bg-emerald-50 text-emerald-700'
    case 'photo':
      return 'bg-rose-50 text-rose-700'
    case 'document':
      return 'bg-slate-100 text-slate-700'
    case 'video':
      return 'bg-purple-50 text-purple-700'
  }
}

function iconKeyGlyph(key: ComposerIconKey) {
  const stroke = 'currentColor'
  switch (key) {
    case 'binding-offer':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke={stroke} strokeWidth="1.4" />
          <path d="M5.5 6h5M5.5 9h5M5.5 12h3" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      )
    case 'estimate':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M3 12V4M6 12V7M9 12V5M12 12V8" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      )
    case 'diagnosis':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="7" cy="7" r="3.5" stroke={stroke} strokeWidth="1.4" />
          <path d="m9.5 9.5 3 3" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      )
    case 'change-order':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M3 5h7M13 5l-2-2M13 5l-2 2M13 11H6M3 11l2-2M3 11l2 2" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      )
    case 'project':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M2 6.5 8 3l6 3.5v6L8 16l-6-3.5v-6Z" stroke={stroke} strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M2 6.5 8 10l6-3.5M8 10v6" stroke={stroke} strokeWidth="1.4" />
        </svg>
      )
    case 'photo':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="2" y="3.5" width="12" height="9" rx="1.5" stroke={stroke} strokeWidth="1.4" />
          <circle cx="8" cy="8.5" r="2.2" stroke={stroke} strokeWidth="1.4" />
        </svg>
      )
    case 'document':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M3.5 2h6L12.5 5v9h-9V2Z" stroke={stroke} strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M5.5 8.5h5M5.5 11h5M5.5 6h2" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      )
    case 'video':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M2 5h8.5v6H2z" stroke={stroke} strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M10.5 6.5 14 5v6l-3.5-1.5" stroke={stroke} strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      )
  }
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="m2 8 12-5-5 12-2-5-5-2Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        fill="currentColor"
      />
    </svg>
  )
}
