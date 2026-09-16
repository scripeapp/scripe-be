-- Add Super Admin User
-- 20260107_add_super_admin.sql

DO $$
DECLARE
    v_user_id uuid;
    v_email text := 'abodunrindayo01@gmail.com';
BEGIN
    -- 1. Find the user ID from auth.users
    SELECT id INTO v_user_id FROM auth.users WHERE email = v_email LIMIT 1;

    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'User with email % not found in auth.users', v_email;
    END IF;

    -- 2. Insert into admin_users (or update if exists)
    INSERT INTO admin_users (user_id, role, name, email, is_active)
    VALUES (
        v_user_id, 
        'super_admin', 
        'Dayo Abodunrin', -- Fallback name, can be updated later
        v_email, 
        TRUE
    )
    ON CONFLICT (email) DO UPDATE
    SET 
        role = 'super_admin',
        is_active = TRUE,
        updated_at = NOW();

    RAISE NOTICE 'Successfully granted Super Admin access for %', v_email;
END $$;
