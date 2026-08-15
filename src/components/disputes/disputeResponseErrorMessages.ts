/**
 * User-facing error messages for dispute-response submit attempts.
 * Lives next to the composer but is split out so the composer file only
 * exports a React component (react-refresh contract).
 */
import {
  DisputeResponseError,
  type DisputeResponseErrorCode,
} from '../../lib/workflow/disputeResponseWorkflow'
import { RbacError, type RbacErrorCode } from '../../lib/auth/rbacGuards'

export function mapDisputeResponseSubmitError(err: unknown): string {
  if (err instanceof DisputeResponseError) {
    return mapResponseError(err.code)
  }
  if (err instanceof RbacError) {
    return mapRbacError(err.code)
  }
  return 'Senden fehlgeschlagen. Bitte später erneut versuchen oder Support kontaktieren.'
}

function mapResponseError(code: DisputeResponseErrorCode): string {
  switch (code) {
    case 'dispute_response_empty':
      return 'Stellungnahme darf nicht leer sein.'
    case 'dispute_not_awaiting_response':
      return 'Der Streitfall steht nicht mehr auf Stellungnahme — vermutlich hat SaFix/Operator den Fall bereits übernommen. Bitte Seite neu laden.'
    case 'dispute_terminal':
      return 'Streitfall ist abgeschlossen — Stellungnahme nicht mehr möglich.'
    case 'dispute_not_found':
      return 'Streitfall nicht mehr verfügbar. Bitte Seite neu laden.'
    case 'job_not_found':
      return 'Auftrag nicht mehr verfügbar.'
    default:
      return 'Senden fehlgeschlagen.'
  }
}

function mapRbacError(code: RbacErrorCode): string {
  switch (code) {
    case 'rbac_owner':
      return 'Nur der Inhaber kann diese Stellungnahme an SaFix senden.'
    case 'rbac_customer':
      return 'Nur der Auftraggeber kann diese Stellungnahme an SaFix senden.'
    default:
      return 'Du hast keine Berechtigung, diese Stellungnahme zu senden.'
  }
}
