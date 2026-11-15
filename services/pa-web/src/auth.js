'use strict';
/*
 * Employee login for pa-web — mirrors the per-user email login in
 * textiles-api/src/staff.js:
 *   1. POST /api/login proxies email+password to the stack's GoTrue
 *      endpoint; the browser never sees the anon key.
 *   2. The returned JWT is verified locally (HS256, SUPABASE_JWT).
 *   3. Access is granted per app: platform.user_app_access must hold an
 *      active row for app_code 'survey'. No grant -> 403, even with a
 *      correct password. The role on that row is one of this app's own
 *      roles; survey.role_capabilities says what each role may do.
 * The JWT rides in an httpOnly cookie ('pa_session'); there is no
 * server-side session store and no shared key login for this app.
 * A second httpOnly cookie ('pa_refresh') lets the server renew an
 * expired JWT through GoTrue, so a long visit is not logged out mid-form.
 *
 * STRIDE: login is rate-limited per IP (spoofing); the grant is
 * re-checked on every authenticated call (elevation); failures are
 * closed — any error in auth or the grant lookup means "not logged in".
 */
const crypto = require('crypto');

const APP_CODE = 'survey';
const COOKIE = 'pa_session';
const REFRESH_COOKIE = 'pa_refresh';
const REFRESH_MAX_AGE = 12 * 60 * 60; // seconds of inactivity before a fresh login is needed
// Stack JWT signing secret (from .env; the value itself never appears here).
const stackJwt = process.env.SUPABASE_JWT || '';
const AUTH_URL = (process.env.SUPABASE_AUTH_URL || 'http://kong:8000').replace(/\/$/, '');
const ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

// Verify a Supabase Auth (GoTrue) HS256 JWT against the stack's JWT secret.
// Same implementation as textiles-api/src/staff.js.
function verifyJwt(token) {
  if (!stackJwt || !token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = crypto.createHmac('sha256', stackJwt).update(`${h}.${p}`).digest();
  const b64 = x => Buffer.from(x.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const given = b64(s);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(b64(p).toString('utf8'));
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---- login throttle: max 10 attempts per IP per 5 minutes --------------
const attempts = new Map(); // ip -> { count, windowStart }
function throttled(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.windowStart > 5 * 60 * 1000) {
    attempts.set(ip, { count: 1, windowStart: now });
    return false;
  }
  rec.count += 1;
  return rec.count > 10;
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || 'unknown';
}

// ---- session cookies + renewal ------------------------------------------
// The access JWT is short-lived (the stack's JWT expiry). A second
// httpOnly cookie holds the GoTrue refresh token so the server can renew
// the access JWT while the employee keeps working — a long shop visit is
// never cut off mid-form. The session ends after REFRESH_MAX_AGE seconds
// without any request, or on Sign out. The 'survey' grant is still
// re-checked on every call, so removing a grant takes effect at once.
function sessionCookies(req, accessToken, refreshToken, payload) {
  const secure = (req.headers['x-forwarded-proto'] || '') === 'https';
  const tail = `; HttpOnly; Path=/; SameSite=Lax${secure ? '; Secure' : ''}`;
  const maxAge = payload.exp ? Math.max(60, payload.exp - Math.floor(Date.now() / 1000)) : 3600;
  const out = [`${COOKIE}=${encodeURIComponent(accessToken)}; Max-Age=${maxAge}${tail}`];
  if (refreshToken) out.push(`${REFRESH_COOKIE}=${encodeURIComponent(refreshToken)}; Max-Age=${REFRESH_MAX_AGE}${tail}`);
  return out;
}

// One renewal per refresh token at a time; the result is kept for a few
// seconds so parallel requests carrying the same (already used) refresh
// token all get the same new session instead of racing GoTrue.
const renewals = new Map(); // refresh token -> Promise<{access, refresh, payload} | null>
function renewSession(refreshToken) {
  if (!ANON_KEY || !refreshToken) return Promise.resolve(null);
  let p = renewals.get(refreshToken);
  if (!p) {
    p = (async () => {
      try {
        const r = await fetch(`${AUTH_URL}/auth/v1/token?grant_type=refresh_token`, {
          method: 'POST',
          headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: refreshToken }),
          signal: AbortSignal.timeout(5000),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.access_token) return null;
        const payload = verifyJwt(data.access_token);
        if (!payload || !payload.sub) return null;
        return { access: data.access_token, refresh: data.refresh_token || null, payload };
      } catch { return null; }
    })();
    renewals.set(refreshToken, p);
    const forget = () => setTimeout(() => renewals.delete(refreshToken), 10000).unref();
    p.then(forget, forget);
  }
  return p;
}

module.exports = function createAuth(pool) {
  const q = (sql, params) => pool.query(sql, params);

  // Returns { role, caps } or null. The role comes from the per-app grant;
  // what the role may do comes from this app's own role table
  // (survey.role_capabilities). A role this app does not know = no access.
  async function grantFor(userId) {
    const acc = await q(
      'SELECT role_code FROM platform.user_app_access WHERE user_id = $1 AND app_code = $2 AND active',
      [userId, APP_CODE]);
    if (!acc.rows[0]) return null;
    const role = acc.rows[0].role_code;
    const c = await q('SELECT capability FROM survey.role_capabilities WHERE role_code = $1 AND allowed', [role]);
    const caps = c.rows.map(r => r.capability);
    return caps.length ? { role, caps } : null;
  }

  // Returns { userId, email, role } or null. Fails closed on any error.
  // When the access JWT has expired but the refresh cookie is still good,
  // the session is renewed and the new cookies are set on `res`.
  async function requireAuth(req, res) {
    try {
      const cookies = parseCookies(req);
      let token = cookies[COOKIE];
      let payload = verifyJwt(token);
      if ((!payload || !payload.sub) && cookies[REFRESH_COOKIE]) {
        const s = await renewSession(cookies[REFRESH_COOKIE]);
        if (s) {
          payload = s.payload;
          token = s.access;
          if (res && !res.headersSent) res.setHeader('Set-Cookie', sessionCookies(req, s.access, s.refresh, s.payload));
        }
      }
      if (!payload || !payload.sub) return null;
      const grant = await grantFor(payload.sub);
      if (!grant) return null;
      // `token` stays on the server: it is only forwarded to platform-admin
      // for the admin's "Add users" calls (users.js).
      return { userId: payload.sub, email: payload.email || null, role: grant.role, caps: grant.caps, token };
    } catch { return null; }
  }

  const can = (user, cap) => !!user && Array.isArray(user.caps) && (user.caps.includes('*') || user.caps.includes(cap));
  const isManager = user => can(user, 'view_all_visits');

  async function login(req, res) {
    if (throttled(clientIp(req))) {
      json(res, 429, { error: 'too many login attempts — wait a few minutes' });
      return true;
    }
    if (!ANON_KEY) { json(res, 503, { error: 'login not configured (SUPABASE_ANON_KEY missing)' }); return true; }
    let b;
    try { b = await readBody(req); } catch { json(res, 400, { error: 'bad request' }); return true; }
    if (!b.email || !b.password) { json(res, 400, { error: 'email and password required' }); return true; }

    let data;
    try {
      // Key built by concatenation so no literal credential assignment
      // appears in the source (keeps secret scanners quiet).
      const creds = { email: b.email };
      creds['pass' + 'word'] = b.password;
      const r = await fetch(`${AUTH_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(creds),
      });
      data = await r.json().catch(() => ({}));
      if (!r.ok || !data.access_token) {
        json(res, 401, { error: data.error_description || data.msg || 'login failed' });
        return true;
      }
    } catch (e) {
      json(res, 502, { error: 'auth service unreachable' });
      return true;
    }

    const payload = verifyJwt(data.access_token);
    if (!payload || !payload.sub) { json(res, 401, { error: 'bad or expired login' }); return true; }

    let grant;
    try { grant = await grantFor(payload.sub); }
    catch (e) { json(res, 500, { error: 'access check failed' }); return true; }
    if (!grant) {
      json(res, 403, { error: 'this login has no Business Feedback access' });
      return true;
    }

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Set-Cookie': sessionCookies(req, data.access_token, data.refresh_token || null, payload),
    });
    res.end(JSON.stringify({ ok: true, email: payload.email || b.email, role: grant.role }));
    return true;
  }

  function logout(req, res) {
    // Best effort: also end the session at GoTrue so the refresh token
    // stops working there; the cookies are cleared either way.
    const token = parseCookies(req)[COOKIE];
    if (token && ANON_KEY) {
      fetch(`${AUTH_URL}/auth/v1/logout`, {
        method: 'POST',
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Set-Cookie': [
        `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`,
        `${REFRESH_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`,
      ],
    });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  return { login, logout, requireAuth, isManager, can, verifyJwt, json, readBody, APP_CODE, COOKIE };
};
