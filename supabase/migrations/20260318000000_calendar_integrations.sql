-- Calendar integrations table
-- Stores OAuth tokens for Google Calendar / Google Meet per user

CREATE TABLE IF NOT EXISTS calendar_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'google',
  google_email TEXT,
  access_token TEXT,
  refresh_token TEXT NOT NULL,
  token_expiry TIMESTAMPTZ,
  calendar_id TEXT DEFAULT 'primary',
  scopes TEXT[],
  connected_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, provider)
);

-- RLS
ALTER TABLE calendar_integrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their own calendar integrations"
  ON calendar_integrations FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own calendar integrations"
  ON calendar_integrations FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own calendar integrations"
  ON calendar_integrations FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own calendar integrations"
  ON calendar_integrations FOR DELETE
  USING (auth.uid() = user_id);
