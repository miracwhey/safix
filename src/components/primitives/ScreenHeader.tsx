type ScreenHeaderProps = {
  title: string
  eyebrow?: string
  action?: React.ReactNode
  className?: string
}

/**
 * Standard screen title area. Used at the top of every screen.
 * Eyebrow = font-medium uppercase muted label above the title.
 * Action = optional right-aligned element (button, link, badge).
 */
export default function ScreenHeader({ title, eyebrow, action, className = '' }: ScreenHeaderProps) {
  return (
    <div className={`flex items-start justify-between gap-4 ${className}`}>
      <div>
        {eyebrow && (
          <p className="text-[11px] font-medium uppercase tracking-widest text-ink-muted">
            {eyebrow}
          </p>
        )}
        <h1 className="mt-0.5 text-[22px] font-bold leading-tight text-ink">
          {title}
        </h1>
      </div>
      {action && (
        <div className="mt-1 shrink-0">{action}</div>
      )}
    </div>
  )
}
