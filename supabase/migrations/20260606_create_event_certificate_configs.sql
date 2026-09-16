-- Per-event configuration for automated certificates of attendance.
-- One config row per event (1:1).

CREATE TABLE IF NOT EXISTS event_certificate_configs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id            UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  business_id         UUID REFERENCES businesses(id) ON DELETE CASCADE,

  enabled             BOOLEAN NOT NULL DEFAULT false,

  -- Who qualifies: everyone who registered, or only those checked in.
  eligibility         TEXT NOT NULL DEFAULT 'checked_in'
                        CHECK (eligibility IN ('registered', 'checked_in')),

  -- When certificates become available after the event ends.
  release_mode        TEXT NOT NULL DEFAULT 'auto'
                        CHECK (release_mode IN ('auto', 'manual')),
  release_delay_hours INTEGER NOT NULL DEFAULT 24
                        CHECK (release_delay_hours >= 0 AND release_delay_hours <= 24),
  released_at         TIMESTAMPTZ,
  release_job_id      TEXT,            -- QStash messageId for scheduled auto-release

  -- Template / branding
  background_url      TEXT,
  accent_color        TEXT,
  signatory_name      TEXT,
  signatory_title     TEXT,
  signature_url       TEXT,
  body_text           TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT event_certificate_configs_event_unique UNIQUE (event_id)
);

CREATE INDEX IF NOT EXISTS idx_event_certificate_configs_event
  ON event_certificate_configs (event_id);
CREATE INDEX IF NOT EXISTS idx_event_certificate_configs_business
  ON event_certificate_configs (business_id);

ALTER TABLE event_certificate_configs ENABLE ROW LEVEL SECURITY;

-- Members of the owning business can manage the config. Mirrors the membership
-- check used across business-scoped tables.
CREATE POLICY "Business members manage certificate configs"
  ON event_certificate_configs
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.business_id = event_certificate_configs.business_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.business_id = event_certificate_configs.business_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );
