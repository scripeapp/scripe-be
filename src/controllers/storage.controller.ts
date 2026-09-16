import { Response } from "express";
import { SupabaseRequest } from "../types/http";
import ApiResponse from "../utils/apiResponse";
import StorageService from "../services/storage.service";
import crypto from "crypto";

/**
 * Storage Controller
 * Handles generic file uploads to Supabase storage
 */
export class StorageController {
  /**
   * @desc Upload a file to a specific bucket and path
   * @route POST /api/storage/upload
   * @access Private (authenticated)
   */
  static async uploadFile(req: SupabaseRequest, res: Response) {
    try {
      const { bucket, path } = req.query;
      const file = req.file;

      if (!file) {
        return ApiResponse.badRequest(res, "No file provided");
      }

      if (!bucket) {
        return ApiResponse.badRequest(res, "Bucket parameter is required");
      }

      const storageService = new StorageService(req.supabase);

      // Generate a unique filename if path is not fully specified or ends with a slash
      let finalPath = (path as string) || "";
      if (!finalPath || finalPath.endsWith("/")) {
        const fileExt = file.originalname.split(".").pop();
        const fileName = `${crypto.randomBytes(16).toString("hex")}.${fileExt}`;
        finalPath = `${finalPath}${fileName}`;
      }

      const result = await storageService.uploadFile(
        bucket as string,
        finalPath,
        file as any,
      );

      return ApiResponse.success(res, "File uploaded successfully", result);
    } catch (error: any) {
      console.error("[StorageController] uploadFile error:", error);
      return ApiResponse.serverError(
        res,
        error.message || "Failed to upload file",
      );
    }
  }
}
