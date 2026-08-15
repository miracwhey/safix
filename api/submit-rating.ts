import type { VercelRequest, VercelResponse } from '@vercel/node'
import { applyCors } from './_cors.js'
import { requireAuth } from './_auth.js'
import { getSupabaseAdmin } from './_supabase.js'
import { logWarning } from './_observability.js'
import { applyRateLimit } from './_rateLimit.js'

/**
 * POST /api/submit-rating
 *
 * Persists a customer rating for a completed job directly into the `ratings`
 * table using the Supabase admin client (bypasses RLS for write).
 *
 * Body:
 *   { jobId: string, providerUserId: string, ratingScore: 1-5, ratingComment?: string }
 *
 * Guards:
 *   - Caller must be authenticated (Supabase session).
 *   - jobId must be a non-empty string.
 *   - ratingScore must be an integer between 1 and 5.
 *   - Only one rating per job is allowed (UNIQUE constraint on job_id).
 *   - RLS INSERT policy enforces that customer_user_id = auth.uid().
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (applyCors(req, res)) return

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed. Use POST.' })
    return
  }

  const auth = await requireAuth(req, res)
  if (!auth) return
  if (await applyRateLimit(res, 'standard', auth.userId)) return

  const admin = getSupabaseAdmin()
  if (!admin) {
    logWarning('api.ratings.submit_failed', {
      route: 'submit-rating',
      reason: 'supabase_admin_unavailable',
    })
    res.status(500).json({ error: 'Server misconfiguration: authorization service unavailable.' })
    return
  }

  const body = (req.body ?? {}) as {
    jobId?: unknown
    providerUserId?: unknown
    ratingScore?: unknown
    ratingComment?: unknown
  }

  const { jobId, providerUserId, ratingScore, ratingComment } = body

  if (!jobId || typeof jobId !== 'string' || jobId.trim() === '') {
    res.status(400).json({ error: 'Validation error: jobId must be a non-empty string.' })
    return
  }

  if (!providerUserId || typeof providerUserId !== 'string' || providerUserId.trim() === '') {
    res.status(400).json({ error: 'Validation error: providerUserId must be a non-empty string.' })
    return
  }

  if (
    typeof ratingScore !== 'number' ||
    !Number.isInteger(ratingScore) ||
    ratingScore < 1 ||
    ratingScore > 5
  ) {
    res.status(400).json({ error: 'Validation error: ratingScore must be an integer between 1 and 5.' })
    return
  }

  if (ratingComment !== undefined && (typeof ratingComment !== 'string' || ratingComment.length > 2000)) {
    res.status(400).json({ error: 'Validation error: ratingComment must be a string of at most 2000 characters.' })
    return
  }

  // Verify the job exists and belongs to the authenticated caller as customer.
  const { data: jobRow, error: jobError } = await admin
    .from('jobs')
    .select('id, status, customer_user_id, craftsman_user_id')
    .eq('id', jobId.trim())
    .single()

  if (jobError || !jobRow) {
    res.status(404).json({ error: 'Job not found.' })
    return
  }

  if (jobRow.status !== 'completed') {
    res.status(422).json({ error: 'Ratings can only be submitted for completed jobs.' })
    return
  }

  if (jobRow.customer_user_id !== auth.userId) {
    res.status(403).json({ error: 'Forbidden: you are not the customer for this job.' })
    return
  }

  // Derive the rated provider from the job itself — never trust the client.
  // ratings.provider_user_id is the craftsman's auth user id, which lives on the
  // job as craftsman_user_id (jobs.provider_id is providers.id, a DB pointer, not
  // an auth uid). Trusting the client-supplied providerUserId would let any
  // customer attribute a rating to an arbitrary provider (reputation poisoning).
  const jobProviderUserId =
    typeof jobRow.craftsman_user_id === 'string' ? jobRow.craftsman_user_id.trim() : ''

  if (!jobProviderUserId) {
    res.status(422).json({ error: 'This job has no assigned provider to rate.' })
    return
  }

  // If the client supplied a providerUserId, it must match the job's provider.
  if (providerUserId.trim() !== jobProviderUserId) {
    res.status(403).json({ error: 'Forbidden: providerUserId does not match the assigned provider for this job.' })
    return
  }

  // Check for duplicate rating.
  const { data: existing } = await admin
    .from('ratings')
    .select('id')
    .eq('job_id', jobId.trim())
    .maybeSingle()

  if (existing) {
    res.status(409).json({ error: 'A rating for this job already exists.' })
    return
  }

  const { data: inserted, error: insertError } = await admin
    .from('ratings')
    .insert({
      job_id: jobId.trim(),
      provider_user_id: jobProviderUserId,
      customer_user_id: auth.userId,
      rating_score: ratingScore,
      rating_comment: typeof ratingComment === 'string' ? ratingComment.trim() : null,
    })
    .select()
    .single()

  if (insertError) {
    logWarning('api.ratings.insert_failed', {
      route: 'submit-rating',
      jobId: jobId.trim(),
      error: insertError.message,
    })
    res.status(500).json({ error: 'Failed to save rating. Please try again.' })
    return
  }

  res.status(201).json({ rating: inserted })
}
