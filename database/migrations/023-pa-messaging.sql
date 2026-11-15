-- =====================================================================
-- PlotFarms PA — 023: Messaging layer (consumer PA)
-- Adds schema `pa`: PA user registration, the app registry, consumer
-- conversation sessions, the platform-level order book, and the
-- no-service request log.
--
-- Design basis (owner, 2026-11-14): all domain apps run INDEPENDENTLY
-- and register with PA. PA never touches an app's database; it may only
-- request basic information through the app's registered interface —
-- check_availability, place_order, order_status (see
-- docs/design/PA-Messaging-Layer.md).
--
-- Secrets: NO app secrets are stored in this table. Each registry row
-- names an environment variable (secret_env); the value lives only in
-- pa-web's server-side .env.
-- Re-runnable: safe to run more than once.
-- =====================================================================

create schema if not exists pa;

-- ---------------------------------------------------------------------
-- PA users — people registered with the Personal Assistant.
-- Registration holds name + address, so location (pincode) is derived
-- from it and never re-asked. One row per person; channel refs link
-- the channels they talk to PA on.
-- ---------------------------------------------------------------------
create table if not exists pa.users (
  id               bigint generated always as identity primary key,
  name             text        not null,
  phone            text,
  address          text        not null,
  pincode          text        not null,
  telegram_chat_id bigint      unique,
  whatsapp_ref     text        unique,
  active           boolean     not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- App registry — one row per registered app INSTANCE (one VegiBot
-- deployment = one store = one row). PA routes only to status='active'
-- rows whose categories match the request and whose service_pincodes
-- are empty (serves everywhere) or contain the user's pincode.
-- mode: mediated = quote -> confirm -> order (ordering apps)
--       query    = basic info answer, then optional request (lawyer)
--       booking  = slot availability, then book (scheduler)
-- ---------------------------------------------------------------------
create table if not exists pa.app_registry (
  app_id           text primary key,
  app_name         text        not null,
  app_type         text        not null,           -- ordering | appointment | legal
  categories       text[]      not null default '{}',
  service_pincodes text[]      not null default '{}',
  endpoint_url     text        not null default '', -- filled on the server at activation
  secret_env       text        not null default '', -- env var NAME holding the shared secret
  capabilities     text[]      not null default '{check_availability,place_order,order_status}',
  mode             text        not null default 'mediated',
  status           text        not null default 'pending', -- pending | active | inactive
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- The four POC apps, registered in principle. Endpoints stay empty and
-- status stays 'pending' until each app's adapter is deployed and the
-- activation test call succeeds (POST /api/pa/apps/:id/test).
insert into pa.app_registry (app_id, app_name, app_type, categories, secret_env, mode)
values
  ('textiles-padmavathi', 'Padmavathi Textiles', 'ordering',
   '{cloth,textiles}', 'PA_APP_SECRET_TEXTILES', 'mediated'),
  ('vegibot', 'VegiBot', 'ordering',
   '{vegetables}', 'PA_APP_SECRET_VEGIBOT', 'mediated'),
  ('scheduler', 'Scheduler', 'appointment',
   '{appointment}', 'PA_APP_SECRET_SCHEDULER', 'booking'),
  ('helplawyer', 'HelpLawyer', 'legal',
   '{legal,lawyer}', 'PA_APP_SECRET_HELPLAWYER', 'query')
on conflict (app_id) do nothing;

-- ---------------------------------------------------------------------
-- Consumer conversation sessions — Postgres, never in-memory only
-- (the textiles stale-stage lesson). One row per (channel, chat).
-- stage: registering | idle | awaiting_confirm | awaiting_slot
-- context: registration progress / pending quote / pending slots.
-- ---------------------------------------------------------------------
create table if not exists pa.sessions (
  session_key text primary key,                    -- '<channel>:<chat_ref>'
  channel     text        not null,
  chat_ref    text        not null,
  user_id     bigint      references pa.users(id),
  stage       text        not null default 'registering',
  context     jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- PA order book — platform-level copy ONLY: what PA asked, on whose
-- behalf, what the app answered. Stock and money live in the app;
-- the vendor sends the invoice + payment instructions to the user.
-- pa_request_id is the idempotency key sent to the app.
-- ---------------------------------------------------------------------
create table if not exists pa.orders (
  pa_request_id text primary key,
  user_id       bigint      not null references pa.users(id),
  app_id        text        not null references pa.app_registry(app_id),
  items         jsonb       not null default '[]'::jsonb,
  total         numeric,
  app_order_id  text,
  status        text        not null default 'placed',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Requests PA could not serve (UC-11) — reviewed so missing services
-- get registered instead of silently failing.
create table if not exists pa.request_log (
  id         bigint generated always as identity primary key,
  channel    text,
  chat_ref   text,
  user_id    bigint references pa.users(id),
  text       text,
  reason     text        not null,                 -- no_service_found | not_understood
  created_at timestamptz not null default now()
);

-- survey_app (pa-web's DB role) access — schema pa only, nothing else.
grant usage on schema pa to survey_app;
grant select, insert, update, delete on all tables in schema pa to survey_app;
grant usage, select on all sequences in schema pa to survey_app;

-- VERIFY
select 'pa.users' as tbl, count(*) from pa.users union all
select 'pa.app_registry', count(*) from pa.app_registry union all
select 'pa.sessions', count(*) from pa.sessions union all
select 'pa.orders', count(*) from pa.orders union all
select 'pa.request_log', count(*) from pa.request_log;
select has_schema_privilege('survey_app', 'pa', 'USAGE') as pa_schema_usage,
       has_table_privilege('survey_app', 'pa.app_registry', 'SELECT') as registry_select,
       has_table_privilege('survey_app', 'pa.orders', 'INSERT') as orders_insert;
