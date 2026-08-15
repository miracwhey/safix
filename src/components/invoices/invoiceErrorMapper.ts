/**
 * Maps raw invoice workflow errors to user-readable German messages.
 *
 * Called in CraftsmanInvoicesScreen after issueInvoiceWorkflow or
 * markInvoiceSentWorkflow throws. The mapper inspects the error message
 * for known engine patterns and returns a fachlich brauchbare Erklärung.
 *
 * Fallback: generic retry message for unexpected errors.
 */
export function mapInvoiceWorkflowError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)

  // issuerName or issuerAddress is a known placeholder value
  if (msg.includes('placeholder value')) {
    return 'Rechnung kann nicht ausgestellt werden: Deine Ausstellerdaten sind Platzhalterwerte. Bitte hinterlege deinen echten Unternehmensnamen und deine Adresse im Profil.'
  }

  // issuerAddress present but no comma → city-only / incomplete
  if (msg.includes('is incomplete') || msg.includes('full address is required')) {
    return 'Rechnung kann nicht ausgestellt werden: Die hinterlegte Adresse ist unvollständig. Bitte trage eine vollständige Adresse (Straße, PLZ Ort) im Profil ein.'
  }

  // issuerName or issuerAddress is missing entirely
  if (msg.includes('issuerName is missing') || msg.includes('issuerAddress is missing')) {
    return 'Rechnung kann nicht ausgestellt werden: Ausstellerdaten fehlen. Bitte ergänze Unternehmensname und Adresse im Profil.'
  }

  // customerName missing
  if (msg.includes('customerName is missing')) {
    return 'Rechnung kann nicht ausgestellt werden: Kundendaten fehlen.'
  }

  // No line items
  if (msg.includes('lineItems must contain')) {
    return 'Rechnung kann nicht ausgestellt werden: Es sind keine Rechnungspositionen vorhanden.'
  }

  // grossAmount zero or negative
  if (msg.includes('grossAmount must be')) {
    return 'Rechnung kann nicht ausgestellt werden: Der Rechnungsbetrag ist ungültig.'
  }

  // Illegal state machine transition (e.g. sent → issued, draft → sent)
  if (msg.includes('Illegal invoice transition')) {
    return 'Diese Aktion ist im aktuellen Rechnungsstatus nicht möglich.'
  }

  // issueInvoiceWorkflow / markInvoiceSentWorkflow: no invoice for job
  if (msg.includes('no invoice found')) {
    return 'Rechnung konnte nicht gefunden werden.'
  }

  // Unrecognised error
  return 'Aktion fehlgeschlagen. Bitte versuche es erneut.'
}
