-- =============================================================================
-- Migration: BLOCK 3 – Add source_conversation_id to jobs
-- =============================================================================
-- PROBLEM:
--   Jobs created via convertInquiryToProjectWorkflow have a projectId that
--   matches the originating conversation's projectId (used for in-memory reverse
--   lookup via getConversationByProjectId).  However, there is no explicit
--   database column linking a job directly back to its source conversation ID.
--
--   Without this column:
--     • Notification / email systems cannot reliably query "which thread does
--       this job correspond to" without loading all conversations and joining
--       on projectId in application code.
--     • Server-side functions cannot resolve conversation context from a job ID.
--
-- FIX:
--   Add an optional source_conversation_id TEXT column to the jobs table.
--   The column is populated by convertInquiryToProjectWorkflow for all
--   inquiry-origin jobs.  Direct / legacy jobs leave it NULL.
--
-- The IF NOT EXISTS guard makes this migration safe to re-run.
-- =============================================================================

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS source_conversation_id text;

CREATE INDEX IF NOT EXISTS idx_jobs_source_conversation_id
  ON public.jobs (source_conversation_id)
  WHERE source_conversation_id IS NOT NULL;
