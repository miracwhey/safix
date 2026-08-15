-- @-Handle-System · Block H1 — Identitäts-Fundament
--
-- Führt eine kanonische Personen-Identität `profiles.handle` für ALLE User ein
-- (Kunden UND Handwerker), damit sich Nutzer↔Nutzer, Nutzer↔Handwerker,
-- Handwerker↔Handwerker per @-Tag finden können. Getrennt vom Legacy
-- `providers.handle` (Firmen-Alias, mit führendem '@') — dieses bleibt
-- unangetastet.
--
-- Enthält: reserved_handles, handle/discoverable/dm_privacy-Spalten,
-- Format-CHECK, case-insensitiver Unique-Index, slugify-Funktion,
-- deterministischer Backfill (verifiziert gegen Prod-Daten 2026-07-05),
-- DB-weiter reserved-Guard-Trigger, claim/check-RPCs.
--
-- Apply-Reihenfolge-sicher: rein additiv, kein DROP, keine Änderung an
-- providers/craftsman_profiles. Kein Auto-Handle im Signup — neue User
-- claimen im UI (Block H4).

-- ── 1. Reservierte Handles ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.reserved_handles (
  handle text PRIMARY KEY
);
ALTER TABLE public.reserved_handles ENABLE ROW LEVEL SECURITY;
-- Nur SECURITY-DEFINER-Funktionen lesen die Liste; keine anon/authenticated-Policy
-- (kein direkter Client-Zugriff nötig, verhindert Enumeration).

INSERT INTO public.reserved_handles (handle) VALUES
  ('safix'), ('fixup'), ('admin'), ('administrator'), ('support'), ('hilfe'),
  ('help'), ('info'), ('kontakt'), ('contact'), ('system'), ('mod'),
  ('moderator'), ('moderation'), ('team'), ('official'), ('offiziell'),
  ('root'), ('null'), ('undefined'), ('me'), ('you'), ('all'), ('everyone')
ON CONFLICT (handle) DO NOTHING;

-- ── 2. Spalten ───────────────────────────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS handle            text,
  ADD COLUMN IF NOT EXISTS handle_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS discoverable      boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS dm_privacy        text    NOT NULL DEFAULT 'everyone';

-- Format: lowercase, erstes Zeichen [a-z0-9_], danach [a-z0-9_.], Länge 3–30.
-- Ohne führendes '@' (das ist Anzeige-/Eingabe-Layer, nicht Speicherung).
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_handle_format_chk;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_handle_format_chk
  CHECK (handle IS NULL OR handle ~ '^[a-z0-9_][a-z0-9_.]{2,29}$');

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_dm_privacy_chk;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_dm_privacy_chk
  CHECK (dm_privacy IN ('everyone', 'nobody'));

-- Case-insensitiver Unique-Index. handle wird lowercase gespeichert (CHECK
-- erzwingt es), lower() ist daher redundant-sicher gegen manuelle Writes.
CREATE UNIQUE INDEX IF NOT EXISTS profiles_handle_lower_unique_idx
  ON public.profiles (lower(handle)) WHERE handle IS NOT NULL;

-- ── 3. slugify ───────────────────────────────────────────────────────────────
-- Deterministische Normalisierung eines Roh-Strings (display_name oder
-- provider-handle ohne '@') in einen Handle-Kandidaten. Deutsche Umlaute/ß
-- werden mehrbuchstabig transliteriert (ü→ue), gängige Akzente 1:1 auf den
-- Basisbuchstaben, Rest der Nicht-[a-z0-9_.] entfernt, Whitespace → '_'.
-- Länge/Reserviertheit werden vom Aufrufer geprüft (nicht hier).
-- IMMUTABLE: rein von Input abhängig.
CREATE OR REPLACE FUNCTION public.slugify_handle(input text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE s text;
BEGIN
  s := lower(coalesce(input, ''));
  s := replace(s, 'ä', 'ae');
  s := replace(s, 'ö', 'oe');
  s := replace(s, 'ü', 'ue');
  s := replace(s, 'ß', 'ss');
  s := translate(s, 'áàâãéèêíìîóòôõúùûñç', 'aaaaeeeiiioooouuunc');
  s := regexp_replace(s, '[[:space:]]+', '_', 'g');
  s := regexp_replace(s, '[^a-z0-9_.]', '', 'g');
  s := regexp_replace(s, '^[._]+', '', 'g');   -- führende Punkte/Unterstriche → erstes Zeichen muss [a-z0-9_] sein; Punkte raus
  RETURN s;
END;
$$;

-- ── 4. Backfill ──────────────────────────────────────────────────────────────
-- Vergibt Handles an Bestandsuser. Basis = provider-handle (ohne '@')
-- bevorzugt, sonst display_name. Kollisions-/Reserviert-Auflösung per
-- numerischem Suffix. User ohne verwertbaren Namen bleiben handle=NULL
-- (nicht auffindbar bis Selbst-Claim). Erstvergabe → handle_changed_at bleibt
-- NULL (zählt nicht als Änderung fürs Rate-Limit).
DO $$
DECLARE
  r    record;
  base text;
  cand text;
  n    int;
BEGIN
  FOR r IN
    SELECT p.id, p.display_name, pr.handle AS provider_handle
    FROM public.profiles p
    LEFT JOIN public.providers pr ON pr.profile_id = p.id
    WHERE p.handle IS NULL
    ORDER BY p.created_at
  LOOP
    base := public.slugify_handle(
      coalesce(nullif(ltrim(coalesce(r.provider_handle, ''), '@'), ''), r.display_name)
    );

    -- Kein verwertbarer Slug (leer / zu kurz) → kein Handle.
    IF base IS NULL OR length(base) < 3 THEN
      CONTINUE;
    END IF;
    -- Auf 30 Zeichen kappen (Format-Obergrenze).
    base := left(base, 30);

    cand := base;
    n := 1;
    -- Suffix-Loop bei Reserviert-/Kollisions-Treffer.
    WHILE EXISTS (SELECT 1 FROM public.reserved_handles rh WHERE rh.handle = cand)
       OR EXISTS (SELECT 1 FROM public.profiles p2 WHERE lower(p2.handle) = cand)
    LOOP
      n := n + 1;
      -- Basis so kürzen, dass base||n ≤ 30 bleibt.
      cand := left(base, 30 - length(n::text)) || n::text;
    END LOOP;

    UPDATE public.profiles SET handle = cand WHERE id = r.id;
  END LOOP;
END;
$$;

-- ── 5. DB-weiter reserved-Guard ──────────────────────────────────────────────
-- Erzwingt reservierte Namen unabhängig vom RPC — auch ein direkter
-- PostgREST-INSERT/UPDATE auf profiles.handle kann keinen reservierten Handle
-- setzen. Format + Eindeutigkeit sind bereits durch CHECK + Unique-Index
-- erzwungen. Bei INSERT ist OLD NULL → `IS NOT DISTINCT FROM` greift nur, wenn
-- auch NEW.handle NULL ist (dann kein Check nötig).
CREATE OR REPLACE FUNCTION public.profiles_handle_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.handle IS NOT DISTINCT FROM OLD.handle THEN
    RETURN NEW;
  END IF;
  IF NEW.handle IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.reserved_handles rh WHERE rh.handle = lower(NEW.handle)) THEN
    RAISE EXCEPTION 'handle_reserved' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_handle_guard_tg ON public.profiles;
CREATE TRIGGER profiles_handle_guard_tg
  BEFORE INSERT OR UPDATE OF handle ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_handle_guard();

-- ── 6. RPC: Verfügbarkeits-Check (Live-UI) ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.rpc_check_handle_available(p_handle text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'handle',       h.norm,
    'valid_format', h.norm ~ '^[a-z0-9_][a-z0-9_.]{2,29}$',
    'reserved',     EXISTS (SELECT 1 FROM public.reserved_handles r WHERE r.handle = h.norm),
    'available', (
      h.norm ~ '^[a-z0-9_][a-z0-9_.]{2,29}$'
      AND NOT EXISTS (SELECT 1 FROM public.reserved_handles r WHERE r.handle = h.norm)
      AND NOT EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE lower(p.handle) = h.norm AND p.id IS DISTINCT FROM auth.uid()
      )
    )
  )
  FROM (SELECT ltrim(lower(btrim(coalesce(p_handle, ''))), '@') AS norm) h;
$$;

-- ── 7. RPC: Handle claimen/ändern (Chokepoint) ───────────────────────────────
-- Einziger empfohlener Vergabe-Weg. Prüft Auth, Format, Reserviert, Rate-Limit
-- (max. 1 Änderung / 30 Tage; Erstvergabe unbegrenzt) und Eindeutigkeit mit
-- sauberem Fehler-Mapping. Der DB-Guard + Unique-Index + CHECK bleiben die
-- harte Erzwingungsschicht auch gegen direkte Writes.
CREATE OR REPLACE FUNCTION public.rpc_claim_handle(p_handle text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_norm    text;
  v_current text;
  v_changed timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  v_norm := ltrim(lower(btrim(coalesce(p_handle, ''))), '@');

  IF v_norm !~ '^[a-z0-9_][a-z0-9_.]{2,29}$' THEN
    RAISE EXCEPTION 'handle_invalid_format' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.reserved_handles WHERE handle = v_norm) THEN
    RAISE EXCEPTION 'handle_reserved' USING ERRCODE = '22023';
  END IF;

  SELECT handle, handle_changed_at INTO v_current, v_changed
  FROM public.profiles WHERE id = v_uid;

  -- No-op (schon der eigene Handle).
  IF v_current IS NOT NULL AND lower(v_current) = v_norm THEN
    RETURN v_current;
  END IF;

  -- Rate-Limit gilt nur für Änderungen, nicht für die Erstvergabe.
  IF v_current IS NOT NULL AND v_changed IS NOT NULL
     AND v_changed > now() - interval '30 days' THEN
    RAISE EXCEPTION 'handle_change_rate_limited' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (SELECT 1 FROM public.profiles WHERE lower(handle) = v_norm AND id <> v_uid) THEN
    RAISE EXCEPTION 'handle_taken' USING ERRCODE = '23505';
  END IF;

  UPDATE public.profiles
     SET handle            = v_norm,
         handle_changed_at = CASE WHEN v_current IS NULL THEN handle_changed_at ELSE now() END
   WHERE id = v_uid;

  RETURN v_norm;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'handle_taken' USING ERRCODE = '23505';
END;
$$;

-- ── 8. Grants ────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.slugify_handle(text)             FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_check_handle_available(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_claim_handle(text)           FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_check_handle_available(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_claim_handle(text)           TO authenticated;

-- ── 9. PostgREST Schema-Cache ────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
