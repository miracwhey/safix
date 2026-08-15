/**
 * Section identifiers and titles for the legal documents. Lives apart from
 * legalContent.tsx so the latter only exports components — required by the
 * react-refresh/only-export-components lint rule.
 *
 * `inTosGate` marks the documents that are part of the pauschal ToS-Gate
 * acceptance (AGB, Datenschutz, EULA/Community). Impressum and Widerruf are
 * informational/point-of-sale and are only linked, never pauschal accepted.
 * Anbieterbedingungen (B2B) are accepted separately at craftsman onboarding.
 */

export type LegalSection =
  | 'agb'
  | 'anbieter_agb'
  | 'avv'
  | 'datenschutz'
  | 'widerruf'
  | 'eula'
  | 'impressum'

export const LEGAL_SECTIONS: Array<{
  id: LegalSection
  title: string
  inTosGate: boolean
}> = [
  { id: 'agb', title: 'AGB', inTosGate: true },
  { id: 'anbieter_agb', title: 'Anbieterbedingungen', inTosGate: false },
  { id: 'avv', title: 'Auftragsverarbeitung', inTosGate: false },
  { id: 'datenschutz', title: 'Datenschutz', inTosGate: true },
  { id: 'widerruf', title: 'Widerruf', inTosGate: false },
  { id: 'eula', title: 'Community-Richtlinien', inTosGate: true },
  { id: 'impressum', title: 'Impressum', inTosGate: false },
]

/** Documents shown — and pauschal accepted — in the ToS-Gate. */
export const TOS_GATE_SECTIONS = LEGAL_SECTIONS.filter((s) => s.inTosGate)

export const LEGAL_TITLES: Record<LegalSection, string> = {
  agb: 'Allgemeine Geschäftsbedingungen',
  anbieter_agb: 'Anbieterbedingungen für Handwerksbetriebe',
  avv: 'Auftragsverarbeitungsvertrag (Anlage zu den Anbieterbedingungen)',
  datenschutz: 'Datenschutzerklärung',
  widerruf: 'Widerrufsbelehrung',
  eula: 'Nutzungs- und Community-Richtlinien',
  impressum: 'Impressum',
}

export function isLegalSection(value: string | undefined): value is LegalSection {
  return (
    value === 'agb' ||
    value === 'anbieter_agb' ||
    value === 'avv' ||
    value === 'datenschutz' ||
    value === 'widerruf' ||
    value === 'eula' ||
    value === 'impressum'
  )
}
