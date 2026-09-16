import { supabaseAdmin } from "../config/supabase";
import { emailService, SendEmailOptions } from "./email.service";

export interface ScheduleEmailOptions extends Omit<SendEmailOptions, 'to'> {
  to: string;
  scheduledAt: Date;
  idempotencyKey?: string;
}

class ScheduledEmailService {
  /**
   * Schedule an email for later delivery
   */
  async schedule(options: ScheduleEmailOptions): Promise<void> {
    const { to, subject, body, type, businessId, scheduledAt, idempotencyKey } = options;

    console.log(`[ScheduledEmailService] Scheduling email to ${to} for ${scheduledAt.toISOString()}`);

    const payload = {
      recipient_email: to,
      subject,
      body,
      email_type: type,
      business_id: businessId,
      scheduled_at: scheduledAt.toISOString(),
      status: "pending",
      idempotency_key: idempotencyKey || null,
    };

    const { error } = idempotencyKey
      ? await supabaseAdmin
          .from("scheduled_emails")
          .upsert(payload as any, {
            onConflict: "idempotency_key",
            ignoreDuplicates: true,
          } as any)
      : await supabaseAdmin.from("scheduled_emails").insert([payload]);

    if (error) {
      console.error("[ScheduledEmailService] Failed to schedule email:", error);
      throw error;
    }
  }

  /**
   * Process emails that are due for delivery
   */
  async processDueEmails(): Promise<void> {
    const now = new Date().toISOString();

    // Fetch pending emails that are due
    const { data: dueEmails, error } = await supabaseAdmin
      .from("scheduled_emails")
      .select("*")
      .eq("status", "pending")
      .lte("scheduled_at", now)
      .limit(20); // Process in smaller batches to avoid cron-time email spikes

    if (error) {
      console.error("[ScheduledEmailService] Failed to fetch due emails:", error);
      return;
    }

    if (!dueEmails || dueEmails.length === 0) {
      return;
    }

    console.log(`[ScheduledEmailService] Found ${dueEmails.length} due emails to process`);

    for (const email of dueEmails) {
      // Atomically claim the email by updating status from 'pending' to 'processing'
      // This prevents race conditions when multiple instances run
      const { data: claimed, error: claimError } = await supabaseAdmin
        .from("scheduled_emails")
        .update({ status: "processing", updated_at: now })
        .eq("id", email.id)
        .eq("status", "pending") // Only claim if still pending
        .select("*")
        .single();

      // If the email was already claimed by another process, skip it
      if (claimError || !claimed) {
        console.log(`[ScheduledEmailService] Email ${email.id} already claimed by another process, skipping`);
        continue;
      }

      try {
        await emailService.send({
          to: email.recipient_email,
          subject: email.subject,
          body: email.body,
          type: email.email_type,
          businessId: email.business_id,
        });

        // Update status to sent
        await supabaseAdmin
          .from("scheduled_emails")
          .update({
            status: "sent",
            sent_at: new Date().toISOString(),
          })
          .eq("id", email.id);

        console.log(`[ScheduledEmailService] Successfully sent email ${email.id} to ${email.recipient_email}`);
      } catch (sendError: any) {
        console.error(`[ScheduledEmailService] Failed to send email ${email.id}:`, sendError);

        // Update status to failed and record error
        await supabaseAdmin
          .from("scheduled_emails")
          .update({
            status: "failed",
            error_message: sendError.message || String(sendError),
            retry_count: (email.retry_count || 0) + 1,
          })
          .eq("id", email.id);
      }
    }
  }
}

export const scheduledEmailService = new ScheduledEmailService();
export default ScheduledEmailService;
