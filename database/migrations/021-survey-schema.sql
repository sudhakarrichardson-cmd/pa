-- =====================================================================
-- PlotFarms PA — 021: Business Feedback (survey) schema + app registration
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

-- ------------------------------------------------------- app registration
-- Same pattern as 012 (platform app registration): the 'survey' app must
-- exist in platform.apps before any grant in platform.user_app_access
-- can reference it (foreign key). domain/admin_role_code columns come
-- from 013 (two-tier admin).
insert into platform.apps (app_code, display_name, schema_name)
values ('survey', 'Business Feedback', 'survey')
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

-- The 42501 lesson (textiles, 2026-11-11): an app role needs USAGE on
-- the platform SCHEMA as well as the table grants, or every grant check
-- fails with "permission denied for schema platform".
grant usage on schema platform to survey_app;
grant select on platform.user_app_access to survey_app;
grant select on platform.apps to survey_app;

-- ======================= VERIFY (results appear below) =======================
-- The app row must exist, and the privilege checks must all return true.
select app_code, display_name, schema_name, domain, admin_role_code
  from platform.apps where app_code = 'survey';

select has_schema_privilege('survey_app', 'survey', 'USAGE')   as survey_schema_usage,
       has_schema_privilege('survey_app', 'platform', 'USAGE') as platform_schema_usage,
       has_table_privilege('survey_app', 'survey.visits', 'INSERT')              as visits_insert,
       has_table_privilege('survey_app', 'platform.user_app_access', 'SELECT')   as grants_select;
