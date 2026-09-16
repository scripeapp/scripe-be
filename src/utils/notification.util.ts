
import { supabaseAdmin } from "../config/supabase";

export class NotificationUtil {
  /**
   * Check if a user should receive a specific type of notification
   * @param userId The user ID to check
   * @param preferenceKey The key in the notification_preferences JSON to check
   * @param defaultValue Default value if preference is not set (default: true)
   */
  static async shouldSendNotification(
    userId: string,
    preferenceKey: string,
    defaultValue: boolean = true
  ): Promise<boolean> {
    try {
      const { data: user, error } = await supabaseAdmin
        .from("users")
        .select("notification_preferences")
        .eq("id", userId)
        .single();

      if (error || !user) {
        console.warn(
          `[NotificationUtil] Failed to fetch preferences for user ${userId}. Defaulting to ${defaultValue}.`,
          error
        );
        return defaultValue;
      }

      const preferences = user.notification_preferences as Record<
        string,
        boolean
      > | null;

      if (!preferences) {
        return defaultValue;
      }

      // If the key exists, return its value. Otherwise, return default.
      return preferences[preferenceKey] !== undefined
        ? preferences[preferenceKey]
        : defaultValue;
    } catch (err) {
      console.error(
        `[NotificationUtil] Error checking preference ${preferenceKey} for user ${userId}:`,
        err
      );
      return defaultValue;
    }
  }
}
