import { SupabaseRequest } from '../types/http';
import { Request, Response } from 'express';
import { createPurchaseService } from '../services/purchase.service';
import { IssuedTicketRecord } from 'src/types/models';
import ApiResponse from '../utils/apiResponse';

interface TicketRow { id: string; ticket_name: string; ticket_price: number; available_quantity: number }
interface TicketSaleRow { order_id: string; quantity_sold: number; ticket: TicketRow }
interface OrderRow { id: string; total_amount: number; order_date: string }

const normalizeRevenueSource = (source?: string | null) => {
  if (!source) return "other";
  if (source === "scheduling_payment") return "scheduling";
  return source;
};

/**
 * @desc Get dashboard statistics (revenue, customers, subscribers) with latest lists
 * @access private
 * @endpoint GET /api/dashboard/stats
 */
export const getDashboardStats = async (req: SupabaseRequest, res: Response) => {
  const supabaseClient = req.supabase!;
  const user_id = req.user_id; // Keep strict user checking if needed, but primary scope is business
  const businessId = (req as any).businessId || req.query.business_id;

  if (!businessId) {
    return res.status(400).json({ success: false, error: "Business context required" });
  }

  try {
    // 1. Get ALL stores for this BUSINESS
    const { data: stores } = await supabaseClient
      .from("stores")
      .select("id")
      .eq("business_id", businessId);

    let storeRevenue = 0;
    let latestOrders: any[] = [];
    let topProducts: any[] = [];
    const allStoreOrders: any[] = [];

    if (stores && stores.length > 0) {
      const storeIds = stores.map(s => s.id);

      // Get store orders for revenue calculation
      const { data: storeOrders } = await supabaseClient
        .from("store_orders")
        .select("id, order_number, customer_name, customer_email, items, total, currency, status, created_at, store_id")
        .in("store_id", storeIds)
        .in("status", ["paid", "fulfilled"]);

      if (storeOrders) {
        storeRevenue = storeOrders.reduce((sum, order) => sum + (Number(order.total) || 0), 0);
        allStoreOrders.push(...storeOrders);
      }

      // Get latest 5 orders
      const { data: recentOrders } = await supabaseClient
        .from("store_orders")
        .select("id, order_number, customer_name, items, total, currency, created_at")
        .in("store_id", storeIds)
        .order("created_at", { ascending: false })
        .limit(5);

      if (recentOrders) {
        latestOrders = recentOrders.map(order => {
          const items = order.items as Array<{ product_name?: string; name?: string }>;
          const firstItem = Array.isArray(items) && items.length > 0 ? items[0] : null;
          return {
            id: order.id,
            order_number: order.order_number,
            customer_name: order.customer_name,
            product_name: firstItem?.product_name || firstItem?.name || "Product",
            amount: order.total,
            currency: order.currency || "NGN",
            created_at: order.created_at,
          };
        });
      }

      // Get top 5 products by sold count
      const { data: products } = await supabaseClient
        .from("products")
        .select("id, name, cover_image")
        .in("store_id", storeIds)
        .eq("status", "published")
        .limit(10);

      if (products && allStoreOrders.length > 0) {
        // Calculate sold counts
        const soldCounts: Record<string, number> = {};
        for (const order of allStoreOrders) {
          const items = order.items as Array<{ product_id: string; quantity: number }>;
          if (Array.isArray(items)) {
            for (const item of items) {
              if (item.product_id) {
                soldCounts[item.product_id] = (soldCounts[item.product_id] || 0) + (item.quantity || 1);
              }
            }
          }
        }

        topProducts = products
          .map(p => ({
            id: p.id,
            name: p.name,
            sold_count: soldCounts[p.id] || 0,
            cover_image: p.cover_image,
          }))
          .sort((a, b) => b.sold_count - a.sold_count)
          .slice(0, 5);
      }
    }

    // 2. Get unified business revenue so overview totals include stores, events,
    // publications, circles, and scheduling in one source of truth.
    const { data: allRevenueRows, error: revenueError } = await supabaseClient
      .from("business_revenue_ledger_view")
      .select("amount, created_at, source, currency")
      .eq("business_id", businessId)
      .eq("status", "paid");

    if (revenueError) throw revenueError;

    // Optional currency filter: shows what the business has actually
    // collected in that currency (each ledger row carries its own real
    // settlement currency — NGN via Paystack, or USD/GBP/etc via
    // Flutterwave). Deliberately NOT a live-rate conversion of NGN
    // totals — rates drift day to day, which would silently change what a
    // past period "made" every time you looked at it. No matching rows
    // just means ₦/$/etc. 0 was genuinely collected in that currency.
    const requestedCurrency =
      typeof req.query.currency === "string" && req.query.currency.trim()
        ? req.query.currency.trim().toUpperCase()
        : null;
    const revenueRows = requestedCurrency
      ? (allRevenueRows || []).filter(
          (row) => (row.currency || "NGN").toUpperCase() === requestedCurrency,
        )
      : allRevenueRows;

    const revenueBreakdown = (revenueRows || []).reduce<Record<string, number>>(
      (acc, row) => {
        const source = normalizeRevenueSource(row.source);
        acc[source] = (acc[source] || 0) + (Number(row.amount) || 0);
        return acc;
      },
      {},
    );

    const totalRevenue = Object.values(revenueBreakdown).reduce(
      (sum, value) => sum + value,
      0,
    );
    const paidCount = (revenueRows || []).length;

    // 3. Get total customers and latest 5 from CRM (Scoped by Business)
    let totalCustomers = 0;
    let latestCustomers: any[] = [];

    // Try unified view first
    const { data: unifiedContacts, count: unifiedCount, error: unifiedError } = await supabaseClient
      .from("crm_contacts_unified")
      .select("id, name, email, created_at", { count: "exact" })
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(5);

    if (!unifiedError && unifiedContacts) {
      totalCustomers = unifiedCount || 0;
      latestCustomers = unifiedContacts.map(c => ({
        id: c.id,
        name: c.name,
        email: c.email,
        created_at: c.created_at,
      }));
    } else {
      // Fallback to contacts table
      const { data: contacts, count: contactsCount } = await supabaseClient
        .from("contacts")
        .select("id, name, email, created_at", { count: "exact" })
        .eq("business_id", businessId)
        .order("created_at", { ascending: false })
        .limit(5);

      totalCustomers = contactsCount || 0;
      if (contacts) {
        latestCustomers = contacts.map(c => ({
          id: c.id,
          name: c.name,
          email: c.email,
          created_at: c.created_at,
        }));
      }
    }

    // 4. Get total subscribers and latest 5
    const { data: publications } = await supabaseClient
      .from("publications")
      .select("id")
      .eq("business_id", businessId);

    let totalSubscribers = 0;
    let latestSubscribers: any[] = [];

    if (publications && publications.length > 0) {
      const pubIds = publications.map(p => p.id);

      // Get unique subscriber count instead of total subscriptions
      // We must paginate because Supabase limits responses to 1000 rows by default
      let allSubscriberIds: string[] = [];
      
      const { count: totalSubsCount } = await supabaseClient
        .from("subscriptions")
        .select("*", { count: "exact", head: true })
        .in("publication_id", pubIds);

      const BATCH_SIZE = 1000;
      const totalToFetch = totalSubsCount || 0;
      
      for (let offset = 0; offset < totalToFetch; offset += BATCH_SIZE) {
        const { data: batch } = await supabaseClient
          .from("subscriptions")
          .select("user_id")
          .in("publication_id", pubIds)
          .range(offset, offset + BATCH_SIZE - 1);
          
        if (batch) {
          allSubscriberIds.push(...batch.map(s => s.user_id));
        }
      }
      
      const uniqueUsers = new Set(allSubscriberIds.filter(id => id));
      totalSubscribers = uniqueUsers.size;

      // Get latest subscribers with user info
      const { data: recentSubs } = await supabaseClient
        .from("subscriptions")
        .select("id, user_id, subscribed_at, publication_id")
        .in("publication_id", pubIds)
        .order("subscribed_at", { ascending: false })
        .limit(5);

      if (recentSubs && recentSubs.length > 0) {
        // Fetch user details for subscribers
        const userIds = recentSubs.map(s => s.user_id);
        const { data: users } = await supabaseClient
          .from("users")
          .select("id, name, email")
          .in("id", userIds);

        const userMap = new Map((users || []).map(u => [u.id, u]));

        latestSubscribers = recentSubs.map(sub => {
          const user = userMap.get(sub.user_id);
          return {
            id: sub.id,
            name: user?.name || "Subscriber",
            email: user?.email || "",
            subscribed_at: sub.subscribed_at,
          };
        });
      }
    }

    // 5. Generate chart data based on requested period
    const chartData: { date: string; revenue: number; subscribers: number; customers: number }[] = [];
    const today = new Date();
    
    const period = (req.query.period as string) || "90 days";
    let daysToShow = 90;

    switch (period.toLowerCase()) {
      case "today": daysToShow = 1; break;
      case "7 days": daysToShow = 7; break;
      case "14 days": daysToShow = 14; break;
      case "30 days": daysToShow = 30; break;
      case "90 days": daysToShow = 90; break;
      case "180 days": daysToShow = 180; break;
      case "1 year": daysToShow = 365; break;
      case "all time": 
        // Find the earliest date from orders/subs to determine range, or default to a reasonable max
        // For simplicity/performance, let's cap "All time" at 2 years for the chart view
        daysToShow = 730; 
        break;
      default: daysToShow = 90;
    }

    // Build a map of revenue by date from the unified revenue ledger
    const revenueByDate: Record<string, number> = {};
    for (const revenueRow of revenueRows || []) {
      const dateKey = new Date(revenueRow.created_at).toISOString().split('T')[0];
      revenueByDate[dateKey] =
        (revenueByDate[dateKey] || 0) + (Number(revenueRow.amount) || 0);
    }

    // Build a map of subscribers by date
    const subscribersByDate: Record<string, number> = {};
    if (publications && publications.length > 0) {
      const pubIds = publications.map(p => p.id);
      
      const allSubsDates: string[] = [];
      let offset = 0;
      while (true) {
        const { data: batch } = await supabaseClient
          .from("subscriptions")
          .select("subscribed_at")
          .in("publication_id", pubIds)
          .range(offset, offset + 999);
          
        if (!batch || batch.length === 0) break;
        allSubsDates.push(...batch.map((s: any) => s.subscribed_at));
        if (batch.length < 1000) break;
        offset += 1000;
      }

      for (const dateStr of allSubsDates) {
        const dateKey = new Date(dateStr).toISOString().split('T')[0];
        subscribersByDate[dateKey] = (subscribersByDate[dateKey] || 0) + 1;
      }
    }

    // Build a map of customers by date (from CRM contacts)
    const customersByDate: Record<string, number> = {};
    
    // Fetch all contact dates with pagination
    let allContactDates: string[] = [];
    let offset = 0;
    let useUnified = true;

    // Try unified view first
    while (true) {
       const { data: batch, error } = await supabaseClient
          .from("crm_contacts_unified")
          .select("created_at")
          .eq("business_id", businessId)
          .range(offset, offset + 999);
       
       if (error) {
         useUnified = false;
         break; 
       }
       
       if (!batch || batch.length === 0) break;
       allContactDates.push(...batch.map((c: any) => c.created_at));
       if (batch.length < 1000) break;
       offset += 1000;
    }

    if (!useUnified) {
       // Fallback to contacts table
       allContactDates = [];
       offset = 0;
       while (true) {
          const { data: batch, error } = await supabaseClient
            .from("contacts")
            .select("created_at")
            .eq("business_id", businessId)
            .range(offset, offset + 999);
            
          if (error) {
             console.error("Error fetching contacts for chart:", error);
             break;
          }
          
          if (!batch || batch.length === 0) break;
          allContactDates.push(...batch.map((c: any) => c.created_at));
          if (batch.length < 1000) break;
          offset += 1000;
       }
    }

    for (const dateStr of allContactDates) {
      if (dateStr) {
        const dateKey = new Date(dateStr).toISOString().split('T')[0];
        customersByDate[dateKey] = (customersByDate[dateKey] || 0) + 1;
      }
    }

    // Generate chart points for each day
    for (let i = daysToShow - 1; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateKey = date.toISOString().split('T')[0];
      
      chartData.push({
        date: dateKey,
        revenue: revenueByDate[dateKey] || 0,
        subscribers: subscribersByDate[dateKey] || 0,
        customers: customersByDate[dateKey] || 0,
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        revenue: {
          total: totalRevenue,
          currency: requestedCurrency || "NGN",
          breakdown: revenueBreakdown,
          // Count of paid ledger entries in this currency — lets the
          // frontend compute a currency-correct average sale instead of
          // dividing by an all-currency order count.
          paid_count: paidCount,
        },
        total_customers: totalCustomers,
        total_subscribers: totalSubscribers,
        period: "all_time",
        latest_customers: latestCustomers,
        latest_subscribers: latestSubscribers,
        latest_orders: latestOrders,
        top_products: topProducts,
        chart: chartData,
      },
    });
  } catch (error: any) {
    console.error("Error fetching dashboard stats:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch dashboard stats",
      details: error?.message,
    });
  }
};

/**
 * @desc Fetching events for the dashboard
 * @access private
 * @endpoint /api/dashboard/events
 */
export const getUserEvents = async (req: SupabaseRequest, res: Response) => {
  const supabaseClient = req.supabase!; // Use the authenticated client
  const businessId = (req as any).businessId || req.query.business_id;

  if (!businessId) {
    return res.status(400).json({ success: false, error: "Business context required" });
  }

  try {
    const { data: events, error: eventError } = await supabaseClient
      .from("events")
      .select(
        "event_name, id, status, event_type, venue, cover_image, is_online,is_physical, event_url"
      )
      .eq("business_id", businessId);

    if (eventError) throw eventError;

    // required info: Event Name, Sold, Revenue

    // const eventsWithStats = await Promise.all(
    //   (events || []).map(async (event: any) => {
    //     const { data: tickets, error: ticketError } = await supabaseClient
    //       .from("event_tickets")
    //       .select()
    //       .eq("event_id", event.id);

    //     if (ticketError) throw ticketError;

    //     const { data: ticketSales, error: ticketSalesError } =
    //       await supabaseClient
    //         .from("ticket_sales")
    //         .select("*, ticket:ticket_id(*)")
    //         .in(
    //           "ticket_id",
    //           (tickets || []).map((ticket: any) => ticket.id)
    //         );
    //     if (ticketSalesError) throw ticketSalesError;

    //     // Calculate sold and revenue
    //     const sold = (ticketSales as TicketSaleRow[]).reduce(
    //       (acc, sale) => acc + sale.quantity_sold,
    //       0
    //     );

    //     const revenue = (ticketSales as TicketSaleRow[]).reduce(
    //       (acc, sale) => acc + sale.quantity_sold * sale.ticket.ticket_price,
    //       0
    //     );

    //     return {
    //       ...event,
    //       sold,
    //       revenue,
    //     };
    //   })
    // );
    const eventsWithStats = await Promise.all(
      (events || []).map(async (event: any) => {
        // const { data: tickets, error: ticketError } = await supabaseClient
        //   .from("event_tickets")
        //   .select()
        //   .eq("event_id", event.id);

        // if (ticketError) throw ticketError;

        // Get the count of issued tickets first
        const { count, error: countError } = await supabaseClient
          .from("issued_tickets")
          .select("*", { count: "exact", head: true })
          .eq("event_id", event.id);
        if (countError) throw countError;

        // Paginate through all issued tickets to calculate revenue
        const BATCH_SIZE = 1000;
        let allIssuedTickets: IssuedTicketRecord[] = [];
        const totalCount = count || 0;

        for (let offset = 0; offset < totalCount; offset += BATCH_SIZE) {
          const { data: batch, error: batchError } = await supabaseClient
            .from("issued_tickets")
            .select("ticket_price")
            .eq("event_id", event.id)
            .range(offset, offset + BATCH_SIZE - 1);

          if (batchError) throw batchError;
          if (batch) allIssuedTickets = allIssuedTickets.concat(batch as IssuedTicketRecord[]);
        }

        // Calculate sold and revenue
        const sold = count;

        const revenue = allIssuedTickets.reduce(
          (acc, t) => acc + (Number(t.ticket_price) || 0),
          0
        );
        console.log('user revenue', revenue, 'tickets fetched:', allIssuedTickets.length); 

        return {
          ...event,
          sold,
          revenue,
        };
      })
    );

    console.log('user events', eventsWithStats);

    return res.status(200).json({
      success: true,
      data: eventsWithStats,
    });
  } catch (error: any) {
    console.error("Error fetching user events:", error);
    return res.status(500).json({
      error: "Failed to fetch user events",
      details: error?.message,
    });
  }
};

/**
 * @desc Get a single event with detailed statistics
 * @access private
 * @endpoint /api/dashboard/events/:id
 */
export const getEvent = async (req: SupabaseRequest, res: Response) => {
  const supabaseClient = req.supabase!;
  const businessId = (req as any).businessId || req.query.business_id;
  const event_id = req.params.id;

  if (!businessId) {
    return res.status(400).json({ success: false, error: "Business context required" });
  }

  try {
    // Get event details with owner information
    const { data: event, error: eventError } = await supabaseClient
      .from("events")
      .select("*, owner:owner_id(*)")
      .eq("id", event_id)
      .eq("business_id", businessId)
      .single();

    if (eventError) throw eventError;

    // Get all orders with customer information for the event
    const { data: orders, error: ordersError } = await supabaseClient
      .from("orders")
      .select("*, customer:customer_id(*)")
      .eq("event_id", event_id)
      .order("order_date", { ascending: false });

    if (ordersError) throw ordersError;

    // Get all ticket sales with ticket information for these orders
    // Batch the query to avoid URL length limits when there are many orders
    const orderIds = (orders || []).map((order: any) => order.id);
    const BATCH_SIZE = 50;
    let ticketSales: any[] = [];
    
    for (let i = 0; i < orderIds.length; i += BATCH_SIZE) {
      const batchIds = orderIds.slice(i, i + BATCH_SIZE);
      if (batchIds.length === 0) continue;
      
      const { data: batchSales, error: ticketSalesError } = await supabaseClient
        .from("ticket_sales")
        .select("*, ticket:ticket_id(*)")
        .in("order_id", batchIds);
      
      if (ticketSalesError) throw ticketSalesError;
      if (batchSales) ticketSales = ticketSales.concat(batchSales);
    }

    // Get all tickets for the event
    const { data: tickets, error: ticketsError } = await supabaseClient
      .from("event_tickets")
      .select()
      .eq("event_id", event_id)
      .order("ticket_price", { ascending: true });

    if (ticketsError) throw ticketsError;

    // Group ticket sales by ticket type (for backward compatibility)
    const salesByTicket = (ticketSales as TicketSaleRow[]).reduce((acc: any, sale) => {
      const ticketId = sale.ticket.id;
      if (!acc[ticketId]) {
        acc[ticketId] = {
          ticket_id: ticketId,
          ticket_name: sale.ticket.ticket_name,
          quantity_sold: 0,
          revenue: 0,
          available_quantity: sale.ticket.available_quantity,
          price: sale.ticket.ticket_price,
        };
      }
      acc[ticketId].quantity_sold += sale.quantity_sold;
      acc[ticketId].revenue += sale.quantity_sold * sale.ticket.ticket_price;
      return acc;
    }, {} as Record<string, any>);

    // Fetch all issued tickets with pagination (source of truth for revenue & sold)
    const { count: issuedTicketCount, error: countError } = await supabaseClient
      .from("issued_tickets")
      .select("*", { count: "exact", head: true })
      .eq("event_id", event_id);
    if (countError) throw countError;

    const ISSUED_BATCH_SIZE = 1000;
    let allIssuedTickets: IssuedTicketRecord[] = [];
    const totalIssuedCount = issuedTicketCount || 0;

    for (let offset = 0; offset < totalIssuedCount; offset += ISSUED_BATCH_SIZE) {
      const { data: batch, error: batchError } = await supabaseClient
        .from("issued_tickets")
        .select("ticket_price, ticket_name")
        .eq("event_id", event_id)
        .range(offset, offset + ISSUED_BATCH_SIZE - 1);

      if (batchError) throw batchError;
      if (batch) allIssuedTickets = allIssuedTickets.concat(batch as IssuedTicketRecord[]);
    }

    // Group issued tickets by ticket name for accurate stats
    const salesByTicketFromIssued = allIssuedTickets.reduce((acc: any, ticket) => {
      const ticketName = ticket.ticket_name;
      if (!acc[ticketName]) {
        acc[ticketName] = {
          ticket_name: ticketName,
          quantity_sold: 0,
          revenue: 0,
          price: Number(ticket.ticket_price) || 0,
        };
      }
      acc[ticketName].quantity_sold += 1;
      acc[ticketName].revenue += Number(ticket.ticket_price) || 0;
      return acc;
    }, {} as Record<string, any>);

    // Calculate event statistics using issued tickets as source of truth
    const statistics = calculateEventStatistics(
      Object.values(salesByTicketFromIssued),
      orders as OrderRow[],
      allIssuedTickets
    );

    // Add time-based analytics
    const timeAnalytics = calculateTimeBasedAnalytics(orders, ticketSales);

    return res.status(200).json({
      success: true,
      data: {
        ...event,
        tickets,
        ticketSales,
        orders,
        statistics,
        timeAnalytics,
      },
    });
  } catch (error: any) {
    console.error("Error fetching event:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch event",
      details: error?.message,
    });
  }
};

/**
 * Calculate comprehensive event statistics
 * @param salesByTicketType - Sales grouped by ticket type
 * @param orders - All orders for the event
 * @param issuedTickets - Optional: All issued tickets (source of truth for revenue & sold count)
 */
const calculateEventStatistics = (
  salesByTicketType: any[],
  orders: OrderRow[],
  issuedTickets?: IssuedTicketRecord[]
) => {
  // Calculate basic metrics
  const totalOrders = orders.length;

  // Use issued tickets as source of truth if available, otherwise fall back to orders
  let totalRevenue: number;
  let totalTicketsSold: number;

  if (issuedTickets && issuedTickets.length > 0) {
    // Source of truth: issued_tickets table
    totalTicketsSold = issuedTickets.length;
    totalRevenue = issuedTickets.reduce(
      (acc, ticket) => acc + (Number(ticket.ticket_price) || 0),
      0
    );
  } else {
    // Fallback to orders/sales data
    totalRevenue = orders.reduce(
      (acc, order) => acc + order.total_amount,
      0
    );
    totalTicketsSold = salesByTicketType.reduce(
      (acc, ticket) => acc + ticket.quantity_sold,
      0
    );
  }

  const totalAvailableTickets = salesByTicketType.reduce(
    (acc, ticket) => acc + (ticket.available_quantity || 0),
    0
  );

  return {
    totalTicketsSold,
    totalRevenue,
    totalOrders,
    salesByTicketType,
    ticketUtilization:
      totalAvailableTickets > 0
        ? (totalTicketsSold / totalAvailableTickets) * 100
        : 0,
    averageOrderValue: totalOrders > 0 ? totalRevenue / totalOrders : 0,
  };
};

/**
 * Calculate time-based analytics for orders
 */
const calculateTimeBasedAnalytics = (orders: OrderRow[], ticketSales: TicketSaleRow[]) => {
  if (orders.length === 0) return null;

  // Group orders by date
  const ordersByDate = orders.reduce((acc: any, order) => {
    const date = new Date(order.order_date).toISOString().split("T")[0];

    if (!acc[date]) {
      acc[date] = {
        date,
        revenue: 0,
        orders: 0,
        tickets: 0,
      };
    }

    // Add order data
    acc[date].revenue += order.total_amount;
    acc[date].orders += 1;

    // Add ticket quantities for this order
    const orderTickets = (ticketSales || []).filter((sale) => sale.order_id === order.id);
    acc[date].tickets += orderTickets.reduce((sum, sale) => sum + sale.quantity_sold, 0);

    return acc;
  }, {});

  return (Object.values(ordersByDate) as any[])
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .slice(-30); // Last 30 days
};

// /**
//  * @desc Send receipt email to the user
//  */
// async function sendReceiptEmail(userEmail, listOfTickets) {
//   const pdfPath = await generateReceiptPDF(listOfTickets);
//   const pdfData = fs.readFileSync(pdfPath);
//   const pdfBase64 = pdfData.toString("base64");

//   await client.sendEmail({
//     From: "Hilaq Tickets noreply@hilaq.com",
//     To: userEmail,
//     Subject: "Your Order Receipt",
//     TextBody: "Thank you for your order. Please find your receipt attached.",
//     Attachments: [
//       {
//         Name: `receipt-${listOfTickets[0].id}.pdf`,
//         Content: pdfBase64,
//         ContentType: "application/pdf",
//       },
//     ],
//   });

//   // Optional: delete the PDF file after sending
//   fs.unlinkSync(pdfPath);
// }

/**
 * @desc Get all purchased tickets for an event with attendees information
 * @access private
 * @endpoint /api/dashboard/events/:id/attendees
 */
export const getAttendees = async (req: SupabaseRequest, res: Response) => {
  const supabaseClient = req.supabase!;
  const event_id = req.params.id;

  try {
    // 1. Authorization Check
    const { data: event, error: eventError } = await supabaseClient
      .from("events")
      .select("business_id, owner_id")
      .eq("id", event_id)
      .single();

    if (eventError || !event) {
      return res.status(404).json({ success: false, error: "Event not found" });
    }

    // Check-in token: token already scoped to a specific event — verify it matches
    if (req.checkinEventId) {
      if (req.checkinEventId !== event_id) {
        return res.status(403).json({
          success: false,
          error: "Check-in token is not valid for this event",
        });
      }
    } else {
      // Standard user auth: check ownership or team permission
      const user_id = req.user_id!;
      const { PermissionService } = require("../services/permission.service");
      const permissionService = new PermissionService(supabaseClient);

      const isOwner = event.owner_id === user_id;
      let hasPermission = false;

      if (!isOwner && event.business_id) {
        hasPermission = await permissionService.hasPermission(
          user_id,
          event.business_id,
          "event.attendee.read",
        );
      }

      if (!isOwner && !hasPermission) {
        return res.status(403).json({
          success: false,
          error: "Access denied: Missing permission 'event.attendee.read'",
        });
      }
    }

    // 2. Fetch Attendees
    // Get total count first
    const { count, error: countError } = await supabaseClient
      .from("issued_tickets")
      .select("*", { count: "exact", head: true })
      .eq("event_id", event_id);

    if (countError) throw countError;

    // Paginate to fetch all attendees
    const BATCH_SIZE = 1000;
    let allAttendees: any[] = [];
    const totalCount = count || 0;

    for (let offset = 0; offset < totalCount; offset += BATCH_SIZE) {
      const { data: batch, error: batchError } = await supabaseClient
        .from("issued_tickets")
        .select()
        .eq("event_id", event_id)
        .order("created_at", { ascending: false })
        .range(offset, offset + BATCH_SIZE - 1);

      if (batchError) throw batchError;
      if (batch) allAttendees = allAttendees.concat(batch);
    }

    return res.status(200).json({
      success: true,
      data: allAttendees,
      count: totalCount,
    });
  } catch (error: any) {
    console.error("Error fetching attendees:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch attendees",
      details: error?.message,
    });
  }
};

export const checkInAttendee = async (req: SupabaseRequest, res: Response) => {
  const supabaseClient = req.supabase!;
  const eventId = req.params.id;
  const { entry_code } = req.body;

  try {
    // Authorization: check-in token must match the route's event; user auth
    // relies on requirePermission having already been applied at the route level.
    if (req.checkinEventId && req.checkinEventId !== eventId) {
      return res.status(403).json({
        success: false,
        error: "Check-in token is not valid for this event",
      });
    }

    // First, get the current check-in status
    const { data: currentData, error: fetchError } = await supabaseClient
      .from("issued_tickets")
      .select("checked_in, check_in_time")
      .eq("entry_code", entry_code)
      .eq("event_id", eventId)
      .single();

  if (fetchError) throw fetchError;

    if (!currentData) {
      return res.status(404).json({
        success: false,
        error: "Ticket not found",
      });
    }

    // Already checked in — return existing data without modifying the record
    if (currentData.checked_in) {
      return res.status(200).json({
        success: true,
        status: "already_checked_in",
        message: "Ticket has already been checked in",
        data: {
          checked_in: true,
          check_in_time: currentData.check_in_time,
        },
      });
    }

    const checkInTime = new Date().toISOString();
    const { error: updateError } = await supabaseClient
      .from("issued_tickets")
      .update({
        checked_in: true,
        check_in_time: checkInTime,
        last_modified: checkInTime,
      })
      .eq("entry_code", entry_code);

    if (updateError) throw updateError;

    return res.status(200).json({
      success: true,
      message: "Attendee checked in successfully",
      data: {
        checked_in: true,
        check_in_time: checkInTime,
      },
    });
  } catch (error: any) {
    console.error("Error updating attendee check-in status:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to update check-in status",
      details: error?.message,
    });
  }
};

/**
 * @desc Validate a ticket/attendee before check-in
 * @access private
 * @endpoint POST /api/events/:id/attendees/validate
 */
export const validateAttendee = async (req: SupabaseRequest, res: Response) => {
  const supabaseClient = req.supabase!;
  const { id: event_id } = req.params;
  const { code } = req.body;

  // Check-in token must be scoped to the same event being validated
  if (req.checkinEventId && req.checkinEventId !== event_id) {
    return res.status(403).json({
      success: false,
      error: "Check-in token is not valid for this event",
    });
  }

  try {
    const { data: ticket, error } = await supabaseClient
      .from("issued_tickets")
      .select("*, event:events(*)")
      .eq("event_id", event_id)
      .eq("entry_code", code)
      .single();

    if (error || !ticket) {
      return res.status(404).json({
        success: false,
        error: "Invalid ticket",
        message: "This ticket could not be found for this event",
      });
    }

    if (ticket.checked_in) {
      return res.status(200).json({
        status: "already_checked_in",
        success: true,
        ticket,
        message: "This ticket has already been used",
      });
    }

    return res.status(200).json({
      status: "valid",
      success: true,
      ticket,
      message: "Ticket is valid",
    });
  } catch (error: any) {
    console.error("Error validating ticket:", error);
    return res.status(500).json({
      success: false,
      error: "Validation failed",
      details: error?.message,
    });
  }
};
export const updateSalesStatus = async (req: SupabaseRequest, res: Response) => {
  // is_sales_active
  // sales_status_updated_at

  const supabaseClient = req.supabase!;
  const event_id = req.params.id;
  const { is_sales_active } = req.body;

  try {
    const { error } = await supabaseClient
      .from("events")
      .update({
        is_sales_active,
        sales_status_updated_at: new Date().toISOString(),
      })
      .eq("id", event_id);

    if (error) throw error;

    return res.status(200).json({
      success: true,
      message: "Sales status updated successfully",
    });
  } catch (error: any) {
    console.error("Error updating sales status:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to update sales status",
      details: error?.message,
    });
  }
};

/**
 * @desc Create a cash purchase order for an event
 * @access private (event owner only)
 * @endpoint POST /api/dashboard/events/:id/orders/cash
 */
export const createCashPurchase = async (req: SupabaseRequest, res: Response) => {
  const supabaseClient = req.supabase!;
  const event_id = req.params.id;
  const {
    customer_name,
    customer_email,
    customer_phone,
    customer_gender,
    ticket_id,
    quantity,
    check_in_immediately,
  } = req.body;

  // Validate required fields
  if (!customer_name) {
    return res.status(400).json({
      success: false,
      error: "Customer name is required",
    });
  }

  if (!ticket_id) {
    return res.status(400).json({
      success: false,
      error: "Ticket type is required",
    });
  }

  if (!quantity || quantity < 1) {
    return res.status(400).json({
      success: false,
      error: "Quantity must be at least 1",
    });
  }

  try {
    const purchaseService = createPurchaseService(supabaseClient);

    const result = await purchaseService.processCashPurchase({
      event_id,
      customer_name, 
      customer_email,
      customer_phone,
      customer_gender,
      ticket_id,
      quantity: Number(quantity),
      check_in_immediately: Boolean(check_in_immediately),
    });

    return res.status(201).json({
      success: true,
      message: "Cash order created successfully",
      data: result,
    });
  } catch (error: any) {
    console.error("Error creating cash purchase:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to create cash purchase",
      details: error?.message,
    });
  }
};


/**
//  * @desc Process order for an event
//  * @access private
//  * @endpoint /api/dashboard/events/:id/orders
//  */
// exports.processOrder = async (req, res) => {
//   const supabaseClient = supabase; // Use the public client
//   const {
//     full_name,
//     phone_number,
//     gender,
//     email,
//     event_id,
//     selectedTickets,
//     amount,
//     payment_reference,
//     tickets,
//   } = req.body;

//   try {
//     // Save customer details
//     const customerData = await saveCustomer(
//       supabaseClient,
//       full_name,
//       email,
//       phone_number,
//       gender
//     );
//     const orderData = await createOrder(
//       supabaseClient,
//       customerData.id,
//       event_id,
//       amount,
//       payment_reference
//     );

//     // Process ticket sales for an order
//     async function processTicketSales(
//       supabaseClient,
//       order_id,
//       selectedTickets,
//       tickets
//     ) {
//       const ticketSales = Object.keys(selectedTickets).map((index) => ({
//         order_id: order_id,
//         ticket_id: tickets[parseInt(index)].id,
//         quantity_sold: selectedTickets[parseInt(index)],
//         sale_date: new Date().toISOString(),
//       }));

//       const { error, data } = await supabaseClient
//         .from("ticket_sales")
//         .insert(ticketSales)
//         .select("*, ticket:ticket_id(*), order:order_id(*)");

//       if (error) throw error;
//       return data;
//     }

//     // Process ticket sales
//     const ticketSalesResp = await processTicketSales(
//       supabaseClient,
//       orderData.id,
//       selectedTickets,
//       tickets
//     );

//     //  Update ticket sales based on the selected tickets
//     for (const [index, quantity] of Object.entries(selectedTickets)) {
//       const { error } = await supabaseClient
//         .from("event_tickets")
//         .update({
//           available_quantity: tickets[parseInt(index)].ticket_is_limited_stock
//             ? tickets[parseInt(index)].available_quantity - quantity
//             : 0,
//           quantity_sold: tickets[parseInt(index)].quantity_sold + quantity,
//         })
//         .eq("id", tickets[parseInt(index)].id);

//       if (error) throw error;
//     }

//     // Get event details
//     const { data: eventData, error } = await supabaseClient
//       .from("events")
//       .select("*")
//       .eq("id", event_id)
//       .single();

//     if (error) throw error;

//     // Prepare receipt and ticket information
//     const orderDate = new Date();
//     const eventDateString = `${eventData.start_date} from ${eventData.start_time} to ${eventData.end_time}`;
//     const orderTimeString = orderDate.toLocaleTimeString();
//     const orderDateString = orderDate.toDateString();

//     const listOfIssuedTickets = await Promise.all(
//       ticketSalesResp.map(async (purchase) => {
//         const tickets = [];

//         for (let i = 0; i < purchase.quantity_sold; i++) {
//           // Generate a unique ticket entry code for each ticket
//           const generateTicketEntryCode = () => {
//             const prefix = "TKT-";
//             const randomPart = crypto
//               .randomBytes(5)
//               .toString("hex")
//               .toUpperCase(); // Ensures random part is uppercase
//             return `${prefix}${randomPart}`;
//           };
//           const ticketEntryCode = generateTicketEntryCode();

//           console.log("Ticket Entry Code:", ticketEntryCode);

//           // Generate QR code for the ticket
//           const qrCode = await generateQRCode(ticketEntryCode);

//           // Prepare ticket information
//           tickets.push({
//             eventName: eventData.event_name,
//             ticketName: `${purchase.ticket.ticket_name} - ₦${Number(
//               purchase.ticket.ticket_price
//             ).toLocaleString()}`,
//             address: eventData.is_physical
//               ? eventData.venue.placeDesc
//               : "Online Event",
//             eventDate: eventDateString,
//             orderId: orderData.id,
//             id: purchase.order.id,
//             customerName: full_name,
//             orderDate: orderDateString,
//             time: orderTimeString,
//             date: orderDateString,
//             ticketEntryCode: ticketEntryCode,
//             qrCode: qrCode,
//           });
//         }
//         return tickets;
//       })
//     );

//     // Flatten the array of arrays
//     const flattenedListOfIssuedTickets = listOfIssuedTickets.flat();

//     console.log("Receipt and Ticket Information:", listOfIssuedTickets);

//     const newIssuedTickets = flattenedListOfIssuedTickets.map((p) => {
//       return {
//         order_id: p.orderId,
//         customer_name: p.customerName,
//         customer_phone: phone_number,
//         customer_gender: gender,
//         ticket_name: p.ticketName,
//         entry_code: p.ticketEntryCode,
//         qr_code: p.qrCode,
//         event_id: event_id,
//         customer_email: email,
//       };
//     });

//     console.log("New Issued Tickets:", newIssuedTickets);
//     // store the list of purchased tickets in the database
//     const { error: purchasedTicketsError } = await supabaseClient
//       .from("issued_tickets")
//       .insert(newIssuedTickets);

//     if (purchasedTicketsError) throw purchasedTicketsError;

//     // Send receipt email to the user
//     await sendReceiptEmail(email, flattenedListOfIssuedTickets);

//     return res.status(200).json({
//       success: true,
//       data: { orderId: orderData.id },
//     });
//   } catch (error) {
//     console.error("Error processing order:", error);
//     return res.status(500).json({
//       error: "Failed to process order",
//       details: error.message,
//     });
//   }
// };

// /**
//  * @desc Save customer details
//  */
// async function saveCustomer(
//   supabaseClient,
//   full_name,
//   email,
//   phone_number,
//   gender
// ) {
//   const { data, error } = await supabaseClient
//     .from("customers")
//     .upsert(
//       {
//         firstname: full_name?.split(" ")[0],
//         lastname: full_name?.split(" ")[1],
//         email: email,
//         phone_number: phone_number,
//         gender: gender,
//       },
//       { onConflict: "email" }
//     )
//     .select("id")
//     .single();

//   if (error) throw error;
//   return data;
// }

// /**
//  * @desc Create an order for an event
//  * @access private
//  * @endpoint /api/dashboard/events/:id/orders
//  */
// async function createOrder(
//   supabaseClient,
//   customer_id,
//   event_id,
//   amount,
//   payment_reference
// ) {
//   const { data, error } = await supabaseClient
//     .from("orders")
//     .insert({
//       customer_id: customer_id,
//       event_id: event_id,
//       total_amount: amount / 100,
//       payment_reference: payment_reference,
//     })
//     .select("id, payment_reference")
//     .single();

//   if (error) throw error;
//   return data;
// }

/**
 * @desc  Aggregates actionable items the merchant should address today.
 *        Currently surfaces: unfulfilled paid store orders.
 * @access private
 * @endpoint GET /api/dashboard/attention?business_id=
 */
export const getDashboardAttention = async (
  req: SupabaseRequest,
  res: Response,
) => {
  const businessId = req.query.business_id as string | undefined;
  if (!businessId) {
    return ApiResponse.error(res, "business_id is required", 400);
  }

  try {
    const supabase = req.supabase;

    // Find stores owned by this business
    const { data: stores, error: storesError } = await supabase
      .from("stores")
      .select("id, name")
      .eq("business_id", businessId);

    if (storesError) throw storesError;

    const items: {
      id: string;
      title: string;
      category: "storefront";
      href: string;
      urgent: boolean;
      count: number;
    }[] = [];

    if (stores && stores.length > 0) {
      const storeIds = stores.map((s: { id: string }) => s.id);

      // Count paid (unfulfilled) orders across all stores
      const { count, error: ordersError } = await supabase
        .from("store_orders")
        .select("id", { count: "exact", head: true })
        .in("store_id", storeIds)
        .eq("status", "paid");

      if (ordersError) throw ordersError;

      const pendingCount = count ?? 0;
      if (pendingCount > 0) {
        items.push({
          id: "storefront-pending-orders",
          title: `${pendingCount} order${pendingCount === 1 ? "" : "s"} awaiting fulfilment`,
          category: "storefront",
          href: "/dashboard/store/orders?status=paid",
          urgent: pendingCount >= 5,
          count: pendingCount,
        });
      }
    }

    const urgentCount = items.filter((i) => i.urgent).length;

    return ApiResponse.success(res, "Attention items fetched", {
      items,
      total: items.length,
      urgent_count: urgentCount,
    });
  } catch (err: unknown) {
    console.error("[getDashboardAttention]", err);
    return ApiResponse.error(res, "Failed to fetch attention items");
  }
};
