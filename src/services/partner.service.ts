import { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "../config/supabase";
import { notificationService } from "./notification.services";

// =============================================================================
// Types
// =============================================================================

export interface Partner {
  id: string;
  user_id: string;
  code: string;
  commission_type: "percentage" | "flat";
  commission_value: number;
  status: "active" | "suspended" | "inactive";
  total_earnings: number;
  total_referrals: number;
  clicks: number;
  notes?: string;
  activated_at: string;
  created_at: string;
}

export interface PartnerWithUser extends Partner {
  user?: {
    id: string;
    name?: string;
    email?: string;
  };
}

export interface PartnerReferral {
  id: string;
  partner_id: string;
  referred_user_id?: string;
  referred_email?: string;
  status: "pending" | "signed_up" | "active";
  signed_up_at?: string;
  created_at: string;
}

export interface PartnerCommission {
  id: string;
  partner_id: string;
  referral_id: string;
  transaction_type: string;
  transaction_id?: string;
  transaction_amount: number;
  commission_amount: number;
  currency: string;
  status: "pending" | "approved" | "paid" | "rejected";
  paid_at?: string;
  created_at: string;
}

export interface PartnerDashboardData {
  partner: Partner;
  stats: {
    total_earnings: number;
    pending_earnings: number;
    total_referrals: number;
    active_referrals: number;
    clicks: number;
    conversion_rate: number;
  };
  recent_commissions: PartnerCommission[];
}

// =============================================================================
// Partner Service
// =============================================================================

export class PartnerService {
  constructor(private supabase: SupabaseClient) {}

  // ---------------------------------------------------------------------------
  // Code generation
  // ---------------------------------------------------------------------------

  private generateCode(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I,O,0,1
    let code = "";
    for (let i = 0; i < 8; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  // ---------------------------------------------------------------------------
  // Admin: Add partner
  // ---------------------------------------------------------------------------

  async addPartner(
    userId: string,
    commissionType: "percentage" | "flat" = "percentage",
    commissionValue: number = 10,
    notes?: string,
  ): Promise<Partner> {
    // Generate unique code
    let code = this.generateCode();
    let attempts = 0;
    while (attempts < 5) {
      const { data: existing } = await this.supabase
        .from("partners")
        .select("id")
        .eq("code", code)
        .maybeSingle();
      if (!existing) break;
      code = this.generateCode();
      attempts++;
    }

    const { data, error } = await this.supabase
      .from("partners")
      .insert([
        {
          user_id: userId,
          code,
          commission_type: commissionType,
          commission_value: commissionValue,
          notes,
        },
      ])
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  // ---------------------------------------------------------------------------
  // Admin: Send onboarding email
  // ---------------------------------------------------------------------------

  async sendOnboardingEmail(partner: Partner): Promise<void> {
    // Get user details
    const { data: user } = await supabaseAdmin
      .from("users")
      .select("name, email")
      .eq("id", partner.user_id)
      .single();

    if (!user?.email) return;

    const referralLink = `https://hilaq.com/?ref=${partner.code}`;

    await notificationService.createNotification({
      toEmail: user.email,
      emailName: user.name || "Partner",
      emailSubject: "Welcome to the Hilaq Partner Program! 🎉",
      emailBody: `
        <div style="font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Welcome to the Hilaq Partner Program!</h2>
          <p>Hi ${user.name || "Partner"},</p>
          <p>You've been accepted into the Hilaq Partner Program. Here's everything you need to get started:</p>
          
          <div style="background: #f7f7f7; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="margin-top: 0;">Your Referral Link</h3>
            <p style="font-size: 18px; font-weight: bold; color: #6366f1; word-break: break-all;">
              ${referralLink}
            </p>
            <p style="font-size: 14px; color: #666;">Your code: <strong>${partner.code}</strong></p>
          </div>

          <h3>Commission Structure</h3>
          <p>You'll earn <strong>${partner.commission_type === "percentage" ? partner.commission_value + "%" : "₦" + partner.commission_value}</strong> on every transaction made by users you refer.</p>
          
          <h3>How It Works</h3>
          <ol>
            <li>Share your referral link with potential users</li>
            <li>When they sign up using your link, they're added to your downline</li>
            <li>Earn commissions whenever they make a purchase (events, store, circles, etc.)</li>
            <li>Track everything from your Partner Dashboard</li>
          </ol>
          
          <h3>Tips for Success</h3>
          <ul>
            <li>Share on social media with a compelling message</li>
            <li>Target communities that would benefit from Hilaq's features</li>
            <li>Follow up with users who sign up to help them get started</li>
          </ul>
          
          <p>Access your Partner Dashboard anytime from the Hilaq settings.</p>
          <p>Best of luck! 🚀</p>
          <p>— The Hilaq Team</p>
        </div>
      `,
    });
  }

  // ---------------------------------------------------------------------------
  // Admin: Update partner status
  // ---------------------------------------------------------------------------

  async updatePartnerStatus(
    partnerId: string,
    status: "active" | "suspended" | "inactive",
  ): Promise<Partner> {
    const { data, error } = await this.supabase
      .from("partners")
      .update({ status })
      .eq("id", partnerId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  // ---------------------------------------------------------------------------
  // Admin: List all partners
  // ---------------------------------------------------------------------------

  async listAllPartners(
    page: number = 1,
    limit: number = 20,
  ): Promise<{ partners: PartnerWithUser[]; total: number }> {
    const offset = (page - 1) * limit;

    const {
      data: partners,
      error,
      count,
    } = await this.supabase
      .from("partners")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    const userIds = (partners || []).map((p) => p.user_id).filter(Boolean);
    let usersMap: Record<string, any> = {};
    if (userIds.length > 0) {
      const { data: users } = await this.supabase
        .from("users")
        .select("id, name, email")
        .in("id", userIds);
      users?.forEach((u) => {
        usersMap[u.id] = u;
      });
    }

    const enriched = (partners || []).map((p) => ({
      ...p,
      user: usersMap[p.user_id] || null,
    }));

    return { partners: enriched, total: count || 0 };
  }

  // ---------------------------------------------------------------------------
  // Partner: Get own profile
  // ---------------------------------------------------------------------------

  async getPartnerByUserId(userId: string): Promise<Partner | null> {
    const { data, error } = await this.supabase
      .from("partners")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  // ---------------------------------------------------------------------------
  // Partner: Check if user is partner
  // ---------------------------------------------------------------------------

  async isPartner(userId: string): Promise<boolean> {
    const partner = await this.getPartnerByUserId(userId);
    return !!partner;
  }

  // ---------------------------------------------------------------------------
  // Partner: Dashboard stats
  // ---------------------------------------------------------------------------

  async getPartnerDashboard(partnerId: string): Promise<PartnerDashboardData> {
    const { data: partner, error: pErr } = await this.supabase
      .from("partners")
      .select("*")
      .eq("id", partnerId)
      .single();

    if (pErr) throw pErr;

    // Count active referrals
    const { count: activeReferrals } = await this.supabase
      .from("partner_referrals")
      .select("id", { count: "exact", head: true })
      .eq("partner_id", partnerId)
      .eq("status", "active");

    // Pending earnings
    const { data: pendingData } = await this.supabase
      .from("partner_commissions")
      .select("commission_amount")
      .eq("partner_id", partnerId)
      .eq("status", "pending");

    const pendingEarnings = (pendingData || []).reduce(
      (sum, c) => sum + parseFloat(c.commission_amount || "0"),
      0,
    );

    // Recent commissions
    const { data: recentCommissions } = await this.supabase
      .from("partner_commissions")
      .select("*")
      .eq("partner_id", partnerId)
      .order("created_at", { ascending: false })
      .limit(10);

    const conversionRate =
      partner.clicks > 0 ? (partner.total_referrals / partner.clicks) * 100 : 0;

    return {
      partner,
      stats: {
        total_earnings: partner.total_earnings,
        pending_earnings: pendingEarnings,
        total_referrals: partner.total_referrals,
        active_referrals: activeReferrals || 0,
        clicks: partner.clicks,
        conversion_rate: Math.round(conversionRate * 100) / 100,
      },
      recent_commissions: recentCommissions || [],
    };
  }

  // ---------------------------------------------------------------------------
  // Partner: Downline (referred users)
  // ---------------------------------------------------------------------------

  async getDownline(
    partnerId: string,
    page: number = 1,
    limit: number = 20,
  ): Promise<{
    referrals: (PartnerReferral & { user?: any; earnings?: number })[];
    total: number;
  }> {
    const offset = (page - 1) * limit;

    const {
      data: referrals,
      error,
      count,
    } = await this.supabase
      .from("partner_referrals")
      .select("*", { count: "exact" })
      .eq("partner_id", partnerId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    // Fetch users manually
    const userIds = (referrals || [])
      .map((r) => r.referred_user_id)
      .filter(Boolean);
    let usersMap: Record<string, any> = {};
    if (userIds.length > 0) {
      const { data: users } = await this.supabase
        .from("users")
        .select("id, name, email")
        .in("id", userIds);
      users?.forEach((u) => {
        usersMap[u.id] = u;
      });
    }

    // Calculate earnings per referral
    const referralIds = (referrals || []).map((r) => r.id);
    let earningsByReferral: Record<string, number> = {};

    if (referralIds.length > 0) {
      const { data: commissions } = await this.supabase
        .from("partner_commissions")
        .select("referral_id, commission_amount")
        .in("referral_id", referralIds);

      (commissions || []).forEach((c) => {
        earningsByReferral[c.referral_id] =
          (earningsByReferral[c.referral_id] || 0) +
          parseFloat(c.commission_amount || "0");
      });
    }

    const enriched = (referrals || []).map((r) => ({
      ...r,
      user: usersMap[r.referred_user_id] || null,
      earnings: earningsByReferral[r.id] || 0,
    }));

    return { referrals: enriched, total: count || 0 };
  }

  // ---------------------------------------------------------------------------
  // Partner: Referral detail (user + commissions)
  // ---------------------------------------------------------------------------

  async getReferralDetail(
    partnerId: string,
    referralId: string,
  ): Promise<{
    referral: PartnerReferral & { user?: any };
    commissions: PartnerCommission[];
    total_earned: number;
  }> {
    const { data: referral, error: rErr } = await this.supabase
      .from("partner_referrals")
      .select("*")
      .eq("id", referralId)
      .eq("partner_id", partnerId)
      .single();

    if (rErr) throw rErr;

    const { data: commissions } = await this.supabase
      .from("partner_commissions")
      .select("*")
      .eq("referral_id", referralId)
      .order("created_at", { ascending: false });

    let user = null;
    if (referral?.referred_user_id) {
      const { data: u } = await this.supabase
        .from("users")
        .select("id, name, email")
        .eq("id", referral.referred_user_id)
        .single();
      user = u;
    }

    const totalEarned = (commissions || []).reduce(
      (sum, c) => sum + parseFloat(c.commission_amount || "0"),
      0,
    );

    return {
      referral: { ...referral, user },
      commissions: commissions || [],
      total_earned: totalEarned,
    };
  }

  // ---------------------------------------------------------------------------
  // Public: Track click
  // ---------------------------------------------------------------------------

  async trackClick(code: string): Promise<Partner | null> {
    const { data: partner } = await this.supabase
      .from("partners")
      .select("*")
      .eq("code", code)
      .eq("status", "active")
      .maybeSingle();

    if (!partner) return null;

    // Increment click count (use admin client to bypass RLS)
    const client = supabaseAdmin || this.supabase;
    await client
      .from("partners")
      .update({ clicks: (partner.clicks || 0) + 1 })
      .eq("id", partner.id);

    return partner;
  }

  // ---------------------------------------------------------------------------
  // Signup attribution: link new user to partner via ref code
  // ---------------------------------------------------------------------------

  async attributeSignup(
    code: string,
    referredUserId: string,
    referredEmail?: string,
  ): Promise<PartnerReferral | null> {
    // Find the partner by code
    const client = supabaseAdmin || this.supabase;
    const { data: partner } = await client
      .from("partners")
      .select("id")
      .eq("code", code)
      .eq("status", "active")
      .maybeSingle();

    if (!partner) return null;

    // Check if this user was already referred
    const { data: existing } = await client
      .from("partner_referrals")
      .select("id")
      .eq("partner_id", partner.id)
      .eq("referred_user_id", referredUserId)
      .maybeSingle();

    if (existing) return null; // Already attributed

    // Create referral record
    const { data: referral, error } = await client
      .from("partner_referrals")
      .insert([
        {
          partner_id: partner.id,
          referred_user_id: referredUserId,
          referred_email: referredEmail,
          status: "signed_up",
          signed_up_at: new Date().toISOString(),
        },
      ])
      .select()
      .single();

    if (error) {
      console.error("[PartnerService] attributeSignup error:", error);
      return null;
    }

    // Increment total_referrals
    await client
      .from("partners")
      .update({
        total_referrals:
          (
            await client
              .from("partner_referrals")
              .select("id", { count: "exact", head: true })
              .eq("partner_id", partner.id)
          ).count || 0,
      })
      .eq("id", partner.id);

    return referral;
  }

  // ---------------------------------------------------------------------------
  // Commission recording (called after any purchase by a referred user)
  // ---------------------------------------------------------------------------

  async recordCommission(
    buyerUserId: string,
    transactionType: string,
    transactionId: string | undefined,
    transactionAmount: number,
    currency: string = "NGN",
  ): Promise<PartnerCommission | null> {
    // Check if buyer is a referred user
    const client = supabaseAdmin || this.supabase;
    const { data: referral } = await client
      .from("partner_referrals")
      .select("id, partner_id")
      .eq("referred_user_id", buyerUserId)
      .maybeSingle();

    if (!referral) return null; // Not a referred user

    // Get partner commission terms
    const { data: partner } = await client
      .from("partners")
      .select("*")
      .eq("id", referral.partner_id)
      .single();

    if (!partner || partner.status !== "active") return null;

    // Calculate commission
    const commissionAmount =
      partner.commission_type === "percentage"
        ? (transactionAmount * partner.commission_value) / 100
        : partner.commission_value;

    // Insert commission record
    const { data: commission, error } = await client
      .from("partner_commissions")
      .insert([
        {
          partner_id: partner.id,
          referral_id: referral.id,
          transaction_type: transactionType,
          transaction_id: transactionId,
          transaction_amount: transactionAmount,
          commission_amount: Math.round(commissionAmount * 100) / 100,
          currency,
          status: "pending",
        },
      ])
      .select()
      .single();

    if (error) {
      console.error("[PartnerService] recordCommission error:", error);
      return null;
    }

    // Update total_earnings on partner
    await client
      .from("partners")
      .update({
        total_earnings:
          partner.total_earnings !== undefined
            ? parseFloat(String(partner.total_earnings)) +
              Math.round(commissionAmount * 100) / 100
            : Math.round(commissionAmount * 100) / 100,
      })
      .eq("id", partner.id);

    // Mark referral as active (has transactions)
    await client
      .from("partner_referrals")
      .update({ status: "active" })
      .eq("id", referral.id);

    return commission;
  }
}
