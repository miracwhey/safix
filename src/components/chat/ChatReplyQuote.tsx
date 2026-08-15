type Props = {
  senderName: string
  preview: string
  /** Whether the surrounding bubble is the user's own (mirrors accent colour). */
  isOwnBubble: boolean
  /** Optional click handler — taps the quote to scroll to the original message. */
  onPress?: () => void
}

/**
 * In-bubble Reply-Quote (ADR D-5/D-7). Renders a vertical accent-bar plus a
 * one-line truncated preview of the original message. Sits *inside* the
 * surrounding ChatBubble, above the body text.
 */
export function ChatReplyQuote({ senderName, preview, isOwnBubble, onPress }: Props) {
  const accentClass = isOwnBubble ? 'bg-white/70' : 'bg-blue-400'
  const nameClass = isOwnBubble ? 'text-white/90' : 'text-blue-700'
  const previewClass = isOwnBubble ? 'text-white/70' : 'text-slate-600'
  const containerClass = isOwnBubble ? 'bg-white/10' : 'bg-slate-50'

  const content = (
    <div className={`flex gap-2 rounded-lg ${containerClass} p-2`}>
      <span className={`w-1 self-stretch rounded-full ${accentClass}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className={`truncate text-[11px] font-semibold ${nameClass}`}>{senderName}</div>
        <div className={`truncate text-[12px] ${previewClass}`}>{preview}</div>
      </div>
    </div>
  )

  if (!onPress) return <div className="mb-1.5">{content}</div>

  return (
    <button
      type="button"
      onClick={onPress}
      className="mb-1.5 block w-full text-left transition active:scale-[0.99]"
    >
      {content}
    </button>
  )
}
