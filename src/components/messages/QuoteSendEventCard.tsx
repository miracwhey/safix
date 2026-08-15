import { Link } from 'react-router-dom'
import type { MessageRole } from '../../lib/messages'
import type { OfferPaymentArtifact } from '../../lib/messages/threadArtifactTypes'
import type { OfferDocumentType } from '../../lib/offers/types'
import { ArtifactCardShell } from '../chat/ArtifactCardShell'
import {
  type ArtifactCardView,
  type StatusTone,
  tone,
  TYPE_LABEL,
  OFFER_DOCTYPE_LABEL,
  OFFER_STATUS_LABEL_BY_PHASE,
} from '../chat/artifactCardVocab'

type Props = {
  artifact: OfferPaymentArtifact
  timeLabel: string
  role: MessageRole
  /**
   * True when a funded funding step has superseded this offer for the same
   * canonical context (jobId). The card stays as historical context but its
   * status is muted (passive tone) so it does not compete with the funding card.
   */
  superseded?: boolean
}

/**
 * Renders a commercial-document (Angebot / Kostenvoranschlag / Schätzung /
 * Diagnose) send event inline in the chat timeline (V5 redesign 2026-06-23:
 * now renders through the shared `ArtifactCardShell` — identical shell +
 * vocabulary as every other stream artifact card; full-width, no
 * outgoing/incoming alignment).
 *
 * Decision 1 (2026-06-23): NO price on the Angebot card — the prominent line is
 * the project title; the price lives on the detail screen only.
 *
 * Data source: canonical OfferPaymentArtifact from thread_artifacts.
 */
export default function QuoteSendEventCard({ artifact, timeLabel, role, superseded = false }: Props) {
  const { offer, snapshot, phase, documentType } = artifact
  const docType: OfferDocumentType = documentType ?? 'binding_offer'

  const isPaymentPhase = phase === 'payment_due' || phase === 'diagnosis_payment_due'
  const statusKey = isPaymentPhase ? phase : (offer?.status ?? phase ?? 'sent')

  const title = offer?.projectTitleSnapshot?.trim()
    || snapshot?.summary?.trim()
    || offer?.description?.trim()
    || 'Angebot'

  // Superseded offers are passive context → mute the tone to slate.
  const statusTone: StatusTone = superseded ? 'expired' : tone(statusKey)

  const view: ArtifactCardView = {
    iconKey: 'OfferPayment',
    typeLabel: OFFER_DOCTYPE_LABEL[docType] ?? TYPE_LABEL.OfferPayment,
    prominent: title,
    prominentKind: 'title',
    statusLabel: OFFER_STATUS_LABEL_BY_PHASE[statusKey] ?? statusKey,
    statusTone,
  }

  const offerId = offer?.id ?? snapshot?.offerId
  const detailPath = offerId
    ? role === 'craftsman'
      ? `/craftsman/quotes/${offerId}`
      : `/quotes/${offerId}`
    : null

  return (
    <div className="mx-4 my-1.5" data-testid="quote-send-event">
      {detailPath ? (
        <Link
          to={detailPath}
          data-testid="quote-send-event-link"
          className="block cursor-pointer select-none transition hover:-translate-y-px active:translate-y-0"
        >
          <ArtifactCardShell view={view} testid="artifact-card-offer" />
        </Link>
      ) : (
        <ArtifactCardShell view={view} testid="artifact-card-offer" />
      )}
      <div className="mt-0.5 px-1 text-[10px] text-slate-400">{timeLabel}</div>
    </div>
  )
}
