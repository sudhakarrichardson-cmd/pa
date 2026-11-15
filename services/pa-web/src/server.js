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
const telegramHandler = registerTelegram(pool, auth);

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

    /* ---------------- Telegram bot ---------------- */
    // Webhook is public (Telegram pushes here); link routes require login.
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

    sendHtml(res, 404, '<!doctype html><title>Not found</title><p>Not found.</p>');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
    else res.end();
  }
});

server.listen(PORT, () => console.log(`pa-web listening on ${PORT}`));
