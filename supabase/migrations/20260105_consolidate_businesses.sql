-- Consolidate multiple businesses for the same user into one.
-- This fixes the issue where users with multiple stores received 
-- multiple businesses during the initial migration.

DO $$
DECLARE
    r RECORD;
    primary_business_id UUID;
BEGIN
    -- 1. Identify users with more than one business
    FOR r IN (
        SELECT owner_user_id
        FROM businesses
        GROUP BY owner_user_id
        HAVING COUNT(*) > 1
    ) LOOP
        -- 2. Pick the primary business to keep.
        -- Priority: 
        -- a) The one named 'My Awesome Business' (user's favorite)
        -- b) The oldest one (first created)
        SELECT id INTO primary_business_id
        FROM businesses
        WHERE owner_user_id = r.owner_user_id
        ORDER BY 
            (name = 'My Awesome Business') DESC,
            created_at ASC
        LIMIT 1;

        -- 3. Re-link stores from other businesses to the primary one
        UPDATE stores
        SET business_id = primary_business_id
        WHERE business_id IN (
            SELECT id FROM businesses 
            WHERE owner_user_id = r.owner_user_id 
            AND id != primary_business_id
        );

        -- 4. Re-link publications from other businesses to the primary one
        -- (Uses EXECUTE because publications table is optional/dynamic in some environments)
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'publications') THEN
            EXECUTE format('
                UPDATE publications
                SET business_id = %L
                WHERE business_id IN (
                    SELECT id FROM businesses 
                    WHERE owner_user_id = %L 
                    AND id != %L
                )', primary_business_id, r.owner_user_id, primary_business_id);
        END IF;

        -- 5. Re-link audit logs and invitations
        UPDATE audit_logs
        SET business_id = primary_business_id
        WHERE business_id IN (
            SELECT id FROM businesses 
            WHERE owner_user_id = r.owner_user_id 
            AND id != primary_business_id
        );

        UPDATE invitations
        SET business_id = primary_business_id
        WHERE business_id IN (
            SELECT id FROM businesses 
            WHERE owner_user_id = r.owner_user_id 
            AND id != primary_business_id
        );

        -- 6. Delete memberships in the redundant businesses
        DELETE FROM memberships
        WHERE business_id IN (
            SELECT id FROM businesses 
            WHERE owner_user_id = r.owner_user_id 
            AND id != primary_business_id
        );

        -- 7. Delete redundant businesses
        DELETE FROM businesses
        WHERE owner_user_id = r.owner_user_id
        AND id != primary_business_id;

    END LOOP;
END $$;
