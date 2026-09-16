-- Session Feature Tables
-- Creates sessions, occurrences, members, and tags with comprehensive RLS policies

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- ENUM TYPES
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE session_type AS ENUM ('talk', 'study', 'workshop', 'discussion', 'other');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE session_visibility AS ENUM ('public', 'private', 'invite_only');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE session_access_type AS ENUM ('free', 'paid');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE session_cadence AS ENUM ('one_off', 'recurring');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE occurrence_location_type AS ENUM ('physical', 'online');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE session_member_role AS ENUM ('audience', 'facilitator');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================================
-- SESSIONS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title VARCHAR(255) NOT NULL,
  description TEXT,
  creator_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  session_type session_type NOT NULL DEFAULT 'talk',
  visibility session_visibility NOT NULL DEFAULT 'public',
  access_type session_access_type NOT NULL DEFAULT 'free',
  cadence session_cadence NOT NULL DEFAULT 'one_off',
  cover_image_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for sessions
CREATE INDEX IF NOT EXISTS idx_sessions_creator_id ON sessions(creator_id);
CREATE INDEX IF NOT EXISTS idx_sessions_business_id ON sessions(business_id);
CREATE INDEX IF NOT EXISTS idx_sessions_visibility ON sessions(visibility);
CREATE INDEX IF NOT EXISTS idx_sessions_session_type ON sessions(session_type);
CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at DESC);

-- ============================================================================
-- SESSION TAGS TABLE (Normalized)
-- ============================================================================

CREATE TABLE IF NOT EXISTS session_tags (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tag VARCHAR(100) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(session_id, tag)
);

-- Indexes for session_tags
CREATE INDEX IF NOT EXISTS idx_session_tags_session_id ON session_tags(session_id);
CREATE INDEX IF NOT EXISTS idx_session_tags_tag ON session_tags(tag);

-- ============================================================================
-- SESSION OCCURRENCES TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS session_occurrences (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  title VARCHAR(255),
  start_datetime TIMESTAMP WITH TIME ZONE NOT NULL,
  end_datetime TIMESTAMP WITH TIME ZONE,
  location_type occurrence_location_type NOT NULL DEFAULT 'online',
  location_value TEXT NOT NULL,
  -- Speakers as JSONB array of objects: [{name, title, description, image_url, ...}]
  speakers JSONB DEFAULT '[]'::jsonb,
  capacity INTEGER,
  notes TEXT,
  -- Resources as JSONB array: [{name, url, type}]
  resources JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for session_occurrences
CREATE INDEX IF NOT EXISTS idx_session_occurrences_session_id ON session_occurrences(session_id);
CREATE INDEX IF NOT EXISTS idx_session_occurrences_start_datetime ON session_occurrences(start_datetime);

-- ============================================================================
-- SESSION MEMBERS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS session_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role session_member_role NOT NULL DEFAULT 'audience',
  joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  -- Payment tracking for paid sessions
  payment_reference VARCHAR(255),
  payment_status VARCHAR(20) DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'refunded')),
  UNIQUE(session_id, user_id)
);

-- Indexes for session_members
CREATE INDEX IF NOT EXISTS idx_session_members_session_id ON session_members(session_id);
CREATE INDEX IF NOT EXISTS idx_session_members_user_id ON session_members(user_id);
CREATE INDEX IF NOT EXISTS idx_session_members_role ON session_members(role);

-- ============================================================================
-- TRIGGERS FOR updated_at
-- ============================================================================

DROP TRIGGER IF EXISTS sessions_set_updated_at ON sessions;
CREATE TRIGGER sessions_set_updated_at
BEFORE UPDATE ON sessions
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

DROP TRIGGER IF EXISTS session_occurrences_set_updated_at ON session_occurrences;
CREATE TRIGGER session_occurrences_set_updated_at
BEFORE UPDATE ON session_occurrences
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

-- ============================================================================
-- RLS POLICIES
-- ============================================================================

-- Enable RLS on all tables
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_members ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- SESSIONS POLICIES
-- -----------------------------------------------------------------------------

-- SELECT: Public sessions visible to all, private/invite_only visible to members/facilitators
DROP POLICY IF EXISTS sessions_select_policy ON sessions;
CREATE POLICY sessions_select_policy ON sessions FOR SELECT USING (
  visibility = 'public'
  OR creator_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM session_members sm 
    WHERE sm.session_id = sessions.id AND sm.user_id = auth.uid()
  )
  OR EXISTS (
    SELECT 1 FROM memberships bm 
    WHERE bm.business_id = sessions.business_id AND bm.user_id = auth.uid()
  )
);

-- INSERT: Business members with session.create permission
DROP POLICY IF EXISTS sessions_insert_policy ON sessions;
CREATE POLICY sessions_insert_policy ON sessions FOR INSERT WITH CHECK (
  creator_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM memberships bm 
    WHERE bm.business_id = sessions.business_id AND bm.user_id = auth.uid()
  )
);

-- UPDATE: Creator or business members with permission
DROP POLICY IF EXISTS sessions_update_policy ON sessions;
CREATE POLICY sessions_update_policy ON sessions FOR UPDATE USING (
  creator_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM session_members sm 
    WHERE sm.session_id = sessions.id AND sm.user_id = auth.uid() AND sm.role = 'facilitator'
  )
  OR EXISTS (
    SELECT 1 FROM memberships bm 
    WHERE bm.business_id = sessions.business_id AND bm.user_id = auth.uid()
  )
);

-- DELETE: Only creator or business owner
DROP POLICY IF EXISTS sessions_delete_policy ON sessions;
CREATE POLICY sessions_delete_policy ON sessions FOR DELETE USING (
  creator_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM businesses b 
    WHERE b.id = sessions.business_id AND b.owner_user_id = auth.uid()
  )
);

-- -----------------------------------------------------------------------------
-- SESSION TAGS POLICIES
-- -----------------------------------------------------------------------------

-- SELECT: Same as parent session
DROP POLICY IF EXISTS session_tags_select_policy ON session_tags;
CREATE POLICY session_tags_select_policy ON session_tags FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM sessions s WHERE s.id = session_tags.session_id
  )
);

-- INSERT: Facilitators or creator only
DROP POLICY IF EXISTS session_tags_insert_policy ON session_tags;
CREATE POLICY session_tags_insert_policy ON session_tags FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM sessions s 
    WHERE s.id = session_tags.session_id 
    AND (
      s.creator_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM session_members sm 
        WHERE sm.session_id = s.id AND sm.user_id = auth.uid() AND sm.role = 'facilitator'
      )
    )
  )
);

-- UPDATE: Facilitators or creator only
DROP POLICY IF EXISTS session_tags_update_policy ON session_tags;
CREATE POLICY session_tags_update_policy ON session_tags FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM sessions s 
    WHERE s.id = session_tags.session_id 
    AND (
      s.creator_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM session_members sm 
        WHERE sm.session_id = s.id AND sm.user_id = auth.uid() AND sm.role = 'facilitator'
      )
    )
  )
);

-- DELETE: Facilitators or creator only
DROP POLICY IF EXISTS session_tags_delete_policy ON session_tags;
CREATE POLICY session_tags_delete_policy ON session_tags FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM sessions s 
    WHERE s.id = session_tags.session_id 
    AND (
      s.creator_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM session_members sm 
        WHERE sm.session_id = s.id AND sm.user_id = auth.uid() AND sm.role = 'facilitator'
      )
    )
  )
);

-- -----------------------------------------------------------------------------
-- SESSION OCCURRENCES POLICIES
-- -----------------------------------------------------------------------------

-- SELECT: Anyone who can see the session can see occurrences
-- But notes/resources gated by membership for paid sessions
DROP POLICY IF EXISTS session_occurrences_select_policy ON session_occurrences;
CREATE POLICY session_occurrences_select_policy ON session_occurrences FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM sessions s WHERE s.id = session_occurrences.session_id
  )
);

-- INSERT: Facilitators or creator only
DROP POLICY IF EXISTS session_occurrences_insert_policy ON session_occurrences;
CREATE POLICY session_occurrences_insert_policy ON session_occurrences FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM sessions s 
    WHERE s.id = session_occurrences.session_id 
    AND (
      s.creator_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM session_members sm 
        WHERE sm.session_id = s.id AND sm.user_id = auth.uid() AND sm.role = 'facilitator'
      )
    )
  )
);

-- UPDATE: Facilitators or creator only
DROP POLICY IF EXISTS session_occurrences_update_policy ON session_occurrences;
CREATE POLICY session_occurrences_update_policy ON session_occurrences FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM sessions s 
    WHERE s.id = session_occurrences.session_id 
    AND (
      s.creator_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM session_members sm 
        WHERE sm.session_id = s.id AND sm.user_id = auth.uid() AND sm.role = 'facilitator'
      )
    )
  )
);

-- DELETE: Facilitators or creator only
DROP POLICY IF EXISTS session_occurrences_delete_policy ON session_occurrences;
CREATE POLICY session_occurrences_delete_policy ON session_occurrences FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM sessions s 
    WHERE s.id = session_occurrences.session_id 
    AND (
      s.creator_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM session_members sm 
        WHERE sm.session_id = s.id AND sm.user_id = auth.uid() AND sm.role = 'facilitator'
      )
    )
  )
);

-- -----------------------------------------------------------------------------
-- SESSION MEMBERS POLICIES
-- -----------------------------------------------------------------------------

-- SELECT: Facilitators can see all members, members can see themselves
DROP POLICY IF EXISTS session_members_select_policy ON session_members;
CREATE POLICY session_members_select_policy ON session_members FOR SELECT USING (
  user_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM sessions s 
    WHERE s.id = session_members.session_id 
    AND (
      s.creator_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM session_members sm 
        WHERE sm.session_id = s.id AND sm.user_id = auth.uid() AND sm.role = 'facilitator'
      )
    )
  )
);

-- INSERT: Users can join public/free sessions, facilitators can add members
DROP POLICY IF EXISTS session_members_insert_policy ON session_members;
CREATE POLICY session_members_insert_policy ON session_members FOR INSERT WITH CHECK (
  -- User joining themselves
  (user_id = auth.uid() AND EXISTS (
    SELECT 1 FROM sessions s 
    WHERE s.id = session_members.session_id 
    AND s.visibility = 'public'
  ))
  -- Facilitators adding members
  OR EXISTS (
    SELECT 1 FROM sessions s 
    WHERE s.id = session_members.session_id 
    AND (
      s.creator_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM session_members sm 
        WHERE sm.session_id = s.id AND sm.user_id = auth.uid() AND sm.role = 'facilitator'
      )
    )
  )
);

-- UPDATE: Only facilitators can update member records (e.g., payment status)
DROP POLICY IF EXISTS session_members_update_policy ON session_members;
CREATE POLICY session_members_update_policy ON session_members FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM sessions s 
    WHERE s.id = session_members.session_id 
    AND (
      s.creator_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM session_members sm 
        WHERE sm.session_id = s.id AND sm.user_id = auth.uid() AND sm.role = 'facilitator'
      )
    )
  )
);

-- DELETE: Users can leave (delete own record), facilitators can remove members
DROP POLICY IF EXISTS session_members_delete_policy ON session_members;
CREATE POLICY session_members_delete_policy ON session_members FOR DELETE USING (
  user_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM sessions s 
    WHERE s.id = session_members.session_id 
    AND (
      s.creator_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM session_members sm 
        WHERE sm.session_id = s.id AND sm.user_id = auth.uid() AND sm.role = 'facilitator'
      )
    )
  )
);

-- ============================================================================
-- HELPER FUNCTION: Check if user has paid access to session
-- ============================================================================

CREATE OR REPLACE FUNCTION has_session_access(p_session_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_access_type session_access_type;
  v_is_member BOOLEAN;
  v_payment_status VARCHAR(20);
BEGIN
  -- Get session access type
  SELECT access_type INTO v_access_type
  FROM sessions
  WHERE id = p_session_id;
  
  -- Free sessions: just need to be a member
  IF v_access_type = 'free' THEN
    SELECT EXISTS (
      SELECT 1 FROM session_members 
      WHERE session_id = p_session_id AND user_id = p_user_id
    ) INTO v_is_member;
    RETURN v_is_member;
  END IF;
  
  -- Paid sessions: need to be a member with paid status
  SELECT payment_status INTO v_payment_status
  FROM session_members
  WHERE session_id = p_session_id AND user_id = p_user_id;
  
  IF v_payment_status IS NULL THEN
    RETURN FALSE;
  END IF;
  
  RETURN v_payment_status = 'paid';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- GRANT PERMISSIONS
-- ============================================================================

GRANT ALL ON sessions TO authenticated;
GRANT ALL ON session_tags TO authenticated;
GRANT ALL ON session_occurrences TO authenticated;
GRANT ALL ON session_members TO authenticated;

GRANT SELECT ON sessions TO anon;
GRANT SELECT ON session_tags TO anon;
GRANT SELECT ON session_occurrences TO anon;
