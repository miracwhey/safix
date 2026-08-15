import type { MessageRole, ThreadArtifacts } from '../../lib/messages'
import { FUNDING_ACTIVE_CTA_PHASES } from '../../lib/messages/threadArtifactTypes'
import ThreadArtifactProjectCard from './ThreadArtifactProjectCard'
import ThreadArtifactOfferCard from './ThreadArtifactOfferCard'
import ThreadArtifactFundingCard from './ThreadArtifactFundingCard'
import ThreadArtifactChangeOrderCard from './ThreadArtifactChangeOrderCard'
import ThreadArtifactScanCard from './ThreadArtifactScanCard'

type Props = {
  artifacts: ThreadArtifacts
  role: MessageRole
  onSetActiveProject?: (projectId: string) => void
  onOfferUpdated?: () => void
}

function ArtifactSkeleton({ label }: { label: string }) {
  return (
    <div className="animate-pulse rounded-[12px] bg-white px-3 py-2 ring-1 ring-slate-200/50">
      <div className="flex items-center gap-2">
        <div className="h-3 w-14 rounded-full bg-slate-100" />
        <div className="h-3 w-20 rounded bg-slate-100" />
      </div>
      <span className="sr-only">{label} wird geladen…</span>
    </div>
  )
}

/**
 * LAYER 1 — PERSISTENT CONTEXT container.
 *
 * Renders canonical business-card artifacts above the timeline.
 * These are persistent context (active project, current offer status) —
 * visually distinct from historical timeline event cards below.
 *
 * SINGLE ACTIVE PROJECT: only the active/main project is rendered in this
 * top context area.  All project cards (including the active one) also
 * appear as historical events in the timeline below.  This prevents
 * multiple top context bars when several projects have been sent.
 */
export default function ThreadArtifactCards({ artifacts, role, onSetActiveProject, onOfferUpdated }: Props) {
  const {
    projectArtifacts,
    offerPaymentArtifact,
    fundingStepArtifact,
    changeOrderArtifacts,
    offerFundingSuperseded,
    pendingProjectArtifact,
    pendingOfferArtifact,
    pendingFundingArtifact,
  } = artifacts

  // Only the active/main project is shown in the persistent top context.
  const activeProject = projectArtifacts.find((a) => a.isActiveProject) ?? null

  // ── Card hierarchy: suppress offer from persistent context when superseded ──
  // When the funding step is the canonical funded confirmation for the same
  // canonical context (jobId), the offer card is redundant in the persistent
  // area (both would show green confirmation).  The offer event still appears
  // as historical context in the timeline below.
  const showOffer = !!offerPaymentArtifact && !offerFundingSuperseded

  // ── Workflow-first ordering in persistent context (Block 3.5) ─────────
  // When the funding step is the primary active card for the same canonical
  // context (active CTA phase: sent / funding_started / funding_initiated),
  // it should appear ABOVE the offer card so the user sees the current
  // action surface first rather than stale context above the CTA.
  // Context scoping: only reorders when jobIds match (same canonical context).
  const isFundingActiveCTA =
    !!fundingStepArtifact &&
    FUNDING_ACTIVE_CTA_PHASES.has(fundingStepArtifact.phase)
  const fundingBeforeOffer =
    showOffer &&
    isFundingActiveCTA &&
    !!offerPaymentArtifact?.jobId &&
    offerPaymentArtifact.jobId === fundingStepArtifact!.jobId

  // Only show pending ChangeOrder cards in the persistent context area.
  // Accepted/declined/cancelled COs are historical — they live in the timeline.
  const pendingChangeOrders = changeOrderArtifacts.filter((co) => co.status === 'pending')

  const hasContent =
    activeProject != null || showOffer || fundingStepArtifact || pendingProjectArtifact || pendingOfferArtifact || pendingFundingArtifact || pendingChangeOrders.length > 0

  if (!hasContent) return null

  // ── Offer card element (reused by both ordering branches) ──
  const offerElement = showOffer ? (
    <ThreadArtifactOfferCard artifact={offerPaymentArtifact!} role={role} onUpdated={onOfferUpdated} />
  ) : null

  // ── Funding card element (reused by both ordering branches) ──
  const fundingElement = fundingStepArtifact ? (
    <ThreadArtifactFundingCard artifact={fundingStepArtifact} role={role} />
  ) : null

  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {pendingProjectArtifact && !activeProject && (
        <ArtifactSkeleton label="Projekt" />
      )}
      {activeProject && (
        <ThreadArtifactProjectCard
          key={activeProject.artifactId}
          artifact={activeProject}
          role={role}
          onSetActive={onSetActiveProject}
        />
      )}
      {activeProject?.project?.roomScanUrl && activeProject.project.roomScanMetadata && (() => {
        // snapshot?.projectId is always available at first render; project?.id requires hydration
        const projectId = activeProject.snapshot?.projectId ?? activeProject.project?.id
        return projectId ? (
          <ThreadArtifactScanCard
            projectId={projectId}
            metadata={activeProject.project.roomScanMetadata}
          />
        ) : null
      })()}
      {pendingOfferArtifact && !offerPaymentArtifact && (
        <ArtifactSkeleton label="Angebot" />
      )}
      {/* Workflow-first ordering: funding CTA above passive offer context */}
      {fundingBeforeOffer ? (
        <>
          {pendingFundingArtifact && !fundingStepArtifact && (
            <ArtifactSkeleton label="Einzahlung" />
          )}
          {fundingElement}
          {offerElement}
        </>
      ) : (
        <>
          {offerElement}
          {pendingFundingArtifact && !fundingStepArtifact && (
            <ArtifactSkeleton label="Einzahlung" />
          )}
          {fundingElement}
        </>
      )}
      {/* Pending ChangeOrder cards — each pending Nachtrag gets its own card */}
      {pendingChangeOrders.map((co) => (
        <ThreadArtifactChangeOrderCard
          key={co.artifactId}
          artifact={co}
          role={role}
        />
      ))}
    </div>
  )
}
