import { type LucideIcon } from 'lucide-react'

type IconSize = 'sm' | 'md' | 'lg'

type IconProps = {
  icon: LucideIcon
  size?: IconSize
  className?: string
  'aria-label'?: string
  'aria-hidden'?: boolean
}

const sizeMap: Record<IconSize, number> = {
  sm: 16,
  md: 20,
  lg: 24,
}

/**
 * Wraps a Lucide icon with a consistent size token.
 * Import the icon component directly from lucide-react and pass as `icon` prop.
 *
 * Usage:
 *   import { MapPin } from 'lucide-react'
 *   <Icon icon={MapPin} size="md" />
 *
 * No Emoji. No other icon libraries.
 */
export default function Icon({
  icon: LucideIconComponent,
  size = 'md',
  className = '',
  'aria-label': ariaLabel,
  'aria-hidden': ariaHidden,
}: IconProps) {
  const px = sizeMap[size]
  return (
    <LucideIconComponent
      size={px}
      className={className}
      aria-label={ariaLabel}
      aria-hidden={ariaHidden ?? (ariaLabel ? undefined : true)}
    />
  )
}
