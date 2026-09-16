-- Function to increment a member of a JSONB column atomically
-- Usage: SELECT increment_campaign_metric('campaign_id', 'opens');

CREATE OR REPLACE FUNCTION increment_campaign_metric(
  target_campaign_id UUID,
  metric_key TEXT,
  increment_amount INT DEFAULT 1
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE campaigns
  SET metrics = jsonb_set(
    metrics,
    ARRAY[metric_key],
    (COALESCE((metrics->>metric_key)::INT, 0) + increment_amount)::TEXT::JSONB
  )
  WHERE id = target_campaign_id;
END;
$$;
