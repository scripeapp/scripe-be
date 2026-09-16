-- ============================================================================
-- Hilaq Admin RPCs (RLS-Compliant cross-tenant access)
-- ============================================================================

-- Helper function to check if the caller is an active admin (Super User bypass)
CREATE OR REPLACE FUNCTION public.check_is_admin()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM admin_users 
    WHERE user_id = auth.uid() AND is_active = TRUE
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 1. Get Platform Statistics
CREATE OR REPLACE FUNCTION public.get_admin_stats()
RETURNS JSONB AS $$
DECLARE
  result JSONB;
BEGIN
  -- Security Check
  IF NOT public.check_is_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

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

-- 2. List Platform Users
CREATE OR REPLACE FUNCTION public.get_admin_users(
  search_term TEXT DEFAULT '',
  limit_val INTEGER DEFAULT 20,
  offset_val INTEGER DEFAULT 0
)
RETURNS TABLE (
  id UUID,
  name TEXT,
  email TEXT,
  created_at TIMESTAMPTZ,
  total_count BIGINT
) AS $$
BEGIN
  -- Security Check
  IF NOT public.check_is_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN QUERY
  SELECT 
    u.id,
    u.name,
    u.email,
    u.created_at,
    count(*) OVER() as total_count
  FROM public.users u
  WHERE (search_term = '' OR u.name ILIKE '%' || search_term || '%' OR u.email ILIKE '%' || search_term || '%')
  ORDER BY u.created_at DESC
  LIMIT limit_val
  OFFSET offset_val;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. List Platform Businesses
CREATE OR REPLACE FUNCTION public.get_admin_businesses(
  limit_val INTEGER DEFAULT 20,
  offset_val INTEGER DEFAULT 0
)
RETURNS TABLE (
  id UUID,
  name TEXT,
  created_at TIMESTAMPTZ,
  total_count BIGINT
) AS $$
BEGIN
  -- Security Check
  IF NOT public.check_is_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN QUERY
  SELECT 
    b.id,
    b.name,
    b.created_at,
    count(*) OVER() as total_count
  FROM public.businesses b
  ORDER BY b.created_at DESC
  LIMIT limit_val
  OFFSET offset_val;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. List Platform Payouts
CREATE OR REPLACE FUNCTION public.get_admin_payouts(
  status_filter TEXT DEFAULT 'all',
  limit_val INTEGER DEFAULT 20,
  offset_val INTEGER DEFAULT 0
)
RETURNS TABLE (
  id UUID,
  business_id UUID,
  amount DECIMAL,
  currency VARCHAR,
  status VARCHAR,
  created_at TIMESTAMPTZ,
  total_count BIGINT
) AS $$
BEGIN
  IF NOT public.check_is_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN QUERY
  SELECT 
    p.id,
    p.business_id,
    p.amount,
    p.currency,
    p.status,
    p.created_at,
    count(*) OVER() as total_count
  FROM public.payout_requests p
  WHERE (status_filter = 'all' OR p.status = status_filter)
  ORDER BY p.created_at DESC
  LIMIT limit_val
  OFFSET offset_val;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. List Platform Transactions
CREATE OR REPLACE FUNCTION public.get_admin_transactions(
  limit_val INTEGER DEFAULT 20,
  offset_val INTEGER DEFAULT 0
)
RETURNS TABLE (
  id UUID,
  business_id UUID,
  amount DECIMAL,
  currency VARCHAR,
  status VARCHAR,
  created_at TIMESTAMPTZ,
  total_count BIGINT
) AS $$
BEGIN
  IF NOT public.check_is_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN QUERY
  SELECT 
    t.id,
    t.business_id,
    t.amount,
    t.currency,
    t.status,
    t.created_at,
    count(*) OVER() as total_count
  FROM public.transactions t
  ORDER BY t.created_at DESC
  LIMIT limit_val
  OFFSET offset_val;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 6. List Platform Publications
CREATE OR REPLACE FUNCTION public.get_admin_publications(
  limit_val INTEGER DEFAULT 20,
  offset_val INTEGER DEFAULT 0
)
RETURNS TABLE (
  id UUID,
  name TEXT,
  owner_name TEXT,
  owner_email TEXT,
  created_at TIMESTAMPTZ,
  total_count BIGINT
) AS $$
BEGIN
  IF NOT public.check_is_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN QUERY
  SELECT 
    p.id,
    p.name,
    u.name as owner_name,
    u.email as owner_email,
    p.created_at,
    count(*) OVER() as total_count
  FROM public.publications p
  LEFT JOIN public.users u ON u.id = p.user_id
  ORDER BY p.created_at DESC
  LIMIT limit_val
  OFFSET offset_val;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7. Get Moderation Queue
CREATE OR REPLACE FUNCTION public.get_admin_moderation_queue(
  limit_val INTEGER DEFAULT 20,
  offset_val INTEGER DEFAULT 0
)
RETURNS TABLE (
  id UUID,
  target_type VARCHAR,
  target_id UUID,
  reason VARCHAR,
  description TEXT,
  status VARCHAR,
  created_at TIMESTAMPTZ,
  total_count BIGINT
) AS $$
BEGIN
  IF NOT public.check_is_admin() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN QUERY
  SELECT 
    m.id,
    m.target_type,
    m.target_id,
    m.reason,
    m.description,
    m.status,
    m.created_at,
    count(*) OVER() as total_count
  FROM public.moderation_reports m
  WHERE m.status = 'open'
  ORDER BY m.created_at DESC
  LIMIT limit_val
  OFFSET offset_val;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
