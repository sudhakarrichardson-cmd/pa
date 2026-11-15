-- =====================================================================
-- PlotFarms PA — 021: Personal Assistant (survey) schema + app registration
-- AI-DLC Gate 4 build, 2026-11-14. Plan: docs/design/PA-Business-Feedback-Form-Plan.md
-- Target: the existing self-hosted Postgres (db.plotfarms.com stack).
-- Pattern: one DB, multiple schemas — one schema per app
-- (public = HelpLawyer/RNB, textiles = Padmavathi, survey = Business Feedback).
-- Run as postgres (Studio SQL editor or docker exec) AFTER 020.
-- Safe to re-run. The pa-web service is the only writer to schema survey.
-- =====================================================================

create schema if not exists survey;

-- ---------------------------------------------------------------- visits
-- One row per business visit. Typed columns = everything the dashboard
-- counts/filters and the Results-Tracker export needs. Full answers live
-- in part_a / part_b / part_c JSONB, exactly as filled in the form.
create table if not exists survey.visits (
  id              bigint generated always as identity primary key,
  -- who / when (submitted_by comes from the login, never from the client)
  submitted_by    text not null,               -- platform user email
  visit_date      date not null default current_date,
  status          text not null default 'draft'
                  check (status in ('draft','submitted','completed')),
  -- business identity (Part A1 + tracker columns)
  business_name   text,
  business_type   text check (business_type in
                  ('cloth','vegetable','restaurant','grocery','lawyer','doctor')),
  town            text,
  owner_name      text,
  owner_whatsapp  text,
  -- headline numbers (Part A3)
  orders_per_day  text,                        -- range text, as collected
  missed_enquiries_per_week integer,
  -- goal field collected in Part A9, counted by the office
  fee_comfort     text check (fee_comfort in
                  ('lt_500','500_1000','1000_2500','2500_5000','see_it_work')),
  -- wrap-up / tracker fields (Part C; null until wrap-up is filled)
  top_pain        text,                        -- owner's words, one line (C7)
  template_fit    text check (template_fit in
                  ('ordering','scheduler','case_manager','custom')),
  fit_score       text check (fit_score in
                  ('ready','small_changes','major_custom','not_a_fit')),
  interest_level  text check (interest_level in ('hot','warm','cold','no')),
  pilot_status    text check (pilot_status in
                  ('yes','demo_first','after_office_call','no')),
  pilot_date      date,
  next_step       text,
  next_step_date  date,
  -- full answers
  part_a          jsonb not null default '{}'::jsonb,  -- A1..A10
  part_b          jsonb not null default '{}'::jsonb,  -- matching B module only
  part_c          jsonb not null default '{}'::jsonb,  -- internal wrap-up
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  submitted_at    timestamptz
);

create index if not exists visits_type_idx      on survey.visits (business_type);
create index if not exists visits_status_idx    on survey.visits (status);
create index if not exists visits_by_idx        on survey.visits (submitted_by);
create index if not exists visits_date_idx      on survey.visits (visit_date);

-- ------------------------------------------------------------ attachments
-- A10 sample photos, stored on the pa-web uploads volume; only metadata
-- in the DB, files are served only through authenticated pa-web routes.
create table if not exists survey.attachments (
  id          bigint generated always as identity primary key,
  visit_id    bigint not null references survey.visits(id) on delete cascade,
  kind        text not null check (kind in
              ('bill_sample','price_list','shop_front','visiting_card',
               'catalogue','software_screen','other')),
  file_path   text not null,                   -- generated file name inside the uploads volume
  uploaded_by text not null,
  created_at  timestamptz not null default now()
);

create index if not exists attachments_visit_idx on survey.attachments (visit_id);

-- ------------------------------------------------------ roles of this app
-- Every app defines its OWN roles (same table shape as
-- textiles.role_capabilities). The role_code is what the app admin picks
-- for an employee and what is stored in platform.user_app_access; the
-- capability rows decide what that role may do inside pa-web:
--   fill_visits      create and edit own visits
--   view_all_visits  see every employee's visits
--   view_dashboard   office dashboard + CSV export
--   manage_users     Staff & HR page: employee profiles, logins, turn access off
--   offer_letters    create and download offer letters
--   *                everything (the app admin: all surveys + all HR work)
-- 'hr' does the HR work only — it cannot see survey visits.
-- 'owner' is this app's admin role (platform.apps.admin_role_code below);
-- the platform admin can create only that one — the app admin creates
-- everyone else.
create table if not exists survey.role_capabilities (
  role_code  text not null,
  capability text not null,
  allowed    boolean not null default true,
  primary key (role_code, capability)
);
insert into survey.role_capabilities (role_code, capability) values
  ('intern','fill_visits'),
  ('trainee','fill_visits'),
  ('engineer','fill_visits'),
  ('sr_engineer','fill_visits'),
  ('manager','fill_visits'), ('manager','view_all_visits'), ('manager','view_dashboard'),
  ('branch_manager','fill_visits'), ('branch_manager','view_all_visits'), ('branch_manager','view_dashboard'),
  ('hr','manage_users'), ('hr','offer_letters'),
  ('owner','*')
on conflict do nothing;

-- ------------------------------------------------------ employee profiles
-- One row per employee, keyed by the login (auth.users.id). No foreign
-- key on purpose: the HR record must outlive a deleted login.
-- Aadhaar, PAN and the bank account number are stored ENCRYPTED
-- (AES-256-GCM); the key exists only in pa-web's server .env
-- (STAFF_DATA_KEY), never in the database or the repo.
create table if not exists survey.employees (
  user_id                 uuid primary key,
  employee_code           text unique,
  full_name               text not null,
  email                   text not null,
  mobile                  text,
  role_code               text not null,
  -- job
  branch                  text,
  date_of_joining         date,
  reporting_manager       text,
  -- personal
  address                 text,
  date_of_birth           date,
  emergency_contact_name  text,
  emergency_contact_phone text,
  -- salary (visible to admin / HR only)
  monthly_salary          numeric(12,2),
  -- ID and bank
  aadhaar_enc             text,
  pan_enc                 text,
  bank_account_enc        text,
  bank_account_name       text,
  bank_name               text,
  bank_ifsc               text,
  created_by              text not null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- ---------------------------------------------------------- offer letters
-- One row per letter. The company letterhead + signatory are copied into
-- `company` when the letter is created, so an old letter always
-- re-downloads exactly as it was issued.
create table if not exists survey.offer_letters (
  id                bigint generated always as identity primary key,
  candidate_name    text not null,
  candidate_email   text,
  candidate_mobile  text,
  candidate_address text,
  position          text not null,
  work_location     text,
  reporting_manager text,
  date_of_joining   date,
  pay_type          text not null default 'salary' check (pay_type in ('salary','stipend')),
  monthly_pay       numeric(12,2) not null,
  probation_months  integer not null default 6,
  notice_days       integer not null default 30,
  offer_date        date not null default current_date,
  valid_until       date,
  extra_terms       text,
  company           jsonb not null,
  created_by        text not null,
  created_at        timestamptz not null default now()
);

-- Company details printed on offer letters; filled by the app admin on
-- the Staff & HR page (single row).
create table if not exists survey.org_settings (
  id              integer primary key default 1 check (id = 1),
  company_name    text,
  company_cin     text,
  company_address text,
  company_phone   text,
  company_email   text,
  company_website text,
  signatory_name  text,
  signatory_title text,
  updated_by      text,
  updated_at      timestamptz
);
insert into survey.org_settings (id) values (1) on conflict do nothing;
-- Starting values given by the owner on 2026-11-14 (public company
-- record). Applied only while the row is still empty; afterwards the
-- admin edits them on the page and a re-run never overwrites that.
update survey.org_settings
   set company_name    = 'MSR Plotfarms Private Limited',
       company_cin     = 'U72900AP2020PTC114758',
       company_address = '7-26-6B, Chevuri Vari Thota, Kavali, Nellore District, Andhra Pradesh 524201, India',
       signatory_name  = 'Rajani Jetty',
       signatory_title = 'Director',
       updated_by      = 'migration 021',
       updated_at      = now()
 where id = 1 and company_name is null;

-- ------------------------------------------------------- app registration
-- Same pattern as 012 (platform app registration): the 'survey' app must
-- exist in platform.apps before any grant in platform.user_app_access
-- can reference it (foreign key). domain/admin_role_code columns come
-- from 013 (two-tier admin).
insert into platform.apps (app_code, display_name, schema_name)
values ('survey', 'Personal Assistant', 'survey')
on conflict (app_code) do nothing;

update platform.apps
   set domain = 'pa.plotfarms.com', admin_role_code = 'owner'
 where app_code = 'survey';

-- ------------------------------------------------------------ app DB role
-- Second wall, same pattern as the other apps: the service connects as
-- survey_app, which can touch only schema survey, plus read its own
-- grant rows in platform. Create the role ONCE, by hand, with the
-- password set on the server (never in this file, never in chat):
--
--   create role survey_app login password '<set-on-server>';
--
-- (If the role already exists, the grants below are all this file needs.)

grant usage on schema survey to survey_app;
grant select, insert, update, delete on all tables in schema survey to survey_app;
grant usage, select on all sequences in schema survey to survey_app;
-- The app reads its role table but must not be able to change what a
-- role may do.
revoke insert, update, delete on survey.role_capabilities from survey_app;

-- platform-admin (the only holder of the Auth service key) validates the
-- role an app admin assigns against THIS app's role list, exactly as 011
-- lets it read textiles.role_capabilities. Skipped where that DB role
-- does not exist (e.g. a local rig).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'platform_admin') then
    grant usage on schema survey to platform_admin;
    grant select on survey.role_capabilities to platform_admin;
  end if;
end $$;

-- The 42501 lesson (textiles, 2026-11-11): an app role needs USAGE on
-- the platform SCHEMA as well as the table grants, or every grant check
-- fails with "permission denied for schema platform".
grant usage on schema platform to survey_app;
grant select on platform.user_app_access to survey_app;
grant select on platform.apps to survey_app;
-- platform.user_app_access has RLS enabled; without BYPASSRLS the role
-- sees 0 rows (same fix as textiles_app, confirmed 2026-11-15).
alter role survey_app bypassrls;

-- ======================= VERIFY (results appear below) =======================
-- The app row must exist, and the privilege checks must all return true.
select app_code, display_name, schema_name, domain, admin_role_code
  from platform.apps where app_code = 'survey';

select has_schema_privilege('survey_app', 'survey', 'USAGE')   as survey_schema_usage,
       has_schema_privilege('survey_app', 'platform', 'USAGE') as platform_schema_usage,
       has_table_privilege('survey_app', 'survey.visits', 'INSERT')              as visits_insert,
       has_table_privilege('survey_app', 'platform.user_app_access', 'SELECT')   as grants_select;

-- The eight roles of this app, with what each may do.
select role_code, string_agg(capability, ', ' order by capability) as capabilities
  from survey.role_capabilities where allowed group by role_code order by role_code;
