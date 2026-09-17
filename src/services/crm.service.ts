import { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import {
  Contact,
  Segment,
  SegmentWithCount,
  Campaign,
  CampaignStats,
} from "../types/crm";
import { supabaseAdmin } from "../config/supabaseAdmin";
import { CampaignCreditsService } from "./campaign-credits.service";

// Strip characters that PostgREST interprets as filter syntax (commas, parens, backslash)
// to prevent injected filters in .or() expressions used for search.
function sanitizeSearchTerm(term: string): string {
  return term.replace(/[,()\\]/g, "");
}

// Queue import - will be null if Redis not configured
import { isQStashAvailable, queueCampaignJob } from "../config/qstash";

/**
 * CRM Service
 * Class-based service for Contacts, Segments, and Campaigns
 */
class CRMService {
  constructor(private supabase: SupabaseClient) {}

  // ============================================================================
  // Contacts
  // ============================================================================

  /**
   * Get contacts with pagination and filtering
   * Includes both manually added contacts AND aggregated contacts from store orders, events, subscribers
   */
  async getContacts(
    businessId: string,
    userId: string,
    params: {
      page: number;
      limit: number;
      search?: string;
      status?: "marketing" | "transactional" | "unsubscribed" | "blocked";
      source?: "manual" | "store" | "event" | "publication" | "all";
    },
  ): Promise<{
    contacts: (Contact & { source?: string })[];
    total: number;
    page: number;
    limit: number;
  }> {
    const { page, limit, search, status, source = "all" } = params;
    const offset = (page - 1) * limit;

    // If requesting only manual contacts or a specific status filter, use contacts table
    if (source === "manual" || status) {
      let query = this.supabase
        .from("contacts")
        .select("*", { count: "exact" })
        .eq("business_id", businessId)
        .range(offset, offset + limit - 1)
        .order("created_at", { ascending: false });

      if (status) {
        query = query.eq("status", status);
      }

      if (search) {
        const s = sanitizeSearchTerm(search);
        query = query.or(`name.ilike.%${s}%,email.ilike.%${s}%`);
      }

      const { data, error, count } = await query;

      if (error) throw error;

      return {
        contacts: ((data as Contact[]) || []).map((c) => ({
          ...c,
          source: "manual",
        })),
        total: count || 0,
        page,
        limit,
      };
    }

    // Fetch from unified view for aggregated contacts
    let query = this.supabase
      .from("crm_contacts_unified")
      .select("*", { count: "exact" })
      .eq("business_id", businessId)
      .range(offset, offset + limit - 1)
      .order("updated_at", { ascending: false });

    if (source !== "all") {
      query = query.eq("source", source);
    }

    if (search) {
      const s = sanitizeSearchTerm(search);
      query = query.or(`name.ilike.%${s}%,email.ilike.%${s}%`);
    }

    const {
      data: aggregatedData,
      error: aggError,
      count: aggCount,
    } = await query;

    if (aggError) {
      // If view doesn't exist, fall back to manual contacts only
      console.warn(
        "crm_contacts_unified view not found, falling back to manual contacts:",
        aggError.message,
      );

      let fallbackQuery = this.supabase
        .from("contacts")
        .select("*", { count: "exact" })
        .eq("business_id", businessId)
        .range(offset, offset + limit - 1)
        .order("created_at", { ascending: false });

      if (search) {
        const s = sanitizeSearchTerm(search);
        fallbackQuery = fallbackQuery.or(
          `name.ilike.%${s}%,email.ilike.%${s}%`,
        );
      }

      const { data, error, count } = await fallbackQuery;

      if (error) throw error;

      return {
        contacts: ((data as Contact[]) || []).map((c) => ({
          ...c,
          source: "manual",
        })),
        total: count || 0,
        page,
        limit,
      };
    }

    // Batch persist unified contacts to contacts table to ensure stable IDs

    if (!aggregatedData || aggregatedData.length === 0) {
      return {
        contacts: [],
        total: aggCount || 0,
        page,
        limit,
      };
    }

    const contactsToUpsert = aggregatedData
      .filter((c) => c.email)
      .map((c) => ({
        business_id: businessId,
        email: c.email,
        name: c.name || "Unknown",
        phone: c.phone || null,
        status: "marketing",
        metadata: { source: c.source, auto_created: true },
        updated_at: new Date().toISOString(),
      }));

    const emails = contactsToUpsert.map((c) => c.email);

    // 1. Fetch existing (try exact matches first)
    // Note: We use ilike or simple equality? Supabase .in is exact.
    // For robustness, we'll try to match by lowercased email if possible, but .in() is strict.
    // So we'll rely on strict email matching for now, as emails should be canonical.
    const { data: existingContacts, error: fetchError } = await this.supabase
      .from("contacts")
      .select("*")
      .eq("business_id", businessId)
      .in("email", emails);

    if (fetchError) throw fetchError;

    // Use lowercased keys for map to be robust against casing differences
    const existingMap = new Map<string, Contact>();
    (existingContacts || []).forEach((c) =>
      existingMap.set(c.email.toLowerCase(), c),
    );

    // 2. Identify missing
    const newContacts: any[] = [];
    const now = new Date().toISOString();

    for (const c of contactsToUpsert) {
      if (!existingMap.has(c.email.toLowerCase())) {
        // Double check we haven't already added this email to newContacts queue
        // (aggregatedData should be distinct by email, but just in case)
        if (
          !newContacts.find(
            (nc) => nc.email.toLowerCase() === c.email.toLowerCase(),
          )
        ) {
          newContacts.push({
            business_id: businessId,
            user_id: userId, // Ensure userId is passed
            email: c.email,
            name: c.name,
            phone: c.phone,
            status: "marketing",
            metadata: c.metadata,
            created_at: now,
            updated_at: now,
          });
        }
      }
    }

    // 3. Insert missing
    if (newContacts.length > 0) {
      const { data: inserted, error: insertError } = await this.supabase
        .from("contacts")
        .insert(newContacts)
        .select("*");

      if (insertError) {
        console.warn("Batch insert error:", insertError.message);
        // Fallback: If insert fails, we might still want to return what we have (or re-fetch)
      } else if (inserted) {
        inserted.forEach((c: Contact) =>
          existingMap.set(c.email.toLowerCase(), c),
        );
      }
    }

    // 4. Construct response
    const finalContacts: (Contact & { source?: string })[] = [];
    for (const c of aggregatedData) {
      const emailLower = c.email?.toLowerCase();
      if (emailLower && existingMap.has(emailLower)) {
        finalContacts.push({
          ...existingMap.get(emailLower)!,
          source: c.source,
        });
      }
    }

    return {
      contacts: finalContacts,
      total: aggCount || 0,
      page,
      limit,
    };
  }

  /**
   * Create a new contact
   */
  async createContact(
    businessId: string,
    userId: string,
    data: {
      email: string;
      name: string;
      phone?: string;
      status?: "marketing" | "transactional" | "unsubscribed" | "blocked";
      segment_ids?: string[];
      metadata?: Record<string, any>;
    },
  ): Promise<Contact> {
    const now = new Date().toISOString();

    const newContact = {
      business_id: businessId,
      user_id: userId,
      email: data.email,
      name: data.name,
      phone: data.phone || null,
      status: data.status || "marketing",
      metadata: data.metadata || {},
      created_at: now,
      updated_at: now,
    };

    const { data: contact, error } = await this.supabase
      .from("contacts")
      .insert([newContact])
      .select("*")
      .single();

    if (error) {
      if (error.code === "23505") {
        // Unique constraint violation
        throw Object.assign(
          new Error("Contact with this email already exists"),
          {
            statusCode: 409,
          },
        );
      }
      throw error;
    }

    // Add to segments if specified
    if (data.segment_ids && data.segment_ids.length > 0) {
      await this.addContactsToSegment(businessId, contact.id, data.segment_ids);
    }

    return contact as Contact;
  }

  /**
   * Update a contact
   */
  async updateContact(
    businessId: string,
    contactId: string,
    updates: Partial<Pick<Contact, "name" | "phone" | "status" | "metadata">>,
  ): Promise<Contact> {
    // Verify ownership first
    const { data: existing, error: findError } = await this.supabase
      .from("contacts")
      .select("id")
      .eq("id", contactId)
      .eq("business_id", businessId)
      .single();

    if (findError || !existing) {
      throw Object.assign(new Error("Contact not found"), { statusCode: 404 });
    }

    const { data, error } = await this.supabase
      .from("contacts")
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq("id", contactId)
      .eq("business_id", businessId)
      .select("*")
      .single();

    if (error) throw error;
    return data as Contact;
  }

  /**
   * Get segments that a contact belongs to
   */
  async getContactSegments(
    businessId: string,
    contactId: string,
  ): Promise<{ segments: Segment[] }> {
    // Verify contact ownership
    const { data: contact, error: contactError } = await this.supabase
      .from("contacts")
      .select("id")
      .eq("id", contactId)
      .eq("business_id", businessId)
      .single();

    if (contactError || !contact) {
      throw Object.assign(new Error("Contact not found"), { statusCode: 404 });
    }

    // Get segment IDs from junction table
    const { data: contactSegments, error: csError } = await this.supabase
      .from("contact_segments")
      .select("segment_id")
      .eq("contact_id", contactId);

    if (csError) throw csError;

    if (!contactSegments || contactSegments.length === 0) {
      return { segments: [] };
    }

    const segmentIds = contactSegments.map((cs) => cs.segment_id);

    // Get full segment details
    const { data: segments, error: segmentsError } = await this.supabase
      .from("segments")
      .select("*")
      .eq("business_id", businessId)
      .in("id", segmentIds)
      .order("name", { ascending: true });

    if (segmentsError) throw segmentsError;

    return { segments: (segments as Segment[]) || [] };
  }

  /**
   * Get contact activities, transactions, subscriptions, and products
   * Aggregates data from store orders, subscriptions using the contact's email
   */
  async getContactActivities(businessId: string, contactId: string): Promise<{
    activities: any[];
    transactions: any[];
    subscriptions: any[];
    products: any[];
    analytics: { spent: number; pending: number };
  }> {
    // 1. Get the contact's email
    // RLS: contacts are scoped to business_id, so is_business_member check applies.
    const { data: contact } = await this.supabase
      .from("contacts")
      .select("id, email, name")
      .eq("id", contactId)
      .eq("business_id", businessId)
      .single();

    const contactEmail = contact?.email?.toLowerCase().trim();

    // 2. Fetch store orders for this contact's email
    // store_orders has no direct business_id — join through stores.
    // RLS policy "Business members can manage their orders" covers this.
    let storeOrders: any[] = [];
    if (contactEmail) {
      const { data: businessStores } = await this.supabase
        .from("stores")
        .select("id")
        .eq("business_id", businessId);
      const storeIds = (businessStores || []).map((s: any) => s.id);

      if (storeIds.length > 0) {
        const { data: orders } = await this.supabase
          .from("store_orders")
          .select("id, order_number, total, status, created_at, items, customer_name, store:stores(id, name, slug)")
          .in("store_id", storeIds)
          .ilike("customer_email", contactEmail)
          .order("created_at", { ascending: false });
        storeOrders = orders || [];
      }
    }

    // 3. Fetch user-linked subscriptions via user lookup. The subscriptions
    // table has permissive SELECT policies so this works with the
    // authenticated client. We do one user lookup then query subscriptions.
    let contactSubscriptions: any[] = [];

    if (contactEmail) {
      const { data: userRow } = await this.supabase
        .from("users")
        .select("id")
        .ilike("email", contactEmail)
        .single();

      if (userRow?.id) {
        // 3a. Newsletter subscriptions scoped to this business's publications
        const { data: bizPubs } = await this.supabase
          .from("publications")
          .select("id, name")
          .eq("business_id", businessId);
        const pubIds = (bizPubs || []).map((p: any) => p.id);

        if (pubIds.length > 0) {
          // Note: the timestamp column is `subscribed_at`, not `created_at`
          const { data: subs } = await this.supabase
            .from("subscriptions")
            .select("id, subscription_type, status, subscribed_at, publication:publications(id, name)")
            .eq("user_id", userRow.id)
            .in("publication_id", pubIds)
            .order("subscribed_at", { ascending: false });
          contactSubscriptions = (subs || []).map((s: any) => ({
            ...s,
            created_at: s.subscribed_at, // normalise field name for frontend
          }));
        }
      }
    }

    // 4. Fetch event tickets for this contact's email
    // RLS: "Allow all users to view all tickets" → USING (true), so no restriction.
    // We scope to this business by joining through events.
    let eventTickets: any[] = [];
    if (contactEmail) {
      // Get event IDs belonging to this business
      const { data: bizEvents } = await this.supabase
        .from("events")
        .select("id")
        .eq("business_id", businessId);
      const eventIds = (bizEvents || []).map((e: any) => e.id);

      if (eventIds.length > 0) {
        const { data: tickets } = await this.supabase
          .from("issued_tickets")
          .select("id, ticket_name, ticket_price, created_at, event:events(id, business_id)")
          .in("event_id", eventIds)
          .ilike("customer_email", contactEmail)
          .order("created_at", { ascending: false });
        eventTickets = tickets || [];
      }
    }

    // 5. Build transactions — store orders + event tickets combined
    const transactions = [
      ...storeOrders.map((order) => ({
        id: order.id,
        order_number: order.order_number || order.id.slice(0, 8).toUpperCase(),
        amount: Number(order.total || 0),
        status: order.status,
        created_at: order.created_at,
        store: order.store,
        type: "store" as const,
      })),
      ...eventTickets.map((ticket) => ({
        id: ticket.id,
        order_number: ticket.id.slice(0, 8).toUpperCase(),
        amount: Number(ticket.ticket_price || 0),
        status: "paid" as const,
        created_at: ticket.created_at,
        store: null,
        type: "event" as const,
        label: ticket.ticket_name || "Event Ticket",
      })),
    ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    // 6. Build products from store order items
    const productsMap = new Map<string, any>();
    storeOrders.forEach((order) => {
      const items: any[] = Array.isArray(order.items) ? order.items : [];
      items.forEach((item) => {
        const key = item.product_id || item.name;
        if (!productsMap.has(key)) {
          productsMap.set(key, {
            id: item.product_id || key,
            name: item.name || item.title || "Product",
            price: Number(item.price || item.unit_price || 0),
            quantity: item.quantity || 1,
            purchased_at: order.created_at,
            order_id: order.id,
          });
        }
      });
    });
    // Also include event tickets as products
    eventTickets.forEach((ticket) => {
      const key = `ticket-${ticket.id}`;
      productsMap.set(key, {
        id: key,
        name: ticket.ticket_name || "Event Ticket",
        price: Number(ticket.ticket_price || 0),
        quantity: 1,
        purchased_at: ticket.created_at,
        order_id: ticket.id,
      });
    });
    const products = Array.from(productsMap.values());

    // 7. Build activities timeline (store orders + event tickets + subscriptions)
    const activities: any[] = [
      ...storeOrders.map((order) => ({
        id: `order-${order.id}`,
        type: "purchase" as const,
        description: `Placed order ${order.order_number || "#" + order.id.slice(0, 8).toUpperCase()} · NGN ${Number(order.total || 0).toLocaleString()}`,
        created_at: order.created_at,
      })),
      ...eventTickets.map((ticket) => ({
        id: `ticket-${ticket.id}`,
        type: "event" as const,
        description: `Purchased ticket: ${ticket.ticket_name || "Event Ticket"} · NGN ${Number(ticket.ticket_price || 0).toLocaleString()}`,
        created_at: ticket.created_at,
      })),
      ...contactSubscriptions.map((sub) => ({
        id: `sub-${sub.id}`,
        type: "subscription" as const,
        description: `Subscribed to ${(sub.publication as any)?.name || "a publication"} (${sub.subscription_type})`,
        created_at: sub.created_at,
      })),
    ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    // 8. Analytics — total spent across orders and tickets
    const spent =
      storeOrders
        .filter((o) => ["paid", "fulfilled"].includes(o.status))
        .reduce((sum, o) => sum + Number(o.total || 0), 0) +
      eventTickets.reduce((sum, t) => sum + Number(t.ticket_price || 0), 0);
    const pending = storeOrders
      .filter((o) => ["pending", "processing"].includes(o.status))
      .reduce((sum, o) => sum + Number(o.total || 0), 0);

    return { activities, transactions, subscriptions: contactSubscriptions, products, analytics: { spent, pending } };
  }

  /**
   * Delete a contact
   */
  async deleteContact(businessId: string, contactId: string): Promise<void> {
    const { error } = await this.supabase
      .from("contacts")
      .delete()
      .eq("id", contactId)
      .eq("business_id", businessId);

    if (error) throw error;
  }

  /**
   * Bulk contact operations
   */
  async bulkContactAction(
    businessId: string,
    action: "delete" | "update_status",
    contactIds: string[],
    status?: "marketing" | "transactional" | "unsubscribed" | "blocked",
  ): Promise<{ affected: number }> {
    if (action === "delete") {
      const { error, count } = await this.supabase
        .from("contacts")
        .delete()
        .eq("business_id", businessId)
        .in("id", contactIds);

      if (error) throw error;
      return { affected: count || 0 };
    }

    if (action === "update_status" && status) {
      const { error, count } = await this.supabase
        .from("contacts")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("business_id", businessId)
        .in("id", contactIds);

      if (error) throw error;
      return { affected: count || 0 };
    }

    throw Object.assign(new Error("Invalid bulk action"), { statusCode: 400 });
  }

  /**
   * Import contacts from CSV (bulk upload)
   * Handles duplicate detection, validation, and source tracking
   */
  async importContacts(
    businessId: string,
    userId: string,
    data: {
      contacts: Array<{
        name: string;
        email: string;
        phone?: string | null;
        status?: "marketing" | "transactional" | "unsubscribed" | "blocked";
      }>;
      options?: { skip_duplicates?: boolean; update_existing?: boolean };
    },
  ): Promise<{
    imported: number;
    skipped: number;
    failed: number;
    total: number;
    errors: Array<{ row: number; email: string; error: string }>;
    imported_contacts: Array<{ id?: string; email: string; name: string }>;
  }> {
    const options = {
      skip_duplicates: data.options?.skip_duplicates ?? true,
      update_existing: data.options?.update_existing ?? false,
    };

    const now = new Date().toISOString();
    const importBatchId = randomUUID();

    const errors: Array<{ row: number; email: string; error: string }> = [];
    const importedContacts: Array<{
      id?: string;
      email: string;
      name: string;
    }> = [];
    let imported = 0;
    let skipped = 0;
    let failed = 0;

    // Extract all emails for duplicate checking
    const emails = data.contacts.map((c) => c.email.toLowerCase().trim());

    // Fetch existing contacts by email
    const { data: existingContacts, error: fetchError } = await this.supabase
      .from("contacts")
      .select("id, email, name, phone, status")
      .eq("business_id", businessId)
      .in("email", emails);

    if (fetchError) throw fetchError;

    const existingMap = new Map<
      string,
      {
        id: string;
        email: string;
        name: string;
        phone: string | null;
        status: string;
      }
    >();
    (existingContacts || []).forEach((c) =>
      existingMap.set(c.email.toLowerCase(), c),
    );

    // Process each contact
    const toInsert: any[] = [];
    const toUpdate: { id: string; updates: any }[] = [];

    for (let i = 0; i < data.contacts.length; i++) {
      const contact = data.contacts[i];
      const emailLower = contact.email.toLowerCase().trim();

      // Check for duplicate in this batch (by email)
      const isDuplicateInBatch = data.contacts
        .slice(0, i)
        .some((c) => c.email.toLowerCase().trim() === emailLower);

      if (isDuplicateInBatch) {
        errors.push({
          row: i,
          email: contact.email,
          error: "Duplicate email in this import batch",
        });
        failed++;
        continue;
      }

      // Check if contact already exists
      const existing = existingMap.get(emailLower);

      if (existing) {
        if (options.update_existing) {
          // Update existing contact
          toUpdate.push({
            id: existing.id,
            updates: {
              name: contact.name,
              phone: contact.phone || existing.phone,
              status: contact.status || existing.status,
              updated_at: now,
            },
          });
          importedContacts.push({ email: existing.email, name: contact.name });
          imported++;
        } else if (options.skip_duplicates) {
          // Skip duplicate
          skipped++;
        } else {
          // Return error for duplicate
          errors.push({
            row: i,
            email: contact.email,
            error: "Contact already exists",
          });
          failed++;
        }
      } else {
        toInsert.push({
          business_id: businessId,
          user_id: userId,
          email: contact.email.trim(),
          name: contact.name.trim(),
          phone: contact.phone?.trim() || null,
          status: contact.status || "marketing",
          metadata: {
            source: "import",
            import_date: now,
            import_batch_id: importBatchId,
          },
          created_at: now,
          updated_at: now,
        });
        importedContacts.push({ email: contact.email, name: contact.name });
      }
    }

    // Batch insert new contacts
    if (toInsert.length > 0) {
      const { error: insertError } = await this.supabase
        .from("contacts")
        .insert(toInsert);

      if (insertError) {
        // Handle partial failure - some might have been inserted
        console.error(
          "[importContacts] Batch insert error:",
          insertError.message,
        );
        throw Object.assign(
          new Error("Failed to import contacts: " + insertError.message),
          { statusCode: 500 },
        );
      }
      imported += toInsert.length;
    }

    // Update existing contacts (if update_existing is true)
    for (const { id, updates } of toUpdate) {
      const { error: updateError } = await this.supabase
        .from("contacts")
        .update(updates)
        .eq("id", id)
        .eq("business_id", businessId);

      if (updateError) {
        console.warn(
          "[importContacts] Update error for",
          id,
          ":",
          updateError.message,
        );
      }
    }

    console.log(
      `[importContacts] Batch ${importBatchId}: imported=${imported}, skipped=${skipped}, failed=${failed}, total=${data.contacts.length}`,
    );

    return {
      imported,
      skipped,
      failed,
      total: data.contacts.length,
      errors,
      imported_contacts: importedContacts,
    };
  }

  // ============================================================================
  // Segments
  // ============================================================================

  /**
   * Get all segments with contact counts
   */
  async getSegments(businessId: string): Promise<SegmentWithCount[]> {
    // Get segments
    const { data: segments, error } = await this.supabase
      .from("segments")
      .select("*")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return segments as SegmentWithCount[];
  }

  /**
   * Create a segment (enhanced for dynamic segments)
   */
  async createSegment(
    businessId: string,
    userId: string,
    data: {
      name: string;
      description?: string;
      type?: "dynamic" | "static";
      track_membership_changes?: boolean;
      logic?: "AND" | "OR";
      groups?: any[];
      filters?: Record<string, any>;
    },
  ): Promise<Segment> {
    const now = new Date().toISOString();

    // Calculate contact count for dynamic segments
    let contactCount = 0;
    let initialContacts: string[] = [];

    if (data.type === "dynamic" && data.groups && data.groups.length > 0) {
      const { evaluateSegmentConditions } = await import("./segment-evaluator");

      try {
        const result = await evaluateSegmentConditions(
          this.supabase,
          businessId,
          data.logic || "AND",
          data.groups,
          { countOnly: false },
        );
        contactCount = result.count;
        initialContacts = result.sample.map((c: any) => c.id);
        const initialContactsData = result.sample;

        const { data: segment, error } = await this.supabase
          .from("segments")
          .insert([
            {
              business_id: businessId,
              user_id: userId,
              name: data.name,
              description: data.description || null,
              type: data.type || "static",
              track_membership_changes: data.track_membership_changes || false,
              logic: data.logic || "AND",
              groups: data.groups || [],
              filters: data.filters || {},
              contact_count: contactCount,
              created_at: now,
              updated_at: now,
            },
          ])
          .select("*")
          .single();

        if (error) throw error;

        if (initialContacts.length > 0 && segment) {
          await this.addContactsToSegment(businessId, segment.id, initialContacts, {
            userId,
            contactsData: initialContactsData,
          });
        }

        return segment as Segment;
      } catch (err: any) {
        throw Object.assign(
          new Error(
            err?.message || "Failed to evaluate dynamic segment conditions",
          ),
          { statusCode: err?.statusCode || 500 },
        );
      }
    }

    const newSegment = {
      business_id: businessId,
      user_id: userId,
      name: data.name,
      description: data.description || null,
      type: data.type || "static",
      track_membership_changes: data.track_membership_changes || false,
      logic: data.logic || "AND",
      groups: data.groups || [],
      filters: data.filters || {},
      contact_count: contactCount,
      created_at: now,
      updated_at: now,
    };

    const { data: segment, error } = await this.supabase
      .from("segments")
      .insert([newSegment])
      .select("*")
      .single();

    if (error) throw error;
    return segment as Segment;
  }

  /**
   * Update a segment (enhanced for dynamic segments)
   */
  async updateSegment(
    businessId: string,
    segmentId: string,
    updates: Partial<
      Pick<
        Segment,
        | "name"
        | "description"
        | "type"
        | "track_membership_changes"
        | "logic"
        | "groups"
        | "filters"
      >
    >,
  ): Promise<Segment> {
    // Verify ownership
    const { data: existing, error: findError } = await this.supabase
      .from("segments")
      .select("*")
      .eq("id", segmentId)
      .eq("business_id", businessId)
      .single();

    if (findError || !existing) {
      throw Object.assign(new Error("Segment not found"), { statusCode: 404 });
    }

    let contactCount = existing.contact_count || 0;
    let contactsToSync: string[] = [];
    let contactsDataToSync: any[] = [];
    let shouldSyncContacts = false;

    const segmentType = updates.type || existing.type;
    const segmentLogic = updates.logic || existing.logic || "AND";
    const segmentGroups = updates.groups || existing.groups || [];

    // Check if dynamic definition changed
    if (
      segmentType === "dynamic" &&
      (updates.groups || updates.logic || updates.type)
    ) {
      shouldSyncContacts = true;
      const { evaluateSegmentConditions } = await import("./segment-evaluator");

      try {
        const result = await evaluateSegmentConditions(
          this.supabase,
          businessId,
          segmentLogic,
          segmentGroups,
          { countOnly: false },
        );
        contactCount = result.count;
        contactsToSync = result.sample.map((c: any) => c.id);
        contactsDataToSync = result.sample;
      } catch (err: any) {
        throw Object.assign(
          new Error(
            err?.message || "Failed to recalculate dynamic segment membership",
          ),
          { statusCode: err?.statusCode || 500 },
        );
      }
    }

    const { data, error } = await this.supabase
      .from("segments")
      .update({
        ...updates,
        contact_count: contactCount,
        updated_at: new Date().toISOString(),
      })
      .eq("id", segmentId)
      .eq("business_id", businessId)
      .select("*")
      .single();

    if (error) throw error;

    // Sync contacts for dynamic segments if definition changed
    if (shouldSyncContacts) {
      // Clear existing contacts
      await this.supabase
        .from("contact_segments")
        .delete()
        .eq("segment_id", segmentId);

      // Add new contacts
      if (contactsToSync.length > 0) {
        // We do NOT catch and swallow errors here anymore.
        // If the migration isn't run, this will throw the DB constraint error back to the UI.
        await this.addContactsToSegment(businessId, segmentId, contactsToSync, {
          userId: existing.user_id,
          contactsData: contactsDataToSync,
        });
      }
    }

    return data as Segment;
  }

  /**
   * Preview segment - evaluate conditions without saving
   */
  async previewSegment(
    businessId: string,
    data: {
      logic: "AND" | "OR";
      groups: any[];
    },
  ): Promise<{ count: number; sample: any[] }> {
    const { evaluateSegmentConditions } = await import("./segment-evaluator");

    return evaluateSegmentConditions(
      this.supabase,
      businessId,
      data.logic,
      data.groups,
      { limit: 5, countOnly: false },
    );
  }

  /**
   * Get contacts belonging to a segment
   */
  /**
   * Lowercased emails of every contact in a segment, for membership checks
   * (e.g. tiered event pricing). Empty set when the segment has no contacts.
   */
  async getSegmentMemberEmails(
    businessId: string,
    segmentId: string,
  ): Promise<Set<string>> {
    const { data: contactSegments, error: csError } = await this.supabase
      .from("contact_segments")
      .select("contact_id")
      .eq("segment_id", segmentId);

    if (csError) throw csError;
    if (!contactSegments || contactSegments.length === 0) return new Set();

    const contactIds = contactSegments.map((cs) => cs.contact_id);
    const { data: contacts, error } = await this.supabase
      .from("crm_contacts_unified")
      .select("email")
      .eq("business_id", businessId)
      .in("id", contactIds);

    if (error) throw error;

    return new Set(
      (contacts || [])
        .map((contact) => contact.email?.toLowerCase())
        .filter((email): email is string => !!email),
    );
  }

  async getSegmentContacts(
    businessId: string,
    segmentId: string,
    params: { page?: number; limit?: number; search?: string } = {},
  ): Promise<{
    contacts: Contact[];
    total: number;
    page: number;
    limit: number;
  }> {
    const { page = 1, limit = 50, search } = params;
    const offset = (page - 1) * limit;

    // Verify segment ownership
    const { data: segment, error: segmentError } = await this.supabase
      .from("segments")
      .select("id")
      .eq("id", segmentId)
      .eq("business_id", businessId)
      .single();

    if (segmentError || !segment) {
      throw Object.assign(new Error("Segment not found"), { statusCode: 404 });
    }

    // Get contact IDs from junction table
    const { data: contactSegments, error: csError } = await this.supabase
      .from("contact_segments")
      .select("contact_id")
      .eq("segment_id", segmentId);

    if (csError) throw csError;

    if (!contactSegments || contactSegments.length === 0) {
      return { contacts: [], total: 0, page, limit };
    }

    const contactIds = contactSegments.map((cs) => cs.contact_id);

    // Get full contact details from unified view
    let query = this.supabase
      .from("crm_contacts_unified")
      .select("*", { count: "exact" })
      .eq("business_id", businessId)
      .in("id", contactIds)
      .order("created_at", { ascending: false });

    if (search) {
      const s = sanitizeSearchTerm(search);
      query = query.or(`name.ilike.%${s}%,email.ilike.%${s}%`);
    }

    const {
      data: contacts,
      error: contactsError,
      count,
    } = await query.range(offset, offset + limit - 1);

    if (contactsError) throw contactsError;

    return {
      contacts: (contacts as Contact[]) || [],
      total: count || 0,
      page,
      limit,
    };
  }

  /**
   * Delete a segment
   */
  async deleteSegment(businessId: string, segmentId: string): Promise<void> {
    const { error } = await this.supabase
      .from("segments")
      .delete()
      .eq("id", segmentId)
      .eq("business_id", businessId);

    if (error) throw error;
  }

  /**
   * Add contacts to a segment
   * Supports both manual contacts (from contacts table) and unified contacts (from view)
   * Uses email-based matching for unified contacts since view generates random IDs
   */
  async addContactsToSegment(
    businessId: string,
    segmentId: string,
    contactIds: string[],
    options: { userId?: string; contactsData?: any[] } = {},
  ): Promise<{ added: number }> {
    console.log("[addContactsToSegment] Input:", {
      businessId,
      segmentId,
      contactIdsCount: contactIds.length,
    });

    if (!contactIds || contactIds.length === 0) {
      return { added: 0 };
    }

    // Verify segment ownership
    const { data: segment, error: segmentError } = await this.supabase
      .from("segments")
      .select("id, user_id")
      .eq("id", segmentId)
      .eq("business_id", businessId)
      .single();

    if (segmentError || !segment) {
      console.log("[addContactsToSegment] Segment not found:", segmentError);
      throw Object.assign(new Error("Segment not found"), { statusCode: 404 });
    }

    // Since the database constraint has been decoupled, we map the unified IDs directly
    // into the contact_segments junction table without looping them sequentially into the manual contacts table.
    const records = contactIds.map((contactId) => ({
      contact_id: contactId,
      segment_id: segmentId,
    }));

    // Batch upsert into junction table. Because segments can be huge (5000+),
    // we split this into chunks to guarantee it hits DB reliably without timing out or facing query limits.
    const CHUNK_SIZE = 500;
    for (let i = 0; i < records.length; i += CHUNK_SIZE) {
      const chunk = records.slice(i, i + CHUNK_SIZE);
      const { error } = await this.supabase
        .from("contact_segments")
        .upsert(chunk, { onConflict: "contact_id,segment_id" });

      if (error) {
        console.warn(
          "[addContactsToSegment] Insert chunk error:",
          error.message,
        );
        throw error;
      }
    }

    // Refresh segment count
    const { count: newCount } = await this.supabase
      .from("contact_segments")
      .select("*", { count: "exact", head: true })
      .eq("segment_id", segmentId);

    await this.supabase
      .from("segments")
      .update({
        contact_count: newCount || 0,
        updated_at: new Date().toISOString(),
      })
      .eq("id", segmentId);

    // Log activity
    await this.logSegmentActivity(segmentId, "contacts_added", {
      count: contactIds.length,
      contact_ids: contactIds,
    });

    return { added: contactIds.length };
  }

  /**
   * Get segment activity log
   */
  async getSegmentActivity(
    businessId: string,
    segmentId: string,
  ): Promise<{
    activity: { id: string; event: string; date: string }[];
    analytics: { campaigns_sent: number };
  }> {
    // Verify segment ownership and get segment data
    const { data: segment, error: segmentError } = await this.supabase
      .from("segments")
      .select("id, created_at, updated_at")
      .eq("id", segmentId)
      .eq("business_id", businessId)
      .single();

    if (segmentError || !segment) {
      throw Object.assign(new Error("Segment not found"), { statusCode: 404 });
    }

    // Get activity logs
    const { data: activityLogs, error: activityError } = await this.supabase
      .from("segment_activity")
      .select("*")
      .eq("segment_id", segmentId)
      .order("created_at", { ascending: false })
      .limit(50);

    const activity: { id: string; event: string; date: string }[] = [];

    // Add logged activities
    if (!activityError && activityLogs) {
      for (const log of activityLogs) {
        let eventText = "";
        switch (log.event_type) {
          case "contacts_added":
            eventText = `${log.event_data?.count || 1} contact(s) added to segment`;
            break;
          case "contacts_removed":
            eventText = `${log.event_data?.count || 1} contact(s) removed from segment`;
            break;
          case "segment_updated":
            eventText = "Segment updated";
            break;
          case "campaign_sent":
            eventText = `Campaign "${log.event_data?.campaign_name || ""}" sent to segment`;
            break;
          default:
            eventText = log.event_type;
        }
        activity.push({
          id: log.id,
          event: eventText,
          date: log.created_at,
        });
      }
    }

    // Add "Segment created" event from segment.created_at
    activity.push({
      id: `created-${segment.id}`,
      event: "Segment created",
      date: segment.created_at,
    });

    // Sort by date descending
    activity.sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );

    // Count campaigns sent to this segment
    const { count: campaignsSent } = await this.supabase
      .from("campaigns")
      .select("*", { count: "exact", head: true })
      .eq("business_id", businessId)
      .eq("status", "sent")
      .contains("segment_ids", [segmentId]);

    return {
      activity,
      analytics: {
        campaigns_sent: campaignsSent || 0,
      },
    };
  }

  /**
   * Helper to log segment activity
   */
  private async logSegmentActivity(
    segmentId: string,
    eventType: string,
    eventData: Record<string, any> = {},
  ): Promise<void> {
    try {
      await this.supabase.from("segment_activity").insert({
        segment_id: segmentId,
        event_type: eventType,
        event_data: eventData,
      });
    } catch (err) {
      console.warn("Failed to log segment activity:", err);
      // Don't throw - activity logging is non-critical
    }
  }

  /**
   * Remove contacts from a segment
   */
  async removeContactsFromSegment(
    businessId: string,
    segmentId: string,
    contactIds: string[],
  ): Promise<{ removed: number }> {
    // Verify segment ownership
    const { data: segment, error: segmentError } = await this.supabase
      .from("segments")
      .select("id")
      .eq("id", segmentId)
      .eq("business_id", businessId)
      .single();

    if (segmentError || !segment) {
      throw Object.assign(new Error("Segment not found"), { statusCode: 404 });
    }

    const { error, count } = await this.supabase
      .from("contact_segments")
      .delete()
      .eq("segment_id", segmentId)
      .in("contact_id", contactIds);

    if (error) throw error;

    const removedCount = count || 0;

    if (removedCount > 0) {
      // 1. Log activity
      await this.logSegmentActivity(segmentId, "contacts_removed", {
        count: removedCount,
        contact_ids: contactIds,
      });

      // 2. Refresh count
      const { count: newCount } = await this.supabase
        .from("contact_segments")
        .select("*", { count: "exact", head: true })
        .eq("segment_id", segmentId);

      await this.supabase
        .from("segments")
        .update({
          contact_count: newCount || 0,
          updated_at: new Date().toISOString(),
        })
        .eq("id", segmentId);
    }

    return { removed: removedCount };
  }

  /**
   * Helper to add a single contact to multiple segments
   */
  // private async addContactToSegments(
  //   userId: string,
  //   contactId: string,
  //   segmentIds: string[],
  // ): Promise<void> {
  //   // Verify segments belong to user
  //   const { data: segments } = await this.supabase
  //     .from("segments")
  //     .select("id")
  //     .eq("user_id", userId)
  //     .in("id", segmentIds);

  //   const validSegmentIds = (segments || []).map((s) => s.id);

  //   if (validSegmentIds.length === 0) return;

  //   const records = validSegmentIds.map((segmentId) => ({
  //     contact_id: contactId,
  //     segment_id: segmentId,
  //   }));

  //   await this.supabase.from("contact_segments").insert(records);
  // }

  // ============================================================================
  // Campaigns
  // ============================================================================

  /**
   * Get campaigns with pagination and accurate metrics from email logs
   */
  async getCampaigns(
    businessId: string,
    params: {
      page: number;
      limit: number;
      status?: string;
    },
  ): Promise<{
    campaigns: Campaign[];
    total: number;
    page: number;
    limit: number;
  }> {
    const { page, limit, status } = params;
    const offset = (page - 1) * limit;

    let query = this.supabase
      .from("campaigns")
      .select("*", { count: "exact" })
      .eq("business_id", businessId)
      .range(offset, offset + limit - 1)
      .order("created_at", { ascending: false });

    if (status) {
      query = query.eq("status", status);
    }

    const { data, error, count } = await query;

    if (error) throw error;

    const campaigns = (data as Campaign[]) || [];

    const campaignIds = campaigns.map((c) => c.id);

    if (campaignIds.length > 0 && supabaseAdmin) {
      const { data: emailLogs } = await supabaseAdmin
        .from("campaign_email_logs")
        .select("campaign_id, status")
        .in("campaign_id", campaignIds);

      const metricsByCampaign: Record<string, { sent: number; failed: number }> = {};

      for (const log of emailLogs || []) {
        if (!metricsByCampaign[log.campaign_id]) {
          metricsByCampaign[log.campaign_id] = { sent: 0, failed: 0 };
        }
        if (log.status === "sent") {
          metricsByCampaign[log.campaign_id].sent++;
        } else if (log.status === "failed") {
          metricsByCampaign[log.campaign_id].failed++;
        }
      }

      for (const campaign of campaigns) {
        const logs = metricsByCampaign[campaign.id];
        if (logs) {
          campaign.metrics = {
            ...campaign.metrics,
            sent: logs.sent,
            bounces: logs.failed,
          };
        }
      }
    }

    return {
      campaigns,
      total: count || 0,
      page,
      limit,
    };
  }

  /**
   * Get a single campaign by ID with accurate metrics from email logs
   */
  async getCampaign(businessId: string, campaignId: string): Promise<Campaign> {
    const { data, error } = await this.supabase
      .from("campaigns")
      .select("*")
      .eq("id", campaignId)
      .eq("business_id", businessId)
      .single();

    if (error || !data) {
      throw Object.assign(new Error("Campaign not found"), { statusCode: 404 });
    }

    const campaign = data as Campaign;

    if (supabaseAdmin) {
      const { data: emailLogs } = await supabaseAdmin
        .from("campaign_email_logs")
        .select("status")
        .eq("campaign_id", campaignId);

      const sent = emailLogs?.filter((l) => l.status === "sent").length || 0;
      const failed = emailLogs?.filter((l) => l.status === "failed").length || 0;

      campaign.metrics = {
        ...campaign.metrics,
        sent,
        bounces: failed,
      };
    }

    return campaign;
  }

  /**
   * Create a campaign
   */
  async createCampaign(
    businessId: string,
    userId: string,
    data: {
      name: string;
      description?: string;
      type?: "broadcast" | "automated";
      audience_type: "all_contacts" | "segment" | "manual";
      audience_ref?: any;
      subject: string;
      from_name?: string;
      from_email?: string;
      content: { html: string; text?: string };
      send_type?: "immediate" | "scheduled";
      scheduled_at?: string;
    },
  ): Promise<Campaign> {
    const now = new Date().toISOString();

    const newCampaign = {
      business_id: businessId,
      user_id: userId,
      name: data.name,
      description: data.description || null,
      type: data.type || "broadcast",
      status: "draft",
      audience_type: data.audience_type,
      audience_ref: data.audience_ref || null,
      audience_count: 0,
      excluded_count: 0,
      subject: data.subject,
      from_name: data.from_name || "Hilaq",
      from_email: data.from_email || "noreply@hilaq.com",
      content: { html: data.content.html, text: data.content.text || "" },
      send_type: data.send_type || "immediate",
      scheduled_at: data.scheduled_at || null,
      sent_at: null,
      metrics: {
        sent: 0,
        delivered: 0,
        opens: 0,
        clicks: 0,
        bounces: 0,
        unsubscribes: 0,
      },
      created_at: now,
      updated_at: now,
    };

    const { data: campaign, error } = await this.supabase
      .from("campaigns")
      .insert([newCampaign])
      .select("*")
      .single();

    if (error) throw error;
    return campaign as Campaign;
  }

  /**
   * Update a campaign (only if draft)
   */
  async updateCampaign(
    businessId: string,
    campaignId: string,
    updates: Partial<{
      name: string;
      description: string | null;
      audience_type: "all_contacts" | "segment" | "manual";
      audience_ref: any;
      subject: string;
      from_name: string;
      from_email: string;
      content: { html: string; text?: string };
      send_type: "immediate" | "scheduled";
      scheduled_at: string | null;
    }>,
  ): Promise<Campaign> {
    // Verify ownership
    const { data: existing, error: findError } = await this.supabase
      .from("campaigns")
      .select("id, status")
      .eq("id", campaignId)
      .eq("business_id", businessId)
      .single();

    if (findError || !existing) {
      throw Object.assign(new Error("Campaign not found"), { statusCode: 404 });
    }

    const { data, error } = await this.supabase
      .from("campaigns")
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq("id", campaignId)
      .eq("business_id", businessId)
      .select("*")
      .single();

    if (error) throw error;
    return data as Campaign;
  }

  /**
   * Delete a campaign
   */
  async deleteCampaign(businessId: string, campaignId: string): Promise<void> {
    const { error } = await this.supabase
      .from("campaigns")
      .delete()
      .eq("id", campaignId)
      .eq("business_id", businessId);

    if (error) throw error;
  }

  /**
   * Validate audience for a campaign (returns counts)
   */
  async validateAudience(
    businessId: string,
    params: {
      audience_type: "all_contacts" | "segment" | "manual";
      audience_ref?: any;
    },
  ): Promise<{ total: number; eligible: number; excluded: number }> {
    if (params.audience_type === "all_contacts") {
      // Get exact counts via count query
      const { count: total } = await this.supabase
        .from("crm_contacts_unified")
        .select("*", { count: "exact", head: true })
        .eq("business_id", businessId);

      const { count: eligible } = await this.supabase
        .from("crm_contacts_unified")
        .select("*", { count: "exact", head: true })
        .eq("business_id", businessId)
        .eq("status", "marketing");

      if (total === null) {
        // Fallback to contacts table if view fails
        const { count: manualTotal } = await this.supabase
          .from("contacts")
          .select("*", { count: "exact", head: true })
          .eq("business_id", businessId);

        const { count: manualEligible } = await this.supabase
          .from("contacts")
          .select("*", { count: "exact", head: true })
          .eq("business_id", businessId)
          .eq("status", "marketing");

        const t = manualTotal || 0;
        const e = manualEligible || 0;
        return { total: t, eligible: e, excluded: t - e };
      }

      const t = total || 0;
      const e = eligible || 0;
      return { total: t, eligible: e, excluded: t - e };
    } else if (params.audience_type === "segment") {
      const segmentId = params.audience_ref as string;

      // Get exact count from contact_segments
      const { count: total } = await this.supabase
        .from("contact_segments")
        .select("*", { count: "exact", head: true })
        .eq("segment_id", segmentId);

      if (!total) {
        return { total: 0, eligible: 0, excluded: 0 };
      }

      // Get contact IDs for this segment to check eligibility
      const { data: segmentContactIds } = await this.supabase
        .from("contact_segments")
        .select("contact_id")
        .eq("segment_id", segmentId);

      if (!segmentContactIds || segmentContactIds.length === 0) {
        return { total, eligible: 0, excluded: total };
      }

      const ids = segmentContactIds.map((c) => c.contact_id);

      const { count: eligible } = await this.supabase
        .from("crm_contacts_unified")
        .select("*", { count: "exact", head: true })
        .eq("business_id", businessId)
        .eq("status", "marketing")
        .in("id", ids);

      const eCount = eligible || 0;
      return { total, eligible: eCount, excluded: total - eCount };
    } else if (params.audience_type === "manual") {
      const contactIds = (params.audience_ref as string[]) || [];

      if (contactIds.length === 0) {
        return { total: 0, eligible: 0, excluded: 0 };
      }

      let total = 0;
      let eligible = 0;
      const ID_CHUNK_SIZE = 100; // Smaller chunk size to avoid URI length limits
      for (let i = 0; i < contactIds.length; i += ID_CHUNK_SIZE) {
        const chunk = contactIds.slice(i, i + ID_CHUNK_SIZE);
        const { data } = await this.supabase
          .from("contacts")
          .select("id, status")
          .eq("business_id", businessId)
          .in("id", chunk);

        if (data) {
          total += data.length;
          eligible += data.filter((c) => c.status === "marketing").length;
        }
      }

      return { total, eligible, excluded: total - eligible };
    }

    return { total: 0, eligible: 0, excluded: 0 };
  }

  /**
   * Get accurate sent/delivered/open/click/bounce counts from campaign_email_logs.
   * These are the authoritative numbers — metrics.sent on the campaign row can drift
   * if the increment RPC fails for any individual send.
   */
  async getCampaignStats(businessId: string, campaignId: string) {
    const { data: campaign } = await this.supabase
      .from("campaigns")
      .select("id")
      .eq("id", campaignId)
      .eq("business_id", businessId)
      .single();

    if (!campaign) {
      throw Object.assign(new Error("Campaign not found"), { statusCode: 404 });
    }

    const countFor = (col?: string) => {
      const q = this.supabase
        .from("campaign_email_logs")
        .select("*", { count: "exact", head: true })
        .eq("campaign_id", campaignId);
      return col ? q.not(col, "is", null) : q;
    };

    const [
      { count: total },
      { count: sent },
      { count: delivered },
      { count: opened },
      { count: clicked },
      { count: bounced },
      { count: unsubscribed },
    ] = await Promise.all([
      countFor(),
      countFor("sent_at"),
      countFor("delivered_at"),
      countFor("opened_at"),
      countFor("clicked_at"),
      countFor("bounced_at"),
      countFor("unsubscribed_at"),
    ]);

    const s = sent || 0;
    const d = delivered || 0;
    const o = opened || 0;
    const c = clicked || 0;
    const b = bounced || 0;

    return {
      total: total || 0,
      sent: s,
      delivered: d,
      opened: o,
      clicked: c,
      bounced: b,
      unsubscribed: unsubscribed || 0,
      open_rate: d > 0 ? Math.round((o / d) * 100) : 0,
      click_rate: o > 0 ? Math.round((c / o) * 100) : 0,
      bounce_rate: s > 0 ? Math.round((b / s) * 100) : 0,
    };
  }

  /**
   * Get campaign recipients
   */
  async getCampaignRecipients(
    businessId: string,
    campaignId: string,
    params: { page: number; limit: number; status?: string },
  ): Promise<{
    recipients: any[];
    total: number;
    pages: number;
    statusCounts: Record<string, number>;
  }> {
    // Verify campaign belongs to this business
    const { data: campaign, error: findError } = await this.supabase
      .from("campaigns")
      .select("id")
      .eq("id", campaignId)
      .eq("business_id", businessId)
      .single();

    if (findError || !campaign) {
      throw Object.assign(new Error("Campaign not found"), { statusCode: 404 });
    }

    const offset = (params.page - 1) * params.limit;

    // Use COUNT queries (head:true) instead of fetching rows — avoids the
    // Supabase 1000-row default cap that caused sent counts to be truncated.
    const countQuery = (col?: string) => {
      const q = this.supabase
        .from("campaign_email_logs")
        .select("*", { count: "exact", head: true })
        .eq("campaign_id", campaignId);
      return col ? q.not(col, "is", null) : q;
    };

    const [
      { count: totalAll },
      { count: sentCount },
      { count: deliveredCount },
      { count: openedCount },
      { count: clickedCount },
      { count: bouncedCount },
      { count: unsubscribedCount },
    ] = await Promise.all([
      countQuery(),
      countQuery("sent_at"),
      countQuery("delivered_at"),
      countQuery("opened_at"),
      countQuery("clicked_at"),
      countQuery("bounced_at"),
      countQuery("unsubscribed_at"),
    ]);

    const statusCounts: Record<string, number> = {
      sent: sentCount || 0,
      delivered: deliveredCount || 0,
      opened: openedCount || 0,
      clicked: clickedCount || 0,
      bounced: bouncedCount || 0,
      unsubscribed: unsubscribedCount || 0,
    };

    // Map status filter to the appropriate column check.
    // Status is overwritten on each event (sent→delivered→opened→clicked),
    // so we filter by timestamp columns to capture "ever reached this stage".
    const STATUS_COLUMN_MAP: Record<string, string> = {
      sent: "sent_at",
      delivered: "delivered_at",
      opened: "opened_at",
      clicked: "clicked_at",
      bounced: "bounced_at",
      unsubscribed: "unsubscribed_at",
    };
    const timestampCol = params.status
      ? STATUS_COLUMN_MAP[params.status]
      : null;

    // Filtered count for pagination
    const baseCount = this.supabase
      .from("campaign_email_logs")
      .select("*", { count: "exact", head: true })
      .eq("campaign_id", campaignId);
    const { count } = await (timestampCol
      ? baseCount.not(timestampCol, "is", null)
      : baseCount);
    const total = count || 0;

    // Fetch paginated logs — filter applied in one chain to avoid reassignment issues
    const baseLogs = this.supabase
      .from("campaign_email_logs")
      .select(
        "contact_email, status, sent_at, delivered_at, opened_at, clicked_at, bounced_at, unsubscribed_at",
      )
      .eq("campaign_id", campaignId);
    const { data: logs, error: logsError } = await (
      timestampCol ? baseLogs.not(timestampCol, "is", null) : baseLogs
    )
      .order("sent_at", { ascending: false })
      .range(offset, offset + params.limit - 1);

if (logsError) throw new Error(logsError.message);
    if (!logs || logs.length === 0) {
      return {
        recipients: [],
        total,
        pages: Math.ceil(total / params.limit) || 1,
        statusCounts: { total: totalAll || 0, ...statusCounts },
      };
    }

    // Enrich with contact names from crm_contacts_unified
    const emails = logs.map((l) => l.contact_email);
    const { data: contacts } = await this.supabase
      .from("crm_contacts_unified")
      .select("email, name")
      .eq("business_id", businessId)
      .in("email", emails);

    const contactMap = new Map(
      (contacts || []).map((c: { email: string; name: string | null }) => [
        c.email,
        c.name,
      ]),
    );

    return {
      recipients: logs.map((log) => ({
        id: log.contact_email,
        email: log.contact_email,
        name: contactMap.get(log.contact_email) || null,
        status: log.status,
        sent_at: log.sent_at,
        delivered_at: log.delivered_at || null,
        opened_at: log.opened_at || null,
        clicked_at: log.clicked_at || null,
        bounced_at: log.bounced_at || null,
        unsubscribed_at: log.unsubscribed_at || null,
      })),
      total,
      pages: Math.ceil(total / params.limit) || 1,
      statusCounts: { total: totalAll || 0, ...statusCounts },
    };
  }

  /**
   * Collects all contacts for an audience into an array.
   * Used only by getCampaignRecipients (UI pagination).
   * sendCampaign uses streamAudienceContacts directly so it never
   * materialises the full list.
   */
  private async getAudienceContacts(
    businessId: string,
    audience: {
      audience_type: "all_contacts" | "segment" | "manual";
      audience_ref?: any;
    },
  ): Promise<any[]> {
    const all: any[] = [];
    for await (const page of this.streamAudienceContacts(
      businessId,
      audience,
    )) {
      all.push(...page);
    }
    return all;
  }

  /**
   * Async generator — yields one page of contacts at a time.
   * Callers can process each page immediately without ever holding
   * the full audience in memory simultaneously.
   *
   * startCursorId allows resumption from a known position (all_contacts only).
   */
  private async *streamAudienceContacts(
    businessId: string,
    audience: {
      audience_type: "all_contacts" | "segment" | "manual";
      audience_ref?: any;
    },
    startCursorId: string | null = null,
    pageSize = 1000,
  ): AsyncGenerator<any[]> {
    if (audience.audience_type === "all_contacts") {
      yield* this.streamAllContactsKeyset(businessId, pageSize, startCursorId);
    } else if (audience.audience_type === "segment") {
      yield* this.streamSegmentContacts(
        businessId,
        audience.audience_ref,
        pageSize,
      );
    } else if (audience.audience_type === "manual") {
      yield* this.streamManualContacts(businessId, audience.audience_ref);
    }
  }

  /**
   * Streams all_contacts using count-first short-circuit + keyset pagination.
   *
   * Why generators instead of the old array-accumulating loops:
   * - Each yielded page is processed (and GC-eligible) before the next is fetched.
   * - startCursorId lets an interrupted job resume from its last checkpoint.
   */
  private async *streamAllContactsKeyset(
    businessId: string,
    pageSize: number,
    startCursorId: string | null,
  ): AsyncGenerator<any[]> {
    // Count first — decide strategy without fetching any rows
    const { count, error: countError } = await this.supabase
      .from("crm_contacts_unified")
      .select("*", { count: "exact", head: true })
      .eq("business_id", businessId)
      .eq("status", "marketing");

    if (countError) {
      throw new Error(
        `Failed to count audience contacts: ${countError.message}`,
      );
    }

    if (!count || count === 0) {
      yield* this.streamContactsFallbackKeyset(
        businessId,
        pageSize,
        startCursorId,
      );
      return;
    }

    let lastId = startCursorId;

    while (true) {
      let query = this.supabase
        .from("crm_contacts_unified")
        .select("*")
        .eq("business_id", businessId)
        .eq("status", "marketing")
        .order("id")
        .limit(pageSize);

      if (lastId !== null) {
        query = query.gt("id", lastId);
      }

      const { data, error } = await query;

      if (error) {
        throw new Error(`Failed to fetch contacts page: ${error.message}`);
      }

      if (!data || data.length === 0) break;

      yield data;
      lastId = data[data.length - 1].id as string;
      if (data.length < pageSize) break;
    }
  }

  /**
   * Streams the raw contacts table (fallback when unified view is empty).
   */
  private async *streamContactsFallbackKeyset(
    businessId: string,
    pageSize: number,
    startCursorId: string | null,
  ): AsyncGenerator<any[]> {
    let lastId = startCursorId;

    while (true) {
      let query = this.supabase
        .from("contacts")
        .select("*")
        .eq("business_id", businessId)
        .eq("status", "marketing")
        .order("id")
        .limit(pageSize);

      if (lastId !== null) {
        query = query.gt("id", lastId);
      }

      const { data, error } = await query;

      if (error) {
        throw new Error(`Fallback contact fetch failed: ${error.message}`);
      }

      if (!data || data.length === 0) break;

      yield data;
      lastId = data[data.length - 1].id as string;
      if (data.length < pageSize) break;
    }
  }

  /**
   * Streams contacts belonging to a segment, one page of segment members at a time.
   */
  private async *streamSegmentContacts(
    businessId: string,
    segmentId: string,
    pageSize: number,
  ): AsyncGenerator<any[]> {
    let offset = 0;
    const ID_CHUNK_SIZE = 100;

    while (true) {
      const { data: contactSegments, error: segError } = await this.supabase
        .from("contact_segments")
        .select("contact_id")
        .eq("segment_id", segmentId)
        .range(offset, offset + pageSize - 1);

      if (segError) {
        throw new Error(`Failed to fetch segment members: ${segError.message}`);
      }

      if (!contactSegments || contactSegments.length === 0) break;

      const ids = contactSegments.map(
        (cs: { contact_id: string }) => cs.contact_id,
      );
      const pageContacts: any[] = [];

      for (let j = 0; j < ids.length; j += ID_CHUNK_SIZE) {
        const idChunk = ids.slice(j, j + ID_CHUNK_SIZE);
        const { data: contacts, error: contactsError } = await this.supabase
          .from("crm_contacts_unified")
          .select("*")
          .eq("business_id", businessId)
          .in("id", idChunk)
          .eq("status", "marketing");

        if (contactsError) {
          throw new Error(
            `Failed to fetch segment contacts chunk: ${contactsError.message}`,
          );
        }

        if (contacts && contacts.length > 0) pageContacts.push(...contacts);
      }

      if (pageContacts.length > 0) yield pageContacts;

      offset += pageSize;
      if (contactSegments.length < pageSize) break;
    }
  }

  /**
   * Streams a manual (explicit ID list) audience in 100-ID chunks.
   */
  private async *streamManualContacts(
    businessId: string,
    ids: string[],
  ): AsyncGenerator<any[]> {
    if (!ids || ids.length === 0) return;

    const ID_CHUNK_SIZE = 100;

    for (let offset = 0; offset < ids.length; offset += ID_CHUNK_SIZE) {
      const chunk = ids.slice(offset, offset + ID_CHUNK_SIZE);
      const { data, error } = await this.supabase
        .from("contacts")
        .select("*")
        .eq("business_id", businessId)
        .in("id", chunk)
        .eq("status", "marketing");

      if (error) {
        throw new Error(
          `Failed to fetch manual contacts chunk: ${error.message}`,
        );
      }

      if (data && data.length > 0) yield data;
    }
  }

  private isRetryableCampaignSendError(error: any): boolean {
    const statusCode = Number(error?.status || error?.statusCode || 0);
    // 429 = rate limit; 499 = client closed / nginx timeout; ≥500 = server error
    if (statusCode === 429 || statusCode === 499 || statusCode >= 500) return true;

    const message = String(error?.message || "").toLowerCase();
    return (
      message.includes("timeout") ||
      message.includes("network") ||
      message.includes("fetch failed") ||
      message.includes("connection")
    );
  }

  private async sendCampaignEmailWithRetry(params: {
    campaignId: string;
    businessId: string;
    contact: any;
    senderName: string;
    senderEmail: string;
    subject: string;
    replyTo?: string;
    parsedContent: { html: string; text: string };
  }): Promise<boolean> {
    const { notificationService } = await import("./notification.services");
    const { campaignEmailTemplate } = await import("../utils/emailsTemplate");
    const contactEmail = (params.contact.email || "").trim().toLowerCase();

    // Idempotency check - skip if already sent
    if (supabaseAdmin) {
      const { data: existingLog } = await supabaseAdmin
        .from("campaign_email_logs")
        .select("id, status")
        .eq("campaign_id", params.campaignId)
        .eq("contact_email", contactEmail)
        .single();

      if (existingLog) {
        console.log(
          `[CRMService] Skipping duplicate email for ${contactEmail} in campaign ${params.campaignId}`,
        );
        return true;
      }
    }

    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const firstName =
          params.contact.first_name ||
          (params.contact.name ? params.contact.name.split(" ")[0] : "");
        const lastName =
          params.contact.last_name ||
          (params.contact.name && params.contact.name.includes(" ")
            ? params.contact.name.split(" ").slice(1).join(" ")
            : "");
        const email = params.contact.email || "";
        const company =
          params.contact.company || params.contact.company_name || "";

        let personalizedHtml = params.parsedContent.html || "";
        let personalizedText = params.parsedContent.text || "";

        if (personalizedHtml) {
          personalizedHtml = personalizedHtml
            .replace(/{{first_name}}/gi, firstName)
            .replace(/{{last_name}}/gi, lastName)
            .replace(/{{email}}/gi, email)
            .replace(/{{company}}/gi, company);
        }

        if (personalizedText) {
          personalizedText = personalizedText
            .replace(/{{first_name}}/gi, firstName)
            .replace(/{{last_name}}/gi, lastName)
            .replace(/{{email}}/gi, email)
            .replace(/{{company}}/gi, company);
        }

        // Wrap content in branded template
        const brandedHtml = campaignEmailTemplate({
          subject: params.subject,
          content: personalizedHtml || personalizedText || "",
          businessName: params.senderName,
          unsubscribeUrl: `https://www.hilaq.com/unsubscribe?email=${encodeURIComponent(
            params.contact.email,
          )}&campaign=${params.campaignId}`,
        });

        await notificationService.createNotification({
          toEmail: params.contact.email,
          emailName: params.senderName,
          emailSubject: params.subject,
          formatType: "html",
          emailBody: brandedHtml,
          replyTo: params.replyTo,
          fromEmail: params.senderEmail,
          metadata: {
            campaign_id: params.campaignId,
            contact_email: params.contact.email,
            business_id: params.businessId,
          },
        });

        // Log successful send for idempotency
        if (supabaseAdmin) {
          await supabaseAdmin.from("campaign_email_logs").upsert(
            {
              campaign_id: params.campaignId,
              contact_email: contactEmail,
              business_id: params.businessId,
              status: "sent",
              sent_at: new Date().toISOString(),
            },
            {
              onConflict: "campaign_id,contact_email",
            },
          );
        }

        // Atomic increment of sent metric.
        // We do this individually to ensure the "stats" reflect real-time progress.
        await this.supabase.rpc("increment_campaign_metric", {
          target_campaign_id: params.campaignId,
          metric_key: "sent",
          increment_amount: 1,
        });

        return true;
      } catch (error) {
        const canRetry = this.isRetryableCampaignSendError(error);
        if (!canRetry || attempt === maxAttempts) {
          throw error;
        }

        const backoffMs = 300 * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    return false;
  }

  /**
   * Send a campaign
   */
  async sendCampaign(
    businessId: string,
    campaignId: string,
  ): Promise<{ sent: number; excluded: number; campaign: Campaign }> {
    // Get campaign
    const { data: campaign, error: findError } = await this.supabase
      .from("campaigns")
      .select("*, author:user_id(email)")
      .eq("id", campaignId)
      .eq("business_id", businessId)
      .single();

    if (findError || !campaign) {
      throw Object.assign(new Error("Campaign not found"), { statusCode: 404 });
    }

    if (campaign.status !== "draft" && campaign.status !== "scheduled") {
      throw Object.assign(
        new Error(`Cannot send campaign with status: ${campaign.status}`),
        { statusCode: 400 },
      );
    }

    // Validate audience
    const audienceResult = await this.validateAudience(businessId, {
      audience_type: campaign.audience_type,
      audience_ref: campaign.audience_ref,
    });

    // Check monthly email limits before sending
    const { PlanLimitsService } = await import("./plan-limits.service");
    const planLimits = new PlanLimitsService(this.supabase);
    const limitCheck = await planLimits.canCreate(
      businessId,
      "emails_per_month",
    );

    if (
      limitCheck.limit !== "unlimited" &&
      limitCheck.used + audienceResult.eligible > limitCheck.limit
    ) {
      const available = Math.max(0, limitCheck.limit - limitCheck.used);
      throw Object.assign(
        new Error(
          `Monthly email limit exceeded. You have ${available} emails remaining this month out of your ${limitCheck.limit} limit. Please upgrade your plan or reduce your audience size.`,
        ),
        { statusCode: 403 },
      );
    }

    const campaignCredits = new CampaignCreditsService(this.supabase);

    // Move campaign into sending state first. Final sent/failed status is set by the worker.
    const { data: updatedCampaign, error: updateError } = await this.supabase
      .from("campaigns")
      .update({
        status: "sending",
        audience_count: audienceResult.eligible,
        excluded_count: audienceResult.excluded,
        sent_at: null,
        metrics: {
          sent: 0,
          delivered: 0,
          opens: 0,
          clicks: 0,
          bounces: 0,
          unsubscribes: 0,
        },
        updated_at: new Date().toISOString(),
      })
      .eq("id", campaignId)
      .in("status", ["draft", "scheduled"])
      .select(
        "id, user_id, name, description, type, status, audience_type, audience_ref, audience_count, excluded_count, subject, from_name, from_email, content, send_type, scheduled_at, sent_at, metrics, created_at, updated_at",
      )
      .single();

    if (updateError) throw updateError;

    try {
      await campaignCredits.debitForCampaign({
        businessId,
        campaignId,
        credits: audienceResult.eligible,
        metadata: {
          action: "send",
          audience_count: audienceResult.eligible,
          excluded_count: audienceResult.excluded,
        },
      });
    } catch (creditError) {
      await this.supabase
        .from("campaigns")
        .update({
          status: campaign.status,
          updated_at: new Date().toISOString(),
        })
        .eq("id", campaignId);
      throw creditError;
    }

    // Create a persistent job record before starting the background worker.
    // This solves three problems:
    //   1. Memory   — the worker streams contacts page by page and never holds
    //                 the full audience in memory at once.
    //   2. Timeout  — cursor_id is checkpointed after every send batch so an
    //                 interrupted job can resume without re-sending to contacts
    //                 that were already delivered.
    //   3. Progress — sent_count / failed_count are written incrementally so the
    //                 campaign dashboard shows live progress.
    const { data: sendJob, error: jobError } = await this.supabase
      .from("campaign_send_jobs")
      .insert({
        campaign_id: campaignId,
        business_id: businessId,
        status: "processing",
      })
      .select()
      .single();

    if (jobError || !sendJob) {
      console.error(
        `[Campaign ${campaignId}] Failed to create send job:`,
        jobError,
      );
    }

    const jobId: string | null = sendJob?.id ?? null;

    // Use QStash queue if configured, otherwise fallback to fire-and-forget
    const qstashQueued = isQStashAvailable() && await queueCampaignJob({
      campaignId,
      businessId,
      dbJobId: jobId,
      isRetry: false,
    });

    if (qstashQueued) {
      console.log(`[Campaign ${campaignId}] Queued via QStash (job: ${jobId})`);
    } else {
      // Fallback: fire and forget (original behavior)
      // Background worker — fire and forget.
      // Contacts are streamed one page at a time; the full audience is never
      // accumulated in memory.
      const fallbackJobId = jobId;
      (async () => {
        let sentCount = 0;
        let failedCount = 0;
        let totalDelivered = 0;

        try {
          // Fetch business details for sender identity (once, before the loop)
          const { data: business } = await this.supabase
            .from("businesses")
            .select("name, slug")
            .eq("id", businessId)
            .single();

          const businessSlug =
            business?.slug ||
            business?.name
              ?.toLowerCase()
              .replace(/[^a-z0-9]/g, "-")
              .replace(/-+/g, "-")
              .slice(0, 30) ||
            "business";
          const senderName = business?.name || "Hilaq";
          const senderEmail = `${businessSlug}@hilaq.com`;

          console.log(
            `[Campaign ${campaignId}] Background process starting. sender=${senderName} <${senderEmail}>`,
          );

          // Parse content once — reused for every contact
          let parsedContent: { html: string; text: string } = {
            html: "",
            text: "",
          };
          if (campaign.content) {
            if (typeof campaign.content === "string") {
              try {
                parsedContent = JSON.parse(campaign.content);
              } catch {
                parsedContent = {
                  html: campaign.content,
                  text: campaign.content,
                };
              }
            } else {
              parsedContent = {
                html: campaign.content.html || "",
                text: campaign.content.text || "",
              };
            }
          }

          // Global email dedup — stores only lowercase email strings (~30 B each),
          // not full contact objects, so memory stays proportional to unique addresses.
          const emailsSeen = new Set<string>();

          // Send buffer — flushed in parallel batches of 25
          const BATCH_SIZE = 25;
          let sendBuffer: any[] = [];
          let lastCursorId: string | null = null;

          const flushBuffer = async () => {
            if (sendBuffer.length === 0) return;

            const batch = sendBuffer;
            sendBuffer = [];

            const results = await Promise.allSettled(
              batch.map((contact) =>
                this.sendCampaignEmailWithRetry({
                  campaignId,
                  businessId,
                  contact,
                  senderName,
                  senderEmail,
                  subject: campaign.subject,
                  replyTo: (campaign as any).author?.email,
                  parsedContent,
                }),
              ),
            );

            for (let j = 0; j < results.length; j++) {
              if (results[j].status === "fulfilled") {
                sentCount++;
              } else {
                failedCount++;
                console.error(
                  `[Campaign ${campaignId}] Failed to send to ${batch[j]?.email}:`,
                  (results[j] as PromiseRejectedResult).reason,
                );
              }
            }

            totalDelivered = sentCount + failedCount;

            // Checkpoint progress after every batch — enables resume and live progress.
            if (fallbackJobId) {
              await this.supabase
                .from("campaign_send_jobs")
                .update({
                  cursor_id: lastCursorId,
                  sent_count: sentCount,
                  failed_count: failedCount,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", fallbackJobId);
            }
          };

          // Stream contacts page by page — no full-list materialisation
          for await (const page of this.streamAudienceContacts(businessId, {
            audience_type: campaign.audience_type,
            audience_ref: campaign.audience_ref,
          })) {
            for (const contact of page) {
              const email = (contact.email || "").trim().toLowerCase();
              if (
                !email ||
                contact.status !== "marketing" ||
                emailsSeen.has(email)
              ) {
                continue;
              }
              emailsSeen.add(email);
              lastCursorId = contact.id ?? lastCursorId;

              sendBuffer.push(contact);
              if (sendBuffer.length >= BATCH_SIZE) {
                await flushBuffer();
              }
            }
          }

          // Drain any remaining contacts in the buffer
          await flushBuffer();

          const dedupeExcluded = Math.max(
            0,
            (audienceResult.eligible || 0) - totalDelivered,
          );

          console.log(
            `[Campaign ${campaignId}] Completed: sent=${sentCount}, failed=${failedCount}, total=${totalDelivered}`,
          );

          const now = new Date().toISOString();

          if (fallbackJobId) {
            await this.supabase
              .from("campaign_send_jobs")
              .update({
                status: "completed",
                cursor_id: lastCursorId,
                sent_count: sentCount,
                failed_count: failedCount,
                updated_at: now,
              })
              .eq("id", fallbackJobId);
          }

          await this.supabase
            .from("campaigns")
            .update({
              status: sentCount > 0 ? "sent" : "failed",
              sent_at: now,
              audience_count: totalDelivered,
              excluded_count: audienceResult.excluded + dedupeExcluded,
              updated_at: now,
            })
            .eq("id", campaignId);
        } catch (err) {
          console.error(
            `[Campaign ${campaignId}] Background process failed:`,
            err,
          );

          if (fallbackJobId) {
            await this.supabase
              .from("campaign_send_jobs")
              .update({
                status: "failed",
                sent_count: sentCount,
                failed_count: failedCount,
                error_message: (err as Error).message,
                updated_at: new Date().toISOString(),
              })
              .eq("id", fallbackJobId);
          }

          await this.supabase
            .from("campaigns")
            .update({
              status: "failed",
              updated_at: new Date().toISOString(),
            })
            .eq("id", campaignId);
        }
      })();
    }

    return {
      sent: 0, // Sending is now asynchronous
      excluded: audienceResult.excluded,
      campaign: updatedCampaign as Campaign,
    };
  }

  /**
   * Retry a failed campaign
   * Allows resending campaigns that failed (e.g., due to timeout)
   */
  async retryCampaign(
    businessId: string,
    campaignId: string,
  ): Promise<{ sent: number; excluded: number; campaign: Campaign }> {
    // Get campaign
    const { data: campaign, error: findError } = await this.supabase
      .from("campaigns")
      .select("*, author:user_id(email)")
      .eq("id", campaignId)
      .eq("business_id", businessId)
      .single();

    if (findError || !campaign) {
      throw Object.assign(new Error("Campaign not found"), { statusCode: 404 });
    }

    // Only failed campaigns can be retried
    if (campaign.status !== "failed") {
      throw Object.assign(
        new Error(
          `Only failed campaigns can be retried. Current status: ${campaign.status}`,
        ),
        { statusCode: 400 },
      );
    }

    // Count only unsent contacts — already-sent ones are skipped by dedup
    const { count: alreadySentCount } = await this.supabase
      .from("campaign_email_logs")
      .select("*", { count: "exact", head: true })
      .eq("campaign_id", campaignId);

    const audienceResult = await this.validateAudience(businessId, {
      audience_type: campaign.audience_type,
      audience_ref: campaign.audience_ref,
    });
    const remainingToSend = Math.max(
      0,
      audienceResult.eligible - (alreadySentCount || 0),
    );

    if (remainingToSend === 0) {
      throw Object.assign(
        new Error("All contacts in this campaign have already been sent to."),
        { statusCode: 400 },
      );
    }

    // Check monthly email limits against remaining unsent count only
    const { PlanLimitsService } = await import("./plan-limits.service");
    const planLimits = new PlanLimitsService(this.supabase);
    const limitCheck = await planLimits.canCreate(
      businessId,
      "emails_per_month",
    );

    if (
      limitCheck.limit !== "unlimited" &&
      limitCheck.used + remainingToSend > limitCheck.limit
    ) {
      const available = Math.max(0, limitCheck.limit - limitCheck.used);
      throw Object.assign(
        new Error(
          `Monthly email limit exceeded. You have ${available} emails remaining this month out of your ${limitCheck.limit} limit. Please upgrade your plan or reduce your audience size.`,
        ),
        { statusCode: 403 },
      );
    }

    const campaignCredits = new CampaignCreditsService(this.supabase);

    // Move back to sending state — preserve existing metrics so original sends
    // aren't lost. New sends will accumulate on top via increment_campaign_metric.
    // audience_count stays as the full original audience so the UI shows total targeted.
    const { data: updatedCampaign, error: updateError } = await this.supabase
      .from("campaigns")
      .update({
        status: "sending",
        sent_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", campaignId)
      .eq("status", "failed")
      .select(
        "id, user_id, name, description, type, status, audience_type, audience_ref, audience_count, excluded_count, subject, from_name, from_email, content, send_type, scheduled_at, sent_at, metrics, created_at, updated_at",
      )
      .single();

    if (updateError) throw updateError;

    try {
      await campaignCredits.debitForCampaign({
        businessId,
        campaignId,
        credits: remainingToSend,
        metadata: {
          action: "retry",
          remaining_to_send: remainingToSend,
          already_sent_count: alreadySentCount || 0,
        },
      });
    } catch (creditError) {
      await this.supabase
        .from("campaigns")
        .update({
          status: "failed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", campaignId);
      throw creditError;
    }

    // Create a new send job
    const { data: sendJob, error: jobError } = await this.supabase
      .from("campaign_send_jobs")
      .insert({
        campaign_id: campaignId,
        business_id: businessId,
        status: "processing",
      })
      .select()
      .single();

    if (jobError || !sendJob) {
      console.error(
        `[Campaign ${campaignId}] Failed to create retry send job:`,
        jobError,
      );
    }

    const retryJobId: string | null = sendJob?.id ?? null;

    // Use QStash queue if configured, otherwise fallback to fire-and-forget
    const retryQstashQueued = isQStashAvailable() && await queueCampaignJob({
      campaignId,
      businessId,
      dbJobId: retryJobId,
      isRetry: true,
    });

    if (retryQstashQueued) {
      console.log(
        `[Campaign ${campaignId}] Retry queued via QStash (job: ${retryJobId})`,
      );
    } else {
      // Fallback: fire and forget (original behavior)
      const fallbackJobId = retryJobId;
      (async () => {
        let sentCount = 0;
        let failedCount = 0;
        let totalDelivered = 0;

        try {
          const { data: business } = await this.supabase
            .from("businesses")
            .select("name, slug")
            .eq("id", businessId)
            .single();

          const businessSlug =
            business?.slug ||
            business?.name
              ?.toLowerCase()
              .replace(/[^a-z0-9]/g, "-")
              .replace(/-+/g, "-")
              .slice(0, 30) ||
            "business";
          const senderName = business?.name || "Hilaq";
          const senderEmail = `${businessSlug}@hilaq.com`;
          const now = new Date().toISOString();

          console.log(
            `[Campaign ${campaignId}] Retry background process starting.`,
          );

          let parsedContent: { html: string; text: string } = {
            html: "",
            text: "",
          };
          if (campaign.content) {
            if (typeof campaign.content === "string") {
              try {
                parsedContent = JSON.parse(campaign.content);
              } catch {
                parsedContent = {
                  html: campaign.content,
                  text: campaign.content,
                };
              }
            } else {
              parsedContent = {
                html: campaign.content.html || "",
                text: campaign.content.text || "",
              };
            }
          }

          // Global email dedup
          const emailsSeen = new Set<string>();

          // Send buffer — flushed in parallel batches of 25
          const BATCH_SIZE = 25;
          let sendBuffer: any[] = [];
          let lastCursorId: string | null = null;

          const flushBuffer = async () => {
            if (sendBuffer.length === 0) return;

            const batch = sendBuffer;
            sendBuffer = [];

            const results = await Promise.allSettled(
              batch.map((contact) =>
                this.sendCampaignEmailWithRetry({
                  campaignId,
                  businessId,
                  contact,
                  senderName,
                  senderEmail,
                  subject: campaign.subject,
                  replyTo: (campaign as any).author?.email,
                  parsedContent,
                }),
              ),
            );

            for (let j = 0; j < results.length; j++) {
              if (results[j].status === "fulfilled") {
                sentCount++;
              } else {
                failedCount++;
                console.error(
                  `[Campaign ${campaignId}] Failed to send to ${batch[j]?.email}:`,
                  (results[j] as PromiseRejectedResult).reason,
                );
              }
            }

            totalDelivered = sentCount + failedCount;

            // Checkpoint progress
            if (fallbackJobId) {
              await this.supabase
                .from("campaign_send_jobs")
                .update({
                  cursor_id: lastCursorId,
                  sent_count: sentCount,
                  failed_count: failedCount,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", fallbackJobId);
            }
          };

          // Stream contacts page by page
          for await (const page of this.streamAudienceContacts(businessId, {
            audience_type: campaign.audience_type,
            audience_ref: campaign.audience_ref,
          })) {
            for (const contact of page) {
              const email = (contact.email || "").trim().toLowerCase();
              if (
                !email ||
                contact.status !== "marketing" ||
                emailsSeen.has(email)
              ) {
                continue;
              }
              emailsSeen.add(email);
              lastCursorId = contact.id ?? lastCursorId;

              sendBuffer.push(contact);
              if (sendBuffer.length >= BATCH_SIZE) {
                await flushBuffer();
              }
            }
          }

          // Drain remaining buffer
          await flushBuffer();

          // Final updates
          if (fallbackJobId) {
            await this.supabase
              .from("campaign_send_jobs")
              .update({
                status: "completed",
                sent_count: sentCount,
                failed_count: failedCount,
                completed_at: now,
                updated_at: now,
              })
              .eq("id", fallbackJobId);
          }

          await this.supabase
            .from("campaigns")
            .update({
              status: sentCount > 0 ? "sent" : "failed",
              sent_at: now,
              audience_count: totalDelivered,
              excluded_count: audienceResult.excluded,
              updated_at: now,
            })
            .eq("id", campaignId);
        } catch (err) {
          console.error(
            `[Campaign ${campaignId}] Retry background process failed:`,
            err,
          );

          if (fallbackJobId) {
            await this.supabase
              .from("campaign_send_jobs")
              .update({
                status: "failed",
                sent_count: sentCount,
                failed_count: failedCount,
                error_message: (err as Error).message,
                updated_at: new Date().toISOString(),
              })
              .eq("id", fallbackJobId);
          }

          await this.supabase
            .from("campaigns")
            .update({
              status: "failed",
              updated_at: new Date().toISOString(),
            })
            .eq("id", campaignId);
        }
      })();
    }

    return {
      sent: 0,
      excluded: audienceResult.excluded,
      campaign: updatedCampaign as Campaign,
    };
  }

  /**
   * Schedule a campaign
   */
  async scheduleCampaign(
    businessId: string,
    campaignId: string,
    scheduledAt: string,
  ): Promise<Campaign> {
    // Verify ownership and draft status
    const { data: campaign, error: findError } = await this.supabase
      .from("campaigns")
      .select("id, status, audience_type, audience_ref")
      .eq("id", campaignId)
      .eq("business_id", businessId)
      .single();

    if (findError || !campaign) {
      throw Object.assign(new Error("Campaign not found"), { statusCode: 404 });
    }

    if (campaign.status !== "draft") {
      throw Object.assign(new Error("Only draft campaigns can be scheduled"), {
        statusCode: 400,
      });
    }

    // Validate future date
    if (new Date(scheduledAt) <= new Date()) {
      throw Object.assign(new Error("Scheduled time must be in the future"), {
        statusCode: 400,
      });
    }

    // Check monthly email limits before scheduling
    const audienceResult = await this.validateAudience(businessId, {
      audience_type: campaign.audience_type,
      audience_ref: campaign.audience_ref,
    });

    const { PlanLimitsService } = await import("./plan-limits.service");
    const planLimits = new PlanLimitsService(this.supabase);
    const limitCheck = await planLimits.canCreate(
      businessId,
      "emails_per_month",
    );

    if (
      limitCheck.limit !== "unlimited" &&
      limitCheck.used + audienceResult.eligible > limitCheck.limit
    ) {
      const available = Math.max(0, limitCheck.limit - limitCheck.used);
      throw Object.assign(
        new Error(
          `Monthly email limit exceeded. You have ${available} emails remaining this month out of your ${limitCheck.limit} limit. Please upgrade your plan or reduce your audience size.`,
        ),
        { statusCode: 403 },
      );
    }

    const { data, error } = await this.supabase
      .from("campaigns")
      .update({
        status: "scheduled",
        send_type: "scheduled",
        scheduled_at: scheduledAt,
        updated_at: new Date().toISOString(),
      })
      .eq("id", campaignId)
      .select(
        "id, user_id, name, description, type, status, audience_type, audience_ref, audience_count, excluded_count, subject, from_name, from_email, content, send_type, scheduled_at, sent_at, metrics, created_at, updated_at",
      )
      .single();

    if (error) throw error;
    return data as Campaign;
  }
}

// Export singleton instance with default supabase client
import supabase from "../config/supabase";
export const crmService = new CRMService(supabase);
export default CRMService;
