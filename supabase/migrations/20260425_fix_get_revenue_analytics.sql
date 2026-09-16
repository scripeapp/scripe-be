-- Fix get_revenue_analytics: session_id column was renamed to circle_id when
-- sessions were renamed to circles, but this function was never updated.
-- Must DROP first because PostgreSQL won't let you rename a parameter in place.

DROP FUNCTION IF EXISTS get_revenue_analytics(UUID);

CREATE FUNCTION get_revenue_analytics(p_circle_id UUID)
RETURNS TABLE (
  date TEXT,
  revenue NUMERIC,
  cumulative NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    TO_CHAR(created_at, 'YYYY-MM') AS date,
    SUM(amount) AS revenue,
    SUM(SUM(amount)) OVER (ORDER BY TO_CHAR(created_at, 'YYYY-MM')) AS cumulative
  FROM session_payments
  WHERE circle_id = p_circle_id
    AND status = 'success'
  GROUP BY TO_CHAR(created_at, 'YYYY-MM')
  ORDER BY date ASC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION get_revenue_analytics(UUID) TO authenticated;
