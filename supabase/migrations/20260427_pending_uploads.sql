-- pending_uploads: tracks in-progress R2 presigned uploads for orphan detection and QStash callbacks
CREATE TABLE IF NOT EXISTS pending_uploads (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_key          TEXT NOT NULL,
  business_id       UUID NOT NULL,
  context           TEXT NOT NULL,         -- e.g. 'lesson-video', 'course-material'
  entity_id         TEXT,                  -- lesson id, course id, etc.
  file_name         TEXT NOT NULL,
  mime_type         TEXT NOT NULL,
  size_bytes        BIGINT,
  uploaded_by       UUID NOT NULL,
  confirmed_at      TIMESTAMPTZ,
  processing_job_id TEXT,                  -- QStash message ID
  processed_at      TIMESTAMPTZ,           -- set by process-video callback after HeadObject verification
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '1 hour'),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE pending_uploads ENABLE ROW LEVEL SECURITY;

-- Only service-role backend can read/write this table
CREATE POLICY "service role only" ON pending_uploads
  USING (auth.role() = 'service_role');

-- Partial index for efficient orphan cleanup queries
CREATE INDEX IF NOT EXISTS idx_pending_uploads_unconfirmed
  ON pending_uploads (expires_at)
  WHERE confirmed_at IS NULL;
