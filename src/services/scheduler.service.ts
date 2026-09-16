import cron, { ScheduledTask } from "node-cron";
import { supabaseAdmin } from "../config/supabase";
import { uploadService } from "./upload.service";
import { sendEmail, trackEvent, isConfigured } from "../config/plunk";
import { postNotificationMailToSubscribers } from "../utils/emailsTemplate";
import { chunk, convertDraftToHtml } from "../utils/index";
import { scheduledEmailService } from "./scheduled-email.service";
import { StoreService } from "./store.service";
import { acquireLock } from "../config/redis";
import { listPaystackTransactions } from "../utils/paystack.util";
import { pendingCheckoutService } from "./pending-checkout.service";

/**
 * Scheduler Service for handling scheduled post publishing and subscription maintenance
 * Runs various cron jobs for post publishing and subscription management
 */
export class SchedulerService {
  private cronJob: ScheduledTask | null = null;
  private subscriptionExpiryJob: ScheduledTask | null = null;
  private renewalReminderJob: ScheduledTask | null = null;
  private paymentCleanupJob: ScheduledTask | null = null;
  private businessSubscriptionExpiryJob: ScheduledTask | null = null;
  private scheduledEmailJob: ScheduledTask | null = null;
  private activationGuideJob: ScheduledTask | null = null;
  private postNotificationRetryJob: ScheduledTask | null = null;
  private preOrderReleaseJob: ScheduledTask | null = null;
  private abandonedSchedulingPaymentJob: ScheduledTask | null = null;
  private stuckCampaignCleanupJob: ScheduledTask | null = null;
  private orphanUploadCleanupJob: ScheduledTask | null = null;
  private storeEngagementJob: ScheduledTask | null = null;
  private productRankingJob: ScheduledTask | null = null;
  private orphanBookingReservationJob: ScheduledTask | null = null;
  private orphanPaymentReconcileJob: ScheduledTask | null = null;
  private pendingCheckoutCleanupJob: ScheduledTask | null = null;
  private ndprDeletionCleanupJob: ScheduledTask | null = null;
  private readonly runningJobs = new Set<string>();

  private async runScheduledJob(
    jobId: string,
    lockTtlSeconds: number,
    logMessage: string,
    task: () => Promise<void>,
  ): Promise<void> {
    if (this.runningJobs.has(jobId)) {
      console.warn(`[Scheduler] Skipping ${jobId}; previous run still active`);
      return;
    }

    this.runningJobs.add(jobId);
    try {
      if (!(await acquireLock(`lock:${jobId}`, lockTtlSeconds))) return;
      console.log(logMessage);
      await task();
    } catch (error) {
      console.error(`[Scheduler] Error running ${jobId}:`, error);
    } finally {
      this.runningJobs.delete(jobId);
    }
  }

  /**
   * Start the scheduler
   */
  start(): void {
    // Run every 5 minutes - Scheduled post publishing
    this.cronJob = cron.schedule("1-59/5 * * * *", () =>
      this.runScheduledJob(
        "publish-scheduled-posts",
        270,
        "[Scheduler] Checking for scheduled posts to publish...",
        () => this.publishScheduledPosts(),
      ),
    );

    console.log(
      "[Scheduler] Scheduled post publisher started (runs every 5 minutes)",
    );

    // Run every hour - Expire cancelled subscriptions
    this.subscriptionExpiryJob = cron.schedule("6 * * * *", () =>
      this.runScheduledJob(
        "expire-subscriptions",
        3500,
        "[Scheduler] Checking for subscriptions to expire...",
        () => this.expireCancelledSubscriptions(),
      ),
    );

    console.log(
      "[Scheduler] Subscription expiry checker started (runs every hour)",
    );

    // Run daily at 9am - Renewal reminders
    this.renewalReminderJob = cron.schedule("9 9 * * *", () =>
      this.runScheduledJob(
        "send-renewal-reminders",
        86000,
        "[Scheduler] Sending renewal reminders...",
        () => this.sendRenewalReminders(),
      ),
    );

    console.log(
      "[Scheduler] Renewal reminder sender started (runs daily at 9:09am)",
    );

    // Run every hour at :33 - Clean up pending payments
    this.paymentCleanupJob = cron.schedule("33 * * * *", () =>
      this.runScheduledJob(
        "cleanup-pending-payments",
        3500,
        "[Scheduler] Cleaning up expired pending payments...",
        () => this.cleanupPendingPayments(),
      ),
    );

    console.log("[Scheduler] Payment cleanup started (runs every hour at :33)");

    // Run every hour at :47 - Expire business subscriptions
    this.businessSubscriptionExpiryJob = cron.schedule(
      "47 * * * *",
      () =>
        this.runScheduledJob(
          "expire-business-subscriptions",
          3500,
          "[Scheduler] Checking for business subscriptions to downgrade...",
          () => this.expireBusinessSubscriptions(),
        ),
    );

    console.log(
      "[Scheduler] Business subscription expiry checker started (runs every hour at :47)",
    );

    // Run every hour - Send upcoming session reminders
    cron.schedule("12 * * * *", () =>
      this.runScheduledJob(
        "send-session-reminders",
        3500,
        "[Scheduler] Sending upcoming session reminders...",
        () => this.sendUpcomingSessionReminders(),
      ),
    );

    console.log(
      "[Scheduler] Session reminder sender started (runs every hour)",
    );

    // Run every 5 minutes - Process scheduled emails
    this.scheduledEmailJob = cron.schedule("2-59/5 * * * *", () =>
      this.runScheduledJob(
        "process-scheduled-emails",
        270,
        "[Scheduler] Checking for scheduled emails to send...",
        () => scheduledEmailService.processDueEmails(),
      ),
    );

    console.log(
      "[Scheduler] Scheduled email processor started (runs every 5 minutes)",
    );

    this.activationGuideJob = cron.schedule("14 10 * * *", () =>
      this.runScheduledJob(
        "process-activation-nudges",
        86000,
        "[Scheduler] Processing activation nudges...",
        () => this.processActivationNudges(),
      ),
    );

    console.log(
      "[Scheduler] Activation guide nudges started (runs daily at 10:14am)",
    );

    // Run every 10 minutes - Retry failed post notifications
    this.postNotificationRetryJob = cron.schedule("4-59/10 * * * *", () =>
      this.runScheduledJob(
        "retry-post-notifications",
        570,
        "[Scheduler] Retrying failed post notifications...",
        () => this.retryFailedPostNotifications(),
      ),
    );

    console.log(
      "[Scheduler] Post notification retry started (runs every 10 minutes)",
    );

    // Run every hour - Auto-release pre-order products whose release date has passed
    this.preOrderReleaseJob = cron.schedule("18 * * * *", () =>
      this.runScheduledJob(
        "auto-release-preorders",
        3500,
        "[Scheduler] Checking for pre-order products to auto-release...",
        () => this.autoReleaseExpiredPreOrders(),
      ),
    );

    console.log(
      "[Scheduler] Pre-order auto-release checker started (runs every hour at :18)",
    );

    // Run every 15 minutes — expire awaiting_payment scheduled bookings older than 30 minutes
    this.abandonedSchedulingPaymentJob = cron.schedule(
      "7-59/15 * * * *",
      () =>
        this.runScheduledJob(
          "cleanup-abandoned-payments",
          870,
          "[Scheduler] Cleaning up abandoned scheduling payments...",
          () => this.expireAbandonedSchedulingPayments(),
        ),
    );

    console.log(
      "[Scheduler] Abandoned scheduling payment cleanup started (runs every 15 minutes)",
    );

    // Run every 5 minutes - Clean up stuck campaigns (sending for > 30 minutes)
    this.stuckCampaignCleanupJob = cron.schedule("3-59/5 * * * *", () =>
      this.runScheduledJob(
        "cleanup-stuck-campaigns",
        270,
        "[Scheduler] Checking for stuck campaigns...",
        () => this.cleanupStuckCampaigns(),
      ),
    );

    console.log(
      "[Scheduler] Stuck campaign cleanup started (runs every 5 minutes)",
    );

    // Run daily at 3:21am — delete unconfirmed R2 uploads whose presign window has expired
    this.orphanUploadCleanupJob = cron.schedule("21 3 * * *", () =>
      this.runScheduledJob(
        "orphan-upload-cleanup",
        86000,
        "[Scheduler] Cleaning up orphaned R2 uploads...",
        async () => {
          if (supabaseAdmin) {
            await uploadService.cleanupOrphans(supabaseAdmin);
          }
        },
      ),
    );

    console.log(
      "[Scheduler] Orphan upload cleanup started (runs daily at 3:21am)",
    );

    // Run monthly on the 1st at 9:23am - Re-engage store owners (no sales / inactive)
    this.storeEngagementJob = cron.schedule("23 9 1 * *", () =>
      this.runScheduledJob(
        "process-store-nudges",
        86000,
        "[Scheduler] Processing monthly store engagement nudges...",
        () => this.processStoreNudges(),
      ),
    );

    console.log(
      "[Scheduler] Store engagement nudges started (runs monthly on the 1st at 9:23am)",
    );

    // Run nightly at 2am — recalculate product trending & revenue scores
    this.productRankingJob = cron.schedule("17 2 * * *", () =>
      this.runScheduledJob(
        "recalculate-product-rankings",
        86000,
        "[Scheduler] Recalculating product ranking scores...",
        () => this.recalculateProductRankings(),
      ),
    );

    console.log(
      "[Scheduler] Product ranking recalculation started (runs nightly at 2:17am)",
    );

    // Run every 15 minutes — cancel orphan service_bookings pending reservations
    // older than 20 minutes with no associated order (slot-hold expired, payment not started)
    this.orphanBookingReservationJob = cron.schedule("11-59/15 * * * *", () =>
      this.runScheduledJob(
        "cleanup-orphan-booking-reservations",
        870,
        "[Scheduler] Cleaning up orphan booking reservations...",
        () => this.cleanupOrphanBookingReservations(),
      ),
    );

    console.log(
      "[Scheduler] Orphan booking reservation cleanup started (runs every 15 minutes)",
    );

    // Run every 2 hours — detect Paystack successes with no matching order row
    this.orphanPaymentReconcileJob = cron.schedule("26 */2 * * *", () =>
      this.runScheduledJob(
        "reconcile-orphan-payments",
        7000,
        "[Scheduler] Reconciling orphaned Paystack payments...",
        () => this.reconcileOrphanedPayments(),
      ),
    );

    console.log(
      "[Scheduler] Orphaned payment reconciliation started (runs every 2 hours)",
    );

    // Run daily at 3:23am — expire pending checkouts whose VA window lapsed
    // without a payment (14-day window exceeds Paystack VA validity + settlement).
    this.pendingCheckoutCleanupJob = cron.schedule("23 3 * * *", () =>
      this.runScheduledJob(
        "cleanup-expired-pending-checkouts",
        120,
        "[Scheduler] Cleaning up expired pending checkouts...",
        () => this.cleanupExpiredPendingCheckouts(),
      ),
    );

    console.log(
      "[Scheduler] Expired pending checkout cleanup started (runs daily at 3:23am)",
    );

    // Run daily at 1am — audit completed deletion requests for NDPR compliance
    this.ndprDeletionCleanupJob = cron.schedule("19 1 * * *", () =>
      this.runScheduledJob(
        "ndpr-deletion-cleanup",
        86000,
        "[Scheduler] Auditing completed NDPR deletion requests...",
        () => this.auditCompletedDeletionRequests(),
      ),
    );

    console.log(
      "[Scheduler] NDPR deletion audit started (runs daily at 1:19am)",
    );
  }

  /**
   * Stop the scheduler gracefully
   */
  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      console.log("[Scheduler] Scheduled post publisher stopped");
    }
    if (this.subscriptionExpiryJob) {
      this.subscriptionExpiryJob.stop();
      console.log("[Scheduler] Subscription expiry checker stopped");
    }
    if (this.renewalReminderJob) {
      this.renewalReminderJob.stop();
      console.log("[Scheduler] Renewal reminder sender stopped");
    }
    if (this.paymentCleanupJob) {
      this.paymentCleanupJob.stop();
      console.log("[Scheduler] Payment cleanup stopped");
    }
    if (this.businessSubscriptionExpiryJob) {
      this.businessSubscriptionExpiryJob.stop();
      console.log("[Scheduler] Business subscription expiry checker stopped");
    }
    if (this.scheduledEmailJob) {
      this.scheduledEmailJob.stop();
      console.log("[Scheduler] Scheduled email processor stopped");
    }
    if (this.activationGuideJob) {
      this.activationGuideJob.stop();
      console.log("[Scheduler] Activation guide nudges stopped");
    }
    if (this.postNotificationRetryJob) {
      this.postNotificationRetryJob.stop();
      console.log("[Scheduler] Post notification retry stopped");
    }
    if (this.preOrderReleaseJob) {
      this.preOrderReleaseJob.stop();
      console.log("[Scheduler] Pre-order auto-release checker stopped");
    }
    if (this.abandonedSchedulingPaymentJob) {
      this.abandonedSchedulingPaymentJob.stop();
      console.log("[Scheduler] Abandoned scheduling payment cleanup stopped");
    }
    if (this.storeEngagementJob) {
      this.storeEngagementJob.stop();
      console.log("[Scheduler] Store engagement nudges stopped");
    }
    if (this.productRankingJob) {
      this.productRankingJob.stop();
      console.log("[Scheduler] Product ranking recalculation stopped");
    }
    if (this.orphanBookingReservationJob) {
      this.orphanBookingReservationJob.stop();
      console.log("[Scheduler] Orphan booking reservation cleanup stopped");
    }
    if (this.orphanPaymentReconcileJob) {
      this.orphanPaymentReconcileJob.stop();
      console.log("[Scheduler] Orphaned payment reconciliation stopped");
    }
    if (this.pendingCheckoutCleanupJob) {
      this.pendingCheckoutCleanupJob.stop();
      console.log("[Scheduler] Expired pending checkout cleanup stopped");
    }
    if (this.ndprDeletionCleanupJob) {
      this.ndprDeletionCleanupJob.stop();
      console.log("[Scheduler] NDPR deletion audit stopped");
    }
  }

  /**
   * Find and publish all posts that are scheduled and ready
   */
  async publishScheduledPosts(): Promise<void> {
    try {
      // Find posts that are scheduled and past their publish time
      const { data: scheduledPosts, error } = await supabaseAdmin
        .from("posts")
        .select(
          `
          *,
          author:user_id(id, name, email),
          publication(id, name, description)
        `,
        )
        .eq("status", "scheduled")
        .lte("publish_time", new Date().toISOString());

      if (error) {
        console.error("[Scheduler] Error fetching scheduled posts:", error);
        return;
      }

      if (!scheduledPosts || scheduledPosts.length === 0) {
        console.log("[Scheduler] No scheduled posts ready to publish");
        return;
      }

      console.log(
        `[Scheduler] Found ${scheduledPosts.length} post(s) ready to publish`,
      );

      // Process each post individually to avoid blocking others on failure
      for (const post of scheduledPosts) {
        await this.publishPost(post);
      }
    } catch (error) {
      console.error(
        "[Scheduler] Unexpected error in publishScheduledPosts:",
        error,
      );
    }
  }

  /**
   * Publish a single scheduled post
   */
  private async publishPost(post: any): Promise<void> {
    try {
      const now = new Date().toISOString();

      // 1. Update post status to published
      const { error: updateError } = await supabaseAdmin
        .from("posts")
        .update({
          status: "published",
          updated_at: now,
        })
        .eq("id", post.id);

      if (updateError) {
        console.error(
          `[Scheduler] Failed to update post ${post.id}:`,
          updateError,
        );
        return;
      }

      console.log(`[Scheduler] Published post: ${post.id} - "${post.title}"`);

      // 2. Send author notification
      await this.sendAuthorNotification(post);

      // 3. Send to subscribers (if post has a publication)
      if (post.publication?.id) {
        await this.sendToSubscribers(post);
      }

      console.log(
        `[Scheduler] Completed all notifications for post: ${post.id}`,
      );
    } catch (error) {
      console.error(`[Scheduler] Failed to publish post ${post.id}:`, error);
      // Don't rethrow - we want to continue processing other posts
    }
  }

  /**
   * Send notification to the author that their post was auto-published
   */
  public async sendAuthorNotification(post: any): Promise<void> {
    try {
      if (!post.author?.email) {
        console.warn(`[Scheduler] No author email for post ${post.id}`);
        return;
      }

      if (!isConfigured()) {
        console.warn(
          "[Scheduler] Plunk client not configured; skipping author notification",
        );
        return;
      }

      await trackEvent({
        event: "scheduled-post-published",
        email: post.author.email,
        data: {
          name: post.author.name || "Author",
          post_id: post.id,
          post_title: post.title,
        },
      });

      console.log(
        `[Scheduler] Author notification sent to: ${post.author.email}`,
      );
    } catch (error) {
      console.error(
        `[Scheduler] Failed to send author notification for post ${post.id}:`,
        error,
      );
    }
  }

  /**
   * Send the post to all publication subscribers
   */
  public async sendToSubscribers(post: any): Promise<void> {
    // Idempotency: acquire the send lock by flipping is_email_sent from false->true.
    // If the row was already flipped (or missing), we skip sending.
    const { data: sendGate, error: sendGateError } = await supabaseAdmin
      .from("posts")
      .update({ is_email_sent: true })
      .eq("id", post.id)
      .eq("is_email_sent", false)
      .select("id")
      .maybeSingle();

    if (sendGateError) {
      console.error(
        `[Scheduler] Failed to acquire email send gate for post ${post.id}:`,
        sendGateError,
      );
      return;
    }

    if (!sendGate) {
      console.log(
        `[Scheduler] Subscriber email already sent (or in-flight) for post ${post.id}; skipping`,
      );
      return;
    }

    try {
      // Fetch subscribers
      const { data: subscribers, error } = await supabaseAdmin
        .from("subscriptions")
        .select(
          `
          *,
          user:user_id(email, name),
          publication:publication_id(name, description)
        `,
        )
        .eq("publication_id", post.publication.id);

      if (error) {
        throw new Error(`Failed to fetch subscribers: ${error.message}`);
      }

      if (!subscribers || subscribers.length === 0) {
        console.log(
          `[Scheduler] No subscribers found for publication ${post.publication.id}`,
        );
        return; // No rollback needed — nothing to send
      }

      // Filter subscribers with valid emails
      const validSubscribers = subscribers.filter(
        (sub: any) => sub.user?.email,
      );

      if (validSubscribers.length === 0) {
        console.log(
          `[Scheduler] No valid subscriber emails for publication ${post.publication.id}`,
        );
        return; // No rollback needed — nothing to send
      }

      // Prepare emails
      const emails = validSubscribers.map((sub: any) => ({
        to: sub.user.email,
        name: post.publication.name || post.author?.name || "Hilaq Publication",
        subject: post.title,
        type: "html" as const,
        body: postNotificationMailToSubscribers({
          author_name: post.author?.name || "Author",
          name: sub.user.name || "Subscriber",
          post_id: post.id,
          post_title: post.title,
          post_subtitle: post.subtitle || "",
          post_content: convertDraftToHtml(post.body || ""),
          pub_name: post.publication.name,
          cover_image: post.cover_image || null,
        }),
      }));

      // Send in batches
      await this.sendEmailsInBatches(emails);

      console.log(
        `[Scheduler] Sent post notification to ${validSubscribers.length} subscribers for post ${post.id}`,
      );
    } catch (error) {
      // Rollback: flip is_email_sent back to false so the retry job can pick it up
      console.error(
        `[Scheduler] Failed to send to subscribers for post ${post.id}:`,
        error,
      );
      await supabaseAdmin
        .from("posts")
        .update({ is_email_sent: false })
        .eq("id", post.id);
      console.log(
        `[Scheduler] Rolled back is_email_sent for post ${post.id}; will retry`,
      );
    }
  }

  /**
   * Send emails in batches of 50
   */
  private async sendEmailsInBatches(emails: any[]): Promise<void> {
    if (!isConfigured()) {
      console.warn(
        "[Scheduler] Plunk client not configured; skipping batch email send",
      );
      return;
    }

    const BATCH_SIZE = 10;
    const batches = chunk(emails, BATCH_SIZE);

    for (const batch of batches) {
      await Promise.all(batch.map((email: any) => sendEmail(email)));
    }
  }

  // ==========================================================================
  // POST NOTIFICATION RETRY
  // ==========================================================================

  /**
   * Retry failed post notifications.
   * Finds published posts where is_email_sent is still false and
   * publish_time is within the last 24 hours.
   */
  async retryFailedPostNotifications(): Promise<void> {
    try {
      const twentyFourHoursAgo = new Date(
        Date.now() - 24 * 60 * 60 * 1000,
      ).toISOString();

      const { data: failedPosts, error } = await supabaseAdmin
        .from("posts")
        .select(
          `
          *,
          author:user_id(id, name, email),
          publication(id, name, description)
        `,
        )
        .eq("status", "published")
        .eq("is_email_sent", false)
        .gte("publish_time", twentyFourHoursAgo);

      if (error) {
        console.error(
          "[Scheduler] Error fetching failed post notifications:",
          error,
        );
        return;
      }

      if (!failedPosts || failedPosts.length === 0) {
        return; // Nothing to retry — stay quiet
      }

      console.log(
        `[Scheduler] Retrying notifications for ${failedPosts.length} post(s)`,
      );

      for (const post of failedPosts) {
        if (!post.publication?.id) continue;
        try {
          await this.sendToSubscribers(post);
        } catch (err) {
          console.error(`[Scheduler] Retry failed for post ${post.id}:`, err);
        }
      }
    } catch (error) {
      console.error(
        "[Scheduler] Unexpected error in retryFailedPostNotifications:",
        error,
      );
    }
  }

  // ==========================================================================
  // SUBSCRIPTION MAINTENANCE JOBS
  // ==========================================================================

  /**
   * Expire cancelled subscriptions that are past their period end
   */
  // ---------------------------------------------------------------------------
  // Job registry — maps slug → method for admin-triggered manual runs
  // ---------------------------------------------------------------------------

  static readonly JOB_DEFINITIONS = [
    {
      id: "publish-scheduled-posts",
      label: "Publish Scheduled Posts",
      schedule: "Every 5 minutes at :01/:06/:11...",
    },
    {
      id: "expire-subscriptions",
      label: "Expire Cancelled Subscriptions",
      schedule: "Every hour at :06",
    },
    {
      id: "send-renewal-reminders",
      label: "Send Renewal Reminders",
      schedule: "Daily at 9:09am",
    },
    {
      id: "cleanup-pending-payments",
      label: "Cleanup Pending Payments",
      schedule: "Every hour at :33",
    },
    {
      id: "expire-business-subscriptions",
      label: "Expire Business Subscriptions",
      schedule: "Every hour at :47",
    },
    {
      id: "send-session-reminders",
      label: "Send Session Reminders",
      schedule: "Every hour at :12",
    },
    {
      id: "process-scheduled-emails",
      label: "Process Scheduled Emails",
      schedule: "Every 5 minutes at :02/:07/:12...",
    },
    {
      id: "process-activation-nudges",
      label: "Process Activation Nudges",
      schedule: "Daily at 10:14am",
    },
    {
      id: "retry-post-notifications",
      label: "Retry Failed Post Notifications",
      schedule: "Every 10 minutes at :04/:14/:24...",
    },
    {
      id: "auto-release-preorders",
      label: "Auto-Release Expired Pre-Orders",
      schedule: "Every hour at :18",
    },
    {
      id: "cleanup-abandoned-payments",
      label: "Cleanup Abandoned Scheduling Payments",
      schedule: "Every 15 minutes at :07/:22/:37/:52",
    },
    {
      id: "cleanup-stuck-campaigns",
      label: "Cleanup Stuck Campaigns",
      schedule: "Every 5 minutes at :03/:08/:13...",
    },
    {
      id: "process-store-nudges",
      label: "Monthly Store Engagement Nudges",
      schedule: "Monthly on the 1st at 9:23am",
    },
    {
      id: "cleanup-orphan-booking-reservations",
      label: "Cleanup Orphan Booking Reservations",
      schedule: "Every 15 minutes at :11/:26/:41/:56",
    },
    {
      id: "reconcile-orphan-payments",
      label: "Reconcile Orphaned Paystack Payments",
      schedule: "Every 2 hours at :26",
    },
    {
      id: "ndpr-deletion-audit",
      label: "NDPR Deletion Request Audit",
      schedule: "Daily at 1:19am",
    },
  ] as const;

  async runJob(jobId: string): Promise<void> {
    switch (jobId) {
      case "publish-scheduled-posts":
        return this.publishScheduledPosts();
      case "expire-subscriptions":
        return this.expireCancelledSubscriptions();
      case "send-renewal-reminders":
        return this.sendRenewalReminders();
      case "cleanup-pending-payments":
        return this.cleanupPendingPayments();
      case "expire-business-subscriptions":
        return this.expireBusinessSubscriptions();
      case "send-session-reminders":
        return this.sendUpcomingSessionReminders();
      case "process-scheduled-emails":
        return scheduledEmailService.processDueEmails();
      case "process-activation-nudges":
        return this.processActivationNudges();
      case "retry-post-notifications":
        return this.retryFailedPostNotifications();
      case "auto-release-preorders":
        return this.autoReleaseExpiredPreOrders();
      case "cleanup-abandoned-payments":
        return this.expireAbandonedSchedulingPayments();
      case "cleanup-stuck-campaigns":
        return this.cleanupStuckCampaigns();
      case "process-store-nudges":
        return this.processStoreNudges();
      case "cleanup-orphan-booking-reservations":
        return this.cleanupOrphanBookingReservations();
      case "reconcile-orphan-payments":
        return this.reconcileOrphanedPayments();
      case "ndpr-deletion-audit":
        return this.auditCompletedDeletionRequests();
      default:
        throw new Error(`Unknown job id: ${jobId}`);
    }
  }

  private async expireCancelledSubscriptions(): Promise<void> {
    try {
      const { publicationSubscriptionService } =
        await import("./publication-subscription.service");
      const count =
        await publicationSubscriptionService.expireCancelledSubscriptions();

      if (count > 0) {
        console.log(`[Scheduler] Expired ${count} cancelled subscription(s)`);
      } else {
        console.log("[Scheduler] No cancelled subscriptions to expire");
      }
    } catch (error) {
      console.error("[Scheduler] Error expiring subscriptions:", error);
    }
  }

  /**
   * Send renewal reminders to subscribers 3 days before expiry
   */
  private async sendRenewalReminders(): Promise<void> {
    try {
      const { publicationSubscriptionService } =
        await import("./publication-subscription.service");
      const subscriptions =
        await publicationSubscriptionService.getSubscriptionsNeedingReminder();

      if (subscriptions.length === 0) {
        console.log("[Scheduler] No renewal reminders to send");
        return;
      }

      for (const sub of subscriptions) {
        try {
          const userEmail = (sub as any).user?.email;
          const userName = (sub as any).user?.name || "Subscriber";
          const pubName = (sub as any).publication?.name || "Publication";

          if (!userEmail || !isConfigured()) continue;

          await trackEvent({
            event: "subscription-renewal-reminder",
            email: userEmail,
            data: {
              name: userName,
              publication_name: pubName,
              expiry_date: sub.current_period_end || "Unknown",
              plan: sub.plan || "paid",
            },
          });

          console.log(`[Scheduler] Sent renewal reminder to: ${userEmail}`);
        } catch (err) {
          console.error(
            `[Scheduler] Failed to send renewal reminder for subscription ${sub.id}:`,
            err,
          );
        }
      }

      console.log(
        `[Scheduler] Sent ${subscriptions.length} renewal reminder(s)`,
      );
    } catch (error) {
      console.error("[Scheduler] Error sending renewal reminders:", error);
    }
  }

  /**
   * Clean up pending payments that are older than 24 hours
   */
  private async cleanupPendingPayments(): Promise<void> {
    try {
      const { publicationSubscriptionService } =
        await import("./publication-subscription.service");
      const count =
        await publicationSubscriptionService.cleanupPendingPayments();

      if (count > 0) {
        console.log(`[Scheduler] Cleaned up ${count} pending payment(s)`);
      } else {
        console.log("[Scheduler] No pending payments to clean up");
      }
    } catch (error) {
      console.error("[Scheduler] Error cleaning up payments:", error);
    }
  }

  /**
   * Downgrade expired business subscriptions to starter plan
   */
  private async expireBusinessSubscriptions(): Promise<void> {
    try {
      // Find businesses with expired subscriptions that haven't been downgraded
      const { data: expiredBusinesses, error } = await supabaseAdmin
        .from("businesses")
        .select("id, subscription_plan, subscription_expires_at")
        .in("subscription_plan", ["plus", "pro"])
        .in("subscription_status", ["cancelled", "expired", "past_due"])
        .lt("subscription_expires_at", new Date().toISOString())
        .not("subscription_expires_at", "is", null);

      if (error) {
        console.error(
          "[Scheduler] Error fetching expired business subscriptions:",
          error,
        );
        return;
      }

      if (!expiredBusinesses || expiredBusinesses.length === 0) {
        console.log(
          "[Scheduler] No expired business subscriptions to downgrade",
        );
        return;
      }

      console.log(
        `[Scheduler] Found ${expiredBusinesses.length} business(es) to downgrade`,
      );

      // Import the service dynamically
      const { businessSubscriptionService } =
        await import("./business-subscription.service");

      for (const business of expiredBusinesses) {
        try {
          await businessSubscriptionService.downgradeToStarter(business.id);
          console.log(
            `[Scheduler] Downgraded business ${business.id} to starter plan`,
          );
        } catch (err) {
          console.error(
            `[Scheduler] Failed to downgrade business ${business.id}:`,
            err,
          );
        }
      }

      console.log(
        `[Scheduler] Completed downgrading ${expiredBusinesses.length} business(es)`,
      );
    } catch (error) {
      console.error(
        "[Scheduler] Error expiring business subscriptions:",
        error,
      );
    }
  }

  /**
   * Send upcoming session reminders
   */
  private async sendUpcomingSessionReminders(): Promise<void> {
    try {
      const { CircleNotificationService } =
        await import("./circleNotification.service");
      const notificationService = new CircleNotificationService(supabaseAdmin);
      await notificationService.sendUpcomingReminders();
      console.log("[Scheduler] Sent upcoming session reminders");
    } catch (error) {
      console.error("[Scheduler] Error sending session reminders:", error);
    }
  }

  private async processActivationNudges(): Promise<void> {
    try {
      const { ActivationGuideService } =
        await import("./activation-guide.service");
      const activationGuideService = new ActivationGuideService(supabaseAdmin);
      await activationGuideService.processActivationNudges();
      console.log("[Scheduler] Activation nudges processed");
    } catch (error) {
      console.error("[Scheduler] Error processing activation nudges:", error);
    }
  }

  private async processStoreNudges(): Promise<void> {
    try {
      const { storeEngagementService } =
        await import("./store-engagement.service");
      await storeEngagementService.processMonthlyStoreNudges();
      console.log("[Scheduler] Store engagement nudges processed");
    } catch (error) {
      console.error(
        "[Scheduler] Error processing store engagement nudges:",
        error,
      );
    }
  }

  /**
   * Find all pre-order products whose release date has passed and release them
   * so buyers receive their download links and the product returns to normal sale.
   */
  private async autoReleaseExpiredPreOrders(): Promise<void> {
    try {
      const { data: products, error } = await supabaseAdmin
        .from("products")
        .select("id, store_id")
        .eq("is_pre_order", true)
        .not("pre_order_release_date", "is", null)
        .lte("pre_order_release_date", new Date().toISOString());

      if (error) {
        console.error("[Scheduler] Error fetching expired pre-orders:", error);
        return;
      }

      if (!products || products.length === 0) return;

      console.log(
        `[Scheduler] Auto-releasing ${products.length} expired pre-order product(s)...`,
      );

      const storeService = new StoreService(supabaseAdmin);
      for (const product of products) {
        try {
          const result = await storeService.releasePreOrderProduct(
            product.store_id,
            product.id,
          );
          console.log(
            `[Scheduler] Released product ${product.id} — fulfilled ${result.fulfilled_count} order(s)`,
          );
        } catch (err) {
          console.error(
            `[Scheduler] Failed to auto-release product ${product.id}:`,
            err,
          );
        }
      }
    } catch (error) {
      console.error("[Scheduler] Error in autoReleaseExpiredPreOrders:", error);
    }
  }

  private async expireAbandonedSchedulingPayments(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 minutes ago

      const { data: abandoned, error } = await supabaseAdmin
        .from("scheduled_bookings")
        .select("id")
        .eq("status", "awaiting_payment")
        .lt("created_at", cutoff);

      if (error) {
        console.error(
          "[Scheduler] Error fetching abandoned scheduling payments:",
          error,
        );
        return;
      }

      if (!abandoned || abandoned.length === 0) return;

      console.log(
        `[Scheduler] Expiring ${abandoned.length} abandoned scheduling payment(s)...`,
      );

      const ids = abandoned.map((b: { id: string }) => b.id);
      const { error: updateError } = await supabaseAdmin
        .from("scheduled_bookings")
        .update({ status: "cancelled", payment_status: "unpaid" })
        .in("id", ids);

      if (updateError) {
        console.error(
          "[Scheduler] Error expiring abandoned scheduling payments:",
          updateError,
        );
      } else {
        console.log(
          `[Scheduler] Cancelled ${ids.length} abandoned payment booking(s)`,
        );
      }
    } catch (error) {
      console.error(
        "[Scheduler] Error in expireAbandonedSchedulingPayments:",
        error,
      );
    }
  }

  /**
   * Cancel pending service_bookings that have no associated order and were
   * created more than 20 minutes ago — these are slot-hold reservations where
   * the customer never completed payment.
   */
  private async cleanupOrphanBookingReservations(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - 20 * 60 * 1000).toISOString();

      const { data: orphans, error } = await supabaseAdmin
        .from("service_bookings")
        .select("id")
        .eq("status", "pending")
        .eq("payment_status", "pending")
        .is("order_id", null)
        .lt("created_at", cutoff);

      if (error) {
        console.error(
          "[Scheduler] Error fetching orphan booking reservations:",
          error,
        );
        return;
      }

      if (!orphans || orphans.length === 0) return;

      const ids = orphans.map((b: { id: string }) => b.id);
      const { error: updateError } = await supabaseAdmin
        .from("service_bookings")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .in("id", ids);

      if (updateError) {
        console.error(
          "[Scheduler] Error cancelling orphan booking reservations:",
          updateError,
        );
      } else {
        console.log(
          `[Scheduler] Cancelled ${ids.length} orphan booking reservation(s)`,
        );
      }
    } catch (error) {
      console.error(
        "[Scheduler] Error in cleanupOrphanBookingReservations:",
        error,
      );
    }
  }

  /**
   * Clean up campaigns stuck in "sending" state for more than 30 minutes
   * This handles cases where the background worker was killed (e.g., serverless timeout)
   */
  async cleanupStuckCampaigns(): Promise<void> {
    try {
      const thirtyMinutesAgo = new Date(
        Date.now() - 30 * 60 * 1000,
      ).toISOString();

      // Find campaigns stuck in "sending" state for > 30 minutes
      const { data: stuckCampaigns, error } = await supabaseAdmin
        .from("campaigns")
        .select("id, status, updated_at, name")
        .eq("status", "sending")
        .lt("updated_at", thirtyMinutesAgo);

      if (error) {
        console.error("[Scheduler] Error fetching stuck campaigns:", error);
        return;
      }

      if (!stuckCampaigns || stuckCampaigns.length === 0) return;

      console.log(
        `[Scheduler] Found ${stuckCampaigns.length} stuck campaign(s)`,
      );

      for (const campaign of stuckCampaigns) {
        console.log(
          `[Scheduler] Marking campaign ${campaign.id} (${campaign.name || "unnamed"}) as failed due to timeout`,
        );

        // Check the send job status
        const { data: sendJob } = await supabaseAdmin
          .from("campaign_send_jobs")
          .select("id, status, sent_count, failed_count")
          .eq("campaign_id", campaign.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .single();

        const sentCount = sendJob?.sent_count || 0;
        const failedCount = sendJob?.failed_count || 0;
        const sendJobId = sendJob?.id;

        // Always mark as failed — a stuck campaign did not complete, even if some
        // emails went out. Marking partial sends as "sent" would hide the gap and
        // prevent the user from retrying to reach the unsent contacts.
        await supabaseAdmin
          .from("campaigns")
          .update({
            status: "failed",
            updated_at: new Date().toISOString(),
          })
          .eq("id", campaign.id);

        // Update job status if exists
        if (sendJobId) {
          await supabaseAdmin
            .from("campaign_send_jobs")
            .update({
              status: "failed",
              error_message:
                "Campaign timed out - background worker did not complete",
              updated_at: new Date().toISOString(),
            })
            .eq("id", sendJobId);
        }

        console.log(
          `[Scheduler] Campaign ${campaign.id} marked as failed (sent so far: ${sentCount}, failed: ${failedCount})`,
        );
      }
    } catch (error) {
      console.error("[Scheduler] Error in cleanupStuckCampaigns:", error);
    }
  }

  /**
   * Recalculate trending_score and revenue_score for all active products.
   *
   * trending_score = (orders in last 7d × 3) + (orders in last 30d × 1.5) + (lifetime orders × 0.2)
   * revenue_score  = SUM(item.quantity × item.price) from store_orders in last 30 days
   *
   * Uses raw SQL via supabaseAdmin RPC to keep the logic in one place and avoid
   * N+1 queries per product.
   */
  private async recalculateProductRankings(): Promise<void> {
    if (!supabaseAdmin) {
      console.warn("[Scheduler] supabaseAdmin not available — skipping product ranking recalculation");
      return;
    }

    try {
      // Trending score: aggregate order counts per product from store_orders items JSONB
      const { error: trendingError } = await supabaseAdmin.rpc(
        "recalculate_product_trending_scores",
      );

      if (trendingError) {
        console.error("[Scheduler] Error recalculating trending scores:", trendingError);
        return;
      }

      console.log("[Scheduler] Product ranking scores updated successfully");
    } catch (error) {
      console.error("[Scheduler] Error in recalculateProductRankings:", error);
    }
  }

  // ==========================================================================
  // NDPR DELETION AUDIT
  // ==========================================================================

  /**
   * Finds completed deletion requests and verifies the user record was
   * anonymized. Logs any gaps so they can be resolved manually.
   *
   * NDPR requires data not to be retained beyond its stated purpose.
   * Deletion requests completed more than 30 days ago are audited here.
   */
  async auditCompletedDeletionRequests(): Promise<void> {
    if (!supabaseAdmin) {
      console.warn("[Scheduler] supabaseAdmin not available — skipping NDPR deletion audit");
      return;
    }

    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      const { data: requests, error } = await supabaseAdmin
        .from("ndpr_requests")
        .select("id, user_id, processed_at")
        .eq("request_type", "deletion")
        .eq("status", "completed")
        .lt("processed_at", thirtyDaysAgo)
        .not("user_id", "is", null);

      if (error) {
        console.error("[Scheduler] Error fetching completed deletion requests:", error);
        return;
      }

      if (!requests || requests.length === 0) {
        console.log("[Scheduler] NDPR audit: no completed deletion requests require review");
        return;
      }

      const userIds = requests.map((r: { user_id: string }) => r.user_id);

      const { data: notAnonymized, error: userError } = await supabaseAdmin
        .from("users")
        .select("id")
        .in("id", userIds)
        .eq("is_deleted", false);

      if (userError) {
        console.error("[Scheduler] Error checking user anonymization status:", userError);
        return;
      }

      if (!notAnonymized || notAnonymized.length === 0) {
        console.log(`[Scheduler] NDPR audit: all ${requests.length} completed deletion(s) correctly anonymized`);
        return;
      }

      // These users should have been anonymized but weren't — log for manual review
      const ids = notAnonymized.map((u: { id: string }) => u.id).join(", ");
      console.error(
        `[Scheduler] NDPR audit: ${notAnonymized.length} user(s) have completed deletion requests but are NOT anonymized. User IDs: ${ids}`,
      );
    } catch (error) {
      console.error("[Scheduler] Error in auditCompletedDeletionRequests:", error);
    }
  }

  // ==========================================================================
  // PAYMENT RECONCILIATION
  // ==========================================================================

  /**
   * Fetch Paystack successes from the last 8 hours and insert any that have no
   * matching order into payment_recovery_queue for admin review.
   *
   * - Looks back 8 hours to cover Paystack's ~5-hour retry window plus margin.
   * - Skips transactions younger than 30 minutes to let Paystack's own retries
   *   self-heal before we surface them as orphans.
   * - ON CONFLICT DO NOTHING ensures repeated runs are idempotent.
   */
  async reconcileOrphanedPayments(): Promise<void> {
    if (!supabaseAdmin) {
      console.warn("[Scheduler] supabaseAdmin not available — skipping payment reconciliation");
      return;
    }

    try {
      const now = Date.now();
      const from = new Date(now - 8 * 60 * 60 * 1000).toISOString();
      const minAgeThreshold = new Date(now - 30 * 60 * 1000).toISOString();

      const { transactions } = await listPaystackTransactions({
        status: "success",
        from,
        perPage: 100,
      });

      if (!transactions || transactions.length === 0) {
        console.log("[Scheduler] No successful Paystack transactions in the last 8 hours");
        return;
      }

      // Filter out transactions that are too recent — give Paystack retries time to land
      const candidates = transactions.filter(
        (tx: any) => tx.paid_at && tx.paid_at < minAgeThreshold,
      );

      if (candidates.length === 0) {
        console.log("[Scheduler] All recent transactions are within the 30-minute grace window");
        return;
      }

      const references = candidates.map((tx: any) => tx.reference as string);

      // Check which references already have an order row or a wallet credit
      const [{ data: eventOrders }, { data: storeOrders }, { data: walletCredits }] =
        await Promise.all([
          supabaseAdmin
            .from("orders")
            .select("payment_reference")
            .in("payment_reference", references),
          supabaseAdmin
            .from("store_orders")
            .select("payment_reference")
            .in("payment_reference", references),
          supabaseAdmin
            .from("wallet_transactions")
            .select("provider_reference")
            .eq("provider", "paystack")
            .in("provider_reference", references),
        ]);

      const fulfilledReferences = new Set<string>([
        ...(eventOrders ?? []).map((r: { payment_reference: string }) => r.payment_reference),
        ...(storeOrders ?? []).map((r: { payment_reference: string }) => r.payment_reference),
        // Dedicated-virtual-account deposits are fulfilled by their wallet
        // credit — without this, every successful deposit would be flagged as
        // an orphan and alert admins despite the webhook crediting it fine.
        ...(walletCredits ?? []).map((r: { provider_reference: string }) => r.provider_reference),
      ]);

      const orphans = candidates.filter(
        (tx: any) => !fulfilledReferences.has(tx.reference),
      );

      if (orphans.length === 0) {
        console.log("[Scheduler] No orphaned payments found");
        return;
      }

      console.log(`[Scheduler] Found ${orphans.length} orphaned payment(s) — queuing for recovery`);

      const rows = orphans.map((tx: any) => ({
        payment_reference: tx.reference,
        paystack_amount: tx.amount,
        paystack_email: tx.customer?.email ?? null,
        paystack_paid_at: tx.paid_at ?? null,
        paystack_metadata: tx.metadata ?? null,
      }));

      // upsert with ignoreDuplicates: true → ON CONFLICT DO NOTHING, so repeated runs are safe
      const { error } = await supabaseAdmin
        .from("payment_recovery_queue")
        .upsert(rows, { onConflict: "payment_reference", ignoreDuplicates: true });

      if (error) {
        console.error("[Scheduler] Error inserting into payment_recovery_queue:", error.message);
        return;
      }

      console.log(`[Scheduler] Queued ${rows.length} orphaned payment(s) for admin recovery`);
      await this.alertAdminOfOrphanedPayments(orphans);
    } catch (error) {
      console.error("[Scheduler] Error in reconcileOrphanedPayments:", error);
    }
  }

  async cleanupExpiredPendingCheckouts(): Promise<void> {
    if (!supabaseAdmin) {
      console.warn(
        "[Scheduler] supabaseAdmin not available — skipping pending checkout cleanup",
      );
      return;
    }

    try {
      const abandonedCount = await pendingCheckoutService.markExpiredAsAbandoned(
        supabaseAdmin,
        new Date().toISOString(),
      );
      console.log(
        `[Scheduler] Marked ${abandonedCount} expired pending checkout(s) as abandoned`,
      );
    } catch (error) {
      console.error("[Scheduler] Error in cleanupExpiredPendingCheckouts:", error);
    }
  }

  private async alertAdminOfOrphanedPayments(orphans: any[]): Promise<void> {
    if (!isConfigured()) {
      console.warn("[Scheduler] Plunk not configured — skipping orphaned payment alert email");
      return;
    }

    const itemLines = orphans
      .map((tx) => {
        const amount = new Intl.NumberFormat("en-NG", {
          style: "currency",
          currency: "NGN",
          minimumFractionDigits: 2,
        }).format((tx.amount ?? 0) / 100);
        const paidAt = tx.paid_at ? new Date(tx.paid_at).toLocaleString("en-NG") : "unknown time";
        const email = tx.customer?.email ?? "unknown";
        return `- **${tx.reference}** | ${amount} | ${email} | paid ${paidAt}`;
      })
      .join("\n");

    const body = `
## ${orphans.length} Orphaned Payment${orphans.length === 1 ? "" : "s"} Need Attention

The payment reconciliation job found Paystack transactions that were marked **success** but have no matching order in the database.

These customers paid but did not receive their order or tickets.

### Affected Transactions

${itemLines}

### Next Steps

Open the [Payment Recovery page](https://hilaq.com/admin/payments) to fulfill each order and resend confirmation emails.

---
*Sent automatically by the Hilaq reconciliation cron job.*
    `.trim();

    try {
      await sendEmail({
        to: "hilaqapp@gmail.com",
        name: "Hilaq Admin",
        subject: `[Action Required] ${orphans.length} orphaned payment${orphans.length === 1 ? "" : "s"} need recovery`,
        type: "markdown",
        body,
      });
      console.log("[Scheduler] Orphaned payment alert sent to hilaqapp@gmail.com");
    } catch (err) {
      console.error("[Scheduler] Failed to send orphaned payment alert email:", err);
    }
  }
}

// Export singleton instance
export const schedulerService = new SchedulerService();
