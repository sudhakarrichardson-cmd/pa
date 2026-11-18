-- =====================================================================
-- PlotFarms PA — 026: Service-question seed entries
--
-- Two new dictionary routes (services/pa-web/src/dictionary.js):
--   list_services — "which shops/services are registered with PA?"
--   which_shop    — "which shop will fulfil my order?"
-- The ai-helper matches these routes for any phrasing; PA answers
-- from pa.app_registry / the live session — the helper never names
-- a shop. These manual seeds cover the canonical short forms so a
-- plain dictionary lookup fires without a helper call. Patterns are
-- normalizePattern() output (lowercase, digits masked, punctuation
-- stripped) and must match the WHOLE message.
-- Manual entries are governance rows: status='disabled' stops one
-- without a deploy. They are never auto-demoted.
-- Re-runnable: safe to run more than once.
-- =====================================================================

insert into pa.dictionary_entry (pattern, route, category, items_template, status, source)
values
  ('shops',                'list_services', null,         '[]', 'active', 'manual'),
  ('list shops',           'list_services', null,         '[]', 'active', 'manual'),
  ('shops list',           'list_services', null,         '[]', 'active', 'manual'),
  ('registered shops',     'list_services', null,         '[]', 'active', 'manual'),
  ('available shops',      'list_services', null,         '[]', 'active', 'manual'),
  ('which shops',          'list_services', null,         '[]', 'active', 'manual'),
  ('list services',        'list_services', null,         '[]', 'active', 'manual'),
  ('vegetable shops',      'list_services', 'vegetables', '[]', 'active', 'manual'),
  ('list vegetable shops', 'list_services', 'vegetables', '[]', 'active', 'manual'),
  ('which shop',           'which_shop',    null,         '[]', 'active', 'manual')
on conflict (pattern) do nothing;

-- Verify:
-- select pattern, route, category, status from pa.dictionary_entry
--  where route in ('list_services','which_shop') order by pattern;
