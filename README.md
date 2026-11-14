# PlotFarms PA — Business Feedback app

The pa.plotfarms.com site: a public PlotFarms Personal Assistant home page,
plus the **Business Feedback** survey — the Nov 12, 2026 field questionnaire
(Part A common core, one Part B module per business type, Part C engineer
wrap-up) as a login-only web form for PlotFarms employees.

Built by the **AI-DLC** process with **STRIDE** threat modelling, in the same
source structure as the textiles app (`sudhakarrichardson-cmd/textile`).
Gate 1 (Requirements) and Gate 2 (Architecture) were confirmed by the owner
on 2026-11-14 — see `docs/design/`.

## What the app does

- **Public home page** (`/`): the PlotFarms PA page (same as plotfarms.com,
  without the restaurant / matrimony / real-estate links) with Telegram
  links to https://t.me/ypa25bot and an Employee Login button. It contains
  **no survey content**.
- **Employee login** (`/login`): email + password, verified against the
  stack's Supabase Auth and the caller's grant in
  `platform.user_app_access` for app `survey`. Roles: employee (own visits),
  manager / owner (all visits, dashboard, export). Accounts are created by
  the app admin — there is no public sign-up and no shared key.
- **Survey** (`/feedback`, served only after login): step wizard mirroring
  the questionnaire — business type first (it selects the Part B module),
  Part A in steps, A10 samples with photo upload, review + submit, then
  Part C wrap-up as a separate post-visit step. Drafts auto-save.
- **Office dashboard + CSV export** (manager/owner): the Results Tracker
  summary counts live, and a CSV with the tracker's Visits columns.

## Repository layout

```
database/migrations/    021-survey-schema.sql — survey schema + app registration
deploy/caddy/           Caddyfile.template — pa.plotfarms.com block
docs/design/            Gate 1 plan + Gate 2 architecture (with STRIDE table)
docs/DEPLOY.md          server deployment, start to finish
scripts/verify.sh       static checks (syntax, secrets, forbidden links)
services/pa-web/        the app (plain Node, no framework) — src/server.js routes,
                        src/auth.js logins, src/visits.js survey API (sole DB
                        writer for schema survey), src/dashboard.js reports
tests/run.sh            Gate 5 starter checks (boot + login gate)
```

## Rules that shape the code

- The survey is **never** in a response to a logged-out visitor: `/feedback*`
  pages and `/api/*` data routes check the session and the `survey` grant
  on the server before anything is sent.
- `submitted_by` always comes from the login, never from the client.
- Photos (A10) are stored on the server volume under generated names and
  served only through an authenticated route — no public file URLs.
- One database, multiple schemas: this app owns schema `survey` and reads
  its grant rows in `platform`; its DB role (`survey_app`) can touch
  nothing else.
