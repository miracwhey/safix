type SurfaceProps = {
  children: React.ReactNode
  variant?: 'default' | 'elevated'
  className?: string
}

/**
 * Base container for all card-like UI surfaces.
 * Enforces the two-shadow / two-radius system.
 * Spacing is the caller's responsibility.
 */
export default function Surface({ children, variant = 'default', className = '' }: SurfaceProps) {
  const shadow = variant === 'elevated' ? 'shadow-elevated' : 'shadow-subtle'
  return (
    <div className={`rounded-container bg-surface ${shadow} ${className}`}>
      {children}
    </div>
  )
}
