/**
 * Trade-Dependent Question Definitions
 *
 * Each trade/service category has a curated set of follow-up questions
 * that help craftsmen evaluate the request more effectively.
 *
 * Questions are organized by trade and are all optional — the customer
 * can skip the entire step and still create a valid request.
 *
 * The answers are stored as key-value pairs in the project entity and
 * rendered in the full request detail view (Level 2).
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type TradeQuestionType = 'single' | 'multi' | 'text'

export type TradeQuestion = {
  /** Unique key for this question (e.g. 'scope', 'count'). */
  key: string
  /** Human-readable question label in German. */
  label: string
  /** Question input type. */
  type: TradeQuestionType
  /** Available options for 'single' and 'multi' type questions. */
  options?: string[]
  /** Placeholder text for 'text' type questions. */
  placeholder?: string
}

/** Stored answer for a trade-specific question. */
export type TradeAnswer = {
  key: string
  label: string
  value: string
}

// ── Trade question definitions ────────────────────────────────────────────────

const ELEKTRIK_QUESTIONS: TradeQuestion[] = [
  {
    key: 'scope',
    label: 'Art der Arbeit',
    type: 'single',
    options: ['Reparatur', 'Neuinstallation', 'Modernisierung', 'Erweiterung'],
  },
  {
    key: 'count',
    label: 'Ungefähre Anzahl Steckdosen / Anschlüsse',
    type: 'single',
    options: ['1–3', '4–10', '11–20', 'Mehr als 20'],
  },
  {
    key: 'issue',
    label: 'Problemtyp (falls Reparatur)',
    type: 'single',
    options: ['Kurzschluss', 'Sicherung fliegt', 'Defekte Steckdose / Schalter', 'Leitungsproblem', 'Anderes'],
  },
]

const BAD_QUESTIONS: TradeQuestion[] = [
  {
    key: 'scope',
    label: 'Art der Arbeit',
    type: 'single',
    options: ['Teilrenovierung', 'Komplettrenovierung', 'Neubau', 'Einzelne Reparatur'],
  },
  {
    key: 'size',
    label: 'Ungefähre Raumgröße',
    type: 'single',
    options: ['Klein (< 5 m²)', 'Mittel (5–10 m²)', 'Groß (> 10 m²)'],
  },
  {
    key: 'fixtures',
    label: 'Was soll eingebaut / erneuert werden?',
    type: 'multi',
    options: ['Dusche', 'Badewanne', 'WC', 'Waschbecken', 'Fliesen', 'Heizung'],
  },
]

const SANITAER_QUESTIONS: TradeQuestion[] = [
  {
    key: 'scope',
    label: 'Art der Arbeit',
    type: 'single',
    options: ['Leck / Wasserschaden', 'Austausch', 'Neuanschluss', 'Wartung'],
  },
  {
    key: 'location',
    label: 'Betroffener Bereich',
    type: 'single',
    options: ['Küche', 'Bad', 'Keller', 'Heizungsraum', 'Außenbereich'],
  },
  {
    key: 'urgency',
    label: 'Dringlichkeit',
    type: 'single',
    options: ['Notfall (sofort)', 'Dringend (1–3 Tage)', 'Normal', 'Keine Eile'],
  },
]

const FLIESEN_QUESTIONS: TradeQuestion[] = [
  {
    key: 'scope',
    label: 'Art der Arbeit',
    type: 'single',
    options: ['Neuverfliesen', 'Reparatur / Austausch', 'Verfugen'],
  },
  {
    key: 'area',
    label: 'Ungefähre Fläche',
    type: 'single',
    options: ['Unter 5 m²', '5–15 m²', '15–30 m²', 'Über 30 m²'],
  },
  {
    key: 'surface',
    label: 'Wo?',
    type: 'single',
    options: ['Boden', 'Wand', 'Beides', 'Außen'],
  },
]

const SCHREINEREI_QUESTIONS: TradeQuestion[] = [
  {
    key: 'scope',
    label: 'Art der Arbeit',
    type: 'single',
    options: ['Möbel nach Maß', 'Einbauschrank', 'Türen', 'Fenster', 'Reparatur', 'Sonstiges'],
  },
  {
    key: 'dimensions',
    label: 'Ungefähre Abmessungen',
    type: 'text',
    placeholder: 'z. B. 2,5 m breit × 2 m hoch',
  },
  {
    key: 'material',
    label: 'Materialwunsch',
    type: 'single',
    options: ['Massivholz', 'Holzwerkstoffe', 'Egal / offen'],
  },
]

const MALER_QUESTIONS: TradeQuestion[] = [
  {
    key: 'scope',
    label: 'Art der Arbeit',
    type: 'single',
    options: ['Innenanstrich', 'Außenanstrich', 'Tapezieren', 'Fassade', 'Lackieren'],
  },
  {
    key: 'area',
    label: 'Ungefähre Fläche',
    type: 'single',
    options: ['Einzelne Wand', '1 Raum', '2–3 Räume', 'Ganze Wohnung', 'Fassade'],
  },
  {
    key: 'preparation',
    label: 'Vorarbeiten nötig?',
    type: 'single',
    options: ['Tapete entfernen', 'Untergrund spachteln', 'Nein, Wände sind fertig', 'Nicht sicher'],
  },
]

const HEIZUNG_QUESTIONS: TradeQuestion[] = [
  {
    key: 'scope',
    label: 'Art der Arbeit',
    type: 'single',
    options: ['Neuer Kessel / Anlage', 'Reparatur', 'Wartung', 'Heizkörper tauschen', 'Fußbodenheizung'],
  },
  {
    key: 'system',
    label: 'Heizungstyp',
    type: 'single',
    options: ['Gas', 'Öl', 'Wärmepumpe', 'Pellet', 'Unbekannt / egal'],
  },
  {
    key: 'units',
    label: 'Anzahl Heizkörper / Räume',
    type: 'single',
    options: ['1–3', '4–8', '9–15', 'Mehr als 15'],
  },
]

const RENOVIERUNG_QUESTIONS: TradeQuestion[] = [
  {
    key: 'scope',
    label: 'Art der Arbeit',
    type: 'single',
    options: ['Einzelner Raum', 'Wohnung / Etage', 'Ganzes Haus', 'Außenbereich'],
  },
  {
    key: 'area',
    label: 'Ungefähre Wohnfläche',
    type: 'single',
    options: ['Unter 30 m²', '30–60 m²', '60–120 m²', 'Über 120 m²'],
  },
  {
    key: 'notes',
    label: 'Besondere Anforderungen',
    type: 'text',
    placeholder: 'z. B. Denkmalschutz, Altbau, besondere Materialien…',
  },
]

// ── Lookup ────────────────────────────────────────────────────────────────────

const TRADE_QUESTIONS: Record<string, TradeQuestion[]> = {
  'Elektrik': ELEKTRIK_QUESTIONS,
  'Bad': BAD_QUESTIONS,
  'Sanitär': SANITAER_QUESTIONS,
  'Fliesen': FLIESEN_QUESTIONS,
  'Schreinerei': SCHREINEREI_QUESTIONS,
  'Malerarbeiten': MALER_QUESTIONS,
  'Heizung': HEIZUNG_QUESTIONS,
  'Renovierung': RENOVIERUNG_QUESTIONS,
}

/**
 * Returns the trade-dependent follow-up questions for a given trade category.
 * Returns an empty array for unknown/unmapped trades.
 */
export function getTradeQuestions(category: string): TradeQuestion[] {
  return TRADE_QUESTIONS[category] ?? []
}

/**
 * Returns all known trade categories that have questions defined.
 */
export function getTradeCategories(): string[] {
  return Object.keys(TRADE_QUESTIONS)
}
