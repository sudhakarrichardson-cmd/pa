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
 *      ai-helper only as an escalation — it returns data, never writes;
 *      phrases the parser misses go through the route dictionary
 *      learning loop, src/dictionary.js + migration 025);
 *   3. for ordering categories (vegetables, cloth) collects the full
 *      list first — a cart: the user adds items over as many messages
 *      as they like and NO app is contacted until they say DONE;
 *   4. finds registered apps for the category + pincode (apps.js),
 *      asks them for basic information (check_availability) for the
 *      whole list at once, compares quotes, shows the best — the user
 *      can still add items to the shown quote (re-checked with the
 *      winning app) — and only on the user's confirmation places the
 *      order (place_order, idempotent pa_request_id);
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
const dict = require('./dictionary');

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

// Typo tolerance for item names: users type "mirhi", "tomto",
// "onoin". A word that is a near miss of exactly ONE known item
// (Damerau distance — a swapped letter pair counts once) snaps to
// that item. Ambiguous near misses (close to two items) never snap.
// Common English words that sit one edit from an item name are
// stoplisted so ordinary sentences can never become items.
const FUZZY_STOP = new Set(['short', 'part', 'ride', 'rich', 'core', 'coin', 'care', 'card',
  'want', 'need', 'have', 'what', 'with', 'from', 'this', 'that', 'will', 'your',
  'like', 'nice', 'means', 'best', 'week', 'shift', 'union', 'some', 'more']);
function editDistance(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}
function fuzzyItem(word) {
  const w = String(word || '').toLowerCase();
  if (w.length < 4 || FUZZY_STOP.has(w)) return null;
  if (VEG_ITEMS.includes(w) || CLOTH_ITEMS.includes(w)) return null; // exact is not fuzzy
  const limit = w.length >= 7 ? 2 : 1;
  let best = null, bestD = Infinity, tied = false;
  for (const item of [...VEG_ITEMS, ...CLOTH_ITEMS]) {
    if (item.includes(' ') || Math.abs(item.length - w.length) > limit) continue;
    const dist = editDistance(w, item);
    if (dist > limit) continue;
    if (dist < bestD) { bestD = dist; best = item; tied = false; }
    else if (dist === bestD) tied = true;
  }
  return best && !tied ? best : null;
}

function detectCategory(t) {
  for (const w of VEG_ITEMS) if (new RegExp(`\\b${w}\\b`).test(t)) return 'vegetables';
  for (const w of CLOTH_ITEMS) if (new RegExp(`\\b${w}\\b`).test(t)) return 'cloth';
  for (const [cat, words] of CATEGORY_WORDS) {
    for (const w of words) if (t.includes(w)) return cat;
  }
  // Fuzzy pass — only for order-shaped text (a quantity or a unit
  // is present), so ordinary sentences can't trip it: "2 kg mirhi"
  // is an order even though the item word is misspelled.
  const orderShaped = /\d/.test(t) ||
    UNIT_WORDS.some(u => new RegExp(`\\b${u}\\b`).test(t));
  if (orderShaped) {
    for (const w of t.split(/[^a-z]+/).filter(Boolean)) {
      const f = fuzzyItem(w);
      if (f) return VEG_ITEMS.includes(f) ? 'vegetables' : 'cloth';
    }
  }
  return null;
}

const UNIT_WORDS = ['kg', 'g', 'gram', 'grams', 'litre', 'liter', 'l', 'ml',
  'piece', 'pieces', 'pcs', 'pc', 'box', 'boxes', 'dozen'];

function parseItems(t, category) {
  const items = [];
  // The name ends at a comma / "and" / "&", at the NEXT item's
  // quantity, or at the end — "1 kg ginger 2 kg garlic" is two
  // items even without a comma; without the digit boundary the
  // first item's name can never close and it is silently dropped.
  const re = /(\d+(?:\.\d+)?)\s*(kg|g|gram|grams|litre|liter|l|ml|pieces|piece|pcs|pc|boxes|box|dozen)?\s+(?:of\s+)?([a-z][a-z\s]*?)(?=\s*(?:,| and |&|\d|$))/gi;
  let m;
  while ((m = re.exec(t)) !== null) {
    let name = m[3].trim().replace(/\s+/g, ' ');
    if (!name || ['want', 'need', 'order', 'buy'].includes(name)) continue;
    if (!name.includes(' ')) name = fuzzyItem(name) || name;
    // "tomotos 2 kg": the quantity-first pattern can latch onto the
    // unit itself as the name — a unit is never an item name.
    if (UNIT_WORDS.includes(name)) continue;
    items.push({ name, qty: parseFloat(m[1]), unit: normUnit(m[2], category) });
  }
  if (!items.length) {
    // Name-first phrasing: "tomato 2kg", "tomotos 2 kg", "add brinjal 1kg".
    const re2 = /([a-z][a-z\s]*?)\s+(\d+(?:\.\d+)?)\s*(kg|g|gram|grams|litre|liter|l|ml|pieces|piece|pcs|pc|boxes|box|dozen)?\b/gi;
    let m2;
    while ((m2 = re2.exec(t)) !== null) {
      let name = m2[1].trim().replace(/\s+/g, ' ')
        .replace(/^(add|buy|want|need|get|order|please)\s+/, '');
      if (!name || UNIT_WORDS.includes(name)) continue;
      if (!name.includes(' ')) name = fuzzyItem(name) || name;
      if (['want', 'need', 'order', 'buy'].includes(name)) continue;
      items.push({ name, qty: parseFloat(m2[2]), unit: normUnit(m2[3], category) });
    }
  }
  if (!items.length) {
    const known = [...VEG_ITEMS, ...CLOTH_ITEMS]
      .find(w => new RegExp(`\\b${w}\\b`).test(t));
    if (known) {
      items.push({ name: known, qty: 1, unit: normUnit(null, category) });
    } else {
      // No exact item word — a single near-miss word still counts
      // ("mirhi" with no quantity in a known-category context).
      for (const w of t.split(/[^a-z]+/).filter(Boolean)) {
        const f = fuzzyItem(w);
        if (f) { items.push({ name: f, qty: 1, unit: normUnit(null, category) }); break; }
      }
    }
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

// Ordering categories go through the cart (collecting) stage;
// query (legal) and booking (appointment) requests dispatch at once.
const ORDER_CATEGORIES = ['vegetables', 'cloth'];

// Words that mean "my list is complete — show prices" while
// collecting. (YES / OK / proceed already parse as 'confirm', which
// the collecting stage also treats as done.)
const DONE_WORDS = new Set([
  'done', "that's all", 'thats all', 'no more', 'no more items',
  'checkout', 'show prices', 'get prices', 'chalu', 'inka chalu',
]);

// Merge extra items into a list: same name + unit adds quantities,
// anything else appends. Quantities always come from the live
// message, never from a stored template.
function mergeItems(base, extra) {
  const out = (base || []).map(i => ({ ...i }));
  for (const e of extra || []) {
    const hit = out.find(i => i.name === e.name && i.unit === e.unit);
    if (hit) hit.qty = Number(hit.qty || 0) + Number(e.qty || 0);
    else out.push({ name: e.name, qty: e.qty, unit: e.unit });
  }
  return out;
}

function fmtCart(cart) {
  const lines = (cart.items || []).map(i => `• ${i.name} — ${i.qty} ${i.unit}`);
  return (
    `Your list so far:
${lines.join('\n')}

` +
    'Add more items, or reply DONE to see prices. Reply NO to cancel.');
}

// "remove tomato", "delete the brinjal", "i don't want kg - 2kg from
// the list" — the user may paste the bot's own list line back, so an
// item whose name appears as a word in the target wins first; else
// quantities / units / filler are stripped and what remains is the
// name. Returns { name } or null.
const REMOVE_FILLER = new Set(['from', 'the', 'list', 'item', 'please',
  'in', 'my', 'cart', 'order', 'this', 'that']);
function parseRemoval(raw, items) {
  const t = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  let target = null;
  let m = t.match(/^(?:please\s+)?(?:remove|delete|drop)\s+(.+)$/);
  if (m) target = m[1];
  if (!target) {
    m = t.match(/(?:don'?t|do not)\s+want\s+(.+)$/);
    if (m) target = m[1];
  }
  if (!target) {
    m = t.match(/^no\s+(.+)$/);
    if (m && !['more', 'more items', 'cancel'].includes(m[1])) target = m[1];
  }
  if (!target) return null;
  for (const it of items || []) {
    if (new RegExp(`\\b${it.name}\\b`).test(target)) return { name: it.name };
  }
  const words = target.replace(/[—–\-,]/g, ' ').split(/\s+/).filter(w =>
    w && !/^\d/.test(w) && !UNIT_WORDS.includes(w) && !REMOVE_FILLER.has(w));
  const name = words.join(' ').trim();
  return name ? { name } : null;
}

const CATEGORY_LABELS = {
  vegetables: 'Vegetables', cloth: 'Cloth',
  legal: 'Legal help', appointment: 'Appointments',
};
const SERVICE_CATEGORIES = ['vegetables', 'cloth', 'legal', 'appointment'];

// Split heuristic for shared bots (telegram.js shouldHandle): does
// this text look like a PA service-discovery question ("which shops
// are registered", "any shops in the list") rather than the other
// audience's business ("shops we visited", "survey list")? Kept
// deliberately narrow — visit/survey/dashboard words veto it, and
// inside PA the ai-helper + dictionary do the real understanding.
function looksLikeServicesQuestion(raw) {
  const t = String(raw || '').toLowerCase();
  if (!/\b(shops?|stores?|services)\b/.test(t)) return false;
  if (/\b(visits?|visited|survey|surveyed|dashboard)\b/.test(t)) return false;
  return /\b(registered|list|available|any|all|what|which|where)\b/.test(t);
}

// Deterministic net for questions ABOUT PA — the shapes users
// actually type, typos included ("in shop are you odering it",
// "what is teh shop name you will order this item"). This runs
// BEFORE the dictionary and the ai-helper in every meta path, so
// these questions are answered even when the helper is down, has
// not learned the new signatures yet, or the dictionary is off.
// The helper remains the long-tail mechanism (any other phrasing,
// learned or proposed); this net only catches clear shapes and
// returns null otherwise. Same veto as the split heuristic:
// visit/survey/dashboard questions are never PA meta questions.
function parseMetaQuestion(raw) {
  const t = String(raw || '').toLowerCase()
    .replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ');
  if (!/\b(shops?|stores?)\b/.test(t)) return null;
  if (/\b(visits?|visited|survey|surveyed|dashboard)\b/.test(t)) return null;
  // Listing question: an explicit list/registered/available word,
  // or plural "shops" asked about with a discovery word.
  if (/\b(list|registered|available|near|nearby)\b/.test(t) ||
      (/\bshops\b/.test(t) &&
       /\b(any|all|what|which|where|do you|can you)\b/.test(t))) {
    const cat = detectCategory(t);
    return { kind: 'services', category: SERVICE_CATEGORIES.includes(cat) ? cat : null };
  }
  // Which-shop question: singular shop/store in a question shape.
  if (/\b(which|what|where|name|in|from)\b/.test(t) ||
      /\b(are you|will you|you will|you are)\b/.test(t)) {
    return { kind: 'which_shop' };
  }
  return null;
}

function findItemIndex(items, name) {
  const n = String(name || '').toLowerCase();
  let idx = (items || []).findIndex(i => i.name.toLowerCase() === n);
  if (idx < 0) {
    idx = (items || []).findIndex(i =>
      i.name.toLowerCase().includes(n) || n.includes(i.name.toLowerCase()));
  }
  return idx;
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

  // The dictionary learning loop runs only when the store provides it
  // (the Postgres store does; minimal test stores may not) and the
  // flag is on. PA_DICTIONARY_ENABLED=false restores pre-dictionary
  // behavior exactly.
  const dictOn = () =>
    process.env.PA_DICTIONARY_ENABLED !== 'false' &&
    typeof store.dictLookup === 'function';

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
      if (parsed.kind === 'cancel' && reg.step) {
        session.context = {};
        session.stage = 'registering';
        await save(key, session);
        replies.push('Registration cancelled. Message me any time to start again.');
        return { replies };
      }
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

    // Status answer for the user's last order (used by the status
    // intent and by dictionary routes that resolve to it).
    async function statusReply() {
      const order = await store.latestOrder(user.id).catch(() => null);
      if (!order) return 'You have no orders with me yet.';
      const app = await store.getApp(order.app_id).catch(() => null);
      const live = app && order.app_order_id
        ? await store.orderStatus(app, order.app_order_id).catch(() => null)
        : null;
      return (
        `Your last order (${fmtItems(order.items || [])}) — ` +
        `status: ${live || order.status}.` +
        (order.app_order_id ? ` Order ID: ${order.app_order_id}.` : ''));
    }

    // Answer a service-discovery question from the REGISTRY — the
    // apps actually registered (active) for the user's pincode.
    // Never from survey/visit data and never from the ai-helper:
    // the helper only decides that this is the question being asked.
    async function servicesReply(category) {
      const cats = category ? [category] : SERVICE_CATEGORIES;
      const groups = [];
      for (const c of cats) {
        const apps = await store.findApps(c, user.pincode).catch(() => []);
        if (apps && apps.length) groups.push({ c, apps });
      }
      if (!groups.length) {
        return category
          ? `No ${category} shops or services are registered with PA in your area (${user.pincode}) yet. I have noted it — PlotFarms will add services as they register.`
          : `No shops or services are registered with PA in your area (${user.pincode}) yet. I have noted it — PlotFarms will add services as they register.`;
      }
      const lines = groups.map(g =>
        `• ${CATEGORY_LABELS[g.c] || g.c}: ${g.apps.map(a => a.app_name).join(', ')}`);
      return `Registered with PA in your area (${user.pincode}):\n${lines.join('\n')}`;
    }

    // Resolve a question ABOUT PA (which shops are registered /
    // which shop fulfils this order) inside an open cart or quote:
    // dictionary lookup first, then the ai-helper — only the two
    // meta routes are accepted here, and a confident helper match is
    // learned exactly as at idle. Returns { req, entryId } or null.
    async function resolveMeta(rawText) {
      const det = parseMetaQuestion(rawText);
      if (det) return { req: det, entryId: null };
      if (!dictOn()) return null;
      const hit = await store.dictLookup(rawText).catch(() => null);
      if (hit && hit.request &&
          (hit.request.kind === 'services' || hit.request.kind === 'which_shop')) {
        return { req: hit.request, entryId: hit.entry && hit.entry.id };
      }
      if (store.dictMatch) {
        const match = await store.dictMatch(rawText).catch(() => null);
        if (match && (match.route === 'list_services' || match.route === 'which_shop') &&
            match.confidence >= dict.AUTO_ROUTE_CONFIDENCE) {
          let entryId = null;
          if (store.dictLearn) {
            const e = await store.dictLearn(rawText, match).catch(() => null);
            entryId = e && e.id;
          }
          return { req: match.request, entryId };
        }
      }
      return null;
    }

    // Dispatch one resolved request to its apps (registry + pincode,
    // then the app mode's flow). dictEntryId, when set, is the
    // dictionary entry that produced this request: it travels into
    // the pending confirmation so the user's YES/NO can promote or
    // demote the entry (query mode counts its hit at info delivery —
    // for a case question, the info IS the answer).
    async function dispatchRequest(req, dictEntryId) {
      const out = [];
      // Questions about PA itself (idle stage): answered from the
      // registry / the session — no app is contacted. (Inside an
      // open cart or quote the stage handlers answer these via
      // resolveMeta, with the cart/quote context attached.)
      if (req.kind === 'services') {
        out.push(await servicesReply(req.category || null));
        if (dictEntryId && store.dictRecordHit) {
          await store.dictRecordHit(dictEntryId).catch(() => {});
        }
        // Compound message ("I want to order vegetables — do you
        // have any shops available?"): the question is answered AND
        // the order starts collecting in the same reply.
        if (req.category && ORDER_CATEGORIES.includes(req.category) &&
            /\b(order|want|need|buy)\b/i.test(String(text || ''))) {
          session.stage = 'collecting';
          session.context = { cart: { category: req.category, items: [] } };
          await save(key, session);
          out.push(`Send me the ${req.category} items and I will get the prices.`);
        }
        return out;
      }
      if (req.kind === 'which_shop') {
        if (dictEntryId && store.dictRecordHit) {
          await store.dictRecordHit(dictEntryId).catch(() => {});
        }
        out.push(
          'You have no order in progress right now, so no shop is picked yet. ' +
          'When you order, I compare the registered shops in your area and ' +
          'the quote names the shop before you confirm.');
        return out;
      }
      const apps = await store.findApps(req.category, user.pincode);
      if (!apps.length) {
        await store.logRequest({
          channel, chatRef, userId: user.id, text, reason: 'no_service_found',
        }).catch(() => {});
        out.push(
          'No registered service for this is available in your area yet. ' +
          'I have noted your request — PlotFarms will add services as they register.');
        return out;
      }

      const app = apps[0];

      // Query mode (lawyer): basic information first, request on confirm.
      if (app.mode === 'query') {
        const answer = await store.checkAvailability(app, user, req.items);
        if (!answer) {
          out.push(`I could not reach ${app.app_name} right now. Please try again shortly.`);
          return out;
        }
        const info = answer.info || answer.note ||
          (answer.items || []).map(i =>
            `• ${i.name}: ${i.note || i.available || ''}`).join('\n');
        if (dictEntryId && store.dictRecordHit) {
          await store.dictRecordHit(dictEntryId).catch(() => {});
        }
        session.stage = 'awaiting_confirm';
        session.context = {
          pending: {
            kind: 'service_request', app_id: app.app_id, app_name: app.app_name,
            items: req.items, total: null, pa_request_id: newRequestId(),
          },
        };
        await save(key, session);
        out.push(
          `${info}\n\nIf you want me to send this request to ${app.app_name}, reply YES. Otherwise reply NO.`);
        return out;
      }

      // Booking mode (scheduler): availability = free slots.
      if (app.mode === 'booking') {
        const answer = await store.checkAvailability(app, user, req.items);
        const slots = (answer && (answer.slots ||
          (answer.items && answer.items[0] && answer.items[0].slots))) || [];
        if (!answer || !slots.length) {
          out.push(
            answer && answer.note ? answer.note
              : `No free slots are available with ${app.app_name} right now. Please try another day.`);
          return out;
        }
        session.stage = 'awaiting_slot';
        session.context = {
          pending: {
            kind: 'booking', app_id: app.app_id, app_name: app.app_name,
            service: req.items[0].name, slots,
            ...(dictEntryId ? { dict_entry_id: dictEntryId } : {}),
          },
        };
        await save(key, session);
        out.push(
          `Free slots with ${app.app_name}:\n` +
          slots.map((s, i) => `${i + 1}. ${s}`).join('\n') +
          '\n\nReply with the number to book, or NO to cancel.');
        return out;
      }

      // Mediated mode (ordering): quote from every app serving the
      // area, show the best, order only on confirmation.
      const quotes = [];
      for (const a of apps) {
        const answer = await store.checkAvailability(a, user, req.items);
        if (answer) quotes.push({ app: a, answer });
      }
      if (!quotes.length) {
        out.push('The stores could not be reached right now. Please try again shortly.');
        return out;
      }
      const best = pickBestQuote(quotes);
      if (!best) {
        const names = [...new Set(quotes.flatMap(q =>
          (q.answer.items || []).filter(i => i.available === 'no').map(i => i.name)))];
        out.push(
          `Not available right now: ${names.join(', ') || fmtItems(req.items)}. ` +
          'Please try again later or ask for something else.');
        return out;
      }
      session.stage = 'awaiting_confirm';
      session.context = {
        pending: {
          kind: 'order', category: req.category,
          app_id: best.app.app_id, app_name: best.app.app_name,
          items: best.answer.items.map(i => ({
            name: i.name, qty: i.qty, unit: i.unit, rate: i.rate,
          })),
          total: best.answer.total, pa_request_id: newRequestId(),
          ...(dictEntryId ? { dict_entry_id: dictEntryId } : {}),
        },
      };
      await save(key, session);
      const others = quotes.length > 1
        ? `\n(Compared ${quotes.length} stores for your area.)` : '';
      out.push(
        `${fmtQuote(best.app.app_name, best.answer)}${others}\n\n` +
        'Reply YES to place the order, or NO to cancel — ' +
        'or send more items to add to this order.');
      return out;
    }

    // Inside an open cart / order quote the category is already
    // known, so a SHORT item-shaped phrase ("1 kg dragon fruit")
    // counts as an item of that category even when the name is new
    // to the word lists — the store's answer decides availability.
    // Sentence-like text is refused here: it goes to the ai-helper
    // (resolveAdd) or is treated as not understood, never guessed
    // into an item ("...from teh list" is not a vegetable).
    const SENTENCE_WORDS = new Set(['from', 'list', 'want', 'modify',
      'change', 'please', 'the', "don't", 'dont', 'remove', 'delete',
      'drop', 'not', 'this', 'that', 'my']);
    function contextualItems(rawText, category) {
      if (!category) return null;
      const t = String(rawText || '').trim().toLowerCase();
      const words = t.split(/\s+/);
      if (words.length > 4) return null;
      if (words.some(w => SENTENCE_WORDS.has(w.replace(/[^a-z']/g, '')))) return null;
      const items = parseItems(t, category);
      return items.length ? { kind: 'request', category, items } : null;
    }

    // Resolve a would-be item addition inside an open cart / quote,
    // in order: (1) the route dictionary, (2) the ai-helper — when
    // PA does not understand, the helper decides whether the phrase
    // is a valid item request at all (only a confident order route
    // for THIS category is accepted, and a learned entry is saved
    // the same way as at idle), (3) the gated contextual parse.
    async function resolveAdd(rawText, category) {
      if (dictOn()) {
        const hit = await store.dictLookup(rawText).catch(() => null);
        if (hit && hit.request && hit.request.kind === 'request') return hit.request;
        if (store.dictMatch) {
          const match = await store.dictMatch(rawText).catch(() => null);
          if (match && match.route === 'order' &&
              match.confidence >= dict.AUTO_ROUTE_CONFIDENCE &&
              (!category || match.category === category)) {
            if (store.dictLearn) {
              await store.dictLearn(rawText, match).catch(() => null);
            }
            return match.request;
          }
        }
      }
      return contextualItems(rawText, category);
    }

    // Fold a fresh check_availability answer into a pending quote.
    function applyAnswerToPending(pending, answer) {
      const kept = (answer.items || [])
        .filter(i => i.available === 'yes' || i.available === 'partial');
      if (!kept.length) return false;
      pending.items = kept.map(i => ({
        name: i.name, qty: i.qty, unit: i.unit, rate: i.rate,
      }));
      pending.total = answer.total;
      return true;
    }

    // Route one resolved request: ordering categories first collect
    // the full list (cart) — no app is contacted until the user says
    // DONE; query and booking requests dispatch immediately.
    async function routeRequest(req, entryId) {
      if (req.kind !== 'request') return dispatchRequest(req, entryId);
      if (ORDER_CATEGORIES.includes(req.category)) {
        const cart = {
          category: req.category,
          items: mergeItems([], req.items),
          ...(entryId ? { dict_entry_id: entryId } : {}),
        };
        session.stage = 'collecting';
        session.context = { cart };
        await save(key, session);
        return [fmtCart(cart)];
      }
      return dispatchRequest(req, entryId);
    }

    // ---------- collecting the list (cart, ordering only) ----------
    if (session.stage === 'collecting') {
      const cart = session.context.cart || { category: null, items: [] };
      if (parsed.kind === 'cancel') {
        session.stage = 'idle'; session.context = {};
        await save(key, session);
        replies.push('Cancelled. Nothing was ordered.');
        return { replies };
      }
      if (parsed.kind === 'status') {
        replies.push(await statusReply());
        return { replies };
      }
      const doneText = DONE_WORDS.has(
        String(text || '').trim().toLowerCase().replace(/\s+/g, ' '));
      if (parsed.kind === 'confirm' || doneText) {
        if (!cart.items.length) {
          replies.push('Your list is empty — tell me the first item you need.');
          return { replies };
        }
        const req = { kind: 'request', category: cart.category, items: cart.items };
        const entryId = cart.dict_entry_id || null;
        session.stage = 'idle'; session.context = {};
        await save(key, session);
        replies.push(...await dispatchRequest(req, entryId));
        return { replies };
      }
      // A question about PA itself (registered shops / which shop
      // will fulfil this) is answered, not mistaken for an item —
      // the cart is preserved and re-shown.
      const metaC = await resolveMeta(text);
      if (metaC) {
        if (metaC.entryId && store.dictRecordHit) {
          await store.dictRecordHit(metaC.entryId).catch(() => {});
        }
        replies.push(metaC.req.kind === 'services'
          ? await servicesReply(metaC.req.category)
          : 'I have not picked a shop yet — when you say DONE I compare the shops serving your area and show you the best one with the prices.');
        replies.push(fmtCart(cart));
        return { replies };
      }
      const rem = parseRemoval(text, cart.items);
      if (rem) {
        const idx = findItemIndex(cart.items, rem.name);
        if (idx < 0) {
          replies.push(`There is no ${rem.name} in your list.
${fmtCart(cart)}`);
          return { replies };
        }
        const [gone] = cart.items.splice(idx, 1);
        if (!cart.items.length) {
          session.stage = 'idle'; session.context = {};
          await save(key, session);
          replies.push(`Removed ${gone.name} — your list is now empty, so the order is cancelled.`);
          return { replies };
        }
        session.context = { cart };
        await save(key, session);
        replies.push(`Removed ${gone.name} — ${gone.qty} ${gone.unit}.
${fmtCart(cart)}`);
        return { replies };
      }
      let addReq = parsed.kind === 'request' ? parsed : null;
      if (!addReq) addReq = await resolveAdd(text, cart.category);
      if (addReq) {
        if (cart.category && addReq.category !== cart.category) {
          replies.push(
            `That is a separate ${addReq.category} list — let us finish this ` +
            `${cart.category} order first (DONE to see prices, or NO to cancel), ` +
            'then I will take it.');
          return { replies };
        }
        cart.category = cart.category || addReq.category;
        cart.items = mergeItems(cart.items, addReq.items);
        session.context = { cart };
        await save(key, session);
        replies.push(fmtCart(cart));
        return { replies };
      }
      if (parsed.kind === 'greeting' || parsed.kind === 'help') {
        replies.push(fmtCart(cart));
        return { replies };
      }
      if (store.dictPropose) {
        await store.dictPropose(text).catch(() => {});
      }
      replies.push(`I could not pick an item out of that.
${fmtCart(cart)}`);
      return { replies };
    }

    // ---------- dictionary clarification (learning loop) ----------
    if (session.stage === 'awaiting_dict_clarify') {
      const pending = session.context.pending || {};
      if (parsed.kind === 'cancel') {
        session.stage = 'idle'; session.context = {};
        await save(key, session);
        if (pending.text && store.dictPropose) {
          await store.dictPropose(pending.text).catch(() => {});
        }
        replies.push('No problem — I have noted it for review. Anything else?');
        return { replies };
      }
      if (parsed.kind !== 'confirm' || !pending.request) {
        replies.push('Please reply YES to continue, or NO to cancel.');
        return { replies };
      }
      let entryId = null;
      if (store.dictLearn && pending.text && pending.match) {
        const e = await store.dictLearn(pending.text, pending.match).catch(() => null);
        entryId = e && e.id;
      }
      session.stage = 'idle'; session.context = {};
      await save(key, session);
      replies.push(...await routeRequest(pending.request, entryId));
      return { replies };
    }

    // ---------- pending confirmation (UC-07/08) ----------
    if (session.stage === 'awaiting_confirm') {
      const pending = session.context.pending || {};
      if (parsed.kind === 'cancel') {
        // A dictionary entry whose route ends in a cancel at the
        // confirmation misfired — demote it for owner review.
        if (pending.dict_entry_id && store.dictDemote) {
          await store.dictDemote(pending.dict_entry_id).catch(() => {});
        }
        session.stage = 'idle'; session.context = {};
        await save(key, session);
        replies.push('Cancelled. Nothing was ordered.');
        return { replies };
      }
      // A question about PA itself at the quote stage ("in which
      // shop are you planning to order it") is answered from the
      // pending quote — it must not fall into the YES/NO gate.
      if (parsed.kind !== 'confirm' && pending.kind === 'order') {
        const metaQ = await resolveMeta(text);
        if (metaQ) {
          if (metaQ.entryId && store.dictRecordHit) {
            await store.dictRecordHit(metaQ.entryId).catch(() => {});
          }
          const quoteText =
            `${fmtQuote(pending.app_name, { items: pending.items, total: pending.total })}\n\n` +
            'Reply YES to place the order, or NO to cancel — or send more items to add.';
          replies.push(metaQ.req.kind === 'which_shop'
            ? `This order will go to ${pending.app_name}.\n\n${quoteText}`
            : `${await servicesReply(metaQ.req.category)}\n\nYour current quote:\n${quoteText}`);
          return { replies };
        }
      }
      // Remove an item from the shown quote: drop it and re-check
      // the rest with the same app, so rates and the total stay live.
      const remQ = parsed.kind !== 'confirm' && pending.kind === 'order'
        ? parseRemoval(text, pending.items) : null;
      if (remQ) {
        const idx = findItemIndex(pending.items, remQ.name);
        if (idx < 0) {
          replies.push(
            `There is no ${remQ.name} in this order. Reply YES to place it, ` +
            'NO to cancel, or name an item to add or remove.');
          return { replies };
        }
        const rest = (pending.items || [])
          .filter((_, i) => i !== idx)
          .map(i => ({ name: i.name, qty: i.qty, unit: i.unit }));
        if (!rest.length) {
          session.stage = 'idle'; session.context = {};
          await save(key, session);
          replies.push('Removed the last item — the order is cancelled. Nothing was ordered.');
          return { replies };
        }
        const app = await store.getApp(pending.app_id);
        const answer = app
          ? await store.checkAvailability(app, user, rest).catch(() => null)
          : null;
        if (!answer || !applyAnswerToPending(pending, answer)) {
          replies.push(
            `I could not reach ${pending.app_name} just now — your quote is unchanged.

` +
            `${fmtQuote(pending.app_name, { items: pending.items, total: pending.total })}

` +
            'Reply YES to place the order, or NO to cancel — or send more items to add.');
          return { replies };
        }
        session.context = { pending };
        await save(key, session);
        replies.push(
          `Removed ${remQ.name}.
${fmtQuote(pending.app_name, answer)}

` +
          'Reply YES to place the order, or NO to cancel — or send more items to add.');
        return { replies };
      }
      // Add-more at the quote stage (order quotes only): merge the
      // new items into the pending list and re-check the whole list
      // with the SAME app that won the quote. An item the store does
      // not have is named and left out; the rest of the quote stands.
      if (parsed.kind !== 'confirm' && pending.kind === 'order') {
        let addReq = parsed.kind === 'request' ? parsed : null;
        if (!addReq && parsed.kind === 'unknown') {
          addReq = await resolveAdd(text, pending.category);
        }
        if (addReq) {
          if (pending.category && addReq.category !== pending.category) {
            replies.push(
              `That belongs to a separate ${addReq.category} order — let us ` +
              'finish this one first: YES to place it, or NO to cancel.');
            return { replies };
          }
          const app = await store.getApp(pending.app_id);
          const merged = mergeItems(
            (pending.items || []).map(i => ({ name: i.name, qty: i.qty, unit: i.unit })),
            addReq.items);
          const answer = app
            ? await store.checkAvailability(app, user, merged).catch(() => null)
            : null;
          if (!answer) {
            replies.push(
              `I could not reach ${pending.app_name} just now — your quote is unchanged.

` +
              `${fmtQuote(pending.app_name, { items: pending.items, total: pending.total })}

` +
              'Reply YES to place the order, or NO to cancel — or send more items to add.');
            return { replies };
          }
          const newNames = new Set(addReq.items.map(i => i.name));
          const dropped = (answer.items || [])
            .filter(i => i.available === 'no' && newNames.has(i.name))
            .map(i => i.name);
          if (!applyAnswerToPending(pending, answer)) {
            replies.push(
              `${pending.app_name} cannot fulfil this order right now — ` +
              'please try again later, or NO to cancel.');
            return { replies };
          }
          session.context = { pending };
          await save(key, session);
          const note = dropped.length
            ? `${dropped.join(', ')} is not available at ${pending.app_name}.

` : '';
          replies.push(
            `${note}${fmtQuote(pending.app_name, answer)}

` +
            'Reply YES to place the order, or NO to cancel — or send more items to add.');
          return { replies };
        }
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
      // Clean hit: the user confirmed the dictionary-routed request
      // and it was placed.
      if (pending.dict_entry_id && store.dictRecordHit) {
        await store.dictRecordHit(pending.dict_entry_id).catch(() => {});
      }
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
        if (pending.dict_entry_id && store.dictDemote) {
          await store.dictDemote(pending.dict_entry_id).catch(() => {});
        }
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
      if (pending.dict_entry_id && store.dictRecordHit) {
        await store.dictRecordHit(pending.dict_entry_id).catch(() => {});
      }
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
      replies.push(await statusReply());
      return { replies };
    }

    // ---------- a real request (UC-04/05/06) ----------
    let req = parsed;
    let dictEntryId = null;

    // Dictionary learning loop (migration 025, src/dictionary.js):
    // only phrases the rule parser could not place reach it. A
    // dictionary hit becomes the request; on a miss the ai-helper
    // match step may route + learn (>= 0.85), ask one clarifying
    // question (0.60-0.85), or leave a proposal (< 0.60) — then the
    // pre-existing fallbacks below continue unchanged.
    if (req.kind === 'unknown') {
      const det = parseMetaQuestion(text);
      if (det) {
        req = det;
        // The phrase is understood, so it also joins the dictionary
        // (probationary, like a helper match) — the learning loop
        // sees every understood phrasing, whichever net caught it.
        if (dictOn() && store.dictLearn) {
          const e = await store.dictLearn(text, {
            route: det.kind === 'services' ? 'list_services' : 'which_shop',
            category: det.category || null, items: [], confidence: 1,
          }).catch(() => null);
          dictEntryId = e && e.id;
        }
      }
    }
    if (req.kind === 'unknown' && dictOn()) {
      const hit = await store.dictLookup(text).catch(() => null);
      if (hit && hit.request) {
        req = hit.request;
        dictEntryId = hit.entry && hit.entry.id;
        if (req.kind === 'status') {
          replies.push(await statusReply());
          if (dictEntryId && store.dictRecordHit) {
            await store.dictRecordHit(dictEntryId).catch(() => {});
          }
          return { replies };
        }
      } else if (store.dictMatch) {
        const match = await store.dictMatch(text).catch(() => null);
        if (match && match.confidence >= dict.AUTO_ROUTE_CONFIDENCE) {
          const e = store.dictLearn
            ? await store.dictLearn(text, match).catch(() => null) : null;
          req = match.request;
          dictEntryId = e && e.id;
        } else if (match && match.confidence >= dict.CLARIFY_CONFIDENCE) {
          session.stage = 'awaiting_dict_clarify';
          session.context = {
            pending: {
              text: String(text || ''),
              match: {
                route: match.route, category: match.category,
                items: match.items, confidence: match.confidence,
              },
              request: match.request,
            },
          };
          await save(key, session);
          replies.push(
            `Did you mean: ${dict.describeRoute(match)}? ` +
            'Reply YES to continue, or NO to cancel.');
          return { replies };
        } else if (store.dictPropose) {
          await store.dictPropose(text).catch(() => {});
        }
      }
    }
    if (req.kind === 'unknown' && store.understand) {
      const ai = await store.understand(String(text || '')).catch(() => null);
      if (ai && ai.category && Array.isArray(ai.items) && ai.items.length) {
        req = { kind: 'request', category: ai.category, items: ai.items };
      }
    }
    if (req.kind === 'services' || req.kind === 'which_shop') {
      replies.push(...await dispatchRequest(req, dictEntryId));
      return { replies };
    }
    if (req.kind !== 'request') {
      await store.logRequest({
        channel, chatRef, userId: user.id, text, reason: 'not_understood',
      }).catch(() => {});
      replies.push(`I did not understand that.\n\n${MENU}`);
      return { replies };
    }

    replies.push(...await routeRequest(req, dictEntryId));
    return { replies };

  }

  // For channel layers that share one bot between two audiences
  // (telegram.js: employees linked to the survey app + PA users).
  // True when this message belongs to the PA consumer flow: a fresh
  // PA request or status question, or any reply inside a PA flow this
  // chat already started (registration, quote confirmation, slot
  // pick). Everything else stays with the other audience's handler.
  async function shouldHandle({ channel, chatRef, text }) {
    // Service-discovery questions belong to PA even on a shared bot:
    // a narrow keyword bridge for the split (the other audience's
    // visit/survey questions are vetoed inside the check), plus any
    // phrase the route dictionary has learned — a DB read, no AI
    // call on the split path.
    if (looksLikeServicesQuestion(text)) return true;
    if (parseMetaQuestion(text)) return true;
    const parsed = parseRequest(text);
    if (parsed.kind === 'request' || parsed.kind === 'status') return true;
    if (typeof store.dictLookup === 'function') {
      const hit = await store.dictLookup(text).catch(() => null);
      if (hit) return true;
    }
    const session = await store.getSession(`${channel}:${chatRef}`)
      .catch(() => null);
    if (!session) return false;
    if (session.stage === 'awaiting_confirm' ||
        session.stage === 'awaiting_slot' ||
        session.stage === 'collecting' ||
        session.stage === 'awaiting_dict_clarify') return true;
    return session.stage === 'registering' &&
      !!(session.context && session.context.reg);
  }

  return { handleMessage, shouldHandle };
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
    // Dictionary learning loop (migration 025) — every method
    // degrades to a miss/no-op until the migration is applied.
    ...dict.makeDictionary(pool, { parseItems }),
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
module.exports.looksLikeServicesQuestion = looksLikeServicesQuestion;
module.exports.parseMetaQuestion = parseMetaQuestion;
module.exports.fuzzyItem = fuzzyItem;
module.exports.parseRequest = parseRequest;
module.exports.parseItems = parseItems;
module.exports.pickBestQuote = pickBestQuote;
