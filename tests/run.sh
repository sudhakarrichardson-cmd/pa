#!/usr/bin/env bash
# Gate 5 starter checks for pa-web — no database or auth stack needed.
# The server is booted with dummy env pointing at unreachable DB/auth,
# and must fail CLOSED:
#   1. node --check passes on every src/*.js
#   2. GET /                 -> 200, and the public home page contains
#                               NO survey form markup
#   3. GET /survey           -> 302 to /login when logged out
#      GET /feedback         -> 301 to /survey (permanent redirect after rename)
#   4. GET /api/visits       -> 401 when logged out
#   5. POST /api/login       -> NOT 200 when auth/DB are unreachable
# Usage: bash tests/run.sh    (ends with ALL TESTS PASSED on success)
set -u
cd "$(dirname "$0")/.."
SRC=services/pa-web/src
PORT=18095
BASE="http://127.0.0.1:$PORT"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

echo "== 1. syntax =="
for f in "$SRC"/*.js; do
  if node --check "$f" >/dev/null 2>&1; then pass "node --check $f"; else fail "node --check $f"; fi
done

if [ ! -d services/pa-web/node_modules ]; then
  echo "== installing dependencies (first run) =="
  (cd services/pa-web && npm install --omit=dev --ignore-scripts >/dev/null 2>&1)
fi

echo "== 2-5. boot with dummy env =="
mkdir -p /tmp/pa-test-uploads
env PORT=$PORT \
    DB_HOST=127.0.0.1 DB_PORT=1 DB_NAME=postgres DB_USER=survey_app DB_PASSWORD=dummy \
    SUPABASE_AUTH_URL=http://127.0.0.1:1 SUPABASE_ANON_KEY=dummy SUPABASE_JWT=dummy-test-secret \
    UPLOAD_DIR=/tmp/pa-test-uploads \
    node "$SRC/server.js" >/tmp/pa-web-test.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT

UP=0
for i in $(seq 1 30); do
  if curl -s -o /dev/null --max-time 2 "$BASE/health" 2>/dev/null; then UP=1; break; fi
  sleep 0.5
done
if [ "$UP" != 1 ]; then
  fail "server did not start (see /tmp/pa-web-test.log)"
  echo "TESTS FAILED"; exit 1
fi
pass "server booted on $BASE"

# 2. home page is public and survey-free
HOME_BODY=$(curl -s --max-time 5 "$BASE/")
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/")
if [ "$CODE" = 200 ]; then pass "GET / = 200"; else fail "GET / = $CODE (want 200)"; fi
if echo "$HOME_BODY" | grep -qiE "part_a|data-scope|missed enquiries|Part B module"; then
  fail "GET / contains survey form markup"
else
  pass "GET / contains no survey form markup"
fi
if echo "$HOME_BODY" | grep -q "https://t.me/ypa25bot"; then
  pass "GET / links Telegram @ypa25bot"
else
  fail "GET / is missing the Telegram link"
fi

# 3. survey page is gated; /feedback redirects permanently to /survey
SV=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 5 "$BASE/survey")
case "$SV" in
  "302 "*"/login") pass "GET /survey logged out = 302 to /login" ;;
  *) fail "GET /survey logged out = $SV (want 302 to /login)" ;;
esac
FB=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 5 "$BASE/feedback")
case "$FB" in
  "301 "*"/survey") pass "GET /feedback = 301 to /survey (renamed)" ;;
  *) fail "GET /feedback = $FB (want 301 to /survey)" ;;
esac

# 4. API is gated
API=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/api/visits")
if [ "$API" = 401 ]; then pass "GET /api/visits logged out = 401"; else fail "GET /api/visits logged out = $API (want 401)"; fi
DASH=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/api/dashboard")
if [ "$DASH" = 401 ]; then pass "GET /api/dashboard logged out = 401"; else fail "GET /api/dashboard logged out = $DASH (want 401)"; fi

for path in /api/staff /api/offers /api/offers/1/pdf /api/org; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE$path")
  if [ "$CODE" = 401 ]; then pass "GET $path logged out = 401"; else fail "GET $path logged out = $CODE (want 401)"; fi
done
STAFF=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 5 "$BASE/staff")
case "$STAFF" in
  "302 "*"/login") pass "GET /staff logged out = 302 to /login" ;;
  *) fail "GET /staff logged out = $STAFF (want 302 to /login)" ;;
esac
if curl -s --max-time 5 "$BASE/" "$BASE/login" | grep -qiE "aadhaar|offer letter|monthly salary"; then
  fail "a public page contains Staff & HR markup"
else
  pass "public pages contain no Staff & HR markup"
fi

# 4b. messaging layer routes: registry API is gated; the gateway
# inbound fails closed (503) while PA_INBOUND_SECRET is not configured.
PAAPPS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/api/pa/apps")
if [ "$PAAPPS" = 401 ]; then pass "GET /api/pa/apps logged out = 401"; else fail "GET /api/pa/apps logged out = $PAAPPS (want 401)"; fi
INB=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST "$BASE/api/pa/inbound" \
  -H 'Content-Type: application/json' -d '{"channel":"whatsapp","user_ref":"100","text":"hi"}')
if [ "$INB" = 503 ]; then pass "POST /api/pa/inbound unconfigured = 503 (fails closed)"; else fail "POST /api/pa/inbound unconfigured = $INB (want 503)"; fi
RELAY=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST "$BASE/api/pa/relay/invoice" \
  -H 'Content-Type: application/json' -d '{"user_ref":"pa-user-1","invoice_no":"INV-001"}')
if [ "$RELAY" = 503 ]; then pass "POST /api/pa/relay/invoice unconfigured = 503 (fails closed)"; else fail "POST /api/pa/relay/invoice unconfigured = $RELAY (want 503)"; fi

# 5. login fails closed when auth/DB are unreachable
LOGIN=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "$BASE/api/login" \
  -H 'Content-Type: application/json' -d '{"email":"nobody@example.com","password":"wrong-password"}')
if [ "$LOGIN" != 200 ]; then pass "POST /api/login with unreachable auth = $LOGIN (not 200)"; else fail "POST /api/login returned 200 with unreachable auth"; fi

kill $SERVER_PID 2>/dev/null
trap - EXIT

if [ "$FAIL" = 0 ]; then echo "ALL TESTS PASSED"; else echo "TESTS FAILED"; fi
exit $FAIL
