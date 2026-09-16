-- Course certificates issued when a student completes all lessons in a course.
-- One certificate per (user, course) pair.

CREATE TABLE IF NOT EXISTS course_certificates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  course_id     UUID NOT NULL REFERENCES circle_courses(id) ON DELETE CASCADE,
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Denormalised at issue time so the certificate is self-contained even if the
  -- course or user record changes later.
  recipient_name  TEXT,
  course_title    TEXT NOT NULL,
  business_name   TEXT,

  CONSTRAINT course_certificates_unique_enrollment UNIQUE (user_id, course_id)
);

CREATE INDEX IF NOT EXISTS idx_course_certificates_user    ON course_certificates (user_id);
CREATE INDEX IF NOT EXISTS idx_course_certificates_course  ON course_certificates (course_id);

-- RLS
ALTER TABLE course_certificates ENABLE ROW LEVEL SECURITY;

-- Owners can read their own certificates
CREATE POLICY "Users read own certificates"
  ON course_certificates FOR SELECT
  USING (auth.uid() = user_id);

-- Public verification: anyone can read by ID (handled via service layer bypassing RLS
-- using the service-role key — no public RLS policy needed here).
