-- Website-Store Linking Table (Optional)
-- Allows explicit linking between websites and stores for enhanced features

CREATE TABLE IF NOT EXISTS website_linked_stores (
  website_id UUID REFERENCES websites(id) ON DELETE CASCADE,
  store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
  display_settings JSONB DEFAULT '{
    "showProducts": true,
    "showCategories": true,
    "productLimit": 12,
    "layout": "grid"
  }',
  is_primary BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (website_id, store_id)
);

-- Index for efficient querying by store
CREATE INDEX IF NOT EXISTS idx_website_linked_stores_store ON website_linked_stores(store_id);

-- Index for finding primary store for a website
CREATE INDEX IF NOT EXISTS idx_website_linked_stores_primary ON website_linked_stores(website_id) WHERE is_primary = true;

-- Similar linking table for events
CREATE TABLE IF NOT EXISTS website_linked_events (
  website_id UUID REFERENCES websites(id) ON DELETE CASCADE,
  event_id UUID REFERENCES events(id) ON DELETE CASCADE,
  display_settings JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (website_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_website_linked_events_event ON website_linked_events(event_id);

-- Similar linking table for halqahs
CREATE TABLE IF NOT EXISTS website_linked_halqahs (
  website_id UUID REFERENCES websites(id) ON DELETE CASCADE,
  halqah_id UUID REFERENCES halqahs(id) ON DELETE CASCADE,
  display_settings JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (website_id, halqah_id)
);

CREATE INDEX IF NOT EXISTS idx_website_linked_halqahs_halqah ON website_linked_halqahs(halqah_id);

-- Similar linking table for publications
CREATE TABLE IF NOT EXISTS website_linked_publications (
  website_id UUID REFERENCES websites(id) ON DELETE CASCADE,
  publication_id UUID REFERENCES publications(id) ON DELETE CASCADE,
  display_settings JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (website_id, publication_id)
);

CREATE INDEX IF NOT EXISTS idx_website_linked_publications_pub ON website_linked_publications(publication_id);
