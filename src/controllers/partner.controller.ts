/**
 * Partner Controller
 * HTTP handlers for the Partner Referral Program
 */

import { Request, Response } from "express";
import { PartnerService } from "../services/partner.service";
import { SupabaseRequest } from "../types/http";
import { supabaseAdmin } from "../config/supabase";
import supabase from "../config/supabase";

// =============================================================================
// Helper
// =============================================================================

function handleError(res: Response, error: any, context: string) {
  console.error(`[PartnerController] ${context}:`, error);

  if (error.code === "23505") {
    return res.status(409).json({
      success: false,
      error: "This user is already a partner",
    });
  }

  return res.status(500).json({
    success: false,
    error: error.message || "Internal Server Error",
  });
}

// =============================================================================
// Admin Endpoints
// =============================================================================

/**
 * @desc Add a new partner (admin only)
 * @route POST /api/partners
 */
export async function addPartner(req: SupabaseRequest, res: Response) {
  try {
    const { email, commission_type, commission_value, notes, send_email } =
      req.body;

    console.log("[PartnerController] addPartner payload:", {
      email,
      send_email,
    });

    if (!email) {
      return res
        .status(400)
        .json({ success: false, error: "email is required" });
    }

    // Lookup user by email
    const { data: user, error: userError } = await supabaseAdmin
      .from("users") // View on auth.users
      .select("id")
      .eq("email", email)
      .single();

    if (userError || !user) {
      // Try auth.users directly if public.users view fails/doesn't exist
      // Note: direct access to auth schema usually requires service role (which we have)
      // but client libraries shadow it. Best to rely on our public.users view/table.
      return res.status(404).json({ success: false, error: "User not found" });
    }

    const user_id = user.id;

    const service = new PartnerService(req.supabase);
    const partner = await service.addPartner(
      user_id,
      commission_type,
      commission_value,
      notes,
    );

    // Optionally send onboarding email
    if (send_email !== false) {
      try {
        await service.sendOnboardingEmail(partner);
      } catch (emailErr) {
        console.error("[PartnerController] Onboarding email failed:", emailErr);
      }
    }

    return res.status(201).json({ success: true, data: partner });
  } catch (error: any) {
    return handleError(res, error, "addPartner");
  }
}

/**
 * @desc Update partner status (admin only)
 * @route PATCH /api/partners/:id/status
 */
export async function updatePartnerStatus(req: SupabaseRequest, res: Response) {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!["active", "suspended", "inactive"].includes(status)) {
      return res.status(400).json({
        success: false,
        error: "Invalid status. Must be: active, suspended, or inactive",
      });
    }

    const service = new PartnerService(req.supabase);
    const partner = await service.updatePartnerStatus(id, status);

    return res.json({ success: true, data: partner });
  } catch (error: any) {
    return handleError(res, error, "updatePartnerStatus");
  }
}

/**
 * @desc List all partners (admin only)
 * @route GET /api/partners/all
 */
export async function listAllPartners(req: SupabaseRequest, res: Response) {
  try {
    const { page = "1", limit = "20" } = req.query as any;

    const service = new PartnerService(req.supabase);
    const { partners, total } = await service.listAllPartners(
      parseInt(page),
      parseInt(limit),
    );

    return res.json({
      success: true,
      data: partners,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error: any) {
    return handleError(res, error, "listAllPartners");
  }
}

// =============================================================================
// Partner Endpoints
// =============================================================================

/**
 * @desc Get my partner profile
 * @route GET /api/partners/me
 */
export async function getMyPartnerProfile(req: SupabaseRequest, res: Response) {
  try {
    const userId = req.user_id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const service = new PartnerService(req.supabase);
    const partner = await service.getPartnerByUserId(userId);

    if (!partner) {
      return res.status(404).json({
        success: false,
        error: "You are not a partner",
      });
    }

    return res.json({ success: true, data: partner });
  } catch (error: any) {
    return handleError(res, error, "getMyPartnerProfile");
  }
}

/**
 * @desc Check if current user is a partner
 * @route GET /api/partners/check
 */
export async function checkPartnerStatus(req: SupabaseRequest, res: Response) {
  try {
    const userId = req.user_id;
    if (!userId) {
      return res.json({ success: true, data: { is_partner: false } });
    }

    const service = new PartnerService(req.supabase);
    const isPartner = await service.isPartner(userId);

    return res.json({ success: true, data: { is_partner: isPartner } });
  } catch (error: any) {
    return handleError(res, error, "checkPartnerStatus");
  }
}

/**
 * @desc Get partner dashboard
 * @route GET /api/partners/me/dashboard
 */
export async function getPartnerDashboard(req: SupabaseRequest, res: Response) {
  try {
    const userId = req.user_id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const service = new PartnerService(req.supabase);
    const partner = await service.getPartnerByUserId(userId);
    if (!partner) {
      return res.status(404).json({ success: false, error: "Not a partner" });
    }

    const dashboard = await service.getPartnerDashboard(partner.id);
    return res.json({ success: true, data: dashboard });
  } catch (error: any) {
    return handleError(res, error, "getPartnerDashboard");
  }
}

/**
 * @desc Get downline (referred users)
 * @route GET /api/partners/me/downline
 */
export async function getDownline(req: SupabaseRequest, res: Response) {
  try {
    const userId = req.user_id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const { page = "1", limit = "20" } = req.query as any;

    const service = new PartnerService(req.supabase);
    const partner = await service.getPartnerByUserId(userId);
    if (!partner) {
      return res.status(404).json({ success: false, error: "Not a partner" });
    }

    const { referrals, total } = await service.getDownline(
      partner.id,
      parseInt(page),
      parseInt(limit),
    );

    return res.json({
      success: true,
      data: referrals,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error: any) {
    return handleError(res, error, "getDownline");
  }
}

/**
 * @desc Get referral detail (user + commissions)
 * @route GET /api/partners/me/downline/:refId
 */
export async function getReferralDetail(req: SupabaseRequest, res: Response) {
  try {
    const userId = req.user_id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const service = new PartnerService(req.supabase);
    const partner = await service.getPartnerByUserId(userId);
    if (!partner) {
      return res.status(404).json({ success: false, error: "Not a partner" });
    }

    const detail = await service.getReferralDetail(
      partner.id,
      req.params.refId,
    );

    return res.json({ success: true, data: detail });
  } catch (error: any) {
    return handleError(res, error, "getReferralDetail");
  }
}

// =============================================================================
// Public Endpoints
// =============================================================================

/**
 * @desc Track referral click and redirect
 * @route GET /api/partners/track/:code
 */
export async function trackClick(req: Request, res: Response) {
  try {
    const { code } = req.params;
    const client = supabaseAdmin || supabase;
    const service = new PartnerService(client);

    await service.trackClick(code);

    // Redirect to homepage with ref code in query
    return res.redirect(`https://hilaq.com/?ref=${code}`);
  } catch (error: any) {
    // On error, still redirect
    return res.redirect("https://hilaq.com");
  }
}
