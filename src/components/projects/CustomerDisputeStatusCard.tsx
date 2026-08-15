import { useState } from 'react'
import DisputeResolutionCard from '../disputes/DisputeResolutionCard'
import DisputeResponseComposer from '../disputes/DisputeResponseComposer'
import ConsensusSplitSlot from '../disputes/ConsensusSplitSlot'
import {
  getDisputeByJobId,
  isDisputeRepositoryHydrated,
  mapToDisputeCenterItem,
  subscribeDisputes,
  type DisputeCenterItem,
} from '../../lib/disputes'
import {
  canSubmitDisputeResponse,
  deriveDisputeResponseDeadline,
} from '../../lib/disputes/disputeResponseSelectors'
import {
  getArtifactsByDisputeId,
  getArtifactViewModels,
  subscribeMedia,
  type MediaArtifactViewModel,
} from '../../lib/media'
import { getJobById, subscribeJobs } from '../../lib/jobs'
import type { Job } from '../../lib/jobs/types'
import { useStoreSync } from '../../lib/reactive'
import { useSession } from '../../hooks/useSession'

type Props = {
  jobId: string
}

export default function CustomerDisputeStatusCard({ jobId }: Props) {
  const session = useSession()
  const [item, setItem] = useState<DisputeCenterItem | undefined>(() => {
    const d = getDisputeByJobId(jobId)
    return d ? mapToDisputeCenterItem(d) : undefined
  })
  const [job, setJob] = useState<Job | undefined>(() => getJobById(jobId))
  const [evidenceArtifacts, setEvidenceArtifacts] = useState<MediaArtifactViewModel[]>(
    () => {
      const d = getDisputeByJobId(jobId)
      return d ? getArtifactViewModels(getArtifactsByDisputeId(d.id)) : []
    }
  )

  useStoreSync(
    [subscribeDisputes, subscribeMedia, subscribeJobs],
    () => {
      const d = getDisputeByJobId(jobId)
      setItem(d ? mapToDisputeCenterItem(d) : undefined)
      setEvidenceArtifacts(d ? getArtifactViewModels(getArtifactsByDisputeId(d.id)) : [])
      setJob(getJobById(jobId))
    },
  )

  // Hydration gate (Z.125): a missing dispute during cold load means "not
  // loaded yet", not "no dispute". Wait for the repo before deciding there is
  // nothing to render.
  if (!isDisputeRepositoryHydrated()) return null
  if (!item) return null

  const sessionContext = {
    userId: session.user?.id ?? '',
    role: session.role,
    craftsmanRole: session.craftsmanRole,
  }
  const canSubmit =
    !!job &&
    canSubmitDisputeResponse({
      dispute: item.dispute,
      session: sessionContext,
      job,
    })
  const deadline = deriveDisputeResponseDeadline(item.dispute)

  const responseSlot = canSubmit ? (
    <DisputeResponseComposer jobId={jobId} deadline={deadline} />
  ) : null

  // Consensus-split (P4 Teil B): the customer is always a dispute party here.
  const consensusSlot = (
    <ConsensusSplitSlot
      dispute={item.dispute}
      jobId={jobId}
      currentUserId={session.user?.id}
      isParty={session.role === 'customer'}
    />
  )

  return (
    <DisputeResolutionCard
      item={item}
      evidenceArtifacts={evidenceArtifacts}
      role="customer"
      ownerUserId={session.user?.id}
      job={job}
      responseSlot={responseSlot}
      consensusSlot={consensusSlot}
    />
  )
}
