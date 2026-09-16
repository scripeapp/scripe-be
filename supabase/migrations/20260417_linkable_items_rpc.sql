-- =============================================================================
-- Linkable-items performance: composite indexes + single-query RPC
--
-- Problem: the /store/linkable-items endpoint fired 4 separate PostgREST
-- queries in parallel (circles, publications, hilaq_forms, event_types).
-- Even with Promise.all each call carried its own auth/HTTP overhead (~50-100ms).
--
-- Solution:
--   1. Composite indexes on the filtered columns so each table scan is O(log n)
--   2. A single get_linkable_items() RPC that joins all 4 tables in one DB call,
--      reducing network round-trips from 4 → 1.
-- =============================================================================

-- ── Composite indexes ─────────────────────────────────────────────────────────

-- hilaq_forms: the query filters (business_id, deleted_at IS NULL, is_published)
-- A composite index lets Postgres satisfy all three in a single index scan.
CREATE INDEX IF NOT EXISTS idx_hilaq_forms_linkable
  ON hilaq_forms (business_id, is_published)
  WHERE deleted_at IS NULL;

-- event_types: filters (business_id, is_active = true)
CREATE INDEX IF NOT EXISTS idx_event_types_linkable
  ON event_types (business_id)
  WHERE is_active = true;

-- circles: filters on business_id (already indexed), order by created_at
-- Adding created_at to the index avoids a separate sort step.
CREATE INDEX IF NOT EXISTS idx_circles_business_created
  ON circles (business_id, created_at DESC);

-- publications: same pattern
CREATE INDEX IF NOT EXISTS idx_publications_business_created
  ON publications (business_id, created_at DESC);


-- ── RPC function ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_linkable_items(p_business_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE          -- no writes; allows the planner to cache results within a query
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_circles      JSONB;
  v_publications JSONB;
  v_forms        JSONB;
  v_event_types  JSONB;
BEGIN

  -- ── Circles ────────────────────────────────────────────────────────────────
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',          id,
        'name',        title,
        'description', description,
        'slug',        slug,
        'price',       COALESCE(price, 0),
        'currency',    COALESCE(currency, 'NGN'),
        'image_url',   cover_image_url,
        'type_label',  'Circle',
        'extras',      jsonb_build_object('access_type', access_type)
      )
      ORDER BY created_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_circles
  FROM circles
  WHERE business_id = p_business_id;

  -- ── Publications ───────────────────────────────────────────────────────────
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',          id,
        'name',        name,
        'description', description,
        'slug',        slug,
        -- monthly_price stored in kobo; divide by 100 → naira
        'price',       COALESCE((monetization->>'monthly_price')::numeric / 100, 0),
        'currency',    COALESCE(monetization->>'currency', 'NGN'),
        'image_url',   profile_image,
        'type_label',  'Publication',
        'extras',      jsonb_build_object(
                         'monthly_price', COALESCE((monetization->>'monthly_price')::numeric, 0),
                         'yearly_price',  COALESCE((monetization->>'yearly_price')::numeric, 0)
                       )
      )
      ORDER BY created_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_publications
  FROM publications
  WHERE business_id = p_business_id;

  -- ── Forms ──────────────────────────────────────────────────────────────────
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',          id,
        'name',        title,
        'description', description,
        'slug',        slug,
        'price',       CASE WHEN access_type = 'paid'
                            THEN COALESCE(payment_amount, 0)
                            ELSE 0
                       END,
        'currency',    COALESCE(payment_currency, 'NGN'),
        'image_url',   NULL,
        'type_label',  'Form',
        'extras',      jsonb_build_object('access_type', access_type)
      )
      ORDER BY created_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_forms
  FROM hilaq_forms
  WHERE business_id = p_business_id
    AND deleted_at IS NULL
    AND is_published = true;

  -- ── Event types (consultations) ────────────────────────────────────────────
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',          id,
        'name',        title,
        'description', description,
        'slug',        slug,
        'price',       CASE WHEN requires_payment
                            THEN COALESCE(payment_amount, 0)
                            ELSE 0
                       END,
        'currency',    'NGN',
        'image_url',   NULL,
        'type_label',  'Consultation',
        'extras',      jsonb_build_object(
                         'duration_minutes', duration_minutes,
                         'requires_payment', requires_payment,
                         'color',            color
                       )
      )
      ORDER BY created_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_event_types
  FROM event_types
  WHERE business_id = p_business_id
    AND is_active = true;

  RETURN jsonb_build_object(
    'circle',      v_circles,
    'publication', v_publications,
    'form',        v_forms,
    'event_type',  v_event_types
  );
END;
$$;

-- Grant execute to the authenticated role used by Supabase
GRANT EXECUTE ON FUNCTION get_linkable_items(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION get_linkable_items(UUID) TO service_role;
