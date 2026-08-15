/**
 * Basic client-side content filter for obvious abuse.
 *
 * This is NOT a comprehensive moderation system — it catches only the most
 * blatant abuse terms to provide a minimum safety layer.  The real moderation
 * happens through Report/Block + operator review.
 */

// Lowercase terms that should never appear in user-generated messages.
// Kept intentionally short and focused on unambiguous abuse.
const BLOCKED_TERMS: string[] = [
  // German
  'hurensohn',
  'hure',
  'missgeburt',
  'wichser',
  'arschloch',
  'schlampe',
  'nazi',
  'sieg heil',
  'heil hitler',
  'vergasen',
  'drecksjude',
  'kanake',
  'neger',
  'schwuchtel',
  // English
  'fuck you',
  'kill yourself',
  'kys',
  'nigger',
  'faggot',
  'retard',
]

/**
 * Checks whether a message text contains obviously abusive content.
 *
 * Returns `{ allowed: true }` for clean text, or
 * `{ allowed: false, reason }` when the text should be blocked.
 */
export function checkContent(text: string): { allowed: boolean; reason?: string } {
  const normalized = text.toLowerCase()

  for (const term of BLOCKED_TERMS) {
    if (normalized.includes(term)) {
      return {
        allowed: false,
        reason: 'Nachricht enthält unangemessene Inhalte und kann nicht gesendet werden.',
      }
    }
  }

  return { allowed: true }
}
