-- @-Handle-System · Block H2a — Personen-Suche (Discovery-RPC)
--
-- Liefert die Server-seitige Handle-/Namens-Suche für den „Neuer Chat"-Flow
-- (H4). Jeder eingeloggte User findet jeden anderen auffindbaren User
-- (Kunde↔Kunde, Kunde↔Handwerker, Handwerker↔Handwerker) über handle oder
-- display_name.
--
-- Bewusst SECURITY DEFINER: die Suche läuft als Owner und ist damit UNABHÄNGIG
-- von den profiles-SELECT-Policies. Sie gibt nur eine PII-minimale Spaltenmenge
-- zurück (KEIN phone, keine Rohzeile) und filtert Blocks in BEIDE Richtungen.
-- Dadurch ist die Discovery bereits sicher, BEVOR die separate, riskante
-- profiles-Policy-Härtung (H2b) angefasst wird.
--
-- Hängt an H1 (profiles.handle/discoverable). Rein additiv, kein DROP.

-- ── 1. Anti-Scraping-Quota ───────────────────────────────────────────────────
-- Tages-Zähler pro User. Nur die SECDEF-Such-RPC (Owner) schreibt/liest ihn;
-- kein direkter Client-Zugriff (RLS an, keine Policy → deny-all von außen).
CREATE TABLE IF NOT EXISTS public.profile_search_quota (
  user_id uuid  NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  day     date  NOT NULL,
  count   int   NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
ALTER TABLE public.profile_search_quota ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.profile_search_quota FROM anon, authenticated;

-- ── 2. Such-RPC ──────────────────────────────────────────────────────────────
-- VOLATILE (schreibt Quota). Normalisiert die Query, erzwingt Auth, prüft das
-- Tageslimit (weich: Überschreitung → leere Liste, kein Fehler), escaped
-- ILIKE-Wildcards, filtert nicht-auffindbare/gebannte/self/geblockte Profile
-- und rankt exakter-Handle > Handle-Prefix > display_name.
CREATE OR REPLACE FUNCTION public.rpc_search_profiles(p_query text)
RETURNS TABLE (
  profile_id      uuid,
  handle          text,
  display_name    text,
  role            text,
  craftsman_role  text,
  provider_handle text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_q     text;
  v_esc   text;
  v_count int;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  -- Normalisierung: trim, lowercase, ein führendes '@' strippen.
  v_q := lower(btrim(coalesce(p_query, '')));
  IF left(v_q, 1) = '@' THEN
    v_q := substr(v_q, 2);
  END IF;

  -- Zu kurz → leere Liste (kein Enumeration-Blankoscheck).
  IF length(v_q) < 2 THEN
    RETURN;
  END IF;

  -- Tageslimit 300 (Anti-Scraping). Zählt JEDE valide Suche; über Limit →
  -- leere Liste statt Fehler (UX-Entscheid laut Plan).
  INSERT INTO public.profile_search_quota AS q (user_id, day, count)
  VALUES (v_uid, current_date, 1)
  ON CONFLICT (user_id, day) DO UPDATE SET count = q.count + 1
  RETURNING q.count INTO v_count;

  IF v_count > 300 THEN
    RETURN;
  END IF;

  -- ILIKE-Wildcards im User-Input neutralisieren (Escape-Zeichen '\').
  v_esc := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');

  RETURN QUERY
  SELECT
    p.id,
    p.handle,
    p.display_name,
    p.role,
    p.craftsman_role,
    (SELECT pr.handle FROM public.providers pr WHERE pr.profile_id = p.id LIMIT 1)
  FROM public.profiles p
  WHERE p.handle IS NOT NULL
    AND p.discoverable
    AND p.moderation_state = 'active'
    AND p.id <> v_uid
    AND NOT EXISTS (
      SELECT 1 FROM public.user_blocks b
      WHERE (b.blocker_id = v_uid AND b.blocked_id = p.id)
         OR (b.blocker_id = p.id AND b.blocked_id = v_uid)
    )
    AND (
      p.handle = v_q
      OR p.handle LIKE v_esc || '%' ESCAPE '\'
      OR (p.display_name IS NOT NULL AND p.display_name ILIKE '%' || v_esc || '%' ESCAPE '\')
    )
  ORDER BY
    CASE
      WHEN p.handle = v_q                         THEN 0
      WHEN p.handle LIKE v_esc || '%' ESCAPE '\'  THEN 1
      ELSE 2
    END,
    p.handle
  LIMIT 10;
END;
$$;

-- ── 3. Grants ────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.rpc_search_profiles(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_search_profiles(text) TO authenticated;

-- ── 4. PostgREST Schema-Cache ────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
