-- =============================================================================
-- Migration: Conversations – customer_user_id ownership column & RLS hardening
-- =============================================================================
-- BLOCK 16 FOLLOW-UP: Closes the remaining customer-ownership gap in the
-- messaging/conversation domain.
--
-- BEFORE: conversations had no customer_user_id column.  Jobs created from
--   non-builder-project inquiry conversations (reel, profile, category) were
--   left without a customer_user_id because the job creation workflow could
--   not find a source project from which to propagate the customer owner UID.
--
-- AFTER:
--   • conversations.customer_user_id is stamped at conversation-creation time
--     by the inquiry workflow helpers (startReelInquiryWorkflow, etc.) using
--     the calling user's session UID.
--   • convertInquiryToProjectWorkflow falls back to conversation.customerUserId
--     when no source project is available, covering reel/profile/category paths.
--   • Conversations and messages RLS policies accept BOTH craftsman_user_id AND
--     customer_user_id so the customer side can read/write their own threads.
--
-- Ownership model after this migration:
--   conversations  → customer_user_id = auth.uid()   (customer creates, reads, updates)
--                    OR craftsman_user_id = auth.uid() (craftsman reads, updates)
--   messages       → conversation_id IN (conversations owned by either party)
--
-- All DO blocks use IF NOT EXISTS / DROP IF EXISTS guards for idempotency.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Add customer_user_id column to conversations
-- ---------------------------------------------------------------------------

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS customer_user_id text;

CREATE INDEX IF NOT EXISTS idx_conversations_customer_user_id
  ON public.conversations (customer_user_id)
  WHERE customer_user_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Update conversations RLS policies
--    DROP existing policies, then recreate with the expanded predicates.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS conversations_select_own ON public.conversations;
DROP POLICY IF EXISTS conversations_insert_own ON public.conversations;
DROP POLICY IF EXISTS conversations_update_own ON public.conversations;

DO $$
BEGIN
  -- SELECT: the customer who started the conversation OR the craftsman it was
  --   sent to can both read the thread.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='conversations' AND policyname='conversations_select_own') THEN
    CREATE POLICY conversations_select_own ON public.conversations
      FOR SELECT USING (
        craftsman_user_id = auth.uid()::text
        OR customer_user_id  = auth.uid()::text
      );
  END IF;

  -- INSERT: conversations are initiated by the customer, so the inserting user
  --   must supply their own auth UID as the customer_user_id.
  --   craftsman_user_id is set to the target provider's UID (not the caller's)
  --   so we cannot check it for insertion.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='conversations' AND policyname='conversations_insert_own') THEN
    CREATE POLICY conversations_insert_own ON public.conversations
      FOR INSERT WITH CHECK (customer_user_id = auth.uid()::text);
  END IF;

  -- UPDATE: both parties may update (craftsman marks as reviewed/declined;
  --   customer updates status labels or clears unread counts).
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='conversations' AND policyname='conversations_update_own') THEN
    CREATE POLICY conversations_update_own ON public.conversations
      FOR UPDATE USING (
        craftsman_user_id = auth.uid()::text
        OR customer_user_id  = auth.uid()::text
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Update messages RLS policies to extend ownership chain to customer side
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS messages_select_own ON public.messages;
DROP POLICY IF EXISTS messages_insert_own ON public.messages;

DO $$
BEGIN
  -- SELECT: either party to the conversation may read messages in the thread.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='messages' AND policyname='messages_select_own') THEN
    CREATE POLICY messages_select_own ON public.messages
      FOR SELECT USING (
        conversation_id IN (
          SELECT id FROM public.conversations
          WHERE craftsman_user_id = auth.uid()::text
             OR customer_user_id  = auth.uid()::text
        )
      );
  END IF;

  -- INSERT: either party may send messages in a conversation they own.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='messages' AND policyname='messages_insert_own') THEN
    CREATE POLICY messages_insert_own ON public.messages
      FOR INSERT WITH CHECK (
        conversation_id IN (
          SELECT id FROM public.conversations
          WHERE craftsman_user_id = auth.uid()::text
             OR customer_user_id  = auth.uid()::text
        )
      );
  END IF;
END $$;

-- =============================================================================
-- BLOCK 16 FOLLOW-UP COMPLETION SUMMARY
-- =============================================================================
-- conversations.customer_user_id is now the canonical direct customer owner
-- link on the conversation record.
--
-- PROPAGATION PATH:
--   • All inquiry workflows (startReelInquiryWorkflow, startProfileInquiryWorkflow,
--     startCategoryInquiryWorkflowFromProvider, startProjectInquiryWorkflow,
--     startProjectInquiryWorkflowFromProvider) stamp customer_user_id from
--     getSession().user?.id at conversation-creation time.
--   • convertInquiryToProjectWorkflow propagates the customer owner UID to
--     the resulting job using a priority chain:
--       1. sourceProject.customerUserId  (builder-origin – already working)
--       2. conversation.customerUserId   (reel / profile / category – now fixed)
--
-- NO REMAINING GAPS for customer ownership propagation in job creation paths.
-- =============================================================================
