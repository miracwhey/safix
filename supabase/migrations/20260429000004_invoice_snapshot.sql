-- =============================================================================
-- Block 7.1B3 — Invoice Snapshot + §14 Hard-Gates
-- =============================================================================
-- Erweiterung der `invoices`-Tabelle um den unveränderlichen §14-UStG-Snapshot,
-- der beim Übergang draft → issued aus Provider-Tax-Profile (B1) und
-- Customer-Billing-Profile (B2) plus akzeptierten ChangeOrders eingefroren wird.
--
-- Pre-Deploy-Schema-Verifikation gegen Prod (information_schema.columns) hat
-- bestätigt: keine der hier hinzugefügten Spalten existiert bereits.
-- Auch `sent_at` fehlt heute in Prod (Code schreibt es, DDL lag aber nie vor).
--
-- Reihenfolge der Pushes auf Prod:
--   1. supabase db push 20260429000002_providers_tax_billing_profile.sql (B1)
--   2. supabase db push 20260429000003_customer_billing_profiles.sql     (B2)
--   3. supabase db push 20260429000004_invoice_snapshot.sql              (B3)
-- =============================================================================

-- 1. sent_at — vom App-Code seit Block 8 erwartet, in DDL nie angelegt.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS sent_at bigint NOT NULL DEFAULT 0;

-- 2. Service-Period (Leistungszeitraum gemäß §14 (4) Nr. 6 UStG).
--    `*_from` / `*_to` sind Unix-ms Timestamps, `label` ist der gerenderte Text
--    auf der Rechnung. NULL solange im Draft.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS service_period_from  bigint,
  ADD COLUMN IF NOT EXISTS service_period_to    bigint,
  ADD COLUMN IF NOT EXISTS service_period_label text;

-- 3. Steuer-Aufstellung gruppiert nach Steuersatz (§14 (4) Nr. 7+8 UStG).
--    jsonb array of { vatRate:number, netAmount:number, taxAmount:number, grossAmount:number }.
--    NULL solange im Draft.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS tax_breakdown jsonb;

-- 4. Steuerhinweis (Kleinunternehmer §19 / Reverse-Charge Vorbereitung).
--    NULL wenn keine Hinweispflicht; bei Kleinunternehmer der §19-Hinweis-Text.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS tax_note text;

-- 5. Quellen-Referenzen (Audit-Trail für die Issuance-Quelle).
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS source_offer_id                  uuid,
  ADD COLUMN IF NOT EXISTS source_change_order_ids          jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS source_supplementary_payment_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 6. Provider- und Customer-Snapshot (eingefroren beim draft → issued).
--    Strukturiertes jsonb mit Steuer-/Rechnungsdaten beider Parteien.
--    NULL solange im Draft.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS provider_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS customer_snapshot jsonb;

-- =============================================================================
-- 7. SECURITY DEFINER RPC — Provider-seitige Snapshot-Lese der Customer-
--    Billing-Daten am Issue-Time (RLS auf customer_billing_profiles ist
--    owner-only; ohne diese RPC könnte der Provider die §14-pflichtige
--    Empfänger-Anschrift nicht in den Snapshot übernehmen).
--
--    Authorisation: nur der craftsman_user_id des referenzierten Jobs darf
--    lesen — nicht andere Provider, nicht andere Customer.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_customer_billing_for_invoice(
  p_job_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_uid_text  text;
  v_craftsman_uid    text;
  v_customer_uid     uuid;
  v_profile          public.customer_billing_profiles%ROWTYPE;
BEGIN
  v_caller_uid_text := auth.uid()::text;
  IF v_caller_uid_text IS NULL THEN
    RAISE EXCEPTION 'auth required'
      USING ERRCODE = '28000';
  END IF;

  SELECT j.craftsman_user_id, j.customer_user_id
    INTO v_craftsman_uid, v_customer_uid
  FROM public.jobs j
  WHERE j.id = p_job_id
  LIMIT 1;

  IF v_craftsman_uid IS NULL THEN
    RAISE EXCEPTION 'job not found'
      USING ERRCODE = '02000';
  END IF;

  IF v_craftsman_uid <> v_caller_uid_text THEN
    RAISE EXCEPTION 'not authorised for job %', p_job_id
      USING ERRCODE = '42501';
  END IF;

  IF v_customer_uid IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT *
    INTO v_profile
  FROM public.customer_billing_profiles
  WHERE user_id = v_customer_uid
  LIMIT 1;

  IF v_profile.id IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'userId',                v_profile.user_id,
    'billingName',           v_profile.billing_name,
    'billingAddressLine1',   v_profile.billing_address_line1,
    'billingAddressLine2',   v_profile.billing_address_line2,
    'billingPostalCode',     v_profile.billing_postal_code,
    'billingCity',           v_profile.billing_city,
    'billingCountry',        v_profile.billing_country,
    'billingEmail',          v_profile.billing_email,
    'billingPhone',          v_profile.billing_phone,
    'isBusiness',            COALESCE(v_profile.is_business, FALSE),
    'businessName',          v_profile.business_name,
    'vatId',                 v_profile.vat_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_customer_billing_for_invoice(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_customer_billing_for_invoice(uuid) TO authenticated;
