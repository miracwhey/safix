/**
 * SystemMessageBubble — Block 3.
 *
 * Renders an `internal_messages` row with sender_kind='system'. These come
 * from server endpoints (e.g. absence-notify) and have no human author.
 *
 * Visual contract: centered, muted background, no avatar, smaller type than
 * a regular bubble. The intent is "out-of-band notice" — readers should
 * understand at a glance that this is not someone speaking, but the system
 * announcing a state change.
 */

type Props = {
  body: string
  createdAt: number
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
}

export function SystemMessageBubble({ body, createdAt }: Props) {
  return (
    <div className="flex justify-center my-2 px-4">
      <div className="max-w-[85%] rounded-full bg-neutral-100 px-3 py-1.5 text-center">
        <p className="text-xs text-neutral-600 leading-snug">
          <span>{body}</span>
          <span className="ml-2 text-neutral-400">{formatTime(createdAt)}</span>
        </p>
      </div>
    </div>
  )
}
