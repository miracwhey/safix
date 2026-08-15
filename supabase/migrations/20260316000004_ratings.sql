-- ratings table: one rating per job, customer rates provider
CREATE TABLE IF NOT EXISTS public.ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id text NOT NULL UNIQUE,
  provider_user_id uuid NOT NULL REFERENCES auth.users(id),
  customer_user_id uuid NOT NULL REFERENCES auth.users(id),
  rating_score smallint NOT NULL CHECK (rating_score BETWEEN 1 AND 5),
  rating_comment text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ratings_provider_user_id_idx ON public.ratings(provider_user_id);
CREATE INDEX IF NOT EXISTS ratings_job_id_idx ON public.ratings(job_id);

ALTER TABLE public.ratings ENABLE ROW LEVEL SECURITY;

-- Customers can insert their own ratings
CREATE POLICY "customers_can_insert_own_ratings"
  ON public.ratings FOR INSERT
  WITH CHECK (customer_user_id = auth.uid());

-- Anyone authenticated can read ratings
CREATE POLICY "authenticated_can_read_ratings"
  ON public.ratings FOR SELECT
  USING (auth.uid() IS NOT NULL);
