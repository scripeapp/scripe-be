-- Create crm storage bucket for campaign images
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'crm',
  'crm',
  true,
  10485760, -- 10MB limit
  ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp']::text[]
)
ON CONFLICT (id) DO NOTHING;

-- Public read access
CREATE POLICY "crm_bucket_public_read" ON storage.objects FOR SELECT
USING (bucket_id = 'crm');

-- Authenticated users can upload
CREATE POLICY "crm_bucket_authenticated_insert" ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'crm');

-- Owner can update/delete
CREATE POLICY "crm_bucket_owner_update" ON storage.objects FOR UPDATE
TO authenticated
USING (bucket_id = 'crm');

CREATE POLICY "crm_bucket_owner_delete" ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'crm');
