-- Create scheduled_emails table for delayed delivery
CREATE TABLE IF NOT EXISTS public.scheduled_emails (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    recipient_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    email_type TEXT NOT NULL DEFAULT 'platform',
    business_id UUID,
    scheduled_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    sent_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_scheduled_emails_status_scheduled_at ON public.scheduled_emails(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_emails_recipient ON public.scheduled_emails(recipient_email);

-- Add update trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_scheduled_emails_updated_at
    BEFORE UPDATE ON public.scheduled_emails
    FOR EACH ROW
    EXECUTE PROCEDURE update_updated_at_column();
