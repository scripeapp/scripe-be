-- Migration: 20260218_financials_ledger_view.sql
-- Description: Creates the Master Revenue Ledger View with corrected column mappings

-- =============================================================================
-- 1. Create Master Revenue Ledger View
-- =============================================================================
-- This view aggregates income from all revenue-generating sources
-- Normalizes amounts to Naira (DECIMAL)

CREATE OR REPLACE VIEW business_revenue_ledger_view AS
SELECT 
  id,
  business_id,
  amount,
  currency,
  status,
  source,
  reference_id,
  customer_name,
  customer_email,
  payment_reference,
  created_at
FROM (
  -- Store Orders
  SELECT 
    store_orders.id,
    stores.business_id,
    store_orders.total as amount,
    store_orders.currency,
    store_orders.status,
    'store' as source,
    store_orders.id as reference_id,
    store_orders.customer_name,
    store_orders.customer_email,
    store_orders.payment_reference,
    store_orders.created_at
  FROM store_orders
  JOIN stores ON store_orders.store_id = stores.id

  UNION ALL

  -- Event ticket sales
  SELECT 
    orders.id,
    events.business_id,
    orders.total_amount as amount,
    'NGN' as currency,
    'paid' as status,
    'event' as source,
    orders.id as reference_id,
    COALESCE(NULLIF(TRIM(COALESCE(customers.firstname, '') || ' ' || COALESCE(customers.lastname, '')), ''), 'Customer') as customer_name,
    customers.email as customer_email,
    orders.payment_reference,
    orders.created_at
  FROM orders
  JOIN events ON orders.event_id = events.id
  LEFT JOIN customers ON orders.customer_id = customers.id

  UNION ALL

  -- Publication Subscriptions
  SELECT 
    subscription_payments.id,
    publications.business_id,
    (subscription_payments.amount::DECIMAL / 100.0) as amount, -- Convert kobo to Naira
    subscription_payments.currency,
    subscription_payments.status,
    'subscription' as source,
    subscriptions.id as reference_id,
    users.name as customer_name,
    users.email as customer_email,
    subscription_payments.paystack_reference as payment_reference,
    subscription_payments.created_at
  FROM subscription_payments
  JOIN subscriptions ON subscription_payments.subscription_id = subscriptions.id
  JOIN publications ON subscriptions.publication_id = publications.id
  JOIN users ON subscriptions.user_id = users.id
) combined;

-- Grant access to the view
GRANT SELECT ON business_revenue_ledger_view TO authenticated;
GRANT SELECT ON business_revenue_ledger_view TO service_role;
