alter table app.business_invitations drop constraint "business_invitations_roleId_fkey";
alter table app.business_invitations add constraint "business_invitations_roleId_fkey"
  foreign key ("roleId") references app.roles ("id") on delete restrict;
alter table app.business_invitations alter column "roleId" set not null;
