-- Debug Function: Inspect Availability Profiles
-- 20260107_debug_availability.sql

DROP FUNCTION IF EXISTS public.debug_get_all_admins();

-- Reusing the same function name for convenience, or create a new one. 
-- Let's stick to a new dedicated one to avoid confusion.
CREATE OR REPLACE FUNCTION public.debug_get_availability_profiles()
RETURNS SETOF availability_profiles AS $$
BEGIN
  RETURN QUERY SELECT * FROM availability_profiles;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
