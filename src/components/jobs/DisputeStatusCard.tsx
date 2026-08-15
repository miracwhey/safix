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
  shouldShowWorkerResponseHint,
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

export default function DisputeStatusCard({ jobId }: Props) {
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
  const showWorkerHint =
    !!job &&
    shouldShowWorkerResponseHint({
      dispute: item.dispute,
      session: sessionContext,
      job,
    })
  const deadline = deriveDisputeResponseDeadline(item.dispute)

  const responseSlot = canSubmit ? (
    <DisputeResponseComposer jobId={jobId} deadline={deadline} />
  ) : showWorkerHint ? (
    <div className="mt-4 rounded-[18px] bg-blue-50 p-4 ring-1 ring-blue-100">
      <div className="text-[13px] font-semibold text-blue-900">
        Inhaber muss antworten
      </div>
      <div className="mt-1 text-[12px] text-blue-800/80">
        Stellungnahmen an SaFix/Operator gehen ausschließlich vom Inhaber aus.
        Bitte den Inhaber informieren — du siehst hier nur den Streitverlauf.
      </div>
    </div>
  ) : null

  // Owner-only photo/video evidence upload — mirrors N3a Provider-Side D5
  // (Owner-only). Worker is excluded both at the workflow guard and the
  // disputes_update_own_side RLS layer; surface the upload accordingly.
  const ownerUserId =
    session.craftsmanRole === 'owner' ? session.user?.id : undefined

  // Consensus-split (P4 Teil B): the craftsman PARTY is the owner. Workers are
  // RLS-excluded from proposing/confirming, so mirror the owner-only gating.
  const consensusSlot = (
    <ConsensusSplitSlot
      dispute={item.dispute}
      jobId={jobId}
      currentUserId={session.user?.id}
      isParty={session.role === 'craftsman' && session.craftsmanRole === 'owner'}
    />
  )

  return (
    <DisputeResolutionCard
      item={item}
      evidenceArtifacts={evidenceArtifacts}
      role="craftsman"
      ownerUserId={ownerUserId}
      job={job}
      responseSlot={responseSlot}
      consensusSlot={consensusSlot}
    />
  )
}
