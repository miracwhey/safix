type StickyBottomActionProps = {
  label: string
  onClick?: () => void
  disabled?: boolean
  loading?: boolean
  type?: 'button' | 'submit'
}

/**
 * Sticky primary CTA anchored to the bottom of the screen.
 * Respects safe-area-inset-bottom. Always bg-brand.
 * Use for: payment release, offer accept, confirm, submit.
 * One per screen maximum.
 */
export default function StickyBottomAction({
  label,
  onClick,
  disabled = false,
  loading = false,
  type = 'button',
}: StickyBottomActionProps) {
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-30 bg-canvas/90 px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3 backdrop-blur-sm"
    >
      <button
        type={type}
        onClick={onClick}
        disabled={disabled || loading}
        className="
          w-full rounded-container bg-brand py-3.5
          text-[15px] font-semibold text-white
          shadow-elevated
          transition-transform duration-150
          active:scale-[0.98]
          disabled:opacity-40
        "
      >
        {loading ? 'Bitte warten…' : label}
      </button>
    </div>
  )
}
