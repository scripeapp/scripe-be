-- Add Notification System for Session Feature
-- Enables user notification preferences and scheduled notifications

BEGIN;

-- =============================================================================
-- NOTIFICATION PREFERENCES TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS notification_preferences (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  new_occurrence BOOLEAN DEFAULT true,
  upcoming_reminder BOOLEAN DEFAULT true,
  role_change BOOLEAN DEFAULT true,
  session_updates BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_prefs_user ON notification_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_notification_prefs_session ON notification_preferences(session_id);

-- =============================================================================
-- NOTIFICATION QUEUE TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS notification_queue (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  occurrence_id UUID REFERENCES session_occurrences(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL CHECK (type IN (
    'new_occurrence', 
    'upcoming_reminder', 
    'role_change', 
    'session_update'
  )),
  scheduled_for TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  error_message TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_queue_scheduled ON notification_queue(scheduled_for) 
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_notification_queue_user ON notification_queue(user_id);
CREATE INDEX IF NOT EXISTS idx_notification_queue_status ON notification_queue(status);
CREATE INDEX IF NOT EXISTS idx_notification_queue_type ON notification_queue(type);

-- =============================================================================
-- RLS POLICIES
-- =============================================================================

-- Notification Preferences
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

-- Users can view their own preferences
DROP POLICY IF EXISTS notification_prefs_select_policy ON notification_preferences;
CREATE POLICY notification_prefs_select_policy ON notification_preferences 
  FOR SELECT USING (user_id = auth.uid());

-- Users can create their own preferences
DROP POLICY IF EXISTS notification_prefs_insert_policy ON notification_preferences;
CREATE POLICY notification_prefs_insert_policy ON notification_preferences 
  FOR INSERT WITH CHECK (user_id = auth.uid());

-- Users can update their own preferences
DROP POLICY IF EXISTS notification_prefs_update_policy ON notification_preferences;
CREATE POLICY notification_prefs_update_policy ON notification_preferences 
  FOR UPDATE USING (user_id = auth.uid());

-- Users can delete their own preferences
DROP POLICY IF EXISTS notification_prefs_delete_policy ON notification_preferences;
CREATE POLICY notification_prefs_delete_policy ON notification_preferences 
  FOR DELETE USING (user_id = auth.uid());

-- Notification Queue
ALTER TABLE notification_queue ENABLE ROW LEVEL SECURITY;

-- Users can view their own queued notifications
DROP POLICY IF EXISTS notification_queue_select_policy ON notification_queue;
CREATE POLICY notification_queue_select_policy ON notification_queue 
  FOR SELECT USING (user_id = auth.uid());

-- Only system can insert notifications (via service role)
-- No INSERT policy for authenticated users

-- =============================================================================
-- TRIGGERS
-- =============================================================================

DROP TRIGGER IF EXISTS notification_prefs_set_updated_at ON notification_preferences;
CREATE TRIGGER notification_prefs_set_updated_at
BEFORE UPDATE ON notification_preferences
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

-- =============================================================================
-- GRANT PERMISSIONS
-- =============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON notification_preferences TO authenticated;
GRANT SELECT ON notification_queue TO authenticated;

-- =============================================================================
-- COMMENTS
-- =============================================================================

COMMENT ON TABLE notification_preferences IS 'User notification preferences for sessions';
COMMENT ON TABLE notification_queue IS 'Queue for scheduled session notifications';
COMMENT ON COLUMN notification_preferences.new_occurrence IS 'Notify when new occurrence is scheduled';
COMMENT ON COLUMN notification_preferences.upcoming_reminder IS 'Send reminder 24h before occurrence';
COMMENT ON COLUMN notification_preferences.role_change IS 'Notify when user role changes';
COMMENT ON COLUMN notification_preferences.session_updates IS 'Notify on session detail updates';
COMMENT ON COLUMN notification_queue.scheduled_for IS 'When to send the notification';
COMMENT ON COLUMN notification_queue.status IS 'Notification delivery status';

COMMIT;
