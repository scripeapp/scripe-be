-- Rename occurrence_attendance → session_attendance
-- Rename occurrence_id column → session_id

BEGIN;

-- 1. Rename the table
ALTER TABLE IF EXISTS occurrence_attendance RENAME TO session_attendance;

-- 2. Rename the column
ALTER TABLE session_attendance RENAME COLUMN occurrence_id TO session_id;

-- 3. Drop old indexes and create new ones
DROP INDEX IF EXISTS idx_occurrence_attendance_occurrence;
DROP INDEX IF EXISTS idx_occurrence_attendance_user;
DROP INDEX IF EXISTS idx_occurrence_attendance_attended;

CREATE INDEX IF NOT EXISTS idx_session_attendance_session ON session_attendance(session_id);
CREATE INDEX IF NOT EXISTS idx_session_attendance_user ON session_attendance(user_id);
CREATE INDEX IF NOT EXISTS idx_session_attendance_attended ON session_attendance(attended) WHERE attended = true;

-- 4. Drop old unique constraint and recreate
ALTER TABLE session_attendance DROP CONSTRAINT IF EXISTS occurrence_attendance_occurrence_id_user_id_key;
ALTER TABLE session_attendance ADD CONSTRAINT session_attendance_session_id_user_id_key UNIQUE (session_id, user_id);

-- 5. Drop old RLS policies
DROP POLICY IF EXISTS occurrence_attendance_select_policy ON session_attendance;
DROP POLICY IF EXISTS occurrence_attendance_insert_policy ON session_attendance;
DROP POLICY IF EXISTS occurrence_attendance_update_policy ON session_attendance;
DROP POLICY IF EXISTS occurrence_attendance_delete_policy ON session_attendance;

-- 6. Recreate RLS policies with new column name
CREATE POLICY session_attendance_select_policy ON session_attendance FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM circle_sessions cs
    JOIN circles c ON cs.circle_id = c.id
    WHERE cs.id = session_attendance.session_id
    AND cs.deleted_at IS NULL
    AND (
      c.creator_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM circle_members cm
        WHERE cm.circle_id = c.id AND cm.user_id = auth.uid()
      )
    )
  )
);

CREATE POLICY session_attendance_insert_policy ON session_attendance FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM circle_sessions cs
    JOIN circles c ON cs.circle_id = c.id
    WHERE cs.id = session_attendance.session_id
    AND cs.deleted_at IS NULL
    AND (
      c.creator_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM circle_members cm
        WHERE cm.circle_id = c.id
        AND cm.user_id = auth.uid()
        AND cm.role = 'facilitator'
      )
    )
  )
);

CREATE POLICY session_attendance_update_policy ON session_attendance FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM circle_sessions cs
    JOIN circles c ON cs.circle_id = c.id
    WHERE cs.id = session_attendance.session_id
    AND cs.deleted_at IS NULL
    AND (
      c.creator_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM circle_members cm
        WHERE cm.circle_id = c.id
        AND cm.user_id = auth.uid()
        AND cm.role = 'facilitator'
      )
    )
  )
);

CREATE POLICY session_attendance_delete_policy ON session_attendance FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM circle_sessions cs
    JOIN circles c ON cs.circle_id = c.id
    WHERE cs.id = session_attendance.session_id
    AND (
      c.creator_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM circle_members cm
        WHERE cm.circle_id = c.id
        AND cm.user_id = auth.uid()
        AND cm.role = 'facilitator'
      )
    )
  )
);

-- 7. Recreate trigger
DROP TRIGGER IF EXISTS occurrence_attendance_set_updated_at ON session_attendance;
DROP TRIGGER IF EXISTS session_attendance_set_updated_at ON session_attendance;
CREATE TRIGGER session_attendance_set_updated_at
BEFORE UPDATE ON session_attendance
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

-- 8. Update get_avg_attendance function
CREATE OR REPLACE FUNCTION get_avg_attendance(p_session_id UUID)
RETURNS TABLE (avg_rate NUMERIC) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    COALESCE(
      AVG(
        (SELECT COUNT(*) FROM session_attendance 
         WHERE session_id = cs.id AND attended = true)::float / 
        NULLIF(cs.capacity, 0) * 100
      ), 
      0
    ) as avg_rate
  FROM circle_sessions cs
  WHERE cs.circle_id = p_session_id
    AND cs.start_datetime < NOW()
    AND cs.deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 9. Update grants
GRANT ALL ON session_attendance TO authenticated;

-- 10. Update comments
COMMENT ON TABLE session_attendance IS 'Tracks member attendance at circle sessions for analytics';
COMMENT ON COLUMN session_attendance.session_id IS 'References the circle_sessions table';
COMMENT ON COLUMN session_attendance.attended IS 'Whether the user attended the session';
COMMENT ON COLUMN session_attendance.checked_in_at IS 'Timestamp when user checked in (if attended)';

COMMIT;
