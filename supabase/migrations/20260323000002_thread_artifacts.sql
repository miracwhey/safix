-- ============================================================================
-- Migration: thread_artifacts — First-class persisted thread artifact table
-- ============================================================================
--
-- Introduces a canonical persisted record that binds business entities
-- (projects, offers, payment phases) to conversations.
--
-- Before this table, thread artifacts were derived at read time from
-- multiple competing repositories (conversations, projects, offers, jobs,
-- payments).  If any upstream repository had stale or missing data, the
-- corresponding business card would vanish after reload.
--
-- This table makes the conversation → artifact linkage reload-stable:
-- the linkage itself is persisted, not inferred.
--
-- ── Schema ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS thread_artifacts (
  id             TEXT    PRIMARY KEY,
  conversation_id TEXT   NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  artifact_type  TEXT    NOT NULL CHECK (artifact_type IN ('project', 'offer', 'payment_phase')),

  -- Business entity references (exactly one populated per artifact type)
  project_id     TEXT,
  offer_id       TEXT,
  job_id         TEXT,

  -- Lifecycle phase (primarily for offer artifacts)
  phase          TEXT,

  -- Participant scope: duplicate from conversation for fast RLS filtering
  customer_user_id  TEXT,
  craftsman_user_id TEXT,

  -- Timestamps (epoch ms)
  created_at     BIGINT  NOT NULL DEFAULT 0,
  updated_at     BIGINT  NOT NULL DEFAULT 0,

  -- One artifact per type per conversation
  UNIQUE(conversation_id, artifact_type)
);

-- ── Indexes ────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_thread_artifacts_conversation
  ON thread_artifacts(conversation_id);

CREATE INDEX IF NOT EXISTS idx_thread_artifacts_project
  ON thread_artifacts(project_id)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_thread_artifacts_offer
  ON thread_artifacts(offer_id)
  WHERE offer_id IS NOT NULL;

-- ── RLS ────────────────────────────────────────────────────────────────────

ALTER TABLE thread_artifacts ENABLE ROW LEVEL SECURITY;

-- SELECT: user must be either the customer or the craftsman
CREATE POLICY thread_artifacts_select_own ON thread_artifacts
  FOR SELECT USING (
    auth.uid()::text = customer_user_id
    OR auth.uid()::text = craftsman_user_id
  );

-- INSERT: user must be a participant (customer attaching project or craftsman sending offer)
CREATE POLICY thread_artifacts_insert_own ON thread_artifacts
  FOR INSERT WITH CHECK (
    auth.uid()::text = customer_user_id
    OR auth.uid()::text = craftsman_user_id
  );

-- UPDATE: user must be a participant
CREATE POLICY thread_artifacts_update_own ON thread_artifacts
  FOR UPDATE USING (
    auth.uid()::text = customer_user_id
    OR auth.uid()::text = craftsman_user_id
  );

-- ── Backfill ───────────────────────────────────────────────────────────────
-- Populate thread_artifacts from existing conversations that have a
-- source_project_id set (project artifacts).

INSERT INTO thread_artifacts (
  id,
  conversation_id,
  artifact_type,
  project_id,
  customer_user_id,
  craftsman_user_id,
  created_at,
  updated_at
)
SELECT
  'ta_project_' || c.id,
  c.id,
  'project',
  c.source_project_id,
  c.customer_user_id,
  c.craftsman_user_id,
  COALESCE(c.created_at, 0),
  COALESCE(c.created_at, 0)
FROM conversations c
WHERE c.source_project_id IS NOT NULL
  AND c.source_project_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
ON CONFLICT (conversation_id, artifact_type) DO NOTHING;

-- Backfill offer artifacts from existing offers table.

INSERT INTO thread_artifacts (
  id,
  conversation_id,
  artifact_type,
  offer_id,
  job_id,
  phase,
  customer_user_id,
  craftsman_user_id,
  created_at,
  updated_at
)
SELECT
  'ta_offer_' || o.conversation_id,
  o.conversation_id,
  'offer',
  o.id,
  o.created_job_id,
  CASE
    WHEN o.status = 'pending'  THEN 'sent'
    WHEN o.status = 'accepted' THEN 'accepted'
    WHEN o.status = 'declined' THEN 'declined'
    ELSE 'sent'
  END,
  o.customer_user_id,
  o.craftsman_user_id,
  COALESCE(o.created_at, 0),
  COALESCE(o.updated_at, 0)
FROM offers o
WHERE o.conversation_id IS NOT NULL
ON CONFLICT (conversation_id, artifact_type) DO NOTHING;
