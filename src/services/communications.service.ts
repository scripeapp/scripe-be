import { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import {
  CommunicationDomain,
  CommunicationSender,
  DnsRecord,
  HILAQ_DEFAULT_SENDER,
} from "../types/communications";

/**
 * Communications Service - Manages domains and sender identities
 */
export class CommunicationsService {
  constructor(private supabase: SupabaseClient) {}

  // ============================================================================
  // Domains
  // ============================================================================

  /**
   * List all domains for a user
   */
  async getDomains(businessId: string): Promise<CommunicationDomain[]> {
    const { data, error } = await this.supabase
      .from("communication_domains")
      .select("*")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return (data as CommunicationDomain[]) || [];
  }

  /**
   * Add a new domain and generate DNS records
   */
  async addDomain(businessId: string, userId: string, domain: string): Promise<CommunicationDomain> {
    // Check if domain already exists
    const { data: existing } = await this.supabase
      .from("communication_domains")
      .select("id")
      .eq("business_id", businessId)
      .eq("domain", domain)
      .single();

    if (existing) {
      throw Object.assign(new Error("Domain already exists"), { statusCode: 400 });
    }

    // Generate DNS records for verification
    const dnsRecords = this.generateDnsRecords(domain);

    const now = new Date().toISOString();
    const newDomain = {
      id: randomUUID(),
      business_id: businessId,
      user_id: userId,
      domain,
      status: "pending",
      dns_records: dnsRecords,
      verified_at: null,
      last_verified_at: null,
      created_at: now,
      updated_at: now,
    };

    const { data, error } = await this.supabase
      .from("communication_domains")
      .insert([newDomain])
      .select("*")
      .single();

    if (error) throw error;
    return data as CommunicationDomain;
  }

  /**
   * Generate DNS records for a domain
   */
  private generateDnsRecords(domain: string): DnsRecord[] {
    // Generate a unique verification code
    const verificationCode = `hilaq-verification=${randomUUID().substring(0, 12)}`;
    
    // Generate a simple DKIM public key placeholder (in production, use actual keys)
    const dkimValue = `v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQ...`;

    return [
      {
        type: "TXT" as const,
        name: `_hilaq.${domain}`,
        value: verificationCode,
        verified: false,
      },
      {
        type: "TXT" as const,
        name: `hilaq._domainkey.${domain}`,
        value: dkimValue,
        verified: false,
      },
      {
        type: "TXT" as const,
        name: domain,
        value: "v=spf1 include:_spf.hilaq.com ~all",
        verified: false,
      },
    ];
  }

  /**
   * Verify DNS records for a domain using real DNS lookups
   */
  async verifyDomain(businessId: string, domainId: string): Promise<CommunicationDomain> {
    const { data: domain, error: findError } = await this.supabase
      .from("communication_domains")
      .select("*")
      .eq("id", domainId)
      .eq("business_id", businessId)
      .single();

    if (findError || !domain) {
      throw Object.assign(new Error("Domain not found"), { statusCode: 404 });
    }

    const dnsRecords = domain.dns_records as DnsRecord[];
    const updatedRecords: DnsRecord[] = [];

    // Verify each DNS record
    for (const record of dnsRecords) {
      if (record.type === "TXT") {
        const isVerified = await this.verifyTxtRecord(record.name, record.value);
        updatedRecords.push({
          ...record,
          verified: isVerified,
        });
      } else {
        // For non-TXT records, keep existing state
        updatedRecords.push(record);
      }
    }

    // Determine domain status based on verification results
    const allVerified = updatedRecords.every((r: DnsRecord) => r.verified);
    const anyVerified = updatedRecords.some((r: DnsRecord) => r.verified);

    let status: string;
    if (allVerified) {
      status = "verified";
    } else if (anyVerified) {
      status = "needs_attention";
    } else {
      status = "pending";
    }

    const now = new Date().toISOString();
    const { data: updated, error: updateError } = await this.supabase
      .from("communication_domains")
      .update({
        dns_records: updatedRecords,
        status,
        verified_at: allVerified && !domain.verified_at ? now : domain.verified_at,
        last_verified_at: now,
        updated_at: now,
      })
      .eq("id", domainId)
      .select("*")
      .single();

    if (updateError) throw updateError;
    return updated as CommunicationDomain;
  }

  /**
   * Verify a TXT record exists in DNS
   */
  private async verifyTxtRecord(hostname: string, expectedValue: string): Promise<boolean> {
    try {
      // Dynamic import for dns/promises (Node.js built-in)
      const dns = await import("dns");
      const { promisify } = await import("util");
      const resolveTxt = promisify(dns.resolveTxt);

      // Set a timeout for DNS resolution
      const timeoutPromise = new Promise<string[][]>((_, reject) => {
        setTimeout(() => reject(new Error("DNS timeout")), 5000);
      });

      const dnsPromise = resolveTxt(hostname);

      const records = await Promise.race([dnsPromise, timeoutPromise]);
      
      // DNS TXT records come back as array of arrays (each record can have multiple strings)
      // Flatten and check if any record contains or matches our expected value
      const flatRecords = records.flat();
      
      // Check for exact match or contains match
      const isVerified = flatRecords.some((record: string) => {
        // Exact match
        if (record === expectedValue) return true;
        // Contains match (useful for verification codes)
        if (record.includes(expectedValue.split("=")[1] || expectedValue)) return true;
        return false;
      });

      console.log(`[DNS Verify] ${hostname}: found ${flatRecords.length} TXT records, verified: ${isVerified}`);
      return isVerified;
    } catch (error: any) {
      // ENODATA means no TXT records found, ENOTFOUND means domain doesn't exist
      if (error.code === "ENODATA" || error.code === "ENOTFOUND") {
        console.log(`[DNS Verify] ${hostname}: no TXT records found`);
        return false;
      }
      console.warn(`[DNS Verify] ${hostname}: error - ${error.message}`);
      return false;
    }
  }

  /**
   * Delete a domain (fails if has active senders)
   */
  async deleteDomain(businessId: string, domainId: string): Promise<void> {
    // Check for active senders
    const { data: senders } = await this.supabase
      .from("communication_senders")
      .select("id")
      .eq("domain_id", domainId)
      .eq("is_active", true)
      .limit(1);

    if (senders && senders.length > 0) {
      throw Object.assign(
        new Error("Cannot delete domain with active senders. Deactivate or delete senders first."),
        { statusCode: 400 }
      );
    }

    const { error } = await this.supabase
      .from("communication_domains")
      .delete()
      .eq("id", domainId)
      .eq("business_id", businessId);

    if (error) throw error;
  }

  // ============================================================================
  // Senders
  // ============================================================================

  /**
   * List all senders for a user
   */
  async getSenders(businessId: string): Promise<CommunicationSender[]> {
    const { data, error } = await this.supabase
      .from("communication_senders")
      .select("*, domain:domain_id(*)")
      .eq("business_id", businessId)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: false });

    if (error) throw error;
    return (data as CommunicationSender[]) || [];
  }

  /**
   * Get default sender for a user
   */
  async getDefaultSender(businessId: string): Promise<Pick<CommunicationSender, "name" | "email"> & { id?: string }> {
    const { data: sender } = await this.supabase
      .from("communication_senders")
      .select("id, name, email")
      .eq("business_id", businessId)
      .eq("is_default", true)
      .eq("is_active", true)
      .single();

    if (sender) {
      return sender as Pick<CommunicationSender, "name" | "email"> & { id: string };
    }

    // Fallback to Hilaq default
    return HILAQ_DEFAULT_SENDER;
  }

  /**
   * Get a single sender by ID
   */
  async getSender(businessId: string, senderId: string): Promise<CommunicationSender> {
    const { data, error } = await this.supabase
      .from("communication_senders")
      .select("*, domain:domain_id(*)")
      .eq("id", senderId)
      .eq("business_id", businessId)
      .single();

    if (error || !data) {
      throw Object.assign(new Error("Sender not found"), { statusCode: 404 });
    }

    return data as CommunicationSender;
  }

  /**
   * Create a sender
   */
  async createSender(
    businessId: string,
    userId: string,
    data: {
      name: string;
      email: string;
      domain_id?: string;
    }
  ): Promise<CommunicationSender> {
    // Extract domain from email
    const emailDomain = data.email.split("@")[1];

    // If domain_id provided, verify it's verified
    if (data.domain_id) {
      const { data: domain } = await this.supabase
        .from("communication_domains")
        .select("domain, status")
        .eq("id", data.domain_id)
        .eq("business_id", businessId)
        .single();

      if (!domain) {
        throw Object.assign(new Error("Domain not found"), { statusCode: 404 });
      }

      if (domain.status !== "verified") {
        throw Object.assign(
          new Error("Domain must be verified before creating senders"),
          { statusCode: 400 }
        );
      }

      // Ensure email matches domain
      if (!emailDomain.endsWith(domain.domain)) {
        throw Object.assign(
          new Error(`Email must belong to verified domain: ${domain.domain}`),
          { statusCode: 400 }
        );
      }
    }

    // Check if any default exists
    const { data: existingDefault } = await this.supabase
      .from("communication_senders")
      .select("id")
      .eq("business_id", businessId)
      .eq("is_default", true)
      .limit(1);

    const isDefault = !existingDefault || existingDefault.length === 0;

    const now = new Date().toISOString();
    const newSender = {
      id: randomUUID(),
      business_id: businessId,
      user_id: userId,
      domain_id: data.domain_id || null,
      name: data.name,
      email: data.email,
      is_default: isDefault,
      is_active: true,
      used_by: [],
      created_at: now,
      updated_at: now,
    };

    const { data: sender, error } = await this.supabase
      .from("communication_senders")
      .insert([newSender])
      .select("*")
      .single();

    if (error) throw error;
    return sender as CommunicationSender;
  }

  /**
   * Update a sender
   */
  async updateSender(
    businessId: string,
    senderId: string,
    updates: Partial<{
      name: string;
      is_active: boolean;
      used_by: string[];
    }>
  ): Promise<CommunicationSender> {
    const { data, error } = await this.supabase
      .from("communication_senders")
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq("id", senderId)
      .eq("business_id", businessId)
      .select("*")
      .single();

    if (error) throw error;
    return data as CommunicationSender;
  }

  /**
   * Set a sender as default
   */
  async setDefaultSender(businessId: string, senderId: string): Promise<CommunicationSender> {
    // Verify sender exists and belongs to user
    const { data: sender, error: findError } = await this.supabase
      .from("communication_senders")
      .select("id, is_active")
      .eq("id", senderId)
      .eq("business_id", businessId)
      .single();

    if (findError || !sender) {
      throw Object.assign(new Error("Sender not found"), { statusCode: 404 });
    }

    if (!sender.is_active) {
      throw Object.assign(new Error("Cannot set inactive sender as default"), { statusCode: 400 });
    }

    // Unset previous default
    await this.supabase
      .from("communication_senders")
      .update({ is_default: false, updated_at: new Date().toISOString() })
      .eq("business_id", businessId)
      .eq("is_default", true);

    // Set new default
    const { data: updated, error: updateError } = await this.supabase
      .from("communication_senders")
      .update({
        is_default: true,
        updated_at: new Date().toISOString(),
      })
      .eq("id", senderId)
      .select("*")
      .single();

    if (updateError) throw updateError;
    return updated as CommunicationSender;
  }

  /**
   * Delete a sender
   */
  async deleteSender(businessId: string, senderId: string): Promise<void> {
    const { error } = await this.supabase
      .from("communication_senders")
      .delete()
      .eq("id", senderId)
      .eq("business_id", businessId);

    if (error) throw error;
  }

  // ============================================================================
  // Sender Resolution
  // ============================================================================

  /**
   * Resolve sender for any email operation
   * Priority: 1. Explicit sender_id, 2. Workspace default, 3. Hilaq fallback
   */
  async resolveSender(
    businessId: string,
    senderId?: string
  ): Promise<{ name: string; email: string; id?: string }> {
    // 1. Explicit sender_id if provided
    if (senderId) {
      try {
        const sender = await this.getSender(businessId, senderId);
        if (sender.is_active) {
          return { id: sender.id, name: sender.name, email: sender.email };
        }
      } catch {
        // Fall through to default
      }
    }

    // 2. Workspace default sender
    return this.getDefaultSender(businessId);
  }
}

export default CommunicationsService;
