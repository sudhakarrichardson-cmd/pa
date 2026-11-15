'use strict';
/*
 * pf-router — the PA messaging layer core (consumer side).
 *
 * One front door for PA users on any channel (Telegram today via
 * telegram.js; WhatsApp/SMS via POST /api/pa/inbound from the platform
 * gateways). The router:
 *
 *   1. registers the user once (name, address, pincode) — location is
 *      derived from the registration, never re-asked;
 *   2. understands the request (deterministic rule parser first, the
 *      ai-helper only as an escalation — it returns data, never writes);
 *   3. finds registered apps for the category + pincode (apps.js);
 *   4. asks them for basic information (check_availability), compares
 *      quotes, shows the best, and only on the user's confirmation
 *      places the order (place_order, idempotent pa_request_id);
 *   5. records the order in the PA order book (pa.orders) and answers
 *      status questions (order_status);
 *   6. logs what it could not serve (pa.request_log, UC-11).
 *
 * Sessions live in Postgres (pa.sessions) — never in-memory only.
 * PA never touches an app's database and never takes money: the app /
 * vendor sends the final invoice + payment instructions to the user.
 *
 * Exports: module.exports(pool) for server use, and
 * module.exports.createRouter(store) with an injectable store for
 * tests (tests/pa-messaging.test.js). parseRequest / pickBestQuote are
 * exported as pure helpers.
 */

const crypto = require('crypto');

// ---------------------------------------------------------------------
// Rule parser — deterministic, no LLM. Returns one of:
//   { kind: 'greeting' | 'help' | 'confirm' | 'cancel' | 'status' }
//   { kind: 'slot_pick', n }
//   { kind: 'request', category, items: [{ name, qty, unit }] }
//   { kind: 'unknown' }
// ---------------------------------------------------------------------

const VEG_ITEMS = ['mirchi', 'chilli', 'chillies', 'tomato', 'tomatoes', 'onion',
  'onions', 'potato', 'potatoes', 'brinjal', 'carrot', 'beans', 'cabbage',
  'cauliflower', 'drumstick', 'coriander', 'lemon', 'ginger', 'garlic',
  'spinach', 'cucumber', 'pumpkin', 'ridge gourd', 'bottle gourd',
  'ladies finger', 'okra', 'curry leaves', 'banana', 'mango', 'apple'];
const CLOTH_ITEMS = ['nighty', 'vest', 'vests', 'saree', 'shirt', 'pant',
  'pants', 'dress', 'frock', 'towel', 'lungi', 'blouse', 'dhoti', 'kurta'];
const CATEGORY_WORDS = [
  ['legal', ['lawyer', 'advocate', 'case', 'hearing', 'court', 'legal']],
  ['appointment', ['doctor', 'appointment', 'clinic', 'dentist', 'hospital', 'checkup', 'check-up']],
  ['cloth', ['cloth', 'clothes', 'textile', 'textiles', 'garment']],
  ['vegetables', ['vegetable', 'vegetables', 'veg', 'sabzi', 'grocery', 'groceries']],
];

function normUnit(u, category) {
  if (!u) return category === 'cloth' ? 'piece' : 'kg';
  const s = u.toLowerCase();
  if (['g', 'gram', 'grams'].includes(s)) return 'g';
  if (['pc', 'pcs', 'piece', 'pieces'].includes(s)) return 'piece';
  if (['l', 'litre', 'liter'].includes(s)) return 'litre';
  return s;
}

function detectCategory(t) {
  for (const w of VEG_ITEMS) if (new RegExp(`\\b${w}\\b`).test(t)) return 'vegetables';
  for (const w of CLOTH_ITEMS) if (new RegExp(`\\b${w}\\b`).test(t)) return 'cloth';
  for (const [cat, words] of CATEGORY_WORDS) {
    for (const w of words) if (t.includes(w)) return cat;
  }
  return null;
}

function parseItems(t, category) {
  const items = [];
  const re = /(\d+(?:\.\d+)?)\s*(kg|g|gram|grams|litre|liter|l|ml|pieces|piece|pcs|pc|boxes|box|dozen)?\s+(?:of\s+)?([a-z][a-z\s]*?)(?=\s*(?:,| and |&|$))/gi;
  let m;
  while ((m = re.exec(t)) !== null) {
    const name = m[3].trim().replace(/\s+/g, ' ');
    if (!name || ['want', 'need', 'order', 'buy'].includes(name)) continue;
    items.push({ name, qty: parseFloat(m[1]), unit: normUnit(m[2], category) });
  }
  if (!items.length) {
    const known = [...VEG_ITEMS, ...CLOTH_ITEMS]
      .find(w => new RegExp(`\\b${w}\\b`).test(t));
    if (known) items.push({ name: known, qty: 1, unit: normUnit(null, category) });
  }
  return items;
}

function parseRequest(raw) {
  const t = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t || t === '/start' || ['hi', 'hello', 'hey', 'namaste'].includes(t)) {
    return { kind: 'greeting' };
  }
  if (t === 'help' || t === '/help' || t === 'menu') return { kind: 'help' };
  if (['yes', 'confirm', 'ok', 'okay', 'yes confirm', 'proceed'].includes(t)) {
    return { kind: 'confirm' };
  }
  if (['no', 'cancel', 'stop', 'no cancel'].includes(t)) return { kind: 'cancel' };
  if (/^(status|my order|order status|track|track order)\b/.test(t)) {
    return { kind: 'status' };
  }
  if (/^\d{1,2}$/.test(t)) return { kind: 'slot_pick', n: parseInt(t, 10) };

  const category = detectCategory(t);
  if (!category) return { kind: 'unknown' };
  const items = parseItems(t, category);
  if (!items.length) {
    // Service-type request with no item (lawyer / doctor): the service
    // itself is the item.
    const svc = category === 'legal' ? 'consultation'
      : category === 'appointment' ? 'appointment' : null;
    if (!svc) return { kind: 'unknown' };
    return { kind: 'request', category, items: [{ name: svc, qty: 1, unit: 'service' }] };
  }
  return { kind: 'request', category, items };
}

// quotes: [{ app, answer }] — answer is the app's check_availability
// reply. Best = available (yes/partial) with the lowest total.
function pickBestQuote(quotes) {
  const valid = (quotes || []).filter(q => q && q.answer &&
    q.answer.total != null &&
    (q.answer.items || []).some(i => i.available === 'yes' || i.available === 'partial'));
  if (!valid.length) return null;
  return valid.reduce((a, b) => (Number(b.answer.total) < Number(a.answer.total) ? b : a));
}

function fmtItems(items) {
  return items.map(i => `${i.name} — ${i.qty} ${i.unit}`).join(', ');
}

function fmtQuote(appName, answer) {
  const lines = (answer.items || []).map(i => {
    const avail = i.available === 'yes' ? 'available'
      : i.available === 'partial' ? `only ${i.available_qty} available` : 'not available';
    const money = i.amount != null ? ` — ₹${i.rate} × ${i.qty} = ₹${i.amount}` : '';
    return `• ${i.name} (${i.qty} ${i.unit})${money} — ${avail}`;
  });
  return `${appName}:\n${lines.join('\n')}\nTotal: ₹${answer.total}`;
}

const MENU =
  'Tell me what you need, for example:\n' +
  '• "2 kg mirchi" — vegetables\n' +
  '• "I want a nighty" — cloth\n' +
  '• "my case status" — lawyer\n' +
  '• "doctor appointment" — appointments\n' +
  'Or ask "status" for your last order.';

// ---------------------------------------------------------------------
// Router core — store is injectable for tests.
// ---------------------------------------------------------------------

function newRequestId() {
  return 'pf-' + Date.now().toString(36) + '-' + crypto.randomBytes(2).toString('hex');
}

function createRouter(store) {
  async function save(key, s) {
    await store.saveSession(key, s);
  }

  async function handleMessage({ channel, chatRef, text }) {
    const key = `${channel}:${chatRef}`;
    const replies = [];
    const session = (await store.getSession(key)) ||
      { channel, chatRef, userId: null, stage: 'registering', context: {} };
    let user = session.userId
      ? await store.getUserById(session.userId).catch(() => null)
      : null;
    if (!user) user = await store.getUserByRef(channel, chatRef).catch(() => null);
    if (user && !session.userId) session.userId = user.id;

    const parsed = parseRequest(text);

    // ---------- registration (UC-01) ----------
    if (!user) {
      const reg = session.context.reg || {};
      const body = String(text || '').trim();
      if (parsed.kind === 'greeting' || !reg.step) {
        session.stage = 'registering';
        session.context = { reg: { step: 'name' } };
        await save(key, session);
        replies.push(
          'Welcome to PlotFarms Personal Assistant. I will register you once — ' +
          'after that I remember your address and never ask again.\n\nYour name?');
        return { replies };
      }
      if (reg.step === 'name') {
        reg.name = body;
        reg.step = 'address';
        session.context = { reg };
        await save(key, session);
        replies.push(`Thanks, ${reg.name}. Your full address (with town)?`);
        return { replies };
      }
      if (reg.step === 'address') {
        reg.address = body;
        reg.step = 'pincode';
        session.context = { reg };
        await save(key, session);
        replies.push('And your pincode?');
        return { replies };
      }
      // step === 'pincode'
      const pin = (body.match(/\d{4,10}/) || [])[0];
      if (!pin) {
        replies.push('Please send the pincode as digits, e.g. 521001.');
        return { replies };
      }
      user = await store.createUser({
        name: reg.name, address: reg.address, pincode: pin, channel, chatRef,
      });
      session.userId = user.id;
      session.stage = 'idle';
      session.context = {};
      await save(key, session);
      replies.push(`Registered ✅ — ${user.name}, ${user.pincode}.\n\n${MENU}`);
      return { replies };
    }

    // ---------- pending confirmation (UC-07/08) ----------
    if (session.stage === 'awaiting_confirm') {
      const pending = session.context.pending || {};
      if (parsed.kind === 'cancel') {
        session.stage = 'idle'; session.context = {};
        await save(key, session);
        replies.push('Cancelled. Nothing was ordered.');
        return { replies };
      }
      if (parsed.kind !== 'confirm') {
        replies.push('Please reply YES to confirm, or NO to cancel.');
        return { replies };
      }
      const existing = await store.findOrder(pending.pa_request_id).catch(() => null);
      if (existing) {
        session.stage = 'idle'; session.context = {};
        await save(key, session);
        replies.push(`Already placed — order ${existing.app_order_id || existing.pa_request_id}, status: ${existing.status}.`);
        return { replies };
      }
      const app = await store.getApp(pending.app_id);
      const res = app
        ? await store.placeOrder(app, user, pending.items, pending.pa_request_id)
        : null;
      session.stage = 'idle'; session.context = {};
      await save(key, session);
      if (!res) {
        replies.push(`I could not place this with ${pending.app_name} right now. Please ask again in a little while — nothing was charged.`);
        return { replies };
      }
      await store.recordOrder({
        paRequestId: pending.pa_request_id, userId: user.id,
        appId: pending.app_id, items: pending.items,
        total: res.total != null ? res.total : pending.total,
        appOrderId: res.app_order_id, status: res.status || 'placed',
      });
      replies.push(
        pending.kind === 'booking'
          ? `✅ Booked with ${pending.app_name}. Booking ID: ${res.app_order_id} — status: ${res.status || 'confirmed'}.`
          : `✅ Order placed with ${pending.app_name}. Order ID: ${res.app_order_id}.\n` +
            'The store will send the final invoice and payment instructions (GPay / cash on delivery).');
      return { replies };
    }

    // ---------- pending slot pick (Scheduler) ----------
    if (session.stage === 'awaiting_slot') {
      const pending = session.context.pending || {};
      if (parsed.kind === 'cancel') {
        session.stage = 'idle'; session.context = {};
        await save(key, session);
        replies.push('Cancelled. No appointment was booked.');
        return { replies };
      }
      if (parsed.kind !== 'slot_pick' || !pending.slots ||
          parsed.n < 1 || parsed.n > pending.slots.length) {
        replies.push(`Please reply with a number 1–${(pending.slots || []).length}, or NO to cancel.`);
        return { replies };
      }
      const slot = pending.slots[parsed.n - 1];
      const paRequestId = newRequestId();
      const app = await store.getApp(pending.app_id);
      const items = [{ name: pending.service || 'appointment', qty: 1, unit: 'slot', slot }];
      const res = app ? await store.placeOrder(app, user, items, paRequestId) : null;
      session.stage = 'idle'; session.context = {};
      await save(key, session);
      if (!res) {
        replies.push(`I could not book with ${pending.app_name} right now. Please try again shortly.`);
        return { replies };
      }
      await store.recordOrder({
        paRequestId, userId: user.id, appId: pending.app_id, items,
        total: res.total != null ? res.total : null,
        appOrderId: res.app_order_id, status: res.status || 'booked',
      });
      replies.push(`✅ Appointment with ${pending.app_name} on ${slot}. Booking ID: ${res.app_order_id} — status: ${res.status || 'booked'}.`);
      return { replies };
    }

    // ---------- simple kinds ----------
    if (parsed.kind === 'greeting' || parsed.kind === 'help') {
      replies.push(parsed.kind === 'greeting'
        ? `Hello ${user.name}. ${MENU}` : MENU);
      return { replies };
    }
    if (parsed.kind === 'confirm' || parsed.kind === 'cancel') {
      replies.push('Nothing is waiting for confirmation right now.');
      return { replies };
    }
    if (parsed.kind === 'status') {
      const order = await store.latestOrder(user.id).catch(() => null);
      if (!order) { replies.push('You have no orders with me yet.'); return { replies }; }
      const app = await store.getApp(order.app_id).catch(() => null);
      const live = app && order.app_order_id
        ? await store.orderStatus(app, order.app_order_id).catch(() => null)
        : null;
      replies.push(
        `Your last order (${fmtItems(order.items || [])}) — ` +
        `status: ${live || order.status}.` +
        (order.app_order_id ? ` Order ID: ${order.app_order_id}.` : ''));
      return { replies };
    }

    // ---------- a real request (UC-04/05/06) ----------
    let req = parsed;
    if (req.kind === 'unknown' && store.understand) {
      const ai = await store.understand(String(text || '')).catch(() => null);
      if (ai && ai.category && Array.isArray(ai.items) && ai.items.length) {
        req = { kind: 'request', category: ai.category, items: ai.items };
      }
    }
    if (req.kind !== 'request') {
      await store.logRequest({
        channel, chatRef, userId: user.id, text, reason: 'not_understood',
      }).catch(() => {});
      replies.push(`I did not understand that.\n\n${MENU}`);
      return { replies };
    }

    const apps = await store.findApps(req.category, user.pincode);
    if (!apps.length) {
      await store.logRequest({
        channel, chatRef, userId: user.id, text, reason: 'no_service_found',
      }).catch(() => {});
      replies.push(
        'No registered service for this is available in your area yet. ' +
        'I have noted your request — PlotFarms will add services as they register.');
      return { replies };
    }

    const app = apps[0];

    // Query mode (lawyer): basic information first, request on confirm.
    if (app.mode === 'query') {
      const answer = await store.checkAvailability(app, user, req.items);
      if (!answer) {
        replies.push(`I could not reach ${app.app_name} right now. Please try again shortly.`);
        return { replies };
      }
      const info = answer.info || answer.note ||
        (answer.items || []).map(i =>
          `• ${i.name}: ${i.note || i.available || ''}`).join('\n');
      session.stage = 'awaiting_confirm';
      session.context = {
        pending: {
          kind: 'service_request', app_id: app.app_id, app_name: app.app_name,
          items: req.items, total: null, pa_request_id: newRequestId(),
        },
      };
      await save(key, session);
      replies.push(
        `${info}\n\nIf you want me to send this request to ${app.app_name}, reply YES. Otherwise reply NO.`);
      return { replies };
    }

    // Booking mode (scheduler): availability = free slots.
    if (app.mode === 'booking') {
      const answer = await store.checkAvailability(app, user, req.items);
      const slots = (answer && (answer.slots ||
        (answer.items && answer.items[0] && answer.items[0].slots))) || [];
      if (!answer || !slots.length) {
        replies.push(
          answer && answer.note ? answer.note
            : `No free slots are available with ${app.app_name} right now. Please try another day.`);
        return { replies };
      }
      session.stage = 'awaiting_slot';
      session.context = {
        pending: {
          kind: 'booking', app_id: app.app_id, app_name: app.app_name,
          service: req.items[0].name, slots,
        },
      };
      await save(key, session);
      replies.push(
        `Free slots with ${app.app_name}:\n` +
        slots.map((s, i) => `${i + 1}. ${s}`).join('\n') +
        '\n\nReply with the number to book, or NO to cancel.');
      return { replies };
    }

    // Mediated mode (ordering): quote from every app serving the area,
    // show the best, order only on confirmation.
    const quotes = [];
    for (const a of apps) {
      const answer = await store.checkAvailability(a, user, req.items);
      if (answer) quotes.push({ app: a, answer });
    }
    if (!quotes.length) {
      replies.push('The stores could not be reached right now. Please try again shortly.');
      return { replies };
    }
    const best = pickBestQuote(quotes);
    if (!best) {
      const names = [...new Set(quotes.flatMap(q =>
        (q.answer.items || []).filter(i => i.available === 'no').map(i => i.name)))];
      replies.push(
        `Not available right now: ${names.join(', ') || fmtItems(req.items)}. ` +
        'Please try again later or ask for something else.');
      return { replies };
    }
    session.stage = 'awaiting_confirm';
    session.context = {
      pending: {
        kind: 'order', app_id: best.app.app_id, app_name: best.app.app_name,
        items: best.answer.items.map(i => ({
          name: i.name, qty: i.qty, unit: i.unit, rate: i.rate,
        })),
        total: best.answer.total, pa_request_id: newRequestId(),
      },
    };
    await save(key, session);
    const others = quotes.length > 1
      ? `\n(Compared ${quotes.length} stores for your area.)` : '';
    replies.push(
      `${fmtQuote(best.app.app_name, best.answer)}${others}\n\n` +
      'Reply YES to place the order, or NO to cancel.');
    return { replies };
  }

  return { handleMessage };
}

// ---------------------------------------------------------------------
// Postgres-backed store (server use).
// ---------------------------------------------------------------------

module.exports = function registerRouter(pool) {
  const apps = require('./apps')(pool);
  const q = (sql, params) => pool.query(sql, params);

  const store = {
    async getUserById(id) {
      const r = await q('SELECT * FROM pa.users WHERE id = $1 AND active', [id]);
      return r.rows[0] || null;
    },
    async getUserByRef(channel, chatRef) {
      if (channel === 'telegram') {
        if (!/^\d+$/.test(String(chatRef))) return null;
        const r = await q(
          'SELECT * FROM pa.users WHERE telegram_chat_id = $1 AND active',
          [Number(chatRef)]);
        return r.rows[0] || null;
      }
      const r = await q(
        'SELECT * FROM pa.users WHERE whatsapp_ref = $1 AND active', [chatRef]);
      return r.rows[0] || null;
    },
    async createUser({ name, address, pincode, channel, chatRef }) {
      const tg = channel === 'telegram' && /^\d+$/.test(String(chatRef))
        ? Number(chatRef) : null;
      const wa = channel === 'telegram' ? null : String(chatRef);
      const r = await q(
        `INSERT INTO pa.users (name, address, pincode, telegram_chat_id, whatsapp_ref)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [name, address, pincode, tg, wa]);
      return r.rows[0];
    },
    async getSession(key) {
      const r = await q('SELECT * FROM pa.sessions WHERE session_key = $1', [key]);
      if (!r.rows[0]) return null;
      return {
        channel: r.rows[0].channel, chatRef: r.rows[0].chat_ref,
        userId: r.rows[0].user_id, stage: r.rows[0].stage,
        context: r.rows[0].context || {},
      };
    },
    async saveSession(key, s) {
      await q(
        `INSERT INTO pa.sessions (session_key, channel, chat_ref, user_id, stage, context, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6, now())
         ON CONFLICT (session_key) DO UPDATE SET
           user_id = EXCLUDED.user_id, stage = EXCLUDED.stage,
           context = EXCLUDED.context, updated_at = now()`,
        [key, s.channel, s.chatRef, s.userId || null, s.stage,
         JSON.stringify(s.context || {})]);
    },
    findApps: (category, pincode) => apps.findApps(category, pincode),
    getApp: appId => apps.getApp(appId),
    checkAvailability: (app, user, items) => apps.checkAvailability(app, user, items),
    placeOrder: (app, user, items, id) => apps.placeOrder(app, user, items, id),
    orderStatus: (app, orderId) => apps.orderStatus(app, orderId),
    async recordOrder(o) {
      await q(
        `INSERT INTO pa.orders
           (pa_request_id, user_id, app_id, items, total, app_order_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (pa_request_id) DO NOTHING`,
        [o.paRequestId, o.userId, o.appId, JSON.stringify(o.items || []),
         o.total, o.appOrderId, o.status]);
    },
    async findOrder(paRequestId) {
      const r = await q(
        'SELECT * FROM pa.orders WHERE pa_request_id = $1', [paRequestId]);
      return r.rows[0] || null;
    },
    async latestOrder(userId) {
      const r = await q(
        `SELECT * FROM pa.orders WHERE user_id = $1
          ORDER BY created_at DESC LIMIT 1`, [userId]);
      return r.rows[0] || null;
    },
    async logRequest(e) {
      await q(
        `INSERT INTO pa.request_log (channel, chat_ref, user_id, text, reason)
         VALUES ($1,$2,$3,$4,$5)`,
        [e.channel, e.chatRef, e.userId || null, e.text || '', e.reason]);
    },
    // Optional escalation: the platform ai-helper returns structured
    // intent as DATA only ({ category, items }); it never writes.
    async understand(text) {
      const url = process.env.AI_HELPER_URL || '';
      if (!url) return null;
      try {
        const r = await fetch(url.replace(/\/$/, '') + '/understand', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) return null;
        const d = await r.json().catch(() => null);
        return d && d.category ? d : null;
      } catch { return null; }
    },
  };

  return createRouter(store);
};
module.exports.createRouter = createRouter;
module.exports.parseRequest = parseRequest;
module.exports.pickBestQuote = pickBestQuote;
