/**
 * Search domain – trade taxonomy + query resolution.
 *
 * Pure-logic (L1) module. No I/O, no global state, deterministic.
 *
 * Encodes the FixUp Gewerke (trade) taxonomy: a canonical trade list plus the
 * aliases (industry spellings) and laymanTerms (how customers actually phrase
 * problems) that should resolve to each canonical trade.
 *
 * Exposed API:
 *   - `normalizeTerm(s)`  → KEY A fold (lowercase + ß→ss + umlaut digraphs +
 *                           punctuation stripped). Diacritic-preserving form used
 *                           for exact + substring/compound matching.
 *   - `resolveQuery(text)`→ { matchedTrades, freeTokens } using exact → compound →
 *                           fuzzy (Damerau/OSA, length-gated) matching.
 *   - `expandTrade(canonical)` → relatedTrades for query-adjacency expansion.
 *   - `TRADES`            → the raw taxonomy (read-only).
 *
 * Folding is bidirectional/symmetric: the same KEY A / KEY B folds are applied
 * to the indexed taxonomy terms AND to the incoming query, so the corpus and
 * the query always meet at the same key.
 */

export type TradeDefinition = {
  canonical: string
  aliases: readonly string[]
  laymanTerms: readonly string[]
  relatedTrades: readonly string[]
}

export const TRADES: readonly TradeDefinition[] = [
  {
    canonical: 'Elektrik',
    aliases: ['Elektro', 'Elektroinstallation', 'Elektrotechnik', 'Elektroinstallateur', 'Energie- und Gebäudetechnik', 'Elektriker'],
    laymanTerms: ['Elektriker', 'Elektirker', 'Elektroniker', 'Strom', 'kein Strom', 'Stromausfall', 'Steckdose', 'Steckdosen', 'Schalter', 'Lichtschalter', 'Sicherung', 'Sicherung fliegt', 'Sicherungen', 'Sicherungskasten', 'Verteilerkasten', 'Zählerschrank', 'Kurzschluss', 'FI-Schalter', 'E-Check', 'Echeck', 'Verkabelung', 'Kabel', 'Leitung verlegen', 'Lampe anschließen', 'Lampe aufhängen', 'Herd anschließen', 'Starkstrom', 'Smart Home', 'Wallbox', 'Ladestation', 'Photovoltaik', 'PV', 'Solar', 'Solaranlage', 'Wechselrichter', 'Beleuchtung', 'Deckenlampe', 'Deckenleuchte', 'Klingel', 'Türklingel', 'Gegensprechanlage'],
    relatedTrades: ['Sanitär', 'Heizung', 'Trockenbau', 'Bad', 'Küche'],
  },
  {
    canonical: 'Sanitär',
    aliases: ['SHK', 'Sanitärinstallation', 'Sanitärtechnik', 'Installateur', 'Gas-Wasser-Installateur', 'Heizungs- und Sanitärtechnik'],
    laymanTerms: ['Klempner', 'Klempnerei', 'Sanitaer', 'sanitar', 'Notdienst Wasser', 'Rohrbruch', 'Rohr', 'Rohre', 'Rohrverstopfung', 'Verstopfung', 'Abfluss', 'Abfluss verstopft', 'verstopfter Abfluss', 'Wasserhahn', 'Wasserhahn tropft', 'Armatur', 'Wasserschaden', 'Leck', 'Leckage', 'undichte Leitung', 'Wasserleitung', 'Wasserrohr', 'WC', 'Toilette', 'Klo', 'Spülkasten', 'Waschbecken', 'Spüle', 'Boiler', 'Durchlauferhitzer', 'Silikonfugen erneuern', 'Mischbatterie', 'Siphon', 'Spülung', 'Klospülung', 'Eckventil', 'Rohrreinigung'],
    relatedTrades: ['Heizung', 'Bad', 'Fliesen', 'Küche', 'Elektrik'],
  },
  {
    canonical: 'Heizung',
    aliases: ['Heizungsbau', 'Heizungstechnik', 'Heizungsinstallation', 'SHK', 'Heizungs- und Sanitärtechnik'],
    laymanTerms: ['Heizungsbauer', 'Wärmepumpe', 'Waermepumpe', 'Therme', 'Gastherme', 'Brennwerttherme', 'Kessel', 'Heizkessel', 'Brennwertkessel', 'Gasheizung', 'Ölheizung', 'Oelheizung', 'Pelletheizung', 'Pellet', 'Heizkörper', 'Heizkoerper', 'Fußbodenheizung', 'Fussbodenheizung', 'Heizung kalt', 'Heizung defekt', 'Heizung entlüften', 'Heizungswartung', 'Thermostat', 'Warmwasser', 'Solarthermie', 'Öltank', 'Klimaanlage', 'Klima', 'Split-Klimagerät', 'Heizungstausch', 'neue Heizung'],
    relatedTrades: ['Sanitär', 'Elektrik', 'Bad'],
  },
  {
    canonical: 'Fliesen',
    aliases: ['Fliesenleger', 'Fliesenlegerei', 'Plattenleger', 'Fliesen-, Platten- und Mosaikleger', 'Fliesenarbeiten', 'Fliesenverlegung'],
    laymanTerms: ['Fliesen legen', 'Fliesen verlegen', 'Flisen', 'Fliessen', 'Kacheln', 'Kachel', 'Verfugen', 'Fugen', 'Fugen erneuern', 'Silikonfugen', 'Mosaik', 'Naturstein', 'Bodenfliesen', 'Wandfliesen', 'Fliesenspiegel', 'neue Fliesen'],
    relatedTrades: ['Bad', 'Küche', 'Böden', 'Sanitär'],
  },
  {
    canonical: 'Maler',
    aliases: ['Malerei', 'Malerarbeiten', 'Maler und Lackierer', 'Malerbetrieb', 'Anstreicher'],
    laymanTerms: ['Streichen', 'Wand streichen', 'Wände streichen', 'anstreichen', 'Tapezieren', 'Tapete', 'Tapeten', 'Tapete entfernen', 'Lackieren', 'Lasieren', 'Anstrich', 'Innenanstrich', 'Außenanstrich', 'Aussenanstrich', 'Fassade streichen', 'Fassadenanstrich', 'Wandfarbe', 'Farbe', 'Spachteln', 'Verputzen', 'Putz', 'Raufaser', 'Wandgestaltung', 'Schimmel', 'Schimmel entfernen'],
    relatedTrades: ['Trockenbau', 'Renovierung', 'Bad'],
  },
  {
    canonical: 'Trockenbau',
    aliases: ['Trockenbauarbeiten', 'Trockenbauer', 'Innenausbau', 'Akustikbau'],
    laymanTerms: ['Rigips', 'Gipskarton', 'Gipskartonplatten', 'Gips', 'Rigipswand', 'Trennwand', 'Ständerwand', 'Leichtbauwand', 'Wand einziehen', 'abgehängte Decke', 'Decke abhängen', 'Vorsatzschale', 'Dämmung', 'Innenputz', 'Verputzen', 'Putz', 'Decke', 'Zimmerdecke'],
    relatedTrades: ['Maler', 'Renovierung', 'Elektrik'],
  },
  {
    canonical: 'Böden',
    aliases: ['Boden', 'Bodenbeläge', 'Bodenleger', 'Bodenlegerei', 'Parkettleger', 'Raumausstatter'],
    laymanTerms: ['Parkett', 'Parkett schleifen', 'Laminat', 'Laminat verlegen', 'Vinyl', 'Vinylboden', 'Klickvinyl', 'Designboden', 'Teppich', 'Teppichboden', 'PVC', 'Linoleum', 'Dielen', 'Dielenboden', 'Kork', 'Boden verlegen', 'Bodenbelag verlegen', 'Fußboden', 'Fussboden'],
    relatedTrades: ['Fliesen', 'Estrich', 'Renovierung', 'Schreiner'],
  },
  {
    canonical: 'Schreiner',
    aliases: ['Schreinerei', 'Tischler', 'Tischlerei', 'Möbelbau', 'Möbelschreiner', 'Bautischler'],
    laymanTerms: ['Möbel nach Maß', 'Maßmöbel', 'Einbauschrank', 'Einbaumöbel', 'Möbelmontage', 'Möbel aufbauen', 'Regal', 'Regale', 'Holzarbeiten', 'Holz', 'Massivholz', 'Treppe', 'Treppenbau', 'Arbeitsplatte', 'Innentüren', 'Zimmertüren', 'Türen einbauen', 'Schrank', 'Kommode', 'Tischlerarbeiten'],
    relatedTrades: ['Fenster & Türen', 'Küche', 'Böden', 'Renovierung'],
  },
  {
    canonical: 'Fenster & Türen',
    aliases: ['Fensterbau', 'Fenster- und Türenbau', 'Fensterbauer', 'Tür- und Fenstermontage', 'Glaserei', 'Glaser', 'Bauelemente'],
    laymanTerms: ['Fenster', 'Fenster tauschen', 'Fenstertausch', 'neue Fenster', 'Türen', 'Tür', 'Haustür', 'Haustuer', 'Zimmertür', 'Verglasung', 'Glas', 'Glasbruch', 'Scheibe', 'Fensterscheibe', 'Rollladen', 'Rolladen', 'Rollläden', 'Jalousie', 'Jalousien', 'Insektenschutz', 'Fliegengitter', 'Markise', 'Sonnenschutz', 'Türschloss', 'Schloss austauschen'],
    relatedTrades: ['Schreiner', 'Maler', 'Metallbau', 'Renovierung'],
  },
  {
    canonical: 'Dach',
    aliases: ['Dachdecker', 'Dachdeckerei', 'Bedachung', 'Dachbau', 'Dachklempnerei', 'Spengler'],
    laymanTerms: ['Dachdecker', 'Dachreparatur', 'Dach decken', 'Dach undicht', 'Dachrinne', 'Dachrinne reinigen', 'Regenrinne', 'Dachziegel', 'Ziegel', 'Dachfenster', 'Dachfenster einbauen', 'Dachstuhl', 'Flachdach', 'Schornstein', 'Gauben', 'Dachdämmung', 'Dachboden ausbauen'],
    relatedTrades: ['Zimmerer', 'Gerüstbau', 'Fenster & Türen', 'Renovierung'],
  },
  {
    canonical: 'Garten',
    aliases: ['Garten- und Landschaftsbau', 'GaLaBau', 'Gartenbau', 'Landschaftsbau', 'Gartengestaltung', 'Gärtnerei'],
    laymanTerms: ['Gärtner', 'Gaertner', 'Rasen', 'Rasen mähen', 'Rasen anlegen', 'Hecke', 'Hecke schneiden', 'Heckenschnitt', 'Baum fällen', 'Baumfällung', 'Baumpflege', 'Bepflanzung', 'Beet', 'Terrasse', 'Terrasse bauen', 'Pflastern', 'Pflasterarbeiten', 'Wege', 'Zaun', 'Zaun bauen', 'Gartenzaun', 'Teich', 'Bewässerung', 'Außenanlage', 'Gartenpflege', 'Winterdienst', 'Gras', 'Rollrasen', 'Baum', 'Unkraut'],
    relatedTrades: ['Maurer', 'Abbruch', 'Zimmerer', 'Renovierung'],
  },
  {
    canonical: 'Maurer',
    aliases: ['Maurerarbeiten', 'Maurerei', 'Rohbau', 'Hochbau', 'Maurer- und Betonbauer', 'Beton- und Stahlbetonbauer'],
    laymanTerms: ['Mauern', 'Mauer', 'Mauer bauen', 'Mauerwerk', 'Wand mauern', 'Beton', 'Betonarbeiten', 'Fundament', 'Bodenplatte', 'Durchbruch', 'Wanddurchbruch', 'Mauerdurchbruch', 'Klinker', 'Verklinkern', 'Sockel', 'Rohbauarbeiten'],
    relatedTrades: ['Abbruch', 'Estrich', 'Renovierung', 'Garten'],
  },
  {
    canonical: 'Estrich',
    aliases: ['Estrichleger', 'Estricharbeiten', 'Estrichbau', 'Fließestrich', 'Bodenestrich'],
    laymanTerms: ['Estrich', 'Estrich legen', 'Estrich gießen', 'Fließestrich', 'Zementestrich', 'Anhydritestrich', 'Bodenausgleich', 'Ausgleichsmasse', 'Unterboden', 'Heizestrich'],
    relatedTrades: ['Böden', 'Fliesen', 'Maurer', 'Renovierung'],
  },
  {
    canonical: 'Zimmerer',
    aliases: ['Zimmerei', 'Zimmermann', 'Holzbau', 'Holzbauer', 'Zimmererarbeiten'],
    laymanTerms: ['Zimmermann', 'Holzbau', 'Dachstuhl', 'Dachstuhl reparieren', 'Carport', 'Carport bauen', 'Holzkonstruktion', 'Balken', 'Gauben', 'Holzrahmenbau', 'Fachwerk', 'Pergola', 'Gartenhaus', 'Holzterrasse'],
    relatedTrades: ['Dach', 'Schreiner', 'Garten', 'Renovierung'],
  },
  {
    canonical: 'Metallbau',
    aliases: ['Schlosser', 'Schlosserei', 'Metallbauer', 'Metallbauarbeiten', 'Stahlbau', 'Kunstschmiede', 'Schweißarbeiten'],
    laymanTerms: ['Schlosser', 'Geländer', 'Treppengeländer', 'Balkongeländer', 'Tor', 'Tore', 'Garagentor', 'Gittertür', 'Metalltreppe', 'Schweißen', 'Edelstahl', 'Stahl', 'Vordach', 'Schloss'],
    relatedTrades: ['Fenster & Türen', 'Garten', 'Renovierung'],
  },
  {
    canonical: 'Abbruch',
    aliases: ['Abbrucharbeiten', 'Abriss', 'Abrissarbeiten', 'Rückbau', 'Demontage', 'Entkernung'],
    laymanTerms: ['Abriss', 'Abreißen', 'abbrechen', 'Rückbau', 'Entkernen', 'Entkernung', 'Wand entfernen', 'Wand abreißen', 'rausreißen', 'raus reißen', 'Schuttentsorgung', 'Bauschutt', 'Entsorgung', 'Haus abreißen'],
    relatedTrades: ['Maurer', 'Renovierung', 'Trockenbau', 'Garten'],
  },
  {
    canonical: 'Gerüstbau',
    aliases: ['Gerüstbauer', 'Gerüstarbeiten', 'Gerüstmontage', 'Baugerüst'],
    laymanTerms: ['Gerüst', 'Geruest', 'Gerüst aufbauen', 'Gerüst mieten', 'Fassadengerüst', 'Arbeitsgerüst'],
    relatedTrades: ['Dach', 'Maler', 'Maurer'],
  },
  {
    canonical: 'Reinigung',
    aliases: ['Gebäudereinigung', 'Gebäudereiniger', 'Reinigungsservice', 'Unterhaltsreinigung'],
    laymanTerms: ['Putzen', 'Putzkraft', 'Bauschlussreinigung', 'Bauendreinigung', 'Fensterreinigung', 'Fenster putzen', 'Grundreinigung', 'Teppichreinigung', 'Treppenhausreinigung', 'Entrümpelung', 'entrümpeln', 'Haushaltsauflösung'],
    relatedTrades: ['Maler', 'Renovierung', 'Abbruch'],
  },
  {
    canonical: 'Bad',
    aliases: ['Badezimmer', 'Badsanierung', 'Badrenovierung', 'Bad-Umbau', 'Badezimmersanierung'],
    laymanTerms: ['Bad renovieren', 'Bad sanieren', 'Badumbau', 'neues Bad', 'Dusche', 'Duschkabine', 'ebenerdige Dusche', 'Badewanne', 'barrierefreies Bad', 'behindertengerechtes Bad', 'Gäste-WC'],
    relatedTrades: ['Sanitär', 'Fliesen', 'Heizung', 'Elektrik', 'Trockenbau'],
  },
  {
    canonical: 'Küche',
    aliases: ['Küchenmontage', 'Kücheneinbau', 'Küchenbau', 'Küchenstudio', 'Einbauküche'],
    laymanTerms: ['Kueche', 'Küche aufbauen', 'Küche montieren', 'Küche anschließen', 'Küchenmöbel', 'Arbeitsplatte', 'Spüle anschließen', 'Dunstabzug', 'Küche planen', 'Küchenrückwand'],
    relatedTrades: ['Schreiner', 'Elektrik', 'Sanitär', 'Fliesen'],
  },
  {
    canonical: 'Renovierung',
    aliases: ['Sanierung', 'Modernisierung', 'Komplettsanierung', 'Kernsanierung', 'Umbau', 'Altbausanierung', 'Generalsanierung'],
    laymanTerms: ['renovieren', 'sanieren', 'modernisieren', 'Wohnung renovieren', 'Haus sanieren', 'Komplettrenovierung', 'Renovierungsarbeiten', 'Sanierungsarbeiten', 'Umbau', 'alles aus einer Hand'],
    relatedTrades: ['Maler', 'Trockenbau', 'Böden', 'Fliesen', 'Elektrik', 'Sanitär'],
  },
] as const

// ---------------------------------------------------------------------------
// Normalisation — KEY A (exact/compound) and KEY B (fuzzy)
// ---------------------------------------------------------------------------

/**
 * Shared pre-pass applied to BOTH normalisation keys.
 *   1. NFC + Unicode lowercase (ß stays ß — handled explicitly next).
 *   2. ß → ss.
 *   3. '&' → ' und '; hyphen / slash / dot / comma → space.
 *   4. drop other punctuation; collapse whitespace; trim.
 */
function preNormalize(input: string): string {
  let t = (input ?? '').normalize('NFC').toLowerCase()
  t = t.replace(/ß/g, 'ss')
  t = t.replace(/&/g, ' und ')
  t = t.replace(/[-/.,]/g, ' ')
  t = t.replace(/[^\p{L}\p{N}\s]/gu, '')
  t = t.replace(/\s+/g, ' ').trim()
  return t
}

/**
 * KEY A — exact/alias key (diacritic-preserving digraph form).
 * "Sanitär" → "sanitaer", "Böden" → "boeden", "Fenster & Türen" → "fenster und tueren".
 *
 * This is the public normaliser: lowercase + umlaut-fold + punctuation stripped.
 * Use for exact and substring/compound matching.
 */
export function normalizeTerm(input: string): string {
  let t = preNormalize(input)
  t = t.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
  // Strip any leftover combining accents down to base ASCII.
  t = t.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC')
  return t
}

/**
 * KEY B — loose/fuzzy key. Starts from KEY A then collapses the digraphs
 * (ae→a, oe→o, ue→u) so the bare-vowel typo lands too:
 * "sanitär"/"sanitaer"/"sanitar" → "sanitar".
 *
 * Mildly lossy (legit ae/oe/ue sequences also collapse) — reserved for the
 * fuzzy stage only; KEY A drives exact/compound matching.
 */
function looseKey(input: string): string {
  let t = normalizeTerm(input)
  t = t.replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u')
  return t
}

// ---------------------------------------------------------------------------
// Index build (computed once at module load — pure, deterministic)
// ---------------------------------------------------------------------------

const CANONICAL_ORDER = new Map<string, number>()
TRADES.forEach((t, i) => CANONICAL_ORDER.set(t.canonical, i))

/** KEY A → set of canonical trades. A term can legitimately belong to several
 *  trades (e.g. "SHK" → Sanitär + Heizung, "Putz" → Maler + Trockenbau). */
const exactMap = new Map<string, Set<string>>()

/** Single-word KEY A terms (no space) used for German-compound substring
 *  matching, sorted by length desc so longer terms win first. */
const singleWordTerms: Array<{ key: string; canonical: string; len: number }> = []

/** Multi-word KEY A phrases ("lampe anschliessen", "fenster und tueren") matched
 *  via whole-string contains. */
const multiWordTerms: Array<{ key: string; canonical: string }> = []

/** KEY B → set of canonical trades, single-word terms only, for the fuzzy stage. */
const fuzzyDict = new Map<string, Set<string>>()

function addExact(key: string, canonical: string): void {
  if (!key) return
  let set = exactMap.get(key)
  if (!set) {
    set = new Set<string>()
    exactMap.set(key, set)
  }
  set.add(canonical)
}

function addFuzzy(keyB: string, canonical: string): void {
  if (keyB.length < 4) return
  let set = fuzzyDict.get(keyB)
  if (!set) {
    set = new Set<string>()
    fuzzyDict.set(keyB, set)
  }
  set.add(canonical)
}

{
  const seenSingle = new Set<string>()
  for (const trade of TRADES) {
    const terms = [trade.canonical, ...trade.aliases, ...trade.laymanTerms]
    for (const raw of terms) {
      const keyA = normalizeTerm(raw)
      if (!keyA) continue
      addExact(keyA, trade.canonical)
      if (keyA.includes(' ')) {
        multiWordTerms.push({ key: keyA, canonical: trade.canonical })
      } else {
        const dedupeKey = `${keyA}::${trade.canonical}`
        if (!seenSingle.has(dedupeKey)) {
          seenSingle.add(dedupeKey)
          singleWordTerms.push({ key: keyA, canonical: trade.canonical, len: keyA.length })
        }
        addFuzzy(looseKey(raw), trade.canonical)
      }
    }
  }
  singleWordTerms.sort((a, b) => b.len - a.len)
  // Longer multi-word phrases first so the most specific phrase matches.
  multiWordTerms.sort((a, b) => b.key.length - a.key.length)
}

// ---------------------------------------------------------------------------
// Protected near-collisions
// ---------------------------------------------------------------------------

/**
 * Look-alike words (KEY B / looseKey form) that sit within fuzzy distance of one
 * another but belong to DIFFERENT trades (or to no trade at all). The fuzzy
 * stage must NOT bridge between members of the same group — e.g. the non-trade
 * word "fach" must never fuzz onto "dach" (Dach), "gras" must never fuzz onto
 * "glas" (Fenster & Türen). Exact KEY A still wins, so the real word ("Dach")
 * resolves normally in phases 1–2; only the fuzzy bleed is cut.
 */
const PROTECTED_COLLISION_GROUPS: ReadonlyArray<ReadonlySet<string>> = [
  new Set(['decke', 'hecke']),
  new Set(['gras', 'glas']),
  new Set(['dach', 'fach', 'bach', 'nach', 'wach']),
  new Set(['maler', 'maurer', 'mauer']),
]

/** looseKey → its protected group (for O(1) lookup in the fuzzy stage). */
const PROTECTED_WORD_TO_GROUP = new Map<string, ReadonlySet<string>>()
for (const group of PROTECTED_COLLISION_GROUPS) {
  for (const word of group) PROTECTED_WORD_TO_GROUP.set(word, group)
}

// ---------------------------------------------------------------------------
// Damerau / OSA edit distance (transposition-aware) — pure
// ---------------------------------------------------------------------------

/**
 * Optimal String Alignment distance (restricted Damerau-Levenshtein).
 * Transposition-aware: "elektirker" → "elektriker" is distance 1.
 * Early-exits when the running minimum row exceeds `max`.
 */
function osaDistance(a: string, b: string, max: number): number {
  const la = a.length
  const lb = b.length
  if (Math.abs(la - lb) > max) return max + 1
  if (la === 0) return lb
  if (lb === 0) return la

  let prevPrev = new Array<number>(lb + 1)
  let prev = new Array<number>(lb + 1)
  let curr = new Array<number>(lb + 1)
  for (let j = 0; j <= lb; j++) prev[j] = j

  for (let i = 1; i <= la; i++) {
    curr[0] = i
    let rowMin = curr[0]
    const ai = a.charCodeAt(i - 1)
    for (let j = 1; j <= lb; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1
      let val = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      )
      if (
        i > 1 &&
        j > 1 &&
        ai === b.charCodeAt(j - 2) &&
        a.charCodeAt(i - 2) === b.charCodeAt(j - 1)
      ) {
        val = Math.min(val, prevPrev[j - 2] + 1) // transposition
      }
      curr[j] = val
      if (val < rowMin) rowMin = val
    }
    if (rowMin > max) return max + 1
    const tmp = prevPrev
    prevPrev = prev
    prev = curr
    curr = tmp
  }
  return prev[lb]
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ResolvedQuery = {
  /** Canonical trades the query resolved to, ordered by the taxonomy order. */
  matchedTrades: string[]
  /** Query tokens that did not resolve to any trade (residual free text). */
  freeTokens: string[]
}

/**
 * Resolves a free-text query into canonical trades + residual free tokens.
 *
 * Matching order (per the fuzzy guidance):
 *   1. KEY A exact     — token equals a canonical/alias/layman term.
 *   2. KEY A compound  — multi-word phrase contains, then per-token
 *                        prefix/substring (German compounds:
 *                        "sicherungskasten"→Elektrik, "badezimmerrenovierung"
 *                        →Bad+Renovierung). Runs BEFORE fuzzy.
 *   3. KEY B fuzzy     — Damerau/OSA, length-gated (len≤3 → 0, 4-6 → ≤1,
 *                        ≥7 → ≤2). Ambiguity guard: a token within threshold of
 *                        two DIFFERENT canonicals is dropped (never guess).
 *
 * Always prefers an exact/compound hit over any fuzzy hit. Pure + deterministic.
 */
export function resolveQuery(text: string): ResolvedQuery {
  const normFull = normalizeTerm(text)
  if (!normFull) return { matchedTrades: [], freeTokens: [] }

  const matched = new Set<string>()

  // ── Phase 0: multi-word phrase contains (whole normalised string) ────────
  for (const { key, canonical } of multiWordTerms) {
    if (normFull === key || normFull.includes(` ${key} `) || normFull.startsWith(`${key} `) || normFull.endsWith(` ${key}`) || normFull.includes(key)) {
      matched.add(canonical)
    }
  }

  const tokens = normFull.split(' ').filter((t) => t.length > 0)
  const consumed = new Array<boolean>(tokens.length).fill(false)

  // ── Phase 1: per-token exact (KEY A) ─────────────────────────────────────
  tokens.forEach((tok, i) => {
    const set = exactMap.get(tok)
    if (set) {
      set.forEach((c) => matched.add(c))
      consumed[i] = true
    }
  })

  // ── Phase 2: per-token compound (prefix / substring, KEY A) ──────────────
  tokens.forEach((tok, i) => {
    if (consumed[i]) return
    let hit = false
    for (const term of singleWordTerms) {
      if (term.len >= tok.length) continue // need a strict sub-part for a compound
      // len-3 terms: prefix-only (protects "tor" in "motor"); len≥4: substring.
      const isMatch = term.len >= 4 ? tok.includes(term.key) : tok.startsWith(term.key)
      if (isMatch) {
        matched.add(term.canonical)
        hit = true
        // do not break — one compound token can carry two trades
      }
    }
    if (hit) consumed[i] = true
  })

  // ── Phase 3: per-token fuzzy (KEY B, length-gated, ambiguity-guarded) ─────
  tokens.forEach((tok, i) => {
    if (consumed[i]) return
    const tb = looseKey(tok)
    if (tb.length < 4) return
    // Protected near-collision: if the token IS one of the protected words, its
    // look-alike counterparts in another trade are off-limits to fuzzy bridging
    // (e.g. "fach" must not fuzz onto "dach"). The real word resolved exactly in
    // phases 1–2 already, so only the spurious neighbour is cut here.
    const protectedGroup = PROTECTED_WORD_TO_GROUP.get(tb)
    const threshold = tb.length <= 6 ? 1 : 2
    let best = threshold + 1
    let cands = new Set<string>()
    for (const [key, set] of fuzzyDict) {
      if (protectedGroup && key !== tb && protectedGroup.has(key)) continue
      const d = osaDistance(tb, key, threshold)
      if (d > threshold) continue
      if (d < best) {
        best = d
        cands = new Set<string>(set)
      } else if (d === best) {
        set.forEach((c) => cands.add(c))
      }
    }
    if (best <= threshold && cands.size === 1) {
      matched.add([...cands][0])
      consumed[i] = true
    }
    // cands.size > 1 → ambiguous → drop the fuzzy candidate (never cross-bleed).
  })

  const matchedTrades = [...matched].sort(
    (a, b) => (CANONICAL_ORDER.get(a) ?? 0) - (CANONICAL_ORDER.get(b) ?? 0),
  )
  const freeTokens = tokens.filter((_, i) => !consumed[i]).filter((t) => t.length >= 2)

  return { matchedTrades, freeTokens }
}

/**
 * Canonicalises a single STORED trade label (candidate side) through the same
 * exact KEY A alias/layman map that `resolveQuery` uses on the query side — but
 * ONLY when the label resolves UNAMBIGUOUSLY to exactly one canonical trade.
 *
 * Ambiguous labels (e.g. "SHK" → Sanitär + Heizung) and unknown labels fall
 * back to the trimmed input, so they are never silently mis-canonicalised.
 * This lets candidate-side equality / `includes` checks meet the query's
 * canonical even under label drift: "Schreinerei" → "Schreiner",
 * "Malerei" → "Maler". Pure + deterministic.
 */
export function canonicalizeTrade(label: string): string {
  const key = normalizeTerm(label)
  const set = key ? exactMap.get(key) : undefined
  if (set && set.size === 1) return [...set][0]
  return (label ?? '').trim()
}

/** Returns the canonical related trades for a canonical trade (query-adjacency
 *  expansion). Unknown canonicals yield an empty list. */
export function expandTrade(canonical: string): string[] {
  const trade = TRADES.find((t) => t.canonical === canonical)
  return trade ? [...trade.relatedTrades] : []
}
