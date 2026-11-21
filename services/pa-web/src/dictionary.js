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
    return { 