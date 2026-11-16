'use strict';
/*
 * Telegram bot for pa-web — employees ask about their survey visits;
 * managers get dashboard counts; freeform questions go to MiniMax AI.
 * Chats that are NOT linked to an employee login are handed to the
 * consumer messaging layer (router.js, passed in by server.js): this
 * is the same public PA bot (@ypa25bot) that PA users talk to.
 *
 * Routes registered in server.js:
 *   POST /api/telegram/webhook  — Telegram pushes updates here
 *   POST /api/telegram/link     — web link-confirmation (requires login)
 *   GET  /link                  — link page served to logged-in employees
 *
 * Linking flow:
 *   1. Employee sends /link in Telegram
 *   2. Bot generates a 6-digit OTP → stored in survey.telegram_link_tokens
 *   3. Employee opens pa.plotfarms.com/link, logs in, enters OTP
 *   4. Server verifies OTP → creates survey.telegram_sessions row
 *   5. Bot sends "✅ Linked!" via Bot API
 */

const crypto = require('crypto');

const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN || '';
const MINIMAX_KEY    = process.env.MINIMAX_API_KEY    || '';
const APP_DOMAIN     = process.env.APP_DOMAIN         || 'pa.plotfarms.com';
const TG_API         = `https://api.telegram.org/bot${BOT_TOKEN}`;
const APP_CODE       = 'survey';
// Webhook secret derived from bot token so no extra env var is needed.
const WEBHOOK_SECRET = BOT_TOKEN
  ? crypto.createHash('sha256').update(BOT_TOKEN).digest('hex').slice(0, 32)
  : '';

// ---- Telegram Bot API -------------------------------------------------
async function tgCall(method, body) {
  if (!BOT_TOKEN) return null;
  const r = await fetch(`${TG_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);
  return r && r.ok ? r.json().catch(() => null) : null;
}

async function sendMessage(chatId, text, extra = {}) {
  return tgCall('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
}

// Plain-text send for PA consumer replies (router.js) — the text can
// contain user-supplied names/items, so no HTML parse mode.
async function sendPlain(chatId, text) {
  return tgCall('sendMessage', { chat_id: chatId, text });
}

// Send a PDF buffer as a document (invoice delivery via relay).
// Uses Node 20 built-in FormData — no extra deps needed.
async function sendDocumentBuffer(chatId, buffer, filename, caption) {
  if (!BOT_TOKEN) return null;
  try {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('document', new Blob([buffer], { type: 'application/pdf' }), filename);
    if (caption) {
      form.append('caption', caption);
      form.append('parse_mode', 'HTML');
    }
    const r = await fetch(`${TG_API}/sendDocument`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(30000),
    }).catch(() => null);
    return r && r.ok ? r.json().catch(() => null) : null;
  } catch { return null; }
}

// Register the webhook URL with Telegram (idempotent — safe to call on startup).
async function setupWebhook() {
  if (!BOT_TOKEN) return;
  await tgCall('setWebhook', {
    url: `https://${APP_DOMAIN}/api/telegram/webhook`,
    secret_token: WEBHOOK_SECRET,
    allowed_updates: ['message'],
  });
}

// ---- MiniMax AI -------------------------------------------------------
async function askLLM(systemPrompt, userMessage) {
  if (!MINIMAX_KEY) return null;
  const r = await fetch('https://api.minimax.io/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MINIMAX_KEY}` },
    body: JSON.stringify({
      model: 'MiniMax-Text-01',
      max_tokens: 400,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage },
      ],
    }),
    signal: AbortSignal.timeout(20000),
  }).catch(() => null);
  if (!r || !r.ok) return null;
  const d = await r.json().catch(() => null);
  return d?.choices?.[0]?.message?.content?.trim() || null;
}

// ---- DB helpers -------------------------------------------------------
module.exports = function registerTelegram(pool, auth, paRouter) {
  const q = (sql, params) => pool.query(sql, params);

  // Look up the survey grant for a user_id (mirrors auth.js grantFor).
  async function grantForUser(userId) {
    const acc = await q(
      'SELECT role_code FROM platform.user_app_access WHERE user_id=$1 AND app_code=$2 AND active',
      [userId, APP_CODE]);
    if (!acc.rows[0]) return null;
    const role = acc.rows[0].role_code;
    const c = await q(
      'SELECT capability FROM survey.role_capabilities WHERE role_code=$1 AND allowed', [role]);
    const caps = c.rows.map(r => r.capability);
    return caps.length ? { role, caps } : null;
  }

  // Resolve a Telegram chat_id to { userId, email, role, caps } or null.
  async function resolveSession(chatId) {
    const s = await q(
      'SELECT user_id FROM survey.telegram_sessions WHERE chat_id=$1 AND active', [chatId]);
    if (!s.rows[0]) return null;
    const userId = s.rows[0].user_id;
    const grant  = await grantForUser(userId).catch(() => null);
    if (!grant) return null;
    // Fetch email for display
    const eu = await q(
      "SELECT email FROM auth.users WHERE id=$1::uuid", [userId]).catch(() => ({ rows: [] }));
    return { userId, email: eu.rows[0]?.email || '', role: grant.role, caps: grant.caps };
  }

  // ---- intent + data fetch --------------------------------------------
  async function fetchVisits(userId, all, limit = 10) {
    const sql = all
      ? `SELECT id, visit_date, business_name, business_type, town, status,
                interest_level, submitted_by
           FROM survey.visits ORDER BY visit_date DESC LIMIT $1`
      : `SELECT id, visit_date, business_name, business_type, town, status,
                interest_level
           FROM survey.visits WHERE submitted_by=$2 ORDER BY visit_date DESC LIMIT $1`;
    const params = all ? [limit] : [limit, userId];
    const r = await q(sql, params);
    return r.rows;
  }

  async function fetchDashboard() {
    const r = await q(`
      SELECT status, count(*)::int AS cnt FROM survey.visits GROUP BY status
      UNION ALL
      SELECT 'total', count(*)::int FROM survey.visits`);
    return r.rows;
  }

  function formatVisits(rows) {
    if (!rows.length) return 'No visits found.';
    return rows.map((v, i) =>
      `${i + 1}. <b>${v.business_name || '(no name)'}</b> — ${v.visit_date}` +
      `\n   ${v.business_type || ''} | ${v.town || ''} | ${v.status}` +
      (v.interest_level ? ` | ${v.interest_level}` : '') +
      (v.submitted_by && v.submitted_by !== v.email ? `\n   by ${v.submitted_by}` : '')
    ).join('\n\n');
  }

  function formatDashboard(rows) {
    const map = Object.fromEntries(rows.map(r => [r.status, r.cnt]));
    return `📊 <b>Dashboard</b>\n` +
      `Total: ${map.total || 0}\n` +
      `Draft: ${map.draft || 0}\n` +
      `Submitted: ${map.submitted || 0}\n` +
      `Completed: ${map.completed || 0}`;
  }

  // ---- command handlers -----------------------------------------------
  async function handleStart(chatId) {
    await sendMessage(chatId,
      '👋 <b>Welcome to PlotFarms PA Bot!</b>\n\n' +
      'I can help you check your survey visits and answer questions about the PA app.\n\n' +
      'First, link your account:\n' +
      '/link — connect your pa.plotfarms.com login\n\n' +
      'Once linked:\n' +
      '/visits — your recent visits\n' +
      '/dashboard — counts summary (managers)\n' +
      '/help — all commands');
  }

  async function handleHelp(chatId, user) {
    const isManager = auth.can(user, 'view_all_visits');
    await sendMessage(chatId,
      '<b>PA Bot Commands</b>\n\n' +
      '/visits — your recent visits\n' +
      '/link — re-link your account\n' +
      '/unlink — disconnect this Telegram account\n' +
      (isManager ? '/dashboard — visit counts\n/allvisits — all staff visits\n' : '') +
      '\nOr just ask me anything about your visits!');
  }

  async function handleLink(chatId) {
    // Generate a 6-digit OTP
    const otp = String(crypto.randomInt(100000, 999999));
    await q(
      `INSERT INTO survey.telegram_link_tokens (token, chat_id)
       VALUES ($1, $2)
       ON CONFLICT (token) DO UPDATE SET chat_id=$2, created_at=now(),
         expires_at=now()+interval '10 minutes', used=false`,
      [otp, chatId]);
    await sendMessage(chatId,
      '🔗 <b>Link your PA account</b>\n\n' +
      `Open: https://${APP_DOMAIN}/link\n\n` +
      `Enter code: <b>${otp}</b>\n\n` +
      'Code expires in 10 minutes. Log in to pa.plotfarms.com first.');
  }

  async function handleUnlink(chatId) {
    await q(
      'UPDATE survey.telegram_sessions SET active=false WHERE chat_id=$1', [chatId]);
    await sendMessage(chatId, '✅ Unlinked. Send /link to reconnect.');
  }

  async function handleVisits(chatId, user) {
    const rows = await fetchVisits(user.userId, false);
    await sendMessage(chatId, `<b>Your recent visits</b>\n\n${formatVisits(rows)}`);
  }

  async function handleAllVisits(chatId, user) {
    if (!auth.can(user, 'view_all_visits')) {
      await sendMessage(chatId, '❌ Manager access required.'); return;
    }
    const rows = await fetchVisits(user.userId, true);
    await sendMessage(chatId, `<b>All recent visits</b>\n\n${formatVisits(rows)}`);
  }

  async function handleDashboard(chatId, user) {
    if (!auth.can(user, 'view_dashboard')) {
      await sendMessage(chatId, '❌ Manager access required.'); return;
    }
    const rows = await fetchDashboard();
    await sendMessage(chatId, formatDashboard(rows));
  }

  // ---- AI freeform handler -------------------------------------------
  async function handleAI(chatId, user, text) {
    const canAll  = auth.can(user, 'view_all_visits');
    const canDash = auth.can(user, 'view_dashboard');

    // Fetch relevant data to give the AI context
    const visits = await fetchVisits(user.userId, canAll, 20).catch(() => []);
    const dash   = canDash ? await fetchDashboard().catch(() => []) : [];

    const context = [
      `User: ${user.email} | Role: ${user.role}`,
      `Today: ${new Date().toISOString().slice(0, 10)}`,
      canAll
        ? `Recent visits (all staff, up to 20):\n${JSON.stringify(visits, null, 2)}`
        : `My recent visits (up to 20):\n${JSON.stringify(visits, null, 2)}`,
      canDash ? `Dashboard counts:\n${JSON.stringify(dash, null, 2)}` : '',
    ].filter(Boolean).join('\n\n');

    const system =
      'You are the PA Bot for PlotFarms — a business-visit tracking app used by field employees. ' +
      'Answer the user\'s question using ONLY the data provided below. ' +
      'Be concise (under 200 words). Use plain text, no markdown. ' +
      'If the data does not contain enough information, say so briefly.\n\n' +
      context;

    const reply = await askLLM(system, text);
    if (reply) {
      await sendMessage(chatId, reply);
    } else {
      await sendMessage(chatId,
        "Sorry, I couldn't get an AI response right now.\n" +
        'Try /visits for your recent visits or /help for commands.');
    }
  }

  // ---- main webhook handler ------------------------------------------
  async function handleWebhook(req, res) {
    // Verify the secret token Telegram sends in the header
    const incoming = req.headers['x-telegram-bot-api-secret-token'] || '';
    if (WEBHOOK_SECRET && incoming !== WEBHOOK_SECRET) {
      res.writeHead(403); res.end(); return;
    }

    let body;
    try { body = await auth.readBody(req, 512 * 1024); }
    catch { res.writeHead(400); res.end(); return; }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}'); // always ACK immediately

    const msg = body?.message;
    if (!msg) return;

    const chatId = msg.chat?.id;
    const text   = (msg.text || '').trim();
    if (!chatId || !text) return;

    try {
      const cmd = text.split(' ')[0].toLowerCase().replace(/@.*$/, '');

      if (cmd === '/link')  { await handleLink(chatId);  return; }

      const user = await resolveSession(chatId).catch(() => null);

      if (cmd === '/start' && user) { await handleStart(chatId); return; }

      if (!user) {
        // Not a linked employee. This bot is ALSO the public PA bot
        // (@ypa25bot, linked from the home page): hand the chat to the
        // consumer messaging layer (router.js), which registers PA
        // users and serves their requests. Employees can still send
        // /link at any time to connect their employee login.
        if (paRouter) {
          const out = await paRouter.handleMessage({
            channel: 'telegram', chatRef: String(chatId), text,
          });
          for (const r of (out.replies || [])) await sendPlain(chatId, r);
        } else {
          await sendMessage(chatId,
            '🔒 Your Telegram is not linked to a PA account yet.\n' +
            'Send /link to connect.');
        }
        return;
      }

      if (cmd === '/help')       { await handleHelp(chatId, user);       return; }
      if (cmd === '/visits')     { await handleVisits(chatId, user);     return; }
      if (cmd === '/allvisits')  { await handleAllVisits(chatId, user);  return; }
      if (cmd === '/dashboard')  { await handleDashboard(chatId, user);  return; }
      if (cmd === '/unlink')     { await handleUnlink(chatId);           return; }

      // A linked employee can also be a PA user — the owner is the
      // first test user, and his Telegram IS linked as an employee.
      // PA consumer requests, and replies inside a PA flow this chat
      // started, go to the PA router; visit questions stay with the
      // employee bot below. (Without this split, a linked account
      // asking for "2 kg mirchi" only ever reached the survey AI,
      // which knows visits data and nothing about ordering.)
      if (paRouter && await paRouter.shouldHandle({
        channel: 'telegram', chatRef: String(chatId), text,
      })) {
        const out = await paRouter.handleMessage({
          channel: 'telegram', chatRef: String(chatId), text,
        });
        for (const r of (out.replies || [])) await sendPlain(chatId, r);
        return;
      }

      // Freeform → AI
      await handleAI(chatId, user, text);
    } catch (e) {
      console.error('telegram webhook error:', e.message);
      await sendMessage(chatId, 'Something went wrong. Please try again.').catch(() => {});
    }
  }

  // ---- web link-confirmation (POST /api/telegram/link) ---------------
  async function handleLinkConfirm(req, res, user) {
    let body;
    try { body = await auth.readBody(req); }
    catch { auth.json(res, 400, { error: 'bad request' }); return; }

    const otp = String(body.otp || '').trim();
    if (!otp) { auth.json(res, 400, { error: 'otp required' }); return; }

    const r = await q(
      `SELECT chat_id FROM survey.telegram_link_tokens
       WHERE token=$1 AND NOT used AND expires_at > now()`, [otp]);
    if (!r.rows[0]) {
      auth.json(res, 400, { error: 'invalid or expired code' }); return;
    }
    const chatId = r.rows[0].chat_id;

    // Mark token used + create/update session
    await q('UPDATE survey.telegram_link_tokens SET used=true WHERE token=$1', [otp]);
    await q(
      `INSERT INTO survey.telegram_sessions (chat_id, user_id, active)
       VALUES ($1, $2, true)
       ON CONFLICT (chat_id) DO UPDATE SET user_id=$2, linked_at=now(), active=true`,
      [chatId, user.userId]);

    // Notify the bot chat
    await sendMessage(chatId,
      `✅ <b>Account linked!</b>\n\n` +
      `You're now connected as <b>${user.email}</b> (${user.role}).\n\n` +
      'Send /help to see what I can do.').catch(() => {});

    auth.json(res, 200, { ok: true });
  }

  // Send a text message to a PA user by their pa.users.id.
  // Returns { ok: true } or { ok: false, error } — does not throw.
  async function sendToUser(paUserId, text) {
    try {
      const r = await q(
        'SELECT telegram_chat_id FROM pa.users WHERE id=$1 AND active=true', [paUserId]);
      const chatId = r.rows[0]?.telegram_chat_id;
      if (!chatId) return { ok: false, error: 'user has no telegram' };
      await sendPlain(chatId, text);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Send a PDF document to a PA user by their pa.users.id.
  // buffer is a Buffer of PDF bytes. Returns { ok, error? }.
  async function sendDocumentToUser(paUserId, buffer, filename, caption) {
    try {
      const r = await q(
        'SELECT telegram_chat_id FROM pa.users WHERE id=$1 AND active=true', [paUserId]);
      const chatId = r.rows[0]?.telegram_chat_id;
      if (!chatId) return { ok: false, error: 'user has no telegram' };
      const result = await sendDocumentBuffer(chatId, buffer, filename, caption);
      return result ? { ok: true } : { ok: false, error: 'telegram sendDocument failed' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Register the webhook with Telegram on startup
  setupWebhook().catch(e => console.error('telegram setup error:', e.message));

  return { handleWebhook, handleLinkConfirm, sendToUser, sendDocumentToUser };
};
