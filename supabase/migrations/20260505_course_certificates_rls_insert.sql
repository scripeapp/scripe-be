-- Allow authenticated users to insert and update their own certificates.
-- The initial migration only had a SELECT policy, which blocked the upsert
-- performed by the backend when a student completes all lessons.

CREATE POLICY "Users insert own certificates"
  ON course_certificates FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own certificates"
  ON course_certificates FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
