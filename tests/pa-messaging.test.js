'use strict';
/*
 * PA messaging layer — flow tests with an in-memory store (no DB, no
 * network). Run: node tests/pa-messaging.test.js
 * Covers the POC journeys at router level: registration, J2 vegetables
 * (quote from 2 stores, best picked, confirm, order recorded), J4
 * scheduler slots, J3 lawyer query + request, UC-11 no-service log.
 */
const assert = require('assert');
const { createRouter, parseRequest, pickBestQuote } =
  require('../services/pa-web/src/router');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS  ' + name); }
  catch (e) { failures++; console.log('FAIL  ' + name + ' — ' + e.message); }
}

// ---------------- fake store + fake apps ----------------
function makeWorld() {
  const users = new Map();       // id -> user
  const byRef = new Map();       // 'telegram:111' -> id
  const sessions = new Map();
  const orders = new Map();      // pa_request_id -> order
  const logs = [];
  let nextId = 1;

  const vegA = { app_id: 'veg-a', app_name: 'Veg Store A', mode: 'mediated' };
  const vegB = { app_id: 'veg-b', app_name: 'Veg Store B', mode: 'mediated' };
  const sched = { app_id: 'scheduler', app_name: 'Kavali Dental', mode: 'booking' };
  const lawyer = { app_id: 'helplawyer', app_name: 'HelpLawyer', mode: 'query' };
  const allApps = [vegA, vegB, sched, lawyer];
  const rates = { 'veg-a': 60, 'veg-b': 55 };  // mirchi ₹/kg — B is cheaper

  const store = {
    async getUserById(id) { return users.get(id) || null; },
    async getUserByRef(channel, ref) {
      const id = byRef.get(`${channel}:${ref}`);
      return id ? users.get(id) : null;
    },
    async createUser({ name, address, pincode, channel, chatRef }) {
      const u = { id: nextId++, name, address, pincode, phone: null };
      users.set(u.id, u);
      byRef.set(`${channel}:${chatRef}`, u.id);
      return u;
    },
    async getSession(key) { return sessions.get(key) || null; },
    async saveSession(key, s) { sessions.set(key, { ...s }); },
    async findApps(category) {
      if (category === 'vegetables') return [vegA, vegB];
      if (category === 'appointment') return [sched];
      if (category === 'legal') return [lawyer];
      return []; // cloth: nobody registered for this pincode
    },
    async getApp(appId) { return allApps.find(a => a.app_id === appId) || null; },
    async checkAvailability(app, user, items) {
      if (app.mode === 'booking') {
        return { items, slots: ['2026-11-16 10:00', '2026-11-16 11:30'] };
      }
      if (app.mode === 'query') {
        return { items, info: 'Your case OS/7/2024 — next hearing 2026-11-19, stage: FOR STEPS.' };
      }
      const rate = rates[app.app_id];
      const out = items.map(i => ({
        ...i, rate, amount: rate * i.qty, available: 'yes', available_qty: i.qty,
      }));
      return { items: out, total: out.reduce((s, i) => s + i.amount, 0) };
    },
    async placeOrder(app, user, items, paRequestId) {
      const total = items.reduce((s, i) => s + (i.rate || 0) * i.qty, 0);
      return {
        app_order_id: app.app_id + '-1001',
        status: app.mode === 'booking' ? 'booked' : 'placed',
        total: total || null,
      };
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
  return { store, orders, logs };
}

async function run() {
  // ---- parser units ----
  check('parser: "2 kg mirchi" -> vegetables item', () => {
    const p = parseRequest('2 kg mirchi');
    assert.equal(p.kind, 'request');
    assert.equal(p.category, 'vegetables');
    assert.deepEqual(p.items, [{ name: 'mirchi', qty: 2, unit: 'kg' }]);
  });
  check('parser: "doctor appointment" -> appointment service', () => {
    const p = parseRequest('doctor appointment');
    assert.equal(p.category, 'appointment');
    assert.equal(p.items[0].name, 'appointment');
  });
  check('pickBestQuote picks the lowest available total', () => {
    const best = pickBestQuote([
      { app: { app_id: 'a' }, answer: { total: 120, items: [{ available: 'yes' }] } },
      { app: { app_id: 'b' }, answer: { total: 110, items: [{ available: 'yes' }] } },
      { app: { app_id: 'c' }, answer: { total: 90, items: [{ available: 'no' }] } },
    ]);
    assert.equal(best.app.app_id, 'b');
  });

  const { store, orders, logs } = makeWorld();
  const router = createRouter(store);
  const say = text => router.handleMessage({ channel: 'telegram', chatRef: '111', text });
  const last = out => out.replies[out.replies.length - 1];

  // ---- registration ----
  let out = await say('hi');
  check('first contact asks for name', () => assert.match(last(out), /Your name\?/));
  out = await say('Ravi Kumar');
  check('name -> asks address', () => assert.match(last(out), /address/i));
  out = await say('MG Road, Kavali');
  check('address -> asks pincode', () => assert.match(last(out), /pincode/i));
  out = await say('524201');
  check('pincode -> registered', () => assert.match(last(out), /Registered/));

  // ---- J2 vegetables: compare, confirm, order ----
  out = await say('2 kg mirchi');
  check('quote shows the best store total (₹110) and compares 2 stores', () => {
    assert.match(last(out), /Total: ₹110/);
    assert.match(last(out), /Compared 2 stores/);
  });
  out = await say('yes');
  check('confirm places the order and records it in the PA order book', () => {
    assert.match(last(out), /Order placed with Veg Store B/);
    assert.equal(orders.size, 1);
    const o = [...orders.values()][0];
    assert.equal(o.appId, 'veg-b');
    assert.equal(o.appOrderId, 'veg-b-1001');
  });
  out = await say('status');
  check('status answers from the order book / app', () =>
    assert.match(last(out), /status: placed/));

  // ---- J4 scheduler: slots, pick, book ----
  out = await say('doctor appointment');
  check('scheduler offers slots', () => assert.match(last(out), /1\. 2026-11-16 10:00/));
  out = await say('2');
  check('slot pick books the appointment', () => {
    assert.match(last(out), /Appointment with Kavali Dental on 2026-11-16 11:30/);
    assert.equal(orders.size, 2);
  });

  // ---- J3 lawyer: basic info, then request on confirm ----
  out = await say('my case status');
  check('lawyer query returns case info from the app', () =>
    assert.match(last(out), /next hearing 2026-11-19/));
  out = await say('yes');
  check('confirm submits the request to the lawyer app', () => {
    assert.match(last(out), /Order placed with HelpLawyer/);
    assert.equal(orders.size, 3);
  });

  // ---- UC-11: no service registered ----
  out = await say('I want a nighty');
  check('unserved category -> noted + logged, no crash', () => {
    assert.match(last(out), /No registered service/);
    assert.equal(logs.filter(l => l.reason === 'no_service_found').length, 1);
  });

  // ---- stray confirm ----
  out = await say('yes');
  check('confirm with nothing pending is answered plainly', () =>
    assert.match(last(out), /Nothing is waiting/));

  // ---- shared-bot split (linked employee who is also a PA user) ----
  const sh = text => router.shouldHandle({ channel: 'telegram', chatRef: '111', text });
  assert.equal(await sh('2 kg mirchi'), true);
  console.log('PASS  shouldHandle: PA request -> router');
  assert.equal(await sh('how many visits did I make this week'), false);
  console.log('PASS  shouldHandle: employee visit question -> stays with employee bot');
  out = await say('2 kg mirchi'); // opens a pending quote
  assert.equal(await sh('yes'), true);
  console.log('PASS  shouldHandle: reply inside a pending PA flow -> router');
  out = await say('no');
  check('pending quote cancelled cleanly', () =>
    assert.match(last(out), /Cancelled/));

  console.log(failures ? 'PA MESSAGING TESTS FAILED' : 'ALL PA MESSAGING TESTS PASSED');
  process.exit(failures ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
