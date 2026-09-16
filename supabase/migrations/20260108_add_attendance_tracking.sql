-- Add Attendance Tracking System for Session Analytics
-- Enables tracking of member attendance at session occurrences

BEGIN;

-- Create attendance tracking table
CREATE TABLE IF NOT EXISTS occurrence_attendance (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  occurrence_id UUID NOT NULL REFERENCES session_occurrences(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  attended BOOLEAN DEFAULT false,
  checked_in_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(occurrence_id, user_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_occurrence_attendance_occurrence ON occurrence_attendance(occurrence_id);
CREATE INDEX IF NOT EXISTS idx_occurrence_attendance_user ON occurrence_attendance(user_id);
CREATE INDEX IF NOT EXISTS idx_occurrence_attendance_attended ON occurrence_attendance(attended) WHERE attended = true;

-- Add capacity column to session_occurrences if not exists
ALTER TABLE session_occurrences ADD COLUMN IF NOT EXISTS capacity INTEGER DEFAULT 50;

-- Enable RLS
ALTER TABLE occurrence_attendance ENABLE ROW LEVEL SECURITY;

-- RLS Policies

-- SELECT: Users can view attendance for sessions they're members of
DROP POLICY IF EXISTS occurrence_attendance_select_policy ON occurrence_attendance;
CREATE POLICY occurrence_attendance_select_policy ON occurrence_attendance FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM session_occurrences o
    JOIN sessions s ON o.session_id = s.id
    WHERE o.id = occurrence_attendance.occurrence_id
    AND s.deleted_at IS NULL
    AND (
      s.creator_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM session_members sm
        WHERE sm.session_id = s.id AND sm.user_id = auth.uid()
      )
    )
  )
);

-- INSERT/UPDATE: Only facilitators can mark attendance
DROP POLICY IF EXISTS occurrence_attendance_insert_policy ON occurrence_attendance;
CREATE POLICY occurrence_attendance_insert_policy ON occurrence_attendance FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM session_occurrences o
    JOIN sessions s ON o.session_id = s.id
    WHERE o.id = occurrence_attendance.occurrence_id
    AND s.deleted_at IS NULL
    AND (
      s.creator_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM session_members sm
        WHERE sm.session_id = s.id 
        AND sm.user_id = auth.uid() 
        AND sm.role = 'facilitator'
      )
    )
  )
);

DROP POLICY IF EXISTS occurrence_attendance_update_policy ON occurrence_attendance;
CREATE POLICY occurrence_attendance_update_policy ON occurrence_attendance FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM session_occurrences o
    JOIN sessions s ON o.session_id = s.id
    WHERE o.id = occurrence_attendance.occurrence_id
    AND s.deleted_at IS NULL
    AND (
      s.creator_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM session_members sm
        WHERE sm.session_id = s.id 
        AND sm.user_id = auth.uid() 
        AND sm.role = 'facilitator'
      )
    )
  )
);

-- DELETE: Only facilitators can delete attendance records
DROP POLICY IF EXISTS occurrence_attendance_delete_policy ON occurrence_attendance;
CREATE POLICY occurrence_attendance_delete_policy ON occurrence_attendance FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM session_occurrences o
    JOIN sessions s ON o.session_id = s.id
    WHERE o.id = occurrence_attendance.occurrence_id
    AND (
      s.creator_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM session_members sm
        WHERE sm.session_id = s.id 
        AND sm.user_id = auth.uid() 
        AND sm.role = 'facilitator'
      )
    )
  )
);

-- Trigger for updated_at
DROP TRIGGER IF EXISTS occurrence_attendance_set_updated_at ON occurrence_attendance;
CREATE TRIGGER occurrence_attendance_set_updated_at
BEFORE UPDATE ON occurrence_attendance
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

-- Grant permissions
GRANT ALL ON occurrence_attendance TO authenticated;

-- Comments for documentation
COMMENT ON TABLE occurrence_attendance IS 'Tracks member attendance at session occurrences for analytics';
COMMENT ON COLUMN occurrence_attendance.attended IS 'Whether the user attended the occurrence';
COMMENT ON COLUMN occurrence_attendance.checked_in_at IS 'Timestamp when user checked in (if attended)';
COMMENT ON COLUMN session_occurrences.capacity IS 'Maximum capacity for the occurrence';

COMMIT;
