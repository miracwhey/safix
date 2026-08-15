-- =============================================================================
-- Block D Slice 6 — Dispute-Chat-Integration
-- =============================================================================
-- New column:  chat_threads.dispute_id (uuid FK → disputes.id)
-- New index:   partial-unique (dispute_id) WHERE channel_type = 'dispute'
-- New RPC:     rpc_get_or_create_chat_dispute_thread(p_dispute_id uuid)
-- New storage: chat-dispute bucket RLS (activates Slice-6 reservation)
--
-- Access model: customer_profile_id | team_member of provider_id | operator
-- Participants seeded: customer (customer) + provider owners (craftsman) + operators (admin)
-- Thread is idempotent: 1 dispute thread per dispute, lazy-created on first call.
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 1 — chat_threads.dispute_id column + partial-unique index
-- =============================================================================

ALTER TABLE public.chat_threads
  ADD COLUMN IF NOT EXISTS dispute_id uuid REFERENCES public.disputes(id);

CREATE UNIQUE INDEX IF NOT EXISTS chat_threads_dispute_id_unique
  ON public.chat_threads (dispute_id)
  WHERE channel_type = 'dispute' AND dispute_id IS NOT NULL;

-- =============================================================================
-- SECTION 2 — RPC: rpc_get_or_create_chat_dispute_thread(p_dispute_id uuid)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_get_or_create_chat_dispute_thread(
  p_dispute_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_uid                 uuid;
  v_customer_profile_id uuid;
  v_provider_id         uuid;
  v_thread_id           uuid;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'access_denied: no auth session' USING ERRCODE = 'P0001';
  END IF;

  -- Load dispute parties
  SELECT customer_profile_id, provider_id
  INTO   v_customer_profile_id, v_provider_id
  FROM   public.disputes
  WHERE  id = p_dispute_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_argument: dispute % not found', p_dispute_id
      USING ERRCODE = 'P0001';
  END IF;

  -- Access check: customer OR team member of provider OR operator
  IF v_uid <> v_customer_profile_id
    AND NOT EXISTS (
      SELECT 1
      FROM   public.team_members tm
      WHERE  tm.provider_id = v_provider_id
        AND  tm.profile_id  = v_uid
        AND  tm.is_active   = true
    )
    AND NOT EXISTS (
      SELECT 1
      FROM   public.profiles p
      WHERE  p.id          = v_uid
        AND  p.is_operator = true
    )
  THEN
    RAISE EXCEPTION 'access_denied: caller is not a party to this dispute'
      USING ERRCODE = 'P0001';
  END IF;

  -- Idempotent lookup
  SELECT id INTO v_thread_id
  FROM   public.chat_threads
  WHERE  dispute_id   = p_dispute_id
    AND  channel_type = 'dispute';

  IF v_thread_id IS NOT NULL THEN
    -- Ensure caller is still a participant (handles late-added operators etc.)
    INSERT INTO public.chat_participants (thread_id, user_id, role, joined_at)
    VALUES (v_thread_id, v_uid, 'customer', public.epoch_ms())
    ON CONFLICT (thread_id, user_id) DO NOTHING;
    RETURN v_thread_id;
  END IF;

  -- Create thread (conflict-safe for concurrent callers)
  INSERT INTO public.chat_threads (
    channel_type, dispute_id, title, created_at, updated_at
  )
  VALUES (
    'dispute',
    p_dispute_id,
    'Streitfall-Chat',
    public.epoch_ms(),
    public.epoch_ms()
  )
  ON CONFLICT (dispute_id) WHERE channel_type = 'dispute' AND dispute_id IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_thread_id;

  -- Race: concurrent insert won — fetch the winner
  IF v_thread_id IS NULL THEN
    SELECT id INTO v_thread_id
    FROM   public.chat_threads
    WHERE  dispute_id   = p_dispute_id
      AND  channel_type = 'dispute';
  END IF;

  -- Seed customer
  INSERT INTO public.chat_participants (thread_id, user_id, role, joined_at)
  VALUES (v_thread_id, v_customer_profile_id, 'customer', public.epoch_ms())
  ON CONFLICT (thread_id, user_id) DO NOTHING;

  -- Seed provider owners (craftsman role)
  INSERT INTO public.chat_participants (thread_id, user_id, role, joined_at)
  SELECT v_thread_id, tm.profile_id, 'craftsman', public.epoch_ms()
  FROM   public.team_members tm
  WHERE  tm.provider_id = v_provider_id
    AND  tm.role        = 'owner'
    AND  tm.profile_id  IS NOT NULL
    AND  tm.is_active   = true
  ON CONFLICT (thread_id, user_id) DO NOTHING;

  -- Seed operators (admin role)
  INSERT INTO public.chat_participants (thread_id, user_id, role, joined_at)
  SELECT v_thread_id, p.id, 'admin', public.epoch_ms()
  FROM   public.profiles p
  WHERE  p.is_operator = true
  ON CONFLICT (thread_id, user_id) DO NOTHING;

  RETURN v_thread_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.rpc_get_or_create_chat_dispute_thread(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.rpc_get_or_create_chat_dispute_thread(uuid) TO authenticated;

-- =============================================================================
-- SECTION 3 — chat-dispute storage bucket RLS (activates Slice-6 reservation)
-- =============================================================================
-- Path schema (mirrors chat-customer/-internal):
--   {providerId-or-no-provider}/{threadId}/{pending-or-messageId}/{filename}
-- Membership check via chat_participants — role unrestricted (customer/craftsman/admin).

DROP POLICY IF EXISTS chat_dispute_insert ON storage.objects;
CREATE POLICY chat_dispute_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'chat-dispute'
    AND EXISTS (
      SELECT 1
      FROM   public.chat_participants cp
      JOIN   public.chat_threads      ct ON ct.id = cp.thread_id
      WHERE  cp.thread_id::text = (storage.foldername(name))[2]
        AND  cp.user_id         = (SELECT auth.uid())
        AND  cp.left_at         IS NULL
        AND  ct.channel_type    = 'dispute'
    )
  );

DROP POLICY IF EXISTS chat_dispute_select ON storage.objects;
CREATE POLICY chat_dispute_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'chat-dispute'
    AND EXISTS (
      SELECT 1
      FROM   public.chat_participants cp
      JOIN   public.chat_threads      ct ON ct.id = cp.thread_id
      WHERE  cp.thread_id::text = (storage.foldername(name))[2]
        AND  cp.user_id         = (SELECT auth.uid())
        AND  cp.left_at         IS NULL
        AND  ct.channel_type    = 'dispute'
    )
  );

COMMIT;

-- =============================================================================
-- SECTION R — Reversal Plan (NOT executed automatically)
-- =============================================================================
-- BEGIN;
-- DROP POLICY IF EXISTS chat_dispute_insert ON storage.objects;
-- DROP POLICY IF EXISTS chat_dispute_select ON storage.objects;
-- DROP FUNCTION IF EXISTS public.rpc_get_or_create_chat_dispute_thread(uuid);
-- DROP INDEX IF EXISTS public.chat_threads_dispute_id_unique;
-- ALTER TABLE public.chat_threads DROP COLUMN IF EXISTS dispute_id;
-- COMMIT;
