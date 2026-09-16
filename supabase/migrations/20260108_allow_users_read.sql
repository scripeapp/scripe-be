-- Allow authenticated users to read basic profile info from users table
-- This is required for Session Members list to show user details

BEGIN;

-- Enable RLS on users if not already enabled (it should be)
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- Drop existing policy if it conflicts or is too restrictive
DROP POLICY IF EXISTS "Authenticated users can read all profiles" ON public.users;
DROP POLICY IF EXISTS "Public profiles are viewable by everyone" ON public.users;

-- Create policy allowing authenticated users to read id, name, email, avatar_url
-- Note: 'email' availability details depends on your privacy model, 
-- but usually needed for identifying members in lists.
CREATE POLICY "Authenticated users can read all profiles" ON public.users
  FOR SELECT
  TO authenticated
  USING (true);

COMMIT;
