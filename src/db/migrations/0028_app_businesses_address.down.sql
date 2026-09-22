alter table app.businesses
  drop column if exists "addressLine1",
  drop column if exists "addressLine2",
  drop column if exists "city",
  drop column if exists "state",
  drop column if exists "postalCode",
  drop column if exists "country";
