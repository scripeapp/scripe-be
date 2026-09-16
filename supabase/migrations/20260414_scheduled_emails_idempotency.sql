-- Add processing status and unique constraint to prevent duplicate scheduled emails
-- This prevents the same email from being scheduled/sent multiple times

-- 1. Add 'processing' status to the CHECK constraint
ALTER TABLE public.scheduled_emails
DROP CONSTRAINT IF EXISTS scheduled_emails_status_check;

ALTER TABLE public.scheduled_emails
ADD CONSTRAINT scheduled_emails_status_check
CHECK (status IN ('pending', 'processing', 'sent', 'failed'));

-- 2. Add unique index to prevent duplicate pending emails (same recipient + subject)
CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_emails_pending_unique
ON public.scheduled_emails(recipient_email, subject)
WHERE status = 'pending';
