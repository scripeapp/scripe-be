export type NotificationChannel = "email" | "sms" | "push" | "in_app";

export interface NotificationRow {
  readonly id: string;
  readonly userId: string;
  readonly businessId: string | null;
  readonly type: string;
  readonly title: string;
  readonly body: string;
  readonly data: Record<string, unknown>;
  readonly readAt: Date | null;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
}

export interface Notification extends Omit<NotificationRow, "readAt" | "archivedAt" | "createdAt"> {
  readonly readAt: string | null;
  readonly archivedAt: string | null;
  readonly createdAt: string;
}

export interface NotificationPreferenceRow {
  readonly userId: string;
  readonly type: string;
  readonly channel: NotificationChannel;
  readonly enabled: boolean;
  readonly updatedAt: Date;
}

export interface NotificationPreference extends Omit<NotificationPreferenceRow, "updatedAt"> {
  readonly updatedAt: string;
}

export interface NotificationsOperation {
  readonly userId: string;
  readonly requestId: string;
}

export interface ListNotificationsFilter {
  readonly unreadOnly?: boolean;
  readonly includeArchived?: boolean;
  readonly limit?: number;
}

export interface UpdateNotificationInput {
  readonly read?: boolean;
  readonly archived?: boolean;
}

export interface SetNotificationPreferenceInput {
  readonly enabled: boolean;
}

/** Not exposed via any route — for other domains to call server-side once a real trigger is evidenced. */
export interface CreateNotificationInput {
  readonly userId: string;
  readonly businessId?: string | null;
  readonly type: string;
  readonly title: string;
  readonly body?: string;
  readonly data?: Record<string, unknown>;
}
