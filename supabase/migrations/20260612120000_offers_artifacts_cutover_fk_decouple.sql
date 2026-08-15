-- Block Q — Cutover offer corridor: decouple offers + thread_artifacts from the
-- legacy `conversations` foreign key.
--
-- WHY
-- Cutover inquiry threads live only in `chat_threads` (no `conversations` row).
-- When a craftsman sends a commercial document, the offer + its thread artifact
-- are keyed to the thread id, which on a cutover thread is a `chat_threads.id`.
-- That value does not exist in `conversations`, so both writes violated:
--   offers_conversation_id_fkey            FOREIGN KEY (conversation_id) -> conversations(id)
--   thread_artifacts_conversation_id_fkey  FOREIGN KEY (conversation_id) -> conversations(id)
-- => the entire offer corridor failed on every new (cutover) inquiry thread.
-- The id space is now a union (legacy conversations.id for migrated threads,
-- chat_threads.id for cutover threads), so a single-table FK can no longer model
-- it. The application layer already treats the id as a neutral "thread id".
--
-- SAFETY — verified against prod schema on 2026-06-12:
--   * Account-deletion cleanup of `offers` is UNAFFECTED. offers keeps its direct
--     user FKs offers_{customer,craftsman}_user_id_fkey -> profiles(id) ON DELETE
--     CASCADE, and profiles.id -> auth.users(id) ON DELETE CASCADE. Deleting a
--     user still cascades through profiles to offers without the conversation FK.
--   * Account-deletion cleanup of `thread_artifacts` is UNCHANGED. `conversations`
--     carries NO FK to profiles/auth.users, so the account-deletion path never
--     deletes a conversation row, which means the conversations -> thread_artifacts
--     cascade never fired for account deletion to begin with. Dropping it removes
--     nothing that account deletion relied on. (thread_artifacts has no user FK and
--     thus already lingers post-deletion — a pre-existing retention gap tracked
--     separately; intentionally out of scope for this hotfix.)
--   * RLS is conversation-independent on both tables (insert/select/update key on
--     auth.uid() = customer_user_id OR craftsman_user_id), so cutover writes pass.
--   * Removing these inbound FKs also UNBLOCKS the planned `DROP TABLE conversations`
--     (a table with inbound FKs cannot be dropped without CASCADE).
--
-- Purely constraint removal. No data migration. Idempotent.
--
-- ROLLBACK
-- Re-adding the FKs is only valid while every conversation_id still exists in
-- `conversations`. Once cutover offers/artifacts (conversation_id = chat_threads.id)
-- exist, a plain re-add will fail; use ADD CONSTRAINT ... NOT VALID if a rollback
-- is ever required:
--   ALTER TABLE public.offers           ADD CONSTRAINT offers_conversation_id_fkey
--     FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE NOT VALID;
--   ALTER TABLE public.thread_artifacts ADD CONSTRAINT thread_artifacts_conversation_id_fkey
--     FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE public.offers
  DROP CONSTRAINT IF EXISTS offers_conversation_id_fkey;

ALTER TABLE public.thread_artifacts
  DROP CONSTRAINT IF EXISTS thread_artifacts_conversation_id_fkey;

-- Defensive PostgREST schema-cache reload (constraint topology changed).
NOTIFY pgrst, 'reload schema';
