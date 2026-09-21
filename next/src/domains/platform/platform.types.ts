/**
 * API and domain types for the platform administration, alert, and
 * announcement domain. Database row types remain generated and separate.
 */

export const PLATFORM_ADMINISTRATOR_ROLES = ["super_admin", "finance", "support", "moderator", "viewer"] as const;
export type PlatformAdministratorRole = (typeof PLATFORM_ADMINISTRATOR_ROLES)[number];

export interface PlatformAdministratorRow {
  readonly id: string;
  readonly userId: string;
  readonly role: PlatformAdministratorRole;
  readonly name: string;
  readonly email: string;
  readonly isActive: boolean;
  readonly permissions: string[];
  readonly lastLoginAt: Date | null;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PlatformAdministrator extends Omit<PlatformAdministratorRow, "lastLoginAt" | "createdAt" | "updatedAt"> {
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreatePlatformAdministratorInput {
  readonly email: string;
  readonly name: string;
  readonly role: PlatformAdministratorRole;
  readonly permissions?: string[];
}

export interface UpdatePlatformAdministratorInput {
  readonly role?: PlatformAdministratorRole;
  readonly isActive?: boolean;
  readonly permissions?: string[];
}

export type AdminAlertSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface AdminAlertRow {
  readonly id: string;
  readonly type: string;
  readonly severity: AdminAlertSeverity;
  readonly title: string;
  readonly message: string;
  readonly metadata: Record<string, unknown>;
  readonly isRead: boolean;
  readonly readAt: Date | null;
  readonly createdAt: Date;
}

export interface AdminAlert extends Omit<AdminAlertRow, "readAt" | "createdAt"> {
  readonly readAt: string | null;
  readonly createdAt: string;
}

export interface ListAdminAlertsFilter {
  readonly unreadOnly?: boolean;
  readonly severity?: AdminAlertSeverity;
  readonly type?: string;
  readonly page?: number;
  readonly limit?: number;
}

export interface AdminAlertsPage {
  readonly data: AdminAlert[];
  readonly total: number;
  readonly unread: number;
}

/**
 * Not exposed via any route - other domains' service code raises alerts
 * directly, within their own transaction, about a platform-level event.
 * Mirrors the audit/notifications domains' server-only creation shape.
 */
export interface CreateAdminAlertInput {
  readonly type: string;
  readonly severity: AdminAlertSeverity;
  readonly title: string;
  readonly message: string;
  readonly metadata?: Record<string, unknown>;
}

export type AnnouncementType = "info" | "warning" | "feature" | "maintenance" | "changelog";
export type AnnouncementAudience = "all" | "pro" | "plus" | "starter" | "paid";

export interface SystemAnnouncementRow {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly type: AnnouncementType;
  readonly audience: AnnouncementAudience;
  readonly ctaLabel: string | null;
  readonly ctaUrl: string | null;
  readonly isActive: boolean;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SystemAnnouncement extends Omit<SystemAnnouncementRow, "startsAt" | "endsAt" | "createdAt" | "updatedAt"> {
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateSystemAnnouncementInput {
  readonly title: string;
  readonly body: string;
  readonly type: AnnouncementType;
  readonly audience: AnnouncementAudience;
  readonly ctaLabel?: string | null;
  readonly ctaUrl?: string | null;
  readonly isActive?: boolean;
  readonly startsAt?: string | null;
  readonly endsAt?: string | null;
}

export interface UpdateSystemAnnouncementInput {
  readonly title?: string;
  readonly body?: string;
  readonly type?: AnnouncementType;
  readonly audience?: AnnouncementAudience;
  readonly ctaLabel?: string | null;
  readonly ctaUrl?: string | null;
  readonly isActive?: boolean;
  readonly startsAt?: string | null;
  readonly endsAt?: string | null;
}

export interface ListSystemAnnouncementsFilter {
  readonly activeOnly?: boolean;
  readonly page?: number;
  readonly limit?: number;
}

export interface SystemAnnouncementsPage {
  readonly data: SystemAnnouncement[];
  readonly total: number;
}

export interface PlatformOperation {
  readonly userId: string;
  readonly requestId: string;
}
