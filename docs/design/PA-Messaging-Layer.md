# PA Messaging Layer — gap analysis and what was added

Repo state reviewed: `pa` @ `f1d90d0` (2026-11-15, 7 commits).
Design basis: PlotFarms Messaging Layer use cases UC-01…UC-11
(2026-11-14), the PA model clarified by the owner the same day
(registered users, PA-mediated ordering), and the PA Basic Interface
spec (PA may only request `check_availability`, `place_order`,
`order_status` from a registered app).

## What the repo already had (not messaging layer)

- Public PA home page linking the Telegram bot @ypa25bot, employee
  login, the Business Feedback survey, Staff & HR, offer letters.
- A Telegram bot (`telegram.js`) — but **employee-only**: it links a
  Telegram chat to an *employee* login and answers survey questions
  (`/visits`, `/dashboard`, MiniMax over visit data). A member of the
  public who opened @ypa25bot from the home page was told to link an
  employee account — a dead end for PA users.
- Employee Telegram link tables (migration 022).

## What was missing from the design — and is now added

| # | Design piece | Before | Now |
|---|---|---|---|
| 1 | PA user registration (name, address, pincode; location derived, never re-asked) — UC-01 | Missing — only employee logins existed | `pa.users` (migration 023); conversational registration in `router.js` |
| 2 | App registry: endpoint, capabilities, service area, mode, status per app instance | Missing — `platform.apps` knows platform apps, not PA-callable domain apps | `pa.app_registry` seeded with the 4 POC apps as `pending`; admin API `/api/pa/apps` + activation test in `server.js` / `apps.js` |
| 3 | Router: understand the request, pick the service, own the conversation — UC-03…UC-06 | Missing | `router.js` (pf-router): deterministic rule parser first, optional ai-helper escalation returning data only; numbered menu fallback |
| 4 | Consumer sessions that survive restarts | Missing (employee link table only) | `pa.sessions` in Postgres — never in-memory only |
| 5 | Basic-interface client: PA asks apps for stock/price/slots/info and places orders | Missing — PA called no app | `apps.js`: `check_availability` / `place_order` / `order_status` over HTTP with a per-app shared secret (`x-pa-secret`; registry stores only the env-var name) |
| 6 | Quote → compare → confirm → order; best store for the user's pincode — UC-07/08 | Missing | Mediated mode in `router.js`: all serving apps are quoted, lowest available total wins, order placed only after the user replies YES, idempotent via `pa_request_id` |
| 7 | PA order book (platform-level copy) | Missing | `pa.orders` |
| 8 | Lawyer / scheduler modes — UC-06/07 | Missing | `query` mode (basic case info first, request submitted on confirm) and `booking` mode (slots are the availability; pick a number to book) |
| 9 | Status / follow-up in the same chat — UC-10 | Missing | `status` intent: latest order, live status asked from the app, stored status as fallback |
| 10 | No service found → noted, not silent — UC-11 | Missing | `pa.request_log` (`no_service_found`, `not_understood`) + a plain reply to the user |
| 11 | WhatsApp/SMS channel entry for PA | Missing — Telegram webhook only, employee-shaped | `POST /api/pa/inbound` in `server.js`: the transport-only gateways POST `{channel, user_ref, text}` and send back `{replies[]}` — the textiles `/inbound` contract shape. Telegram consumer chats route through the same router inside `telegram.js` |
| 12 | Voice notes → text — UC-02 | Missing | Still pending (see below) |

## How an app registers (Textiles, VegiBot, …)

1. The app deploys its adapter endpoint answering the three basic
   requests in the common format.
2. PlotFarms creates/updates the registry row (`POST /api/pa/apps`,
   admin): `app_id`, type, categories, `service_pincodes`, endpoint,
   `secret_env` (the *name* of the env var holding the shared secret),
   mode (`mediated` / `query` / `booking`). Status starts `pending`.
3. `POST /api/pa/apps/<id>/test` makes one read-only
   `check_availability` call; a correct answer flips the row to
   `active`. From then on the router finds it automatically for users
   in its pincodes. `inactive` stops routing; the app itself is
   unaffected and keeps running independently.

## STRIDE notes (new surface)

- **Spoofing** — gateway inbound requires `PA_INBOUND_SECRET`
  (fails closed with 503 when unset); app calls carry a per-app
  secret; registry changes require the admin capability (`*`), the
  list requires a manager capability.
- **Tampering** — orders are idempotent (`pa_request_id` primary key,
  `ON CONFLICT DO NOTHING`); a check never creates anything in any app.
- **Information disclosure** — registry API responses mask
  `endpoint_url` and never expose secrets (only env-var names exist in
  the DB); consumer replies on Telegram are sent as plain text (no
  HTML parse mode) so user-supplied names/items cannot inject markup.
- **Elevation** — a PA user can only ever trigger the three basic
  requests against apps; PA holds no app database access at all.
- **DoS** — app calls time out at 8 s and degrade to a plain
  "try again shortly" reply; sessions/quotes are per-chat rows.

## Correction — 2026-11-15, from the owner's first test

The owner tested the bot from his own Telegram and got the employee
AI's answer ("the data contains only visits and dashboard counts").
Cause: his chat is linked as an employee, and the first version of
this change sent *every* linked chat to the employee bot — a linked
account could never reach the consumer flow. Fix: routing is now by
intent for linked chats. Employee commands are unchanged; free text
that the rule parser reads as a PA request (or a status question), and
any reply inside a PA flow the chat already started (registration,
quote confirmation, slot pick), goes to the router
(`router.shouldHandle`). Visit questions still go to the employee AI.

## Still pending (not in this change)

- **App-side adapters** in the four app repos (Textiles stock read
  beside `/internal/catalog`; VegiBot quote/order adapter; Scheduler
  inbound adapter; HelpLawyer adapter over `HlRepo`). Until an
  adapter answers the activation test, its registry row stays
  `pending` and PA honestly reports no service in the area.
- **Voice notes (UC-02)** — needs the shared Sarvam STT step in the
  gateways before the router sees the text.
- **SMS and live calls** — out of POC scope, as fixed 2026-11-14.
- **Gateway configuration on the VPS** — point wa-gateway /
  telegram-gateway at `POST /api/pa/inbound` with the shared secret
  (deploy step, `docs/DEPLOY.md` §4b).

## Tests

- `node tests/pa-messaging.test.js` — router flow tests on an
  in-memory store: registration, J2 quote-compare-confirm-order,
  J4 slot booking, J3 lawyer query + request, UC-11 logging.
- `bash tests/run.sh` — existing gate checks plus: registry API is
  gated (401 logged out) and `/api/pa/inbound` fails closed (503)
  when unconfigured.
- `bash scripts/verify.sh` — syntax + secret scan cover the new files.
