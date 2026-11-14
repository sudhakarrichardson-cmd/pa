#!/usr/bin/env bash
# Static checks for the pa repo: JS syntax, no secrets in the tree,
# and the home-page link rules (no restaurant/matrimony/real-estate
# service links; Telegram must point at the official PA bot).
# Usage: bash scripts/verify.sh   (exit 0 = all good)
set -u
cd "$(dirname "$0")/.."
FAIL=0

echo "== node --check =="
for f in services/pa-web/src/*.js; do
  if node --check "$f" >/dev/null 2>&1; then echo "PASS  $f"; else echo "FAIL  $f"; FAIL=1; fi
done

echo "== secret scan (should find nothing) =="
# Real-looking credential material: long hex/base64 assigned to secret-ish
# names, private keys, or committed .env files. Placeholders in
# .env.example (empty values) are fine.
if find . -name '.env' -not -name '.env.example' | grep -q .; then
  echo "FAIL  a real .env file is present in the tree"; FAIL=1
fi
if grep -rnE "(PASSWORD|SECRET|TOKEN|_KEY)[\"']?\s*[:=]\s*[\"'][A-Za-z0-9+/=_-]{16,}[\"']" \
     --include='*.js' --include='*.json' --include='*.sql' --include='*.yml' \
     services database deploy 2>/dev/null | grep -v 'process.env' ; then
  echo "FAIL  possible hard-coded secret above"; FAIL=1
else
  echo "PASS  no hard-coded secrets"
fi
if grep -rn "BEGIN .*PRIVATE KEY" services database deploy docs 2>/dev/null; then
  echo "FAIL  private key material found"; FAIL=1
else
  echo "PASS  no private keys"
fi

echo "== home page rules =="
HOME=services/pa-web/src/home.html
if grep -qiE "matrimony|real ?estate|rk family dhaba" "$HOME"; then
  echo "FAIL  home.html contains a removed service (restaurant/matrimony/real-estate)"; FAIL=1
else
  echo "PASS  no restaurant/matrimony/real-estate links on home page"
fi
if grep -q "https://t.me/ypa25bot" "$HOME"; then
  echo "PASS  Telegram link points at https://t.me/ypa25bot"
else
  echo "FAIL  Telegram link to ypa25bot missing"; FAIL=1
fi
if grep -qiE "part_a|wizard|missed enquiries" "$HOME"; then
  echo "FAIL  home.html contains survey content"; FAIL=1
else
  echo "PASS  no survey content on the public home page"
fi

if [ "$FAIL" = 0 ]; then echo "VERIFY OK"; else echo "VERIFY FAILED"; fi
exit $FAIL
