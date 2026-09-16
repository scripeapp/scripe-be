import { Response, Request } from 'express';
import { supabase } from '../config/supabase';
import { SupabaseRequest } from '../types/http';

const SUPABASE_URL = process.env.SUPABASE_URL || '';

// Helper to transform relative image paths to full Supabase storage URLs
const toFullImageUrl = (path: string | null | undefined): string | null => {
  if (!path) return null;
  // Already a full URL
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  // Add Supabase storage prefix
  return `${SUPABASE_URL}/storage/v1/object/public/${path}`;
};

/**
 * @desc Get all published posts for marketplace feed
 * @access public
 * @endpoint GET /api/marketplace/posts
 */
export const getAllPosts = async (req: SupabaseRequest, res: Response) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const db = req.supabase;

    const { data: posts, error } = await db
      .from('posts')
      .select(`
        *,
        author:user_id(id, name, username),
        publication(
          id, 
          name, 
          profile_image,
          business:businesses(id, marketplace_visibility)
        )
      `)
      .eq('status', 'published')
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (error) throw error;

    // Filter out posts from businesses that have opted out of marketplace
    // We access business visibility via publication relationship
    const visiblePosts = (posts || []).filter(
      (post: any) => post.publication?.business?.marketplace_visibility !== false
    );

    // Add computed metrics
    const postsWithMetrics = visiblePosts.map((post: any) => ({
      ...post,
      open_rate: post.email_sent_count > 0
        ? Math.round((post.email_open_count / post.email_sent_count) * 100)
        : 0
    }));

    return res.status(200).json({
      success: true,
      data: postsWithMetrics,
    });
  } catch (error: any) {
    console.error('Error fetching marketplace posts:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch posts',
      error: error.message,
    });
  }
};

/**
 * @desc Get all public notes for marketplace feed
 * @access public
 * @endpoint GET /api/marketplace/notes
 */
export const getAllNotes = async (req: SupabaseRequest, res: Response) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const db = req.supabase;

    // Note: Since 'notes' table doesn't have a direct business_id FK yet,
    // we assume the note belongs to the user's primary business (where they are owner).
    // We join businesses on owner_user_id.
    const { data: notes, error } = await db
      .from('notes')
      .select(`
        *,
        author:user_id(
          id, 
          name, 
          username,
          business:businesses!owner_user_id(id, marketplace_visibility)
        )
      `)
      .eq('is_private', false)
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (error) throw error;

    // Filter out notes from businesses that have opted out of marketplace
    // We access business visibility via author -> business relationship
    const visibleNotes = (notes || []).filter(
      (note: any) => {
        // No column ties a note to a specific business, so hide the note if ANY owned business is hidden
        const businesses = Array.isArray(note.author?.business)
          ? note.author.business
          : (note.author?.business ? [note.author.business] : []);

        const hasHiddenBusiness = businesses.some((b: any) => b.marketplace_visibility === false);
        return !hasHiddenBusiness;
      }
    );

    return res.status(200).json({
      success: true,
      data: visibleNotes,
    });
  } catch (error: any) {
    console.error('Error fetching marketplace notes:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch notes',
      error: error.message,
    });
  }
};

// ============================================================================
// Store Marketplace Endpoints
// ============================================================================

/**
 * @desc Get products from across all live stores
 * @access public
 * @endpoint GET /api/marketplace/products
 */
export const getMarketplaceProducts = async (req: SupabaseRequest, res: Response) => {
  try {
    const {
      limit = "20",
      offset = "0",
      sort = "newest",
      category,
      search,
    } = req.query;
    const db = req.supabase;

    const limitNum = Math.min(parseInt(limit as string) || 20, 100);
    const offsetNum = parseInt(offset as string) || 0;
    const userId = req.user_id;

    // Build query for published products from live stores where business is visible
    let query = db
      .from("products")
      .select(`
        id,
        slug,
        name,
        price,
        currency,
        cover_image,
        images,
        type,
        orders_count,
        created_at,
        store:stores!inner(
          id,
          name,
          slug,
          is_live,
          business:businesses!inner(marketplace_visibility)
        )
      `, { count: "exact" })
      .eq("status", "published")
      .eq("marketplace_hidden", false)
      .eq("store.is_live", true)
      .eq("store.business.marketplace_visibility", true);

    // Filter by search query if provided
    if (search) {
      const searchQuery = search as string;
      query = query.ilike("name", `%${searchQuery}%`);
    }

    // Filter by category if provided
    if (category) {
      // Find category ID by slug
      const { data: categoryData } = await db
        .from("marketplace_categories")
        .select("id")
        .eq("slug", category)
        .single();
        

      if (categoryData) {
        query = query.eq("marketplace_category_id", categoryData.id);
      } else {
        // Return empty if category doesn't exist
        return res.status(200).json({
          success: true,
          data: [],
          meta: { total: 0, page: Math.floor(offsetNum / limitNum) + 1, limit: limitNum }
        });
      }
    }

    // Apply sorting
    switch (sort) {
      case "best_sellers":
        // Primary: trending_score (time-decayed recent volume + lifetime weight)
        // Fallback: orders_count for products not yet scored (trending_score = 0)
        query = query
          .order("trending_score", { ascending: false, nullsFirst: false })
          .order("orders_count",   { ascending: false, nullsFirst: false });
        break;
      case "trending":
        query = query.order("trending_score", { ascending: false, nullsFirst: false });
        break;
      case "top_revenue":
        query = query.order("revenue_score", { ascending: false, nullsFirst: false });
        break;
      case "price_asc":
        query = query.order("price", { ascending: true });
        break;
      case "price_desc":
        query = query.order("price", { ascending: false });
        break;
      case "newest":
      default:
        query = query.order("created_at", { ascending: false });
        break;
    }

    query = query.range(offsetNum, offsetNum + limitNum - 1);

    const { data: products, error, count } = await query;

    if (error) throw error;

    // Check wishlist status if user is authenticated
    let wishlistedIds = new Set<string>();
    if (userId) {
      const { data: wishlistData } = await db
        .from("wishlists")
        .select("product_id")
        .eq("user_id", userId);
      
      if (wishlistData) {
        wishlistedIds = new Set(wishlistData.map(w => w.product_id));
      }
    }

    const transformedProducts = (products || []).map((product: any) => ({
      id: product.id,
      slug: product.slug,
      name: product.name,
      price: product.price,
      currency: product.currency || "NGN",
      thumbnail: product.cover_image,
      images: product.images || [],
      type: product.type,
      is_wishlisted: userId ? wishlistedIds.has(product.id) : false,
      store: {
        id: product.store.id,
        name: product.store.name,
        slug: product.store.slug,
      },
    }));

    return res.status(200).json({
      success: true,
      data: transformedProducts,
      meta: {
        total: count || 0,
        page: Math.floor(offsetNum / limitNum) + 1,
        limit: limitNum,
      },
    });
  } catch (err: any) {
    console.error("MARKETPLACE_PRODUCTS_ERROR:", err);
    return res.status(500).json({
      success: false,
      error: "MARKETPLACE_PRODUCTS_ERROR",
      message: err.message,
    });
  }
};

/**
 * @desc Get featured/all stores
 * @access public
 * @endpoint GET /api/marketplace/stores
 */
export const getMarketplaceStores = async (req: SupabaseRequest, res: Response) => {
  try {
    const { limit = "10", featured = "false", search, category } = req.query;
    const limitNum = Math.min(parseInt(limit as string) || 10, 50);
    const isFeatured = featured === "true";
    const db = req.supabase;

    let query = db
      .from("stores")
      .select(`
        id,
        name,
        slug,
        appearance,
        created_at,
        business:businesses!inner(marketplace_visibility)
      `)
      .eq("is_live", true)
      .eq("business.marketplace_visibility", true);

    if (isFeatured) {
      query = query.eq("is_featured", true);
    }

    if (search) {
      query = query.ilike("name", `%${search}%`);
    }

    // Stores have no category field of their own — "category" here means
    // "has at least one published product in that category," resolved via
    // the same marketplace_categories slug lookup getMarketplaceProducts
    // uses, then joined through products.
    if (category) {
      const { data: categoryData } = await db
        .from("marketplace_categories")
        .select("id")
        .eq("slug", category)
        .single();

      if (!categoryData) {
        return res.status(200).json({ success: true, data: [] });
      }

      const { data: categoryProducts } = await db
        .from("products")
        .select("store_id")
        .eq("marketplace_category_id", categoryData.id)
        .eq("status", "published");

      const storeIdsInCategory = Array.from(
        new Set((categoryProducts || []).map((p: any) => p.store_id)),
      );

      if (storeIdsInCategory.length === 0) {
        return res.status(200).json({ success: true, data: [] });
      }

      query = query.in("id", storeIdsInCategory);
    }

    query = query.order("created_at", { ascending: false }).limit(limitNum);

    const { data: stores, error } = await query;

    if (error) throw error;

    // Get product thumbnails for each store (up to 4 per store)
    const storeIds = (stores || []).map((s: any) => s.id);
    
    let productsByStore: Record<string, any[]> = {};
    let productCountByStore: Record<string, number> = {};
    if (storeIds.length > 0) {
      const { data: storeProducts } = await db
        .from("products")
        .select("id, store_id, cover_image")
        .in("store_id", storeIds)
        .eq("status", "published");

      (storeProducts || []).forEach((p: any) => {
        productCountByStore[p.store_id] = (productCountByStore[p.store_id] || 0) + 1;
        if (!productsByStore[p.store_id]) productsByStore[p.store_id] = [];
        if (productsByStore[p.store_id].length < 4) {
          productsByStore[p.store_id].push({ thumbnail: p.cover_image });
        }
      });
    }

    const transformedStores = (stores || []).map((store: any) => ({
      id: store.id,
      name: store.name,
      slug: store.slug,
      appearance: {
        logo: store.appearance?.logo || null,
        cover_image: store.appearance?.cover_image || null,
        accent_color: store.appearance?.accent_color || null,
        category: store.appearance?.category || null,
      },
      products: productsByStore[store.id] || [],
      product_count: productCountByStore[store.id] || 0,
    }));

    return res.status(200).json({
      success: true,
      data: transformedStores,
    });
  } catch (err: any) {
    console.error("MARKETPLACE_STORES_ERROR:", err);
    return res.status(500).json({
      success: false,
      error: "MARKETPLACE_STORES_ERROR",
      message: err.message,
    });
  }
};


/**
 * @desc Get available product categories across all stores
 * @access public
 * @endpoint GET /api/marketplace/categories
 */
export const getMarketplaceCategories = async (req: SupabaseRequest, res: Response) => {
  try {
    const db = req.supabase;
    const { data: categories, error } = await db
      .from("marketplace_categories")
      .select("*")
      .eq("is_active", true)
      .order("position", { ascending: true });

    if (error) throw error;

    return res.status(200).json({
      success: true,
      data: categories,
    });
  } catch (err: any) {
    console.error("MARKETPLACE_CATEGORIES_ERROR:", err);
    return res.status(500).json({
      success: false,
      error: "MARKETPLACE_CATEGORIES_ERROR",
      message: err.message,
    });
  }
};

/**
 * @desc Get curated collections/themes
 * @access public
 * @endpoint GET /api/marketplace/collections
 */
export const getMarketplaceCollections = async (req: SupabaseRequest, res: Response) => {
  try {
    const db = req.supabase;
    const { data: collections, error } = await db
      .from("marketplace_collections")
      .select("*")
      .eq("is_active", true)
      .order("display_order");

    if (error) {
      // Table might not exist, return static collections
      if (error.code === "42P01") {
        return res.status(200).json({
          success: true,
          data: [
            {
              id: "morning-essentials",
              title: "Start Your Day Right",
              subtitle: "Morning essentials",
              image_url: null,
              link: "/discover/morning-essentials",
            },
            {
              id: "trending-now",
              title: "Trending Now",
              subtitle: "What's hot this week",
              image_url: null,
              link: "/discover/trending",
            },
            {
              id: "new-arrivals",
              title: "New Arrivals",
              subtitle: "Fresh picks just for you",
              image_url: null,
              link: "/discover/new",
            },
          ],
        });
      }
      throw error;
    }

    const transformedCollections = (collections || []).map((c: any) => ({
      id: c.id,
      title: c.title,
      subtitle: c.subtitle,
      image_url: c.image_url,
      link: c.link || `/discover/${c.slug || c.id}`,
    }));

    return res.status(200).json({
      success: true,
      data: transformedCollections,
    });
  } catch (err: any) {
    console.error("MARKETPLACE_COLLECTIONS_ERROR:", err);
    return res.status(500).json({
      success: false,
      error: "MARKETPLACE_COLLECTIONS_ERROR",
      message: err.message,
    });
  }
};

// ============================================================================
// Marketplace Orders & Wishlist (Authenticated)
// ============================================================================

/**
 * @desc Fetch current user's order history (both product orders and event tickets)
 * @access private
 * @endpoint GET /api/marketplace/orders
 */
export const getMarketplaceOrders = async (req: SupabaseRequest, res: Response) => {
  try {
    const userId = req.user_id;
    const db = req.supabase;

    // Get user's email for matching historical guest purchases
    const { data: userData } = await db
      .from("users")
      .select("email")
      .eq("id", userId)
      .single();
    
    const userEmail = userData?.email;

    // Fetch store product orders (by user_id OR customer_email)
    let productQuery = db
      .from("store_orders")
      .select(`
        *,
        store:stores(id, name, slug)
      `)
      .order("created_at", { ascending: false });
    
    if (userEmail) {
      productQuery = productQuery.or(`user_id.eq.${userId},customer_email.eq.${userEmail}`);
    } else {
      productQuery = productQuery.eq("user_id", userId);
    }
    
    const { data: productOrders, error: productError } = await productQuery;
    if (productError) throw productError;

    // Fetch event ticket orders (by user_id OR customer email via customer table)
    // First get customer records for this email
    let ticketOrders: any[] = [];
    
    // Query by user_id
    const { data: userTickets, error: userTicketError } = await db
      .from("orders")
      .select(`
        *,
        event:events(id, event_name, start_date, cover_image)
      `)
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    
    if (userTicketError) throw userTicketError;
    ticketOrders = userTickets || [];

    // Also fetch by customer_id if email matches
    if (userEmail) {
      const { data: customers } = await db
        .from("customers")
        .select("id")
        .eq("email", userEmail);
      
      if (customers && customers.length > 0) {
        const customerIds = customers.map(c => c.id);
        const { data: emailTickets } = await db
          .from("orders")
          .select(`
            *,
            event:events(id, event_name, start_date, cover_image)
          `)
          .in("customer_id", customerIds)
          .order("created_at", { ascending: false });
        
        // Merge and deduplicate by order id
        if (emailTickets) {
          const existingIds = new Set(ticketOrders.map(o => o.id));
          emailTickets.forEach(order => {
            if (!existingIds.has(order.id)) {
              ticketOrders.push(order);
            }
          });
        }
      }
    }

    // Sort merged results by date
    ticketOrders.sort((a, b) => 
      new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
    );

    // Return both in a structured format
    return res.status(200).json({
      success: true,
      data: {
        product_orders: (productOrders || []).map(order => ({
          ...order,
          order_type: "product",
          // Transform store cover images if needed
          store: order.store ? {
            ...order.store,
          } : null,
        })),
        ticket_orders: ticketOrders.map(order => ({
          ...order,
          order_type: "ticket",
          // Transform event cover_image to full URL
          event: order.event ? {
            ...order.event,
            cover_image: toFullImageUrl(order.event.cover_image),
          } : null,
        })),
      },
    });
  } catch (err: any) {
    console.error("MARKETPLACE_ORDERS_ERROR:", err);
    return res.status(500).json({
      success: false,
      error: "MARKETPLACE_ORDERS_ERROR",
      message: err.message,
    });
  }
};

/**
 * @desc Fetch detailed information for a single order
 * @access private
 * @endpoint GET /api/marketplace/orders/:id
 */
export const getMarketplaceOrderDetails = async (req: SupabaseRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user_id;
    const db = req.supabase;

    const { data: order, error } = await db
      .from("orders")
      .select(`
        *,
        store:stores(id, name, slug)
      `)
      .eq("id", id)
      .eq("user_id", userId)
      .single();

    if (error) throw error;

    return res.status(200).json({
      success: true,
      data: order,
    });
  } catch (err: any) {
    console.error("MARKETPLACE_ORDER_DETAILS_ERROR:", err);
    const status = err.code === "PGRST116" ? 404 : 500;
    return res.status(status).json({
      success: false,
      error: "MARKETPLACE_ORDER_DETAILS_ERROR",
      message: err.message,
    });
  }
};

/**
 * @desc Fetch all products in the user's wishlist
 * @access private
 * @endpoint GET /api/marketplace/wishlist
 */
export const getMarketplaceWishlist = async (req: SupabaseRequest, res: Response) => {
  try {
    const userId = req.user_id;
    const db = req.supabase;

    const { data: wishlist, error } = await db
      .from("wishlists")
      .select(`
        id,
        created_at,
        product:products(
          id,
          name,
          price,
          currency,
          cover_image,
          type,
          store:stores(id, name, slug)
        )
      `)
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    const transformedWishlist = (wishlist || [])
      .map((item: any) => item.product)
      .filter(Boolean);

    return res.status(200).json({
      success: true,
      data: transformedWishlist,
    });
  } catch (err: any) {
    console.error("MARKETPLACE_WISHLIST_ERROR:", err);
    return res.status(500).json({
      success: false,
      error: "MARKETPLACE_WISHLIST_ERROR",
      message: err.message,
    });
  }
};

/**
 * @desc Toggle an item in the wishlist
 * @access private
 * @endpoint POST /api/marketplace/wishlist
 */
export const toggleWishlist = async (req: SupabaseRequest, res: Response) => {
  try {
    const { productId } = req.body;
    const userId = req.user_id;
    const db = req.supabase;

    if (!productId) {
      return res.status(400).json({ success: false, error: "Product ID is required" });
    }

    // Check if it already exists
    const { data: existing } = await db
      .from("wishlists")
      .select("id")
      .eq("user_id", userId)
      .eq("product_id", productId)
      .single();

    if (existing) {
      // Remove it
      const { error: deleteError } = await db
        .from("wishlists")
        .delete()
        .eq("id", existing.id);
      
      if (deleteError) throw deleteError;

      return res.status(200).json({
        success: true,
        action: "removed",
        message: "Product removed from wishlist",
      });
    } else {
      // Add it
      const { error: insertError } = await db
        .from("wishlists")
        .insert({
          user_id: userId,
          product_id: productId,
        });
      
      if (insertError) throw insertError;

      return res.status(201).json({
        success: true,
        action: "added",
        message: "Product added to wishlist",
      });
    }
  } catch (err: any) {
    console.error("TOGGLE_WISHLIST_ERROR:", err);
    return res.status(500).json({
      success: false,
      error: "TOGGLE_WISHLIST_ERROR",
      message: err.message,
    });
  }
};

/**
 * @desc specifically remove an item from wishlist
 * @access private
 * @endpoint DELETE /api/marketplace/wishlist/:productId
 */
export const removeFromWishlist = async (req: SupabaseRequest, res: Response) => {
  try {
    const { productId } = req.params;
    const userId = req.user_id;
    const db = req.supabase;

    const { error } = await db
      .from("wishlists")
      .delete()
      .eq("user_id", userId)
      .eq("product_id", productId);

    if (error) throw error;

    return res.status(200).json({
      success: true,
      message: "Product removed from wishlist",
    });
  } catch (err: any) {
    console.error("REMOVE_FROM_WISHLIST_ERROR:", err);
    return res.status(500).json({
      success: false,
      error: "REMOVE_FROM_WISHLIST_ERROR",
      message: err.message,
    });
  }
};


