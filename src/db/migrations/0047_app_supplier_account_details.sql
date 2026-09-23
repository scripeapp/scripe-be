-- Vendor detail fields the frontend's supplier UI needs (bank payout details,
-- a free-text contact/category/notes) that the original supplier_accounts
-- table didn't carry.

alter table app.supplier_accounts
  add column "contactPerson" text,
  add column "category" text,
  add column "website" text,
  add column "bankName" text,
  add column "bankCode" text,
  add column "accountNumber" text,
  add column "accountName" text,
  add column "notes" text not null default '';
