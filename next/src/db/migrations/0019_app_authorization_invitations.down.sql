drop function if exists app.accept_business_invitation(text);

drop policy if exists role_permissions_manage on app.role_permissions;
revoke insert, delete on app.role_permissions from surge_app;

drop policy if exists roles_manage on app.roles;
revoke insert, update, delete on app.roles from surge_app;

drop policy if exists membership_roles_manage on app.membership_roles;
revoke insert, delete on app.membership_roles from surge_app;

drop policy if exists business_memberships_manage on app.business_memberships;
revoke update on app.business_memberships from surge_app;

drop table if exists app.business_invitations;
