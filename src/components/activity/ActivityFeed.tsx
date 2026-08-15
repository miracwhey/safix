import { useEffect, useState } from 'react'
import CraftsmanSectionCard from '../CraftsmanSectionCard'
import { getCalendarEntryByJobId } from '../../lib/calendar'
import { getInvoiceByJobId } from '../../lib/invoices'
import { getJobById } from '../../lib/jobs'
import {
  buildProjectTimeline,
  subscribeTimeline,
  type ProjectTimelineEvent,
} from '../../lib/timeline'
import { getPaymentForJobWorkflow } from '../../lib/workflow'
import ActivityFeedItem from './ActivityFeedItem'

type Props = {
  jobId: string
}

function deriveEvents(jobId: string): ProjectTimelineEvent[] {
  const job = getJobById(jobId)
  if (!job) return []
  return buildProjectTimeline({
    job,
    calendarEntry: getCalendarEntryByJobId(jobId),
    invoice: getInvoiceByJobId(jobId),
    payment: getPaymentForJobWorkflow(jobId),
  })
}

export default function ActivityFeed({ jobId }: Props) {
  const [events, setEvents] = useState<ProjectTimelineEvent[]>(() =>
    deriveEvents(jobId)
  )

  useEffect(() => {
    function sync() {
      setEvents(deriveEvents(jobId))
    }

    const unsubTimeline = subscribeTimeline(sync)
    sync()
    return () => {
      unsubTimeline()
    }
  }, [jobId])

  if (events.length === 0) return null

  return (
    <CraftsmanSectionCard
      eyebrow="Aktivitätsverlauf"
      title="Projektverlauf"
      subtitle="Chronologische Übersicht aller Aktivitäten dieses Auftrags."
    >
      <div className="relative">
        {events.map((event, index) => (
          <ActivityFeedItem
            key={event.id}
            event={event}
            isLast={index === events.length - 1}
          />
        ))}
      </div>
    </CraftsmanSectionCard>
  )
}
