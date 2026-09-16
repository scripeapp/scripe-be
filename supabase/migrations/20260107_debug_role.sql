-- Debug Function: Inspect User Role
-- 20260107_debug_role.sql

CREATE OR REPLACE FUNCTION public.debug_inspect_user_role(p_user_id UUID, p_business_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_role_name TEXT;
  v_role_id UUID;
  v_is_system BOOLEAN;
BEGIN
    SELECT r.name, r.id, r.is_system
    INTO v_role_name, v_role_id, v_is_system
    FROM memberships m
    JOIN roles r ON m.role_id = r.id
    WHERE m.user_id = p_user_id AND m.business_id = p_business_id
    LIMIT 1;

    RETURN jsonb_build_object(
        'user_id', p_user_id,
        'business_id', p_business_id,
        'role_name', v_role_name,
        'role_id', v_role_id,
        'is_system_role', v_is_system
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
