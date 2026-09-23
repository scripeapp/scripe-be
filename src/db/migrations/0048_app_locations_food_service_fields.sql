-- Food-store branch fields the frontend's location editor needs (fulfilment
-- types, live accepting-orders toggle, tax rate, per-fulfilment-type service
-- charges, manager, and a free-text "format" tag) that app.locations didn't
-- carry — it only had the address/hours/prep-time fields common to every
-- location kind.

alter table app.locations
  add column "operationTypes" text[] not null default '{}'
    check ("operationTypes" <@ array['dine_in','pickup','delivery','curbside']),
  add column "acceptingOrders" boolean not null default true,
  add column "taxRate" numeric(5,2) not null default 0 check ("taxRate" >= 0 and "taxRate" <= 100),
  add column "serviceChargeRates" jsonb not null default '{}'::jsonb check (jsonb_typeof("serviceChargeRates") = 'object'),
  add column "manager" text,
  add column "format" text;
