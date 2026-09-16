-- Database Optimization for Session API
-- Adds compound indexes for efficient filtering and sorting

-- Optimized index for session occurrences retrieval
CREATE INDEX IF NOT EXISTS idx_session_occurrences_session_time 
ON session_occurrences(session_id, start_datetime);

-- Optimized index for member lookups
CREATE INDEX IF NOT EXISTS idx_session_members_composite 
ON session_members(session_id, user_id);

-- Optional: Index for role-based member filtering
CREATE INDEX IF NOT EXISTS idx_session_members_role_lookup
ON session_members(session_id, role);
