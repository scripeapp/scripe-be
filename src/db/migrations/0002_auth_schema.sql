-- 0002_auth_schema.sql
-- Better Auth tables, schemaName "auth", UUID ids, camelCase column names.
-- Better Auth's kysely adapter emits camelCase identifiers verbatim, so every
-- column is double-quoted here to preserve exact case (unquoted identifiers
-- would be folded to lowercase by PostgreSQL).
-- Runs as scripe_migrator.

create table auth.user (
    "id"            uuid primary key,
    "name"          text not null,
    "email"         text not null unique,
    "emailVerified" boolean     not null default false,
    "image"         text,
    "createdAt"     timestamptz not null default now(),
    "updatedAt"     timestamptz not null default now()
);

create table auth.session (
    "id"        uuid primary key,
    "token"     text        not null unique,
    "userId"    uuid        not null references auth.user ("id") on delete cascade,
    "expiresAt" timestamptz not null,
    "ipAddress" text,
    "userAgent" text,
    "createdAt" timestamptz not null default now(),
    "updatedAt" timestamptz not null default now()
);

create index if not exists session_user_id_idx on auth.session ("userId");

create table auth.account (
    "id"                     uuid primary key,
    "accountId"              text not null,
    "providerId"             text not null,
    "userId"                 uuid not null references auth.user ("id") on delete cascade,
    "accessToken"            text,
    "refreshToken"           text,
    "idToken"                text,
    "accessTokenExpiresAt"   timestamptz,
    "refreshTokenExpiresAt"  timestamptz,
    "scope"                  text,
    "password"               text,
    "createdAt"              timestamptz not null default now(),
    "updatedAt"              timestamptz not null default now()
);

create index if not exists account_user_id_idx on auth.account ("userId");
create unique index if not exists account_provider_account_idx on auth.account ("providerId", "accountId");

create table auth.verification (
    "id"         uuid primary key,
    "identifier" text        not null,
    "value"      text        not null,
    "expiresAt"  timestamptz not null,
    "createdAt"  timestamptz not null default now(),
    "updatedAt"  timestamptz not null default now()
);

create index if not exists verification_identifier_idx on auth.verification ("identifier");

create table auth.passkey (
    "id"           uuid primary key,
    "name"         text,
    "publicKey"    text         not null,
    "userId"       uuid         not null references auth.user ("id") on delete cascade,
    "credentialID" text         not null,
    "counter"      integer      not null,
    "deviceType"   text         not null,
    "backedUp"     boolean      not null,
    "transports"   text,
    "aaguid"       text,
    "createdAt"    timestamptz  not null default now(),
    "updatedAt"    timestamptz  not null default now()
);

create index if not exists passkey_user_id_idx on auth.passkey ("userId");
create unique index if not exists passkey_credential_id_idx on auth.passkey ("credentialID");

grant select, insert, update, delete on all tables in schema auth to scripe_app;
grant usage, select on all sequences in schema auth to scripe_app;
