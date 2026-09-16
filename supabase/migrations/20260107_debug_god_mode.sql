-- Debug Function: Test RPC Logic
-- 20260107_debug_god_mode.sql

DROP FUNCTION IF EXISTS public.debug_get_all_admins();

CREATE OR REPLACE FUNCTION public.debug_get_all_admins()
RETURNS JSONB AS $$
DECLARE
  result JSONB;
BEGIN
  -- Execute the logic from get_admin_stats directly
  SELECT jsonb_build_object(
    'total_users', (SELECT count(*) FROM public.users),
    'total_stores', (SELECT count(*) FROM public.stores),
    'total_events', (SELECT count(*) FROM public.events),
    'total_publications', (SELECT count(*) FROM public.publications),
    'total_revenue', (SELECT COALESCE(sum(total), 0) FROM public.store_orders)
  ) INTO result;

  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
