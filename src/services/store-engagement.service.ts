import { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "../config/supabase";
import { emailService } from "./email.service";
import { activationNudgeEmail } from "../utils/emailsTemplate";

type StoreNudgeType = "no_sales" | "inactive_activation";

interface StoreRecord {
  id: string;
  name: string;
  is_live: boolean | null;
  user_id: string;
  moderation_status: string | null;
}

interface StoreOwner {
  id: string;
  email: string | null;
  name: string | null;
  preferences: Record<string, unknown>;
}

interface NudgeEmail {
  subject: string;
  body: string;
}

const PAID_STORE_ORDER_STATUSES = ["paid", "fulfilled"];
const REJECTED_MODERATION_STATUS = "rejected";
const DASHBOARD_URL = "https://www.hilaq.com/dashboard";

/**
 * Monthly re-engagement nudges for store owners. Two audiences:
 *  - live stores that have never made a sale, gently encouraged to get going;
 *  - inactive stores, walked through the steps to open for business.
 *
 * Each owner receives at most one nudge per store per calendar month; the last
 * sent month is tracked in users.preferences so the monthly job is idempotent.
 */
export class StoreEngagementService {
  constructor(private supabase: SupabaseClient = supabaseAdmin) {}

  async processMonthlyStoreNudges(): Promise<void> {
    const stores = await this.loadStores();

    for (const store of stores) {
      try {
        await this.nudgeStore(store);
      } catch (error) {
        console.error(
          `[StoreEngagement] Failed to nudge store ${store.id}:`,
          error,
        );
      }
    }
  }

  private async loadStores(): Promise<StoreRecord[]> {
    const { data, error } = await this.supabase
      .from("stores")
      .select("id, name, is_live, user_id, moderation_status");

    if (error) throw error;
    return (data as StoreRecord[]) || [];
  }

  private async nudgeStore(store: StoreRecord): Promise<void> {
    if (store.moderation_status === REJECTED_MODERATION_STATUS) return;

    const owner = await this.loadOwner(store.user_id);
    if (!owner?.email) return;

    if (store.is_live) {
      if (await this.storeHasSales(store.id)) return;
      await this.sendNudge(owner, store.id, "no_sales", this.buildNoSalesEmail(store, owner));
      return;
    }

    await this.sendNudge(
      owner,
      store.id,
      "inactive_activation",
      this.buildActivationEmail(store, owner),
    );
  }

  private async loadOwner(userId: string): Promise<StoreOwner | null> {
    const { data, error } = await this.supabase
      .from("users")
      .select("id, email, name, preferences")
      .eq("id", userId)
      .single();

    if (error) {
      console.error(`[StoreEngagement] Failed to load owner ${userId}:`, error);
      return null;
    }

    return {
      id: data.id,
      email: data.email ?? null,
      name: data.name ?? null,
      preferences: (data.preferences as Record<string, unknown>) || {},
    };
  }

  private async storeHasSales(storeId: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from("store_orders")
      .select("id")
      .eq("store_id", storeId)
      .in("status", PAID_STORE_ORDER_STATUSES)
      .limit(1);

    if (error) throw error;
    return (data?.length ?? 0) > 0;
  }

  private async sendNudge(
    owner: StoreOwner,
    storeId: string,
    type: StoreNudgeType,
    email: NudgeEmail,
  ): Promise<void> {
    if (this.wasNudgedThisMonth(owner.preferences, storeId, type)) return;

    await emailService.send({
      to: owner.email!,
      subject: email.subject,
      body: email.body,
      type: "platform",
    });

    await this.recordNudgeSent(owner, storeId, type);
  }

  private wasNudgedThisMonth(
    preferences: Record<string, unknown>,
    storeId: string,
    type: StoreNudgeType,
  ): boolean {
    const sentLog = this.getStoreNudgeLog(preferences);
    return sentLog[storeId]?.[type] === currentMonthKey();
  }

  private async recordNudgeSent(
    owner: StoreOwner,
    storeId: string,
    type: StoreNudgeType,
  ): Promise<void> {
    const sentLog = this.getStoreNudgeLog(owner.preferences);
    const nextLog = {
      ...sentLog,
      [storeId]: { ...(sentLog[storeId] || {}), [type]: currentMonthKey() },
    };

    const { error } = await this.supabase
      .from("users")
      .update({
        preferences: { ...owner.preferences, store_nudges: nextLog },
      })
      .eq("id", owner.id);

    if (error) throw error;
  }

  private getStoreNudgeLog(
    preferences: Record<string, unknown>,
  ): Record<string, Partial<Record<StoreNudgeType, string>>> {
    const raw = preferences.store_nudges;
    if (!raw || typeof raw !== "object") return {};
    return raw as Record<string, Partial<Record<StoreNudgeType, string>>>;
  }

  private buildNoSalesEmail(store: StoreRecord, owner: StoreOwner): NudgeEmail {
    const ownerName = owner.name || "there";
    return {
      subject: `Your ${store.name} store is open — here's how the first sale usually comes in`,
      body: activationNudgeEmail({
        previewText:
          "Your store is live — one small step usually brings the first sale.",
        title: "You're one step from your first sale",
        body: `Hi ${ownerName}, your store ${store.name} is live and ready to take orders — the hard part is already behind you. In my experience the first sale almost always lands right after an owner puts their store link in front of real people. Pick one small move below today; momentum tends to follow quickly.`,
        ctaLabel: "Open your store dashboard",
        ctaUrl: DASHBOARD_URL,
        bullets: [
          "Share your store link on your WhatsApp status, a group, or your bio",
          "Feature one product you'd personally recommend to a friend",
          "Send a short note to anyone who has asked about your products",
        ],
      }),
    };
  }

  private buildActivationEmail(
    store: StoreRecord,
    owner: StoreOwner,
  ): NudgeEmail {
    const ownerName = owner.name || "there";
    return {
      subject: `${store.name} is almost ready — 3 quick steps to start selling`,
      body: activationNudgeEmail({
        previewText:
          "Three quick steps to open your store and start getting paid.",
        title: `Let's get ${store.name} open for business`,
        body: `Hi ${ownerName}, your store is set up but not live yet — and activating it usually takes just a few minutes. Once these three things are in place, customers can find you and pay you. No pressure; whenever you're ready, here's the shortest path.`,
        ctaLabel: "Finish setting up your store",
        ctaUrl: DASHBOARD_URL,
        bullets: [
          "Add your settlement account so your earnings reach your bank",
          "Add at least one product for customers to buy",
          "Switch your store to live from the dashboard",
        ],
      }),
    };
  }
}

function currentMonthKey(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

export const storeEngagementService = new StoreEngagementService();
