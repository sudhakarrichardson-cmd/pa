-- =====================================================================
-- PlotFarms PA — 025: Dictionary learning loop (routes)
--
-- The dictionary maps a normalized message pattern to a ROUTE —
-- { route, category, items_template } — never to a destination app.
-- Which app serves a routed request is still decided live by
-- pa.app_registry + the user's pincode + best quote. Entries can only
-- decide WHERE TO ASK; prices, stock, slots and case facts come live
-- from the app, and nothing is ordered until the user confirms.
--
-- Learning (services/pa-web/src/dictionary.js, router is sole writer):
--   * ai-helper match >= 0.85 on a phrase the rule parser returned as
--     'unknown' -> routed + learned here as status='probationary'.
--   * 3 clean hits (user confirms the routed request and it is
--     placed) promote probationary -> 'active'.
--   * A cancel at that confirmation demotes a LEARNED entry to
--     'pending_review' (hit_count reset). Manual entries never demote.
--   * No match at all -> pa.dictionary_proposal (owner review only;
--     nothing is executed from a proposal).
-- Re-runnable: safe to run more than once.
-- =====================================================================

create schema if not exists pa;

create table if not exists pa.dictionary_entry (
  id             bigint generated always as identity primary key,
  pattern        text        not null unique,  -- normalizePattern(text)
  route          text        not null,         -- order | service_query | book | order_status
  category       text,                         -- vegetables | cloth | legal | appointment | null
  items_template jsonb       not null default '[]', -- [{name, unit}] — NO quantities
  status         text        not null default 'probationary',
                 -- probationary | active | pending_review | disabled
  source         text        not null default 'learned', -- learned | manual
  confidence     numeric,                      -- ai-helper confidence when learned
  hit_count      int         not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  last_used_at   timestamptz
);

create table if not exists pa.dictionary_proposal (
  id         bigint generated always as identity primary key,
  raw_text   text        not null,
  pattern    text        not null,
  status     text        not null default 'pending_review',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Seed entries (manual, active) — phrases the rule parser CANNOT see
-- (no keyword it knows), in the language PA's users actually type.
-- Item template names use the names PA already sends the apps today
-- (the VegiBot adapter resolves 'mirchi' to its Green chilli, etc.).
-- Manual entries are governance rows: set status='disabled' to stop
-- one without a deploy. They are never auto-demoted.
-- ---------------------------------------------------------------------
insert into pa.dictionary_entry (pattern, route, category, items_template, status, source)
values
  ('pachimirchi',  'order', 'vegetables', '[{"name":"mirchi","unit":"kg"}]',  'active', 'manual'),
  ('# pachimirchi','order', 'vegetables', '[{"name":"mirchi","unit":"kg"}]',  'active', 'manual'),
  ('ullipaya',     'order', 'vegetables', '[{"name":"onion","unit":"kg"}]',   'active', 'manual'),
  ('# ullipaya',   'order', 'vegetables', '[{"name":"onion","unit":"kg"}]',   'active', 'manual'),
  ('tamata',       'order', 'vegetables', '[{"name":"tomato","unit":"kg"}]',  'active', 'manual'),
  ('# tamata',     'order', 'vegetables', '[{"name":"tomato","unit":"kg"}]',  'active', 'manual'),
  ('bangaladumpa', 'order', 'vegetables', '[{"name":"potato","unit":"kg"}]',  'active', 'manual'),
  ('# bangaladumpa','order','vegetables', '[{"name":"potato","unit":"kg"}]',  'active', 'manual')
on conflict (pattern) do nothing;

-- survey_app (pa-web's DB role) access for the new tables.
grant select, insert, update, delete on pa.dictionary_entry to survey_app;
grant select, insert, update, delete on pa.dictionary_proposal to survey_app;
grant usage, select on all sequences in schema pa to survey_app;

-- Verify:
select pattern, route, category, status, source
from pa.dictionary_entry order by id;
