-- Create the user_preferences table
CREATE TABLE IF NOT EXISTS public.user_preferences (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    last_active_store_id UUID REFERENCES public.stores(id) ON DELETE SET NULL,
    last_active_publication_id UUID REFERENCES public.publications(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable RLS
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;

-- Create Policies
DROP POLICY IF EXISTS "Users can custom_view_own_user_preferences" ON public.user_preferences;
CREATE POLICY "Users can custom_view_own_user_preferences" ON public.user_preferences
    FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can custom_insert_own_user_preferences" ON public.user_preferences;
CREATE POLICY "Users can custom_insert_own_user_preferences" ON public.user_preferences
    FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can custom_update_own_user_preferences" ON public.user_preferences;
CREATE POLICY "Users can custom_update_own_user_preferences" ON public.user_preferences
    FOR UPDATE USING (auth.uid() = user_id);

-- Ensure users table has preferences column with updated defaults
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{
  "timezone": "Africa/Lagos",
  "currency": "NGN",
  "locale": "en",
  "theme": "light",
  "onboarding_intent": null,
  "onboarding_interests": []
}'::jsonb;

-- Backfill/Merge defaults for existing rows to ensure all keys exist
-- We perform a merge: 'defaults' || 'existing_values'
-- If a key exists in 'existing_values', it is kept. If not, the 'default' is used.
UPDATE public.users
SET preferences = '{
  "timezone": "Africa/Lagos",
  "currency": "NGN",
  "locale": "en",
  "theme": "light",
  "onboarding_intent": null,
  "onboarding_interests": []
}'::jsonb || COALESCE(preferences, '{}'::jsonb);

-- Add comment for schema documentation
COMMENT ON COLUMN public.users.preferences IS 'JSON object containing: timezone, currency, locale, theme, onboarding_intent, onboarding_interests';
