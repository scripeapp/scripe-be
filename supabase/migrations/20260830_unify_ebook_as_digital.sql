-- Collapse the legacy ebook product type into the canonical digital type.
-- The ebook column is retained temporarily for rollback safety, but all
-- application reads and writes use products.digital after this migration.

UPDATE products
SET
  type = 'digital',
  subtype = NULL,
  digital = COALESCE(digital, '{}'::jsonb) || jsonb_strip_nulls(
    jsonb_build_object(
      'download_url', COALESCE(
        ebook #>> '{files,pdf_url}',
        ebook #>> '{files,epub_url}',
        ebook #>> '{files,mobi_url}'
      ),
      'download_limit', ebook -> 'download_limit',
      'file_type', CASE
        WHEN ebook ->> 'format' IN ('pdf', 'epub', 'mobi')
          THEN ebook ->> 'format'
        ELSE NULL
      END,
      'asset', COALESCE(
        ebook #> '{files,pdf_asset}',
        ebook #> '{files,epub_asset}',
        ebook #> '{files,mobi_asset}'
      ),
      'primary_format', CASE
        WHEN ebook ->> 'format' IN ('pdf', 'epub', 'mobi')
          THEN ebook ->> 'format'
        ELSE 'other'
      END,
      'has_sample', COALESCE((ebook ->> 'has_sample')::boolean, false),
      'sample_url', ebook ->> 'sample_url',
      'page_count', ebook -> 'page_count',
      'files', ebook -> 'files'
    )
  ),
  ebook = NULL,
  updated_at = NOW()
WHERE type = 'ebook';

-- Order items are immutable snapshots, but fulfilment decisions read their
-- product_type. Normalize those snapshots so no runtime ebook branch remains.
UPDATE store_orders AS orders
SET items = (
  SELECT jsonb_agg(
    CASE
      WHEN item.value ->> 'product_type' = 'ebook'
        THEN jsonb_set(item.value, '{product_type}', '"digital"'::jsonb)
      ELSE item.value
    END
    ORDER BY item.ordinality
  ) AS items
  FROM jsonb_array_elements(COALESCE(orders.items, '[]'::jsonb))
    WITH ORDINALITY AS item(value, ordinality)
)
WHERE jsonb_typeof(orders.items) = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(orders.items) AS item(value)
    WHERE item.value ->> 'product_type' = 'ebook'
  );

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_type_check;
ALTER TABLE products
  ADD CONSTRAINT products_type_check
  CHECK (type IN (
    'digital',
    'physical',
    'service',
    'course',
    'membership',
    'bundle',
    'donation'
  ));

COMMENT ON COLUMN products.ebook IS
  'Deprecated legacy field. Ebook data was migrated to products.digital on 2026-08-30.';
