-- offers.price: numeric -> text (align DB with the domain contract)
--
-- ROOT CAUSE (repo<->DB type mismatch):
--   The domain treats offers.price as a HUMAN-READABLE STRING — Offer.price is
--   typed `string` ("Required human-readable gross price (e.g. '1.500 €')") and
--   estimate prices are RANGES ("800 – 1.200 €"). SupabaseOfferRepository.offerToRow
--   sends that raw string. But the DB column was `numeric NOT NULL`, so only a
--   bare-integer input (e.g. "1700") cast successfully; any formatted input
--   ("1700 €", "1.700 €", a range) raised `invalid input syntax for type numeric`
--   (22P02) and the INSERT was rolled back. The chat composer's "send offer" path
--   uses a plain INSERT, so a craftsman typing "1700 €" (matching the field's own
--   "z.B. 1.500 €" placeholder) silently lost every offer. Only 2 offers ever
--   persisted prod-wide (prices 20, 3200 — the bare integers that happened to cast).
--
-- FIX: store price as text — the display string the domain already produces. The
--   authoritative numeric amount lives in `gross_total` (cents, unchanged). Mirrors
--   `valid_until` (also text). No app code changes needed on the chat path — the
--   repository already passes/reads price as a string.
--
-- Blast radius (verified): no views reference offers.price; the only function that
--   writes it is create_spatial_offer (p_price numeric). Its INSERT is updated to
--   cast p_price::text so the numeric spatial amount stores as its text form; the
--   numeric parameter + the `p_price < 0` guard are kept, so the spatial TS caller
--   (createViaSpatialQuoteRpc) is unaffected.
--
-- External steps: none (passive schema change + function replace). No data migration
--   (existing 20, 3200 cast cleanly to '20', '3200').

ALTER TABLE public.offers
  ALTER COLUMN price TYPE text USING price::text;

-- Re-create create_spatial_offer with the single change `p_price` -> `p_price::text`
-- in the INSERT VALUES list. Body otherwise identical to 20260522225544.
CREATE OR REPLACE FUNCTION public.create_spatial_offer(
  p_id uuid,
  p_scene_id uuid,
  p_document_type text,
  p_price numeric,
  p_net_total numeric,
  p_gross_total numeric,
  p_vat_amount numeric,
  p_vat_rate integer,
  p_currency text DEFAULT 'EUR'::text,
  p_line_items jsonb DEFAULT '[]'::jsonb,
  p_spatial_metadata jsonb DEFAULT '{}'::jsonb,
  p_description text DEFAULT NULL::text,
  p_conversation_id uuid DEFAULT NULL::uuid
)
RETURNS offers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
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
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'create_spatial_offer: authentication required'
      USING ERRCODE = '28000';
  END IF;

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

  SELECT * INTO v_scene
    FROM public.spatial_scenes
    WHERE id = p_scene_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'create_spatial_offer: scene % not found', p_scene_id
      USING ERRCODE = '22023';
  END IF;

  IF v_scene.source_job_id IS NULL THEN
    RAISE EXCEPTION
      'create_spatial_offer: scene % has no source_job_id — Spatial-Quote requires job context',
      p_scene_id
      USING ERRCODE = '22023';
  END IF;

  IF v_scene.provider_org_id IS NULL THEN
    RAISE EXCEPTION
      'create_spatial_offer: scene % has no provider_org_id — Quote requires a provider',
      p_scene_id
      USING ERRCODE = '22023';
  END IF;

  v_caller_org := public.spatial_user_provider_org(v_uid);
  IF v_caller_org IS NULL OR v_caller_org IS DISTINCT FROM v_scene.provider_org_id THEN
    RAISE EXCEPTION
      'create_spatial_offer: caller % not authorized for provider_org %',
      v_uid, v_scene.provider_org_id
      USING ERRCODE = '42501';
  END IF;

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

  SELECT * INTO v_job
    FROM public.jobs
    WHERE id = v_scene.source_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'create_spatial_offer: source_job % not found',
      v_scene.source_job_id
      USING ERRCODE = '22023';
  END IF;

  v_customer_uid := coalesce(v_scene.customer_id, v_job.customer_user_id);
  IF v_customer_uid IS NULL THEN
    RAISE EXCEPTION
      'create_spatial_offer: cannot resolve customer for scene %', p_scene_id
      USING ERRCODE = '22023';
  END IF;

  v_conv_id := coalesce(p_conversation_id, v_job.source_conversation_id);

  SELECT * INTO v_offer
    FROM public.offers
    WHERE source_spatial_scene_id = p_scene_id
      AND status = 'pending'
    LIMIT 1;
  IF FOUND THEN
    RETURN v_offer;
  END IF;

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
    p_price::text,
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

  IF v_offer.id IS NULL THEN
    SELECT * INTO v_offer
      FROM public.offers
      WHERE id = p_id;
  END IF;

  RETURN v_offer;
END;
$function$;
