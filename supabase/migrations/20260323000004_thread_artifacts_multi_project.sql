-- ============================================================================
-- Migration: thread_artifacts — Multi-send project cards
-- ============================================================================
--
-- Changes the thread_artifacts model from single-slot-per-conversation to
-- append-only for project artifacts.  A conversation may now have multiple
-- project-send artifacts, each with its own identity and timestamp.
--
-- Offer and payment_phase artifacts remain single per conversation
-- (enforced via partial unique indexes).
--
-- ── Schema changes ────────────────────────────────────────────────────────

-- Drop the blanket UNIQUE constraint that prevented multiple project
-- artifacts per conversation.
ALTER TABLE thread_artifacts
  DROP CONSTRAINT IF EXISTS thread_artifacts_conversation_id_artifact_type_key;

-- Reinstate uniqueness for offer and payment_phase artifacts only.
-- Project artifacts are now append-only (no uniqueness constraint).
CREATE UNIQUE INDEX IF NOT EXISTS thread_artifacts_offer_unique
  ON thread_artifacts(conversation_id, artifact_type)
  WHERE artifact_type = 'offer';

CREATE UNIQUE INDEX IF NOT EXISTS thread_artifacts_payment_phase_unique
  ON thread_artifacts(conversation_id, artifact_type)
  WHERE artifact_type = 'payment_phase';
