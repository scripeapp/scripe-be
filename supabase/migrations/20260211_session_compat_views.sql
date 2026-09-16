-- ============================================================================
-- BACKWARD-COMPATIBLE VIEWS: sessions → circles
--
-- The backend code still references the old table names (sessions,
-- session_members, session_occurrences, session_tags). Rather than
-- renaming 60+ .from() calls across services/controllers (risky and
-- time-consuming), we create views so that Supabase resolves the old
-- names to the renamed tables transparently.
--
-- These views are updatable because they are simple 1:1 mappings.
-- ============================================================================

-- Drop views if they already exist (prevents conflicts)
DROP VIEW IF EXISTS sessions CASCADE;
DROP VIEW IF EXISTS session_members CASCADE;
DROP VIEW IF EXISTS session_occurrences CASCADE;
DROP VIEW IF EXISTS session_tags CASCADE;

-- Create backward-compatible views
CREATE VIEW sessions AS SELECT * FROM circles;
CREATE VIEW session_members AS SELECT * FROM circle_members;
CREATE VIEW session_occurrences AS SELECT * FROM circle_sessions;
CREATE VIEW session_tags AS SELECT * FROM circle_tags;

-- Make views insertable/updatable/deletable via INSTEAD OF triggers
-- (Simple views on a single table with no aggregates are auto-updatable in PostgreSQL)

-- Grant permissions on views
GRANT ALL ON sessions TO authenticated;
GRANT ALL ON session_members TO authenticated;
GRANT ALL ON session_occurrences TO authenticated;
GRANT ALL ON session_tags TO authenticated;

GRANT SELECT ON sessions TO anon;
GRANT SELECT ON session_tags TO anon;
GRANT SELECT ON session_occurrences TO anon;
