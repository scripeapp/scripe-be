-- ============================================================================
-- Migration: Backfill Orphaned User Content to Primary Business
-- This script attaches all user-created content (where business_id IS NULL) 
-- to the user's primary business (the one they own).
-- ============================================================================

DO $$
DECLARE
    tables_updated INT := 0;
    rows_updated INT := 0;
BEGIN
    RAISE NOTICE 'Starting content backfill migration...';

    -- Backfill Publications
    UPDATE publications p
    SET business_id = b.id
    FROM businesses b
    WHERE p.user_id = b.owner_user_id 
      AND p.business_id IS NULL;
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    RAISE NOTICE 'Updated % publications', rows_updated;

    -- Backfill Events (uses owner_id)
    UPDATE events e
    SET business_id = b.id
    FROM businesses b
    WHERE e.owner_id = b.owner_user_id 
      AND e.business_id IS NULL;
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    RAISE NOTICE 'Updated % events', rows_updated;

    -- Backfill Halqahs
    UPDATE halqahs h
    SET business_id = b.id
    FROM businesses b
    WHERE h.user_id = b.owner_user_id 
      AND h.business_id IS NULL;
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    RAISE NOTICE 'Updated % halqahs', rows_updated;

    -- Backfill Sessions (uses creator_id)
    UPDATE sessions s
    SET business_id = b.id
    FROM businesses b
    WHERE s.creator_id = b.owner_user_id 
      AND s.business_id IS NULL;
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    RAISE NOTICE 'Updated % sessions', rows_updated;

    -- Backfill Websites
    UPDATE websites w
    SET business_id = b.id
    FROM businesses b
    WHERE w.user_id = b.owner_user_id 
      AND w.business_id IS NULL;
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    RAISE NOTICE 'Updated % websites', rows_updated;

    -- Backfill Contacts
    UPDATE contacts c
    SET business_id = b.id
    FROM businesses b
    WHERE c.user_id = b.owner_user_id 
      AND c.business_id IS NULL;
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    RAISE NOTICE 'Updated % contacts', rows_updated;

    -- Backfill Segments
    UPDATE segments s
    SET business_id = b.id
    FROM businesses b
    WHERE s.user_id = b.owner_user_id 
      AND s.business_id IS NULL;
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    RAISE NOTICE 'Updated % segments', rows_updated;

    -- Backfill Campaigns
    UPDATE campaigns c
    SET business_id = b.id
    FROM businesses b
    WHERE c.user_id = b.owner_user_id 
      AND c.business_id IS NULL;
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    RAISE NOTICE 'Updated % campaigns', rows_updated;

    -- Backfill Availability Profiles (uses owner_id)
    UPDATE availability_profiles a
    SET business_id = b.id
    FROM businesses b
    WHERE a.owner_id = b.owner_user_id 
      AND a.business_id IS NULL;
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    RAISE NOTICE 'Updated % availability_profiles', rows_updated;

    RAISE NOTICE 'Content backfill migration completed!';
END $$;
