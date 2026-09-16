-- Add analytics columns to posts table
ALTER TABLE public.posts 
ADD COLUMN IF NOT EXISTS views_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS email_sent_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS email_open_count INTEGER DEFAULT 0;

-- Add tracking source to subscriptions table
ALTER TABLE public.subscriptions
ADD COLUMN IF NOT EXISTS source_post_id UUID REFERENCES public.posts(id) ON DELETE SET NULL;

-- Add index for source_post_id for performance
CREATE INDEX IF NOT EXISTS idx_subscriptions_source_post_id ON public.subscriptions(source_post_id);

-- Function to increment post views atomic
CREATE OR REPLACE FUNCTION increment_post_views(post_id_param UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE public.posts
  SET views_count = COALESCE(views_count, 0) + 1
  WHERE id = post_id_param;
END;
$$ LANGUAGE plpgsql;

