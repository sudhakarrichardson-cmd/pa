'use strict';
/*
 * Issue reports — employees submit bugs / problems; admin reviews and
 * triggers AI analysis via the Anthropic API (native https, no extra deps).
 *
 * Routes (all behind the server.js session gate):
 *   POST /api/issues                    submit (any authenticated employee)
 *   GET  /api/issues                    list   (admin only)
 *   GET  /api/issues/:id                one    (admin only)
 *   POST /api/issues/:id/analyze        AI analysis (admin only)
 *   POST /api/issues/:id/resolve        mark resolved (admin only)
 */
const https = require('https');

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

function callClaude(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) return Promise.reject(new Error('ANTHROPIC_API_KEY not configured'));

  const body = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (data.content && data.content[0] && data.content[0].text) {
            resolve(data.content[0].text);
          } else {
            reject(new Error('unexpected Claude response: ' + JSON.stringify(data).slice(0, 200)));
          }
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = function registerIssues(pool, auth) {
  const q = (sql, params) => pool.query(sql, params);
  const isAdmin = user => user.caps.includes('*');

  return async function issuesHandler(req, res, url, user) {
    const seg = url.pathname.split('/').filter(Boolean); // ['api','issues',...]

    /* POST /api/issues — any authenticated employee */
    if (req.method === 'POST' && seg.length === 2) {
      let b;
      try { b = await readBody(req); }
      catch { json(res, 400, { error: 'bad request' }); return true; }

      const title = String(b.title || '').trim().slice(0, 200);
      const description = String(b.description || '').trim().slice(0, 4000);
      const steps = String(b.steps || '').trim().slice(0, 2000) || null;
      const severity = ['low', 'medium', 'high', 'critical'].includes(b.severity) ? b.severity : 'medium';
      const area = String(b.area || '').trim().slice(0, 200) || null;
      const user_agent = String(b.user_agent || '').trim().slice(0, 500) || null;

      if (!title || !description) {
        json(res, 400, { error: 'title and description are required' }); return true;
      }

      const r = await q(
        `INSERT INTO survey.issues (title, description, steps, severity, area, user_agent, submitted_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at`,
        [title, description, steps, severity, area, user_agent, user.email]
      );
      json(res, 200, { ok: true, id: r.rows[0].id, created_at: r.rows[0].created_at });
      return true;
    }

    /* Admin-only routes */
    if (!isAdmin(user)) { json(res, 403, { error: 'admin access only' }); return true; }

    /* GET /api/issues — list */
    if (req.method === 'GET' && seg.length === 2) {
      const r = await q(
        `SELECT id, title, severity, status, submitted_by, created_at, analyzed_at, area,
                analysis->>'summary' AS analysis_summary
           FROM survey.issues ORDER BY created_at DESC`
      );
      json(res, 200, { issues: r.rows });
      return true;
    }

    /* GET /api/issues/:id — one issue */
    if (req.method === 'GET' && seg.length === 3) {
      const id = parseInt(seg[2], 10);
      if (!id) { json(res, 400, { error: 'invalid id' }); return true; }
      const r = await q(`SELECT * FROM survey.issues WHERE id = $1`, [id]);
      if (!r.rows[0]) { json(res, 404, { error: 'not found' }); return true; }
      json(res, 200, r.rows[0]);
      return true;
    }

    /* POST /api/issues/:id/analyze — AI analysis */
    if (req.method === 'POST' && seg.length === 4 && seg[3] === 'analyze') {
      const id = parseInt(seg[2], 10);
      if (!id) { json(res, 400, { error: 'invalid id' }); return true; }
      const r = await q(`SELECT * FROM survey.issues WHERE id = $1`, [id]);
      const issue = r.rows[0];
      if (!issue) { json(res, 404, { error: 'not found' }); return true; }

      const prompt = `You are a code-review assistant for the PlotFarms PA web application (pa.plotfarms.com).

An employee has reported the following issue:

Title: ${issue.title}
Severity: ${issue.severity}
Area: ${issue.area || 'not specified'}
Reported by: ${issue.submitted_by}

Description:
${issue.description}
${issue.steps ? '\nSteps to reproduce:\n' + issue.steps : ''}

The app is a plain Node.js 20 (CommonJS, no framework) web app. Key source files:
- services/pa-web/src/server.js — HTTP server, routes, session gate
- services/pa-web/src/auth.js — employee login, JWT verify
- services/pa-web/src/visits.js — survey API (sole writer to schema "survey")
- services/pa-web/src/feedback.html — survey wizard (now served at /survey)
- services/pa-web/src/home.html — public PA home page
- services/pa-web/src/staff.js — staff & HR API
- services/pa-web/src/offers.js — offer letters (pdfkit)
- services/pa-web/src/router.js — PA messaging router
- services/pa-web/src/apps.js — app registry (messaging layer)
- services/pa-web/src/telegram.js — Telegram webhook

Please provide a structured analysis with these sections:
1. **Issue category** — UI bug / logic bug / security / performance / UX / data
2. **Likely files** — which source files to look at first
3. **Probable root cause** — 2-3 sentences
4. **Suggested fix** — 2-3 sentences describing the approach
5. **Claude Code prompt** — a ready-to-use prompt the owner can paste into Claude Code to investigate and fix this issue

Keep the response concise and actionable. The owner will paste the Claude Code prompt directly into their terminal.`;

      await q(`UPDATE survey.issues SET status = 'analyzing' WHERE id = $1`, [id]);

      let analysisText;
      try {
        analysisText = await callClaude(prompt);
      } catch (e) {
        await q(`UPDATE survey.issues SET status = 'open' WHERE id = $1`, [id]);
        json(res, 502, { error: 'AI analysis failed: ' + e.message }); return true;
      }

      const analysis = { summary: analysisText, analyzed_by: user.email };
      await q(
        `UPDATE survey.issues SET status = 'reviewed', analysis = $1::jsonb, analyzed_at = now() WHERE id = $2`,
        [JSON.stringify(analysis), id]
      );
      json(res, 200, { ok: true, analysis: analysisText });
      return true;
    }

    /* POST /api/issues/:id/resolve */
    if (req.method === 'POST' && seg.length === 4 && seg[3] === 'resolve') {
      const id = parseInt(seg[2], 10);
      if (!id) { json(res, 400, { error: 'invalid id' }); return true; }
      let b;
      try { b = await readBody(req); }
      catch { json(res, 400, { error: 'bad request' }); return true; }
      const r = await q(
        `UPDATE survey.issues SET status = 'resolved', resolution = $1 WHERE id = $2 RETURNING id`,
        [String(b.resolution || '').trim() || null, id]
      );
      if (!r.rows[0]) { json(res, 404, { error: 'not found' }); return true; }
      json(res, 200, { ok: true });
      return true;
    }

    return false;
  };
};
