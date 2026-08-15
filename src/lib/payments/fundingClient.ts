/**
 * Funding Client — Server-authoritative funding request creation.
 *
 * This module provides the ONLY client-side path for triggering provider
 * funding request creation. It calls the server /api/request-funding
 * endpoint (the authoritative write path) and returns the server response.
 *
 * After a successful server creation, the caller should refresh/revalidate
 * local repo state — NOT perform a second local truth write.
 *
 * The local `requestFundingForJob()` in craftsmanOperations.ts remains
 * available for tests and local orchestration, but the UI component
 * MUST use this server-authoritative path at runtime.
 */

import { supabase } from '../supabase'
import { apiUrl } from '../api/baseUrl'

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type ServerFundingCreationSuccess = {
  ok: true
  data: {
    fundingRequestId: string
    fundingRequestStatus: string
    escrowPlanId: string
    escrowPlanStatus: string
    jobId: string
    amount: number
    currency: string
    /** Conversation ID linked to the funding artifact */
    conversationId?: string | null
    /** True when the server returned this as an idempotent re-read */
    idempotent?: boolean
    /** Whether the escrow plan was newly created (vs reused) */
    escrowPlanCreated?: boolean
    /** Whether the funding request was newly created (vs reused) */
    fundingRequestCreated?: boolean
    /** Whether the thread artifact was newly created */
    artifactCreated?: boolean
    /** Whether an existing thread artifact was reused */
    artifactReused?: boolean
  }
}

export type ServerFundingCreationError = {
  ok: false
  message: string
  /** Structured error code from the server */
  code?: string
  /** HTTP status code from server */
  statusCode?: number
}

export type ServerFundingCreationResult =
  | ServerFundingCreationSuccess
  | ServerFundingCreationError

// ---------------------------------------------------------------------------
// Error code → German user-facing message mapping
// ---------------------------------------------------------------------------

const ERROR_CODE_MESSAGES: Record<string, string> = {
  JOB_QUERY_FAILED: 'Die Auftragsdaten konnten nicht abgefragt werden. Bitte versuche es erneut.',
  JOB_LOOKUP_FAILED: 'Der Auftrag konnte nicht abgerufen werden. Bitte versuche es erneut.',
  CANONICAL_JOB_NOT_FOUND: 'Der Auftrag wurde nicht gefunden.',
  STALE_JOB_REDIRECT_FAILED: 'Der Auftrag konnte nicht dem aktuellen Angebot zugeordnet werden.',
  SOURCE_OFFER_MISSING: 'Die Angebotszuordnung fehlt. Bitte prüfe den Auftrag.',
  ACCEPTED_OFFER_NOT_FOUND: 'Das akzeptierte Angebot wurde nicht gefunden.',
  CUSTOMER_LINKAGE_MISSING: 'Die Kundenzuordnung fehlt auf dem Auftrag.',
  PROVIDER_PROFILE_NOT_FOUND: 'Das Handwerkerprofil wurde nicht gefunden. Bitte prüfe dein Profil.',
  PROVIDER_LINKAGE_MISSING: 'Die Handwerkerzuordnung fehlt auf dem Auftrag.',
  PROVIDER_NOT_AUTHORIZED: 'Du bist nicht als Handwerker für diesen Auftrag berechtigt.',
  INVALID_AMOUNT_BASIS: 'Der Auftragswert konnte nicht ermittelt werden.',
  JOB_IN_TERMINAL_STATE: 'Der Auftrag ist bereits abgeschlossen oder storniert.',
  NO_ACCEPTED_QUOTE: 'Es liegt kein angenommenes Angebot vor.',
  ESCROW_PLAN_CREATE_FAILED: 'Der Zahlungsplan konnte nicht erstellt werden.',
  FUNDING_REQUEST_CREATE_FAILED: 'Die Zahlungsaufforderung konnte nicht erstellt werden.',
  FUNDING_ARTIFACT_CREATE_FAILED: 'Der Zahlungsschritt konnte nicht in der Konversation angezeigt werden.',
}

/**
 * Map a structured server error code to a German user-facing message.
 * Falls back to the raw server message if no mapping exists.
 */
export function mapFundingErrorToMessage(code: string | undefined, fallback: string): string {
  if (code && ERROR_CODE_MESSAGES[code]) {
    return ERROR_CODE_MESSAGES[code]
  }
  return fallback
}

// ---------------------------------------------------------------------------
// Core funding request creation
// ---------------------------------------------------------------------------

/**
 * Request provider funding creation via the server API.
 *
 * This is the single authoritative path for client-side code.
 * The server validates canonical data, creates/reuses escrow plan +
 * funding request + thread artifact, and returns the canonical state.
 *
 * Idempotent: repeated calls return the same result without creating
 * duplicates.
 *
 * @param jobId — ID of the job to create funding request for
 */
export async function requestServerFundingCreation(
  jobId: string,
): Promise<ServerFundingCreationResult> {
  try {
    // Retrieve the current Supabase session token for authenticated API calls
    const { data: sessionData } = await supabase.auth.getSession()
    const token = sessionData?.session?.access_token

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    const response = await fetch(apiUrl('/api/request-funding'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ jobId }),
    })

    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: 'Unknown server error' }))
      return {
        ok: false,
        message: mapFundingErrorToMessage(body.code, body.error ?? `Server-Fehler (${response.status})`),
        code: body.code,
        statusCode: response.status,
      }
    }

    const data = await response.json()
    return {
      ok: true,
      data: {
        fundingRequestId: data.fundingRequestId,
        fundingRequestStatus: data.fundingRequestStatus,
        escrowPlanId: data.escrowPlanId,
        escrowPlanStatus: data.escrowPlanStatus,
        jobId: data.jobId,
        amount: data.amount,
        currency: data.currency ?? 'EUR',
        conversationId: data.conversationId ?? null,
        idempotent: data.idempotent ?? false,
        escrowPlanCreated: data.escrowPlanCreated ?? false,
        fundingRequestCreated: data.fundingRequestCreated ?? false,
        artifactCreated: data.artifactCreated ?? false,
        artifactReused: data.artifactReused ?? false,
      },
    }
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Netzwerkfehler bei der Zahlungsaufforderung.',
    }
  }
}
