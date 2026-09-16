import { SupabaseClient } from "@supabase/supabase-js";
import supabaseAdmin from "../config/supabaseAdmin";
import {
  CircleCourse,
  CircleCourseModule,
  CircleCourseLesson,
  CircleCourseProgress,
  CourseCertificate,
  CourseEnrollment,
  CreateCircleCourseInput,
  UpdateCircleCourseInput,
  CreateCircleCourseModuleInput,
  CreateCircleCourseLessonInput,
  UpdateCircleCourseLessonInput,
} from "../types/circle";
import { StorageService } from "./storage.service";

/**
 * Courses Service
 *
 * Handles business logic for all courses — both circle-linked and standalone.
 * `circle_id` is nullable after the 20260420_standalone_courses migration:
 *   - circle-linked courses:  circle_id IS NOT NULL, access gated via circle plan membership
 *   - standalone courses:     circle_id IS NULL,     access_type in ('free', 'paid')
 */
export class CoursesService {
  private storageService: StorageService;

  constructor(private supabase: SupabaseClient) {
    this.storageService = new StorageService(supabase);
  }

  // ==========================================================================
  // COURSES
  // ==========================================================================

  /**
   * List courses.
   * Pass `circleId` to fetch courses for a specific circle.
   * Pass `businessId` (with circleId omitted) to fetch standalone courses only.
   */
  async getCourses(
    options: { circleId?: string; businessId?: string },
    userId?: string,
  ): Promise<CircleCourse[]> {
    let query = this.supabase
      .from("courses")
      .select("*")
      .order("created_at", { ascending: false });

    if (options.circleId) {
      query = query.eq("circle_id", options.circleId);
    } else if (options.businessId) {
      // Standalone courses only (no circle association)
      query = query.eq("business_id", options.businessId).is("circle_id", null);
    } else {
      return [];
    }

    const { data: courses, error } = await query;
    if (error) throw error;
    if (!courses || courses.length === 0) return [];

    const courseIds = courses.map((c) => c.id);

    // 1. Fetch lesson IDs for all courses (counts + progress)
    const { data: allLessons } = await this.supabase
      .from("course_lessons")
      .select("id, course_id")
      .in("course_id", courseIds);

    const lessonsByCourse: Record<string, string[]> = {};
    const allLessonIds: string[] = [];
    allLessons?.forEach((l) => {
      if (!lessonsByCourse[l.course_id]) lessonsByCourse[l.course_id] = [];
      lessonsByCourse[l.course_id].push(l.id);
      allLessonIds.push(l.id);
    });

    // 2. Enrollment counts
    const { data: allEnrollments } = await this.supabase
      .from("course_enrollments")
      .select("course_id")
      .in("course_id", courseIds);

    const enrollmentCounts: Record<string, number> = {};
    allEnrollments?.forEach((e) => {
      enrollmentCounts[e.course_id] = (enrollmentCounts[e.course_id] || 0) + 1;
    });

    // 3. Per-user progress (if userId provided)
    let userEnrolledMap = new Set<string>();
    let completedLessonIds = new Set<string>();

    if (userId) {
      const [userEnrollments, userProgress] = await Promise.all([
        this.supabase
          .from("course_enrollments")
          .select("course_id")
          .eq("user_id", userId)
          .in("course_id", courseIds),
        allLessonIds.length > 0
          ? this.supabase
              .from("course_lesson_progress")
              .select("lesson_id")
              .eq("user_id", userId)
              .in("lesson_id", allLessonIds)
          : Promise.resolve({ data: [] }),
      ]);

      userEnrollments.data?.forEach((e) => userEnrolledMap.add(e.course_id));
      userProgress.data?.forEach((p) => completedLessonIds.add(p.lesson_id));
    }

    return courses.map((course) => {
      const courseLessonIds = lessonsByCourse[course.id] || [];
      const lessonCount = courseLessonIds.length;
      const completedCount = courseLessonIds.filter((id) =>
        completedLessonIds.has(id),
      ).length;

      return {
        ...course,
        lesson_count: lessonCount,
        total_lessons: lessonCount,
        enrolled_count: enrollmentCounts[course.id] || 0,
        is_enrolled: userEnrolledMap.has(course.id),
        progress_pct:
          lessonCount > 0
            ? Math.round((completedCount / lessonCount) * 100)
            : 0,
      };
    });
  }

  async getCourse(courseId: string, userId?: string): Promise<CircleCourse> {
    const { data: course, error } = await this.supabase
      .from("courses")
      .select("*, business:business_id(id, name, logo_url, slug, description)")
      .eq("id", courseId)
      .single();

    if (error) throw error;

    const modules = await this.getModulesWithLessons(courseId, userId);
    const enrolledCount = await this.getEnrolledCount(courseId);
    const enrollment = userId
      ? await this.getEnrollment(courseId, userId)
      : null;

    console.log("enrollment", courseId, userId, enrollment);
    const progress = userId
      ? await this.getUserProgress(courseId, userId)
      : null;

    console.log("progress", courseId, userId, progress);

    const totalLessons = modules.reduce(
      (sum, m) => sum + (m.lessons?.length ?? 0),
      0,
    );

    return {
      ...course,
      modules,
      total_lessons: totalLessons,
      enrolled_count: enrolledCount,
      is_enrolled: !!enrollment,
      progress_pct: progress?.pct ?? 0,
    };
  }

  /**
   * Fetch the minimal course row needed for authorization decisions.
   * Returns circle_id (may be null for standalone) and business_id.
   */
  async getCourseRaw(courseId: string): Promise<{
    id: string;
    circle_id: string | null;
    business_id: string;
  } | null> {
    const { data } = await this.supabase
      .from("courses")
      .select("id, circle_id, business_id")
      .eq("id", courseId)
      .maybeSingle();
    return data ?? null;
  }

  /**
   * Create a course.
   * Pass `circleId` for circle-linked courses (server derives business_id from the circle).
   * Pass `businessId` alone for standalone courses.
   */
  async createCourse(
    params: { circleId?: string; businessId?: string },
    data: CreateCircleCourseInput,
    creatorId: string,
  ): Promise<CircleCourse> {
    let businessId = params.businessId;

    // Derive business_id from circle when not explicitly provided
    if (!businessId && params.circleId) {
      const { data: circle } = await this.supabase
        .from("circles")
        .select("business_id")
        .eq("id", params.circleId)
        .single();
      businessId = circle?.business_id;
    }

    if (!businessId) {
      const err: any = new Error("business_id is required to create a course");
      err.statusCode = 400;
      throw err;
    }

    const insert: Record<string, unknown> = {
      ...data,
      business_id: businessId,
      created_by: creatorId,
      access_type: params.circleId
        ? "circle_membership"
        : (data.access_type ?? "free"),
    };
    if (params.circleId) insert.circle_id = params.circleId;

    const { data: course, error } = await this.supabase
      .from("courses")
      .insert([insert])
      .select()
      .single();

    if (error) throw error;
    return course;
  }

  async updateCourse(
    courseId: string,
    data: UpdateCircleCourseInput,
  ): Promise<CircleCourse> {
    const { data: course, error } = await this.supabase
      .from("courses")
      .update({ ...data, updated_at: new Date().toISOString() })
      .eq("id", courseId)
      .select()
      .single();

    if (error) throw error;
    return course;
  }

  async deleteCourse(courseId: string): Promise<void> {
    const { error } = await this.supabase
      .from("courses")
      .delete()
      .eq("id", courseId);

    if (error) throw error;
  }

  async uploadCourseImage(
    businessId: string,
    courseId: string,
    file: Express.Multer.File,
  ) {
    const fileExt = file.originalname.split(".").pop();
    const fileName = `course_${Date.now()}.${fileExt}`;
    const filePath = `courses/${businessId}/${courseId}/${fileName}`;
    return this.storageService.uploadFile("sessions", filePath, file, true);
  }

  // ==========================================================================
  // MODULES
  // ==========================================================================

  async getModulesWithLessons(
    courseId: string,
    userId?: string,
  ): Promise<CircleCourseModule[]> {
    const { data: modules, error: modError } = await this.supabase
      .from("course_modules")
      .select("*")
      .eq("course_id", courseId)
      .order("position", { ascending: true });

    if (modError) throw modError;
    if (!modules || modules.length === 0) return [];

    const { data: allLessons, error: lessonsError } = await this.supabase
      .from("course_lessons")
      .select("*")
      .eq("course_id", courseId)
      .order("position", { ascending: true });

    if (lessonsError) throw lessonsError;

    let completedLessonIds = new Set<string>();
    if (userId && allLessons && allLessons.length > 0) {
      const { data: progress } = await this.supabase
        .from("course_lesson_progress")
        .select("lesson_id")
        .eq("user_id", userId)
        .in(
          "lesson_id",
          allLessons.map((l) => l.id),
        );
      progress?.forEach((p) => completedLessonIds.add(p.lesson_id));
    }

    const lessonsByModule: Record<string, any[]> = {};
    allLessons?.forEach((l) => {
      if (!lessonsByModule[l.module_id]) lessonsByModule[l.module_id] = [];
      lessonsByModule[l.module_id].push({
        ...l,
        is_done: completedLessonIds.has(l.id),
      });
    });

    return modules.map((mod) => ({
      ...mod,
      lessons: lessonsByModule[mod.id] || [],
    }));
  }

  async createModule(
    courseId: string,
    data: CreateCircleCourseModuleInput,
  ): Promise<CircleCourseModule> {
    const position = await this.getNextModulePosition(courseId);
    const { data: mod, error } = await this.supabase
      .from("course_modules")
      .insert([{ ...data, course_id: courseId, position }])
      .select()
      .single();

    if (error) throw error;
    return mod;
  }

  async updateModule(
    moduleId: string,
    data: Partial<CreateCircleCourseModuleInput>,
  ): Promise<CircleCourseModule> {
    const { data: mod, error } = await this.supabase
      .from("course_modules")
      .update({ ...data, updated_at: new Date().toISOString() })
      .eq("id", moduleId)
      .select()
      .single();

    if (error) throw error;
    return mod;
  }

  async deleteModule(moduleId: string): Promise<void> {
    const { error } = await this.supabase
      .from("course_modules")
      .delete()
      .eq("id", moduleId);

    if (error) throw error;
  }

  async reorderModules(courseId: string, orderedIds: string[]): Promise<void> {
    await Promise.all(
      orderedIds.map((id, index) =>
        this.supabase
          .from("course_modules")
          .update({ position: index })
          .eq("id", id)
          .eq("course_id", courseId),
      ),
    );
  }

  // ==========================================================================
  // LESSONS
  // ==========================================================================

  async createLesson(
    moduleId: string,
    courseId: string,
    data: CreateCircleCourseLessonInput,
  ): Promise<CircleCourseLesson> {
    const position = await this.getNextLessonPosition(moduleId);
    const { data: lesson, error } = await this.supabase
      .from("course_lessons")
      .insert([{ ...data, module_id: moduleId, course_id: courseId, position }])
      .select()
      .single();

    if (error) throw error;
    return lesson;
  }

  async updateLesson(
    lessonId: string,
    data: UpdateCircleCourseLessonInput,
  ): Promise<CircleCourseLesson> {
    const { data: lesson, error } = await this.supabase
      .from("course_lessons")
      .update({ ...data, updated_at: new Date().toISOString() })
      .eq("id", lessonId)
      .select()
      .single();

    if (error) throw error;
    return lesson;
  }

  async deleteLesson(lessonId: string): Promise<void> {
    const { error } = await this.supabase
      .from("course_lessons")
      .delete()
      .eq("id", lessonId);

    if (error) throw error;
  }

  // ==========================================================================
  // ENROLLMENT & PROGRESS
  // ==========================================================================

  async enrollUser(courseId: string, userId: string): Promise<void> {
    const { data: course } = await this.supabase
      .from("courses")
      .select("plan_ids, circle_id, access_type")
      .eq("id", courseId)
      .single();

    // Standalone paid courses require a purchase — direct free enrollment is not allowed
    if (!course?.circle_id && course?.access_type === "paid") {
      const err: any = new Error(
        "This is a paid course. Please purchase access before enrolling.",
      );
      err.statusCode = 403;
      throw err;
    }

    // Plan-gate only applies to circle-linked courses
    if (course?.circle_id && course?.plan_ids && course.plan_ids.length > 0) {
      const { data: sub } = await this.supabase
        .from("circle_subscriptions")
        .select("id, plan_id")
        .eq("circle_id", course.circle_id)
        .eq("user_id", userId)
        .eq("status", "active")
        .in("plan_id", course.plan_ids)
        .maybeSingle();

      if (!sub) {
        const err: any = new Error(
          "Your current plan does not include access to this course.",
        );
        err.statusCode = 403;
        throw err;
      }
    }

    const { error } = await this.supabase
      .from("course_enrollments")
      .upsert([{ course_id: courseId, user_id: userId }], {
        onConflict: "course_id,user_id",
      });

    if (error) throw error;
  }

  async getEnrollments(courseId: string): Promise<CourseEnrollment[]> {
    const { data, error } = await this.supabase
      .from("course_enrollments")
      .select(
        "user_id, enrolled_at, users:user_id(id, name, email, avatar_url)",
      )
      .eq("course_id", courseId)
      .order("enrolled_at", { ascending: false });

    if (error) throw error;
    if (!data) return [];

    return data.map((row: any) => ({
      user_id: row.user_id,
      enrolled_at: row.enrolled_at,
      user: row.users ?? undefined,
    }));
  }

  async unenrollUser(courseId: string, userId: string): Promise<void> {
    const { error } = await this.supabase
      .from("course_enrollments")
      .delete()
      .eq("course_id", courseId)
      .eq("user_id", userId);

    if (error) throw error;
  }

  async markLessonComplete(lessonId: string, userId: string): Promise<void> {
    const { error } = await this.supabase
      .from("course_lesson_progress")
      .upsert([{ lesson_id: lessonId, user_id: userId }], {
        onConflict: "lesson_id,user_id",
      });

    if (error) throw error;
  }

  async unmarkLessonComplete(lessonId: string, userId: string): Promise<void> {
    const { error } = await this.supabase
      .from("course_lesson_progress")
      .delete()
      .eq("lesson_id", lessonId)
      .eq("user_id", userId);

    if (error) throw error;
  }

  async getUserProgress(
    courseId: string,
    userId: string,
  ): Promise<CircleCourseProgress> {
    const { data: courseLessons, error: lessonsError } = await this.supabase
      .from("course_lessons")
      .select("id")
      .eq("course_id", courseId);

    if (lessonsError) throw lessonsError;

    const lessonIds = (courseLessons ?? []).map((l) => l.id);
    const total = lessonIds.length;

    if (total === 0) {
      return {
        completed_lessons: 0,
        completed_count: 0,
        total_lessons: 0,
        total_count: 0,
        completed_lesson_ids: [],
        pct: 0,
      };
    }

    const { data: completedRows, error: progressError } = await this.supabase
      .from("course_lesson_progress")
      .select("lesson_id")
      .eq("user_id", userId)
      .in("lesson_id", lessonIds);

    if (progressError) throw progressError;

    const completedIds = (completedRows ?? []).map(
      (r: any) => r.lesson_id as string,
    );
    const completed = completedIds.length;

    return {
      completed_lessons: completed,
      completed_count: completed,
      total_lessons: total,
      total_count: total,
      completed_lesson_ids: completedIds,
      pct: Math.round((completed / total) * 100),
    };
  }

  // ==========================================================================
  // CERTIFICATES
  // ==========================================================================

  /**
   * Issue a certificate for a user who has completed all lessons in a course.
   * Safe to call multiple times — upserts on (user_id, course_id).
   */
  async issueCertificate(
    courseId: string,
    userId: string,
  ): Promise<CourseCertificate> {
    // Fetch course + business name for denormalisation
    const { data: course, error: courseError } = await this.supabase
      .from("courses")
      .select("title, business:business_id(name)")
      .eq("id", courseId)
      .single();

    if (courseError) throw courseError;

    // Fetch user display name
    const { data: profile } = await this.supabase
      .from("users")
      .select("name, email")
      .eq("id", userId)
      .single();

    const businessName =
      (course.business as { name?: string } | null)?.name ?? null;
    const recipientName =
      (profile?.name as string | undefined) ??
      (profile?.email as string | undefined) ??
      null;

    const { data, error } = await this.supabase
      .from("course_certificates")
      .upsert(
        [
          {
            user_id: userId,
            course_id: courseId,
            course_title: course.title as string,
            business_name: businessName,
            recipient_name: recipientName,
          },
        ],
        { onConflict: "user_id,course_id" },
      )
      .select()
      .single();

    if (error) throw error;
    return data as CourseCertificate;
  }

  /**
   * Return all courses a user is currently enrolled in, with progress and
   * certificate status, across all businesses/circles.
   */
  async getEnrolledCourses(userId: string): Promise<CircleCourse[]> {
    // 1. Fetch enrollment records for this user
    const { data: enrollments, error: enrollErr } = await this.supabase
      .from("course_enrollments")
      .select("course_id")
      .eq("user_id", userId);

    if (enrollErr) throw enrollErr;
    if (!enrollments || enrollments.length === 0) return [];

    const courseIds = enrollments.map((e) => e.course_id);

    // 2. Fetch the courses themselves
    const { data: courses, error: coursesErr } = await this.supabase
      .from("courses")
      .select("*")
      .in("id", courseIds)
      .order("created_at", { ascending: false });

    if (coursesErr) throw coursesErr;
    if (!courses || courses.length === 0) return [];

    // 3. Lesson counts per course
    const { data: allLessons } = await this.supabase
      .from("course_lessons")
      .select("id, course_id")
      .in("course_id", courseIds);

    const lessonsByCourse: Record<string, string[]> = {};
    const allLessonIds: string[] = [];
    allLessons?.forEach((l) => {
      if (!lessonsByCourse[l.course_id]) lessonsByCourse[l.course_id] = [];
      lessonsByCourse[l.course_id].push(l.id);
      allLessonIds.push(l.id);
    });

    // 4. User lesson progress
    const { data: progress } = allLessonIds.length > 0
      ? await this.supabase
          .from("course_lesson_progress")
          .select("lesson_id")
          .eq("user_id", userId)
          .in("lesson_id", allLessonIds)
      : { data: [] };

    const completedIds = new Set((progress ?? []).map((p) => p.lesson_id));

    // 5. Certificates
    const { data: certs } = await this.supabase
      .from("course_certificates")
      .select("course_id")
      .eq("user_id", userId)
      .in("course_id", courseIds);

    const certSet = new Set((certs ?? []).map((c) => c.course_id));

    return courses.map((course) => {
      const lessonIds = lessonsByCourse[course.id] ?? [];
      const total = lessonIds.length;
      const completed = lessonIds.filter((id) => completedIds.has(id)).length;

      return {
        ...course,
        lesson_count: total,
        total_lessons: total,
        is_enrolled: true,
        progress_pct: total > 0 ? Math.round((completed / total) * 100) : 0,
        has_certificate: certSet.has(course.id),
      };
    });
  }

  /** Get a user's certificate for a specific course (returns null if not issued). */
  async getCertificateForUser(
    courseId: string,
    userId: string,
  ): Promise<CourseCertificate | null> {
    const { data, error } = await this.supabase
      .from("course_certificates")
      .select("*")
      .eq("course_id", courseId)
      .eq("user_id", userId)
      .maybeSingle();

    if (error) throw error;
    return data as CourseCertificate | null;
  }

  /** Public certificate lookup by certificate ID — for verification pages.
   *  Uses the service-role client so RLS (owner-only SELECT) doesn't block
   *  third-party viewers verifying someone else's certificate. */
  async getPublicCertificate(
    certificateId: string,
  ): Promise<CourseCertificate | null> {
    const client = supabaseAdmin ?? this.supabase;
    const { data, error } = await client
      .from("course_certificates")
      .select("*")
      .eq("id", certificateId)
      .maybeSingle();

    if (error) throw error;
    return data as CourseCertificate | null;
  }

  // ==========================================================================
  // PRIVATE HELPERS
  // ==========================================================================

  private async getEnrolledCount(courseId: string): Promise<number> {
    const { count } = await this.supabase
      .from("course_enrollments")
      .select("id", { count: "exact", head: true })
      .eq("course_id", courseId);
    return count ?? 0;
  }

  private async getEnrollment(courseId: string, userId: string) {
    const { data } = await this.supabase
      .from("course_enrollments")
      .select("id")
      .eq("course_id", courseId)
      .eq("user_id", userId)
      .maybeSingle();
    return data;
  }

  private async getNextModulePosition(courseId: string): Promise<number> {
    const { count } = await this.supabase
      .from("course_modules")
      .select("id", { count: "exact", head: true })
      .eq("course_id", courseId);
    return count ?? 0;
  }

  private async getNextLessonPosition(moduleId: string): Promise<number> {
    const { count } = await this.supabase
      .from("course_lessons")
      .select("id", { count: "exact", head: true })
      .eq("module_id", moduleId);
    return count ?? 0;
  }
}
