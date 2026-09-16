-- Course Content System Tables
-- Modules, Lessons, and Progress tracking for course products

-- Course Modules
CREATE TABLE course_modules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Course Lessons
CREATE TABLE course_lessons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id UUID NOT NULL REFERENCES course_modules(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  type TEXT CHECK (type IN ('video', 'text', 'file')) DEFAULT 'video',
  content JSONB DEFAULT '{}', -- { video_url, text_content, file_url, thumbnail_url }
  duration_minutes INTEGER DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  is_preview BOOLEAN DEFAULT FALSE, -- Can be viewed without purchase
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Course Progress (per user per lesson)
CREATE TABLE course_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  lesson_id UUID NOT NULL REFERENCES course_lessons(id) ON DELETE CASCADE,
  completed_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, lesson_id)
);

-- Indexes
CREATE INDEX idx_course_modules_product ON course_modules(product_id);
CREATE INDEX idx_course_modules_position ON course_modules(product_id, position);
CREATE INDEX idx_course_lessons_module ON course_lessons(module_id);
CREATE INDEX idx_course_lessons_position ON course_lessons(module_id, position);
CREATE INDEX idx_course_progress_user ON course_progress(user_id);
CREATE INDEX idx_course_progress_product ON course_progress(user_id, product_id);

-- RLS Policies
ALTER TABLE course_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_lessons ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_progress ENABLE ROW LEVEL SECURITY;

-- Public can view modules (for curriculum display)
CREATE POLICY "Anyone can view modules"
  ON course_modules FOR SELECT USING (true);

-- Public can view lesson metadata (not full content)
CREATE POLICY "Anyone can view lessons"
  ON course_lessons FOR SELECT USING (true);

-- Store owners can manage modules
CREATE POLICY "Store owners can manage modules"
  ON course_modules FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM products p
      JOIN stores s ON s.id = p.store_id
      JOIN memberships m ON m.business_id = s.business_id
      WHERE p.id = course_modules.product_id AND m.user_id = auth.uid()
    )
  );

-- Store owners can manage lessons
CREATE POLICY "Store owners can manage lessons"
  ON course_lessons FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM course_modules cm
      JOIN products p ON p.id = cm.product_id
      JOIN stores s ON s.id = p.store_id
      JOIN memberships m ON m.business_id = s.business_id
      WHERE cm.id = course_lessons.module_id AND m.user_id = auth.uid()
    )
  );

-- Users can view/insert their own progress
CREATE POLICY "Users can manage own progress"
  ON course_progress FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

COMMENT ON TABLE course_modules IS 'Course modules/sections for course products';
COMMENT ON TABLE course_lessons IS 'Individual lessons within course modules';
COMMENT ON TABLE course_progress IS 'User progress tracking for course completion';
