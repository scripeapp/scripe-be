import { Response } from "express";
import ApiResponse from "../utils/apiResponse";
import { SupabaseRequest } from "../types/http";
import WebsiteService from "../services/website.service";
import publicSupabase from "../config/supabase";

// Initialize a website for the authenticated user or return the existing one
export const init = async (req: SupabaseRequest, res: Response) => {
  try {
    const businessId =
      (req as any).businessId || req.body?.business_id || req.query.business_id;
    if (!businessId) {
      return res
        .status(400)
        .json({ success: false, error: "Business context required" });
    }

    const service = new WebsiteService(req.supabase);
    const site = await service.initUserWebsite(
      req.user_id!,
      req.body,
      businessId,
    );
    return ApiResponse.success(res, "Initialized website", site);
  } catch (err: any) {
    const status = err?.statusCode || 500;
    return res
      .status(status)
      .json({ success: false, error: "INIT_ERROR", message: err.message });
  }
};

// Load the authenticated user's website
export const me = async (req: SupabaseRequest, res: Response) => {
  try {
    const businessId =
      (req as any).businessId || req.query.business_id || req.body?.business_id;
    if (!businessId) {
      return res
        .status(400)
        .json({ success: false, error: "Business context required" });
    }

    const service = new WebsiteService(req.supabase);
    const site = await service.loadWebsiteByQuery({
      userId: req.user_id!,
      requesterId: req.user_id!,
      businessId,
    });
    return ApiResponse.success(res, "Loaded website", site);
  } catch (err: any) {
    const status = err?.statusCode || 500;
    return res
      .status(status)
      .json({ success: false, error: "LOAD_ERROR", message: err.message });
  }
};

/**
 * Upload logo for a website
 */
export const uploadLogo = async (req: SupabaseRequest, res: Response) => {
  if (!req.file) {
    return ApiResponse.badRequest(res, "No file uploaded");
  }

  const businessId = (req as any).businessId || (req as any).params?.businessId;
  if (!businessId) {
    return ApiResponse.badRequest(res, "Business ID required");
  }

  try {
    const service = new WebsiteService(req.supabase);
    const website = await service.loadWebsiteByQuery({ businessId });
    if (!website) {
      return ApiResponse.notFound(res, "Website not found");
    }

    const result = await service.uploadLogo(website.id, req.file);
    return ApiResponse.success(res, "Logo uploaded", result);
  } catch (error: any) {
    return ApiResponse.serverError(res, error.message);
  }
};

/**
 * Upload section image for a website
 */
export const uploadSectionImage = async (
  req: SupabaseRequest,
  res: Response,
) => {
  if (!req.file) {
    return ApiResponse.badRequest(res, "No file uploaded");
  }

  const businessId =
    (req as any).businessId ||
    req.body?.businessId ||
    req.query?.businessId ||
    req.params?.businessId;
  
  const sectionId =
    req.body?.sectionId ||
    req.query?.sectionId ||
    req.params?.sectionId;

  const { prefix = "sections" } = req.query as any;

  console.log("Resolved IDs:", { businessId, sectionId });

  if (!businessId || !sectionId) {
    return ApiResponse.badRequest(res, "Business ID and Section ID required");
  }

  try {
    const service = new WebsiteService(req.supabase);
    const website = await service.loadWebsiteByQuery({ businessId });
    if (!website) {
      return ApiResponse.notFound(res, "Website not found");
    }

    const result = await service.uploadSectionImage(
      website.id,
      sectionId,
      prefix,
      req.file,
    );
    return ApiResponse.success(res, "Section image uploaded", result);
  } catch (error: any) {
    return ApiResponse.serverError(res, error.message);
  }
};

// Public or private load depending on query
export const load = async (req: SupabaseRequest, res: Response) => {
  try {
    const { userId, domain, subdomain, resolveEntities, business_id } =
      req.query as any;
    const businessId = (req as any).businessId || business_id;

    const supabaseClient = req.supabase || publicSupabase;
    const service = new WebsiteService(supabaseClient);

    let site = await service.loadWebsiteByQuery({
      userId,
      domain,
      subdomain,
      requesterId: req.user_id,
      businessId,
    });

    // Optionally resolve linked entities (stores, events, publications)
    if (resolveEntities === "true" && site) {
      const resolved = await service.resolveLinkedEntities(site);
      return ApiResponse.success(res, "Loaded website with resolved entities", {
        ...resolved.website,
        resolvedData: resolved.resolvedData,
      });
    }

    return ApiResponse.success(res, "Loaded website", site);
  } catch (err: any) {
    const status = err?.statusCode || 500;
    console.log("Load Website Error:", err);
    return res
      .status(status)
      .json({ success: false, error: "LOAD_ERROR", message: err.message });
  }
};

// Upsert the authenticated user's website
export const save = async (req: SupabaseRequest, res: Response) => {
  try {
    const businessId =
      (req as any).businessId || req.body?.business_id || req.query.business_id;
    if (!businessId) {
      return res
        .status(400)
        .json({ success: false, error: "Business context required" });
    }

    const service = new WebsiteService(req.supabase);
    const site = await service.saveUserWebsite(
      req.user_id!,
      req.body,
      businessId,
    );
    return ApiResponse.success(res, "Saved website", site);
  } catch (err: any) {
    const status = err?.statusCode || 500;
    return res
      .status(status)
      .json({ success: false, error: "SAVE_ERROR", message: err.message });
  }
};

// Toggle live status and set domain/subdomain as needed
export const publish = async (req: SupabaseRequest, res: Response) => {
  try {
    const businessId =
      (req as any).businessId || req.body?.business_id || req.query.business_id;
    if (!businessId) {
      return res
        .status(400)
        .json({ success: false, error: "Business context required" });
    }

    const service = new WebsiteService(req.supabase);
    const site = await service.setWebsitePublication(
      req.user_id!,
      req.body,
      businessId,
    );
    return ApiResponse.success(res, "Publish updated", site);
  } catch (err: any) {
    const status = err?.statusCode || 500;
    return res
      .status(status)
      .json({ success: false, error: "PUBLISH_ERROR", message: err.message });
  }
};

// Mutate pages (add/update/delete) with invariants
export const page = async (req: SupabaseRequest, res: Response) => {
  try {
    const businessId =
      (req as any).businessId || req.body?.business_id || req.query.business_id;
    if (!businessId) {
      return res
        .status(400)
        .json({ success: false, error: "Business context required" });
    }

    const service = new WebsiteService(req.supabase);
    const site = await service.updateWebsitePage(
      req.user_id!,
      req.body,
      businessId,
    );
    return ApiResponse.success(res, "Page mutation applied", site);
  } catch (err: any) {
    const status = err?.statusCode || 500;
    return res
      .status(status)
      .json({ success: false, error: "PAGE_ERROR", message: err.message });
  }
};

// Mutate sections (add/update/delete/toggle)
export const section = async (req: SupabaseRequest, res: Response) => {
  try {
    const businessId =
      (req as any).businessId || req.body?.business_id || req.query.business_id;
    if (!businessId) {
      return res
        .status(400)
        .json({ success: false, error: "Business context required" });
    }

    const service = new WebsiteService(req.supabase);
    const site = await service.updatePageSection(
      req.user_id!,
      req.body,
      businessId,
    );
    return ApiResponse.success(res, "Section mutation applied", site);
  } catch (err: any) {
    const status = err?.statusCode || 500;
    console.log("Section Controller Error:", err);
    return res
      .status(status)
      .json({ success: false, error: "SECTION_ERROR", message: err.message });
  }
};

// Update only navigation JSON
export const updateNavigation = async (req: SupabaseRequest, res: Response) => {
  try {
    const businessId =
      (req as any).businessId || req.body?.business_id || req.query.business_id;
    if (!businessId) {
      return res
        .status(400)
        .json({ success: false, error: "Business context required" });
    }

    const service = new WebsiteService(req.supabase);
    const site = await service.updateWebsiteNavigation(
      req.user_id!,
      req.body.navigation,
      businessId,
    );
    return ApiResponse.success(res, "Navigation updated", site);
  } catch (err: any) {
    const status = err?.statusCode || 400;
    return res.status(status).json({
      success: false,
      error: "NAVIGATION_UPDATE_ERROR",
      message: err?.message || "Failed to update navigation",
    });
  }
};

// Check subdomain availability (public endpoint - no auth required)
export const checkSubdomain = async (req: SupabaseRequest, res: Response) => {
  try {
    const subdomain = req.query.subdomain as string;
    const service = new WebsiteService(publicSupabase);
    const result = await service.checkSubdomainAvailability(subdomain);
    return res.status(200).json(result);
  } catch (err: any) {
    const status = err?.statusCode || 500;
    return res.status(status).json({
      success: false,
      error: "CHECK_SUBDOMAIN_ERROR",
      message: err.message,
    });
  }
};

export default {
  init,
  me,
  load,
  save,
  publish,
  page,
  section,
  updateNavigation,
  checkSubdomain,
  uploadLogo: uploadLogo,
  uploadSectionImage: uploadSectionImage,
};
