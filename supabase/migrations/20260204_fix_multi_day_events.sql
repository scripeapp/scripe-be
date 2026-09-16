-- Migration to support Multi-day/Conference events
-- Adds event_sessions and event_speakers columns and updates the event_type check constraint

-- 1. Add new columns for sessions and speakers (JSONB arrays)
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS event_sessions JSONB DEFAULT '[]'::jsonb;
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS event_speakers JSONB DEFAULT '[]'::jsonb;

-- 2. Update the event_type check constraint to include 'multi_day'
-- The constraint name was found in the error message as 'ticketed_events_event_type_check'
ALTER TABLE public.events DROP CONSTRAINT IF EXISTS ticketed_events_event_type_check;
ALTER TABLE public.events ADD CONSTRAINT ticketed_events_event_type_check 
  CHECK (event_type IN ('single', 'recurring', 'multi_day'));

-- Note: In some environments, the table might have legacy constraint names.
-- We use DROP IF EXISTS to ensure safety.
