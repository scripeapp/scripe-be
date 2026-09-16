import { SupabaseClient } from "@supabase/supabase-js";

/**
 * User Address
 * Represents a saved delivery address
 */
export interface UserAddress {
  id: string;
  user_id: string;
  label: string | null;
  is_default: boolean;
  recipient_name: string;
  phone: string;
  address_line_1: string;
  address_line_2: string | null;
  city: string;
  state: string;
  postal_code: string | null;
  country: string;
  latitude: number | null;
  longitude: number | null;
  shipbubble_address_code: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * Address Service
 * Handles user address CRUD operations
 */
export class AddressService {
  constructor(private supabase: SupabaseClient) {}

  /**
   * List all addresses for a user
   * Sorted by is_default DESC, created_at DESC
   */
  async listAddresses(userId: string): Promise<UserAddress[]> {
    const { data, error } = await this.supabase
      .from("user_addresses")
      .select("*")
      .eq("user_id", userId)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: false });

    if (error) throw error;
    return (data || []) as UserAddress[];
  }

  /**
   * Create a new address
   * If is_default is true, trigger will clear other defaults
   * If this is user's first address, auto-set as default
   */
  async createAddress(
    userId: string,
    input: {
      label?: string;
      recipient_name: string;
      phone: string;
      address_line_1: string;
      address_line_2?: string;
      city: string;
      state: string;
      postal_code?: string;
      country?: string;
      is_default?: boolean;
      latitude?: number;
      longitude?: number;
      shipbubble_address_code?: number;
    }
  ): Promise<UserAddress> {
    // Check if user has any existing addresses
    const { count } = await this.supabase
      .from("user_addresses")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId);

    // If no existing addresses, auto-set as default
    const isDefault = count === 0 ? true : input.is_default ?? false;

    const addressData = {
      user_id: userId,
      label: input.label || null,
      is_default: isDefault,
      recipient_name: input.recipient_name,
      phone: input.phone,
      address_line_1: input.address_line_1,
      address_line_2: input.address_line_2 || null,
      city: input.city,
      state: input.state,
      postal_code: input.postal_code || null,
      country: input.country || "Nigeria",
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      shipbubble_address_code: input.shipbubble_address_code ?? null,
    };

    const { data, error } = await this.supabase
      .from("user_addresses")
      .insert([addressData])
      .select("*")
      .single();

    if (error) throw error;
    return data as UserAddress;
  }

  /**
   * Update an existing address
   * Validates ownership via RLS
   */
  async updateAddress(
    userId: string,
    addressId: string,
    updates: {
      label?: string;
      recipient_name?: string;
      phone?: string;
      address_line_1?: string;
      address_line_2?: string | null;
      city?: string;
      state?: string;
      postal_code?: string | null;
      country?: string;
      is_default?: boolean;
      latitude?: number | null;
      longitude?: number | null;
      shipbubble_address_code?: number | null;
    }
  ): Promise<UserAddress> {
    // Build update object, only include provided fields
    const updateData: Record<string, any> = {};
    if (updates.label !== undefined) updateData.label = updates.label;
    if (updates.recipient_name !== undefined) updateData.recipient_name = updates.recipient_name;
    if (updates.phone !== undefined) updateData.phone = updates.phone;
    if (updates.address_line_1 !== undefined) updateData.address_line_1 = updates.address_line_1;
    if (updates.address_line_2 !== undefined) updateData.address_line_2 = updates.address_line_2;
    if (updates.city !== undefined) updateData.city = updates.city;
    if (updates.state !== undefined) updateData.state = updates.state;
    if (updates.postal_code !== undefined) updateData.postal_code = updates.postal_code;
    if (updates.country !== undefined) updateData.country = updates.country;
    if (updates.is_default !== undefined) updateData.is_default = updates.is_default;
    if (updates.latitude !== undefined) updateData.latitude = updates.latitude;
    if (updates.longitude !== undefined) updateData.longitude = updates.longitude;
    if (updates.shipbubble_address_code !== undefined)
      updateData.shipbubble_address_code = updates.shipbubble_address_code;

    // Invalidate the cached Shipbubble code when the address text changes but
    // no fresh code was supplied — forces re-validation on next checkout so we
    // never quote/ship against a stale, mismatched address_code.
    const addressChanged =
      updates.address_line_1 !== undefined ||
      updates.city !== undefined ||
      updates.state !== undefined;
    if (addressChanged && updates.shipbubble_address_code === undefined) {
      updateData.shipbubble_address_code = null;
      updateData.latitude = updates.latitude ?? null;
      updateData.longitude = updates.longitude ?? null;
    }

    const { data, error } = await this.supabase
      .from("user_addresses")
      .update(updateData)
      .eq("id", addressId)
      .eq("user_id", userId)
      .select("*")
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        throw Object.assign(new Error("Address not found"), { statusCode: 404 });
      }
      throw error;
    }

    return data as UserAddress;
  }

  /**
   * Delete an address
   * If it was default and other addresses exist, set most recent as default
   */
  async deleteAddress(userId: string, addressId: string): Promise<void> {
    // Get the address to check if it's default
    const { data: address, error: fetchError } = await this.supabase
      .from("user_addresses")
      .select("id, is_default")
      .eq("id", addressId)
      .eq("user_id", userId)
      .single();

    if (fetchError) {
      if (fetchError.code === "PGRST116") {
        // Already deleted or doesn't exist - idempotent
        return;
      }
      throw fetchError;
    }

    // Delete the address
    const { error: deleteError } = await this.supabase
      .from("user_addresses")
      .delete()
      .eq("id", addressId)
      .eq("user_id", userId);

    if (deleteError) throw deleteError;

    // If deleted address was default, reassign to most recent
    if (address.is_default) {
      const { data: remaining } = await this.supabase
        .from("user_addresses")
        .select("id")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (remaining) {
        await this.supabase
          .from("user_addresses")
          .update({ is_default: true })
          .eq("id", remaining.id);
      }
    }
  }

  /**
   * Set an address as the default
   * Clears default on all other addresses (via trigger)
   */
  async setDefaultAddress(userId: string, addressId: string): Promise<UserAddress> {
    const { data, error } = await this.supabase
      .from("user_addresses")
      .update({ is_default: true })
      .eq("id", addressId)
      .eq("user_id", userId)
      .select("*")
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        throw Object.assign(new Error("Address not found"), { statusCode: 404 });
      }
      throw error;
    }

    return data as UserAddress;
  }
}
