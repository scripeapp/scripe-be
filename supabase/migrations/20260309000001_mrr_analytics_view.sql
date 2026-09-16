-- Migration: 20260309000001_mrr_analytics_view.sql
-- Description: Creates MRR summary view for fast admin dashboard queries

CREATE OR REPLACE VIEW mrr_summary AS
SELECT
  COUNT(*) FILTER (WHERE subscription_plan = 'starter' AND subscription_status IN ('active', 'trialing')) AS starter_count,
  COUNT(*) FILTER (WHERE subscription_plan = 'plus'    AND subscription_status IN ('active', 'trialing')) AS plus_count,
  COUNT(*) FILTER (WHERE subscription_plan = 'pro'     AND subscription_status IN ('active', 'trialing')) AS pro_count,
  COUNT(*) FILTER (WHERE subscription_plan != 'starter' AND subscription_status IN ('active', 'trialing')) AS paid_count,
  COUNT(*) FILTER (WHERE subscription_status IN ('cancelled', 'expired') AND updated_at >= NOW() - INTERVAL '30 days') AS churned_last_30d,
  (
    COUNT(*) FILTER (WHERE subscription_plan = 'plus' AND subscription_status IN ('active', 'trialing')) * 4000 +
    COUNT(*) FILTER (WHERE subscription_plan = 'pro'  AND subscription_status IN ('active', 'trialing')) * 7500
  ) AS mrr,
  (
    COUNT(*) FILTER (WHERE subscription_plan = 'plus' AND subscription_status IN ('active', 'trialing')) * 4000 +
    COUNT(*) FILTER (WHERE subscription_plan = 'pro'  AND subscription_status IN ('active', 'trialing')) * 7500
  ) * 12 AS arr
FROM businesses;

GRANT SELECT ON mrr_summary TO authenticated;
GRANT SELECT ON mrr_summary TO service_role;
