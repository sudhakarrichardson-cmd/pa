# Deploying pa-web (pa.plotfarms.com)

Deploys the Business Feedback app on the existing VPS (srv2111189),
alongside the Supabase stack and the other PlotFarms services. Commands
run on the server as root. Read each command's output before moving on.

> Secrets rule (same as textiles): values are generated on the server or
> shell-copied from the stack `.env`. Never type a password, key or token
> in chat, and never commit a real `.env`.

## 0. What must already exist

| Requirement | Check |
|---|---|
| Docker + Docker Compose | `docker compose version` |
| Caddy serving HTTPS for the other subdomains | `systemctl status caddy` |
| Self-hosted Supabase stack up (network `supabase_default`, DB container reachable as `db:5433` on that network) | `docker ps --format '{{.Names}}'` |
| Migrations up to 020 already applied | Studio → database → migrations, or check with the other apps working |
| Port 8095 free on the host | `ss -ltn \| grep 8095` (must print nothing) |
| platform-admin running **with per-app roles and the HR rule** (the textile-repo change: `rolesForApp` reads `<schema>.role_capabilities`, and a role with `manage_users` may manage people but never the app admin), container name `platform-admin` on `supabase_default` | `docker ps`; after pulling the textile repo: `cd services/platform-admin && docker compose up -d --build` |

## 1. DNS

Add an **A record**: `pa` → the VPS IP (same target as `textiles` /
`db`). Wait until `dig +short pa.plotfarms.com` prints the IP.

## 2. Get the code tree onto the server

Clone this repo to `/root/pa/` (the layout mirrors the textile repo):

```bash
git clone https://github.com/sudhakarrichardson-cmd/pa.git /root/pa
```

```
pa/
  database/  deploy/  docs/  scripts/  services/pa-web/  tests/
```

## 3. Create the app DB role (once)

In the Studio SQL editor (db.plotfarms.com) or via `docker exec` psql,
as postgres — set a generated password and keep it for step 5:

```sql
create role survey_app login password '<generated-on-server>';
```

(If the role already exists, skip — migration 021 applies the grants.)

## 4. Run migration 021

Paste `database/migrations/021-survey-schema.sql` into the Studio SQL
editor and run it. It creates schema `survey`, registers the app
(`platform.apps`: `survey` / "Business Feedback" / pa.plotfarms.com) and
grants `survey_app` its access — including USAGE on schema `platform`
(the 42501 lesson). It also creates this app's own roles in
`survey.role_capabilities` (and lets `platform_admin` read that list),
the HR tables `survey.employees`, `survey.offer_letters` and
`survey.org_settings`, and fills the company details for offer letters
(only while they are still empty). The VERIFY selects at the end must
show the app row, all four privilege checks `true`, and eight roles
(intern, trainee, engineer, sr_engineer, manager, branch_manager, hr,
owner).

## 5. Create `services/pa-web/.env`

Start from `.env.example` and fill it **on the server**:

```bash
cd /root/pa/services/pa-web
cp .env.example .env
# DB password = the survey_app password from step 3:
#   DB_PASSWORD=<the generated password>
# Stack secrets under the same aliases textiles-api uses (shell-copied,
# never displayed in chat):
echo "SUPABASE_JWT=$(grep -oP '^JWT_SECRET=\K.*' /root/supabase-selfhost/docker/.env)" >> .env
echo "SUPABASE_ANON_KEY=$(grep -oP '^ANON_KEY=\K.*' /root/supabase-selfhost/docker/.env)" >> .env
# Key for the encrypted ID / bank numbers in employee profiles — generate
# once, never change it, and keep a copy with the database backup:
echo "STAFF_DATA_KEY=$(openssl rand -hex 32)" >> .env
```

Confirm the final `.env` has: `DB_HOST=db`, `DB_PORT=5433`,
`DB_USER=survey_app`, `SUPABASE_AUTH_URL=http://kong:8000`,
`UPLOAD_DIR=/data/uploads`, `PORT=8095`,
`PLATFORM_ADMIN_URL=http://platform-admin:8092`,
`APP_DOMAIN=pa.plotfarms.com`, and a 64-character `STAFF_DATA_KEY`.
Each of the appended names must appear with a value only once — delete
the empty line of the same name that came from `.env.example`.

## 6. Build and start the container

```bash
cd /root/pa/services/pa-web
docker compose up -d --build
docker logs pa-web        # must end with: pa-web listening on 8095
curl -s http://127.0.0.1:8095/health   # {"ok":true}
```

## 7. Caddy

Back up the live Caddyfile, append the block from
`deploy/caddy/Caddyfile.template`, then validate before reloading:

```bash
cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak
# append the pa.plotfarms.com block
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

## 8. Create the app admin, then the employees

Two tiers, as for the other apps — there is no `/admin` page on
pa.plotfarms.com:

1. **Platform admin** (db.plotfarms.com/admin) adds **only this app's
   admin**: under app *Business Feedback*, add the admin's login. That
   grants role `owner` (shown as "Admin") on app `survey`.
2. **App admin** signs in at pa.plotfarms.com → Employee Login. The
   admin sees every employee's survey visits and the dashboard, and the
   header shows a **Staff & HR** link (a separate page, sent only to the
   admin and HR). The admin acts as admin and HR:
   - **Employees** — add an employee: profile (job, personal, salary;
     ID and bank details are optional) and login in one step, with a
     role and a temporary password. Edit a profile, change the role,
     **disable access**, or set a new temporary password.
   - **Offer letters** — fill the form (or start from an employee's
     profile) and download the PDF.
   - **Company details** — name, CIN, registered office and who signs;
     printed on every new offer letter. Check them before the first
     letter.
3. Roles of this app: Intern, Trainee, Engineer, Sr Engineer (own
   visits only); Manager, Branch Manager (all visits + dashboard +
   export); **HR** (Staff & HR page only — no survey data; cannot give
   the HR role, and cannot touch an admin); Admin.
4. Admins themselves are added or changed only by the platform admin.

If Staff & HR shows "user service unreachable", pa-web cannot reach
platform-admin: check both containers are on `supabase_default` and
`PLATFORM_ADMIN_URL` / `APP_DOMAIN` in `.env`. If it rejects a role
with "role does not belong to this app", or an HR login gets "not an
admin of this app", platform-admin is still the old build (see step 0).

## 9. Add uploads to the backup

Schema `survey` (visits, employee profiles, offer letters) rides the
existing Postgres backup automatically. Keep a copy of `STAFF_DATA_KEY`
with it — without the key the encrypted ID / bank numbers in a restored
database cannot be read. Add the uploads folder to the same backup run:

```
/root/pa/services/pa-web/uploads/
```

## 10. Verify checklist

From a phone **outside** the VPS network:

- [ ] `https://pa.plotfarms.com/` opens the PA home page (HTTPS padlock),
      with Telegram links to @ypa25bot and an Employee Login button —
      and **no** restaurant / matrimony / real-estate links.
- [ ] `https://pa.plotfarms.com/feedback` while logged out redirects to
      the login page (no survey content is shown).
- [ ] Login with an employee account **without** a `survey` grant is
      refused (403); with a grant it opens the survey.
- [ ] As the app admin: the **Staff & HR** link is visible and all
      visits of all staff are listed. Add a test Engineer with a profile;
      sign in as that Engineer — no Staff & HR link, no dashboard, only
      own visits, and `/staff` sends them back to the survey.
- [ ] Add a test HR login: it lands on Staff & HR, cannot open the
      survey or dashboard, and is not offered the HR or Admin role.
- [ ] Save a test Aadhaar / PAN on a profile, then check the row in
      Studio: `aadhaar_enc` starts with `v1:` and shows no digits.
- [ ] Create a test offer letter and download the PDF: company name, CIN,
      registered office and signatory are correct. Disable the test
      logins afterwards.
- [ ] A test visit: create a draft, fill a few answers, confirm it
      re-opens after signing out and back in (draft auto-save works).
- [ ] Submit the test visit, add the Part C wrap-up, confirm the status
      becomes `completed`.
- [ ] Upload one A10 photo; confirm it opens only while logged in.
- [ ] As a manager: dashboard counts include the test visit and the
      CSV export downloads with the Results Tracker columns.
- [ ] `docker logs pa-web` shows no errors; delete the test visit rows
      from `survey.visits` when the pilot is done checking.
