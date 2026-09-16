import { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "../config/supabase";
import { emailService } from "./email.service";
import { activationNudgeEmail } from "../utils/emailsTemplate";

export type ActivationTaskId =
  | "setup_business_profile"
  | "setup_add_product"
  | "setup_create_circle"
  | "setup_create_event"
  | "setup_launch_campaign"
  | "setup_payouts";

export interface ActivationGuideTask {
  id: ActivationTaskId;
  completed: boolean;
  value?: number | null;
}

interface ActivationSignals {
  businessName: string;
  ownerUserId: string;
  ownerEmail: string | null;
  ownerName: string;
  hasBusinessProfile: boolean;
  hasPayouts: boolean;
  productCount: number;
  publishedProductCount: number;
  circleCount: number;
  publishedEventCount: number;
  audienceContactCount: number;
  sentCampaignCount: number;
  hasFirstSale: boolean;
}

interface ActivationGuidePayload {
  business: {
    id: string;
    name: string;
  };
  progress: {
    completed: number;
    total: number;
    percent: number;
  };
  tasks: ActivationGuideTask[];
  milestones: {
    has_first_sale: boolean;
    audience_contacts: number;
    sent_campaigns: number;
    published_products: number;
    published_events: number;
  };
}

type ActivationPrefs = Record<
  string,
  {
    [triggerId: string]: string;
  }
>;

const TASK_ORDER: ActivationTaskId[] = [
  "setup_business_profile",
  "setup_add_product",
  "setup_create_circle",
  "setup_create_event",
  "setup_launch_campaign",
  "setup_payouts",
];

export class ActivationGuideService {
  constructor(private supabase: SupabaseClient = supabaseAdmin) {}

  async getGuideForUser(
    userId: string,
    businessId: string,
  ): Promise<ActivationGuidePayload> {
    const business = await this.assertBusinessAccess(userId, businessId);
    const signals = await this.getSignals(businessId, business.owner_user_id);
    const tasks = this.buildTasks(signals);
    const completed = tasks.filter((task) => task.completed).length;

    return {
      business: {
        id: business.id,
        name: business.name,
      },
      progress: {
        completed,
        total: tasks.length,
        percent:
          tasks.length > 0 ? Math.round((completed / tasks.length) * 100) : 0,
      },
      tasks,
      milestones: {
        has_first_sale: signals.hasFirstSale,
        audience_contacts: signals.audienceContactCount,
        sent_campaigns: signals.sentCampaignCount,
        published_products: signals.publishedProductCount,
        published_events: signals.publishedEventCount,
      },
    };
  }

  async processActivationNudges(): Promise<void> {
    const { data: businesses, error } = await this.supabase
      .from("businesses")
      .select("id, name, owner_user_id");

    if (error) {
      console.error(
        "[ActivationGuideService] Failed to load businesses:",
        error,
      );
      return;
    }

    for (const business of businesses || []) {
      try {
        const signals = await this.getSignals(
          business.id,
          business.owner_user_id,
        );
        const tasks = this.buildTasks(signals);
        await this.sendNeededNudges(business.id, signals, tasks);
      } catch (err) {
        console.error(
          `[ActivationGuideService] Failed to process nudges for business ${business.id}:`,
          err,
        );
      }
    }
  }

  private async assertBusinessAccess(userId: string, businessId: string) {
    const { data: business, error } = await this.supabase
      .from("businesses")
      .select("id, name, owner_user_id")
      .eq("id", businessId)
      .single();

    if (error || !business) {
      throw Object.assign(new Error("Business not found"), { statusCode: 404 });
    }

    if (business.owner_user_id === userId) {
      return business;
    }

    const { data: membership, error: membershipError } = await this.supabase
      .from("memberships")
      .select("id, status")
      .eq("business_id", businessId)
      .eq("user_id", userId)
      .maybeSingle();

    if (membershipError) {
      throw membershipError;
    }

    if (!membership || membership.status !== "active") {
      throw Object.assign(
        new Error("You do not have access to this business"),
        {
          statusCode: 403,
        },
      );
    }

    return business;
  }

  private async getSignals(
    businessId: string,
    ownerUserId: string,
  ): Promise<ActivationSignals> {
    const { data: business, error: businessError } = await this.supabase
      .from("businesses")
      .select(
        "id, name, owner_user_id, description, logo_url, primary_color, support_email, paystack_subaccount_code",
      )
      .eq("id", businessId)
      .single();

    if (businessError || !business) {
      throw businessError || new Error("Business not found");
    }

    const { data: owner, error: ownerError } = await this.supabase
      .from("users")
      .select("id, email, name")
      .eq("id", ownerUserId)
      .single();

    if (ownerError || !owner) {
      throw ownerError || new Error("Business owner not found");
    }

    const { data: stores } = await this.supabase
      .from("stores")
      .select("id, is_live")
      .eq("business_id", businessId);

    const storeIds = (stores || []).map((store) => store.id);

    const { count: productCount } = storeIds.length
      ? await this.supabase
          .from("products")
          .select("id", { count: "exact", head: true })
          .in("store_id", storeIds)
      : { count: 0 };

    const { count: publishedProductCount } = storeIds.length
      ? await this.supabase
          .from("products")
          .select("id", { count: "exact", head: true })
          .in("store_id", storeIds)
          .eq("status", "published")
      : { count: 0 };

    const { count: circleCount } = await this.supabase
      .from("circles")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId);

    const { data: events } = await this.supabase
      .from("events")
      .select("id, status")
      .eq("business_id", businessId);

    const publishedEventCount =
      (events || []).filter((event) => event.status === "published").length ||
      0;
    const eventIds = (events || []).map((event) => event.id);

    const { count: audienceContactCount } = await this.supabase
      .from("crm_contacts_unified")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId);

    const { count: sentCampaignCount } = await this.supabase
      .from("campaigns")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId)
      .in("status", ["sending", "sent", "scheduled"]);

    const hasFirstSale = await this.hasFirstSale({
      businessId,
      storeIds,
      eventIds,
    });

    return {
      businessName: business.name,
      ownerUserId,
      ownerEmail: owner.email || null,
      ownerName: owner.name || "there",
      hasBusinessProfile: Boolean(
        business.description ||
        business.logo_url ||
        business.primary_color ||
        business.support_email,
      ),
      hasPayouts: Boolean(business.paystack_subaccount_code),
      productCount: productCount || 0,
      publishedProductCount: publishedProductCount || 0,
      circleCount: circleCount || 0,
      publishedEventCount,
      audienceContactCount: audienceContactCount || 0,
      sentCampaignCount: sentCampaignCount || 0,
      hasFirstSale,
    };
  }

  private buildTasks(signals: ActivationSignals): ActivationGuideTask[] {
    return [
      {
        id: "setup_business_profile",
        completed: signals.hasBusinessProfile,
      },
      {
        id: "setup_add_product",
        completed: signals.productCount > 0,
        value: signals.productCount,
      },
      {
        id: "setup_create_circle",
        completed: signals.circleCount > 0,
        value: signals.circleCount,
      },
      {
        id: "setup_create_event",
        completed: signals.publishedEventCount > 0,
        value: signals.publishedEventCount,
      },
      {
        id: "setup_launch_campaign",
        completed: signals.sentCampaignCount > 0,
        value: signals.sentCampaignCount,
      },
      {
        id: "setup_payouts",
        completed: signals.hasPayouts,
      },
    ];
  }

  private async hasFirstSale({
    businessId,
    storeIds,
    eventIds,
  }: {
    businessId: string;
    storeIds: string[];
    eventIds: string[];
  }): Promise<boolean> {
    const paidOrderStatuses = ["paid", "fulfilled"];

    if (storeIds.length) {
      const { count } = await this.supabase
        .from("orders")
        .select("id", { count: "exact", head: true })
        .in("store_id", storeIds)
        .in("status", paidOrderStatuses);

      if ((count || 0) > 0) return true;
    }

    if (eventIds.length) {
      const { count } = await this.supabase
        .from("orders")
        .select("id", { count: "exact", head: true })
        .in("event_id", eventIds)
        .in("status", paidOrderStatuses);

      if ((count || 0) > 0) return true;
    }

    const { data: publications } = await this.supabase
      .from("publications")
      .select("id")
      .eq("business_id", businessId);

    const publicationIds = (publications || []).map(
      (publication) => publication.id,
    );

    if (publicationIds.length) {
      const { count } = await this.supabase
        .from("subscriptions")
        .select("id", { count: "exact", head: true })
        .in("publication_id", publicationIds)
        .eq("subscription_type", "paid")
        .eq("status", "active");

      if ((count || 0) > 0) return true;
    }

    const { data: circles } = await this.supabase
      .from("circles")
      .select("id")
      .eq("business_id", businessId);

    const circleIds = (circles || []).map((circle) => circle.id);

    if (circleIds.length) {
      const { count } = await this.supabase
        .from("circle_subscriptions")
        .select("id", { count: "exact", head: true })
        .in("circle_id", circleIds)
        .eq("status", "active");

      if ((count || 0) > 0) return true;
    }

    return false;
  }

  private async sendNeededNudges(
    businessId: string,
    signals: ActivationSignals,
    tasks: ActivationGuideTask[],
  ): Promise<void> {
    if (!signals.ownerEmail) return;

    const prefs = await this.getUserPreferences(signals.ownerUserId);
    const activationPrefs = this.getActivationPrefs(prefs.preferences);

    const maybeSend = async (
      triggerId: string,
      subject: string,
      body: string,
    ) => {
      if (activationPrefs[businessId]?.[triggerId]) return;

      await emailService.send({
        to: signals.ownerEmail!,
        subject,
        body,
        type: "platform",
      });

      activationPrefs[businessId] = {
        ...(activationPrefs[businessId] || {}),
        [triggerId]: new Date().toISOString(),
      };

      await this.setActivationPrefs(
        signals.ownerUserId,
        prefs.preferences,
        activationPrefs,
      );
    };

    const setupCompletedCount = tasks.filter((task) => task.completed).length;

    if (setupCompletedCount === 0) {
      await maybeSend(
        "welcome_start_setup",
        `Start selling on Hilaq with ${signals.businessName}`,
        activationNudgeEmail({
          previewText: "Start with one revenue-ready setup step.",
          title: "Start with one thing",
          body: `Your business is ready on Hilaq. The fastest path to your first sale is to complete your setup, add an offer, and publish it.`,
          ctaLabel: "Open your setup guide",
          ctaUrl: "https://www.hilaq.com/dashboard",
          bullets: [
            "Complete your business profile",
            "Add your first product, event, or circle",
            "Set up payouts so you can receive money",
          ],
        }),
      );
    }

    if (
      !signals.hasPayouts &&
      (signals.publishedProductCount > 0 || signals.publishedEventCount > 0)
    ) {
      await maybeSend(
        "complete_payouts",
        "Complete payouts before your first sale lands",
        activationNudgeEmail({
          previewText:
            "Finish payout setup so you can settle revenue correctly.",
          title: "Complete your payouts",
          body: `You already have something live in ${signals.businessName}. Connect your payout details now so revenue can settle smoothly when customers start paying.`,
          ctaLabel: "Set up payouts",
          ctaUrl: "https://www.hilaq.com/dashboard?tab=settings&sub=payouts",
          bullets: [
            "Get paid without avoidable settlement delays",
            "Keep your checkout and sales flow fully ready",
          ],
        }),
      );
    }

    if (
      signals.audienceContactCount > 0 &&
      signals.sentCampaignCount === 0 &&
      (signals.publishedProductCount > 0 ||
        signals.publishedEventCount > 0 ||
        signals.circleCount > 0)
    ) {
      await maybeSend(
        "send_first_campaign",
        "You already have an audience. Send your first campaign.",
        activationNudgeEmail({
          previewText:
            "Turn existing audience contacts into your first buyers.",
          title: "Send your first campaign",
          body: `You already have ${signals.audienceContactCount} audience contact${signals.audienceContactCount === 1 ? "" : "s"} inside Hilaq. A simple launch campaign is often the quickest step between a live offer and a first sale.`,
          ctaLabel: "Create a campaign",
          ctaUrl: "https://www.hilaq.com/dashboard?tab=crm&sub=campaigns",
          bullets: [
            "Announce your live offer to people already in your audience",
            "Drive traffic back to your store, event, or circle",
          ],
        }),
      );
    }

    if (signals.hasFirstSale) {
      await maybeSend(
        "celebrate_first_sale",
        "You just crossed your first sale on Hilaq",
        activationNudgeEmail({
          previewText: "Keep momentum going with the next best growth step.",
          title: "Your first sale is in",
          body: `That first sale matters. Now is the right time to keep the momentum up by publishing another offer, sending a campaign, or turning buyers into repeat customers.`,
          ctaLabel: "Open dashboard",
          ctaUrl: "https://www.hilaq.com/dashboard",
          bullets: [
            "Create a second offer or follow-up event",
            "Send a campaign to drive the next round of conversions",
            "Review what worked and repeat it",
          ],
        }),
      );
    }
  }

  private async getUserPreferences(
    userId: string,
  ): Promise<{ preferences: Record<string, any> }> {
    const { data, error } = await this.supabase
      .from("users")
      .select("preferences")
      .eq("id", userId)
      .single();

    if (error) throw error;

    return {
      preferences: (data?.preferences as Record<string, any>) || {},
    };
  }

  private getActivationPrefs(
    preferences: Record<string, any>,
  ): ActivationPrefs {
    const raw = preferences.activation_nudges;
    if (!raw || typeof raw !== "object") return {};
    return raw as ActivationPrefs;
  }

  private async setActivationPrefs(
    userId: string,
    existingPreferences: Record<string, any>,
    activationPrefs: ActivationPrefs,
  ) {
    const nextPreferences = {
      ...existingPreferences,
      activation_nudges: activationPrefs,
    };

    const { error } = await this.supabase
      .from("users")
      .update({ preferences: nextPreferences })
      .eq("id", userId);

    if (error) throw error;
  }
}
