-- Migration: Add cover image to courses and cohorts
ALTER TABLE circle_courses ADD COLUMN IF NOT EXISTS cover_image_url TEXT;
ALTER TABLE circle_cohorts ADD COLUMN IF NOT EXISTS cover_image_url TEXT;
