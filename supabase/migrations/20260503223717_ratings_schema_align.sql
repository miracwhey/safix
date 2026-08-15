-- Block 3 Follow-up — public.ratings Schema-Drift schließen.
--
-- Findings (siehe PR #830 R2): die ratings-Tabelle wurde lange vor
-- Migration 20260316000004_ratings.sql mit einem Legacy-Schema angelegt
-- (`craftsman_user_id`, `rating numeric DEFAULT 0`, `comment`,
-- `created_at bigint DEFAULT 0`). Repo-Code (SupabaseRatingRepository,
-- Block-2 ratingDistributionService) arbeitet aber gegen das in der
-- Repo-Migration definierte Ziel-Schema (`provider_user_id`,
-- `rating_score smallint CHECK 1..5`, `rating_comment`,
-- `created_at timestamptz`). Reads degradieren still auf 0 Buckets,
-- jeder Insert würde mit 42703 (column does not exist) failen.
--
-- Diese Migration zieht das prod-Schema auf das Repo-Ziel — gefahrlos
-- möglich, weil prod 0 Rows enthält. Vorgehen:
--   1) RLS-Policies droppen (referenzieren alte Spaltennamen)
--   2) Defaults droppen (`rating DEFAULT 0` + `created_at DEFAULT 0`
--      verhindern den Type-Cast nach smallint/timestamptz)
--   3) Spalten umbenennen + Typen angleichen
--   4) Constraints + Indexe neu setzen
--   5) RLS-Policies aus 20260316000004_ratings.sql wiederherstellen
--      (FOR INSERT customer = auth.uid; FOR SELECT auth.uid IS NOT NULL).
--
-- Aufgepasst: ein älterer „ratings_select_own"/"ratings_update_customer"
-- Policy-Set wird hier ENTFERNT. Zustand danach matched die Repo-Migration
-- exakt — Customer können Ratings anderer Provider lesen (Block-2-Anforderung).
-- Ein UPDATE-Pfad existiert in der Repo-Domain nicht.

BEGIN;

-- 1) Alte Policies droppen
DROP POLICY IF EXISTS ratings_insert_customer  ON public.ratings;
DROP POLICY IF EXISTS ratings_select_own       ON public.ratings;
DROP POLICY IF EXISTS ratings_update_customer  ON public.ratings;

-- 2) Legacy-Defaults droppen, damit der ALTER TYPE nicht am Cast hängt
ALTER TABLE public.ratings ALTER COLUMN rating     DROP DEFAULT;
ALTER TABLE public.ratings ALTER COLUMN created_at DROP DEFAULT;

-- 3) Spalten umbenennen + Typen angleichen
ALTER TABLE public.ratings
  RENAME COLUMN craftsman_user_id TO provider_user_id;

ALTER TABLE public.ratings
  RENAME COLUMN comment TO rating_comment;

ALTER TABLE public.ratings
  RENAME COLUMN rating TO rating_score;

-- numeric → smallint (0 Rows → kein Cast-Risiko)
ALTER TABLE public.ratings
  ALTER COLUMN rating_score TYPE smallint USING rating_score::smallint;

-- bigint (epoch ms) → timestamptz (0 Rows → Cast-Pfad ungenutzt,
-- Formel bleibt korrekt für jede Reihe, die später per Backfill auftauchen
-- könnte: ms / 1000 → seconds → timestamp).
ALTER TABLE public.ratings
  ALTER COLUMN created_at TYPE timestamptz
  USING to_timestamp(created_at::double precision / 1000);

ALTER TABLE public.ratings
  ALTER COLUMN created_at SET DEFAULT now();

-- 4) Constraints + Indizes (matched 20260316000004_ratings.sql)
ALTER TABLE public.ratings
  DROP CONSTRAINT IF EXISTS ratings_rating_score_check;
ALTER TABLE public.ratings
  ADD CONSTRAINT ratings_rating_score_check
  CHECK (rating_score BETWEEN 1 AND 5);

-- job_id Unique-Constraint: in der Repo-Migration als UNIQUE deklariert,
-- prod hat aktuell nur den FK ohne UNIQUE.
ALTER TABLE public.ratings
  DROP CONSTRAINT IF EXISTS ratings_job_id_key;
ALTER TABLE public.ratings
  ADD CONSTRAINT ratings_job_id_key UNIQUE (job_id);

-- Sekundärindex auf provider_user_id (Histogramm + Reviews-Lookup)
CREATE INDEX IF NOT EXISTS ratings_provider_user_id_idx
  ON public.ratings(provider_user_id);

-- 5) RLS-Policies aus der Repo-Migration wiederherstellen
DROP POLICY IF EXISTS customers_can_insert_own_ratings ON public.ratings;
CREATE POLICY customers_can_insert_own_ratings
  ON public.ratings FOR INSERT
  WITH CHECK (customer_user_id = auth.uid());

DROP POLICY IF EXISTS authenticated_can_read_ratings ON public.ratings;
CREATE POLICY authenticated_can_read_ratings
  ON public.ratings FOR SELECT
  USING (auth.uid() IS NOT NULL);

COMMIT;
