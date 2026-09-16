-- Websites table for Website Builder feature
create table if not exists websites (
  id uuid primary key,
  user_id uuid not null,
  domain text unique,
  subdomain text unique,
  is_live boolean not null default false,
  design jsonb not null,
  navigation jsonb not null,
  pages jsonb not null,
  created_at timestamp not null default now(),
  updated_at timestamp not null default now()
);

-- One website per user (optional policy)
create unique index if not exists websites_user_unique on websites (user_id);

-- Optional GIN index for pages querying
create index if not exists websites_pages_gin on websites using gin (pages);

-- Trigger to update updated_at
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists websites_set_updated_at on websites;
create trigger websites_set_updated_at
before update on websites
for each row execute procedure set_updated_at();
