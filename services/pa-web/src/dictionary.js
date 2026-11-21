'use strict';
/*
 * PA dictionary — the learning loop for ROUTES (migration 025).
 *
 * Same mechanism as the VegiBot dictionary, adapted to the front door:
 * VegiBot's entries map a phrase to one of the store's own procedures;
 * PA's entries map a phrase to a ROUTE — { category, intent, item
 * template }. An entry never names a destination app: which store or
 * office serves the request is still decided live by the registry, the
 * user's registered pincode, and the best quote. A learned entry can
 * only decide WHERE TO ASK — prices, stock, slots and case facts still
 * come live from the app, and nothing is ordered until the user
 * confirms, exactly as without the dictionary.
 *
 * Flow (router.js, idle stage, registered consumer users only):
 *   1. The rule parser runs first for everything it knows. Only a
 *      message it returns as 'unknown' reaches the dictionary.
 *   2. Dictionary lookup on the normalized pattern. A hit (active, or
 *      probationary — every PA route is self-confirming, so
 *      probationary entries may fire) becomes the request.
 *   3. On a miss, the ai-helper match step: it receives the text plus
 *      the route SIGNATURES only (never the dictionary table) and must
 *      answer strictly { intent, entities, confidence }.
 *        >= 0.85  route it, and learn the phrase as probationary
 *        0.60–0.85 ask ONE clarifying question; route/learn only on YES
 *        < 0.60   no route — a proposal is saved for owner review and
 *                 the router's existing fallbacks continue
 *   4. Promotion/demotion is driven by PA's own confirmation step,
 *      the strongest signal available: a probationary entry whose
 *      routed request the user CONFIRMS (order placed / request sent)
 *      counts a clean hit — 3 clean hits promote it to active. A user
 *      cancelling at that confirmation demotes a learned entry to
 *      pending_review for the owner. Manual (seed) entries are never
 *      demoted.
 *
 * The router is the only writer. The ai-helper proposes; this module
 * validates and saves. Every store method swallows its errors and
 * degrades to "no dictionary": if migration 025 has not been applied
 * or the DB hiccups, the router behaves exactly as before.
 * PA_DICTIONARY_ENABLED=false turns the whole loop off.
 */

const PROMOTE_AFTER_HITS = 3;
const AUTO_ROUTE_CONFIDENCE = 0.85;
const CLARIFY_CONFIDENCE = 0.60;

// The route allowlist — the ONLY things a dictionary entry or an
// ai-helper match may produce. Signatures are what the helper sees.
const ROUTES = [
  {
    intent: 'order',
    params: 'entities: { category: "vegetables" | "cloth", items: [{ name, qty, unit }] } — the user wants to order products from a store',
  },
  {
    intent: 'service_query',
    params: 'entities: { category: "legal" } — the user wants basic information from the lawyer (case status, next hearing) or a consultation',
  },
  {
    intent: 'book',
    params: 'entities: { category: "appointment", service: string } — the user wants to book an appointment (doctor / clinic)',
  },
  {
    intent: 'order_status',
    params: 'entities: {} — the user asks about the status of their last order or booking',
  },
  {
    intent: 'list_services',
    params: 'entities: { category?: "vegetables" | "cloth" | "legal" | "appointment" } — the user asks WHICH shops or services are registered / available with PA (list the shops, what shops are there, where can I shop, do you have any shops). Questions about PA itself, not an order. Omit category when they ask about all shops/services.',
  },
  {
    intent: 'which_shop',
    params: 'entities: {} — the user asks WHICH shop or store will fulfil (or is fulfilling) their order — "in which shop are you planning to order it", "which store will deliver this". A question about the current order, not a new order.',
  },
];
const ROUTE_NAMES = ROUTES.map(r => r.intent);

// ---------------------------------------------------------------------
// Normalization — quantities and dates are entities, not identity:
// "2 kg mirchi" and "5 kg mirchi" are the same route shape. Digits and
// dates mask to '#', punctuation is stripped, case folded. The SAME
// function normalizes stored patterns and incoming messages, so a
// lookup is a plain equality. (PA has no Telugu number-word tables —
// digit masking only; learned entries cover the rest over time.)
// ---------------------------------------------------------------------

function normalizePattern(text) {
  let t = String(text || '').toLowerCase();
  t = t.replace(/\d{4}-\d{1,2}-\d{1,2}/g, ' # ');
  t = t.replace(/\d+(?:\.\d+)?/g, ' # ');
  t = t.replace(/[^\p{L}\p{N}\s#]/gu, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/(#\s)+#/g, '#');
  return t;
}

// ---------------------------------------------------------------------
// Match validation — an ai-helper answer is DATA, never trusted
// blindly. Returns { route, category, items, confidence, request } or
// null. `request` is in the router's parseRequest output shape.
// ---------------------------------------------------------------------

function cleanItem(i, category) {
  if (!i || typeof i !== 'object') return null;
  const name = String(i.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!name || name.length > 60) return null;
  const qty = Number(i.qty);
  const unit = String(i.unit || '').trim().toLowerCase().slice(0, 16) ||
    (category === 'cloth' ? 'piece' : 'kg');
  return {
    name,
    qty: Number.isFinite(qty) && qty > 0 && qty <= 10000 ? qty : 1,
    unit,
  };
}

function validateMatch(d) {
  if (!d || typeof d !== 'object') return null;
  const route = String(d.intent || '');
  if (!ROUTE_NAMES.includes(route)) return null;
  const confidence = Number(d.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  const e = (d.entities && typeof d.entities === 'object') ? d.entities : {};

  if (route === 'order_status') {
    return { route, category: null, items: [], confidence, request: { kind: 'status' } };
  }
  if (route === 'list_services') {
    // Category is optional (all services) but must be a real one.
    if (e.category !== undefined &&
        !['vegetables', 'cloth', 'legal', 'appointment'].includes(e.category)) return null;
    const category = e.category || null;
    return { route, category, items: [], confidence, request: { kind: 'services', category } };
  }
  if (route === 'which_shop') {
    return { route, category: null, items: [], confidence, request: { kind: 'which_shop' } };
  }
  if (route === 'service_query') {
    if (e.category !== undefined && e.category !== 'legal') return null;
    const items = [{ name: 'consultation', qty: 1, unit: 'service' }];
    return { route, category: 'legal', items, confidence, request: { kind: 'request', category: 'legal', items } };
  }
  if (route === 'book') {
    if (e.category !== undefined && e.category !== 'appointment') return null;
    const svc = String(e.service || 'appointment').trim().toLowerCase().slice(0, 60) || 'appointment';
    const items = [{ name: svc, qty: 1, unit: 'service' }];
    return { route, category: 'appointment', items, confidence, request: { kind: 'request', category: 'appointment', items } };
  }
  // route === 'order'
  if (!['vegetables', 'cloth'].includes(e.category)) return null;
  if (!Array.isArray(e.items) || !e.items.length) return null;
  const items = e.items.map(i => cleanItem(i, e.category)).filter(Boolean);
  if (!items.length) return null;
  return { route, category: e.category, items, confidence, request: { kind: 'request', category: e.category, items } };
}

// Item template stored on an entry: names + units, NO quantities —
// quantities are re-read from the live message when the entry fires.
function templateOf(items) {
  return (items || []).map(i => ({ name: i.name, unit: i.unit }));
}

// Build the router request for a firing entry. Quantities come from
// the live message (the router's own parseItems), restricted to the
// template's item names when a template exists.
function buildRequest(entry, text, parseItems) {
  if (!entry) return null;
  if (entry.route === 'order_status') return { kind: 'status' };
  if (entry.route === 'list_services') {
    return { kind: 'services', category: entry.category || null };
  }
  if (entry.route === 'which_shop') return { kind: 'which_shop' };
  if (entry.route === 'service_query') {
    return { kind: 'request', category: 'legal', items: [{ name: 'consultation', qty: 1, unit: 'service' }] };
  }
  if (entry.route === 'book') {
    const t0 = (entry.items_template || [])[0] || {};
    return { kind: 'request', category: 'appointment', items: [{ name: t0.name || 'appointment', qty: 1, unit: 'service' }] };
  }
  if (entry.route !== 'order') return null;
  const category = entry.category;
  if (!['vegetables', 'cloth'].includes(category)) return null;
  let items = [];
  try { items = parseItems(String(text || '').toLowerCase(), category) || []; } catch { items = []; }
  const tmpl = Array.isArray(entry.items_template) ? entry.items_template : [];
  if (tmpl.length) {
    const names = new Set(tmpl.map(i => String(i.name || '').toLowerCase()));
    const matched = items.filter(i => names.has(String(i.name).toLowerCase()));
    if (matched.length) items = matched;
  }
  if (!items.length) {
    items = tmpl.map(i => ({
      name: i.name, qty: 1, unit: i.unit || (category === 'cloth' ? 'piece' : 'kg'),
    }));
  }
  if (!items.length) return null;
  return { kind: 'request', category, items };
}

// One line for the clarifying question.
function describeRoute(m) {
  if (!m) return 'that';
  if (m.route === 'order') {
    const items = (m.items || []).map(i => `${i.qty} ${i.unit} ${i.name}`).join(', ');
    return `ordering ${items}`;
  }
  if (m.route === 'service_query') return 'asking the lawyer about your case / a consultation';
  if (m.route === 'book') return `booking an appointment (${(m.items[0] || {}).name || 'appointment'})`;
  if (m.route === 'order_status') return 'checking your last order status';
  if (m.route === 'list_services') {
    return m.category
      ? `listing the ${m.category} shops registered in your area`
      : 'listing the shops and services registered in your area';
  }
  if (m.route === 'which_shop') return 'telling you which shop this order goes to';
  return 'that';
}

// ---------------------------------------------------------------------
// ai-helper match step — same endpoint family as the router's loose
// understand() escalation, but the strict Textiles contract: the
// helper receives { text, signatures } and must return
// { intent, entities, confidence }. Never throws; null = no match.
// ---------------------------------------------------------------------

async function matchWithHelper(text) {
  const url = process.env.AI_HELPER_URL || '';
  if (!url) return null;
  try {
    const r = await fetch(url.replace(/\/$/, '') + '/understand', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: String(text || ''), signatures: ROUTES }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    return validateMatch(d);
  } catch { return null; }
}

// ---------------------------------------------------------------------
// Postgres store — plugged into the router's store by registerRouter.
// ---------------------------------------------------------------------

const appRegistry = require('./appRegistry');

function makeDictionary(pool, { parseItems }) {
  const q = (sql, params) => pool.query(sql, params);

  return {
    // Normalized lookup. Returns { entry, request } or null (miss, a
    // non-fireable status, or ANY error — a miss is always safe).
    async dictLookup(text) {
      const pattern = normalizePattern(text);
      if (!pattern) return null;
      try {
        const r = await q(
          'SELECT * FROM pa.dictionary_entry WHERE pattern = $1', [pattern]);
        const entry = r.rows[0];
        if (!entry) return null;
        if (entry.status !== 'active' && entry.status !== 'probationary') return null;
        const request = buildRequest(entry, text, parseItems);
        if (!request) return null;
        return { entry, request };
      } catch (e) {
        console.error('[pa-dictionary] lookup failed (degrading to miss):', e.message);
        return null;
      }
    },

    // The strict ai-helper match (signatures only).
    async dictMatch(text) { return matchWithHelper(text); },

    // Save a validated match as a new probationary entry. Returns the
    // entry (existing or new), or null on any failure.
    async dictLearn(text, match) {
      const pattern = normalizePattern(text);
      if (!pattern || !match) return null;
      try {
        const existing = await q(
          'SELECT * FROM pa.dictionary_entry WHERE pattern = $1', [pattern]);
        if (existing.rows[0]) return existing.rows[0];
        const r = await q(
          `INSERT INTO pa.dictionary_entry
             (pattern, route, category, items_template, status, source, confidence)
           VALUES ($1,$2,$3,$4,'probationary','learned',$5)
           ON CONFLICT (pattern) DO NOTHING RETURNING *`,
          [pattern, match.route, match.category,
           JSON.stringify(templateOf(match.items)), match.confidence]);
        if (r.rows[0]) {
          console.log(`[pa-dictionary] learned: "${pattern}" -> ${match.route} (confidence ${match.confidence})`);
          return r.rows[0];
        }
        const again = await q(
          'SELECT * FROM pa.dictionary_entry WHERE pattern = $1', [pattern]);
        return again.rows[0] || null;
      } catch (e) {
        console.error('[pa-dictionary] learn failed:', e.message);
        return null;
      }
    },

    // A clean hit: the user confirmed the routed request and it was
    // placed. Promotes probationary -> active at PROMOTE_AFTER_HITS.
    async dictRecordHit(id) {
      if (!id) return;
      try {
        await q(
          `UPDATE pa.dictionary_entry
           SET hit_count = hit_count + 1, last_used_at = now(), updated_at = now(),
               status = CASE WHEN status = 'probationary' AND hit_count + 1 >= $2
                             THEN 'active' ELSE status END
           WHERE id = $1`,
          [id, PROMOTE_AFTER_HITS]);
      } catch (e) {
        console.error('[pa-dictionary] recordHit failed:', e.message);
      }
    },

    // A misfire: the user cancelled at the confirmation the entry's
    // route produced. Learned entries drop to pending_review for the
    // owner and must re-earn promotion; manual entries never demote.
    async dictDemote(id) {
      if (!id) return;
      try {
        await q(
          `UPDATE pa.dictionary_entry
           SET status = 'pending_review', hit_count = 0, updated_at = now()
           WHERE id = $1 AND source <> 'manual'`,
          [id]);
      } catch (e) {
        console.error('[pa-dictionary] demote failed:', e.message);
      }
    },

    // No route matched at all — save for owner review. This is the
    // ONLY output of the "new capability" path: nothing is coded,
    // registered or executed from a proposal.
    async dictPropose(text) {
      const pattern = normalizePattern(text);
      if (!pattern) return;
      try {
        await q(
          'INSERT INTO pa.dictionary_proposal (raw_text, pattern) VALUES ($1,$2)',
          [String(text || '').slice(0, 500), pattern]);
      } catch (e) {
        console.error('[pa-dictionary] propose failed:', e.message);
      }
    },
  };
}
module.exports = {
  makeDictionary,
  normalizePattern,
  validateMatch,
  buildRequest,
  templateOf,
  describeRoute,
  matchWithHelper,
  ROUTES,
  PROMOTE_AFTER_HITS,
  AUTO_ROUTE_CONFIDENCE,
  CLARIFY_CONFIDENCE,
};
