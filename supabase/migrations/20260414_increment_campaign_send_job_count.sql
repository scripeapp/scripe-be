-- Function to increment campaign send job counts atomically
-- This prevents race conditions when multiple batches update simultaneously

CREATE OR REPLACE FUNCTION increment_campaign_send_job_count(
  job_id UUID,
  sent_increment INT DEFAULT 0,
  failed_increment INT DEFAULT 0,
  new_cursor_id TEXT DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
  UPDATE campaign_send_jobs
  SET 
    sent_count = COALESCE(sent_count, 0) + sent_increment,
    failed_count = COALESCE(failed_count, 0) + failed_increment,
    cursor_id = COALESCE(new_cursor_id, cursor_id),
    updated_at = NOW()
  WHERE id = job_id;
END;
$$ LANGUAGE plpgsql;
