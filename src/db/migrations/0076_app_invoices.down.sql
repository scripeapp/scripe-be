-- 0076_app_invoices.down.sql

drop function if exists app.get_public_invoice(text);

drop table if exists app.invoice_lines;
drop table if exists app.invoices;

-- Revert fiscal documents constraints and policies
drop policy if exists fiscal_documents_insert on app.fiscal_documents;
create policy fiscal_documents_insert on app.fiscal_documents for insert
  with check (app.has_business_permission("businessId", 'payment.manage'));

drop policy if exists fiscal_documents_read on app.fiscal_documents;
create policy fiscal_documents_read on app.fiscal_documents for select
  using (app.has_business_permission("businessId", 'receipt.read'));

drop index if exists app.fiscal_documents_invoice_per_order_unique;
alter table app.fiscal_documents drop constraint fiscal_documents_business_kind_sequence_unique;
alter table app.fiscal_documents add constraint fiscal_documents_businessId_sequence_key unique ("businessId", "sequence");

-- Revert permissions
delete from app.permissions where "code" in ('invoice.read', 'invoice.manage');

-- Revert order lines
alter table app.order_lines alter column "productVariantId" set not null;
