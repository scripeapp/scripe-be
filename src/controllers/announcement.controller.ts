import { Request, Response } from 'express';
import publicSupabase from '../config/supabase';
import { AnnouncementService } from '../services/announcements.services';
import { ApiResponse } from '../utils/apiResponse';
import { SupabaseRequest } from '../types/http';

/**
 * @desc Create a new announcement for an event
 * @access Private (Only event manager)
 * @endpoint POST /api/announcements
 */
export const createAnnouncement = async (req: SupabaseRequest, res: Response) => {
  try {
    const { message, entityId, entityType } = req.body;
    const userId = req.user_id;

    if (!message || !message.trim()) {
      return ApiResponse.badRequest(res, "Announcement message is required");
    }

    if (!entityId || !entityType) {
      return ApiResponse.badRequest(res, "Entity ID and type are required");
    }

    // Validate entity type
    if (entityType.toLowerCase() !== "event") {
      return ApiResponse.badRequest(
        res,
        "Entity type must be 'event'"
      );
    }

    // Create announcement
    const service = new AnnouncementService(req.supabase!);
    const announcement = await service.createAnnouncement({
      entity_id: entityId,
      entity_type: 'event',
      user_id: userId!,
      message,
    });

    return ApiResponse.created(
      res,
      "Announcement created successfully",
      announcement
    );
  } catch (error: any) {
    console.error('Error creating announcement:', error);
    return ApiResponse.serverError(res, error?.message);
  }
};

/**
 * @desc Get all announcements for an entity
 * @access Public
 * @endpoint GET /api/announcements
 * @query {string} entityId - Event ID
 * @query {string} entityType - Type of entity (event)
 */
export const getAnnouncements = async (req: Request, res: Response) => {
  try {
    const { entityId, entityType } = req.query as { entityId?: string; entityType?: string };

    if (!entityId || !entityType) {
      return ApiResponse.badRequest(res, "Entity ID and type are required");
    }

    // Validate entity type
    if (entityType.toLowerCase() !== "event") {
      return ApiResponse.badRequest(
        res,
        "Entity type must be 'event'"
      );
    }

    const supabaseClient = (req as any).supabase || publicSupabase;
    const service = new AnnouncementService(supabaseClient);

    // Get announcements
    const announcements = await service.getAnnouncements(
      entityId!,
      'event'
    );

    return ApiResponse.success(
      res,
      "Announcements retrieved successfully",
      announcements
    );
  } catch (error: any) {
    console.error('Error getting announcements:', error);
    return ApiResponse.serverError(res, error?.message);
  }
};

/**
 * @desc Delete an announcement
 * @access Private (Only entity manager)
 * @endpoint DELETE /api/announcements/:announcementId
 */
export const deleteAnnouncement = async (req: SupabaseRequest, res: Response) => {
  try {
    const { announcementId } = req.params;

    if (!announcementId) {
      return ApiResponse.badRequest(res, "Announcement ID is required");
    }

    // Delete announcement
    const service = new AnnouncementService(req.supabase!);
    await service.deleteAnnouncement(announcementId);

    return ApiResponse.success(res, "Announcement deleted successfully");
  } catch (error: any) {
    console.error('Error deleting announcement:', error);
    return ApiResponse.serverError(res, error?.message);
  }
};