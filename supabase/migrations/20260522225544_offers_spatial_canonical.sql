-- Spatial Canonical · C-10 · Offers-Domain Spatial-Linkage + create_spatial_offer RPC
--
-- Purpose:
--   Closes the C-10 gap. Until this migration a Spatial-Quote sent from
--   JobSpatialBomTab.handleQuoteSend ONLY wrote scene.metadata.{quoteSentAt,
--   quoteSentChannels, quoteTotalCents} — no canonical `offers` row was
--   created. As a result the customer's In-App-Offer-list (Hub) showed
--   nothing, accept/decline FSM could not run, payment-gating never engaged,
--   and the offer-domain hydration carried zero entries for Spatial-Quotes.
--
-- What this migration does:
--   1. Adds `offers.source_spatial_scene_id` (FK → spatial_scenes.id,
--      ON DELETE SET NULL) — the canonical link from an offer back to the
--      scene whose BoM produced it. Distinct from `stale_source_scene_id`
--      (added in 20260520120041), which records the stale-trigger source
--      (VF-2 path) — an offer may carry both: the scene of origin AND a
--      later scene that invalidated it. Semantics are disjoint.
--   2. Adds `offers.spatial_metadata jsonb` — captures BoM-item richness
--      (nodeId scene-anchors + source=auto|manual) that QuoteLineItem cannot
--      express. Future Edit-Override + VF-2-Diff paths require it.
--   3. Adds `offers.pdf_url text` — populated by C10.8 (Offer-PDF). NULL
--      until the PDF generator ships; consumers must null-guard.
--   4. Drops NOT NULL from `offers.conversation_id`. Spatial-Quotes are
--      anchored to scene + job, not necessarily to an inquiry-thread; an
--      offer may exist without a conversation. The existing FK
--      (offers_conversation_id_fkey → conversations.id ON DELETE CASCADE)
--      remains intact and works with nullable columns (the cascade only
--      fires when the FK value is non-null).
--   5. Partial index on `source_spatial_scene_id` — supports
--      OfferRepository.findBySpatialScene reverse-lookups + the Hub Activity
--      feed's "this scene produced an offer" badge.
--   6. UNIQUE partial index `uq_offers_one_pending_per_spatial_scene` —
--      enforces server-side idempotency: at most one pending offer per
--      spatial scene, mirroring the conversation-side guard. A second
--      Quote-Send for the same scene returns the existing pending row
--      (RPC step 11) instead of duplicating.
--   7. SECURITY DEFINER RPC `create_spatial_offer` — the single non-RLS-
--      blocked INSERT path for Spatial-Quotes. Bypasses the RESTRICTIVE
--      `offers_pro_gate_insert` policy (`is_pro_owner(auth.uid())`) so a
--      Worker (team_member without their own Pro plan) can send a Quote
--      under the Org-Owner's Pro plan, matching the Worker-Walk-Capture
--      flow shipped in B9. Server-side guards:
--        a. Caller must be authenticated.
--        b. All required args set, document_type ∈ {binding_offer,
--           cost_estimate}, price ≥ 0.
--        c. Scene exists, has source_job_id (Quote needs job-context for
--           push-routing in C10.5), has provider_org_id (Quote needs a
--           provider Org).
--        d. Caller's effective provider org (`spatial_user_provider_org`,
--           which returns the Owner's `providers.id` directly or the
--           active team_member's `provider_id`) matches the scene's
--           provider_org_id. Owner-direct AND Worker paths both authorize.
--        e. Org-Owner (providers.profile_id for scene.provider_org_id) has
--           an active Pro subscription via `is_pro_owner`. Worker callers
--           ride the Org-Owner's entitlement.
--        f. Customer resolved as COALESCE(scene.customer_id, job.
--           customer_user_id) — scene-side is authoritative per the
--           spatial_create_scene derivation; job is fallback.
--        g. Conversation resolved as COALESCE(p_conversation_id, job.
--           source_conversation_id) — NULL accepted (anchored to scene
--           instead of inquiry).
--        h. Idempotency: existing pending offer for the scene short-
--           circuits before INSERT. ON CONFLICT (id) DO NOTHING + re-read
--           covers the concurrent-call race.
--      `craftsman_user_id` is set to the Org-Owner's profile id (not the
--      caller) so the Owner sees the offer via the existing offers_select_
--      own policy. Worker visibility of their own sent offers needs a
--      separate team_members-aware SELECT policy — out of C-10 scope.
--
-- Architecture decisions (FINAL 2026-05-23):
--   AD-1 SECURITY DEFINER RPC matches the spatial_create_scene pattern
--        (AD-2 of that migration). Transactional atomicity, no edge
--        function deploy, ownership-checked server-side.
--   AD-2 Workflow-layer RBAC is mandatory per CLAUDE.md; the RPC is the
--        workflow layer's server-side enforcement point.
--   AD-3 Org-Owner Pro plan covers Worker callers — matches the team_members
--        membership semantics already used by spatial_user_provider_org.
--   AD-4 conversation_id is NULLABLE not just "optional in the application
--        layer" — the column itself must allow NULL or the RPC INSERT fails
--        before SECURITY DEFINER can bypass anything.
--   AD-5 documentType is the Provider's choice (UI toggle in C10.4), not
--        hardcoded. The CHECK constraint already accepts both values.
--
-- Schema facts verified read-only against prod (itdntawwuzqfwmcwnwjr · 2026-05-23):
--   - offers.id / conversation_id / customer_user_id / craftsman_user_id /
--     created_job_id are uuid (NOT text — the repo's 20260319000001 baseline
--     is drift; later UUID migration was applied prod-only).
--   - offers.price is numeric, not text.
--   - offers_status_check accepts {draft, pending, accepted, declined,
--     expired, superseded, cancelled}.
--   - offers_document_type_check accepts {estimate, cost_estimate,
--     binding_offer, diagnosis} — binding_offer + cost_estimate cover C-10.
--   - offers_context_type_check accepts {conversation, inquiry, project}.
--   - offers_conversation_id_fkey is ON DELETE CASCADE (untouched here;
--     nullable column + cascade is valid — cascade only fires on non-null).
--   - offers_pro_gate_insert is RESTRICTIVE — must be bypassed via
--     SECURITY DEFINER for Worker callers.
--   - uq_offers_one_pending_per_conversation is a partial unique index
--     keyed on conversation_id WHERE status='pending'. Nulls are distinct
--     in btree, so NULL conversation_id rows do not collide — our spatial-
--     scene unique index handles their idempotency.
--   - is_pro_owner(uuid, timestamptz default now()) exists, SECURITY DEFINER.
--   - is_pro_team_member does NOT exist; we authorize via spatial_user_
--     provider_org which already covers Owner+Worker.
--   - spatial_scenes has columns id, provider_id (auth user), provider_org_
--     id (providers.id), customer_id, source_job_id (all uuid).
--   - jobs.source_conversation_id is uuid + nullable.
--   - 1 offer exists prod-side, 0 with NULL conversation_id, 0 pending →
--     DROP NOT NULL is risk-free.
--
-- External steps:
--   1. Supabase Dashboard → Settings → API → Reload schema cache
--      (so PostgREST exposes the new RPC at /rest/v1/rpc/create_spatial_offer
--      and the three new offers columns at /rest/v1/offers).
--   No env vars, no edge-function deploy, no webhook changes.
--
-- Plan reference: ~/.claude/plans/spatial-c10-canonical-offer-spec.md
--                 ~/.claude/plans/spatial-scene-production-post-d2-d3-handover.md §4


-- ── 1. Columns ────────────────────────────────────────────────────────────────

ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS source_spatial_scene_id uuid
    REFERENCES public.spatial_scenes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS spatial_metadata jsonb,
  ADD COLUMN IF NOT EXISTS pdf_url text;

ALTER TABLE public.offers
  ALTER COLUMN conversation_id DROP NOT NULL;

COMMENT ON COLUMN public.offers.source_spatial_scene_id IS
  'Spatial C-10: the canonical scene whose BoM produced this offer (set by '
  'create_spatial_offer RPC). NULL for non-spatial offers. Distinct from '
  'stale_source_scene_id (VF-2 stale-trigger source); semantics are disjoint '
  '— an offer may carry both. ON DELETE SET NULL: deleting a scene severs '
  'the linkage without losing the offer history.';

COMMENT ON COLUMN public.offers.spatial_metadata IS
  'Spatial C-10: captures BoM-item richness that QuoteLineItem cannot express '
  '— nodeId scene-anchors and source=auto|manual per line item, plus scene-'
  'derived totals breakdown. Required by future Edit-Override and VF-2-Diff '
  'paths. NULL for non-spatial offers.';

COMMENT ON COLUMN public.offers.pdf_url IS
  'Spatial C-10/C10.8: storage URL of the generated offer PDF. NULL until '
  'C10.8 PDF generator runs (auto on offer-create + on-demand button). '
  'Consumers must null-guard.';

COMMENT ON COLUMN public.offers.conversation_id IS
  'Conversation anchor for the offer. NULLABLE since Spatial C-10 — Spatial-'
  'Quotes are anchored to scene + job and may exist without an inquiry-thread. '
  'FK ON DELETE CASCADE is intact; cascade only fires for non-null values.';


-- ── 2. Indexes ────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS offers_source_spatial_scene_idx
  ON public.offers (source_spatial_scene_id)
  WHERE source_spatial_scene_id IS NOT NULL;

COMMENT ON INDEX public.offers_source_spatial_scene_idx IS
  'Spatial C-10: partial index supporting OfferRepository.findBySpatialScene '
  'reverse-lookups and the Hub Activity-Feed "scene produced an offer" badge. '
  'WHERE-clause keeps non-spatial offers out of the index.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_offers_one_pending_per_spatial_scene
  ON public.offers (source_spatial_scene_id)
  WHERE source_spatial_scene_id IS NOT NULL AND status = 'pending';

COMMENT ON INDEX public.uq_offers_one_pending_per_spatial_scene IS
  'Spatial C-10: at most one pending offer per spatial scene — the server-'
  'side idempotency guard for repeated Quote-Send taps. Mirrors '
  'uq_offers_one_pending_per_conversation. RPC create_spatial_offer relies on '
  'this constraint as the safety net behind its in-RPC pre-check (step 11).';


-- ── 3. RPC create_spatial_offer ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_spatial_offer(
  p_id               uuid,
  p_scene_id         uuid,
  p_document_type    text,
  p_price            numeric,
  p_net_total        numeric,
  p_gross_total      numeric,
  p_vat_amount       numeric,
  p_vat_rate         integer,
  p_currency         text    DEFAULT 'EUR',
  p_line_items       jsonb   DEFAULT '[]'::jsonb,
  p_spatial_metadata jsonb   DEFAULT '{}'::jsonb,
  p_description      text    DEFAULT NULL,
  p_conversation_id  uuid    DEFAULT NULL
)
RETURNS public.offers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid           uuid := auth.uid();
  v_scene         public.spatial_scenes;
  v_job           public.jobs;
  v_owner_uid     uuid;
  v_caller_org    uuid;
  v_customer_uid  uuid;
  v_conv_id       uuid;
  v_offer         public.offers;
  v_now_ms        bigint := (EXTRACT(EPOCH FROM now()) * 1000)::bigint;
BEGIN
  -- 1. Auth
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'create_spatial_offer: authentication required'
      USING ERRCODE = '28000';
  END IF;

  -- 2. Required args + value guards
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'create_spatial_offer: p_id required (client-generated offer uuid)'
      USING ERRCODE = '22023';
  END IF;
  IF p_scene_id IS NULL THEN
    RAISE EXCEPTION 'create_spatial_offer: p_scene_id required'
      USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_document_type, '') NOT IN ('binding_offer', 'cost_estimate') THEN
    RAISE EXCEPTION
      'create_spatial_offer: p_document_type must be binding_offer | cost_estimate (got %)',
      p_document_type
      USING ERRCODE = '22023';
  END IF;
  IF p_price IS NULL OR p_price < 0 THEN
    RAISE EXCEPTION 'create_spatial_offer: p_price required and non-negative'
      USING ERRCODE = '22023';
  END IF;

  -- 3. Load scene
  SELECT * INTO v_scene
    FROM public.spatial_scenes
    WHERE id = p_scene_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'create_spatial_offer: scene % not found', p_scene_id
      USING ERRCODE = '22023';
  END IF;

  -- 4. Scene must be job-anchored (Quote needs job-context for push-routing C10.5)
  IF v_scene.source_job_id IS NULL THEN
    RAISE EXCEPTION
      'create_spatial_offer: scene % has no source_job_id — Spatial-Quote requires job context',
      p_scene_id
      USING ERRCODE = '22023';
  END IF;

  -- 5. Scene must have a provider Org
  IF v_scene.provider_org_id IS NULL THEN
    RAISE EXCEPTION
      'create_spatial_offer: scene % has no provider_org_id — Quote requires a provider',
      p_scene_id
      USING ERRCODE = '22023';
  END IF;

  -- 6. Authorization: caller's effective provider org must match the scene's.
  --    spatial_user_provider_org returns the Owner's providers.id directly
  --    OR an active team_member's provider_id — both Owner and Worker paths
  --    pass through the same check. Columns are well-typed UUIDs; the
  --    comparison is robust against NULL on either side (IS DISTINCT FROM).
  v_caller_org := public.spatial_user_provider_org(v_uid);
  IF v_caller_org IS NULL OR v_caller_org IS DISTINCT FROM v_scene.provider_org_id THEN
    RAISE EXCEPTION
      'create_spatial_offer: caller % not authorized for provider_org %',
      v_uid, v_scene.provider_org_id
      USING ERRCODE = '42501';
  END IF;

  -- 7. Resolve Org-Owner profile (providers.profile_id), enforce Pro-Gate.
  --    Worker callers ride the Org-Owner's entitlement — matches the
  --    business model where the Org buys Pro and its team members operate
  --    under it.
  SELECT p.profile_id INTO v_owner_uid
    FROM public.providers p
    WHERE p.id = v_scene.provider_org_id;
  IF v_owner_uid IS NULL THEN
    RAISE EXCEPTION
      'create_spatial_offer: cannot resolve provider org % owner profile',
      v_scene.provider_org_id
      USING ERRCODE = '22023';
  END IF;
  IF NOT public.is_pro_owner(v_owner_uid) THEN
    RAISE EXCEPTION
      'create_spatial_offer: provider org % owner does not have an active Pro plan',
      v_scene.provider_org_id
      USING ERRCODE = '42501';
  END IF;

  -- 8. Load job for customer + conversation fallback
  SELECT * INTO v_job
    FROM public.jobs
    WHERE id = v_scene.source_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'create_spatial_offer: source_job % not found',
      v_scene.source_job_id
      USING ERRCODE = '22023';
  END IF;

  -- 9. Customer resolution — scene.customer_id is authoritative
  --    (set server-side by spatial_create_scene from scan/job derivation);
  --    fall back to job.customer_user_id when the scene predates customer
  --    derivation or was customer-cleared (rare).
  v_customer_uid := coalesce(v_scene.customer_id, v_job.customer_user_id);
  IF v_customer_uid IS NULL THEN
    RAISE EXCEPTION
      'create_spatial_offer: cannot resolve customer for scene %', p_scene_id
      USING ERRCODE = '22023';
  END IF;

  -- 10. Conversation resolution — explicit override wins, else job.source_
  --     conversation_id, else NULL. NULL is allowed (column became nullable
  --     in §1 of this migration). context_type follows: 'conversation' when
  --     a thread exists, 'project' otherwise (matches offers_context_type_check).
  v_conv_id := coalesce(p_conversation_id, v_job.source_conversation_id);

  -- 11. Idempotency: existing pending offer for this scene → return it.
  --     uq_offers_one_pending_per_spatial_scene is the DB-level safety net
  --     behind this in-RPC pre-check.
  SELECT * INTO v_offer
    FROM public.offers
    WHERE source_spatial_scene_id = p_scene_id
      AND status = 'pending'
    LIMIT 1;
  IF FOUND THEN
    RETURN v_offer;
  END IF;

  -- 12. Insert. craftsman_user_id = Org-Owner profile so the Owner sees the
  --     offer via the existing offers_select_own policy. Worker self-view
  --     of sent offers needs a separate team_members-aware SELECT policy —
  --     out of C-10 scope; tracked in C10 PR description.
  --
  --     ON CONFLICT (id) DO NOTHING covers concurrent retries with the same
  --     client-generated p_id (step 13 re-reads the winning row). The
  --     uq_offers_one_pending_per_spatial_scene index will also reject a
  --     second pending row for the same scene if step 11's pre-check ever
  --     misses (e.g. SERIALIZABLE race) — surfaced as 23505 to the caller.
  INSERT INTO public.offers (
    id,
    conversation_id,
    customer_user_id,
    craftsman_user_id,
    price,
    description,
    status,
    sent_at,
    currency,
    gross_total,
    net_total,
    vat_amount,
    vat_rate,
    line_items,
    document_type,
    context_type,
    source_spatial_scene_id,
    spatial_metadata
  )
  VALUES (
    p_id,
    v_conv_id,
    v_customer_uid,
    v_owner_uid,
    p_price,
    p_description,
    'pending',
    v_now_ms,
    coalesce(p_currency, 'EUR'),
    p_gross_total,
    p_net_total,
    p_vat_amount,
    p_vat_rate,
    coalesce(p_line_items, '[]'::jsonb),
    p_document_type,
    CASE WHEN v_conv_id IS NULL THEN 'project' ELSE 'conversation' END,
    p_scene_id,
    coalesce(p_spatial_metadata, '{}'::jsonb)
  )
  ON CONFLICT (id) DO NOTHING
  RETURNING * INTO v_offer;

  -- 13. ON CONFLICT race-fallback — re-read the winning row.
  IF v_offer.id IS NULL THEN
    SELECT * INTO v_offer
      FROM public.offers
      WHERE id = p_id;
  END IF;

  RETURN v_offer;
END;
$$;

COMMENT ON FUNCTION public.create_spatial_offer(
  uuid, uuid, text, numeric, numeric, numeric, numeric, integer,
  text, jsonb, jsonb, text, uuid
) IS
  'Spatial Canonical C-10: the canonical Spatial-Quote INSERT path. SECURITY '
  'DEFINER RPC that bypasses the RESTRICTIVE offers_pro_gate_insert policy '
  'so Worker callers can send under the Org-Owner''s Pro plan. Ownership-'
  'guarded (caller''s spatial_user_provider_org must match scene.provider_'
  'org_id; Org-Owner must have is_pro_owner=true). Customer derived from '
  'scene.customer_id with job.customer_user_id fallback. Conversation '
  'resolved from explicit param or job.source_conversation_id (nullable). '
  'Idempotent per (source_spatial_scene_id, status=pending) — repeated '
  'Quote-Send taps return the existing pending offer. craftsman_user_id is '
  'set to the Org-Owner''s profile so it appears in offers_select_own.';

REVOKE EXECUTE ON FUNCTION public.create_spatial_offer(
  uuid, uuid, text, numeric, numeric, numeric, numeric, integer,
  text, jsonb, jsonb, text, uuid
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_spatial_offer(
  uuid, uuid, text, numeric, numeric, numeric, numeric, integer,
  text, jsonb, jsonb, text, uuid
) TO authenticated, service_role;


-- ── Rollback ──────────────────────────────────────────────────────────────────
-- DROP FUNCTION IF EXISTS public.create_spatial_offer(
--   uuid, uuid, text, numeric, numeric, numeric, numeric, integer,
--   text, jsonb, jsonb, text, uuid);
-- DROP INDEX IF EXISTS public.uq_offers_one_pending_per_spatial_scene;
-- DROP INDEX IF EXISTS public.offers_source_spatial_scene_idx;
-- -- Restoring NOT NULL on conversation_id requires backfilling all
-- -- Spatial-Quote offers with a conversation first; do not rollback blindly.
-- -- ALTER TABLE public.offers ALTER COLUMN conversation_id SET NOT NULL;
-- ALTER TABLE public.offers DROP COLUMN IF EXISTS pdf_url;
-- ALTER TABLE public.offers DROP COLUMN IF EXISTS spatial_metadata;
-- ALTER TABLE public.offers DROP COLUMN IF EXISTS source_spatial_scene_id;
