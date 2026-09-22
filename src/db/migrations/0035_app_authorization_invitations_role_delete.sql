-- business_invitations.roleId referenced app.roles ON DELETE RESTRICT, so
-- once a custom role had ever been used on an invitation it could never be
-- deleted again — even after every member holding it was removed and every
-- pending invitation for it was gone, a single already-accepted or revoked
-- (terminal, historical) invitation row would still block
-- app.roles deletion with a raw FK-violation error. Those terminal rows are
-- just a record of what happened, not a live dependency, so deleting the
-- role should clear their roleId rather than being blocked by them.
-- roleInUse (authorization.repository.ts) now separately blocks deleting a
-- role that still has a pending invitation, so a pending row never actually
-- hits this ON DELETE SET NULL in practice.
alter table app.business_invitations alter column "roleId" drop not null;
alter table app.business_invitations drop constraint "business_invitations_roleId_fkey";
alter table app.business_invitations add constraint "business_invitations_roleId_fkey"
  foreign key ("roleId") references app.roles ("id") on delete set null;
