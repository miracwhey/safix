/**
 * Funding Request — Status Semantics (pure predicates)
 *
 * Single, grep-auditable source of truth for classifying a raw
 * `FundingRequestStatus` string. Deliberately free of any service/repository
 * imports so that pure read-selectors can consume it without transitively
 * loading persistence modules.
 */

/**
 * Terminal-dead funding statuses — the request can never transition to
 * `'funded'` and can never be paid:
 *
 *   - `'expired'`   — lapsed without funding (live producers: the
 *                     `expire-funding-requests` cron and the synchronous
 *                     expiry gate in `api/initiate-funding.ts`).
 *   - `'cancelled'` — request was cancelled (enum-terminal).
 *
 * A paid attempt against such a request returns HTTP 409
 * `FUNDING_REQUEST_EXPIRED`; recovery requires the provider to send a NEW
 * funding request (a separate row).
 *
 * Any surface that consumes the RAW `FundingRequestStatus` (i.e. NOT the
 * `MoneyFlowProjection`) must special-case these so it never presents a
 * pay-now / pending call-to-action on a dead request.
 *
 * @param status — raw `FundingRequestStatus` (or undefined/null when unknown)
 */
export function isFundingRequestTerminalDead(status?: string | null): boolean {
  return status === 'expired' || status === 'cancelled'
}
