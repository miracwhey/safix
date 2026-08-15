import { useNavigate } from 'react-router-dom'
import type { CraftsmanAction } from '../../lib/finance/craftsmanActions'
import ContentSection from '../primitives/ContentSection'
import Icon from '../primitives/Icon'

type ActionItemsSectionProps = {
  actions: CraftsmanAction[]
}

export default function ActionItemsSection({ actions }: ActionItemsSectionProps) {
  const navigate = useNavigate()

  if (actions.length === 0) return null

  return (
    <ContentSection eyebrow="Handlungsbedarf" title="Das steht an">
      <div className="space-y-2">
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            onClick={() => navigate(action.navigateTo)}
            className={`
              flex w-full items-center gap-3 rounded-card bg-surface p-3
              ring-1 ${action.color}
              text-left transition-transform duration-150 active:scale-[0.98]
            `}
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-slate-100 text-ink-sub">
              <Icon icon={action.icon} size="md" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-semibold text-ink">{action.label}</p>
            </div>
            <span className="shrink-0 text-[13px] font-semibold text-brand">
              {action.cta} →
            </span>
          </button>
        ))}
      </div>
    </ContentSection>
  )
}
