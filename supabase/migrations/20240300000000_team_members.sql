-- =============================================================================
-- Migration: Team Members
-- =============================================================================
-- Creates the `team_members` table used by SupabaseTeamMemberRepository.
-- Seeds the four default members so that existing job `assigned_member_ids`
-- values (tm-1 … tm-4) continue to resolve correctly after switching from
-- the in-memory mock to real database-backed reads.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.team_members (
  -- Application-generated primary key (e.g. "tm-1", or a UUID for new members)
  id          text        PRIMARY KEY,

  -- Display name shown throughout the UI
  name        text        NOT NULL DEFAULT '',

  -- Role / trade label shown in team cards and assignment views
  role        text        NOT NULL DEFAULT '',

  -- Supabase auth.users UUID of the linked user account.
  -- Present when the team member has a real login; NULL for unlinked members.
  profile_id  text,

  -- Optional FK to the providers table (owner of this business).
  provider_id text,

  -- Creation timestamp in milliseconds (consistent with all other tables)
  created_at  bigint      NOT NULL
                          DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::bigint
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_team_members_profile_id
  ON public.team_members (profile_id);

CREATE INDEX IF NOT EXISTS idx_team_members_provider_id
  ON public.team_members (provider_id);

-- ---------------------------------------------------------------------------
-- Seed default members
-- Matches the IDs used in mockData.ts so pre-existing job assignments
-- (assigned_member_ids: ["tm-1", ...]) continue to resolve after the switch
-- from mock to Supabase persistence.
-- ---------------------------------------------------------------------------

INSERT INTO public.team_members (id, name, role) VALUES
  ('tm-1', 'Leon Becker',  'Elektriker'),
  ('tm-2', 'Murat Yilmaz', 'Monteur'),
  ('tm-3', 'Sven Krause',  'Installateur'),
  ('tm-4', 'Ali Demir',    'Azubi')
ON CONFLICT (id) DO NOTHING;
