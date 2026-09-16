import { SupabaseClient } from "@supabase/supabase-js";
import EventService from "./events.services";
import { notificationService } from "./notification.services";

export type EntityType = "event";

export interface CreateAnnouncementInput {
  message: string;
  user_id: string;
  entity_type: EntityType;
  entity_id: string;
}

export interface AnnouncementRecord {
  id: string;
  message: string;
  event_id: string | null;
  created_at: string;
  user_id: string;
  event?: { id: string; event_name: string; event_url: string } | null;
  profiles?: { id: string; name: string } | null;
}

export class AnnouncementService {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Create a new announcement
   */
  async createAnnouncement(
    data: CreateAnnouncementInput,
  ): Promise<AnnouncementRecord> {
    const insertData: any = {
      message: data.message,
      user_id: data.user_id,
      event_id: data.entity_id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data: announcement, error } = await this.supabase
      .from("announcements")
      .insert([insertData])
      .select(
        `
        id,
        message,
        event_id,
        event:event_id (
          id,
          event_name,
          event_url
        ),
        created_at,
        user_id,
        profiles:user_id (
          id,
          name
        )
      `,
      )
      .single();

    if (error) throw error;

    if (announcement) {
      const eventServiceInstance = new EventService(this.supabase);
      eventServiceInstance.getAttendees(data.entity_id).then((attendees) => {
        attendees.forEach((attendee: any) => {
          const eventName =
            (announcement as any).event?.event_name || "your event";
          const message =
            data.message || "Please visit the event page for more information.";

          notificationService.createNotification({
            toEmail: attendee.customer_email,
            emailName: "Event Announcement",
            formatType: "html",
            emailSubject: `📢 New Announcement for "${eventName}"`,
            emailBody: `
              <div style="font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #333;">
                <h2 style="color: #5046E5;">New Update for "${eventName}"</h2>
                <p>Hello,</p>
                <p>There is a new announcement regarding the event <strong>${eventName}</strong> that you are attending.</p>
                <div style="padding: 12px; background-color: #f9f9f9; border-left: 4px solid #5046E5; margin: 16px 0;">
                  <em>${message}</em>
                </div>
                <p>Please <a href="https://hilaq.com/events/${
                  (announcement as any).event?.event_url || "#"
                }" style="color: #5046E5; text-decoration: underline;">visit the event page</a> for full details.</p>
                <p>Thank you,<br/>Hilaq Events</p>
              </div>
            `,
          });
        });
      });
    }

    return announcement as unknown as AnnouncementRecord;
  }

  /**
   * Get all announcements for an entity
   */
  async getAnnouncements(
    entityId: string,
    entityType: EntityType,
  ): Promise<AnnouncementRecord[]> {
    const { data, error } = await this.supabase
      .from("announcements")
      .select(
        `
        id,
        message,
        event_id,
        created_at,
        user_id,
        profiles:user_id (
          id,
          name
        )
      `,
      )
      .eq("event_id", entityId)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return (data || []) as unknown as AnnouncementRecord[];
  }

  /**
   * Delete an announcement
   */
  async deleteAnnouncement(id: string): Promise<{ success: boolean }> {
    const { error } = await this.supabase
      .from("announcements")
      .delete()
      .eq("id", id);

    if (error) throw error;
    return { success: true };
  }
}