import { supabase } from '../supabase'
import { apiUrl } from '../api/baseUrl'

/**
 * § 356a BGB Widerruf-Button (Client-Seite).
 *
 * Ruft die Vercel-Route /api/submit-widerruf auf. Der Server erfasst die
 * Widerrufserklärung append-only in `widerruf_requests` und sendet dem Nutzer
 * eine Eingangsbestätigung per E-Mail (dauerhafter Datenträger, § 356a Abs. 3).
 *
 * Rückgabe enthält bei Erfolg die maskierte Empfänger-Adresse für die UI sowie
 * ob die Bestätigungs-E-Mail zugestellt werden konnte.
 */

export type SubmitWiderrufResult =
  | { ok: true; maskedEmail: string; confirmationSent: boolean }
  | { ok: false; error: string }

export async function submitWiderruf(contactEmail: string): Promise<SubmitWiderrufResult> {
  const trimmed = contactEmail.trim()
  if (trimmed.length === 0) {
    return { ok: false, error: 'Bitte gib eine E-Mail-Adresse an.' }
  }

  const { data: sessionData } = await supabase.auth.getSession()
  const token = sessionData?.session?.access_token
  if (!token) {
    return { ok: false, error: 'Bitte erneut anmelden.' }
  }

  try {
    const response = await fetch(apiUrl('/api/submit-widerruf'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ contactEmail: trimmed }),
    })

    const body = (await response.json().catch(() => ({}))) as {
      received?: boolean
      confirmationSent?: boolean
      maskedEmail?: string
      error?: string
    }

    if (!response.ok || body.received !== true) {
      return {
        ok: false,
        error: body.error ?? 'Widerruf konnte nicht übermittelt werden.',
      }
    }

    return {
      ok: true,
      maskedEmail: body.maskedEmail ?? '',
      confirmationSent: body.confirmationSent === true,
    }
  } catch {
    return { ok: false, error: 'Netzwerkfehler. Bitte versuche es erneut.' }
  }
}
