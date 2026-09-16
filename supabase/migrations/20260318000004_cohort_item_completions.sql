-- Per-item completion tracking for cohort weeks
CREATE TABLE IF NOT EXISTS circle_cohort_item_completions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id    UUID NOT NULL REFERENCES circle_cohorts(id) ON DELETE CASCADE,
  week_id      UUID NOT NULL REFERENCES circle_cohort_weeks(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL,
  item_id      TEXT NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (week_id, user_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_cohort_item_completions_cohort_user ON circle_cohort_item_completions(cohort_id, user_id);
