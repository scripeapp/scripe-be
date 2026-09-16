/**
 * Courses Controller
 *
 * Unified controller for all course operations at /api/courses.
 * Handles both circle-linked courses and standalone courses.
 *
 * Auth strategy (verifyCourseAdmin):
 *   - circle-linked: caller must be circle creator or have role = 'facilitator'
 *   - standalone:    caller must be the business owner
 */

import { Response } from "express";
import { SupabaseRequest } from "../types/http";
import { CoursesService } from "../services/courses.service";
import { PaymentProviderFactory, SUPPORTED_CURRENCIES } from "../utils/payment";
import type { SupportedCurrency } from "../utils/payment";
import {
  deriveFlutterwaveCommissionShare,
  resolvePaymentProvider,
} from "../utils/payment/fees";
import { resolvePaymentAmount } from "../utils/currency-rates.util";
import { createTransactionReference, REFERENCE_TYPES } from "../utils/references";

// =============================================================================
// HELPERS
// =============================================================================

function handleError(res: Response, error: unknown, context: string) {
  const err = error as { statusCode?: number; message?: string };
  const statusCode = err.statusCode ?? 500;
  const message = err.message ?? "Internal server error";
  console.error(`[CoursesController.${context}]`, error);
  return res.status(statusCode).json({ success: false, error: message });
}

/**
 * Authorise a mutation on a course.
 *
 * Looks up the course record to determine whether it is circle-linked or
 * standalone, then applies the appropriate ownership check.
 *
 * Returns true if the caller is allowed to mutate the course.
 */
async function verifyCourseAdmin(
  supabase: SupabaseRequest["supabase"],
  courseId: string,
  userId: string,
): Promise<boolean> {
  const service = new CoursesService(supabase);
  const course = await service.getCourseRaw(courseId);

  if (!course) return false;

  // --- Circle-linked course ---
  if (course.circle_id) {
    // Check membership role first
    const { data: member } = await supabase
      .from("circle_members")
      .select("role")
      .eq("circle_id", course.circle_id)
      .eq("user_id", userId)
      .maybeSingle();

    if (member?.role === "facilitator") return true;

    // Fall back to circle creator
    const { data: circle } = await supabase
      .from("circles")
      .select("creator_id")
      .eq("id", course.circle_id)
      .maybeSingle();

    return circle?.creator_id === userId;
  }

  // --- Standalone course ---
  const { data: business } = await supabase
    .from("businesses")
    .select("owner_user_id")
    .eq("id", course.business_id)
    .maybeSingle();

  return business?.owner_user_id === userId;
}

// =============================================================================
// COURSES
// =============================================================================

/**
 * GET /api/courses
 * Query params: circle_id OR business_id (one required)
 */
export async function getCourses(req: SupabaseRequest, res: Response) {
  try {
    const userId = req.user_id;
    const circleId = req.query.circle_id as string | undefined;
    const businessId = req.query.business_id as string | undefined;

    if (!circleId && !businessId) {
      return res.status(400).json({
        success: false,
        error: "circle_id or business_id is required",
      });
    }

    // Accept slug as well as UUID — resolve slug to UUID before querying
    let resolvedCircleId = circleId;
    if (
      circleId &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        circleId,
      )
    ) {
      const { data: circle } = await req.supabase
        .from("circles")
        .select("id")
        .eq("slug", circleId)
        .is("deleted_at", null)
        .maybeSingle();
      if (!circle) {
        return res
          .status(404)
          .json({ success: false, error: "Circle not found" });
      }
      resolvedCircleId = circle.id;
    }

    const service = new CoursesService(req.supabase);
    const courses = await service.getCourses(
      { circleId: resolvedCircleId, businessId },
      userId,
    );
    return res.json({ success: true, data: courses });
  } catch (error) {
    return handleError(res, error, "getCourses");
  }
}

/**
 * GET /api/courses/:courseId
 */
export async function getCourse(req: SupabaseRequest, res: Response) {
  try {
    const { courseId } = req.params;
    const userId = req.user_id;
    const service = new CoursesService(req.supabase);
    const course = await service.getCourse(courseId, userId);
    return res.json({ success: true, data: course });
  } catch (error) {
    return handleError(res, error, "getCourse");
  }
}

/**
 * POST /api/courses
 * Body: { circle_id?, business_id?, ...courseFields }
 */
export async function createCourse(req: SupabaseRequest, res: Response) {
  try {
    const userId = req.user_id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const { circle_id: circleId, business_id: businessId, ...data } = req.body;

    if (!circleId && !businessId) {
      return res.status(400).json({
        success: false,
        error: "circle_id or business_id is required",
      });
    }

    // For circle-linked courses, verify admin via circle; for standalone use business_id check
    if (circleId) {
      // Inline check: must be circle creator or facilitator
      const { data: member } = await req.supabase
        .from("circle_members")
        .select("role")
        .eq("circle_id", circleId)
        .eq("user_id", userId)
        .maybeSingle();

      const isFacilitator = member?.role === "facilitator";

      if (!isFacilitator) {
        const { data: circle } = await req.supabase
          .from("circles")
          .select("creator_id")
          .eq("id", circleId)
          .maybeSingle();
        if (circle?.creator_id !== userId) {
          return res.status(403).json({ success: false, error: "Forbidden" });
        }
      }
    } else {
      // Standalone: verify business ownership
      const { data: business } = await req.supabase
        .from("businesses")
        .select("owner_user_id")
        .eq("id", businessId)
        .maybeSingle();
      if (business?.owner_user_id !== userId) {
        return res.status(403).json({ success: false, error: "Forbidden" });
      }
    }

    const service = new CoursesService(req.supabase);
    const course = await service.createCourse(
      { circleId, businessId },
      data,
      userId,
    );
    return res.status(201).json({ success: true, data: course });
  } catch (error) {
    return handleError(res, error, "createCourse");
  }
}

/**
 * PATCH /api/courses/:courseId
 */
export async function updateCourse(req: SupabaseRequest, res: Response) {
  try {
    const { courseId } = req.params;
    const userId = req.user_id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const isAdmin = await verifyCourseAdmin(req.supabase, courseId, userId);
    if (!isAdmin) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    const service = new CoursesService(req.supabase);
    const course = await service.updateCourse(courseId, req.body);
    return res.json({ success: true, data: course });
  } catch (error) {
    return handleError(res, error, "updateCourse");
  }
}

/**
 * DELETE /api/courses/:courseId
 */
export async function deleteCourse(req: SupabaseRequest, res: Response) {
  try {
    const { courseId } = req.params;
    const userId = req.user_id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const isAdmin = await verifyCourseAdmin(req.supabase, courseId, userId);
    if (!isAdmin) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    const service = new CoursesService(req.supabase);
    await service.deleteCourse(courseId);
    return res.json({ success: true });
  } catch (error) {
    return handleError(res, error, "deleteCourse");
  }
}

/**
 * POST /api/courses/:courseId/upload-image
 */
export async function uploadCourseImage(req: SupabaseRequest, res: Response) {
  try {
    const { courseId } = req.params;
    const userId = req.user_id;

    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, error: "No file uploaded" });
    }
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const isAdmin = await verifyCourseAdmin(req.supabase, courseId, userId);
    if (!isAdmin) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    // business_id can come from body or be resolved from the course
    const service = new CoursesService(req.supabase);
    const raw = await service.getCourseRaw(courseId);
    if (!raw) {
      return res
        .status(404)
        .json({ success: false, error: "Course not found" });
    }

    if (!raw.business_id) {
      return res.status(422).json({
        success: false,
        error:
          "Course has no associated business — run the standalone courses migration first",
      });
    }

    const result = await service.uploadCourseImage(
      raw.business_id,
      courseId,
      req.file,
    );
    return res.json({ success: true, data: result });
  } catch (error) {
    return handleError(res, error, "uploadCourseImage");
  }
}

// =============================================================================
// ENROLLMENTS
// =============================================================================

/**
 * GET /api/courses/:courseId/enrollments
 */
export async function getCourseEnrollments(
  req: SupabaseRequest,
  res: Response,
) {
  try {
    const { courseId } = req.params;
    const userId = req.user_id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const isAdmin = await verifyCourseAdmin(req.supabase, courseId, userId);
    if (!isAdmin) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    const service = new CoursesService(req.supabase);
    const enrollments = await service.getEnrollments(courseId);
    return res.json({ success: true, data: enrollments });
  } catch (error) {
    return handleError(res, error, "getCourseEnrollments");
  }
}

/**
 * POST /api/courses/:courseId/enroll
 */
export async function enrollCourse(req: SupabaseRequest, res: Response) {
  try {
    const { courseId } = req.params;
    const userId = req.user_id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const service = new CoursesService(req.supabase);
    await service.enrollUser(courseId, userId);
    return res.json({ success: true });
  } catch (error) {
    return handleError(res, error, "enrollCourse");
  }
}

/**
 * DELETE /api/courses/:courseId/enroll
 */
export async function unenrollCourse(req: SupabaseRequest, res: Response) {
  try {
    const { courseId } = req.params;
    const userId = req.user_id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const service = new CoursesService(req.supabase);
    await service.unenrollUser(courseId, userId);
    return res.json({ success: true });
  } catch (error) {
    return handleError(res, error, "unenrollCourse");
  }
}

// =============================================================================
// COURSE CHECKOUT (paid courses — Paystack)
// =============================================================================

/**
 * POST /api/courses/:courseId/checkout/initiate
 * Authenticated. Creates a Paystack transaction for a paid course purchase.
 * Enrollment is handled by the webhook after payment confirmation.
 */
export async function initiateCourseCheckout(
  req: SupabaseRequest,
  res: Response,
) {
  try {
    const { courseId } = req.params;
    const userId = req.user_id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const { email, name, callback_url, currency: bodyCurrency } = req.body as {
      email: string;
      name: string;
      callback_url?: string;
      currency?: string;
    };

    if (!email || !name) {
      return res
        .status(400)
        .json({ success: false, error: "email and name are required" });
    }

    const service = new CoursesService(req.supabase);
    const course = await service.getCourse(courseId, userId);

    if (!course) {
      return res
        .status(404)
        .json({ success: false, error: "Course not found" });
    }
    if (course.access_type !== "paid" || !course.price) {
      return res.status(400).json({
        success: false,
        error: "This course is free — use the enroll endpoint directly",
      });
    }
    if (course.is_enrolled) {
      return res
        .status(409)
        .json({ success: false, error: "Already enrolled in this course" });
    }

    // Currency: prefer request body → stored course currency → NGN
    const rawCurrency = bodyCurrency || course.payment_currency || "NGN";
    const courseCurrency: SupportedCurrency = (SUPPORTED_CURRENCIES as readonly string[]).includes(rawCurrency)
      ? (rawCurrency as SupportedCurrency)
      : "NGN";

    // ── Platform fee split ────────────────────────────────────────────────────
    // COURSE_SALE_FEE_PERCENT is the TOTAL cost to the creator (Hilaq + provider).
    // Student pays exactly the listed price. Creator nets (100 - feePercent)%.
    const feePercent = parseFloat(process.env.COURSE_SALE_FEE_PERCENT || "10");
    const coursePrice = Number(course.price);

    // Fetch the business subaccount for both Paystack and Flutterwave splits
    let subaccountCode: string | undefined;
    let flwSubaccountId: string | undefined;
    if (course.business_id) {
      const { data: biz } = await req.supabase
        .from("businesses")
        .select("paystack_subaccount_code, flw_subaccount_id")
        .eq("id", course.business_id)
        .single();
      subaccountCode = biz?.paystack_subaccount_code ?? undefined;
      flwSubaccountId = biz?.flw_subaccount_id ?? undefined;
    }

    if (courseCurrency !== "NGN" && !flwSubaccountId) {
      return res.status(422).json({
        success: false,
        error: "This creator has not set up multi-currency payments yet.",
      });
    }

    // Convert base NGN price to buyer's chosen currency using live FLW rates
    const chargeAmount = await resolvePaymentAmount(coursePrice, courseCurrency);
    const totalFee = chargeAmount * (feePercent / 100);

    // For Paystack (NGN): transactionCharge = totalFee - paystackFee so creator nets exactly 90%.
    // For Flutterwave: transactionCharge is ignored; flwMerchantAmount handles the split instead.
    let transactionCharge: number | undefined;
    if (courseCurrency === "NGN") {
      const paystackFee = Math.min(chargeAmount * 0.015 + (chargeAmount >= 2500 ? 100 : 0), 2000);
      const platformFee = Math.max(Number((totalFee - paystackFee).toFixed(2)), 0);
      transactionCharge = Math.round(platformFee * 100);
    }
    const flwMerchantAmount = deriveFlutterwaveCommissionShare({
      chargeAmount,
      merchantPercent: 100 - feePercent,
      currency: courseCurrency,
    });

    const courseProvider = PaymentProviderFactory.getProvider(courseCurrency);

    const mainDomain =
      process.env.NEXT_PUBLIC_CLIENT_BASE_URL || "https://www.hilaq.com";
    const callbackUrl = callback_url || `${mainDomain}/order-success`;
    const reference = createTransactionReference(REFERENCE_TYPES.ORDER);

    const result = await courseProvider.initializePayment({
      amount: chargeAmount,
      email,
      currency: courseCurrency,
      reference,
      callbackUrl,
      subaccountCode,
      bearer: "subaccount",
      transactionCharge,
      flwSubaccountId,
      flwMerchantAmount,
      metadata: {
        store_id: course.business_id ?? "",
        customer_name: name,
        transaction_type: "course_purchase" as any,
        platform_fee: totalFee,
        items: [{ product_id: courseId, product_name: course.title, quantity: 1, price: coursePrice }],
        course_id: courseId,
        user_id: userId,
        customer_email: email,
        currency: courseCurrency,
        payment_provider: resolvePaymentProvider(courseCurrency),
      } as any,
    });

    return res.json({ success: true, data: result });
  } catch (error) {
    return handleError(res, error, "initiateCourseCheckout");
  }
}

// =============================================================================
// PROGRESS
// =============================================================================

/**
 * GET /api/courses/:courseId/progress
 */
export async function getCourseProgress(req: SupabaseRequest, res: Response) {
  try {
    const { courseId } = req.params;
    const userId = req.user_id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const service = new CoursesService(req.supabase);
    const progress = await service.getUserProgress(courseId, userId);
    return res.json({ success: true, data: progress });
  } catch (error) {
    return handleError(res, error, "getCourseProgress");
  }
}

/**
 * POST /api/courses/:courseId/lessons/:lessonId/complete
 * Marks a lesson complete and auto-issues a certificate if the course is now 100% done.
 */
export async function markLessonComplete(req: SupabaseRequest, res: Response) {
  try {
    const { courseId, lessonId } = req.params;
    const userId = req.user_id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const service = new CoursesService(req.supabase);
    await service.markLessonComplete(lessonId, userId);

    // Check if the course is now complete and issue a certificate
    const progress = await service.getUserProgress(courseId, userId);
    if (progress.pct === 100 && progress.total_lessons > 0) {
      const certificate = await service.issueCertificate(courseId, userId);
      return res.json({ success: true, data: { certificate } });
    }

    return res.json({ success: true, data: { certificate: null } });
  } catch (error) {
    return handleError(res, error, "markLessonComplete");
  }
}

/**
 * GET /api/courses/my
 * Returns all courses the authenticated user is enrolled in, with progress.
 */
export async function getMyEnrolledCourses(
  req: SupabaseRequest,
  res: Response,
) {
  try {
    const userId = req.user_id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    const service = new CoursesService(req.supabase);
    const courses = await service.getEnrolledCourses(userId);
    return res.json({ success: true, data: courses });
  } catch (error) {
    return handleError(res, error, "getMyEnrolledCourses");
  }
}

/**
 * GET /api/courses/:courseId/certificate
 * Returns the authenticated user's certificate for this course (null if not issued yet).
 */
export async function getCourseCertificate(
  req: SupabaseRequest,
  res: Response,
) {
  try {
    const { courseId } = req.params;
    const userId = req.user_id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const service = new CoursesService(req.supabase);
    const certificate = await service.getCertificateForUser(courseId, userId);
    return res.json({ success: true, data: certificate });
  } catch (error) {
    return handleError(res, error, "getCourseCertificate");
  }
}

/**
 * GET /api/certificates/:certificateId
 * Public verification endpoint — no auth required.
 */
export async function getPublicCertificate(
  req: SupabaseRequest,
  res: Response,
) {
  try {
    const { certificateId } = req.params;
    const service = new CoursesService(req.supabase);
    const certificate = await service.getPublicCertificate(certificateId);
    if (!certificate) {
      return res
        .status(404)
        .json({ success: false, error: "Certificate not found" });
    }
    return res.json({ success: true, data: certificate });
  } catch (error) {
    return handleError(res, error, "getPublicCertificate");
  }
}

/**
 * DELETE /api/courses/:courseId/lessons/:lessonId/complete
 */
export async function unmarkLessonComplete(
  req: SupabaseRequest,
  res: Response,
) {
  try {
    const { lessonId } = req.params;
    const userId = req.user_id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const service = new CoursesService(req.supabase);
    await service.unmarkLessonComplete(lessonId, userId);
    return res.json({ success: true });
  } catch (error) {
    return handleError(res, error, "unmarkLessonComplete");
  }
}

// =============================================================================
// MODULES
// =============================================================================

/**
 * POST /api/courses/:courseId/modules
 */
export async function createModule(req: SupabaseRequest, res: Response) {
  try {
    const { courseId } = req.params;
    const userId = req.user_id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const isAdmin = await verifyCourseAdmin(req.supabase, courseId, userId);
    if (!isAdmin) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    const service = new CoursesService(req.supabase);
    const mod = await service.createModule(courseId, req.body);
    return res.status(201).json({ success: true, data: mod });
  } catch (error) {
    return handleError(res, error, "createModule");
  }
}

/**
 * PATCH /api/courses/:courseId/modules/reorder
 */
export async function reorderModules(req: SupabaseRequest, res: Response) {
  try {
    const { courseId } = req.params;
    const userId = req.user_id;
    const { orderedIds } = req.body;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const isAdmin = await verifyCourseAdmin(req.supabase, courseId, userId);
    if (!isAdmin) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    const service = new CoursesService(req.supabase);
    await service.reorderModules(courseId, orderedIds);
    return res.json({ success: true });
  } catch (error) {
    return handleError(res, error, "reorderModules");
  }
}

/**
 * PATCH /api/courses/:courseId/modules/:moduleId
 */
export async function updateModule(req: SupabaseRequest, res: Response) {
  try {
    const { courseId, moduleId } = req.params;
    const userId = req.user_id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const isAdmin = await verifyCourseAdmin(req.supabase, courseId, userId);
    if (!isAdmin) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    const service = new CoursesService(req.supabase);
    const mod = await service.updateModule(moduleId, req.body);
    return res.json({ success: true, data: mod });
  } catch (error) {
    return handleError(res, error, "updateModule");
  }
}

/**
 * DELETE /api/courses/:courseId/modules/:moduleId
 */
export async function deleteModule(req: SupabaseRequest, res: Response) {
  try {
    const { courseId, moduleId } = req.params;
    const userId = req.user_id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const isAdmin = await verifyCourseAdmin(req.supabase, courseId, userId);
    if (!isAdmin) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    const service = new CoursesService(req.supabase);
    await service.deleteModule(moduleId);
    return res.json({ success: true });
  } catch (error) {
    return handleError(res, error, "deleteModule");
  }
}

// =============================================================================
// LESSONS
// =============================================================================

/**
 * POST /api/courses/:courseId/modules/:moduleId/lessons
 */
export async function createLesson(req: SupabaseRequest, res: Response) {
  try {
    const { courseId, moduleId } = req.params;
    const userId = req.user_id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const isAdmin = await verifyCourseAdmin(req.supabase, courseId, userId);
    if (!isAdmin) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    const service = new CoursesService(req.supabase);
    const lesson = await service.createLesson(moduleId, courseId, req.body);
    return res.status(201).json({ success: true, data: lesson });
  } catch (error) {
    return handleError(res, error, "createLesson");
  }
}

/**
 * PATCH /api/courses/:courseId/lessons/:lessonId
 */
export async function updateLesson(req: SupabaseRequest, res: Response) {
  try {
    const { courseId, lessonId } = req.params;
    const userId = req.user_id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const isAdmin = await verifyCourseAdmin(req.supabase, courseId, userId);
    if (!isAdmin) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    const service = new CoursesService(req.supabase);
    const lesson = await service.updateLesson(lessonId, req.body);
    return res.json({ success: true, data: lesson });
  } catch (error) {
    return handleError(res, error, "updateLesson");
  }
}

/**
 * DELETE /api/courses/:courseId/lessons/:lessonId
 */
export async function deleteLesson(req: SupabaseRequest, res: Response) {
  try {
    const { courseId, lessonId } = req.params;
    const userId = req.user_id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const isAdmin = await verifyCourseAdmin(req.supabase, courseId, userId);
    if (!isAdmin) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    const service = new CoursesService(req.supabase);
    await service.deleteLesson(lessonId);
    return res.json({ success: true });
  } catch (error) {
    return handleError(res, error, "deleteLesson");
  }
}
