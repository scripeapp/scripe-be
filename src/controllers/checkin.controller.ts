import { Response } from "express";
import { SupabaseRequest } from "../types/http";
import ApiResponse from "../utils/apiResponse";
import { checkinService } from "../services/checkin.service";
import { supabaseAdmin } from "../config/supabase";

class CheckinController {
  /**
   * @desc Generate (or rotate) a check-in access code for an event.
   *       The plaintext code is returned once; only its hash is stored.
   * @access Private — event owner or member with event.manage permission
   * @endpoint POST /api/dashboard/events/:id/checkin-code
   */
  async generateCode(req: SupabaseRequest, res: Response) {
    const eventId = req.params.id;

    const { data: event, error } = await req.supabase
      .from("events")
      .select("id")
      .eq("id", eventId)
      .single();

    if (error || !event) {
      return ApiResponse.notFound(res, "Event not found");
    }

    const code = checkinService.generateAccessCode();
    const hash = checkinService.hashCode(eventId, code);

    await checkinService.saveAccessCodeHash(req.supabase, eventId, hash);

    return ApiResponse.success(
      res,
      "Check-in access code generated. Save this code — it cannot be retrieved again.",
      { code },
    );
  }

  /**
   * @desc Check whether a check-in access code is currently active for an event.
   * @access Private — event owner or member with event.update permission
   * @endpoint GET /api/dashboard/events/:id/checkin-code/status
   */
  async getCodeStatus(req: SupabaseRequest, res: Response) {
    const eventId = req.params.id;

    const { data: event, error } = await req.supabase
      .from("events")
      .select("checkin_access_code_hash")
      .eq("id", eventId)
      .single();

    if (error || !event) {
      return ApiResponse.notFound(res, "Event not found");
    }

    return ApiResponse.success(res, "Status retrieved", {
      enabled: event.checkin_access_code_hash !== null,
    });
  }

  /**
   * @desc Disable check-in access code for an event by clearing the stored hash.
   * @access Private — event owner or member with event.update permission
   * @endpoint DELETE /api/dashboard/events/:id/checkin-code
   */
  async revokeCode(req: SupabaseRequest, res: Response) {
    const eventId = req.params.id;

    const { error } = await req.supabase
      .from("events")
      .update({ checkin_access_code_hash: null })
      .eq("id", eventId);

    if (error) {
      return ApiResponse.serverError(res, "Failed to revoke access code");
    }

    return ApiResponse.success(res, "Check-in access code disabled");
  }

  /**
   * @desc Validate an access code and issue a short-lived check-in token.
   * @access Public — no user auth required
   * @endpoint POST /api/checkin/auth
   */
  async authenticateWithCode(req: SupabaseRequest, res: Response) {
    const { event_id, code } = req.body as { event_id: string; code: string };

    let storedHash: string | null;
    try {
      storedHash = await checkinService.loadAccessCodeHash(
        supabaseAdmin,
        event_id,
      );
    } catch {
      return ApiResponse.notFound(res, "Event not found");
    }

    if (!storedHash) {
      return ApiResponse.unauthorized(
        res,
        "No access code is configured for this event",
      );
    }

    const isValid = checkinService.verifyCode(event_id, code, storedHash);
    if (!isValid) {
      return ApiResponse.unauthorized(res, "Invalid access code");
    }

    const signed = checkinService.signCheckinToken(event_id);
    return ApiResponse.success(res, "Authenticated successfully", signed);
  }
}

export const checkinController = new CheckinController();
