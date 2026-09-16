-- Ensure the 'posts' storage bucket exists and is public so that
-- cover images and inline images are accessible for OG scraping and emails.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'posts',
  'posts',
  true,
  10485760, -- 10 MB limit per file
  ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
  SET public = true,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Public read policy: anyone can view post images
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'Post images are publicly accessible'
  ) THEN
    CREATE POLICY "Post images are publicly accessible"
      ON storage.objects FOR SELECT
      USING (bucket_id = 'posts');
  END IF;
END $$;

-- Authenticated users can upload to their own paths
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'Authenticated users can upload post images'
  ) THEN
    CREATE POLICY "Authenticated users can upload post images"
      ON storage.objects FOR INSERT
      TO authenticated
      WITH CHECK (bucket_id = 'posts');
  END IF;
END $$;

-- Authenticated users can update/delete their own uploads
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'Authenticated users can manage their post images'
  ) THEN
    CREATE POLICY "Authenticated users can manage their post images"
      ON storage.objects FOR ALL
      TO authenticated
      USING (bucket_id = 'posts' AND auth.uid()::text = (storage.foldername(name))[1]);
  END IF;
END $$;
