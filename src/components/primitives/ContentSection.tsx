type ContentSectionProps = {
  children: React.ReactNode
  title?: string
  eyebrow?: string
  headerRight?: React.ReactNode
  className?: string
}

/**
 * Named content section. Role-neutral replacement for CraftsmanSectionCard.
 * All screens use this for interior sections — no role-specific naming.
 */
export default function ContentSection({
  children,
  title,
  eyebrow,
  headerRight,
  className = '',
}: ContentSectionProps) {
  const hasHeader = eyebrow ?? title ?? headerRight

  return (
    <div className={`rounded-card bg-surface shadow-subtle ${className}`}>
      {hasHeader && (
        <div className="flex items-start justify-between gap-3 px-4 pt-4">
          <div>
            {eyebrow && (
              <p className="text-[11px] font-medium uppercase tracking-widest text-ink-muted">
                {eyebrow}
              </p>
            )}
            {title && (
              <h2 className="mt-0.5 text-[16px] font-semibold text-ink">
                {title}
              </h2>
            )}
          </div>
          {headerRight && <div className="shrink-0">{headerRight}</div>}
        </div>
      )}
      <div className={hasHeader ? 'px-4 pb-4 pt-3' : 'p-4'}>
        {children}
      </div>
    </div>
  )
}
