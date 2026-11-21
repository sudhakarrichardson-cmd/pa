'use strict';
/*
 * PA app registry + basic-interface client.
 *
 * Every domain app (Textiles, VegiBot, Scheduler, HelpLawyer, …) runs
 * independently and registers with PA (rows in pa.app_registry, created
 * by migration 023). PA never touches an app's database — it calls the
 * app's own endpoint with exactly three basic requests:
 *
 *   { request: 'check_availability', pa_user, items }  -> quote / info
 *   { request: 'place_order', pa_request_id, pa_user, items }
 *        -> { app_order_id, status, total }
 *   { request: 'order_status', app_order_id }          -> { status }
 *
 * Auth: one shared secret per app, sent as the 'x-pa-secret' header.
 * The registry stores only the NAME of the env var holding the secret;
 * the value lives in pa-web's server-side .env and nowhere else.
 *
 * Exports: module.exports(pool) for server use, and
 * module.exports.createApps({ query, fetchFn, env }) for tests.
 */

const TIMEOUT_MS = 8000;

function createApps(deps) {
  const query = deps.query;
  const fetchFn = deps.fetchFn || fetch;
  const env = deps.env || process.env;

  async function listApps() {
    const r = await query(
      `SELECT app_id, app_name, app_type, categories, service_pincodes,
              endpoint_url, secret_env, capabilities, mode, status
         FROM pa.app_registry ORDER BY app_id`);
    return r.rows;
  }

  async function getApp(appId) {
    const r = await query(
      `SELECT app_id, app_name, app_type, categories, service_pincodes,
              endpoint_url, secret_env, capabilities, mode, status
         FROM pa.app_registry WHERE app_id = $1`, [appId]);
    return r.rows[0] || null;
  }

  // Active apps that can serve this category for this pincode.
  // An empty service_pincodes list means "serves everywhere".
  async function findApps(category, pincode) {
    const r = await query(
      `SELECT app_id, app_name, app_type, categories, service_pincodes,
              endpoint_url, secret_env, capabilities, mode, status
         FROM pa.app_registry
        WHERE status = 'active'
          AND $1 = ANY(categories)
          AND (cardinality(service_pincodes) = 0 OR $2 = ANY(service_pincodes))
        ORDER BY app_id`, [category, pincode || '']);
    return r.rows;
  }

  async function callApp(app, payload) {
    if (!app || !app.endpoint_url) return null;
    const secret = app.secret_env ? (env[app.secret_env] || '') : '';
    try {
      const r = await fetchFn(app.endpoint_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pa-secret': secret },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!r || !r.ok) return null;
      return await r.json().catch(() => null);
    } catch {
      return null; // unreachable / timed out — caller degrades gracefully
    }
  }

  function paUser(user) {
    return {
      name: user.name, phone: user.phone || null,
      address: user.address, pincode: user.pincode,
      // Stable PA identity: apps key their PA customers on it when no phone
      // is known (VegiBot stores it as phone "pa:pa-user-<id>").
      user_ref: `pa-user-${user.id}`,
    };
  }

  // Read-only: creates no order, no reservation, no charge in the app.
  async function checkAvailability(app, user, items) {
    const out = await callApp(app, {
      request: 'check_availability', pa_user: paUser(user), items,
    });
    return out && Array.isArray(out.items) ? out : null;
  }

  // Only ever called after the user confirmed the quote to PA.
  // paRequestId is the idempotency key: the app must not create a
  // second order if it sees the same key again.
  //
  // invoice_callback_url: after the owner approves and sets the final
  // price, the app POSTs { user_ref, invoice_no, amount, store_name }
  // (and optionally pdf_base64/pdf_filename) to this URL with the same
  // x-pa-secret header, and PA delivers it to the customer via Telegram.
  //
  // allow_price_adjustment: true tells the app that the owner may edit
  // the quoted rates before approving (actual stock prices may differ).
  async function placeOrder(app, user, items, paRequestId) {
    const baseUrl = (env.PA_BASE_URL || '').replace(/\/$/, '');
    const payload = {
      request: 'place_order', pa_request_id: paRequestId,
      pa_user: paUser(user), items,
      allow_price_adjustment: true,
    };
    if (baseUrl) {
      payload.invoice_callback_url = `${baseUrl}/api/pa/relay/invoice`;
    }
    const out = await callApp(app, payload);
    return out && out.app_order_id ? out : null;
  }

  async function orderStatus(app, appOrderId) {
    const out = await callApp(app, {
      request: 'order_status', app_order_id: appOrderId,
    });
    return out && out.status ? out.status : null;
  }

  // Admin: create or update a registration (endpoint/status stay under
  // PlotFarms control; a fresh registration starts 'pending').
  async function registerApp(e) {
    const r = await query(
      `INSERT INTO pa.app_registry
         (app_id, app_name, app_type, categories, service_pincodes,
          endpoint_url, secret_env, capabilities, mode, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
       ON CONFLICT (app_id) DO UPDATE SET
         app_name = EXCLUDED.app_name, app_type = EXCLUDED.app_type,
         categories = EXCLUDED.categories,
         service_pincodes = EXCLUDED.service_pincodes,
         endpoint_url = EXCLUDED.endpoint_url,
         secret_env = EXCLUDED.secret_env,
         capabilities = EXCLUDED.capabilities, mode = EXCLUDED.mode,
         updated_at = now()
       RETURNING app_id, status`,
      [e.app_id, e.app_name, e.app_type, e.categories || [],
       e.service_pincodes || [], e.endpoint_url || '', e.secret_env || '',
       e.capabilities || ['check_availability', 'place_order', 'order_status'],
       e.mode || 'mediated']);
    return r.rows[0];
  }

  async function setStatus(appId, status) {
    const r = await query(
      `UPDATE pa.app_registry
         SET status = $1, updated_at = now()
       WHERE app_id = $2
       RETURNING app_id, status`,
      [status, appId]);
    return r.rows[0];
  }

  return {
    listApps,
    getApp,
    findApps,
    callApp,
    paUser,
    checkAvailability,
    placeOrder,
    orderStatus,
    registerApp,
    setStatus,
  };
}

module.exports = createApps;