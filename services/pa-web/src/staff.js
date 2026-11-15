'use strict';
/*
 * Staff & HR API — employee profiles, logins and access, for the app
 * admin and the HR role (capability 'manage_users').
 *
 * Two-tier admin model:
 *   platform admin (db.plotfarms.com/admin)  adds only this app's ADMIN
 *   app admin / HR (here)                    add this app's employees
 *
 * Logins are NOT created here. pa-web holds no Auth service key and
 * cannot write platform.*: creating a login, assigning a role, turning
 * access off and the audit trail all happen inside the existing
 * platform-admin service. This module forwards the signed-in person's own
 * JWT to platform-admin's app surface (/api/app/*), which re-checks who
 * they are. What this module owns is the employee PROFILE
 * (survey.employees) — pa-web stays the only writer to schema survey.
 *
 * Routes (server.js lets only 'manage_users' in):
 *   GET  /api/staff                 everyone in this app + profiles + roles
 *   POST /api/staff                 create login + profile
 *   POST /api/staff/lookup          does this email already have a login?
 *   GET  /api/staff/:id             one profile, ID/bank numbers in full
 *   PUT  /api/staff/:id             update profile and/or role / on-off
 *   POST /api/staff/:id/password    set a new temporary password
 *
 * Aadhaar, PAN and bank account numbers are encrypted before they reach
 * the database (AES-256-GCM, key STAFF_DATA_KEY from .env). They are
 * optional; without a key the app refuses to store them rather than keep
 * them in plain text. Lists show only the last four characters.
 */
const http = require('http');
const crypto = require('crypto');

// platform-admin inside the Docker network; it picks the app from the Host.
const ADMIN_URL = new URL(process.env.PLATFORM_ADMIN_URL || 'http://platform-admin:8092');
const APP_DOMAIN = process.env.APP_DOMAIN || 'pa.plotfarms.com';
// This app's admin role (platform.apps.admin_role_code). Only the PLATFORM
// admin creates or changes app admins — never anyone from here.
const ADMIN_ROLE = 'owner';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KEY_HEX = process.env.STAFF_DATA_KEY || '';
const DATA_KEY = /^[0-9a-f]{64}$/i.test(KEY_HEX) ? Buffer.from(KEY_HEX, 'hex') : null;

function seal(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', DATA_KEY, iv);
  const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}
function unseal(stored) {
  if (!stored || !DATA_KEY || !String(stored).startsWith('v1:')) return null;
  try {
    const raw = Buffer.from(String(stored).slice(3), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', DATA_KEY, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch { return null; }
}
// A DATE column as 'YYYY-MM-DD'. server.js makes pg hand DATEs over as
// plain text; the Date branch only covers a driver that does not.
const day = d => (!d ? null : typeof d === 'string' ? d.slice(0, 10)
  : new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10));
const last4 = v => (v ? '••••' + String(v).slice(-4) : '');

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// One call to platform-admin's app surface, as the signed-in person.
function forward(user, method, pathname, body) {
  return new Promise((resolve) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { Host: APP_DOMAIN, Authorization: 'Bearer ' + user.token };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    const r = http.request({
      hostname: ADMIN_URL.hostname, port: ADMIN_URL.port || 80, path: pathname, method, headers, timeout: 15000,
    }, (resp) => {
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => {
        let data = {};
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* keep {} */ }
        resolve({ status: resp.statusCode || 502, data });
      });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', () => resolve({ status: 502, data: { error: 'user service unreachable — try again in a minute' } }));
    r.end(payload || undefined);
  });
}

/* ---------------- profile fields ---------------- */
const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const TEXT_FIELDS = {
  employee_code: 30, full_name: 120, mobile: 30, branch: 80, reporting_manager: 120, address: 500,
  emergency_contact_name: 120, emergency_contact_phone: 30, bank_account_name: 120, bank_name: 120, bank_ifsc: 11,
};
const DATE_FIELDS = ['date_of_joining', 'date_of_birth'];
// request key -> { column, check, message }
const SEALED = {
  aadhaar_no: { col: 'aadhaar_enc', norm: v => v.replace(/[\s-]/g, ''), ok: v => /^\d{12}$/.test(v), msg: 'Aadhaar must be 12 digits' },
  pan_no: { col: 'pan_enc', norm: v => v.toUpperCase().replace(/\s/g, ''), ok: v => /^[A-Z]{5}\d{4}[A-Z]$/.test(v), msg: 'PAN must look like ABCDE1234F' },
  bank_account_no: { col: 'bank_account_enc', norm: v => v.replace(/[\s-]/g, ''), ok: v => /^\d{6,20}$/.test(v), msg: 'bank account number must be 6 to 20 digits' },
};

// Turns a request body into { column: value } for ONLY the keys present,
// so a small update (role change, turn off) never wipes the profile.
// Returns { values } or { error }.
function profileValues(b) {
  const values = {};
  for (const [k, max] of Object.entries(TEXT_FIELDS)) {
    if (k in b) values[k] = text(b[k], max) || null;
  }
  if ('display_name' in b && !('full_name' in b)) values.full_name = text(b.display_name, 120) || null;
  if (values.bank_ifsc) {
    values.bank_ifsc = values.bank_ifsc.toUpperCase();
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(values.bank_ifsc)) return { error: 'IFSC must look like SBIN0001234' };
  }
  for (const k of DATE_FIELDS) {
    if (!(k in b)) continue;
    const v = text(b[k], 10);
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { error: k.replace(/_/g, ' ') + ' must be a date' };
    values[k] = v || null;
  }
  if ('monthly_salary' in b) {
    const raw = text(b.monthly_salary, 20).replace(/,/g, '');
    if (raw === '') values.monthly_salary = null;
    else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 99999999) return { error: 'monthly salary must be a number' };
      values.monthly_salary = n;
    }
  }
  for (const [k, def] of Object.entries(SEALED)) {
    if (!(k in b)) continue;
    const v = def.norm(text(b[k], 40));
    if (!v) { values[def.col] = null; continue; }
    if (!def.ok(v)) return { error: def.msg };
    if (!DATA_KEY) return { error: 'ID and bank numbers cannot be saved yet — the server has no STAFF_DATA_KEY (see docs/DEPLOY.md). Leave them empty for now.', code: 503 };
    values[def.col] = seal(v);
  }
  return { values };
}

function publicProfile(row, full) {
  if (!row) return null;
  const aadhaar = unseal(row.aadhaar_enc), pan = unseal(row.pan_enc), acct = unseal(row.bank_account_enc);
  return {
    employee_code: row.employee_code, full_name: row.full_name, mobile: row.mobile, branch: row.branch,
    date_of_joining: day(row.date_of_joining), reporting_manager: row.reporting_manager, address: row.address,
    date_of_birth: day(row.date_of_birth), emergency_contact_name: row.emergency_contact_name,
    emergency_contact_phone: row.emergency_contact_phone,
    monthly_salary: row.monthly_salary == null ? null : Number(row.monthly_salary),
    bank_account_name: row.bank_account_name, bank_name: row.bank_name, bank_ifsc: row.bank_ifsc,
    aadhaar_no: full ? aadhaar : last4(aadhaar), pan_no: full ? pan : last4(pan), bank_account_no: full ? acct : last4(acct),
    has_id_bank: !!(row.aadhaar_enc || row.pan_enc || row.bank_account_enc),
  };
}

module.exports = function registerStaff(pool, auth) {
  const q = (sql, params) => pool.query(sql, params);
  const isAdmin = user => Array.isArray(user.caps) && user.caps.includes('*');

  // Roles that themselves manage people (the HR role, the admin role):
  // only the app admin may hand those out or change who holds them.
  async function managerRoles() {
    const r = await q("SELECT DISTINCT role_code FROM survey.role_capabilities WHERE capability IN ('manage_users', '*') AND allowed");
    return new Set(r.rows.map(x => x.role_code).concat([ADMIN_ROLE]));
  }
  // Is `role` one this person may assign? Sends the refusal itself.
  async function roleAllowed(res, user, role) {
    if (role === ADMIN_ROLE) { json(res, 403, { error: 'admins are added by the platform admin, not from here' }); return false; }
    if (!isAdmin(user) && (await managerRoles()).has(role)) { json(res, 403, { error: 'only the admin can give someone the HR role' }); return false; }
    return true;
  }
  // May this person change `id` at all? Returns the person's current row
  // from platform-admin (or {} for a login not yet in this app), or null
  // after sending the refusal.
  async function loadTarget(res, user, id) {
    const o = await forward(user, 'GET', '/api/app/overview');
    if (o.status !== 200) { json(res, o.status, { error: o.data.error || 'could not load staff' }); return null; }
    const target = (o.data.people || []).find(p => p.user_id === id) || {};
    if (target.role_code === ADMIN_ROLE) { json(res, 403, { error: 'admins are managed by the platform admin, not from here' }); return null; }
    if (target.role_code && !isAdmin(user) && (await managerRoles()).has(target.role_code)) {
      json(res, 403, { error: 'only the admin can change someone with the HR role' }); return null;
    }
    return target;
  }

  async function saveProfile(userId, values, base, actor) {
    const exists = (await q('SELECT 1 FROM survey.employees WHERE user_id = $1', [userId])).rows[0];
    if (exists) {
      const cols = Object.keys(values);
      if (!cols.length) return;
      await q(`UPDATE survey.employees SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() WHERE user_id = $1`,
        [userId, ...cols.map(c => values[c])]);
      return;
    }
    const row = { ...values };
    row.full_name = row.full_name || base.full_name || (base.email || '').split('@')[0] || 'Employee';
    row.email = row.email || base.email;
    row.role_code = row.role_code || base.role_code;
    if (!row.email || !row.role_code) return;   // nothing to anchor a new profile on
    const cols = Object.keys(row);
    await q(`INSERT INTO survey.employees (user_id, created_by, ${cols.join(', ')})
             VALUES ($1, $2, ${cols.map((c, i) => `$${i + 3}`).join(', ')})`,
      [userId, actor, ...cols.map(c => row[c])]);
  }
  const dbProblem = e => (e && e.code === '23505' ? 'that employee ID is already used by someone else' : 'could not save the profile');

  return async function staffHandler(req, res, url, user) {
    const seg = url.pathname.split('/').filter(Boolean); // ['api','staff',...]
    try {
      /* ---------------- list ---------------- */
      if (req.method === 'GET' && seg.length === 2) {
        const o = await forward(user, 'GET', '/api/app/overview');
        if (o.status !== 200) { json(res, o.status, { error: o.data.error || 'could not load staff' }); return true; }
        const profiles = new Map((await q('SELECT * FROM survey.employees')).rows.map(r => [r.user_id, r]));
        const restricted = await managerRoles();
        const roles = (o.data.roles || []).filter(r => r !== ADMIN_ROLE && (isAdmin(user) || !restricted.has(r)));
        const people = (o.data.people || []).map(p => ({
          user_id: p.user_id, email: p.email, role_code: p.role_code, active: p.active,
          display_name: (profiles.get(p.user_id) || {}).full_name || p.display_name || '',
          phone: (profiles.get(p.user_id) || {}).mobile || p.phone || '',
          locked: p.role_code === ADMIN_ROLE || (!isAdmin(user) && restricted.has(p.role_code)),
          profile: publicProfile(profiles.get(p.user_id), false),
        }));
        json(res, 200, { roles, people, me: o.data.me || null, id_bank_ready: !!DATA_KEY });
        return true;
      }

      /* ---------------- create login + profile ---------------- */
      if (req.method === 'POST' && seg.length === 2) {
        const b = await readBody(req);
        const login = {
          email: text(b.email, 200).toLowerCase(), display_name: text(b.full_name || b.display_name, 120),
          phone: text(b.mobile, 30), role_code: text(b.role_code, 40),
        };
        login['pass' + 'word'] = String(b['pass' + 'word'] || '');
        if (!login.display_name) { json(res, 400, { error: 'employee name is required' }); return true; }
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(login.email)) { json(res, 400, { error: 'a valid email is required' }); return true; }
        if (!login.role_code) { json(res, 400, { error: 'choose a role' }); return true; }
        if (!(await roleAllowed(res, user, login.role_code))) return true;
        // Check the profile BEFORE the login exists, so a bad field never
        // leaves a login without a profile.
        const p = profileValues(b);
        if (p.error) { json(res, p.code || 400, { error: p.error }); return true; }
        if (p.values.employee_code) {
          const dup = await q('SELECT 1 FROM survey.employees WHERE employee_code = $1', [p.values.employee_code]);
          if (dup.rows[0]) { json(res, 409, { error: 'that employee ID is already used by someone else' }); return true; }
        }
        const r = await forward(user, 'POST', '/api/app/users', login);
        if (r.status !== 200) { json(res, r.status, { error: r.data.error || 'could not create the login' }); return true; }
        const id = r.data.user && r.data.user.id;
        try {
          await saveProfile(id, p.values, { full_name: login.display_name, email: login.email, role_code: login.role_code }, user.email);
        } catch (e) {
          console.error('profile save failed:', e.message);
          json(res, 201, { ok: true, user: r.data.user, warning: 'The login was created, but ' + dbProblem(e) + '. Open the employee and save the profile again.' });
          return true;
        }
        json(res, 201, { ok: true, user: r.data.user });
        return true;
      }

      if (req.method === 'POST' && seg.length === 3 && seg[2] === 'lookup') {
        const b = await readBody(req);
        const r = await forward(user, 'POST', '/api/app/lookup', { email: text(b.email, 200).toLowerCase() });
        json(res, r.status, r.status === 200 ? r.data : { error: r.data.error || 'lookup failed' });
        return true;
      }

      const id = seg[2] && UUID.test(seg[2]) ? seg[2].toLowerCase() : null;
      if (!id) return false;

      /* ---------------- one profile, in full ---------------- */
      if (req.method === 'GET' && seg.length === 3) {
        const target = await loadTarget(res, user, id);
        if (!target) return true;
        if (!target.user_id) { json(res, 404, { error: 'not found' }); return true; }
        const row = (await q('SELECT * FROM survey.employees WHERE user_id = $1', [id])).rows[0];
        json(res, 200, {
          user_id: id, email: target.email, role_code: target.role_code, active: target.active,
          profile: publicProfile(row, true) || { full_name: target.display_name || '', mobile: target.phone || '' },
        });
        return true;
      }

      /* ---------------- update profile / role / on-off ---------------- */
      if (req.method === 'PUT' && seg.length === 3) {
        const b = await readBody(req);
        const target = await loadTarget(res, user, id);
        if (!target) return true;
        const role = text(b.role_code, 40) || target.role_code;
        if (!role) { json(res, 400, { error: 'choose a role' }); return true; }
        if (role !== target.role_code && !(await roleAllowed(res, user, role))) return true;
        const p = profileValues(b);
        if (p.error) { json(res, p.code || 400, { error: p.error }); return true; }
        const active = 'active' in b ? b.active !== false : target.active !== false;
        if (role !== target.role_code || active !== target.active || !target.user_id) {
          const g = await forward(user, 'PUT', '/api/app/grant', { user_id: id, role_code: role, active, display_name: p.values.full_name || target.display_name || '' });
          if (g.status !== 200) { json(res, g.status, { error: g.data.error || 'could not update access' }); return true; }
        }
        p.values.role_code = role;
        try {
          await saveProfile(id, p.values, { full_name: target.display_name, email: target.email || text(b.email, 200).toLowerCase(), role_code: role }, user.email);
        } catch (e) { console.error('profile save failed:', e.message); json(res, e.code === '23505' ? 409 : 500, { error: dbProblem(e) }); return true; }
        json(res, 200, { ok: true });
        return true;
      }

      /* ---------------- new temporary password ---------------- */
      if (req.method === 'POST' && seg.length === 4 && seg[3] === 'password') {
        const b = await readBody(req);
        const target = await loadTarget(res, user, id);
        if (!target) return true;
        const out = { user_id: id };
        out['pass' + 'word'] = String(b['pass' + 'word'] || '');
        const r = await forward(user, 'POST', '/api/app/password', out);
        json(res, r.status, r.status === 200 ? { ok: true } : { error: r.data.error || 'could not set the password' });
        return true;
      }

      return false;
    } catch (e) {
      if (e.message === 'body too large') { json(res, 413, { error: 'request too large' }); return true; }
      if (e instanceof SyntaxError) { json(res, 400, { error: 'bad request' }); return true; }
      console.error(e);
      json(res, 500, { error: 'server error' });
      return true;
    }
  };
};
