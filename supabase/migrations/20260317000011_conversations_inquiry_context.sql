-- =============================================================================
-- Migration: BLOCK 2 – Persist inquiry context fields on conversations
-- =============================================================================
-- PROBLEM:
--   The Conversation domain type carries two fields that were never added to
--   the database schema:
--     • projectDescription  – free-text description entered by the customer
--                             during category/search inquiry flows
--     • inquiryCriteria     – structured search criteria derived from reel
--                             inquiries (category, description, location,
--                             budget, timing)
--
--   Because these fields had no backing DB columns they were silently dropped
--   every time SupabaseMessageRepository serialised a conversation to the
--   database.  After a page reload the columns read back as NULL/absent and:
--     1. convertInquiryToProjectWorkflow could not populate
--        intakeContext.requestDescription from conversation.projectDescription
--     2. Any downstream logic relying on inquiryCriteria (e.g. pre-filling
--        search forms) received undefined instead of the original values.
--
-- FIX:
--   Add both columns as optional (nullable) columns on conversations so they
--   are round-tripped correctly through the Supabase repository on every
--   write and re-hydrated correctly on every initialise() load.
--
-- Both ADD COLUMN statements use IF NOT EXISTS guards so this migration is
-- safe to run against a database that already has one or both columns.
-- =============================================================================

-- Free-text description of the work the customer is requesting.
-- Populated by startCategoryInquiryWorkflow / startProjectInquiryWorkflow.
-- Forwarded to intakeContext.requestDescription during inquiry conversion.
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS project_description text;

-- Structured search criteria derived from a reel inquiry (JSONB object).
-- Shape: { category, description, location, budget?, timing? }
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS inquiry_criteria jsonb;
