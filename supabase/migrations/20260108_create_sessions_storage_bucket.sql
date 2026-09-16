-- Create sessions storage bucket for cover images and resources
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'sessions',
  'sessions',
  true,
  10485760, -- 10MB limit
  ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp']::text[]
)
ON CONFLICT (id) DO NOTHING;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "sessions_bucket_public_read" ON storage.objects;
DROP POLICY IF EXISTS "sessions_bucket_authenticated_insert" ON storage.objects;
DROP POLICY IF EXISTS "sessions_bucket_owner_update" ON storage.objects;
DROP POLICY IF EXISTS "sessions_bucket_owner_delete" ON storage.objects;

-- Public read access for session images
CREATE POLICY "sessions_bucket_public_read" ON storage.objects FOR SELECT
USING (bucket_id = 'sessions');

-- Authenticated users can upload to their business folder
CREATE POLICY "sessions_bucket_authenticated_insert" ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'sessions'
);

-- Owner/business member can update their uploads
CREATE POLICY "sessions_bucket_owner_update" ON storage.objects FOR UPDATE
TO authenticated
USING (
  bucket_id = 'sessions' 
  AND auth.uid() IS NOT NULL
);

-- Owner/business member can delete their uploads
CREATE POLICY "sessions_bucket_owner_delete" ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'sessions'
  AND auth.uid() IS NOT NULL
);
