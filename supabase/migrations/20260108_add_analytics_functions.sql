-- Add Analytics RPC Functions for Session Feature
-- PostgreSQL functions for complex analytics queries

BEGIN;

-- =============================================================================
-- MEMBER GROWTH ANALYTICS
-- =============================================================================

CREATE OR REPLACE FUNCTION get_member_growth(p_session_id UUID)
RETURNS TABLE (
  date TEXT,
  new_members BIGINT,
  members BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    TO_CHAR(joined_at, 'YYYY-MM') as date,
    COUNT(*) as new_members,
    SUM(COUNT(*)) OVER (ORDER BY TO_CHAR(joined_at, 'YYYY-MM')) as members
  FROM session_members
  WHERE session_id = p_session_id
  GROUP BY TO_CHAR(joined_at, 'YYYY-MM')
  ORDER BY date ASC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- REVENUE ANALYTICS
-- =============================================================================

CREATE OR REPLACE FUNCTION get_revenue_analytics(p_session_id UUID)
RETURNS TABLE (
  date TEXT,
  revenue NUMERIC,
  cumulative NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    TO_CHAR(created_at, 'YYYY-MM') as date,
    SUM(amount) as revenue,
    SUM(SUM(amount)) OVER (ORDER BY TO_CHAR(created_at, 'YYYY-MM')) as cumulative
  FROM session_payments
  WHERE session_id = p_session_id
    AND status = 'success'
  GROUP BY TO_CHAR(created_at, 'YYYY-MM')
  ORDER BY date ASC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- AVERAGE ATTENDANCE RATE
-- =============================================================================

CREATE OR REPLACE FUNCTION get_avg_attendance(p_session_id UUID)
RETURNS TABLE (avg_rate NUMERIC) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    COALESCE(
      AVG(
        (SELECT COUNT(*) FROM occurrence_attendance 
         WHERE occurrence_id = o.id AND attended = true)::float / 
        NULLIF(o.capacity, 0) * 100
      ), 
      0
    ) as avg_rate
  FROM session_occurrences o
  WHERE o.session_id = p_session_id
    AND o.start_datetime < NOW()
    AND o.deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- RETENTION RATE
-- =============================================================================

CREATE OR REPLACE FUNCTION get_retention_rate(p_session_id UUID)
RETURNS TABLE (retention_rate NUMERIC) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    COALESCE(
      (COUNT(CASE WHEN joined_at < NOW() - INTERVAL '30 days' THEN 1 END)::float /
       NULLIF(COUNT(*), 0)) * 100,
      0
    ) as retention_rate
  FROM session_members
  WHERE session_id = p_session_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- GRANT PERMISSIONS
-- =============================================================================

GRANT EXECUTE ON FUNCTION get_member_growth TO authenticated;
GRANT EXECUTE ON FUNCTION get_revenue_analytics TO authenticated;
GRANT EXECUTE ON FUNCTION get_avg_attendance TO authenticated;
GRANT EXECUTE ON FUNCTION get_retention_rate TO authenticated;

-- Comments for documentation
COMMENT ON FUNCTION get_member_growth IS 'Returns member growth analytics aggregated by month';
COMMENT ON FUNCTION get_revenue_analytics IS 'Returns revenue trends over time with cumulative totals';
COMMENT ON FUNCTION get_avg_attendance IS 'Calculates average attendance rate across all past occurrences';
COMMENT ON FUNCTION get_retention_rate IS 'Calculates percentage of members who joined 30+ days ago and are still active';

COMMIT;
