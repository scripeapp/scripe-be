-- Seed initial super admin
-- User: abodunrindayo01@gmail.com
-- ID: d307f6b4-1730-40e3-b945-19b37623b0e2

INSERT INTO public.admin_users (
    user_id,
    role,
    name,
    email,
    is_active,
    permissions
)
VALUES (
    'd307f6b4-1730-40e3-b945-19b37623b0e2',
    'super_admin',
    'Admin User',
    'abodunrindayo01@gmail.com',
    true,
    '["*"]'::jsonb
)
ON CONFLICT (email) DO UPDATE SET
    role = 'super_admin',
    is_active = true,
    permissions = '["*"]'::jsonb;
