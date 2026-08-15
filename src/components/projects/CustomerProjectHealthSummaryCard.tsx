import ProjectHealthSummaryCard from '../jobs/ProjectHealthSummaryCard'

type Props = {
  jobId: string
}

/**
 * Customer-facing project health summary card.
 * Renders the same objective health overview as the craftsman view,
 * wired to the same underlying selector and stores.
 */
export default function CustomerProjectHealthSummaryCard({ jobId }: Props) {
  return <ProjectHealthSummaryCard jobId={jobId} />
}
