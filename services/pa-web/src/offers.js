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