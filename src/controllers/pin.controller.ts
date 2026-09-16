import { Response } from "express";
import { PinService } from "../services/pin.service";
import { SupabaseRequest } from "../types/http";
import ApiResponse from "../utils/apiResponse";

export class PinController {
  setPin = async (req: SupabaseRequest, res: Response) => {
    try {
      const service = new PinService(req.supabase);
      await service.setPin(req.body);
      return ApiResponse.success(res, "Transaction PIN saved", {
        has_pin: true,
      });
    } catch (error: any) {
      return ApiResponse.error(
        res,
        error?.message || "Unable to save transaction PIN",
        error?.statusCode || 500,
      );
    }
  };
}