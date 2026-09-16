import { SupabaseClient } from "@supabase/supabase-js";
import { AvailabilityProfile } from "../types/store";
import { randomUUID } from "crypto";

export class AvailabilityService {
  constructor(private supabase: SupabaseClient) {}

  /**
   * List all profiles for a merchant
   */
  async listProfiles(businessId: string): Promise<AvailabilityProfile[]> {
    const { data, error } = await this.supabase
      .from("availability_profiles")
      .select("*")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return data as AvailabilityProfile[];
  }

  /**
   * Get a single profile by ID
   */
  async getProfile(id: string, businessId: string): Promise<AvailabilityProfile> {
    const { data, error } = await this.supabase
      .from("availability_profiles")
      .select("*")
      .eq("id", id)
      .eq("business_id", businessId)
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        throw Object.assign(new Error("Availability profile not found"), { statusCode: 404 });
      }
      throw error;
    }
    return data as AvailabilityProfile;
  }

  /**
   * Get a public profile by ID (no auth required, active profiles only)
   * Returns limited fields for public consumption
   */
  async getPublicProfile(profileId: string): Promise<{
    id: string;
    name: string;
    weekly_schedule: AvailabilityProfile["weekly_schedule"];
    timezone: string;
  }> {
    const { data, error } = await this.supabase
      .from("availability_profiles")
      .select("id, name, weekly_schedule, timezone, status")
      .eq("id", profileId)
      .eq("status", "active")
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        throw Object.assign(new Error("Profile not found"), { statusCode: 404 });
      }
      throw error;
    }

    return {
      id: data.id,
      name: data.name,
      weekly_schedule: data.weekly_schedule,
      timezone: data.timezone,
    };
  }

  /**
   * Create a new availability profile
   */
  async createProfile(businessId: string, payload: Partial<AvailabilityProfile>): Promise<AvailabilityProfile> {
    this.validateSchedule(payload.weekly_schedule);

    const id = randomUUID();
    const newProfile = {
      ...payload,
      id,
      business_id: businessId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await this.supabase
      .from("availability_profiles")
      .insert([newProfile])
      .select("*")
      .single();

    if (error) throw error;
    return data as AvailabilityProfile;
  }

  /**
   * Update an existing profile
   */
  async updateProfile(id: string, businessId: string, payload: Partial<AvailabilityProfile>): Promise<AvailabilityProfile> {
    // Ensure ownership
    await this.getProfile(id, businessId);

    if (payload.weekly_schedule) {
      this.validateSchedule(payload.weekly_schedule);
    }

    const { data, error } = await this.supabase
      .from("availability_profiles")
      .update({
        ...payload,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("business_id", businessId)
      .select("*")
      .single();

    if (error) throw error;
    return data as AvailabilityProfile;
  }

  /**
   * Duplicate a profile
   */
  async duplicateProfile(id: string, businessId: string): Promise<AvailabilityProfile> {
    const original = await this.getProfile(id, businessId);

    const { id: _, created_at: __, updated_at: ___, ...rest } = original;
    
    return this.createProfile(businessId, {
      ...rest,
      name: `${original.name} Copy`,
    });
  }

  /**
   * Delete a profile
   */
  async deleteProfile(id: string, businessId: string): Promise<void> {
    // Ensure ownership
    await this.getProfile(id, businessId);

    // Check if actively linked to products
    const { data: linkedProducts, error: linkError } = await this.supabase
      .from("products")
      .select("id")
      .eq("availability_profile_id", id)
      .limit(1);

    if (linkError) throw linkError;
    if (linkedProducts && linkedProducts.length > 0) {
      throw Object.assign(new Error("Cannot delete profile: It is actively linked to products"), { statusCode: 400 });
    }

    const { error } = await this.supabase
      .from("availability_profiles")
      .delete()
      .eq("id", id)
      .eq("business_id", businessId);

    if (error) throw error;
  }

  /**
   * Fetch a profile linked to a product
   */
  private async getProfileForProduct(productId: string): Promise<AvailabilityProfile | null> {
    const { data: product, error: productError } = await this.supabase
    .from("products")
    .select("id, availability_profile_id, status, store_id, type")
    .eq("id", productId)
    .single();

    if (productError || !product) {
      throw Object.assign(new Error("Product not found"), { statusCode: 404 });
    }

    let profileId = product.availability_profile_id;

    if (!profileId && (product as any).type === "service") {
      const { data: store } = await this.supabase
        .from("stores")
        .select("appearance")
        .eq("id", (product as any).store_id)
        .single();

      profileId = (store?.appearance as any)?.availability_profile_id || null;
    }

    if (!profileId) {
      return null;
    }

    const { data: profile, error: profileError } = await this.supabase
      .from("availability_profiles")
      .select("*")
      .eq("id", profileId)
      .single();

    if (profileError || !profile) {
      return null;
    }

    return profile as AvailabilityProfile;
  }

  /**
   * Check product availability resolution
   */
  async checkProductAvailability(productId: string): Promise<{
    isAvailable: boolean;
    reason?: string;
    nextSlot?: { startTime: string; endTime: string; date: string };
  }> {
    const profile = await this.getProfileForProduct(productId);
    if (!profile || profile.status === "inactive") {
      return { isAvailable: true };
    }

    return this.resolveAvailability(profile);
  }

  /**
   * Get available slots for a product on a specific date
   */
  async getAvailableSlots(
    productId: string,
    date: string // YYYY-MM-DD
  ): Promise<{
    date: string;
    timezone: string;
    slots: Array<{
      startTime: string;
      endTime: string;
      available: boolean;
      reason?: string;
    }>;
    capacityRemaining: {
      day: number | null;
      slots: Record<string, number | null>;
    };
  }> {
    const profile = await this.getProfileForProduct(productId);
    if (!profile || profile.status === "inactive") {
      throw Object.assign(new Error("Availability not configured or inactive"), { statusCode: 400 });
    }

    // 1. Get product details (duration)
    const { data: product } = await this.supabase
      .from("products")
      .select("service")
      .eq("id", productId)
      .single();
    
    // Get duration from service metadata, fallback to 60
    const serviceData = (product as any)?.service || {};
    const duration = serviceData.duration_minutes || 60;
    
    const buffer = profile.buffer_minutes || 0;
    const interval = duration + buffer;

    // 2. Validate date rules
    if (profile.date_rules) {
      if (profile.date_rules.startDate && date < profile.date_rules.startDate) {
        throw Object.assign(new Error(`Availability starts on ${profile.date_rules.startDate}`), { statusCode: 400 });
      }
      if (profile.date_rules.endDate && date > profile.date_rules.endDate) {
        throw Object.assign(new Error(`Availability ended on ${profile.date_rules.endDate}`), { statusCode: 400 });
      }
      const blackout = profile.date_rules.blackoutDates?.find(b => b.date === date);
      if (blackout) {
        throw Object.assign(new Error(blackout.reason || "Blackout date"), { statusCode: 400 });
      }
    }

    // 3. Get schedule for the day
    // Use noon UTC so that Intl.DateTimeFormat resolves the correct calendar day
    // in any UTC± timezone. new Date(year, month, day) creates midnight in the
    // server's local time (UTC on Vercel), which maps to the previous day in
    // any UTC-offset timezone when formatted with timeZone.
    const timezone = profile.timezone || "Africa/Lagos";
    const dateObj = new Date(`${date}T12:00:00Z`);

    const dayName = new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      timeZone: timezone,
    }).format(dateObj);

    const daySchedule = profile.weekly_schedule?.find(s => s.day === dayName);
    if (!daySchedule || !daySchedule.isEnabled) {
      // Return empty slots for invalid day
      return {
        date,
        timezone,
        slots: [],
        capacityRemaining: { day: 0, slots: {} },
      };
    }

    // 4. Generate candidate slots based on ranges
    const slots: Array<{ startTime: string; endTime: string; available: boolean; reason?: string }> = [];
    
    for (const range of daySchedule.ranges || []) {
      // Parse HH:mm to minutes
      const [startH, startM] = range.startTime.split(":").map(Number);
      const [endH, endM] = range.endTime.split(":").map(Number);
      
      let currentMinutes = startH * 60 + startM;
      const endMinutes = endH * 60 + endM;

      // Sequential slot generation
      // Ensure the full duration fits within the range
      while (currentMinutes + duration <= endMinutes) {
        const slotStart = this.minutesToTime(currentMinutes);
        const slotEnd = this.minutesToTime(currentMinutes + duration);
        
        slots.push({
          startTime: slotStart,
          endTime: slotEnd,
          available: true,
        });

        // Advance by duration + buffer
        currentMinutes += interval;
      }
    }

    // 5. Fetch booked slots from store_orders items JSONB (item.slot = { date, startTime, endTime })
    // Filtering in JS — a dedicated bookings table would make this a DB-level query
    const { data: orders } = await this.supabase
      .from("store_orders")
      .select("items")
      .neq("status", "cancelled")
      // This is expensive on JSONB, in prod we'd want a separate bookings table
      // filtering in JS for now as we don't have a dedicated bookings table
    
    const bookings = (orders || []).flatMap((o: any) => o.items)
      .filter((item: any) => 
        item.product_id === productId && 
        item.slot && 
        item.slot.date === date
      );
    
    // Also include service_bookings table
    const { data: serviceBookings } = await this.supabase
      .from("service_bookings")
      .select("*")
      .eq("product_id", productId)
      .eq("booking_date", date)
      .neq("status", "cancelled")
      .neq("status", "declined");

    // Combine bookings from orders (legacy/cart) and service_bookings (direct)
    interface UnifiedBooking {
      startTime: string;
      endTime: string;
    }
    
    const allBookings: UnifiedBooking[] = [
      ...bookings.map((b: any) => ({ startTime: b.slot.startTime, endTime: b.slot.endTime })),
      ...(serviceBookings || []).map((b: any) => ({ startTime: b.start_time, endTime: b.end_time }))
    ];

    // 6. Check capacity and mark unavailable
    // Max bookings per day
    const maxPerDay = profile.capacity?.maxPerDay;
    if (maxPerDay !== null && allBookings.length >= maxPerDay) {
      // Entire day is booked
        return {
        date,
        timezone,
        slots: slots.map(s => ({ ...s, available: false, reason: "Daily capacity reached" })),
        capacityRemaining: { day: 0, slots: {} }
      };
    }

    // Max bookings per slot
    const maxPerSlot = profile.capacity?.maxPerSlot || 1;

    // Update availability using overlap detection
    const enrichedSlots = slots.map(slot => {
      // Count bookings that overlap with this slot
      // Overlap condition: BookingStart < SlotEnd AND BookingEnd > SlotStart
      const overlappingBookings = allBookings.filter((booking) => {
        return booking.startTime < slot.endTime && booking.endTime > slot.startTime;
      });

      const bookedCount = overlappingBookings.length;
      
      let available = true;
      let reason = undefined;

      if (bookedCount >= maxPerSlot) {
        available = false;
        reason = "Slot fully booked";
      }

      return {
        startTime: slot.startTime,
        endTime: slot.endTime,
        available,
        reason
      };
    });

    return {
      date,
      timezone,
      slots: enrichedSlots,
      capacityRemaining: {
        day: maxPerDay ? maxPerDay - allBookings.length : null,
        slots: Object.fromEntries(
          enrichedSlots.map(s => {
            const key = `${s.startTime}-${s.endTime}`;
            // For capacity reporting, we re-calculate overlap count
            const overlapping = allBookings.filter((b) => 
               b.startTime < s.endTime && b.endTime > s.startTime
            ).length;
            return [key, Math.max(0, maxPerSlot - overlapping)];
          })
        )
      }
    };
  }

  private minutesToTime(minutes: number): string {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
  }

  /**
   * Validate if a specific slot is available for a product
   */
  async validateSlotAvailability(
    productId: string,
    slot: { startTime: string; endTime: string; date: string }
  ): Promise<{ isAvailable: boolean; reason?: string }> {
    const profile = await this.getProfileForProduct(productId);
    if (!profile) {
      return { isAvailable: true };
    }

    if (profile.status === "inactive") {
      return { isAvailable: false, reason: "Availability profile is inactive" };
    }

    // 1. Check date rules
    if (profile.date_rules) {
      const { startDate, endDate, blackoutDates } = profile.date_rules;
      if (startDate && slot.date < startDate) {
        return { isAvailable: false, reason: `Availability starts on ${startDate}` };
      }
      if (endDate && slot.date > endDate) {
        return { isAvailable: false, reason: `Availability ended on ${endDate}` };
      }
      if (blackoutDates && Array.isArray(blackoutDates)) {
        const blackout = blackoutDates.find(b => b.date === slot.date);
        if (blackout) {
          return { isAvailable: false, reason: blackout.reason || "Blackout date" };
        }
      }
    }

    // 2. Check weekly schedule
    // Use noon UTC — same reason as getAvailableSlots: new Date(y, m, d) creates
    // midnight server-local (UTC on Vercel) which shifts to the prior calendar day
    // in any UTC-negative timezone when formatted with timeZone.
    const dateObj = new Date(`${slot.date}T12:00:00Z`);

    const dayName = new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      timeZone: profile.timezone || "Africa/Lagos",
    }).format(dateObj);

    const daySchedule = profile.weekly_schedule?.find(s => s.day === dayName);
    if (!daySchedule || !daySchedule.isEnabled) {
      return { isAvailable: false, reason: `Not available on ${dayName}` };
    }

    // 3. Check if slot falls within any of the ranges
    if (daySchedule.ranges && daySchedule.ranges.length > 0) {
      const isWithinRange = daySchedule.ranges.some(r => 
        slot.startTime >= r.startTime && slot.endTime <= r.endTime
      );

      if (!isWithinRange) {
        return { isAvailable: false, reason: "Slot falls outside of available hours" };
      }
    }

    return { isAvailable: true };
  }

  /**
   * Check store-wide availability resolution by slug
   */
  async checkStoreAvailability(storeSlug: string): Promise<{
    isAvailable: boolean;
    reason?: string;
    nextSlot?: { startTime: string; endTime: string; date: string };
  }> {
    const { data: store, error: storeError } = await this.supabase
      .from("stores")
      .select("id, appearance")
      .eq("slug", storeSlug)
      .single();

    if (storeError || !store) {
      throw Object.assign(new Error("Store not found"), { statusCode: 404 });
    }

    const appearance = store.appearance as any;
    if (!appearance || !appearance.availability_profile_id) {
      return { isAvailable: true };
    }

    const { data: profile, error: profileError } = await this.supabase
      .from("availability_profiles")
      .select("*")
      .eq("id", appearance.availability_profile_id)
      .single();

    if (profileError || !profile || (profile as AvailabilityProfile).status === "inactive") {
      return { isAvailable: true };
    }

    return this.resolveAvailability(profile as AvailabilityProfile);
  }

  /**
   * Check store-wide availability resolution by ID
   */
  async checkStoreAvailabilityById(storeId: string): Promise<{
    isAvailable: boolean;
    reason?: string;
    nextSlot?: { startTime: string; endTime: string; date: string };
  }> {
    const { data: store, error: storeError } = await this.supabase
      .from("stores")
      .select("id, appearance")
      .eq("id", storeId)
      .single();

    if (storeError || !store) {
      throw Object.assign(new Error("Store not found"), { statusCode: 404 });
    }

    const appearance = store.appearance as any;
    if (!appearance || !appearance.availability_profile_id) {
      return { isAvailable: true };
    }

    const { data: profile, error: profileError } = await this.supabase
      .from("availability_profiles")
      .select("*")
      .eq("id", appearance.availability_profile_id)
      .single();

    if (profileError || !profile || (profile as AvailabilityProfile).status === "inactive") {
      return { isAvailable: true };
    }

    return this.resolveAvailability(profile as AvailabilityProfile);
  }

  /**
   * Resolve availability for a specific profile
   */
  resolveAvailability(profile: AvailabilityProfile): {
    isAvailable: boolean;
    reason?: string;
    nextSlot?: { startTime: string; endTime: string; date: string };
  } {
    // Get current time in the profile's timezone
    const timezone = profile.timezone || "Africa/Lagos";
    const now = new Date();
    
    // Format current date and time in the specified timezone
    const fmtDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now); // YYYY-MM-DD
    
    const fmtTime = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now); // HH:mm

    const currentDateStr = fmtDate;
    const currentTimeStr = fmtTime;

    // Check date rules
    if (profile.date_rules) {
      const { startDate, endDate, blackoutDates } = profile.date_rules;
      
      if (startDate && currentDateStr < startDate) {
        return { isAvailable: false, reason: `Availability starts on ${startDate}` };
      }
      
      if (endDate && currentDateStr > endDate) {
        return { isAvailable: false, reason: `Availability ended on ${endDate}` };
      }

      if (blackoutDates && Array.isArray(blackoutDates)) {
        const blackout = blackoutDates.find(b => b.date === currentDateStr);
        if (blackout) {
          return { isAvailable: false, reason: blackout.reason || "Blackout date" };
        }
      }
    }

    // Check weekly schedule
    const todayName = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
    }).format(now);
    
    const daySchedule = profile.weekly_schedule?.find(s => s.day === todayName);
    
    if (!daySchedule || !daySchedule.isEnabled) {
      return { isAvailable: false, reason: `Not available on ${todayName}` };
    }

    // Check time slots for today
    if (daySchedule.ranges && daySchedule.ranges.length > 0) {
      const activeRange = daySchedule.ranges.find(r => 
        currentTimeStr >= r.startTime && currentTimeStr <= r.endTime
      );

      if (!activeRange) {
        // Find next slot today if any
        const nextSlotToday = daySchedule.ranges
          .filter(r => r.startTime > currentTimeStr)
          .sort((a, b) => a.startTime.localeCompare(b.startTime))[0];

        return { 
          isAvailable: false, 
          reason: "Outside of available hours",
          nextSlot: nextSlotToday ? { ...nextSlotToday, date: currentDateStr } : undefined
        };
      }
    }

    return { isAvailable: true };
  }

  /**
   * Validate schedule for overlapping ranges
   */
  private validateSchedule(schedule: any) {
    if (!schedule || !Array.isArray(schedule)) return;

    for (const day of schedule) {
      if (!day.isEnabled || !day.ranges || !Array.isArray(day.ranges)) continue;

      const ranges = [...day.ranges].sort((a, b) => a.startTime.localeCompare(b.startTime));
      
      for (let i = 0; i < ranges.length - 1; i++) {
        if (ranges[i].endTime > ranges[i + 1].startTime) {
          throw Object.assign(new Error(`Overlapping time ranges detected on ${day.day}`), { statusCode: 400 });
        }
      }
    }
  }
}
