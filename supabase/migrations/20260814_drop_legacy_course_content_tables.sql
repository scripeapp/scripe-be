-- Drop the legacy products-backed course content tables.
--
-- These tables were the first attempt at selling courses through the store
-- (keyed to products.id). The active course schema lives under circle_courses
-- (circle_course_modules, circle_course_lessons, circle_course_enrollments,
-- circle_course_lesson_progress, course_certificates) and zero backend or
-- frontend code paths reference these legacy tables. The products.type_check
-- constraint keeps 'course' as a valid type because the store Product Wizard
-- still creates type='course' products.
--
-- Drop child tables first so their foreign keys to the parent tables resolve.
-- RLS policies, indexes, and comments on these tables are dropped implicitly.

DROP TABLE IF EXISTS course_progress;
DROP TABLE IF EXISTS course_lessons;
DROP TABLE IF EXISTS course_modules;
