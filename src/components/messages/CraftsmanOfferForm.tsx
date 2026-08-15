import { useState } from 'react'
import { createOfferWorkflow } from '../../lib/workflow/offerWorkflow'
import type { Conversation } from '../../lib/messages/types'

type Props = {
  conversation: Conversation
  onCreated?: () => void
}

/**
 * @deprecated Use QuoteCreationSheet (the full typed Commercial Composer from Paket 3).
 *
 * This minimal form predates documentType typing and sends binding_offer by
 * default without enforcing the commercial hard-gates introduced in Paket 4a
 * (scopeExcluded, paymentTerms, validUntil required for binding_offer).
 *
 * This component is not rendered in any current screen. It will be removed
 * in a future cleanup pass. Do not add new usage.
 */
export default function CraftsmanOfferForm({ conversation, onCreated }: Props) {
  if (import.meta.env.MODE !== 'test') {
    // eslint-disable-next-line no-console
    console.warn(
      '[CraftsmanOfferForm] This component is deprecated and bypasses commercial validation. ' +
      'Use QuoteCreationSheet instead.'
    )
  }
  const [expanded, setExpanded] = useState(false)
  const [price, setPrice] = useState('')
  const [description, setDescription] = useState('')
  const [timingNote, setTimingNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmedPrice = price.trim()
    if (!trimmedPrice || busy) return

    setBusy(true)
    setError(null)
    try {
      await createOfferWorkflow({
        conversationId: conversation.id,
        customerUserId: conversation.customerUserId ?? '',
        craftsmanUserId: conversation.craftsmanUserId ?? '',
        price: trimmedPrice,
        ...(description.trim() && { description: description.trim() }),
        ...(timingNote.trim() && { timingNote: timingNote.trim() }),
      })
      setPrice('')
      setDescription('')
      setTimingNote('')
      setExpanded(false)
      onCreated?.()
    } catch (err) {
      setError(
        err instanceof Error && err.message.includes('Active offer')
          ? 'Es gibt bereits ein offenes Angebot.'
          : 'Angebot konnte nicht erstellt werden.'
      )
    } finally {
      setBusy(false)
    }
  }

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="w-full rounded-[14px] bg-[#2563EB] px-3.5 py-2.5 text-[13px] font-semibold text-white shadow-sm transition active:bg-[#1d4ed8]"
      >
        📋 Angebot erstellen
      </button>
    )
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-[14px] bg-white p-3.5 ring-1 ring-slate-200/70 shadow-[0_8px_20px_-18px_rgba(2,6,23,0.10)]"
    >
      <div className="mb-2 text-[13px] font-semibold text-slate-800">
        Angebot erstellen
      </div>

      <input
        type="text"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        placeholder="Preis (z.B. 1.500 €) *"
        className="mb-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-[13px] text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-400 focus:ring-1 focus:ring-blue-400"
        disabled={busy}
        required
      />

      <input
        type="text"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Beschreibung (optional)"
        className="mb-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-[13px] text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-400 focus:ring-1 focus:ring-blue-400"
        disabled={busy}
      />

      <input
        type="text"
        value={timingNote}
        onChange={(e) => setTimingNote(e.target.value)}
        placeholder="Zeitrahmen (optional)"
        className="mb-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-[13px] text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-400 focus:ring-1 focus:ring-blue-400"
        disabled={busy}
      />

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || !price.trim()}
          className="flex-1 rounded-full bg-[#2563EB] px-3 py-2 text-[12px] font-semibold text-white shadow-sm transition active:bg-[#1d4ed8] disabled:opacity-50"
        >
          {busy ? '…' : 'Angebot senden'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => { setExpanded(false); setError(null) }}
          className="rounded-full bg-white px-3 py-2 text-[12px] font-semibold text-slate-600 ring-1 ring-slate-200 shadow-sm transition active:bg-slate-50 disabled:opacity-50"
        >
          Abbrechen
        </button>
      </div>

      {error && (
        <p className="mt-2 text-[12px] text-red-500" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}
