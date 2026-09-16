-- =============================================================================
-- Indexes for the unified store catalog (products + events + courses list)
--
-- The dashboard store tab now lists products, events, and courses from one
-- endpoint (GET /store/catalog). These indexes cover the exact filter + sort
-- used by that query. Previously:
--   - products had NO index on store_id (was commented out at creation)
--   - events had no index on business_id
--   - event_tickets had no index on event_id (min-price lookup)
-- circle_courses already has (business_id, created_at) from standalone-courses.
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_products_store_id ON public.products(store_id);
CREATE INDEX IF NOT EXISTS idx_products_status ON public.products(status);

CREATE INDEX IF NOT EXISTS idx_events_business_id ON public.events(business_id);
CREATE INDEX IF NOT EXISTS idx_events_status ON public.events(status);

CREATE INDEX IF NOT EXISTS idx_event_tickets_event_id ON public.event_tickets(event_id);