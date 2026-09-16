-- ============================================================================
-- Scheduling: Event Types + Scheduled Bookings
-- ============================================================================

-- Event types — the schedulable meeting/call types a user creates
CREATE TABLE IF NOT EXISTS event_types (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  business_id             UUID REFERENCES businesses(id) ON DELETE CASCADE,
  slug                    TEXT NOT NULL,
  title                   TEXT NOT NULL,
  description             TEXT,
  duration_minutes        INTEGER NOT NULL DEFAULT 30,
  location_type           TEXT NOT NULL DEFAULT 'google_meet',
  -- 'google_meet' | 'in_person' | 'phone' | 'custom'
  location_details        TEXT,
  color                   TEXT DEFAULT '#6366f1',
  is_active               BOOLEAN DEFAULT true,
  requires_confirmation   BOOLEAN DEFAULT false,
  availability_profile_id UUID REFERENCES availability_profiles(id) ON DELETE SET NULL,
  min_notice_minutes      INTEGER DEFAULT 60,
  max_advance_days        INTEGER DEFAULT 60,
  buffer_before_minutes   INTEGER DEFAULT 0,
  buffer_after_minutes    INTEGER DEFAULT 0,
  questions               JSONB DEFAULT '[]',
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, slug)
);

-- Scheduled bookings — customer-facing bookings via the public scheduling page
CREATE TABLE IF NOT EXISTS scheduled_bookings (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type_id            UUID NOT NULL REFERENCES event_types(id) ON DELETE CASCADE,
  host_user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  attendee_name            TEXT NOT NULL,
  attendee_email           TEXT NOT NULL,
  attendee_notes           TEXT,
  answers                  JSONB DEFAULT '{}',
  booking_date             DATE NOT NULL,
  start_time               TIME NOT NULL,
  end_time                 TIME NOT NULL,
  timezone                 TEXT NOT NULL DEFAULT 'UTC',
  status                   TEXT NOT NULL DEFAULT 'confirmed',
  -- 'confirmed' | 'pending' | 'cancelled' | 'rescheduled' | 'completed'
  cancel_reason            TEXT,
  google_calendar_event_id TEXT,
  google_meet_link         TEXT,
  reschedule_token         TEXT UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  cancel_token             TEXT UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_event_types_user_id ON event_types(user_id);
CREATE INDEX IF NOT EXISTS idx_event_types_business_id ON event_types(business_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_bookings_event_type_id ON scheduled_bookings(event_type_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_bookings_host_user_id ON scheduled_bookings(host_user_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_bookings_booking_date ON scheduled_bookings(booking_date);
CREATE INDEX IF NOT EXISTS idx_scheduled_bookings_attendee_email ON scheduled_bookings(attendee_email);

-- updated_at triggers
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS event_types_set_updated_at ON event_types;
CREATE TRIGGER event_types_set_updated_at
  BEFORE UPDATE ON event_types
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS scheduled_bookings_set_updated_at ON scheduled_bookings;
CREATE TRIGGER scheduled_bookings_set_updated_at
  BEFORE UPDATE ON scheduled_bookings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS
ALTER TABLE event_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_bookings ENABLE ROW LEVEL SECURITY;

-- Event types: owner can do everything
CREATE POLICY "Owner full access on event_types"
  ON event_types FOR ALL
  USING (auth.uid() = user_id);

-- Event types: public read for active ones (for booking page)
CREATE POLICY "Public read active event_types"
  ON event_types FOR SELECT
  USING (is_active = true);

-- Scheduled bookings: host can read/update their own
CREATE POLICY "Host can manage their scheduled_bookings"
  ON scheduled_bookings FOR ALL
  USING (auth.uid() = host_user_id);

-- Scheduled bookings: public insert (anyone can book)
CREATE POLICY "Public can create scheduled_bookings"
  ON scheduled_bookings FOR INSERT
  WITH CHECK (true);

-- Scheduled bookings: attendee can read via cancel/reschedule token (handled in service)
