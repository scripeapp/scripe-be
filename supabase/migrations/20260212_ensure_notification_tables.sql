-- 1. Create circle_notification_preferences if it doesn't exist
CREATE TABLE IF NOT EXISTS circle_notification_preferences (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  circle_id UUID NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  new_occurrence BOOLEAN DEFAULT true,
  upcoming_reminder BOOLEAN DEFAULT true,
  role_change BOOLEAN DEFAULT true,
  circle_updates BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, circle_id)
);

-- 2. Create circle_notification_queue if it doesn't exist
CREATE TABLE IF NOT EXISTS circle_notification_queue (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  circle_id UUID REFERENCES circles(id) ON DELETE CASCADE,
  circle_session_id UUID REFERENCES circle_sessions(id) ON DELETE CASCADE,
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

-- 3. Indexes
CREATE INDEX IF NOT EXISTS idx_circle_notification_prefs_user ON circle_notification_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_circle_notification_prefs_circle ON circle_notification_preferences(circle_id);
CREATE INDEX IF NOT EXISTS idx_circle_notification_queue_scheduled ON circle_notification_queue(scheduled_for) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_circle_notification_queue_user ON circle_notification_queue(user_id);

-- 4. RLS Policies
ALTER TABLE circle_notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE circle_notification_queue ENABLE ROW LEVEL SECURITY;

-- Preferences Policies
DROP POLICY IF EXISTS circle_notification_prefs_select_policy ON circle_notification_preferences;
CREATE POLICY circle_notification_prefs_select_policy ON circle_notification_preferences 
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS circle_notification_prefs_insert_policy ON circle_notification_preferences;
CREATE POLICY circle_notification_prefs_insert_policy ON circle_notification_preferences 
  FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS circle_notification_prefs_update_policy ON circle_notification_preferences;
CREATE POLICY circle_notification_prefs_update_policy ON circle_notification_preferences 
  FOR UPDATE USING (user_id = auth.uid());

-- Queue Policies
DROP POLICY IF EXISTS circle_notification_queue_select_policy ON circle_notification_queue;
CREATE POLICY circle_notification_queue_select_policy ON circle_notification_queue 
  FOR SELECT USING (user_id = auth.uid());

-- 5. Triggers
DROP TRIGGER IF EXISTS circle_notification_prefs_set_updated_at ON circle_notification_preferences;
CREATE TRIGGER circle_notification_prefs_set_updated_at
BEFORE UPDATE ON circle_notification_preferences
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

-- 6. Permissions
GRANT ALL ON circle_notification_preferences TO authenticated;
GRANT SELECT ON circle_notification_queue TO authenticated;
