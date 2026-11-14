# PlotFarms PA — Business Feedback (Survey) Web Form — Build Plan

**Date:** 2026-11-14 · **Site:** pa.plotfarms.com · **Page:** Business Feedback
**Source:** Business Survey Questionnaire, 2026-11-12 (Part A common core, Part B type modules, Part C engineer wrap-up)
**Host:** VPS srv2111189 (same server as textiles / wa-gateway / db.plotfarms.com)

## 1. What we are building

The paper questionnaire becomes a login-only web form that the field engineer fills on his phone during the visit. One submitted form = one business visit, stored in the database. The office gets a live summary instead of paper forms and a manually updated Excel tracker.

Nothing on this site is public (owner-confirmed 2026-11-14: pa.plotfarms.com is the website, and the survey page is displayed **only after login**). An unauthenticated visitor sees the login screen and nothing else — no landing page, no questionnaire content, no business data.

## 2. Site and pages — pa.plotfarms.com

| Route | Who | What |
|---|---|---|
| `/` | Everyone | No page of its own: redirects to `/login` when not logged in, and to `/feedback` when a valid employee session exists. |
| `/login` | Employees | The only screen an unauthenticated visitor ever sees. Email + password login (same platform login system as the textiles console). |
| `/feedback` | Employee (logged in) | Business Feedback home: "New visit" button + my visits (drafts and submitted). |
| `/feedback/new` | Employee | The questionnaire form (wizard, §4). |
| `/feedback/:id` | Employee (own) / Manager (any) | View or continue a draft, add Part C wrap-up. |
| `/feedback/dashboard` | Manager / Owner only | All visits, filters, summary counts, CSV/Excel export. |
| `/admin` | App admin (owner) | This app's people and roles only — same two-tier admin pattern as textiles (db.plotfarms.com/admin shows apps and their admins; pa.plotfarms.com/admin manages only this app's users). |

The survey page (`/feedback`, `/feedback/new`, `/feedback/:id`, dashboard) is rendered **only after login** — the server checks the session before sending any part of it, so the questionnaire is never present in a page sent to a logged-out visitor. Unauthenticated request to any `/feedback*` route → redirect to `/login`. The API also returns 401 without a session — the login check is on the server, not just hidden buttons.

## 3. Login — reuse the platform system, do not build a new one

- Same rule as every PlotFarms app: **one database, multiple schemas; access is granted per app** in `platform.user_app_access`.
- Register a new app in `platform.apps`: code **`survey`**, name **"Business Feedback"** (pa.plotfarms.com).
- An employee logs in with the same email + password as the other PlotFarms consoles. Login succeeds for this site **only if** that user has a grant for app `survey`.
- Roles for this app: **employee** (fill forms, see and edit only own drafts/visits), **manager** (see all visits, dashboard, export), **owner/admin** (everything + manage this app's users at `/admin`).
- Session: httpOnly cookie issued by the service, same pattern as the textiles console. No shared STAFF_KEY-style login for this app — every visit must record *which employee* submitted it.
- Employee accounts are created by the app admin at `/admin` (name, email, role). No public sign-up.

## 4. The form — questionnaire mapped 1:1

Mobile-first, step-by-step wizard (the engineer is standing in a shop, often on a weak signal). One section per screen, big tap targets, dropdowns/chips instead of typing wherever the paper form has tick-boxes.

| Step | Source | Content |
|---|---|---|
| 0. Start | — | Business type first: Cloth / Vegetable / Restaurant / Grocery-Kirana / Lawyer / Doctor. This choice decides which Part B module appears at Step 6. Visit date defaults to today; engineer name comes from the login, never typed. |
| 1. Business profile | A1 (Q1–8) | Business name, owner name + decision maker, owner WhatsApp number, address + landmark, town, years in business, retail/wholesale/both, registration (GSTIN / trade licence / Udyam / none), customer languages, shop timings. |
| 2. People & operations | A2 (Q9–13) | Staff count and roles, who attends calls/WhatsApp and what happens when busy, single-person dependencies, busy/slow hours, who will operate a new system + smartphone comfort. |
| 3. Customers & orders today | A3 (Q14–19) | Customer type + radius, orders/day (weekday/weekend), enquiry channels with counts (walk-in, phone, WhatsApp personal, WhatsApp Business, app/platform, staff/agents), how new customers find them, **missed enquiries per week**, repeat customers. |
| 4. Today's flow & catalogue | A4–A5 (Q20–27) | Step-by-step flow (long text), where delays/mistakes happen, what is on paper, item/service count + top categories, price list exists?, price-change frequency, different rates for different customers, items asked for but not supplied. |
| 5. Billing, pains & readiness | A6–A8 (Q28–40) | Billing method, GST billing, payment split (cash/UPI/card/credit %), credit/khata practice + outstanding range, daily sales range, end-of-day tally, **pain points: tick all + pick TOP 3 in order**, "one thing to fix tomorrow" (owner's words), smartphones, internet, computer/printer, software used today, previous app tried, languages needed. |
| 6. Goal & pilot | A9 (Q41–47) | What should improve first, extra orders/month that make it worth it, current monthly spend, **fee-comfort range (ranges only — the form has no free fee field, so the "never quote a fee" rule is enforced by design)**, free 2-week pilot: Yes / No / After demo, final decision maker, office callback contact + time. |
| 7. Samples | A10 | Tick what was collected + **photo upload**: bill/invoice sample, price list/menu/fee chart, shop front, visiting card/pamphlet, catalogue photos, current software screen. Files go to a VPS volume, linked to the visit. |
| 8. Type module | Part B (only the matching one) | B1 Cloth (12 Q), B2 Vegetable (10 Q), B3 Restaurant (10 Q), B4 Grocery/Kirana (10 Q), B5 Lawyer (12 Q), B6 Doctor (12 Q) — same questions and options as the paper module, nothing added, nothing dropped. |
| 9. Review & submit | — | Full summary on one screen, fix-anything links per step, Submit. |

**Part C — separate, after the visit.** Submitting creates the visit with status `submitted`. Part C (template fit, fit score, setup-data readiness, decision-maker met, interest level, top pain in one line, fee reaction, pilot agreed + date, next step + date, unusual notes) is filled from `/feedback/:id` afterwards — status becomes `completed`. It is never part of the in-shop flow, matching the paper rule "fill after leaving, never show the owner" (the owner never sees this site at all, but the separation keeps the visit flow fast).

**Drafts:** every step auto-saves a server-side draft, so a dropped connection or a busy owner does not lose the visit. Drafts appear under "My visits" and can be resumed on any device with the same login.

**Required fields (kept deliberately few, so field entry is never blocked):** business type, business name, town, owner WhatsApp number. Everything else can be saved incomplete in a draft; the review screen lists what is still blank before submit.

## 5. Database — new schema `survey` in the existing Postgres

Same self-hosted Supabase Postgres on the VPS (the stack behind db.plotfarms.com). One new schema, following the platform rule (public = HelpLawyer/RNB, textiles = Padmavathi, **survey = Business Feedback**). Draft SQL is delivered with this plan: `survey-schema.sql`.

- **`survey.visits`** — one row per visit. Typed columns for everything the office searches, counts, or exports (business name/type/town, owner + WhatsApp, visit date, submitted by, orders/day, missed enquiries/week, top pain, template fit, fit score, interest, fee comfort, pilot status/date, next step, status) + three JSONB columns `part_a`, `part_b`, `part_c` holding the full answers exactly as filled. This hybrid gives the dashboard real columns to count on, without building 150 columns for questions that are only ever read back whole.
- **`survey.attachments`** — one row per uploaded sample photo (visit id, A10 kind, file path, uploaded by, time).
- **App DB role** `survey_app` with grants only on schema `survey` + read of its own grant rows in `platform.user_app_access` — the same second-wall pattern as the other apps. The new service is the **only writer** to schema `survey`; the web page never touches the DB directly.
- The dashboard's summary counts are the Results Tracker Summary sheet, live: total visits, hot/warm leads, pilots agreed, demo-first, fit scores, visits by type — computed from the typed columns, no manual Excel.
- Export (manager only): CSV/Excel with exactly the Results Tracker's Visits columns, so the existing office habit keeps working.

## 6. Service and hosting on the VPS

- **New container `pa-web`** on srv2111189 — one small service that serves the pa.plotfarms.com pages and the feedback API (same shape as textiles-api / platform-admin: Node, Docker, `.env` on the server only, no secrets in the repo).
- **Port 8095** (next free after wa-gateway 8080, telegram-gateway 8082, textiles-api 8091, platform-admin 8092, ai-helper 8093, conversation-engine 8094 — verify free before deploy).
- **DNS:** A record `pa` → VPS IP, same as the other subdomains.
- **Caddy:** new block `pa.plotfarms.com → 127.0.0.1:8095`, HTTPS auto-issued like the other subdomains. Caddyfile backed up, validated, then reloaded — the exact procedure used for db/textiles on 2026-11-11.
- **Uploads:** Docker volume on the VPS for sample photos, served only through the logged-in app (no public file URLs).
- **Backups:** schema `survey` rides the existing Postgres backup; the uploads volume is added to the same backup run.

## 7. Build order

| Phase | Work | Done when |
|---|---|---|
| 0 | Owner confirms this plan + the 3 open items in §8; app `survey` registered in `platform.apps` | Go-ahead in chat |
| 1 | DB: run `survey-schema.sql` (schema, tables, `survey_app` role, grants); create employee logins + grants | A test login shows the empty feedback home |
| 2 | `pa-web` service: login/session, `/feedback` list, wizard Steps 0–9 with draft auto-save, Part C screen, photo upload | Engineer can complete a full test visit on a phone |
| 3 | Manager dashboard: filters (type, town, date, employee, interest), summary counts, CSV/Excel export | Counts match a hand-check of test visits |
| 4 | Deploy: DNS + Caddy + container on VPS; HTTPS check | pa.plotfarms.com opens with login on a phone outside the VPS network |
| 5 | Pilot: engineer does 2–3 real visits; office checks dashboard + export; fix what the field shows | Owner confirms pilot visits read correctly in the dashboard |

## 8. Open items — owner's one-line call on each

1. **App name/code:** `survey` / "Business Feedback" as above — or a different name?
2. **First logins:** names + emails + role (employee/manager) for the engineer(s) and office staff who should get access at launch.
3. **Photo upload in Phase 1** (as planned above) — or defer uploads to Phase 2 and keep A10 as tick-boxes only for launch?

## 9. Rules carried over from the paper questionnaire

- The engineer never quotes a fee or promises a feature/date — the form enforces this: fee comfort is a fixed range list, and there is no "promised" field anywhere.
- Numbers are collected in ranges, exactly as the paper form offers them.
- Part C is internal and separate from the in-shop flow.
- Business owners never get accounts on this site; it is employees-only.

## 10. Process — AI-DLC with STRIDE (same as the textiles app)

Owner direction, 2026-11-14: this app is built like the latest textiles application. It therefore follows the same process the textiles project used — **AI-DLC (AI Development Life Cycle) with STRIDE threat modelling**, exactly as written in the Textiles Requirements v1.1, §13. No stage starts before the previous gate is confirmed by the owner; scope changes go into a new version of the document, not into chat messages.

| Gate | Deliverable for this app | Status |
|---|---|---|
| 1. Requirements | This plan (questionnaire mapping, login rule, DB design, hosting) | **Delivered + CONFIRMED by owner 2026-11-14** |
| 2. Architecture | Architecture document + data model + **STRIDE threat table** + technology choices (`PA-Business-Feedback-Architecture.md`, delivered with this plan) | **Delivered + CONFIRMED by owner 2026-11-14** |
| 3. Design | Screen designs: the pa.plotfarms.com home page preview (already built and owner-approved 2026-11-14, with the employee-login section), login screen, survey wizard screens, manager dashboard | Home page done; survey screens at build |
| 4. Build (iterative, AI-assisted) | `pa-web` service in the textiles code structure (§11), in module order: login/access → survey wizard + drafts → Part C → dashboard/export → photo upload | **Started 2026-11-14 after Gate 1+2 confirmation** |
| 5. Test | Test cases per module + STRIDE security checks (unauthenticated access, cross-employee access, role elevation, upload abuse) on the test rig pattern used by textiles (`tests/rig` with fake auth) | After build |
| 6. Go-live & support | DNS + Caddy on the VPS, employee logins created, engineer pilot with 2–3 real visits | Owner go/no-go |

The Muse preview page built on 2026-11-14 is a **Gate 3 design reference only**. Its demo login is not production code and is never deployed: production code is written fresh at Gate 4 in the structure below, with server-side login enforcement per the STRIDE table.

## 11. Source code structure — same as the textiles app

New repository laid out exactly like `sudhakarrichardson-cmd/textile` @ c1b9783 (README + CLAUDE.md, `database/`, `deploy/`, `docs/`, `scripts/`, `services/`, `tests/`). Each service is plain Node with no framework, its own Dockerfile + docker-compose.yml + package.json + `.env.example`, source under `src/`, bound to localhost only, on the external `supabase` Docker network, with Caddy in front — the textiles-api pattern throughout.

```
pa/                                  (repo root — layout mirrors textile repo)
  README.md                          what the app does + layout (textile README pattern)
  CLAUDE.md                          rules for AI coding agents (no secrets in code, config in .env only, tests must pass)
  database/
    migrations/
      021-survey-schema.sql          the survey schema (draft delivered as survey-schema.sql; takes the next migration number)
  deploy/
    caddy/Caddyfile.template         pa.plotfarms.com → 127.0.0.1:8095 block
  docs/
    design/                          this plan (Gate 1) + Architecture (Gate 2) live here
    DEPLOY.md                        server deployment, start to finish (textile DEPLOY.md pattern)
    history/                         manifests and runbooks, as in the textile repo
  scripts/                           deploy/verify helpers (no dependencies, textile scripts pattern)
  services/
    pa-web/                          THE app — analogue of services/textiles-api
      Dockerfile
      docker-compose.yml             container pa-web, "127.0.0.1:8095:8095", env_file .env, uploads volume, network supabase (external)
      package.json                   dependency: pg only (as textiles-api)
      .env.example                   DB creds for survey_app, session settings — real values only in server .env
      src/
        server.js                    HTTP server, routes, session gate (the /inbound-equivalent single entry)
        auth.js                      employee login via platform grant (mirrors textiles staff.js login + access checks)
        visits.js                    survey API: drafts, submit, Part C, my-visits (sole DB writer for schema survey)
        dashboard.js                 manager summary + CSV/Excel export (mirrors textiles owner.js reports)
        home.html                    public PA home page (Gate 3 preview design, re-implemented here)
        login.html                   employee login page
        feedback.html                survey wizard + my visits + dashboard pages
  tests/
    rig/                             local test rig: embedded Postgres + fake GoTrue (textile tests/rig pattern)
    run.sh
```

No new admin service is built: user/role administration reuses the existing **platform-admin** service and the two-tier admin model (db.plotfarms.com/admin for apps and their admins; pa.plotfarms.com/admin for this app's people), exactly as textiles does.
