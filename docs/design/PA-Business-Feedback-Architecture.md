# PlotFarms PA — Business Feedback — Architecture (AI-DLC Gate 2)

**Date:** 2026-11-14 · **Gate:** 2 of AI-DLC (Requirements = Gate 1 plan, delivered 2026-11-14)
**Process:** AI-DLC with STRIDE threat modelling, as in Textiles Requirements v1.1 §13 and Architecture v0.2 §8. **No build starts before the owner confirms this gate.**
**Code structure:** mirrors the textile repo @ c1b9783 (see Plan §11).

## 1. Components

| Component | What it is | Pattern it follows |
|---|---|---|
| Browser (employee phone) | Public home page; login; survey wizard; dashboard | textiles home.html / console.html served by the app service |
| Caddy (VPS) | TLS + reverse proxy: `pa.plotfarms.com → 127.0.0.1:8095` | deploy/caddy template, same as textiles block |
| `pa-web` service (port 8095, localhost only) | The whole app: pages + API, **sole DB writer for schema `survey`** | services/textiles-api — plain Node, no framework, `pg` only, Docker, external `supabase` network |
| Supabase Auth (GoTrue, existing stack) | Employee email + password verification | textiles per-user email logins |
| Postgres (existing stack) | Schema `survey` + `platform.user_app_access` grants | one DB, multiple schemas; per-app DB role as second wall |
| platform-admin (existing service, 8092) | App registration + this app's admins; app-level `/admin` for this app's people | two-tier admin, as deployed for textiles 2026-11-11 |
| Uploads volume (VPS) | A10 sample photos, served only through authenticated pa-web routes | textiles invoices volume pattern — files never on public URLs |

## 2. Request flow

1. Visitor opens pa.plotfarms.com → Caddy → pa-web serves the public home page (no survey content in it — the survey is not part of the public page's HTML, code, or API responses).
2. Employee taps Employee Login → email + password → pa-web verifies against GoTrue, then checks `platform.user_app_access` for a grant on app `survey`. No grant → login refused, even with a correct password.
3. On success pa-web issues an httpOnly session cookie. Every `/feedback*` page and `/api/*` call checks the session **and** the grant server-side before any survey data is read or written.
4. Wizard steps auto-save drafts via `visits.js` (status `draft`, `submitted_by` = the login). Submit sets `submitted`; Part C completes it (`completed`). Employees read/update only their own rows; manager role reads all + dashboard + export.
5. Photo uploads go to the volume with a `survey.attachments` row; downloads are streamed by pa-web after the same session + ownership/role check.

## 3. Data model

As in Plan §5 and `survey-schema.sql` (to be committed as `database/migrations/021-survey-schema.sql`): `survey.visits` (typed tracker/dashboard columns + `part_a`/`part_b`/`part_c` JSONB), `survey.attachments`. Access changes are audited in the existing `platform.access_audit`. Visit rows carry `submitted_by`, `created_at`, `updated_at`, `submitted_at` for attribution.

## 4. Technology choices

Plain Node (no framework) + `pg`, one service, Docker Compose per service, Caddy, existing Supabase Postgres/Auth — deliberately identical to textiles-api so the same deploy, backup, test-rig and admin machinery applies unchanged. No new database, no new auth system, no client-side framework.

## 5. STRIDE threat table

Modelled on Textiles Architecture v0.2 §8, per component:

| Component | Main threats (STRIDE) | Mitigations built into this architecture |
|---|---|---|
| Login (GoTrue) | **S**poofing — someone signs in as an employee/manager | Password auth via GoTrue; sign-ups OFF (accounts created only by the app admin); login rate limiting at Caddy/pa-web; session expiry; logins audited |
| Session + grant check | **E**levation — a valid login for another app (e.g. textiles) used here; employee token used for manager actions | Grant for app `survey` checked at login **and** role capability checked on every endpoint server-side; no grant, no session |
| Survey pages/API | **I**nformation disclosure — questionnaire or visit data reaching a logged-out visitor (the exact failure mode of a client-side-only gate) | Survey HTML and data are served **only after** server-side session verification; unauthenticated = redirect/401 with no survey content; the public home page contains no survey markup |
| pa-web API | **T**ampering — crafted request editing another employee's visit or a submitted record | Ownership check on every visit read/write (employee = own rows only); status transitions enforced server-side (draft → submitted → completed); all writes through `visits.js` only |
| Records | **R**epudiation — "I never submitted / changed that visit" | `submitted_by` + timestamps on every row; grant changes in `platform.access_audit`; submitted visits keep their submitter and submit time |
| Database (multi-schema) | **I**nformation disclosure — survey data leaking to another app's users/roles | `survey_app` DB role with grants only on schema `survey` (+ its own grant reads); no cross-schema queries; service credentials server-side only in `.env` |
| Photo uploads (A10) | **T**ampering — malicious or oversized file uploaded as a "sample photo"; **I**nformation disclosure — bill-book photos are business-sensitive | Image types + size limit enforced server-side; files stored outside any public path with generated names; served only via authenticated pa-web route after ownership/role check; no public or signed-forever URLs |
| Public home page + Telegram link | **S**poofing — a look-alike bot/link harvesting users | The only Telegram link published is the official https://t.me/ypa25bot; no bot token or credential exists in web code; bot tokens stay server-side in their own services |
| VPS / Caddy | **D**enial of service; data loss | Rate limiting on login + public endpoints; container bound to localhost, only Caddy exposed; daily Postgres backup (existing stack routine) + uploads volume in the same backup |

## 6. Gate checklist

- [x] Gate 1 Requirements — plan delivered 2026-11-14; **CONFIRMED by owner 2026-11-14** (Plan §8 defaults stand: app code `survey`, photo upload in Phase 1; first employee logins to be named at go-live)
- [x] Gate 2 Architecture — this document, with data model (§3) and STRIDE table (§5); **CONFIRMED by owner 2026-11-14**
- [x] Owner confirmed Gate 1 + Gate 2 (2026-11-14) → Gate 3 designs (home page approved 2026-11-14; survey screens per Plan §4) → **Gate 4 build started 2026-11-14** in the §11 structure
