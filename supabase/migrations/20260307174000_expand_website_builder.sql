-- Create website_pages table
CREATE TABLE IF NOT EXISTS website_pages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    website_id UUID NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    is_homepage BOOLEAN NOT NULL DEFAULT false,
    seo_metadata JSONB DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'draft',
    content JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    
    -- Ensure unique slugs per website
    UNIQUE(website_id, slug)
);

-- Index for querying pages by website and slug
CREATE INDEX IF NOT EXISTS idx_website_pages_website_id ON website_pages(website_id);
CREATE INDEX IF NOT EXISTS idx_website_pages_slug ON website_pages(website_id, slug);

-- Trigger to update updated_at on website_pages
CREATE OR REPLACE FUNCTION set_website_pages_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = timezone('utc'::text, now());
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_website_pages_updated_at ON website_pages;
CREATE TRIGGER trg_website_pages_updated_at
    BEFORE UPDATE ON website_pages
    FOR EACH ROW
    EXECUTE PROCEDURE set_website_pages_updated_at();

-- RLS Policies for website_pages
ALTER TABLE website_pages ENABLE ROW LEVEL SECURITY;

-- Allow public read access to published pages of live websites
CREATE POLICY "Public can view published pages of live websites" 
    ON website_pages FOR SELECT 
    USING (
        status = 'published' AND 
        EXISTS (
            SELECT 1 FROM websites 
            WHERE websites.id = website_pages.website_id 
            AND websites.is_live = true
        )
    );

-- Users can view their own website pages
CREATE POLICY "Users can view their own website pages" 
    ON website_pages FOR SELECT 
    USING (
        EXISTS (
            SELECT 1 FROM websites 
            WHERE websites.id = website_pages.website_id 
            AND websites.user_id = auth.uid()
        )
    );

-- Business members can view their business's website pages
CREATE POLICY "Business members can view their business website pages" 
    ON website_pages FOR SELECT 
    USING (
        EXISTS (
            SELECT 1 FROM websites w
            JOIN memberships m ON m.business_id = w.business_id
            WHERE w.id = website_pages.website_id 
            AND m.user_id = auth.uid()
        )
    );

-- Users can insert pages to their own websites
CREATE POLICY "Users can insert pages to their own websites" 
    ON website_pages FOR INSERT 
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM websites 
            WHERE websites.id = website_pages.website_id 
            AND websites.user_id = auth.uid()
        )
    );

-- Business members can insert pages to their business's websites
CREATE POLICY "Business members can insert pages to their business websites" 
    ON website_pages FOR INSERT 
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM websites w
            JOIN memberships m ON m.business_id = w.business_id
            WHERE w.id = website_pages.website_id 
            AND m.user_id = auth.uid()
        )
    );

-- Users can update pages of their own websites
CREATE POLICY "Users can update pages of their own websites" 
    ON website_pages FOR UPDATE 
    USING (
        EXISTS (
            SELECT 1 FROM websites 
            WHERE websites.id = website_pages.website_id 
            AND websites.user_id = auth.uid()
        )
    );

-- Business members can update pages of their business's websites
CREATE POLICY "Business members can update pages of their business websites" 
    ON website_pages FOR UPDATE 
    USING (
        EXISTS (
            SELECT 1 FROM websites w
            JOIN memberships m ON m.business_id = w.business_id
            WHERE w.id = website_pages.website_id 
            AND m.user_id = auth.uid()
        )
    );

-- Users can delete pages of their own websites
CREATE POLICY "Users can delete pages of their own websites" 
    ON website_pages FOR DELETE 
    USING (
        EXISTS (
            SELECT 1 FROM websites 
            WHERE websites.id = website_pages.website_id 
            AND websites.user_id = auth.uid()
        )
    );

-- Business members can delete pages of their business's websites
CREATE POLICY "Business members can delete pages of their business websites" 
    ON website_pages FOR DELETE 
    USING (
        EXISTS (
            SELECT 1 FROM websites w
            JOIN memberships m ON m.business_id = w.business_id
            WHERE w.id = website_pages.website_id 
            AND m.user_id = auth.uid()
        )
    );
