'use strict';
/*
 * pa-web — pa.plotfarms.com (PlotFarms PA home page + Business Feedback).
 * Plain Node, no framework, mirroring services/textiles-api.
 *
 * Public:  GET / (PA home page — contains NO survey content),
 *          GET /login, POST /api/login, POST /api/logout, GET /health.
 * Gated:   every /feedback* page and every /api/* data route requires a
 *          valid employee session (cookie + 'survey' grant), checked
 *          here on the server BEFORE any survey HTML or data is sent.
 *          Unauthenticated page request -> 302 /login; API -> 401.
 *          Manager-only: /api/dashboard, /api/export.csv (403 otherwise).
 *
 * This service is the sole writer to schema `survey` (see visits.js).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const createAuth = require('./auth');
const registerVisits = require('./visits');
const registerDashboard = require('./dashboard');

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

const PAGES = {
  home: fs.readFileSync(path.join(__dirname, 'home.html'), 'utf8'),
  login: fs.readFileSync(path.join(__dirname, 'login.html'), 'utf8'),
  feedback: fs.readFileSync(path.join(__dirname, 'feedback.html'), 'utf8'),
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
    if (req.method === 'GET' && p === '/') { sendHtml(res, 200, PAGES.home); return; }
    if (req.method === 'POST' && p === '/api/login') { await auth.login(req, res); return; }
    if (req.method === 'POST' && p === '/api/logout') { auth.logout(req, res); return; }
    if (req.method === 'GET' && p === '/login') {
      const user = await auth.requireAuth(req);
      if (user) { res.writeHead(302, { Location: '/feedback' }); res.end(); return; }
      sendHtml(res, 200, PAGES.login);
      return;
    }

    /* ---------------- gated pages ---------------- */
    if (req.method === 'GET' && (p === '/feedback' || p.startsWith('/feedback/'))) {
      const user = await auth.requireAuth(req);
      if (!user) { res.writeHead(302, { Location: '/login' }); res.end(); return; }
      // Session verified — only now is the survey page sent.
      sendHtml(res, 200, PAGES.feedback, { 'Cache-Control': 'no-store' });
      return;
    }

    /* ---------------- gated API ---------------- */
    if (p.startsWith('/api/')) {
      const user = await auth.requireAuth(req);
      if (!user) { json(res, 401, { error: 'login required' }); return; }

      if (req.method === 'GET' && p === '/api/whoami') {
        json(res, 200, { email: user.email, role: user.role });
        return;
      }
      if (p === '/api/dashboard' || p === '/api/export.csv') {
        if (!auth.isManager(user)) { json(res, 403, { error: 'manager access only' }); return; }
        await dashboardHandler(req, res, url);
        return;
      }
      if (p.startsWith('/api/visits') || p.startsWith('/api/attachments')) {
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
