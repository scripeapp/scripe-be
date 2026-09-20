drop table if exists app.supplier_accounts;
drop table if exists app.customer_accounts;
drop table if exists app.party_addresses;
drop table if exists app.party_contacts;
drop table if exists app.parties;
delete from app.role_permissions where "permissionId" in (select "id" from app.permissions where "code" in ('party.read', 'party.manage'));
delete from app.permissions where "code" in ('party.read', 'party.manage');
