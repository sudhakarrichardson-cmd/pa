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
  `platform.user_app_access` for app `survey`. This app's own roles
  (`survey.role_capabilities`): Intern, Trainee, Engineer, Sr Engineer
  (own visits); Manager, Branch Manager (all visits, dashboard, export);
  HR (Staff & HR only — no survey data); Admin (`owner` — all visits of
  all staff plus all HR work). There is no public sign-up
  and no shared key.
- **Staff & HR** (`/staff`, a separate page sent only to the admin and
  the HR role; linked from the header): employee profiles and logins
  created together, role changes, disabling access, new temporary
  passwords, and **offer letters** as PDF on the company letterhead.
  Aadhaar, PAN and bank account numbers are optional and stored
  encrypted. The platform admin (db.plotfarms.com/admin) adds only this
  app's admin; the admin (who also acts as HR) and HR add everyone else.
  Logins are created by the existing platform-admin service — pa-web
  forwards the request and holds no Auth service key.
- **Survey** (`/feedback`, served only after login): step wizard mirroring
  the questionnaire — business type first (it selects the Part B module),
  Part A in steps, A10 samples with photo upload, review + submit, then
  Part C wrap-up as a separate post-visit step. Drafts auto-save.
- **PA messaging layer** (consumer Personal Assistant, migration 023;
  design + gap analysis in `docs/design/PA-Messaging-Layer.md`): the
  public Telegram bot @ypa25bot also serves PA users — a chat that is
  not linked to an employee login goes to the PA router (`src/router.js`),
  which registers the user once (name, address, pincode), understands
  the request, and asks registered apps (Textiles, VegiBot, Scheduler,
  HelpLawyer — `pa.app_registry`) for basic information only:
  `check_availability`, then `place_order` after the user confirms,
  and `order_status`. Quotes from all stores serving the user's
  pincode are compared; the vendor sends the invoice and payment
  instructions; PA keeps only a platform-level order copy
  (`pa.orders`). Other channels reach the same router through
  `POST /api/pa/inbound` from the transport-only gateways. The
  registry is managed at `/api/pa/apps` (admin; list for managers).
- **Office dashboard + CSV export** (manager/owner): the Results Tracker
  summary counts live, and a CSV with the tracker's Visits columns.

## Repository layout

```
database/migrations/    021-survey-schema.sql — survey schema, roles, HR tables,
                        app registration; 022 — employee Telegram links;
                        023-pa-messaging.sql — schema `pa` (PA users, app
                        registry, sessions, order book, request log)
deploy/caddy/           Caddyfile.template — pa.plotfarms.com block
docs/design/            Gate 1 plan + Gate 2 architecture (with STRIDE table)
docs/DEPLOY.md          server deployment, start to finish
scripts/verify.sh       static checks (syntax, secrets, forbidden links)
services/pa-web/        the app (plain Node, no framework) — src/server.js routes,
                        src/auth.js logins, src/visits.js survey API (sole DB
                        writer for schema survey), src/dashboard.js reports,
                        src/staff.js employee profiles + logins (logins via
                        platform-admin), src/offers.js offer letters (PDF),
                        src/router.js PA messaging router (consumer chats),
                        src/apps.js app registry + basic-interface client
tests/run.sh            Gate 5 starter checks (boot + login gate)
tests/pa-messaging.test.js  router flow tests (in-memory store, no DB)
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
