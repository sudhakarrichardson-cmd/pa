'use strict';
/*
 * PA dictionary learning loop — tests (no DB, no network).
 * Run: node tests/pa-dictionary.test.js
 *
 * Units: normalizePattern / validateMatch / buildRequest from
 * src/dictionary.js. Flows: createRouter with an in-memory store whose
 * dict* methods compose the module's pure functions (the SQL layer in
 * makeDictionary is a thin shell over the same contract):
 *   - seed-style hit routes without any ai-helper call
 *   - ai-helper match >= 0.85 routes + learns; YES at confirm = clean hit
 *   - NO at confirm demotes the learned entry
 *   - 0.60-0.85 asks one clarifying question; YES learns + routes
 *   - < 0.60 leaves a proposal and falls back to "did not understand"
 *   - PA_DICTIONARY_ENABLED=false restores old behavior exactly
 *   - a store without dict methods behaves exactly as before
 */
const assert = require('assert');
const { createRouter, parseItems } = require('../services/pa-web/src/router');
const dict = require('../services/pa-web/src/dictionary');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS  ' + name); }
  catch (e) { failures++; console.log('FAIL  ' + name + ' — ' + e.message); }
}
async function checkAsync(name, fn) {
  try { await fn(); console.log('PASS  ' + name); }
  catch (e) { failures++; console.log('FAIL  ' + name + ' — ' + e.message); }
}

// ---------------- units ----------------
check('normalize: quantities and punctuation mask away', () => {
  assert.equal(dict.normalizePattern('2 kg Mirchi!'), '# kg mirchi');
  assert.equal(dict.normalizePattern('5.5 kg tomato'), '# kg tomato');
  assert.equal(dict.normalizePattern('ullipaya'), 'ullipaya');
  assert.equal(dict.normalizePattern('on 2026-11-20 please'), 'on # please');
});
check('validateMatch: good order match', () => {
  const m = dict.validateMatch({
    intent: 'order', confidence: 0.9,
    entities: { category: 'vegetables', items: [{ name: 'Coriander', qty: 1, unit: 'kg' }] },
  });
  assert.equal(m.route, 'order');
  assert.deepEqual(m.request.items, [{ name: 'coriander', qty: 1, unit: 'kg' }]);
});
check('validateMatch: order to a non-store category is rejected', () => {
  assert.equal(dict.validateMatch({
    intent: 'order', confidence: 0.9,
    entities: { category: 'legal', items: [{ name: 'x', qty: 1, unit: 'kg' }] },
  }), null);
});
check('validateMatch: bad intent / bad confidence rejected', () => {
  assert.equal(dict.validateMatch({ intent: 'teleport', confidence: 0.9, entities: {} }), null);
  assert.equal(dict.validateMatch({ intent: 'book', confidence: 'high', entities: {} }), null);
  assert.equal(dict.validateMatch(null), null);
});
check('validateMatch: book + order_status shapes', () => {
  const b = dict.validateMatch({ intent: 'book', confidence: 0.8, entities: { service: 'Dental checkup' } });
  assert.deepEqual(b.request, { kind: 'request', category: 'appointment', items: [{ name: 'dental checkup', qty: 1, unit: 'service' }] });
  const s = dict.validateMatch({ intent: 'order_status', confidence: 0.8, entities: {} });
  assert.deepEqual(s.request, { kind: 'status' });
});
check('buildRequest: template filters live items, quantities stay live', () => {
  const entry = { route: 'order', category: 'vegetables', items_template: [{ name: 'mirchi', unit: 'kg' }] };
  const r = dict.buildRequest(entry, '5 kg mirchi and 2 kg tomato', parseItems);
  assert.deepEqual(r.items, [{ name: 'mirchi', qty: 5, unit: 'kg' }]);
  const r2 = dict.buildRequest(entry, 'mirchi kavali', parseItems);
  assert.equal(r2.items[0].name, 'mirchi');
});

// ---------------- fake world ----------------
function makeWorld({ withDict = true, matchScript = {} } = {}) {
  const users = new Map(); const byRef = new Map();
  const sessions = new Map(); const orders = new Map(); const logs = [];
  let nextId = 1;
  const veg = { app_id: 'veg-a', app_name: 'Veg Store A', mode: 'mediated' };
  const sched = { app_id: 'scheduler', app_name: 'Kavali Dental', mode: 'booking' };
  const lawyer = { app_id: 'helplawyer', app_name: 'HelpLawyer', mode: 'query' };
  const allApps = [veg, sched, lawyer];

  const calls = { lookup: 0, learn: [], hits: [], demotes: [], proposes: [] };
  const entries = new Map(); // pattern -> entry
  let nextEntryId = 1;
  entries.set('ullipaya', {
    id: nextEntryId++, pattern: 'ullipaya', route: 'order', category: 'vegetables',
    items_template: [{ name: 'onion', unit: 'kg' }], status: 'active', source: 'manual', hit_count: 0,
  });

  const store = {
    async getUserById(id) { return users.get(id) || null; },
    async getUserByRef(channel, ref) {
      const id = byRef.get(`${channel}:${ref}`);
      return id ? users.get(id) : null;
    },
    async createUser({ name, address, pincode, channel, chatRef }) {
      const u = { id: nextId++, name, address, pincode, phone: null };
      users.set(u.id, u); byRef.set(`${channel}:${chatRef}`, u.id);
      return u;
    },
    async getSession(key) { return sessions.get(key) || null; },
    async saveSession(key, s) { sessions.set(key, JSON.parse(JSON.stringify(s))); },
    async findApps(category) {
      if (category === 'vegetables') return [veg];
      if (category === 'appointment') return [sched];
      if (category === 'legal') return [lawyer];
      return [];
    },
    async getApp(appId) { return allApps.find(a => a.app_id === appId) || null; },
    async checkAvailability(app, user, items) {
      if (app.mode === 'booking') return { items, slots: ['2026-11-20 10:00'] };
      if (app.mode === 'query') return { items, info: 'Your case OS/7/2024 — next hearing 2026-11-19.' };
      const out = items.map(i => ({ ...i, rate: 50, amount: 50 * i.qty, available: 'yes', available_qty: i.qty }));
      return { items: out, total: out.reduce((s, i) => s + i.amount, 0) };
    },
    async placeOrder(app) {
      return { app_order_id: app.app_id + '-1001', status: app.mode === 'booking' ? 'booked' : 'placed', total: 50 };
    },
    async orderStatus() { return 'placed'; },
    async recordOrder(o) { if (!orders.has(o.paRequestId)) orders.set(o.paRequestId, o); },
    async findOrder(id) { return orders.get(id) || null; },
    async latestOrder(userId) {
      const mine = [...orders.values()].filter(o => o.userId === userId);
      return mine[mine.length - 1] || null;
    },
    async logRequest(e) { logs.push(e); },
  };

  if (withDict) {
    Object.assign(store, {
      async dictLookup(text) {
        calls.lookup++;
        const entry = entries.get(dict.normalizePattern(text));
        if (!entry || (entry.status !== 'active' && entry.status !== 'probationary')) return null;
        const request = dict.buildRequest(entry, text, parseItems);
        return request ? { entry, request } : null;
      },
      async dictMatch(text) {
        const raw = matchScript[text];
        return raw ? dict.validateMatch(raw) : null;
      },
      async dictLearn(text, match) {
        const pattern = dict.normalizePattern(text);
        calls.learn.push(pattern);
        if (!entries.has(pattern)) {
          entries.set(pattern, {
            id: nextEntryId++, pattern, route: match.route, category: match.category,
            items_template: dict.templateOf(match.items), status: 'probationary',
            source: 'learned', hit_count: 0,
          });
        }
        return entries.get(pattern);
      },
      async dictRecordHit(id) { calls.hits.push(id); },
      async dictDemote(id) { calls.demotes.push(id); },
      async dictPropose(text) { calls.proposes.push(text); },
    });
  }
  return { store, orders, logs, calls, entries };
}

async function register(router, ref) {
  const say = text => router.handleMessage({ channel: 'telegram', chatRef: ref, text });
  await say('hi');
  await say('Test User');
  await say('MG Road, Kavali');
  await say('523001');
  return say;
}

// ---------------- flows ----------------
async function run() {
  await checkAsync('seed hit: "ullipaya" routes to a quote with no ai-helper', async () => {
    const w = makeWorld();
    const router = createRouter(w.store);
    const say = await register(router, '111');
    const r = await say('ullipaya');
    assert.ok(r.replies.join(' ').includes('onion'), r.replies.join(' '));
    assert.ok(r.replies.join(' ').includes('Your list so far'), r.replies.join(' '));
    const q = await say('done');
    assert.ok(q.replies.join(' ').includes('Veg Store A'), q.replies.join(' '));
    assert.equal(w.calls.lookup, 1);
    assert.equal(w.calls.learn.length, 0);
  });

  await checkAsync('learn >= 0.85: routes, learns, YES at confirm records a clean hit', async () => {
    const w = makeWorld({
      matchScript: {
        'kothimeera kavali': {
          intent: 'order', confidence: 0.92,
          entities: { category: 'vegetables', items: [{ name: 'coriander', qty: 1, unit: 'kg' }] },
        },
      },
    });
    const router = createRouter(w.store);
    const say = await register(router, '222');
    const r = await say('kothimeera kavali');
    assert.ok(r.replies.join(' ').includes('coriander'), r.replies.join(' '));
    assert.deepEqual(w.calls.learn, ['kothimeera kavali']);
    const entry = w.entries.get('kothimeera kavali');
    assert.equal(entry.status, 'probationary');
    const q = await say('done');
    assert.ok(q.replies.join(' ').includes('Reply YES to place the order'), q.replies.join(' '));
    const yes = await say('yes');
    assert.ok(yes.replies.join(' ').includes('Order placed'), yes.replies.join(' '));
    assert.deepEqual(w.calls.hits, [entry.id]);
    assert.equal(w.calls.demotes.length, 0);
    assert.equal(w.orders.size, 1);
  });

  await checkAsync('NO at confirm demotes the learned entry', async () => {
    const w = makeWorld({
      matchScript: {
        'kothimeera kavali': {
          intent: 'order', confidence: 0.92,
          entities: { category: 'vegetables', items: [{ name: 'coriander', qty: 1, unit: 'kg' }] },
        },
      },
    });
    const router = createRouter(w.store);
    const say = await register(router, '333');
    await say('kothimeera kavali');
    const entry = w.entries.get('kothimeera kavali');
    await say('done');
    const no = await say('no');
    assert.ok(no.replies.join(' ').includes('Cancelled'), no.replies.join(' '));
    assert.deepEqual(w.calls.demotes, [entry.id]);
    assert.equal(w.calls.hits.length, 0);
    assert.equal(w.orders.size, 0);
  });

  await checkAsync('clarify band: asks once, YES learns + routes (query counts hit at info)', async () => {
    const w = makeWorld({
      matchScript: {
        'naa pani vishayam': { intent: 'service_query', confidence: 0.7, entities: { category: 'legal' } },
      },
    });
    const router = createRouter(w.store);
    const say = await register(router, '444');
    const r = await say('naa pani vishayam');
    assert.ok(r.replies.join(' ').includes('Did you mean'), r.replies.join(' '));
    assert.equal(w.calls.learn.length, 0);
    const yes = await say('yes');
    assert.ok(yes.replies.join(' ').includes('next hearing 2026-11-19'), yes.replies.join(' '));
    assert.deepEqual(w.calls.learn, ['naa pani vishayam']);
    assert.equal(w.calls.hits.length, 1); // query: info delivered = clean
  });

  await checkAsync('clarify band: NO leaves a proposal, routes nothing', async () => {
    const w = makeWorld({
      matchScript: {
        'naa pani vishayam': { intent: 'service_query', confidence: 0.7, entities: { category: 'legal' } },
      },
    });
    const router = createRouter(w.store);
    const say = await register(router, '555');
    await say('naa pani vishayam');
    const no = await say('no');
    assert.ok(no.replies.join(' ').includes('noted it for review'), no.replies.join(' '));
    assert.deepEqual(w.calls.proposes, ['naa pani vishayam']);
    assert.equal(w.calls.learn.length, 0);
  });

  await checkAsync('below band: proposal saved, falls back to did-not-understand', async () => {
    const w = makeWorld({
      matchScript: {
        'edo okati': { intent: 'order', confidence: 0.4, entities: { category: 'vegetables', items: [{ name: 'x', qty: 1, unit: 'kg' }] } },
      },
    });
    const router = createRouter(w.store);
    const say = await register(router, '666');
    const r = await say('edo okati');
    assert.ok(r.replies.join(' ').includes('I did not understand'), r.replies.join(' '));
    assert.deepEqual(w.calls.proposes, ['edo okati']);
    assert.equal(w.logs.filter(l => l.reason === 'not_understood').length, 1);
  });

  await checkAsync('flag off: PA_DICTIONARY_ENABLED=false restores old behavior', async () => {
    process.env.PA_DICTIONARY_ENABLED = 'false';
    try {
      const w = makeWorld({
        matchScript: {
          'kothimeera kavali': {
            intent: 'order', confidence: 0.92,
            entities: { category: 'vegetables', items: [{ name: 'coriander', qty: 1, unit: 'kg' }] },
          },
        },
      });
      const router = createRouter(w.store);
      const say = await register(router, '777');
      const r = await say('kothimeera kavali');
      assert.ok(r.replies.join(' ').includes('I did not understand'), r.replies.join(' '));
      assert.equal(w.calls.lookup, 0);
    } finally {
      delete process.env.PA_DICTIONARY_ENABLED;
    }
  });

  await checkAsync('no dict store: unknown phrase behaves exactly as before', async () => {
    const w = makeWorld({ withDict: false });
    const router = createRouter(w.store);
    const say = await register(router, '888');
    const r = await say('kothimeera kavali');
    assert.ok(r.replies.join(' ').includes('I did not understand'), r.replies.join(' '));
    const r2 = await say('2 kg mirchi');
    assert.ok(r2.replies.join(' ').includes('Your list so far'), r2.replies.join(' '));
    const r3 = await say('done');
    assert.ok(r3.replies.join(' ').includes('Veg Store A'), r3.replies.join(' '));
  });

  console.log(failures === 0 ? 'ALL PA DICTIONARY TESTS PASSED' : `${failures} PA DICTIONARY TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
