-- 0008 gave app.business_memberships a single SELECT policy,
-- memberships_self_select, restricted to the caller's own row. 0019 later
-- added the team member list endpoint (listMembers, gated in the service
-- layer by the 'team.read' permission) without a matching RLS policy, so a
-- business owner querying /team/members can only ever see their own
-- membership row — every other member's row is invisible regardless of
-- permission. This mirrors the existing team.read-gated
-- business_invitations_read policy from 0019.
create policy memberships_team_read_select on app.business_memberships for select
  using (app.has_business_permission("businessId", 'team.read'));
