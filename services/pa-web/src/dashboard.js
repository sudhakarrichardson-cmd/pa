'use strict';
/*
 * Manager dashboard + Results-Tracker export — mirrors the reports role
 * of textiles-api/src/owner.js. Both routes are manager/owner only; the
 * server enforces the role before calling this handler.
 *
 * GET /api/dashboard  summary counts, same definitions as the Results
 *                     Tracker Summary sheet (total, hot/warm, pilots
 *                     agreed, demo-first, fit scores, visits by type).
 * GET /api/export.csv one row per visit with the Results Tracker Visits
 *                     columns, enum codes shown as the tracker's labels.
 */

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const TYPE_LABEL = {
  cloth: 'Cloth store', vegetable: 'Vegetable store', restaurant: 'Restaurant',
  grocery: 'Grocery / Kirana', lawyer: 'Lawyer', doctor: 'Doctor office',
};
const TEMPLATE_LABEL = {
  ordering: 'Ordering app', scheduler: 'Appointment scheduler',
  case_manager: 'Case manager', custom: 'Custom',
};
const FIT_LABEL = {
  ready: 'Ready fit', small_changes: 'Fit with small changes',
  major_custom: 'Needs major custom work', not_a_fit: 'Not a fit',
};
const INTEREST_LABEL = { hot: 'Hot', warm: 'Warm', cold: 'Cold', no: 'No' };
const FEE_LABEL = {
  lt_500: '< ₹500', '500_1000': '₹500–1,000', '1000_2500': '₹1,000–2,500',
  '2500_5000': '₹2,500–5,000', see_it_work: 'Need to see it work',
};
const PILOT_LABEL = {
  yes: 'Yes', demo_first: 'Wants demo first',
  after_office_call: 'After office call', no: 'No',
};

const csvCell = v => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

module.exports = function registerDashboard(pool) {
  const q = (sql, params) => pool.query(sql, params);

  async function counts(column, values) {
    const r = await q(
      `SELECT ${column} AS k, COUNT(*)::int AS n FROM survey.visits WHERE ${column} IS NOT NULL GROUP BY ${column}`);
    const out = {};
    for (const v of values) out[v] = 0;
    for (const row of r.rows) if (row.k in out) out[row.k] = row.n;
    return out;
  }

  return async function dashboardHandler(req, res, url) {
    try {
      if (req.method === 'GET' && url.pathname === '/api/dashboard') {
        const total = await q('SELECT COUNT(*)::int AS n FROM survey.visits');
        const byStatus = await counts('status', ['draft', 'submitted', 'completed']);
        const byType = await counts('business_type', Object.keys(TYPE_LABEL));
        const byInterest = await counts('interest_level', Object.keys(INTEREST_LABEL));
        const byPilot = await counts('pilot_status', Object.keys(PILOT_LABEL));
        const byFit = await counts('fit_score', Object.keys(FIT_LABEL));
        json(res, 200, {
          total_visits: total.rows[0].n,
          by_status: byStatus,
          by_type: byType,
          hot_leads: byInterest.hot || 0,
          warm_leads: byInterest.warm || 0,
          by_interest: byInterest,
          pilots_agreed: byPilot.yes || 0,
          demo_first: byPilot.demo_first || 0,
          by_pilot: byPilot,
          by_fit_score: byFit,
        });
        return true;
      }

      if (req.method === 'GET' && url.pathname === '/api/export.csv') {
        const r = await q(
          `SELECT visit_date, business_name, business_type, town, owner_name, owner_whatsapp,
                  orders_per_day, missed_enquiries_per_week, top_pain, template_fit, fit_score,
                  interest_level, fee_comfort, pilot_status, pilot_date, next_step, part_c
             FROM survey.visits ORDER BY visit_date, id`);
        const header = ['Visit date', 'Business name', 'Type', 'Town / area', 'Owner / decision-maker',
          'WhatsApp no.', 'Orders / clients per day', 'Missed enquiries / week', "Top pain (owner's words)",
          'Template fit', 'Fit score', 'Interest', 'Fee comfort (₹/mo)', 'Pilot agreed?',
          'Pilot / demo start date', 'Next step', 'Engineer notes'];
        const lines = [header.map(csvCell).join(',')];
        for (const v of r.rows) {
          lines.push([
            v.visit_date ? String(v.visit_date).slice(0, 10) : '',
            v.business_name || '',
            TYPE_LABEL[v.business_type] || v.business_type || '',
            v.town || '',
            v.owner_name || '',
            v.owner_whatsapp || '',
            v.orders_per_day || '',
            v.missed_enquiries_per_week ?? '',
            v.top_pain || '',
            TEMPLATE_LABEL[v.template_fit] || v.template_fit || '',
            FIT_LABEL[v.fit_score] || v.fit_score || '',
            INTEREST_LABEL[v.interest_level] || v.interest_level || '',
            FEE_LABEL[v.fee_comfort] || v.fee_comfort || '',
            PILOT_LABEL[v.pilot_status] || v.pilot_status || '',
            v.pilot_date ? String(v.pilot_date).slice(0, 10) : '',
            v.next_step || '',
            (v.part_c && (v.part_c.notes || v.part_c.q11)) || '',
          ].map(csvCell).join(','));
        }
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="business-survey-visits.csv"',
          'Cache-Control': 'no-store',
        });
        res.end('﻿' + lines.join('\r\n') + '\r\n');
        return true;
      }

      return false;
    } catch (e) {
      console.error(e.message);   // details stay in the server log, not in the response
      json(res, 500, { error: 'server error' });
      return true;
    }
  };
};
