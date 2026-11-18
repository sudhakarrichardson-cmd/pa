'use strict';
/*
 * PA service questions — tests (no DB, no network).
 * Run: node tests/pa-services.test.js
 *
 * Questions ABOUT PA ("which shops are registered", "in which shop
 * are you planning to order it") are understood by the ai-helper
 * (route match) but answered by PA from the registry / the live
 * session — never from survey data, never by the helper. Covers the
 * owner's three scenarios (2026-11-17) and the live transcript
 * phrase that was answered with survey visits.
 */
const assert = require('assert');
const routerMod = require('../services/pa-web/src/router');
const { createRouter, looksLikeServicesQuestion } = routerMod;
const dictMod = require('../services/pa-web/src/dictionary');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS  ' + name); }
  catch (e) { failures++; console.log('FAIL  ' + name + ' — ' + e.message); }
}
async function checkAsync(name, fn) {
  try { await fn(); console.log('PASS  ' + name); }
  catch (e) { failures++; console.log('FAIL  ' + name + ' — ' + e.message); }
}

const MATCH = {
  'do you any shops in the list':
    { intent: 'list_services', entities: {}, confidence: 0.93 },
  'can you list all vegitable shops where i can shop':
    { intent: 'list_services', entities: { category: 'vegetables' }, confidence: 0.95 },
  'i want to order vegitable and do you have any shops availlable':
    { intent: 'list_services', entities: { category: 'vegetables' }, confidence: 0.9 },
  'in which shop are planning to order it':
    { intent: 'which_shop', entities: {}, confidence: 0.94 },
  'which shop will fulfil this':
    { intent: 'which_shop', entities: {}, confidence: 0.9 },
  'shops nearby?':
    { intent: 'list_services', entities: {}, confidence: 0.7 },
};

function makeWorld() {
  const users = new Map(); const byRef = new Map();
  const sessions = new Map(); const orders = new Map(); const logs = [];
  let nextId = 1;
  const calls = { check: 0, place: [], learn: [], propose: [] };
  const veg = { app_id: 'kavya', app_name: 'Kavya Vegetables', mode: 'mediated' };
  const tex = { app_id: 'padmavathi', app_name: 'Sree Padmavathi Textiles', mode: 'mediated' };
  const catalog = { mirchi: 60, tomato: 40, brinjal: 50, onion: 30 };

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
      if (category === 'cloth') return [tex];
      return [];
    },
    async getApp(appId) { return appId === 'kavya' ? veg : appId === 'padmavathi' ? tex : null; },
    async checkAvailability(app, user, items) {
      calls.check++;
      const out = items.map(i => {
        const rate = catalog[i.name];
        if (rate == null) return { ...i, rate: null, amount: null, available: 'no', available_qty: 0 };
        return { ...i, rate, amount: rate * i.qty, available: 'yes', available_qty: i.qty };
      });
      const total = out.filter(i => i.available === 'yes')
        .reduce((s, i) => s + i.amount, 0);
      return { items: out, total };
    },
    async placeOrder(app, user, items, paRequestId) {
      calls.place.push({ appId: app.app_id, items, paRequestId });
      return { app_order_id: 'kavya-1001', status: 'placed', total: 0 };
    },
    async orderStatus() { return 'placed'; },
    async recordOrder(o) { if (!orders.has(o.paRequestId)) orders.set(o.paRequestId, o); },
    async findOrder(id) { return orders.get(id) || null; },
    async latestOrder(userId) {
      const mine = [...orders.values()].filter(o => o.userId === userId);
      return mine[mine.length - 1] || null;
    },
    async logRequest(e) { logs.push(e); },
    async dictLookup() { return null; },
    async dictMatch(text) {
      const raw = MATCH[text];
      return raw ? dictMod.validateMatch(raw) : null;
    },
    async dictLearn(text) { calls.learn.push(text); return { id: 99 }; },
    async dictRecordHit() {},
    async dictDemote() {},
    async dictPropose(text) { calls.propose.push(text); },
  };
  return { store, orders, calls };
}

async function register(router, ref) {
  const say = text => router.handleMessage({ channel: 'telegram', chatRef: ref, text });
  await say('hi');
  await say('Test User');
  await say('MG Road, Kavali');
  await say('523001');
  return say;
}
const J = out => out.replies.join(' ');

async function run() {
  check('validateMatch: list_services with and without category; bad category rejected', () => {
    const a = dictMod.validateMatch({ intent: 'list_services', entities: {}, confidence: 0.9 });
    assert.equal(a.request.kind, 'services');
    assert.equal(a.request.category, null);
    const b = dictMod.validateMatch({ intent: 'list_services', entities: { category: 'cloth' }, confidence: 0.9 });
    assert.equal(b.request.category, 'cloth');
    assert.equal(dictMod.validateMatch({ intent: 'list_services', entities: { category: 'space' }, confidence: 0.9 }), null);
    const c = dictMod.validateMatch({ intent: 'which_shop', entities: {}, confidence: 0.9 });
    assert.equal(c.request.kind, 'which_shop');
  });

  check('buildRequest: seeded entries fire to services / which_shop requests', () => {
    const parseItems = routerMod.parseItems;
    assert.deepEqual(
      dictMod.buildRequest({ route: 'list_services', category: 'vegetables' }, 'vegetable shops', parseItems),
      { kind: 'services', category: 'vegetables' });
    assert.deepEqual(
      dictMod.buildRequest({ route: 'which_shop', category: null }, 'which shop', parseItems),
      { kind: 'which_shop' });
  });

  check('looksLikeServicesQuestion: PA questions pass, visit/survey questions vetoed', () => {
    assert.equal(looksLikeServicesQuestion('do you any shops in the list'), true);
    assert.equal(looksLikeServicesQuestion('what shops are registered'), true);
    assert.equal(looksLikeServicesQuestion('list all vegetable shops'), true);
    assert.equal(looksLikeServicesQuestion('how many shops did we visit today'), false);
    assert.equal(looksLikeServicesQuestion('list the survey shops'), false);
    assert.equal(looksLikeServicesQuestion('2 kg mirchi'), false);
    assert.equal(looksLikeServicesQuestion('how many visits today'), false);
  });

  await checkAsync('the live transcript phrase gets the REGISTRY answer, and is learned', async () => {
    const w = makeWorld();
    const say = await register(createRouter(w.store), 's1');
    const r = await say('do you any shops in the list');
    assert.ok(J(r).includes('Registered with PA in your area (523001)'), J(r));
    assert.ok(J(r).includes('Kavya Vegetables'), J(r));
    assert.ok(J(r).includes('Sree Padmavathi Textiles'), J(r));
    assert.ok(!J(r).includes('Sri Lakshmi'), J(r)); // never survey data
    assert.ok(w.calls.learn.includes('do you any shops in the list'));
  });

  await checkAsync('scenario 1: "list all vegitable shops" — category list, NO cart opened', async () => {
    const w = makeWorld();
    const say = await register(createRouter(w.store), 's2');
    const r = await say('can you list all vegitable shops where i can shop');
    assert.ok(J(r).includes('Vegetables: Kavya Vegetables'), J(r));
    assert.ok(!J(r).includes('Send me the vegetables items'), J(r));
    const r2 = await say('2 kg mirchi'); // a fresh order still starts cleanly
    assert.ok(J(r2).includes('Your list so far'), J(r2));
  });

  await checkAsync('scenario 2: order + shops question — answered AND the cart opens', async () => {
    const w = makeWorld();
    const say = await register(createRouter(w.store), 's3');
    const r = await say('i want to order vegitable and do you have any shops availlable');
    assert.ok(J(r).includes('Kavya Vegetables'), J(r));
    assert.ok(J(r).includes('Send me the vegetables items'), J(r));
    const r2 = await say('2 kg tomato');
    assert.ok(J(r2).includes('tomato — 2 kg'), J(r2));
    const r3 = await say('done');
    assert.ok(J(r3).includes('Total: ₹80'), J(r3));
  });

  await checkAsync('scenario 3 at the quote: "in which shop…" names the shop, quote intact, YES still places', async () => {
    const w = makeWorld();
    const say = await register(createRouter(w.store), 's4');
    await say('1 kg tomato');
    const q = await say('done');
    assert.ok(J(q).includes('Kavya Vegetables'), J(q));
    const r = await say('in which shop are planning to order it');
    assert.ok(J(r).includes('This order will go to Kavya Vegetables'), J(r));
    assert.ok(J(r).includes('Total: ₹40'), J(r)); // quote re-shown
    const placed = await say('yes');
    assert.ok(J(placed).includes('Order placed with Kavya Vegetables'), J(placed));
    assert.equal(w.calls.place.length, 1);
  });

  await checkAsync('which_shop while collecting: not picked yet, cart preserved', async () => {
    const w = makeWorld();
    const say = await register(createRouter(w.store), 's5');
    await say('2 kg mirchi');
    const r = await say('which shop will fulfil this');
    assert.ok(J(r).includes('not picked a shop yet'), J(r));
    assert.ok(J(r).includes('mirchi — 2 kg'), J(r));
  });

  await checkAsync('which_shop at idle: no order in progress', async () => {
    const w = makeWorld();
    const say = await register(createRouter(w.store), 's6');
    const r = await say('in which shop are planning to order it');
    assert.ok(J(r).includes('no order in progress'), J(r));
  });

  await checkAsync('services question at the quote stage: list + current quote, NO cancels cleanly', async () => {
    const w = makeWorld();
    const say = await register(createRouter(w.store), 's7');
    await say('1 kg tomato');
    await say('done');
    const r = await say('do you any shops in the list');
    assert.ok(J(r).includes('Registered with PA in your area'), J(r));
    assert.ok(J(r).includes('Your current quote'), J(r));
    const c = await say('no');
    assert.ok(J(c).includes('Cancelled'), J(c));
    assert.equal(w.calls.place.length, 0);
  });

  await checkAsync('mid-confidence services match asks ONE clarifying question, YES lists', async () => {
    const w = makeWorld();
    const say = await register(createRouter(w.store), 's8');
    const r = await say('shops nearby?');
    assert.ok(J(r).includes('Did you mean: listing the shops'), J(r));
    const r2 = await say('yes');
    assert.ok(J(r2).includes('Kavya Vegetables'), J(r2));
  });

  await checkAsync('unmatched question becomes a proposal for review, not a dropped message', async () => {
    const w = makeWorld();
    const say = await register(createRouter(w.store), 's9');
    const r = await say('tell me the history of all shops in the world');
    assert.ok(J(r).includes('did not understand'), J(r));
    assert.ok(w.calls.propose.includes('tell me the history of all shops in the world'));
  });

  await checkAsync('shouldHandle: services questions route to PA on a shared bot; employee questions do not', async () => {
    const w = makeWorld();
    const router = createRouter(w.store);
    assert.equal(await router.shouldHandle({ channel: 'telegram', chatRef: 'x1', text: 'do you any shops in the list' }), true);
    assert.equal(await router.shouldHandle({ channel: 'telegram', chatRef: 'x1', text: 'what shops are registered' }), true);
    assert.equal(await router.shouldHandle({ channel: 'telegram', chatRef: 'x1', text: 'how many shops did we visit today' }), false);
    assert.equal(await router.shouldHandle({ channel: 'telegram', chatRef: 'x1', text: 'how many visits today' }), false);
  });

  await checkAsync('shouldHandle: a learned dictionary phrase routes to PA', async () => {
    const w = makeWorld();
    w.store.dictLookup = async text => text === 'pachimirchi'
      ? { entry: { id: 5 }, request: { kind: 'request', category: 'vegetables', items: [] } }
      : null;
    const router = createRouter(w.store);
    assert.equal(await router.shouldHandle({ channel: 'telegram', chatRef: 'x2', text: 'pachimirchi' }), true);
    assert.equal(await router.shouldHandle({ channel: 'telegram', chatRef: 'x2', text: 'random employee note' }), false);
  });

  console.log(failures ? `\n${failures} FAILURES` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
}

run();
