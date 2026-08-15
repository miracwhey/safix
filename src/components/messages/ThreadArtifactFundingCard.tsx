import { Link } from 'react-router-dom'
import type { MessageRole } from '../../lib/messages'
import type { FundingStepArtifact } from '../../lib/messages/threadArtifactTypes'
import { buildFundingEntryPath } from '../../lib/funding'
import { ArtifactCardShell } from '../chat/ArtifactCardShell'
import {
  type ArtifactCardView,
  tone,
  TYPE_LABEL,
  FUNDING_STATUS_LABEL,
} from '../chat/artifactCardVocab'

type Props = {
  artifact: FundingStepArtifact
  role: MessageRole
}

/**
 * Renders a funding-step (Zahlung) event inline in the chat timeline (V5
 * redesign 2026-06-23: now renders through the shared `ArtifactCardShell` —
 * identical shell + vocabulary as every other stream artifact card).
 *
 * Decision 2 (2026-06-23): the whole card taps through to the funding detail
 * (`/funding/{id}`) where the payment flow lives — no inline "Jetzt einzahlen"
 * button in the stream. `role` no longer branches the render (the detail screen
 * gates the customer payment action), but is kept for API parity with the other
 * stream cards. Trust copy stays "über Stripe abgesichert" on the detail screen
 * — NEVER "Treuhand/Escrow" (ZAG).
 */
export default function ThreadArtifactFundingCard({ artifact, role: _role }: Props) {
  const { phase, amount, fundingRequestId, snapshot } = artifact
  const displayAmount = amount || snapshot?.amount || 'Zahlung'
  const fundingEntryPath = fundingRequestId ? buildFundingEntryPath(fundingRequestId) : null

  const view: ArtifactCardView = {
    iconKey: 'FundingStep',
    typeLabel: TYPE_LABEL.FundingStep,
    prominent: displayAmount,
    prominentKind: 'amount',
    statusLabel: FUNDING_STATUS_LABEL[phase] ?? snapshot?.phaseLabel ?? phase,
    statusTone: tone(phase),
  }

  return (
    <div className="mx-4 my-1.5" data-testid="funding-step-card">
      {fundingEntryPath ? (
        <Link
          to={fundingEntryPath}
          data-testid="funding-step-card-link"
          className="block cursor-pointer select-none transition hover:-translate-y-px active:translate-y-0"
        >
          <ArtifactCardShell view={view} testid="artifact-card-funding" />
        </Link>
      ) : (
        <ArtifactCardShell view={view} testid="artifact-card-funding" />
      )}
    </div>
  )
}
