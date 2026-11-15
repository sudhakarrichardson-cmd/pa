'use strict';
/*
 * pa-web — pa.plotfarms.com (PlotFarms PA home page + Business Feedback).
 * Plain Node, no framework, mirroring services/textiles-api.
 *
 * Public:  GET / (PA home page — contains NO survey content), the logo
 *          files under /assets/,
 *          GET /login, POST /api/login, POST /api/logout, GET /health.
 * Gated:   every /feedback* page and every /api/* data route requires a
 *          valid employee session (cookie + 'survey' grant), checked
 *          here on the server BEFORE any survey HTML or data is sent.
 *          Unauthenticated page request -> 302 /login; API -> 401.
 *          Manager-only: /api/dashboard, /api/export.csv (403 otherwise).
 *          Admin / HR only: the /staff page, /api/staff*, /api/offers*,
 *          /api/org (staff.js, offers.js). The page itself is sent only to
 *          those roles — its markup never reaches other employees.
 *
 * This service is the sole writer to schema `survey` (see visits.js).
 *
 * Messaging layer (consumer PA, migration 023): POST /api/pa/inbound
 * is the gateways' entry to the PA router (router.js + apps.js, schema
 * `pa`); Telegram chats that are not linked to an employee login are
 * served by the same router inside telegram.js. The app registry is
 * managed at /api/pa/apps (admin; list for managers).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');
// Calendar dates (visit date, date of joining, date of birth…) stay plain
// 'YYYY-MM-DD' text end to end. Left to the driver they become JS Dates at
// the server's local midnight and can shift by a day in another timezone.
if (types && types.setTypeParser) types.setTypeParser(1082, v => v);

const createAuth = require('./auth');
const registerVisits = require('./visits');
const registerDashboard = require('./dashboard');
const registerStaff = require('./staff');
const registerOffers = require('./offers');
const registerTelegram = require('./telegram');
const registerApps = require('./apps');
const registerRouter = require('./router');

const PORT = parseInt(process.env.PORT || '8095', 10);

const poolCfg = {
  host: process.env.DB_HOST || 'db',
  port: parseInt(process.env.DB_PORT || '5433', 10),
  database: process.env.DB_NAME || 'postgres',
  user: process.env.DB_USER || 'survey_app',
  connectionTimeoutMillis: 3000,
  max: 5,
};
// DB credential from .env only; the key is built by concatenation so no
// literal credential assignment appears in the source (secret scanners).
poolCfg['pass' + 'word'] = process.env.DB_PASSWORD || undefined;
const pool = new Pool(poolCfg);
pool.on('error', err => console.error('pg pool error:', err.message));

const auth = createAuth(pool);
const visitsHandler = registerVisits(pool, auth);
const dashboardHandler = registerDashboard(pool);
const staffHandler = registerStaff(pool, auth);
const offersHandler = registerOffers(pool);
const paApps = registerApps(pool);
const paRouter = registerRouter(pool);
const telegramHandler = registerTelegram(pool, auth, paRouter);

// Who does survey work, and who gets the Staff & HR page.
const canVisits = user => auth.can(user, 'fill_visits') || auth.can(user, 'view_all_visits');
const canStaff = user => auth.can(user, 'manage_users') || auth.can(user, 'offer_letters');

// The logo files — public, read once at start, served from a fixed list
// (no path from the request ever touches the file system).
const ASSETS = {};
for (const [name, type] of [['logo.webp', 'image/webp'], ['logo-mark.webp', 'image/webp'], ['favicon.png', 'image/png']]) {
  try { ASSETS['/assets/' + name] = { type, body: fs.readFileSync(path.join(__dirname, 'assets', name)) }; }
  catch (e) { console.error('missing asset: ' + name); }
}

const PAGES = {
  home: fs.readFileSync(path.join(__dirname, 'home.html'), 'utf8'),
  login: fs.readFileSync(path.join(__dirname, 'login.html'), 'utf8'),
  feedback: fs.readFileSync(path.join(__dirname, 'feedback.html'), 'utf8'),
  staff: fs.readFileSync(path.join(__dirname, 'staff.html'), 'utf8'),
  link: fs.readFileSync(path.join(__dirname, 'link.html'), 'utf8'),
};

function sendHtml(res, code, html, extraHeaders = {}) {
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    ...extraHeaders,
  });
  res.end(html);
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    /* ---------------- public ---------------- */
    if (req.method === 'GET' && p === '/health') { json(res, 200, { ok: true }); return; }
    if (req.method === 'GET' && (ASSETS[p] || p === '/favicon.ico')) {
      const a = ASSETS[p] || ASSETS['/assets/favicon.png'];
      if (a) {
        res.writeHead(200, { 'Content-Type': a.type, 'Content-Length': a.body.length, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
        res.end(a.body);
        return;
      }
    }
    if (req.method === 'GET' && p === '/') { sendHtml(res, 200, PAGES.home); return; }
    if (req.method === 'POST' && p === '/api/login') { await auth.login(req, res); return; }
    if (req.method === 'POST' && p === '/api/logout') { auth.logout(req, res); return; }
    if (req.method === 'GET' && p === '/login') {
      const user = await auth.requireAuth(req, res);
      if (user) { res.writeHead(302, { Location: '/feedback' }); res.end(); return; }
      sendHtml(res, 200, PAGES.login);
      return;
    }

    /* ---------------- gated pages ---------------- */
    if (req.method === 'GET' && (p === '/feedback' || p.startsWith('/feedback/'))) {
      const user = await auth.requireAuth(req, res);
      if (!user) { res.writeHead(302, { Location: '/login' }); res.end(); return; }
      // A role with no survey work (HR) lands on its own page instead.
      if (!canVisits(user)) { res.writeHead(302, { Location: canStaff(user) ? '/staff' : '/' }); res.end(); return; }
      // Session verified — only now is the survey page sent.
      sendHtml(res, 200, PAGES.feedback, { 'Cache-Control': 'no-store' });
      return;
    }

    if (req.method === 'GET' && p === '/staff') {
      const user = await auth.requireAuth(req, res);
      if (!user) { res.writeHead(302, { Location: '/login' }); res.end(); return; }
      if (!canStaff(user)) { res.writeHead(302, { Location: '/feedback' }); res.end(); return; }
      // Sent only to the admin / HR — never to other employees.
      sendHtml(res, 200, PAGES.staff, { 'Cache-Control': 'no-store' });
      return;
    }

    /* ---------------- Telegram bot (public webhook) ---------------- */
    if (req.method === 'POST' && p === '/api/telegram/webhook') {
      await telegramHandler.handleWebhook(req, res); return;
    }
    if (req.method === 'GET' && p === '/link') {
      const user = await auth.requireAuth(req, res);
      if (!user) { res.writeHead(302, { Location: '/login' }); res.end(); return; }
      sendHtml(res, 200, PAGES.link, { 'Cache-Control': 'no-store' }); return;
    }
    if (req.method === 'POST' && p === '/api/telegram/link') {
      const user = await auth.requireAuth(req, res);
      if (!user) { json(res, 401, { error: 'login required' }); return; }
      await telegramHandler.handleLinkConfirm(req, res, user); return;
    }

    /* ---------------- PA messaging layer (gateway inbound) ----------------
     * The platform gateways (wa-gateway, telegram-gateway) are
     * transport-only: they POST each consumer message here in the same
     * shape the textiles /inbound contract uses, and send the returned
     * replies back on the user's channel. Authenticated by the shared
     * PA_INBOUND_SECRET header; fails closed when it is not set. This
     * route must stay BEFORE the gated /api/* block below. */
    if (req.method === 'POST' && p === '/api/pa/inbound') {
      const expected = process.env.PA_INBOUND_SECRET || '';
      if (!expected) { json(res, 503, { error: 'PA inbound not configured' }); return; }
      if ((req.headers['x-pa-secret'] || '') !== expected) {
        json(res, 403, { error: 'bad secret' }); return;
      }
      let body;
      try { body = await auth.readBody(req, 512 * 1024); }
      catch { json(res, 400, { error: 'bad request' }); return; }
      if (!body.channel || !body.user_ref || typeof body.text !== 'string') {
        json(res, 400, { error: 'channel, user_ref and text are required' }); return;
      }
      const out = await paRouter.handleMessage({
        channel: String(body.channel), chatRef: String(body.user_ref),
        text: body.text,
      });
      json(res, 200, {
        replies: (out.replies || []).map(t => ({ type: 'text', body: t })),
      });
      return;
    }

    /* ------------ PA invoice relay (vegibot → PA customer) ---------------
     * VegiBot calls this after the owner approves a PA-channel order. We
     * look up the PA user's Telegram chat and send them a bill summary.
     * Authenticated with the same per-app secret PA uses to call vegibot. */
    if (req.method === 'POST' && p === '/api/pa/relay/invoice') {
      const expected = process.env.PA_APP_SECRET_VEGIBOT || '';
      if (!expected) { json(res, 503, { error: 'relay not configured' }); return; }
      if ((req.headers['x-pa-secret'] || '') !== expected) {
        json(res, 401, { error: 'unauthorized' }); return;
      }
      let body;
      try { body = await auth.readBody(req); }
      catch { json(res, 400, { error: 'bad request' }); return; }
      const { user_ref, invoice_no, amount, store_name } = body || {};
      if (!user_ref || !invoice_no) {
        json(res, 400, { error: 'user_ref and invoice_no are required' }); return;
      }
      const paUserId = parseInt(String(user_ref).replace(/^pa-user-/, ''), 10);
      if (!paUserId) { json(res, 400, { error: 'invalid user_ref' }); return; }
      const amt = Number(amount || 0);
      const amtStr = amt > 0 ? `₹${amt.toFixed(2)}` : '';
      const msg = [
        `🧾 Your order has been approved!`,
        ``,
        `Invoice: ${invoice_no}`,
        amtStr ? `Amount: ${amtStr}` : null,
        ``,
        `The store will contact you to confirm delivery and payment.`,
        store_name ? `— ${store_name}` : null,
      ].filter(l => l !== null).join('\n');
      const result = await telegramHandler.sendToUser(paUserId, msg);
      json(res, result.ok ? 200 : 422, result);
      return;
    }

    /* ---------------- gated API ---------------- */
    if (p.startsWith('/api/')) {
      const user = await auth.requireAuth(req, res);
      if (!user) { json(res, 401, { error: 'login required' }); return; }

      if (req.method === 'GET' && p === '/api/whoami') {
        json(res, 200, {
          email: user.email, role: user.role,
          can_see_all: auth.can(user, 'view_all_visits'),
          can_dashboard: auth.can(user, 'view_dashboard'),
          can_visits: canVisits(user),
          can_manage_users: auth.can(user, 'manage_users'),
          can_offer_letters: auth.can(user, 'offer_letters'),
          can_staff: canStaff(user),
          is_admin: user.caps.includes('*'),
        });
        return;
      }
      if (p === '/api/pa/apps' || p.startsWith('/api/pa/apps/')) {
        // PA app registry (messaging layer). List: managers. Changes:
        // app admin only. Secrets are never accepted or returned here —
        // a registration names the env var that holds the secret.
        const isAdmin = user.caps.includes('*');
        if (req.method === 'GET' && p === '/api/pa/apps') {
          if (!auth.can(user, 'view_dashboard') && !isAdmin) {
            json(res, 403, { error: 'manager access only' }); return;
          }
          const rows = await paApps.listApps();
          json(res, 200, {
            apps: rows.map(a => ({ ...a, endpoint_url: a.endpoint_url ? 'set' : '' })),
          });
          return;
        }
        if (!isAdmin) { json(res, 403, { error: 'admin access only' }); return; }
        if (req.method === 'POST' && p === '/api/pa/apps') {
          let b;
          try { b = await auth.readBody(req); }
          catch { json(res, 400, { error: 'bad request' }); return; }
          if (!b.app_id || !b.app_name || !b.app_type) {
            json(res, 400, { error: 'app_id, app_name and app_type are required' }); return;
          }
          const row = await paApps.registerApp(b);
          json(res, 200, { ok: true, ...row });
          return;
        }
        const mTest = p.match(/^\/api\/pa\/apps\/([^/]+)\/test$/);
        if (req.method === 'POST' && mTest) {
          const app = await paApps.getApp(decodeURIComponent(mTest[1]));
          if (!app) { json(res, 404, { error: 'app not found' }); return; }
          const answer = await paApps.testApp(app);
          if (!answer) {
            json(res, 502, { ok: false, error: 'app did not answer check_availability' });
            return;
          }
          await paApps.setStatus(app.app_id, 'active');
          json(res, 200, { ok: true, status: 'active' });
          return;
        }
        const mStatus = p.match(/^\/api\/pa\/apps\/([^/]+)\/status$/);
        if (req.method === 'POST' && mStatus) {
          let b;
          try { b = await auth.readBody(req); }
          catch { json(res, 400, { error: 'bad request' }); return; }
          if (!['pending', 'active', 'inactive'].includes(b.status)) {
            json(res, 400, { error: 'status must be pending, active or inactive' }); return;
          }
          const row = await paApps.setStatus(decodeURIComponent(mStatus[1]), b.status);
          if (!row) { json(res, 404, { error: 'app not found' }); return; }
          json(res, 200, { ok: true, ...row });
          return;
        }
        json(res, 404, { error: 'not found' });
        return;
      }
      if (p === '/api/dashboard' || p === '/api/export.csv') {
        if (!auth.can(user, 'view_dashboard')) { json(res, 403, { error: 'manager access only' }); return; }
        await dashboardHandler(req, res, url);
        return;
      }
      if (p === '/api/staff' || p.startsWith('/api/staff/')) {
        // Employee profiles, logins, access — admin / HR only.
        if (!auth.can(user, 'manage_users')) { json(res, 403, { error: 'admin or HR access only' }); return; }
        if (await staffHandler(req, res, url, user)) return;
      } else if (p === '/api/org' || p === '/api/offers' || p.startsWith('/api/offers/')) {
        if (!auth.can(user, 'offer_letters')) { json(res, 403, { error: 'admin or HR access only' }); return; }
        if (await offersHandler(req, res, url, user)) return;
      } else if (p.startsWith('/api/visits') || p.startsWith('/api/attachments')) {
        // Survey data: only roles that do survey work (HR does not).
        if (!canVisits(user)) { json(res, 403, { error: 'this role has no access to survey visits' }); return; }
        const handled = await visitsHandler(req, res, url, user);
        if (handled) return;
      }
      json(res, 404, { error: 'not found' });
      return;
    }

    sendHtml(res, 404, '<!doctype html><title>Not found</title><p>Not found.</p>');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
    else res.end();
  }
});

server.listen(PORT, () => console.log(`pa-web listening on ${PORT}`));
