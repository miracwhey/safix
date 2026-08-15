/**
 * Funding Entry API Client — Server-authoritative funding entry read.
 *
 * Calls GET /api/funding-entry?fundingRequestId=<id> to load the full
 * canonical payment context from the server.  The returned payload is
 * sufficient for the FundingEntryScreen to render the payment UI
 * immediately, without depending on warm client-side stores.
 */

import { supabase } from '../supabase'
import { apiUrl } from '../api/baseUrl'
import type { FundingRequestStatus } from '../payments/fundingRequest/types'
import type { EscrowPlanStatus } from '../payments/escrow/escrowTypes'

// ---------------------------------------------------------------------------
// Response shape (mirrors the server-side payload)
// ---------------------------------------------------------------------------

export type FundingEntryPayload = {
  fundingRequest: {
    id: string
    sourceOfferId: string
    jobId: string
    escrowPlanId: string
    customerUserId: string
    providerId: string
    providerUserId: string
    type: string
    status: FundingRequestStatus
    amount: number
    currency: string
    createdBy: string
    conversationId?: string
    messageId?: string
    createdAt: string
    updatedAt: string
    sentAt?: string
    fundedAt?: string
    externalFundingRef?: string
    fundingIdempotencyKey?: string
    failureReason?: string
  }
  escrowPlan: {
    id: string
    sourceOfferId: string
    jobId: string
    customerUserId: string
    providerId: string
    currency: string
    totalAmount: number
    fundingMode: string
    releaseModel: string
    status: EscrowPlanStatus
    createdAt: string
    updatedAt: string
    fundingInitiatedAt?: string
    fundedAt?: string
    externalFundingRef?: string
    fundingIdempotencyKey?: string
  }
  job: {
    id: string
    status: string
  }
  project?: {
    id: string
    title?: string
  }
}

// ---------------------------------------------------------------------------
// Error codes returned by the server endpoint
// ---------------------------------------------------------------------------

export type FundingEntryErrorCode =
  | 'FUNDING_REQUEST_NOT_FOUND'
  | 'FUNDING_REQUEST_NOT_ACCESSIBLE'
  | 'ESCROW_PLAN_NOT_FOUND'
  | 'JOB_CONTEXT_NOT_FOUND'

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type FundingEntryReadSuccess = {
  ok: true
  data: FundingEntryPayload
}

export type FundingEntryReadError = {
  ok: false
  errorCode?: FundingEntryErrorCode
  message: string
  statusCode?: number
}

export type FundingEntryReadResult =
  | FundingEntryReadSuccess
  | FundingEntryReadError

// ---------------------------------------------------------------------------
// German error messages for each server error code
// ---------------------------------------------------------------------------

const ERROR_MESSAGES: Record<FundingEntryErrorCode, string> = {
  FUNDING_REQUEST_NOT_FOUND: 'Zahlungsanfrage nicht gefunden.',
  FUNDING_REQUEST_NOT_ACCESSIBLE: 'Sie haben keinen Zugriff auf diese Zahlungsanfrage.',
  ESCROW_PLAN_NOT_FOUND: 'Zahlungsplan konnte nicht geladen werden.',
  JOB_CONTEXT_NOT_FOUND: 'Zahlungskontext konnte nicht geladen werden.',
}

function mapErrorCodeToMessage(errorCode?: string, fallback?: string): string {
  if (errorCode && errorCode in ERROR_MESSAGES) {
    return ERROR_MESSAGES[errorCode as FundingEntryErrorCode]
  }
  return fallback ?? 'Zahlungsdaten konnten nicht geladen werden.'
}

// ---------------------------------------------------------------------------
// Main fetch function
// ---------------------------------------------------------------------------

/**
 * Fetches the full canonical payment context for a funding request
 * from the server-authoritative endpoint.
 *
 * @param fundingRequestId — the funding request ID from the route param
 */
export async function fetchFundingEntry(
  fundingRequestId: string,
): Promise<FundingEntryReadResult> {
  try {
    const { data: sessionData } = await supabase.auth.getSession()
    const token = sessionData?.session?.access_token

    const headers: Record<string, string> = {}
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    const url = apiUrl(
      `/api/funding-entry?fundingRequestId=${encodeURIComponent(fundingRequestId)}`,
    )

    const response = await fetch(url, {
      method: 'GET',
      headers,
    })

    if (!response.ok) {
      const body = await response.json().catch(() => ({} as Record<string, unknown>))
      const errorCode = typeof body.errorCode === 'string' ? body.errorCode : undefined
      const errorMessage = typeof body.error === 'string' ? body.error : undefined
      return {
        ok: false,
        errorCode: errorCode as FundingEntryErrorCode | undefined,
        message: mapErrorCodeToMessage(errorCode, errorMessage),
        statusCode: response.status,
      }
    }

    const data: FundingEntryPayload = await response.json()
    return { ok: true, data }
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Netzwerkfehler beim Laden der Zahlungsdaten.',
    }
  }
}
