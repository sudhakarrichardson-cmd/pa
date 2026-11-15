'use strict';
/*
 * Survey visits API — the ONLY writer to schema `survey`.
 *
 * Routes (all require a valid session; the server checks before calling):
 *   POST /api/visits                      create a draft
 *   GET  /api/visits                      list (employee: own; manager/owner: all; filters)
 *   GET  /api/visits/:id                  one visit + its attachments
 *   PUT  /api/visits/:id                  update a draft (employees: own only)
 *   POST /api/visits/:id/submit           draft -> submitted (required fields checked)
 *   POST /api/visits/:id/wrapup           Part C; submitted -> completed
 *   POST /api/visits/:id/attachments      A10 photo upload (multipart, images only)
 *   GET  /api/attachments/:id             stream a photo (owner of visit, or manager+)
 *
 * STRIDE: submitted_by is always taken from the session, never from the
 * client (repudiation/tampering); every read/write checks ownership or
 * manager role (information disclosure); status transitions are enforced
 * here, not in the page (tampering); uploads are type- and size-checked
 * and stored under generated names outside any public path.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/uploads';
const MAX_UPLOAD = 5 * 1024 * 1024; // 5 MB per photo

const BUSINESS_TYPES = ['cloth', 'vegetable', 'restaurant', 'grocery', 'lawyer', 'doctor'];
const FEE_COMFORT = ['lt_500', '500_1000', '1000_2500', '2500_5000', 'see_it_work'];
const TEMPLATE_FIT = ['ordering', 'scheduler', 'case_manager', 'custom'];
const FIT_SCORE = ['ready', 'small_changes', 'major_custom', 'not_a_fit'];
const INTEREST = ['hot', 'warm', 'cold', 'no'];
const PILOT_STATUS = ['yes', 'demo_first', 'after_office_call', 'no'];
const ATTACH_KINDS = ['bill_sample', 'price_list', 'shop_front', 'visiting_card', 'catalogue', 'software_screen', 'other'];

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function readRaw(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const str = v => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const inList = (v, list) => (list.includes(v) ? v : null);
const asInt = v => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const asDate = v => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
const asJson = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// Pull the typed columns out of a request body. Top-level fields win;
// part_a values are the fallback (the wizard stores answers there).
function typedFrom(b) {
  const a = asJson(b.part_a);
  return {
    business_name: str(b.business_name) || str(a.business_name),
    business_type: inList(b.business_type || a.business_type, BUSINESS_TYPES),
    town: str(b.town) || str(a.town),
    owner_name: str(b.owner_name) || str(a.owner_name),
    owner_whatsapp: str(b.owner_whatsapp) || str(a.owner_whatsapp),
    visit_date: asDate(b.visit_date) || asDate(a.visit_date),
    orders_per_day: str(b.orders_per_day) || str(a.orders_per_day),
    missed_enquiries_per_week: asInt(b.missed_enquiries_per_week ?? a.missed_per_week),
    fee_comfort: inList(b.fee_comfort || a.fee_comfort, FEE_COMFORT),
  };
}

function wrapupTypedFrom(b) {
  return {
    top_pain: str(b.top_pain),
    template_fit: inList(b.template_fit, TEMPLATE_FIT),
    fit_score: inList(b.fit_score, FIT_SCORE),
    interest_level: inList(b.interest_level, INTEREST),
    pilot_status: inList(b.pilot_status, PILOT_STATUS),
    pilot_date: asDate(b.pilot_date),
    next_step: str(b.next_step),
    next_step_date: asDate(b.next_step_date),
  };
}

// Minimal multipart/form-data parser: enough for one file field plus
// plain fields. Works on Buffers so binary content is never re-encoded.
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType || '');
  if (!m) throw new Error('no multipart boundary');
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  const fields = {};
  let file = null;
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    let start = pos + boundary.length;
    if (buf[start] === 45 && buf[start + 1] === 45) break; // closing --
    if (buf[start] === 13 && buf[start + 1] === 10) start += 2;
    const headerEnd = buf.indexOf('\r\n\r\n', start);
    if (headerEnd === -1) break;
    const headers = buf.slice(start, headerEnd).toString('utf8');
    const next = buf.indexOf(boundary, headerEnd + 4);
    if (next === -1) break;
    let dataEnd = next;
    if (buf[dataEnd - 2] === 13 && buf[dataEnd - 1] === 10) dataEnd -= 2;
    const data = buf.slice(headerEnd + 4, dataEnd);
    const nameM = /name="([^"]+)"/.exec(headers);
    const fileM = /filename="([^"]*)"/.exec(headers);
    if (nameM) {
      if (fileM && fileM[1]) {
        const typeM = /Content-Type:\s*([^\r\n]+)/i.exec(headers);
        file = { field: nameM[1], filename: fileM[1], contentType: typeM ? typeM[1].trim() : '', data };
      } else {
        fields[nameM[1]] = data.toString('utf8');
      }
    }
    pos = next;
  }
  return { fields, file };
}

// Sniff the real image type from magic bytes — the declared
// Content-Type and the file extension are never trusted.
function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', type: 'image/jpeg' };
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: 'png', type: 'image/png' };
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { ext: 'webp', type: 'image/webp' };
  return null;
}

module.exports = function registerVisits(pool, auth) {
  const q = (sql, params) => pool.query(sql, params);
  const canSeeAll = user => auth.isManager(user);

  async function loadVisit(id) {
    const r = await q('SELECT * FROM survey.visits WHERE id = $1', [id]);
    return r.rows[0] || null;
  }
  const canAccess = (user, visit) => !!visit && (canSeeAll(user) || visit.submitted_by === user.email);

  return async function visitsHandler(req, res, url, user) {
    const seg = url.pathname.split('/').filter(Boolean); // ['api','visits',...]
    try {
      /* ---------------- attachments download ---------------- */
      if (req.method === 'GET' && seg[1] === 'attachments' && seg[2]) {
        const r = await q(
          `SELECT a.*, v.submitted_by AS visit_owner FROM survey.attachments a
             JOIN survey.visits v ON v.id = a.visit_id WHERE a.id = $1`, [seg[2]]);
        const att = r.rows[0];
        if (!att) { json(res, 404, { error: 'not found' }); return true; }
        if (!canSeeAll(user) && att.visit_owner !== user.email) { json(res, 403, { error: 'not your visit' }); return true; }
        const full = path.join(UPLOAD_DIR, path.basename(att.file_path));
        if (!fs.existsSync(full)) { json(res, 404, { error: 'file missing' }); return true; }
        const ext = path.extname(full).slice(1).toLowerCase();
        const type = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        fs.createReadStream(full).pipe(res);
        return true;
      }

      if (seg[1] !== 'visits') return false;

      /* ---------------- list ---------------- */
      if (req.method === 'GET' && !seg[2]) {
        const where = [];
        const params = [];
        if (!canSeeAll(user)) { params.push(user.email); where.push(`submitted_by = $${params.length}`); }
        const type = inList(url.searchParams.get('type'), BUSINESS_TYPES);
        if (type) { params.push(type); where.push(`business_type = $${params.length}`); }
        const status = url.searchParams.get('status');
        if (['draft', 'submitted', 'completed'].includes(status)) { params.push(status); where.push(`status = $${params.length}`); }
        const from = asDate(url.searchParams.get('from'));
        if (from) { params.push(from); where.push(`visit_date >= $${params.length}`); }
        const to = asDate(url.searchParams.get('to'));
        if (to) { params.push(to); where.push(`visit_date <= $${params.length}`); }
        const term = str(url.searchParams.get('q'));
        if (term) { params.push('%' + term + '%'); where.push(`business_name ILIKE $${params.length}`); }
        const sql = `SELECT id, submitted_by, visit_date, status, business_name, business_type, town,
                            owner_name, owner_whatsapp, orders_per_day, missed_enquiries_per_week,
                            fee_comfort, top_pain, template_fit, fit_score, interest_level,
                            pilot_status, pilot_date, next_step, next_step_date, created_at, updated_at, submitted_at
                       FROM survey.visits
                      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                      ORDER BY visit_date DESC, id DESC LIMIT 500`;
        const r = await q(sql, params);
        json(res, 200, r.rows);
        return true;
      }

      /* ---------------- create draft ---------------- */
      if (req.method === 'POST' && !seg[2]) {
        const b = await readBody(req);
        const t = typedFrom(b);
        const r = await q(
          `INSERT INTO survey.visits (submitted_by, visit_date, business_name, business_type, town,
                                      owner_name, owner_whatsapp, orders_per_day, missed_enquiries_per_week,
                                      fee_comfort, part_a, part_b)
           VALUES ($1, COALESCE($2, CURRENT_DATE), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING *`,
          [user.email, t.visit_date, t.business_name, t.business_type, t.town, t.owner_name,
           t.owner_whatsapp, t.orders_per_day, t.missed_enquiries_per_week, t.fee_comfort,
           JSON.stringify(asJson(b.part_a)), JSON.stringify(asJson(b.part_b))]);
        json(res, 201, r.rows[0]);
        return true;
      }

      const id = seg[2] && /^\d+$/.test(seg[2]) ? seg[2] : null;
      if (!id) { json(res, 404, { error: 'not found' }); return true; }
      const visit = await loadVisit(id);
      if (!visit) { json(res, 404, { error: 'not found' }); return true; }
      if (!canAccess(user, visit)) { json(res, 403, { error: 'not your visit' }); return true; }

      /* ---------------- one visit ---------------- */
      if (req.method === 'GET' && !seg[3]) {
        const atts = await q('SELECT id, visit_id, kind, uploaded_by, created_at FROM survey.attachments WHERE visit_id = $1 ORDER BY id', [id]);
        json(res, 200, { ...visit, attachments: atts.rows });
        return true;
      }

      /* ---------------- update draft ---------------- */
      if (req.method === 'PUT' && !seg[3]) {
        if (visit.status === 'completed' && !canSeeAll(user)) {
          json(res, 409, { error: 'a completed visit can only be changed by a manager' }); return true;
        }
        if (visit.status === 'submitted' && !canSeeAll(user)) {
          json(res, 409, { error: 'already submitted — add the Part C wrap-up instead' }); return true;
        }
        const b = await readBody(req);
        if (b.status && b.status !== visit.status) {
          json(res, 400, { error: 'status changes go through submit / wrapup' }); return true;
        }
        if (b.submitted_by && b.submitted_by !== visit.submitted_by) {
          json(res, 400, { error: 'submitted_by comes from the login and cannot be changed' }); return true;
        }
        const t = typedFrom({ ...b, part_a: { ...visit.part_a, ...asJson(b.part_a) } });
        const partA = { ...visit.part_a, ...asJson(b.part_a) };
        const partB = { ...visit.part_b, ...asJson(b.part_b) };
        const r = await q(
          `UPDATE survey.visits SET visit_date = COALESCE($2, visit_date), business_name = $3, business_type = $4,
                  town = $5, owner_name = $6, owner_whatsapp = $7, orders_per_day = $8,
                  missed_enquiries_per_week = $9, fee_comfort = $10, part_a = $11, part_b = $12, updated_at = now()
            WHERE id = $1 RETURNING *`,
          [id, t.visit_date, t.business_name, t.business_type, t.town, t.owner_name, t.owner_whatsapp,
           t.orders_per_day, t.missed_enquiries_per_week, t.fee_comfort,
           JSON.stringify(partA), JSON.stringify(partB)]);
        json(res, 200, r.rows[0]);
        return true;
      }

      /* ---------------- submit ---------------- */
      if (req.method === 'POST' && seg[3] === 'submit') {
        if (visit.status !== 'draft') { json(res, 409, { error: `cannot submit a ${visit.status} visit` }); return true; }
        const missing = [];
        if (!visit.business_type) missing.push('business type');
        if (!visit.business_name) missing.push('business name');
        if (!visit.town) missing.push('town');
        if (!visit.owner_whatsapp) missing.push('owner WhatsApp number');
        if (missing.length) { json(res, 422, { error: 'required before submit: ' + missing.join(', '), missing }); return true; }
        const r = await q(
          `UPDATE survey.visits SET status = 'submitted', submitted_at = now(), updated_at = now()
            WHERE id = $1 RETURNING *`, [id]);
        json(res, 200, r.rows[0]);
        return true;
      }

      /* ---------------- Part C wrap-up ---------------- */
      if (req.method === 'POST' && seg[3] === 'wrapup') {
        if (visit.status === 'draft') { json(res, 409, { error: 'submit the visit before the wrap-up' }); return true; }
        const b = await readBody(req);
        const w = wrapupTypedFrom(b);
        const partC = { ...visit.part_c, ...asJson(b.part_c), ...Object.fromEntries(Object.entries(w).filter(([, v]) => v !== null)) };
        const r = await q(
          `UPDATE survey.visits SET status = 'completed', top_pain = COALESCE($2, top_pain),
                  template_fit = COALESCE($3, template_fit), fit_score = COALESCE($4, fit_score),
                  interest_level = COALESCE($5, interest_level), pilot_status = COALESCE($6, pilot_status),
                  pilot_date = COALESCE($7, pilot_date), next_step = COALESCE($8, next_step),
                  next_step_date = COALESCE($9, next_step_date), part_c = $10, updated_at = now()
            WHERE id = $1 RETURNING *`,
          [id, w.top_pain, w.template_fit, w.fit_score, w.interest_level, w.pilot_status,
           w.pilot_date, w.next_step, w.next_step_date, JSON.stringify(partC)]);
        json(res, 200, r.rows[0]);
        return true;
      }

      /* ---------------- A10 photo upload ---------------- */
      if (req.method === 'POST' && seg[3] === 'attachments') {
        if (!(req.headers['content-type'] || '').includes('multipart/form-data')) {
          json(res, 400, { error: 'multipart/form-data required' }); return true;
        }
        const raw = await readRaw(req, MAX_UPLOAD + 512 * 1024);
        const { fields, file } = parseMultipart(raw, req.headers['content-type']);
        const kind = inList(fields.kind, ATTACH_KINDS) || 'other';
        if (!file) { json(res, 400, { error: 'no file in upload' }); return true; }
        if (file.data.length > MAX_UPLOAD) { json(res, 413, { error: 'photo larger than 5 MB' }); return true; }
        const sniff = sniffImage(file.data);
        if (!sniff) { json(res, 415, { error: 'only JPG, PNG or WebP images are accepted' }); return true; }
        await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });
        const name = `v${id}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${sniff.ext}`;
        await fs.promises.writeFile(path.join(UPLOAD_DIR, name), file.data);
        const r = await q(
          'INSERT INTO survey.attachments (visit_id, kind, file_path, uploaded_by) VALUES ($1, $2, $3, $4) RETURNING id, visit_id, kind, uploaded_by, created_at',
          [id, kind, name, user.email]);
        json(res, 201, r.rows[0]);
        return true;
      }

      json(res, 404, { error: 'not found' });
      return true;
    } catch (e) {
      if (e.message === 'body too large') { json(res, 413, { error: 'request too large' }); return true; }
      if (e instanceof SyntaxError) { json(res, 400, { error: 'bad request' }); return true; }
      console.error(e.message);   // details stay in the server log, not in the response
      json(res, 500, { error: 'server error' });
      return true;
    }
  };
};
