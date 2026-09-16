-- campaign_send_jobs
-- Persistent job record for every campaign send.
-- Solves three problems in the original fire-and-forget IIFE:
--   1. Memory: cursor_id lets the worker stream contacts page-by-page and resume
--              from the exact position it stopped, avoiding full in-memory materialisation.
--   2. Serverless lifetime: if the function is killed mid-send the job stays in
--              'processing' state and can be retried from cursor_id without re-sending
--              contacts that were already delivered.
--   3. Observability: sent_count / failed_count are written after every batch so
--              the campaign dashboard can show live progress.

CREATE TABLE IF NOT EXISTS campaign_send_jobs (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    uuid        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  business_id    text        NOT NULL,
  -- pending → processing → completed | failed
  status         text        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','processing','completed','failed')),
  -- last contact id successfully processed; NULL = not started
  cursor_id      text,
  sent_count     int         NOT NULL DEFAULT 0,
  failed_count   int         NOT NULL DEFAULT 0,
  error_message  text,
  completed_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_campaign_send_jobs_campaign_id
  ON campaign_send_jobs (campaign_id);

-- fast lookup for re-queuing stuck jobs
CREATE INDEX IF NOT EXISTS idx_campaign_send_jobs_status
  ON campaign_send_jobs (status)
  WHERE status IN ('pending','processing');
