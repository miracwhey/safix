-- 20260506000010_provider_median_response_rpc.sql
--
-- SECURITY DEFINER RPC: get_provider_median_response_ms
--
-- Computes the median first-response latency (in milliseconds) for a
-- given provider over a rolling window, using the `conversations` +
-- `messages` tables.
--
-- Algorithm per thread:
--   1. Find the first message where sender_user_id = craftsman_user_id
--      for each conversation (that is the provider's first reply).
--   2. Latency = first_reply.created_at - conversation.created_at  (both bigint epoch-ms).
--   3. Median (percentile_cont 0.5) across all matched threads.
--
-- Exclusions:
--   - Threads where conversations.created_at = 0 (pre-migration rows with
--     default 0 — no reliable start timestamp).
--   - Threads where the provider never replied (LATERAL join returns NULL,
--     excluded by ON condition).
--   - Threads older than p_window_days (default 90 days).
--
-- Returns NULL when there is insufficient data (fewer than 1 matched thread).
--
-- SECURITY DEFINER: the calling user (customer browsing Explore) has no
-- RLS access to other users' conversations. This function runs as owner
-- and is scoped to the single provider_id — no data leakage.

CREATE OR REPLACE FUNCTION public.get_provider_median_response_ms(
  p_craftsman_user_id text,
  p_window_days       int  DEFAULT 90
)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT
    (
      percentile_cont(0.5) WITHIN GROUP (
        ORDER BY (first_reply.first_message_at - c.created_at)
      )
    )::bigint
  FROM conversations c
  JOIN LATERAL (
    SELECT MIN(m.created_at) AS first_message_at
    FROM messages m
    WHERE m.conversation_id = c.id
      AND m.sender_user_id   = p_craftsman_user_id::uuid
  ) first_reply
    ON first_reply.first_message_at IS NOT NULL
  WHERE c.craftsman_user_id = p_craftsman_user_id::uuid
    AND c.created_at > 0
    AND c.created_at > (
      EXTRACT(epoch FROM now())::bigint - p_window_days::bigint * 86400
    ) * 1000
$$;

-- Allow authenticated users (and anon, for public profiles) to call this.
GRANT EXECUTE ON FUNCTION public.get_provider_median_response_ms(text, int)
  TO anon, authenticated;
