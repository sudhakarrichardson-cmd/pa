'use strict';
/*
 * Offer letters + company details — for the app admin and the HR role
 * (capability 'offer_letters').
 *
 *   GET  /api/org                 company details printed on letters
 *   PUT  /api/org                 change them (app admin only)
 *   GET  /api/offers              all letters, newest first
 *   POST /api/offers              create a letter
 *   GET  /api/offers/:id/pdf      download it as a PDF
 *
 * The letter wording below is a STANDARD DRAFT for the owner to review —
 * it is a template, not legal advice. Company name, address and the
 * signatory are never hard-coded: they come from survey.org_settings and
 * are copied into each letter when it is created, so an issued letter
 * always re-downloads exactly as it was.
 */
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

// Logo for the letterhead (JPEG — pdfkit reads JPEG / PNG only). A missing
// file just leaves the letterhead without a logo.
let LOGO = null;
try { LOGO = fs.readFileSync(path.join(__dirname, 'assets', 'logo-print.jpg')); } catch (e) { console.error('offer letters: no logo file'); }

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const asDate = v => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
// A DATE column as 'YYYY-MM-DD'. server.js makes pg hand DATEs over as
// plain text; the Date branch only covers a driver that does not.
const day = d => (!d ? null : typeof d === 'string' ? d.slice(0, 10)
  : new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = iso => { if (!iso) return ''; const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
// The built-in PDF fonts have no rupee sign, so amounts print as "Rs.".
const money = n => 'Rs. ' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const refNo = o => `OL/${String(o.offer_date).slice(0, 4)}/${String(o.id).padStart(4, '0')}`;

const ORG_FIELDS = { company_name: 160, company_cin: 30, company_address: 400, company_phone: 40, company_email: 120, company_website: 120, signatory_name: 120, signatory_title: 120 };

function publicOffer(r) {
  const o = {
    id: Number(r.id), candidate_name: r.candidate_name, candidate_email: r.candidate_email, candidate_mobile: r.candidate_mobile,
    candidate_address: r.candidate_address, position: r.position, work_location: r.work_location,
    reporting_manager: r.reporting_manager, date_of_joining: day(r.date_of_joining), pay_type: r.pay_type,
    monthly_pay: Number(r.monthly_pay), probation_months: r.probation_months, notice_days: r.notice_days,
    offer_date: day(r.offer_date), valid_until: day(r.valid_until), extra_terms: r.extra_terms,
    company: r.company || {}, created_by: r.created_by, created_at: r.created_at,
  };
  o.ref_no = refNo(o);
  return o;
}

/* ---------------- the letter ---------------- */
function writeLetter(doc, o) {
  const c = o.company || {};
  const pay = o.pay_type === 'stipend' ? 'stipend' : 'salary';
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const L = doc.page.margins.left;

  // letterhead: company block on the left, logo on the right
  const LOGO_W = 88, LOGO_H = 48;                     // small mark, top right
  const top = doc.y;
  const HW = LOGO ? W - LOGO_W - 16 : W;             // width left for the text block
  if (LOGO) doc.image(LOGO, L + W - LOGO_W, top, { fit: [LOGO_W, LOGO_H], align: 'right', valign: 'top' });
  doc.font('Helvetica-Bold').fontSize(17).fillColor('#111111').text(c.company_name || '', L, top + 4, { width: HW, align: 'left' });
  doc.font('Helvetica').fontSize(9).fillColor('#555555');
  if (c.company_cin) doc.text('CIN: ' + c.company_cin, { width: HW });
  if (c.company_address) doc.text((c.company_cin ? 'Registered office: ' : '') + c.company_address, { width: HW });
  const contact = [c.company_phone && 'Phone: ' + c.company_phone, c.company_email, c.company_website].filter(Boolean).join('   |   ');
  if (contact) doc.text(contact, { width: HW });
  if (LOGO && doc.y < top + LOGO_H) doc.y = top + LOGO_H;   // never draw the rule through the logo
  doc.x = L;
  doc.moveDown(0.5);
  doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(1).strokeColor('#999999').stroke();
  doc.moveDown(1);

  // reference + date
  doc.font('Helvetica').fontSize(10.5).fillColor('#111111');
  const y = doc.y;
  doc.text('Ref: ' + o.ref_no, L, y, { width: W / 2 });
  doc.text('Date: ' + longDate(o.offer_date), L + W / 2, y, { width: W / 2, align: 'right' });
  doc.moveDown(1.2);

  // addressee
  doc.text('To,', L, doc.y);
  doc.font('Helvetica-Bold').text(o.candidate_name);
  doc.font('Helvetica');
  if (o.candidate_address) doc.text(o.candidate_address, { width: W * 0.6 });
  if (o.candidate_mobile) doc.text('Mobile: ' + o.candidate_mobile);
  if (o.candidate_email) doc.text('Email: ' + o.candidate_email);
  doc.moveDown(1);

  doc.font('Helvetica-Bold').fontSize(12).text('OFFER OF EMPLOYMENT', L, doc.y, { width: W, align: 'center' });
  doc.moveDown(0.8);
  doc.font('Helvetica').fontSize(10.5);
  const para = t => { doc.text(t, L, doc.y, { width: W, align: 'justify', lineGap: 2 }); doc.moveDown(0.6); };

  para(`Dear ${o.candidate_name},`);
  para(`We are pleased to offer you the position of ${o.position} with ${c.company_name}. This letter sets out the terms of the offer.`);

  const terms = [];
  terms.push(['Position', `You will join as ${o.position}` + (o.reporting_manager ? ` and will report to ${o.reporting_manager}.` : '.') +
    ' Your duties will be as explained to you and may be reasonably changed by the company from time to time.']);
  terms.push(['Date of joining and place of work',
    (o.date_of_joining ? `Your date of joining will be ${longDate(o.date_of_joining)}.` : 'Your date of joining will be confirmed to you separately.') +
    (o.work_location ? ` Your place of work will be ${o.work_location}.` : '') +
    ' You may be required to travel or work at other locations of the company as the work needs.']);
  terms.push([pay === 'stipend' ? 'Stipend' : 'Salary',
    `You will be paid a monthly ${pay} of ${money(o.monthly_pay)} (${money(Number(o.monthly_pay) * 12)} per year), ` +
    'subject to the deductions required by law. It is paid monthly in arrears to your bank account.']);
  if (o.probation_months > 0) {
    terms.push(['Probation', `You will be on probation for ${o.probation_months} month${o.probation_months === 1 ? '' : 's'} from your date of joining. ` +
      'On satisfactory completion, your appointment will be confirmed in writing. The company may extend the probation period if needed.']);
  }
  terms.push(['Working hours and leave', 'Your working hours, weekly holiday and leave will be as per the company\'s rules in force from time to time.']);
  terms.push(['Confidentiality', 'You must keep confidential all information about the company, its customers and its business that you come to know during your employment, both while you work with us and afterwards.']);
  terms.push(['Notice period', `Either you or the company may end the employment by giving ${o.notice_days} day${o.notice_days === 1 ? '' : 's'}' written notice, or pay in place of notice.`]);
  terms.push(['Documents', 'Please bring originals and copies of your identity proof, address proof, educational certificates, any previous employment documents and two passport-size photographs on your date of joining. This offer depends on those documents being found in order.']);
  if (o.extra_terms) terms.push(['Other terms', o.extra_terms]);
  if (o.valid_until) terms.push(['Validity of this offer', `This offer is open for your acceptance until ${longDate(o.valid_until)}, after which it lapses unless the company extends it in writing.`]);

  terms.forEach(([head, body], i) => {
    doc.font('Helvetica-Bold').text(`${i + 1}. ${head}`, L, doc.y, { width: W });
    doc.font('Helvetica').text(body, L + 14, doc.y, { width: W - 14, align: 'justify', lineGap: 2 });
    doc.moveDown(0.55);
  });

  // Keep the closing line, the signature and the acceptance block together:
  // if they do not all fit on this page, they start a new one.
  if (doc.y > doc.page.height - doc.page.margins.bottom - 240) doc.addPage();
  else doc.moveDown(0.3);
  para('Please sign and return a copy of this letter as your acceptance of the offer. We look forward to having you with us.');

  doc.text(`For ${c.company_name},`, L, doc.y);
  doc.moveDown(2.6);
  doc.font('Helvetica-Bold').text(c.signatory_name || '');
  doc.font('Helvetica').text(c.signatory_title || '');
  doc.moveDown(1.6);

  doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(0.5).strokeColor('#bbbbbb').stroke();
  doc.moveDown(0.8);
  doc.font('Helvetica-Bold').text('Acceptance', L, doc.y);
  doc.font('Helvetica').text(`I, ${o.candidate_name}, have read and understood the terms above and accept this offer.`, { width: W });
  doc.moveDown(2.2);
  const sy = doc.y;
  doc.text('Signature: ______________________', L, sy, { width: W / 2 });
  doc.text('Date: ______________________', L + W / 2, sy, { width: W / 2 });
}

module.exports = function registerOffers(pool) {
  const q = (sql, params) => pool.query(sql, params);
  const isAdmin = user => Array.isArray(user.caps) && user.caps.includes('*');

  async function org() {
    const r = await q('SELECT * FROM survey.org_settings WHERE id = 1');
    const row = r.rows[0] || {};
    const out = {};
    for (const k of Object.keys(ORG_FIELDS)) out[k] = row[k] || '';
    return out;
  }

  return async function offersHandler(req, res, url, user) {
    const seg = url.pathname.split('/').filter(Boolean); // ['api','org'] | ['api','offers',...]
    try {
      /* ---------------- company details ---------------- */
      if (seg[1] === 'org' && seg.length === 2) {
        if (req.method === 'GET') { json(res, 200, { ...(await org()), can_edit: isAdmin(user) }); return true; }
        if (req.method === 'PUT') {
          if (!isAdmin(user)) { json(res, 403, { error: 'only the admin can change the company details' }); return true; }
          const b = await readBody(req);
          const keys = Object.keys(ORG_FIELDS);
          const vals = keys.map(k => text(b[k], ORG_FIELDS[k]) || null);
          await q(`INSERT INTO survey.org_settings (id, ${keys.join(', ')}, updated_by, updated_at)
                   VALUES (1, ${keys.map((k, i) => `$${i + 1}`).join(', ')}, $${keys.length + 1}, now())
                   ON CONFLICT (id) DO UPDATE SET ${keys.map(k => `${k} = EXCLUDED.${k}`).join(', ')},
                     updated_by = EXCLUDED.updated_by, updated_at = now()`, [...vals, user.email]);
          json(res, 200, { ok: true });
          return true;
        }
        return false;
      }
      if (seg[1] !== 'offers') return false;

      /* ---------------- list ---------------- */
      if (req.method === 'GET' && seg.length === 2) {
        const r = await q('SELECT * FROM survey.offer_letters ORDER BY id DESC LIMIT 500');
        json(res, 200, r.rows.map(publicOffer));
        return true;
      }

      /* ---------------- create ---------------- */
      if (req.method === 'POST' && seg.length === 2) {
        const b = await readBody(req);
        const company = await org();
        if (!company.company_name || !company.signatory_name) {
          json(res, 409, { error: 'Fill in the company details (company name and who signs the letter) before creating an offer letter.' });
          return true;
        }
        const name = text(b.candidate_name, 120), position = text(b.position, 120);
        const payRaw = text(b.monthly_pay, 20).replace(/,/g, '');
        const pay = Number(payRaw);
        const whole = (v, dflt, max) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 && n <= max ? n : dflt; };
        if (!name) { json(res, 400, { error: 'candidate name is required' }); return true; }
        if (!position) { json(res, 400, { error: 'position is required' }); return true; }
        if (payRaw === '' || !Number.isFinite(pay) || pay <= 0 || pay > 99999999) { json(res, 400, { error: 'monthly salary / stipend must be a number above zero' }); return true; }
        const r = await q(
          `INSERT INTO survey.offer_letters (candidate_name, candidate_email, candidate_mobile, candidate_address, position,
               work_location, reporting_manager, date_of_joining, pay_type, monthly_pay, probation_months, notice_days,
               offer_date, valid_until, extra_terms, company, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, COALESCE($13, CURRENT_DATE), $14,$15,$16,$17) RETURNING *`,
          [name, text(b.candidate_email, 200) || null, text(b.candidate_mobile, 30) || null, text(b.candidate_address, 400) || null,
           position, text(b.work_location, 120) || null, text(b.reporting_manager, 120) || null, asDate(b.date_of_joining),
           b.pay_type === 'stipend' ? 'stipend' : 'salary', pay, whole(b.probation_months, 6, 36), whole(b.notice_days, 30, 365),
           asDate(b.offer_date), asDate(b.valid_until), text(b.extra_terms, 1500) || null, JSON.stringify(company), user.email]);
        json(res, 201, publicOffer(r.rows[0]));
        return true;
      }

      /* ---------------- PDF ---------------- */
      if (req.method === 'GET' && seg.length === 4 && seg[3] === 'pdf' && /^\d+$/.test(seg[2])) {
        const r = await q('SELECT * FROM survey.offer_letters WHERE id = $1', [seg[2]]);
        if (!r.rows[0]) { json(res, 404, { error: 'not found' }); return true; }
        const o = publicOffer(r.rows[0]);
        const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 56, left: 62, right: 62 }, info: { Title: 'Offer letter ' + o.ref_no, Author: (o.company || {}).company_name || '' } });
        const fileName = `Offer-${o.ref_no.replace(/\//g, '-')}-${o.candidate_name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'letter'}.pdf`;
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${fileName}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        doc.pipe(res);
        writeLetter(doc, o);
        doc.end();
        return true;
      }

      return false;
    } catch (e) {
      if (e.message === 'body too large') { json(res, 413, { error: 'request too large' }); return true; }
      if (e instanceof SyntaxError) { json(res, 400, { error: 'bad request' }); return true; }
      console.error(e);
      if (!res.headersSent) json(res, 500, { error: 'server error' }); else res.end();
      return true;
    }
  };
};
