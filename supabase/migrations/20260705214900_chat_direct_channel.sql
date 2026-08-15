-- @-Handle-System · Block H3 — direct-Channel (Personen-zu-Personen-Chat)
--
-- Führt `chat_threads.channel_type='direct'` für 1:1-Chats zwischen beliebigen
-- auffindbaren Usern ein (Kunde↔Kunde, Kunde↔Handwerker, Handwerker↔Handwerker).
-- Kein provider, kein Job-Kontext — reine Personen-Konversation.
--
-- RLS-Befund (verifiziert 2026-07-05): die Chat-RLS ist mitgliedschaftsbasiert
-- (chat_threads/participants/messages gaten über „bist du Participant mit
-- left_at IS NULL"). Die einzigen channel-qualifizierten Klauseln sind die
-- customer-worker-Exclusion (für direct vakuum-wahr) und die Thread-INSERT-
-- Policies (per SECDEF-RPC umgangen). → KEINE Policy-Änderung nötig; direct
-- wird automatisch abgedeckt, inkl. is_blocked_by_me()-Silent-Drop.

-- ── 1. Schema ────────────────────────────────────────────────────────────────
-- channel_type um 'direct' erweitern.
ALTER TABLE public.chat_threads DROP CONSTRAINT IF EXISTS chat_threads_channel_type_check;
ALTER TABLE public.chat_threads ADD CONSTRAINT chat_threads_channel_type_check
  CHECK (channel_type = ANY (ARRAY['customer','office','team','assignment','dispute','direct']));

-- provider_required_check: direct braucht keinen provider (wie customer).
ALTER TABLE public.chat_threads DROP CONSTRAINT IF EXISTS chat_threads_provider_required_check;
ALTER TABLE public.chat_threads ADD CONSTRAINT chat_threads_provider_required_check
  CHECK (channel_type IN ('customer','direct') OR provider_id IS NOT NULL);
-- chat_threads_customer_channel_check bleibt customer-only (direct erfüllt es via OR).

-- Symmetrischer Pair-Key least:greatest → genau 1 direct-Thread pro Personenpaar.
ALTER TABLE public.chat_threads ADD COLUMN IF NOT EXISTS direct_pair_key text;
CREATE UNIQUE INDEX IF NOT EXISTS chat_threads_direct_pair_unique
  ON public.chat_threads (direct_pair_key) WHERE channel_type = 'direct';

-- ── 2. Anti-Spam-Quota (neue direct-Threads pro Tag) ─────────────────────────
CREATE TABLE IF NOT EXISTS public.direct_thread_quota (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  day     date NOT NULL,
  count   int  NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
ALTER TABLE public.direct_thread_quota ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.direct_thread_quota FROM anon, authenticated;

-- ── 3. RPC: get-or-create direct-Thread ──────────────────────────────────────
-- SECDEF-Chokepoint. Gates: Auth, kein Self, Target auffindbar+DM-offen+aktiv,
-- kein Block (beidseitig, generischer Fehler), Rolle customer/craftsman,
-- Rate-Limit 20 neue/Tag. Idempotent via direct_pair_key. Vorlage:
-- rpc_get_or_create_chat_customer_thread (20260514000001).
CREATE OR REPLACE FUNCTION public.rpc_get_or_create_chat_direct_thread(p_target_profile_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid          uuid := auth.uid();
  v_pair         text;
  v_thread_id    uuid;
  v_caller_role  text;
  v_caller_h     text;
  v_caller_dn    text;
  v_t_role       text;
  v_t_handle     text;
  v_t_dn         text;
  v_t_disc       boolean;
  v_t_dm         text;
  v_t_mod        text;
  v_count        int;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'access_denied: no auth session' USING ERRCODE = 'P0001';
  END IF;
  IF p_target_profile_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument: target required' USING ERRCODE = 'P0001';
  END IF;
  IF p_target_profile_id = v_uid THEN
    RAISE EXCEPTION 'invalid_argument: cannot DM self' USING ERRCODE = 'P0001';
  END IF;

  -- Target-Sichtbarkeit: auffindbar + DM offen + aktiv. Sonst generisch not_available.
  SELECT role, handle, display_name, discoverable, dm_privacy, moderation_state
    INTO v_t_role, v_t_handle, v_t_dn, v_t_disc, v_t_dm, v_t_mod
    FROM public.profiles WHERE id = p_target_profile_id;
  IF v_t_handle IS NULL
     OR v_t_disc IS NOT TRUE
     OR v_t_dm <> 'everyone'
     OR v_t_mod <> 'active'
     OR v_t_role NOT IN ('customer','craftsman') THEN
    RAISE EXCEPTION 'not_available' USING ERRCODE = 'P0001';
  END IF;

  -- Block beidseitig → Block nicht leaken.
  IF EXISTS (
    SELECT 1 FROM public.user_blocks b
    WHERE (b.blocker_id = v_uid AND b.blocked_id = p_target_profile_id)
       OR (b.blocker_id = p_target_profile_id AND b.blocked_id = v_uid)
  ) THEN
    RAISE EXCEPTION 'not_available' USING ERRCODE = 'P0001';
  END IF;

  -- Caller-Kontext.
  SELECT role, handle, display_name INTO v_caller_role, v_caller_h, v_caller_dn
    FROM public.profiles WHERE id = v_uid;
  IF v_caller_role NOT IN ('customer','craftsman') THEN
    RAISE EXCEPTION 'not_available' USING ERRCODE = 'P0001';
  END IF;

  v_pair := least(v_uid::text, p_target_profile_id::text) || ':' || greatest(v_uid::text, p_target_profile_id::text);

  -- Bestehenden Thread zurückgeben (kein Rate-Limit-Verbrauch).
  SELECT id INTO v_thread_id
  FROM public.chat_threads
  WHERE channel_type = 'direct' AND direct_pair_key = v_pair;
  IF v_thread_id IS NOT NULL THEN
    RETURN v_thread_id;
  END IF;

  -- Rate-Limit: max 20 NEUE direct-Threads/Tag/User.
  INSERT INTO public.direct_thread_quota AS q (user_id, day, count)
  VALUES (v_uid, current_date, 1)
  ON CONFLICT (user_id, day) DO UPDATE SET count = q.count + 1
  RETURNING q.count INTO v_count;
  IF v_count > 20 THEN
    RAISE EXCEPTION 'rate_limited: too many new direct chats today' USING ERRCODE = 'P0001';
  END IF;

  -- Thread anlegen (Race-sicher via Partial-Unique).
  INSERT INTO public.chat_threads (channel_type, direct_pair_key, display_metadata)
  VALUES (
    'direct',
    v_pair,
    jsonb_build_object('peers', jsonb_build_object(
      v_uid::text,               jsonb_build_object('handle', v_caller_h, 'displayName', v_caller_dn),
      p_target_profile_id::text, jsonb_build_object('handle', v_t_handle, 'displayName', v_t_dn)
    ))
  )
  ON CONFLICT (direct_pair_key) WHERE channel_type = 'direct' DO NOTHING
  RETURNING id INTO v_thread_id;

  IF v_thread_id IS NULL THEN
    -- Konkurrierender Insert gewann das Rennen.
    SELECT id INTO v_thread_id
    FROM public.chat_threads
    WHERE channel_type = 'direct' AND direct_pair_key = v_pair;
    RETURN v_thread_id;
  END IF;

  -- Beide Parteien als Teilnehmer (Rolle aus profiles.role).
  INSERT INTO public.chat_participants (thread_id, user_id, role, joined_at)
  VALUES
    (v_thread_id, v_uid,               v_caller_role, public.epoch_ms()),
    (v_thread_id, p_target_profile_id, v_t_role,      public.epoch_ms())
  ON CONFLICT (thread_id, user_id) DO NOTHING;

  RETURN v_thread_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.rpc_get_or_create_chat_direct_thread(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_or_create_chat_direct_thread(uuid) TO authenticated;

-- ── 4. PostgREST Schema-Cache ────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
