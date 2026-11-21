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
      address: user.address || null,
      // Add other user properties as needed
    };
  }

  return {
    listApps,
    getApp,
    findApps,
    callApp,
    paUser,
  };
}
module.exports = function registerApps(pool) {
  return createApps({ query: (sql, params) => pool.query(sql, params) });
};
module.exports.createApps = createApps;
