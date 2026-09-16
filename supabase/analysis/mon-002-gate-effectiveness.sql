-- MON-002 pre-work: which gates actually drive upgrades vs. which just cause friction?
-- Run these in the Supabase SQL editor. Read-only — no writes.
--
-- Key idea: plan_upgrade_signals.resolved_at is stamped when a business UPGRADES
-- (see UpgradeSignalsService.resolveSignals). So:
--   resolved   = hit this limit, then paid   -> a CONVERTING gate (keep / tighten)
--   unresolved = hit this limit, still stuck -> either working demand OR churn-driving friction
--
-- Gate placement for MON-002 should follow this data, not opinion.

-- =====================================================================
-- 1) CONVERSION POWER PER RESOURCE
-- For each limited resource: how often does hitting it precede an upgrade?
-- High conversion_rate = a gate that sells. Low rate + high volume = friction.
-- =====================================================================
SELECT
  resource,
  current_plan,
  COUNT(*)                                             AS times_hit,
  COUNT(*) FILTER (WHERE resolved_at IS NOT NULL)      AS converted,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE resolved_at IS NOT NULL) / COUNT(*),
    1
  )                                                    AS conversion_rate_pct,
  ROUND(AVG(hit_count), 1)                             AS avg_hits_before_outcome
FROM plan_upgrade_signals
GROUP BY resource, current_plan
ORDER BY current_plan, conversion_rate_pct DESC;

-- =====================================================================
-- 2) FRICTION WITHOUT PAYOFF (the churn risk)
-- Resources hit MANY times but rarely converting = users repeatedly slamming
-- into a wall and NOT paying. Candidates to loosen or move up a tier.
-- =====================================================================
SELECT
  resource,
  current_plan,
  COUNT(*)                     AS businesses_stuck,
  SUM(hit_count)               AS total_wall_hits,
  ROUND(AVG(hit_count), 1)     AS avg_hits_per_business,
  MAX(hit_count)               AS worst_case_hits
FROM plan_upgrade_signals
WHERE resolved_at IS NULL
GROUP BY resource, current_plan
HAVING COUNT(*) >= 3            -- ignore noise; tune threshold to your volume
ORDER BY total_wall_hits DESC;

-- =====================================================================
-- 3) TIME-TO-CONVERT PER GATE
-- How long from first hitting a limit to upgrading? Fast = strong buying trigger;
-- slow = weak trigger (the gate isn't the deciding factor).
-- =====================================================================
SELECT
  resource,
  current_plan,
  COUNT(*)                                                         AS conversions,
  ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - first_hit_at)) / 86400.0), 1)
                                                                   AS avg_days_to_upgrade,
  ROUND(AVG(hit_count), 1)                                         AS avg_hits_before_upgrade
FROM plan_upgrade_signals
WHERE resolved_at IS NOT NULL
GROUP BY resource, current_plan
ORDER BY avg_days_to_upgrade ASC;

-- =====================================================================
-- 4) DEAD GATES
-- Limited resources that basically never get hit = doing no pricing work.
-- Either the cap is too generous or nobody wants the feature. Reclaim or re-cap.
-- Compare this list against the caps in plan_limits to spot slack.
-- =====================================================================
SELECT
  resource,
  COUNT(*)        AS total_signals,
  SUM(hit_count)  AS total_hits
FROM plan_upgrade_signals
GROUP BY resource
ORDER BY total_hits ASC;

-- =====================================================================
-- 5) WHICH PLAN GENERATES THE MOST PRESSURE
-- Where do businesses feel the squeeze? Concentrated on starter = Plus is
-- well-positioned. Concentrated on plus = Pro's value gap may be too wide.
-- =====================================================================
SELECT
  current_plan,
  COUNT(*)                                          AS signals,
  COUNT(*) FILTER (WHERE resolved_at IS NOT NULL)   AS converted,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE resolved_at IS NOT NULL) / NULLIF(COUNT(*),0),
    1
  )                                                 AS conversion_rate_pct
FROM plan_upgrade_signals
GROUP BY current_plan
ORDER BY signals DESC;
