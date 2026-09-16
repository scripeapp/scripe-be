-- Add Soft Deletes for Data Retention
-- Allows recovery of accidentally deleted sessions

BEGIN;

-- Add deleted_at columns
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE session_occurrences ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

-- Create index for filtering deleted records
CREATE INDEX IF NOT EXISTS idx_sessions_deleted_at ON sessions(deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_session_occurrences_deleted_at ON session_occurrences(deleted_at) WHERE deleted_at IS NULL;

-- Update RLS policies to exclude deleted records

-- Sessions SELECT policy
DROP POLICY IF EXISTS sessions_select_policy ON sessions;
CREATE POLICY sessions_select_policy ON sessions FOR SELECT USING (
  deleted_at IS NULL AND (
    visibility = 'public'
    OR creator_id = auth.uid()
    OR business_id IN (
      SELECT business_id FROM memberships WHERE user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM session_members sm
      WHERE sm.session_id = sessions.id
      AND sm.user_id = auth.uid()
    )
  )
);

-- Session Occurrences SELECT policy
DROP POLICY IF EXISTS session_occurrences_select_policy ON session_occurrences;
CREATE POLICY session_occurrences_select_policy ON session_occurrences FOR SELECT USING (
  deleted_at IS NULL AND (
    EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = session_occurrences.session_id
      AND s.deleted_at IS NULL
      AND (
        s.visibility = 'public'
        OR s.creator_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM session_members sm
          WHERE sm.session_id = s.id
          AND sm.user_id = auth.uid()
        )
      )
    )
  )
);

-- Comments for documentation
COMMENT ON COLUMN sessions.deleted_at IS 'Soft delete timestamp. NULL means active, non-NULL means deleted';
COMMENT ON COLUMN session_occurrences.deleted_at IS 'Soft delete timestamp. NULL means active, non-NULL means deleted';

COMMIT;
