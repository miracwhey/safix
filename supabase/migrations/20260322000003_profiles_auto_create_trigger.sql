-- Auto-create a profiles row whenever a new auth.users row is inserted.
-- This is a safety-net so that every authenticated user is guaranteed to
-- have a profile row even before the application-level ensureProfileExists()
-- call runs.  The function is idempotent — the ON CONFLICT clause ensures
-- existing rows are never overwritten.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id)
  VALUES (NEW.id)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- Drop the trigger first (idempotent re-run).
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();
