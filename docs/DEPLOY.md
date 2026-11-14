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
(the 42501 lesson). The VERIFY selects at the end must show the app row
and all four privilege checks `true`.

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
```

Confirm the final `.env` has: `DB_HOST=db`, `DB_PORT=5433`,
`DB_USER=survey_app`, `SUPABASE_AUTH_URL=http://kong:8000`,
`UPLOAD_DIR=/data/uploads`, `PORT=8095`.

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

## 8. Create employee logins + grants

Using the existing **platform-admin** (db.plotfarms.com/admin) and the
two-tier admin model — no new admin tool is built:

1. Create each employee's login (email + password) the same way textiles
   logins are created.
2. Grant each login the app **`survey`** with a role:
   `employee` (field engineers), `manager` (office), `owner` (app admin).
3. App-level user management afterwards lives at pa.plotfarms.com/admin
   via the same platform-admin pattern as the other apps.

## 9. Add uploads to the backup

Schema `survey` rides the existing Postgres backup automatically. Add
the uploads folder to the same backup run:

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
- [ ] A test visit: create a draft, fill a few answers, confirm it
      re-opens after signing out and back in (draft auto-save works).
- [ ] Submit the test visit, add the Part C wrap-up, confirm the status
      becomes `completed`.
- [ ] Upload one A10 photo; confirm it opens only while logged in.
- [ ] As a manager: dashboard counts include the test visit and the
      CSV export downloads with the Results Tracker columns.
- [ ] `docker logs pa-web` shows no errors; delete the test visit rows
      from `survey.visits` when the pilot is done checking.
