/**
 * Block D Slice 2 M1 — Compact artifact card routing map.
 *
 * Pure data-driven mapping from `(artifactType, role, state, documentType)`
 * to the detail-screen path that a `ChatArtifactCardCompact` tap navigates to.
 *
 * Canonical source: `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/
 * SaFix/assets/chat-design/chat-design-system-v3.html` Lines 1411-1422 +
 * cross-checked against `ThreadArtifact{Project,Offer,Funding,ChangeOrder}Card`
 * detail paths.
 *
 * Architektur-Regel: pure function, no domain calls, no side effects.
 * The fallback path logs to Sentry via `logError` and returns `/` — the card
 * remains tappable but does not silently mis-route.
 */

import { logError } from '../../lib/observability'
import type { ChatRole } from '../../lib/chat'

/**
 * Canonical artifact types that render as compact cards in the chat timeline.
 *
 * Verified against `src/components/messages/ThreadArtifact*Card.tsx`:
 *   - `Project` ← ThreadArtifactProjectCard
 *   - `OfferPayment` ← ThreadArtifactOfferCard
 *   - `FundingStep` ← ThreadArtifactFundingCard
 *   - `ChangeOrder` ← ThreadArtifactChangeOrderCard
 *
 * Invoice (Rechnung) renders as an artifact_card in the stream (Block 2 — its
 * own producer in markInvoiceSentWorkflow). Rating / Dispute domains still do
 * NOT — they have their own surfaces.
 */
export type ChatArtifactType = 'Project' | 'OfferPayment' | 'FundingStep' | 'ChangeOrder' | 'Invoice'

/**
 * Offer document subtypes (`documentType` on an `OfferPayment` artifact).
 * Informational only for routing — all offer states resolve to the quote
 * detail surface; payment is reached from there, not via a funding deep-link.
 */
export type OfferDocumentSubtype = 'binding_offer' | 'estimate' | 'diagnosis' | 'cost_estimate'

export interface ArtifactRouteContext {
  artifactType: string
  artifactId: string
  role: ChatRole
  /** Lifecycle state of the artifact (e.g. 'sent', 'accepted', 'payment_due'). */
  state?: string | null
  /** Offer document type — only meaningful when artifactType === 'OfferPayment'. */
  documentType?: string | null
}

/**
 * Resolve the detail-screen path for a compact artifact card.
 *
 * Returns a non-empty path string. On unknown `artifactType` the function
 * logs an error via `logError` and returns `/` — the card stays interactive
 * but the user lands on the safe root rather than a 404.
 */
export function getArtifactRoute(ctx: ArtifactRouteContext): string {
  const { artifactType, artifactId, role, state, documentType } = ctx

  switch (artifactType) {
    case 'Project':
      // Role-aware (mirrors getProjectDetailPath): the customer (owner) opens
      // their own project surface; a recipient craftsman/worker/owner inspects
      // the shared project via the craftsman request-detail view. The customer
      // route (CustomerProjectDetailScreen) would render "not found" for a
      // craftsman, who does not own the project.
      if (role === 'craftsman' || role === 'worker' || role === 'owner') {
        return `/craftsman/request/${artifactId}`
      }
      return `/projects/${artifactId}`

    case 'OfferPayment': {
      // Note: payment-due offers are NOT routed to /funding here — the card
      // carries the OFFER id, not a funding-request id, so a funding path would
      // be doubly wrong (wrong id + broken /funding/request/ shape). The compact
      // card maps payment phases onto 'accepted' (offerRouteState) and the
      // canonical decision surface with the payment CTA is the quote detail.
      // Accepted / declined / cancelled offers: read-only quote detail, no
      // craftsman prefix (canonical decision surface is the customer route).
      if (state === 'accepted' || state === 'declined' || state === 'cancelled') {
        return `/quotes/${artifactId}`
      }
      // sent / draft → role-specific quote detail (craftsman sees pro view).
      // documentType is informational only here; both binding_offer and
      // diagnosis route to the same persona path for `sent`.
      void documentType
      if (role === 'craftsman' || role === 'worker' || role === 'owner') {
        return `/craftsman/quotes/${artifactId}`
      }
      return `/quotes/${artifactId}`
    }

    case 'FundingStep':
      // Canonical funding entry path (mirrors buildFundingEntryPath). The old
      // 3-segment `/funding/request/{id}` did not match the `/funding/:id`
      // route → fell through the catch-all to home (dead tap; fixed 2026-06-23).
      return `/funding/${artifactId}`

    case 'ChangeOrder': {
      if (state === 'pending') {
        if (role === 'craftsman' || role === 'worker' || role === 'owner') {
          return `/craftsman/nachtrag/${artifactId}`
        }
        return `/nachtrag/${artifactId}`
      }
      // accepted / declined / cancelled → canonical (non-prefixed) detail
      return `/nachtrag/${artifactId}`
    }

    case 'Invoice':
      // Role-aware Rechnung detail. The customer opens the canonical
      // (non-prefixed) invoice detail; the craftsman opens the prefixed view.
      if (role === 'craftsman' || role === 'worker' || role === 'owner') {
        return `/craftsman/rechnung/${artifactId}`
      }
      return `/rechnung/${artifactId}`

    default:
      logError('chat.unknown_artifact_route', new Error('Unknown artifact type'), {
        artifactType,
        artifactId,
        role,
        state: state ?? null,
      })
      return '/'
  }
}

/**
 * Canonical artifact-type set — useful for exhaustive coverage tests and
 * for narrowing arbitrary `string` artifactType values to the union type.
 */
export const KNOWN_ARTIFACT_TYPES: ReadonlyArray<ChatArtifactType> = [
  'Project',
  'OfferPayment',
  'FundingStep',
  'ChangeOrder',
  'Invoice',
]

export function isKnownArtifactType(value: string): value is ChatArtifactType {
  return (KNOWN_ARTIFACT_TYPES as ReadonlyArray<string>).includes(value)
}
