ALTER TABLE public.scheduled_emails
ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_emails_idempotency_key
ON public.scheduled_emails(idempotency_key)
WHERE idempotency_key IS NOT NULL;
