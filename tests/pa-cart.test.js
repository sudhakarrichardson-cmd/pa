'use strict';
/*
 * PA cart flow — tests (no DB, no network).
 * Run: node tests/pa-cart.test.js
 *
 * The ordering flow collects the full list BEFORE any app is
 * contacted: items accumulate in a cart (stage 'collecting'); DONE
 * (or YES) triggers one check_availability for the whole list and
 * shows the best quote; at the quote the user can still add items —
 * re-checked with the winning store only — or confirm, which is the
 * only point place_order is called. Mirrors the live case that
 * prompted the flow: quote for tomato shown, then "add brinjal 1kg".
 */
const assert = require('assert');
const { createRouter } = require('../services/pa-web/src/router');

let failures = 0;
async function checkAsync(name, fn) {
  try { await fn(); console.log('PASS  ' + name); }
  catch (e) { failures++; console.log('FAIL  ' + name + ' — ' + e.message); }
}

function makeWorld({ withDict = false, matchScript = {} } = {}) {
  const users = new Map(); const byRef = new Map();
  const sessions = new Map(); const orders = new Map(); const logs = [];
  let nextId = 1;
  const calls = { check: 0, place: [] };
  const veg = { app_id: 'kavya', app_name: 'Kavya Vegetables', mode: 'mediated' };
  // ₹ per kg; dragon fruit is stocked out.
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
    async findApps(category) { return category === 'vegetables' ? [veg] : []; },
    async getApp(appId) { return appId === 'kavya' ? veg : null; },
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
  };
  if (withDict) {
    const dictMod = require('../services/pa-web/src/dictionary');
    calls.learn = []; calls.propose = [];
    Object.assign(store, {
      async dictLookup() { return null; },
      async dictMatch(text) {
        const raw = matchScript[text];
        return raw ? dictMod.validateMatch(raw) : null;
      },
      async dictLearn(text) { calls.learn.push(text); return { id: 99 }; },
      async dictRecordHit() {},
      async dictDemote() {},
      async dictPropose(text) { calls.propose.push(text); },
    });
  }
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
  await checkAsync('collect: items accumulate, NO app contact until DONE, quantities merge', async () => {
    const w = makeWorld();
    const say = await register(createRouter(w.store), '111');
    let r = await say('2 kg mirchi');
    assert.ok(J(r).includes('Your list so far'), J(r));
    r = await say('1 kg tomato');
    assert.ok(J(r).includes('tomato — 1 kg'), J(r));
    r = await say('1 kg mirchi');
    assert.ok(J(r).includes('mirchi — 3 kg'), J(r));
    assert.equal(w.calls.check, 0); // apps untouched while collecting
    r = await say('done');
    assert.equal(w.calls.check, 1); // exactly one availability round
    assert.ok(J(r).includes('Total: ₹220'), J(r)); // 3*60 + 1*40
    assert.ok(J(r).includes('send more items to add'), J(r));
  });

  await checkAsync('the live case: quote for tomato, then "add brinjal 1kg" appends', async () => {
    const w = makeWorld();
    const say = await register(createRouter(w.store), '222');
    await say('1 kg tomato');
    let r = await say('done');
    assert.ok(J(r).includes('Total: ₹40'), J(r));
    r = await say('add brinjal 1kg');
    assert.ok(J(r).includes('brinjal'), J(r));
    assert.ok(J(r).includes('Total: ₹90'), J(r)); // 40 + 50
    r = await say('yes');
    assert.ok(J(r).includes('Order placed with Kavya Vegetables'), J(r));
    assert.equal(w.calls.place.length, 1);
    const names = w.calls.place[0].items.map(i => i.name).sort();
    assert.deepEqual(names, ['brinjal', 'tomato']);
  });

  await checkAsync('add at quote: unavailable item is named and left out, quote stands', async () => {
    const w = makeWorld();
    const say = await register(createRouter(w.store), '333');
    await say('1 kg tomato');
    await say('done');
    const r = await say('1 kg dragon fruit');
    assert.ok(J(r).includes('dragon fruit is not available at Kavya Vegetables'), J(r));
    assert.ok(J(r).includes('Total: ₹40'), J(r));
    const y = await say('yes');
    assert.ok(J(y).includes('Order placed'), J(y));
    assert.deepEqual(w.calls.place[0].items.map(i => i.name), ['tomato']);
  });

  await checkAsync('add at quote: a different category is refused, quote untouched', async () => {
    const w = makeWorld();
    const say = await register(createRouter(w.store), '444');
    await say('1 kg tomato');
    await say('done');
    const r = await say('1 nighty');
    assert.ok(J(r).includes('separate cloth order'), J(r));
    const y = await say('yes');
    assert.ok(J(y).includes('Order placed'), J(y));
    assert.deepEqual(w.calls.place[0].items.map(i => i.name), ['tomato']);
  });

  await checkAsync('collecting: different category is held back, cart keeps its category', async () => {
    const w = makeWorld();
    const say = await register(createRouter(w.store), '555');
    await say('1 kg tomato');
    const r = await say('1 nighty');
    assert.ok(J(r).includes('separate cloth list'), J(r));
    const q = await say('done');
    assert.ok(J(q).includes('Total: ₹40'), J(q));
    assert.ok(!J(q).includes('nighty'), J(q));
  });

  await checkAsync('collecting: YES also means done; NO cancels the cart', async () => {
    const w = makeWorld();
    const say = await register(createRouter(w.store), '666');
    await say('2 kg onion');
    const q = await say('yes');
    assert.ok(J(q).includes('Total: ₹60'), J(q));
    const n = await say('no');
    assert.ok(J(n).includes('Cancelled'), J(n));
    assert.equal(w.calls.place.length, 0);
    await say('1 kg onion');
    const c = await say('no');
    assert.ok(J(c).includes('Cancelled. Nothing was ordered.'), J(c));
    assert.equal(w.calls.check, 1); // the cancelled cart never reached a store
  });

  await checkAsync('collecting: status question answers and keeps the cart', async () => {
    const w = makeWorld();
    const say = await register(createRouter(w.store), '777');
    await say('1 kg tomato');
    const r = await say('status');
    assert.ok(J(r).includes('no orders'), J(r));
    const q = await say('done');
    assert.ok(J(q).includes('Total: ₹40'), J(q));
  });

  await checkAsync('name-first quantities keep their quantity ("tomato 2kg")', async () => {
    const w = makeWorld();
    const say = await register(createRouter(w.store), '888');
    const r = await say('tomato 2kg');
    assert.ok(J(r).includes('tomato — 2 kg'), J(r));
    const q = await say('done');
    assert.ok(J(q).includes('Total: ₹80'), J(q));
  });

  await checkAsync('transcript replay: typo validated by ai-helper, no "kg" item, no garbage item', async () => {
    const w = makeWorld({
      withDict: true,
      matchScript: {
        'tomotos 2 kg': {
          intent: 'order', confidence: 0.9,
          entities: { category: 'vegetables', items: [{ name: 'tomato', qty: 2, unit: 'kg' }] },
        },
      },
    });
    const say = await register(createRouter(w.store), '999');
    await say('2 kg mirchi');
    const r = await say('tomotos 2 kg');
    assert.ok(J(r).includes('tomato — 2 kg'), J(r));
    assert.ok(!J(r).includes('• kg —'), J(r));
    assert.deepEqual(w.calls.learn, ['tomotos 2 kg']); // helper-validated phrase learned
    const g = await say("modify the list , i don't want kg -2kg from teh list");
    assert.ok(!J(g).includes('from teh list —'), J(g)); // sentence never becomes an item
    const q = await say('done');
    assert.ok(J(q).includes('Total: ₹200'), J(q)); // mirchi 2*60 + tomato 2*40, unchanged
  });

  await checkAsync('remove in cart: by name, and by pasting the bot\'s own list line back', async () => {
    const w = makeWorld();
    const say = await register(createRouter(w.store), '101');
    await say('2 kg mirchi');
    await say('2 kg tomato');
    let r = await say('remove tomato — 2 kg');
    assert.ok(J(r).includes('Removed tomato'), J(r));
    assert.ok(!J(r).includes('• tomato'), J(r));
    r = await say('remove mirchi');
    assert.ok(J(r).includes('list is now empty'), J(r));
    assert.equal(w.calls.check, 0);
  });

  await checkAsync('remove of an item that is not there: named, cart unchanged', async () => {
    const w = makeWorld();
    const say = await register(createRouter(w.store), '102');
    await say('1 kg tomato');
    const r = await say('remove brinjal');
    assert.ok(J(r).includes('no brinjal in your list'), J(r));
    const q = await say('done');
    assert.ok(J(q).includes('Total: ₹40'), J(q));
  });

  await checkAsync('remove at the quote stage re-quotes the rest; removing the last item cancels', async () => {
    const w = makeWorld();
    const say = await register(createRouter(w.store), '103');
    await say('1 kg tomato');
    await say('1 kg brinjal');
    await say('done');
    const r = await say('remove brinjal');
    assert.ok(J(r).includes('Removed brinjal'), J(r));
    assert.ok(J(r).includes('Total: ₹40'), J(r));
    const r2 = await say('remove tomato');
    assert.ok(J(r2).includes('order is cancelled'), J(r2));
    assert.equal(w.calls.place.length, 0);
  });

  await checkAsync('sentence-like text in cart: not understood, proposed for review, cart unchanged', async () => {
    const w = makeWorld({ withDict: true });
    const say = await register(createRouter(w.store), '104');
    await say('1 kg tomato');
    const r = await say('please change my plan for tomorrow');
    assert.ok(J(r).includes('could not pick an item'), J(r));
    assert.deepEqual(w.calls.propose, ['please change my plan for tomorrow']);
    const q = await say('done');
    assert.ok(J(q).includes('Total: ₹40'), J(q));
  });

  console.log(failures === 0 ? 'ALL PA CART TESTS PASSED' : `${failures} PA CART TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
