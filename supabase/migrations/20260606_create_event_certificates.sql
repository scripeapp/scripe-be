-- Issued certificate records (source of truth). PDFs are generated on demand
-- and streamed — never stored. One certificate per issued ticket.

CREATE TABLE IF NOT EXISTS event_certificates (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  ticket_id        UUID NOT NULL REFERENCES issued_tickets(id) ON DELETE CASCADE,
  business_id      UUID REFERENCES businesses(id) ON DELETE CASCADE,

  -- Snapshotted at issue time so the certificate is self-contained.
  recipient_name   TEXT,
  recipient_email  TEXT,
  event_name       TEXT,
  business_name    TEXT,
  event_end_at     TIMESTAMPTZ,

  serial           TEXT,                       -- human-readable, sequential-ish
  verify_code      TEXT NOT NULL,              -- random, non-guessable token

  status           TEXT NOT NULL DEFAULT 'issued'
                     CHECK (status IN ('issued', 'revoked')),

  issued_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT event_certificates_ticket_unique UNIQUE (ticket_id),
  CONSTRAINT event_certificates_verify_code_unique UNIQUE (verify_code)
);

CREATE INDEX IF NOT EXISTS idx_event_certificates_event
  ON event_certificates (event_id);
CREATE INDEX IF NOT EXISTS idx_event_certificates_verify_code
  ON event_certificates (verify_code);

ALTER TABLE event_certificates ENABLE ROW LEVEL SECURITY;

-- Business members can read certificates issued for their events.
-- Public verification + recipient download go through the service layer using
-- the service-role key (bypasses RLS), so no public SELECT policy is needed.
CREATE POLICY "Business members read event certificates"
  ON event_certificates
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.business_id = event_certificates.business_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
    )
  );
