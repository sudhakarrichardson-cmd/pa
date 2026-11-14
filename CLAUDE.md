# Instructions for AI coding agents

This repository is the **PlotFarms PA Business Feedback** app for
pa.plotfarms.com — a public PA home page plus an employees-only survey
(the Nov 12, 2026 business questionnaire) stored in schema `survey`.
It follows the textiles app repo layout and its **AI-DLC + STRIDE**
process: no stage starts before the previous gate is confirmed by the
owner; design documents live in `docs/design/` — read them before
changing behaviour.

## Map

| Path | What |
|---|---|
| `services/pa-web/src/server.js` | HTTP server, routes, session gate |
| `services/pa-web/src/auth.js` | Employee login (GoTrue proxy + local JWT verify + `platform.user_app_access` grant for app `survey`), login throttle |
| `services/pa-web/src/visits.js` | Survey API + attachments — the ONLY writer to schema `survey` |
| `services/pa-web/src/dashboard.js` | Manager summary counts + Results-Tracker CSV export |
| `services/pa-web/src/home.html` | Public PA home page — must never contain survey content |
| `services/pa-web/src/login.html` | Employee login page |
| `services/pa-web/src/feedback.html` | Survey wizard + my visits + manager dashboard (served only after login) |
| `database/migrations/` | Numbered, re-runnable migrations. Next number after the deployed one; never edit a deployed migration — add a new one |
| `deploy/caddy/Caddyfile.template` | pa.plotfarms.com → 127.0.0.1:8095 |
| `docs/DEPLOY.md` | Server deployment runbook |
| `tests/run.sh` | Gate 5 starter checks |

## Conventions

- Plain Node 20, CommonJS, no framework, no build step. The only
  dependency is `pg` (`services/pa-web/package.json`). Keep it that way.
- pa-web is the only component that touches the database. The browser
  never talks to Postgres or to GoTrue directly.
- The session/grant check happens in `server.js` **before** any survey
  HTML or data is sent. Never move survey content into `home.html`, and
  never gate the survey in client-side JavaScript alone.
- `submitted_by` comes from the verified login (in `auth.js`), never
  from request bodies. Status moves only draft → submitted → completed,
  enforced in `visits.js`.
- Uploads: image types are sniffed from file bytes, size-capped, stored
  under generated names in `UPLOAD_DIR`, and served only through
  `GET /api/attachments/:id` after an ownership/role check.

## Secrets and private data

- **No secrets in code, migrations, docs or this file.** No passwords,
  tokens, JWT secrets, anon keys, or real login emails — ever.
- Configuration comes only from the server-side `.env` (names listed in
  `services/pa-web/.env.example`). `.env` is never committed; on the
  server its values are generated or shell-copied from the Supabase
  stack `.env`, as in `docs/DEPLOY.md` — never typed in chat.
- Survey answers are businesses' private data: they stay in schema
  `survey`, behind the login, and out of logs and test fixtures.

## Verifying changes

```bash
bash tests/run.sh
```

Must end with `ALL TESTS PASSED`. Run it before finishing any change,
and also run `bash scripts/verify.sh` (syntax, secret scan, home-page
link rules).
