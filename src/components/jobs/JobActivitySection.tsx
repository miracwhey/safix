import CraftsmanSectionCard from '../CraftsmanSectionCard'
import type { Job } from '../../lib/jobs'

type Activity = Job['activities'][number]

type Props = {
  activities: Activity[]
}

function getActivityTitle(activity: Activity): string {
  if (
    typeof activity === 'object' &&
    activity !== null &&
    'title' in activity &&
    typeof activity.title === 'string'
  ) {
    return activity.title
  }

  if (
    typeof activity === 'object' &&
    activity !== null &&
    'label' in activity &&
    typeof activity.label === 'string'
  ) {
    return activity.label
  }

  return 'Aktivität'
}

function getActivityDescription(activity: Activity): string | null {
  if (
    typeof activity === 'object' &&
    activity !== null &&
    'description' in activity &&
    typeof activity.description === 'string'
  ) {
    return activity.description
  }

  if (
    typeof activity === 'object' &&
    activity !== null &&
    'text' in activity &&
    typeof activity.text === 'string'
  ) {
    return activity.text
  }

  return null
}

function getActivityDate(activity: Activity): string | null {
  if (
    typeof activity === 'object' &&
    activity !== null &&
    'createdAtLabel' in activity &&
    typeof activity.createdAtLabel === 'string'
  ) {
    return activity.createdAtLabel
  }

  if (
    typeof activity === 'object' &&
    activity !== null &&
    'dateLabel' in activity &&
    typeof activity.dateLabel === 'string'
  ) {
    return activity.dateLabel
  }

  return null
}

function getActivityKey(activity: Activity, index: number): string {
  if (
    typeof activity === 'object' &&
    activity !== null &&
    'id' in activity &&
    typeof activity.id === 'string'
  ) {
    return activity.id
  }

  return `activity-${index}`
}

export default function JobActivitySection({ activities }: Props) {
  return (
    <CraftsmanSectionCard
      eyebrow="Protokoll"
      title="Aktivität"
      subtitle="Chronologische Übersicht über alle relevanten Schritte."
    >
      <div className="space-y-3">
        {activities.map((activity, index) => {
          const title = getActivityTitle(activity)
          const description = getActivityDescription(activity)
          const date = getActivityDate(activity)

          return (
            <div
              key={getActivityKey(activity, index)}
              className="rounded-[18px] bg-slate-50 px-4 py-3 ring-1 ring-slate-200/70"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="text-[14px] font-semibold text-slate-900">
                  {title}
                </div>

                {date ? (
                  <div className="text-[12px] text-slate-400">{date}</div>
                ) : null}
              </div>

              {description ? (
                <div className="mt-2 text-[13px] text-slate-500">
                  {description}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </CraftsmanSectionCard>
  )
}
