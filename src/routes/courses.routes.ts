import express from "express";
import multer from "multer";
import {
  authenticateUser,
  authenticateOptional,
} from "../middleware/supabase-auth-middleware";
import { withSupabase } from "../types/http";
import {
  getCourses,
  getCourse,
  createCourse,
  updateCourse,
  deleteCourse,
  uploadCourseImage,
  getCourseEnrollments,
  enrollCourse,
  unenrollCourse,
  initiateCourseCheckout,
  getCourseProgress,
  markLessonComplete,
  unmarkLessonComplete,
  getCourseCertificate,
  getMyEnrolledCourses,
  createModule,
  reorderModules,
  updateModule,
  deleteModule,
  createLesson,
  updateLesson,
  deleteLesson,
} from "../controllers/courses.controller";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// ---------------------------------------------------------------------------
// Courses
// GET  /api/courses              — list (circle_id or business_id in query)
// POST /api/courses              — create
// GET  /api/courses/:courseId    — single
// PATCH /api/courses/:courseId   — update
// DELETE /api/courses/:courseId  — delete
// ---------------------------------------------------------------------------

router.get("/", authenticateOptional, withSupabase(getCourses));
router.post("/", authenticateUser, withSupabase(createCourse));
// Must be before /:courseId to avoid Express treating "my" as a courseId param
router.get("/my", authenticateUser, withSupabase(getMyEnrolledCourses));
router.get("/:courseId", authenticateOptional, withSupabase(getCourse));
router.patch("/:courseId", authenticateUser, withSupabase(updateCourse));
router.delete("/:courseId", authenticateUser, withSupabase(deleteCourse));

router.post(
  "/:courseId/upload-image",
  authenticateUser,
  upload.single("file"),
  withSupabase(uploadCourseImage),
);

// ---------------------------------------------------------------------------
// Enrollments
// ---------------------------------------------------------------------------

router.get(
  "/:courseId/enrollments",
  authenticateUser,
  withSupabase(getCourseEnrollments),
);
router.post("/:courseId/enroll", authenticateUser, withSupabase(enrollCourse));
router.delete(
  "/:courseId/enroll",
  authenticateUser,
  withSupabase(unenrollCourse),
);
router.post(
  "/:courseId/checkout/initiate",
  authenticateUser,
  withSupabase(initiateCourseCheckout),
);

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

router.get(
  "/:courseId/progress",
  authenticateUser,
  withSupabase(getCourseProgress),
);
router.post(
  "/:courseId/lessons/:lessonId/complete",
  authenticateUser,
  withSupabase(markLessonComplete),
);
router.delete(
  "/:courseId/lessons/:lessonId/complete",
  authenticateUser,
  withSupabase(unmarkLessonComplete),
);

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

router.post("/:courseId/modules", authenticateUser, withSupabase(createModule));
// reorder must be registered before /:moduleId to avoid route collision
router.patch(
  "/:courseId/modules/reorder",
  authenticateUser,
  withSupabase(reorderModules),
);
router.patch(
  "/:courseId/modules/:moduleId",
  authenticateUser,
  withSupabase(updateModule),
);
router.delete(
  "/:courseId/modules/:moduleId",
  authenticateUser,
  withSupabase(deleteModule),
);

// ---------------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------------

router.post(
  "/:courseId/modules/:moduleId/lessons",
  authenticateUser,
  withSupabase(createLesson),
);
router.patch(
  "/:courseId/lessons/:lessonId",
  authenticateUser,
  withSupabase(updateLesson),
);
router.delete(
  "/:courseId/lessons/:lessonId",
  authenticateUser,
  withSupabase(deleteLesson),
);

// ---------------------------------------------------------------------------
// Certificate
// ---------------------------------------------------------------------------

router.get(
  "/:courseId/certificate",
  authenticateUser,
  withSupabase(getCourseCertificate),
);

export default router;
