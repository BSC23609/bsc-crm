// Ledger / KYC form ("SAP LEDGER CREATION DATA SHEET").
// Public (no sign-in):  options | draft | submit
// Staff:                list | get | update | invite | delete | import | export
import { route, send, readBody, getSql, needUser, audit, loadConfig, randomToken, clientIp, rateLimit, fail,
  BUYER_TYPES, SEGMENTS, USAGE, REG_TYPES, KYC_DOCS, KYC_STATUSES, STATE_CODES, gstinProblem, panOf, ifscOk, pinOk, phoneDigits, emailOk,
  clean, cleanMulti, canEdit, isAdmin } from './_lib.js';
import { del } from '@vercel/blob';
import { sendKycEmail, sendKycWhatsApp, appUrl } from './_notify.js';
import { blobReady, blobMode, blobAccess } from './_blob.js';

// SAP customer by code (a customer created in SAP reaches the CRM with the next 15-minute push).
async function sapCustomer(sql, code) {
  const [c] = await sql`SELECT * FROM crm_customers WHERE card_code = ${code}`;
  return c || null;
}

const refOf = (id, at) => `KYC-${String(new Date(at || Date.now()).getFullYear()).slice(2)}-${String(id).padStart(4, '0')}`;
const STATES = [...new Set(Object.values(STATE_CODES))].filter(s => s !== 'Other Territory').sort();

// Normalise + validate a submitted form. Returns {data, errors, warnings}.
export function checkForm(raw, { partial = false } = {}) {
  const d = {
    company: clean(raw.company, 200), company_type: clean(raw.company_type, 120), contact_person: clean(raw.contact_person, 120),
    phone: phoneDigits(raw.phone), email: clean(raw.email, 160).toLowerCase(),
    buyer_types: (Array.isArray(raw.buyer_types) ? raw.buyer_types : []).map(x => clean(x, 80)).filter(Boolean).slice(0, 10),
    buyer_other: clean(raw.buyer_other, 120),
    segment: clean(raw.segment, 80), segment_other: clean(raw.segment_other, 120), usage: clean(raw.usage, 40),
    bill_address: cleanMulti(raw.bill_address, 600), bill_district: clean(raw.bill_district, 80), bill_pincode: clean(raw.bill_pincode, 6),
    bill_state: clean(raw.bill_state, 60), gstin: clean(raw.gstin, 15).toUpperCase().replace(/\s/g, ''), reg_type: clean(raw.reg_type, 40),
    bank_name: clean(raw.bank_name, 160), bank_account: clean(raw.bank_account, 30).replace(/\s/g, ''), ifsc: clean(raw.ifsc, 11).toUpperCase(),
    ship_same: !!raw.ship_same,
    ship_trade_name: clean(raw.ship_trade_name, 200), ship_address: cleanMulti(raw.ship_address, 600), ship_district: clean(raw.ship_district, 80),
    ship_pincode: clean(raw.ship_pincode, 6), ship_state: clean(raw.ship_state, 60), ship_gstin: clean(raw.ship_gstin, 15).toUpperCase().replace(/\s/g, '')
  };
  if (d.ship_same) Object.assign(d, { ship_trade_name: d.ship_trade_name || d.company, ship_address: d.bill_address, ship_district: d.bill_district,
    ship_pincode: d.bill_pincode, ship_state: d.bill_state, ship_gstin: d.gstin });
  const errors = {}, warnings = [];
  const need = (k, label) => { if (!d[k] || (Array.isArray(d[k]) && !d[k].length)) errors[k] = label + ' is required'; };
  if (!partial) {
    need('company', 'Company Name'); need('company_type', 'Company Type'); need('phone', 'Contact Number'); need('email', 'Email Address');
    if (!d.buyer_types.length && !d.buyer_other) errors.buyer_types = 'Pick at least one Type of Buyer';
    if (!d.segment) errors.segment = 'Customer Industry Segment is required';
    need('usage', 'Usage'); need('bill_address', 'Billing Address'); need('bill_district', 'District'); need('bill_pincode', 'Pincode');
    need('bill_state', 'State'); need('gstin', 'GST Number'); need('reg_type', 'Company Registration Type'); need('bank_name', 'Bank Trade Name');
    need('bank_account', 'Bank Account Number'); need('ifsc', 'IFSC Code'); need('ship_trade_name', 'Trade Name'); need('ship_address', 'Shipping Address');
    need('ship_district', 'District'); need('ship_pincode', 'Pincode'); need('ship_state', 'State'); need('ship_gstin', 'GST Number');
  }
  if (d.phone && !/^[6-9]\d{9}$|^0\d{9,11}$/.test(d.phone)) errors.phone = 'Enter a 10-digit mobile number (or landline with STD code)';
  if (d.email && !emailOk(d.email)) errors.email = 'Enter a valid email address';
  if (d.segment && d.segment !== 'Other' && !SEGMENTS.includes(d.segment)) errors.segment = 'Pick a segment from the list';
  if (d.segment === 'Other' && !d.segment_other && !partial) errors.segment_other = 'Tell us your industry segment';
  if (d.usage && !USAGE.includes(d.usage)) errors.usage = 'Pick Once or Monthly Requirement';
  if (d.reg_type && !REG_TYPES.includes(d.reg_type)) errors.reg_type = 'Pick a registration type';
  if (d.bill_pincode && !pinOk(d.bill_pincode)) errors.bill_pincode = 'Pincode must be 6 digits';
  if (d.ship_pincode && !pinOk(d.ship_pincode)) errors.ship_pincode = 'Pincode must be 6 digits';
  if (d.gstin) { const p = gstinProblem(d.gstin); if (p) errors.gstin = p; }
  if (d.ship_gstin) { const p = gstinProblem(d.ship_gstin); if (p) errors.ship_gstin = p; }
  if (d.ifsc && !ifscOk(d.ifsc)) errors.ifsc = 'IFSC is 11 characters like SBIN0001234';
  if (d.bank_account && !/^[0-9A-Z]{6,20}$/i.test(d.bank_account)) errors.bank_account = 'Account number should be 6–20 letters/digits';
  // Soft checks for the reviewer (do not block the customer)
  if (d.gstin && !errors.gstin && d.bill_state && STATE_CODES[d.gstin.slice(0, 2)] !== d.bill_state)
    warnings.push(`Billing state "${d.bill_state}" differs from the GSTIN state (${STATE_CODES[d.gstin.slice(0, 2)]})`);
  if (d.ship_gstin && !errors.ship_gstin && d.ship_state && STATE_CODES[d.ship_gstin.slice(0, 2)] !== d.ship_state)
    warnings.push(`Shipping state "${d.ship_state}" differs from the shipping GSTIN state (${STATE_CODES[d.ship_gstin.slice(0, 2)]})`);
  if (d.gstin && d.ship_gstin && !errors.gstin && !errors.ship_gstin && panOf(d.gstin) !== panOf(d.ship_gstin))
    warnings.push('Billing and shipping GSTINs belong to different PANs (different companies)');
  if (d.gstin && !errors.gstin) {
    const ent = d.gstin[5];  // 4th PAN letter: C company, F firm/LLP, P individual, G government ...
    if (d.reg_type === 'PVT LTD' && ent !== 'C') warnings.push('Registration type is PVT LTD but the PAN is not a company PAN');
    if (d.reg_type === 'Proprietorship' && ent !== 'P') warnings.push('Registration type is Proprietorship but the PAN is not an individual PAN');
    if (d.reg_type === 'LLP' && ent !== 'F') warnings.push('Registration type is LLP but the PAN is not a firm/LLP PAN');
  }
  return { data: d, errors, warnings };
}

async function duplicateChecks(sql, d, selfId) {
  const out = [];
  if (!d.gstin) return out;
  const sap = await sql`SELECT card_code, name, gstin FROM crm_customers WHERE gstin = ${d.gstin} OR (pan = ${panOf(d.gstin)} AND gstin <> ${d.gstin}) LIMIT 6`;
  for (const c of sap) out.push(c.gstin === d.gstin ? `Already in SAP: ${c.card_code} · ${c.name}` : `Same PAN in SAP (other GSTIN): ${c.card_code} · ${c.name} · ${c.gstin}`);
  const k = await sql`SELECT id, ref, status FROM crm_kyc WHERE gstin = ${d.gstin} AND id <> ${selfId || 0} AND status <> 'rejected' AND status <> 'draft' LIMIT 4`;
  for (const r of k) out.push(`Another ledger request with this GSTIN: ${r.ref || '#' + r.id} (${r.status})`);
  return out;
}

const maskAcct = a => (a ? '•••• ' + String(a).slice(-4) : '');

async function filesFor(sql, id) {
  return sql`SELECT id, doc_type, name, size, content_type, pathname IS NULL AS external, url, created_at FROM crm_files WHERE kind = 'kyc' AND ref = ${String(id)} ORDER BY id`;
}

// Copy what the customer told us into the CRM profile once the ledger is linked to a SAP customer.
async function applyProfile(sql, row, who) {
  if (!row.card_code) return;
  const d = row.data || {};
  const segment = d.segment === 'Other' ? (d.segment_other || 'Other') : d.segment || null;
  const buyers = [...(d.buyer_types || []), ...(d.buyer_other ? [d.buyer_other] : [])];
  await sql`INSERT INTO crm_profiles (card_code, segment, buyer_types, usage, reg_type, updated_by)
            VALUES (${row.card_code}, ${segment}, ${buyers}, ${d.usage || null}, ${d.reg_type || null}, ${who})
            ON CONFLICT (card_code) DO UPDATE SET segment = COALESCE(EXCLUDED.segment, crm_profiles.segment),
              buyer_types = CASE WHEN cardinality(EXCLUDED.buyer_types) > 0 THEN EXCLUDED.buyer_types ELSE crm_profiles.buyer_types END,
              usage = COALESCE(EXCLUDED.usage, crm_profiles.usage), reg_type = COALESCE(EXCLUDED.reg_type, crm_profiles.reg_type),
              updated_at = now(), updated_by = EXCLUDED.updated_by`;
}

/* ---------- Google Form import ---------- */
// Google Sheets export of the responses: question titles as headers; District/Pincode/State/GST Number appear twice
// (billing first, shipping second). File questions hold Google Drive links.
function mapGoogleRow(headers, row) {
  const seen = {};
  const d = { buyer_types: [] }, links = [];
  let ts = null;
  headers.forEach((h, i) => {
    const key = String(h || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const v = row[i] == null ? '' : String(row[i]).trim();
    seen[key] = (seen[key] || 0) + 1;
    const second = seen[key] > 1;
    if (key === 'timestamp') ts = v;
    else if (key === 'company name') d.company = v;
    else if (key === 'company type') d.company_type = v;
    else if (key === 'contact number') d.phone = v;
    else if (key === 'email address' || key === 'email') { if (!d.email || second) d.email = v || d.email; }
    else if (key === 'type of buyer') {
      for (const part of v.split(/,\s*(?=[A-Z])/)) { const p = part.trim(); if (!p) continue; if (BUYER_TYPES.includes(p)) d.buyer_types.push(p); else d.buyer_other = p; }
    }
    else if (key === 'customer industry segment') { if (SEGMENTS.includes(v)) d.segment = v; else if (v) { d.segment = 'Other'; d.segment_other = v; } }
    else if (key === 'usage') d.usage = v;
    else if (key === 'billing address') d.bill_address = v;
    else if (key === 'district') d[second ? 'ship_district' : 'bill_district'] = v;
    else if (key === 'pincode') d[second ? 'ship_pincode' : 'bill_pincode'] = v;
    else if (key === 'state') d[second ? 'ship_state' : 'bill_state'] = v;
    else if (key === 'gst number') d[second ? 'ship_gstin' : 'gstin'] = v;
    else if (key === 'company registration type') d.reg_type = v === 'Prorietorship' ? 'Proprietorship' : v;
    else if (key === 'bank trade name') d.bank_name = v;
    else if (key === 'bank account number') d.bank_account = v;
    else if (key === 'ifsc code') d.ifsc = v;
    else if (key === 'trade name') d.ship_trade_name = v;
    else if (key === 'shipping address') d.ship_address = v;
    else if (key.startsWith('gst certificate (billing')) links.push(['gst_billing', v]);
    else if (key.startsWith('cancelled cheque')) links.push(['cheque', v]);
    else if (key.startsWith('gst certificate (shipping')) links.push(['gst_shipping', v]);
  });
  // A state typed in any case still matches the list
  for (const k of ['bill_state', 'ship_state']) { const m = STATES.find(s => s.toLowerCase() === String(d[k] || '').toLowerCase()); if (m) d[k] = m; }
  return { d, links, ts };
}

// Email (info@bharatsteels.in) and/or WhatsApp the personal form link; remembers what was sent on the request.
async function deliver(sql, req, id, token, to, opt, me) {
  const url = `${appUrl(req)}/kyc?t=${token}`;
  const who = { name: to.contact_person || '', company: to.company || '', url };
  const out = [];
  if (opt.send_email && to.email) out.push({ via: 'email', ...(await sendKycEmail({ ...who, to: to.email, logoUrl: `${appUrl(req)}/img/bsc-logo.png` })) });
  if (opt.send_wa && to.phone) out.push({ via: 'whatsapp', ...(await sendKycWhatsApp({ ...who, phone: to.phone, qrToken: token })) });
  if (out.length) {
    const log = out.map(x => ({ via: x.via, ok: x.ok, message: x.message, at: new Date().toISOString(), by: me.email }));
    await sql`UPDATE crm_kyc SET data = jsonb_set(data, '{_sent}', COALESCE(data->'_sent', '[]'::jsonb) || ${JSON.stringify(log)}::jsonb) WHERE id = ${id}`;
  }
  return out;
}

export default route(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const b = await readBody(req);
  const sql = getSql();

  /* ================= public ================= */
  if (b.action === 'options') {
    const cfg = await loadConfig();
    let prefill = null, invite = null;
    if (b.t) {
      const [r] = await sql`SELECT id, status, data, company FROM crm_kyc WHERE token = ${String(b.t)}`;
      if (!r) return send(res, 404, { error: 'This form link is not valid. Please ask Bharat Steel for a new link.' });
      if (r.status !== 'invited') return send(res, 200, { done: true, company: r.company });
      prefill = r.data || {}; invite = { id: r.id };
    }
    return send(res, 200, { open: cfg.kycOpen, buyerTypes: BUYER_TYPES, segments: SEGMENTS, usage: USAGE, regTypes: REG_TYPES, states: STATES,
      docs: KYC_DOCS, prefill, invite, storage: { ready: blobReady(), mode: blobMode(), access: blobAccess() } });
  }

  if (b.action === 'draft') {
    // A row to attach uploaded files to before the form is submitted. Invite links reuse their own row.
    const cfg = await loadConfig();
    if (!cfg.kycOpen) throw fail(403, 'The form is closed.');
    const key = randomToken(12);
    if (b.t) {
      const [r] = await sql`UPDATE crm_kyc SET draft_key = COALESCE(draft_key, ${key}) WHERE token = ${String(b.t)} AND status = 'invited' RETURNING id, draft_key`;
      if (!r) throw fail(404, 'This form link is not valid any more.');
      return send(res, 200, { id: r.id, key: r.draft_key });
    }
    await rateLimit('crm_kyc', clientIp(req), 25);
    const [r] = await sql`INSERT INTO crm_kyc (status, draft_key, source, ip) VALUES ('draft', ${key}, 'form', ${clientIp(req)}) RETURNING id`;
    return send(res, 200, { id: r.id, key });
  }

  if (b.action === 'submit') {
    const cfg = await loadConfig();
    if (!cfg.kycOpen) throw fail(403, 'The form is closed.');
    const { data, errors, warnings } = checkForm(b.data || {});
    if (Object.keys(errors).length) return send(res, 400, { error: 'Please correct the highlighted fields', errors });
    let row;
    if (b.t) [row] = await sql`SELECT id, status, draft_key, created_at, data FROM crm_kyc WHERE token = ${String(b.t)}`;
    else if (b.id) [row] = await sql`SELECT id, status, draft_key, created_at, data FROM crm_kyc WHERE id = ${Number(b.id)} AND status = 'draft'`;
    if (b.t && (!row || row.status !== 'invited')) throw fail(400, 'This form link has already been used.');
    if (row && !b.t && (!row.draft_key || row.draft_key !== b.key)) throw fail(403, 'Form session expired — please reload the page.');
    if (!row) { await rateLimit('crm_kyc', clientIp(req), 25); [row] = await sql`INSERT INTO crm_kyc (status, source, ip) VALUES ('draft', 'form', ${clientIp(req)}) RETURNING id, created_at`; }
    const files = await filesFor(sql, row.id);
    const missing = Object.entries(KYC_DOCS).filter(([k]) => !files.some(f => f.doc_type === k)).filter(([k]) => !(k === 'gst_shipping' && data.ship_same));
    if (missing.length && blobReady()) return send(res, 400, { error: 'Please upload: ' + missing.map(m => m[1]).join(', '), errors: Object.fromEntries(missing.map(([k, v]) => ['file_' + k, v + ' is required'])) });
    const checks = await duplicateChecks(sql, data, row.id);
    const card = (row.data && row.data._card_code) || null;
    const full = { ...data, _warnings: warnings, _checks: checks };
    const ref = refOf(row.id, row.created_at);
    await sql`UPDATE crm_kyc SET status = 'submitted', ref = ${ref}, data = ${JSON.stringify(full)}::jsonb, company = ${data.company}, gstin = ${data.gstin},
              card_code = COALESCE(card_code, ${card}), submitted_at = now(), updated_at = now(), ip = ${clientIp(req)}, draft_key = NULL WHERE id = ${row.id}`;
    await audit('public', 'kyc_submit', { id: row.id, ref, company: data.company });
    return send(res, 200, { ok: true, ref });
  }

  /* ================= staff ================= */
  const me = await needUser(req);

  if (b.action === 'list') {
    const rows = await sql`SELECT k.id, k.ref, k.status, k.company, k.gstin, k.card_code, k.source, k.invited_by, k.reviewed_by, k.submitted_at, k.created_at, k.updated_at,
        k.token, k.data->>'segment' AS segment, k.data->>'segment_other' AS segment_other, k.data->>'usage' AS usage, k.data->>'phone' AS phone,
        k.data->>'email' AS email, k.data->>'bill_state' AS state, k.data->>'bill_district' AS district, k.data->'buyer_types' AS buyer_types,
        COALESCE(jsonb_array_length(k.data->'_warnings'), 0) AS warn_n, COALESCE(jsonb_array_length(k.data->'_checks'), 0) AS dup_n,
        (SELECT COUNT(*)::int FROM crm_files f WHERE f.kind = 'kyc' AND f.ref = k.id::text) AS files, c.name AS sap_name
      FROM crm_kyc k LEFT JOIN crm_customers c ON c.card_code = k.card_code
      WHERE k.status <> 'draft' ORDER BY COALESCE(k.submitted_at, k.created_at) DESC`;
    return send(res, 200, { rows, statuses: KYC_STATUSES });
  }

  if (b.action === 'get') {
    const [r] = await sql`SELECT * FROM crm_kyc WHERE id = ${Number(b.id)}`;
    if (!r) return send(res, 404, { error: 'Not found' });
    const files = await filesFor(sql, r.id);
    if (!canEdit(me) && r.data) r.data = { ...r.data, bank_account: maskAcct(r.data.bank_account) };
    const [sap] = r.card_code ? await sql`SELECT card_code, name, gstin, balance::float AS balance FROM crm_customers WHERE card_code = ${r.card_code}` : [null];
    // Refresh duplicate checks on open (SAP copy may have changed since submission)
    const checks = r.data?.gstin ? await duplicateChecks(sql, r.data, r.id) : [];
    return send(res, 200, { row: { ...r, token: canEdit(me) ? r.token : null }, files, sap: sap || null, checks, docs: KYC_DOCS });
  }

  if (!canEdit(me)) throw fail(403, 'You have view-only access');

  if (b.action === 'update') {
    const id = Number(b.id);
    const [r] = await sql`SELECT * FROM crm_kyc WHERE id = ${id}`;
    if (!r) return send(res, 404, { error: 'Not found' });
    const status = KYC_STATUSES.includes(b.status) ? b.status : r.status;
    let card = b.card_code === undefined ? r.card_code : (clean(b.card_code, 40) || null);
    if (card) {
      const c = await sapCustomer(sql, card);
      if (!c) return send(res, 400, { error: `No SAP customer with code ${card} (a customer created in SAP shows up here within 15 minutes)` });
    }
    if (status === 'created' && !card) return send(res, 400, { error: 'Enter the SAP customer code to mark the ledger as created' });
    let data = r.data;
    if (b.data) {   // staff corrections to the form
      const chk = checkForm({ ...r.data, ...b.data }, { partial: true });
      if (Object.keys(chk.errors).length) return send(res, 400, { error: Object.values(chk.errors).join('\n'), errors: chk.errors });
      data = { ...chk.data, _warnings: chk.warnings, _checks: r.data?._checks || [] };
    }
    const [row] = await sql`UPDATE crm_kyc SET status = ${status}, card_code = ${card}, review_note = ${cleanMulti(b.review_note ?? r.review_note, 2000) || null},
              data = ${JSON.stringify(data)}::jsonb, company = ${data.company || r.company}, gstin = ${data.gstin || r.gstin},
              reviewed_by = ${me.email}, updated_at = now() WHERE id = ${id} RETURNING *`;
    if (card && ['approved', 'created'].includes(status)) await applyProfile(sql, row, me.email);
    await audit(me.email, 'kyc_update', { id, status, card_code: card });
    return send(res, 200, { ok: true });
  }

  if (b.action === 'invite') {
    // Pre-filled link for one customer (new prospect, or an existing SAP customer whose KYC is missing)
    let pre = { company: clean(b.company, 200), phone: phoneDigits(b.phone), email: clean(b.email, 160).toLowerCase(), contact_person: clean(b.contact_person, 120) };
    let card = clean(b.card_code, 40) || null;
    if (card) {
      const c = await sapCustomer(sql, card);
      if (!c) return send(res, 400, { error: 'Unknown SAP customer code' });
      pre = { company: pre.company || c.name, phone: pre.phone || phoneDigits(c.phone), email: pre.email || c.email || '', contact_person: pre.contact_person || c.data?.CntctPrsn || '',
              gstin: c.gstin || '', bill_state: c.state || '', _card_code: c.card_code };
    }
    if (!pre.company) return send(res, 400, { error: 'Enter the company name' });
    const token = randomToken(18);
    const [r] = await sql`INSERT INTO crm_kyc (status, token, company, card_code, data, source, invited_by, lead_ref)
      VALUES ('invited', ${token}, ${pre.company}, ${card}, ${JSON.stringify(pre)}::jsonb, 'invite', ${me.email}, ${b.lead_id ? Number(b.lead_id) : null}) RETURNING id`;
    await sql`UPDATE crm_kyc SET ref = ${refOf(r.id)} WHERE id = ${r.id}`;
    if (b.lead_id) await sql`UPDATE crm_leads SET kyc_id = ${r.id}, updated_at = now() WHERE id = ${Number(b.lead_id)}`;
    const sent = await deliver(sql, req, r.id, token, { ...pre, email: pre.email }, b, me);
    await audit(me.email, 'kyc_invite', { id: r.id, company: pre.company, sent: sent.map(x => x.ok) });
    return send(res, 200, { ok: true, id: r.id, token, phone: pre.phone, company: pre.company, sent });
  }

  if (b.action === 'resend') {   // send the personal link again (or to a corrected email / number)
    const [r] = await sql`SELECT id, token, status, data, company FROM crm_kyc WHERE id = ${Number(b.id)}`;
    if (!r || r.status !== 'invited' || !r.token) return send(res, 400, { error: 'This request has no open form link (already submitted?)' });
    const to = { ...r.data, company: r.data?.company || r.company,
                 email: clean(b.email, 160).toLowerCase() || r.data?.email, phone: phoneDigits(b.phone) || r.data?.phone };
    const sent = await deliver(sql, req, r.id, r.token, to, { send_email: b.send_email, send_wa: b.send_wa }, me);
    await audit(me.email, 'kyc_resend', { id: r.id, sent: sent.map(x => x.ok) });
    return send(res, 200, { ok: true, sent });
  }

  if (b.action === 'export') {
    const rows = await sql`SELECT k.ref, k.status, k.card_code, k.source, k.submitted_at, k.data, k.review_note FROM crm_kyc k
                           WHERE k.status NOT IN ('draft','invited') AND (${!b.status} OR k.status = ${b.status || ''}) ORDER BY k.submitted_at`;
    await audit(me.email, 'kyc_export', { n: rows.length });
    return send(res, 200, { rows });
  }

  if (b.action === 'import') {
    const headers = Array.isArray(b.headers) ? b.headers : [];
    const rows = Array.isArray(b.rows) ? b.rows.slice(0, 3000) : [];
    if (!headers.some(h => /company name/i.test(h))) return send(res, 400, { error: 'This does not look like the ledger form responses (no "Company Name" column).' });
    let added = 0, skipped = 0;
    const problems = [];
    for (const [i, row] of rows.entries()) {
      const { d, links, ts } = mapGoogleRow(headers, row);
      if (!d.company) { skipped++; continue; }
      const { data, errors, warnings } = checkForm(d, { partial: true });
      const when = ts && !isNaN(Date.parse(ts)) ? new Date(ts).toISOString() : null;
      const [dup] = await sql`SELECT id FROM crm_kyc WHERE source = 'import' AND company = ${data.company} AND COALESCE(gstin,'') = ${data.gstin || ''}
                              AND COALESCE(submitted_at::text,'') = COALESCE(${when}::timestamptz::text,'')`;
      if (dup) { skipped++; continue; }
      const checks = await duplicateChecks(sql, data, 0);
      const issues = Object.values(errors);
      if (issues.length) problems.push(`Row ${i + 2} (${data.company}): ${issues.join('; ')}`);
      const full = { ...data, _warnings: [...warnings, ...issues.map(x => 'Imported with issue: ' + x)], _checks: checks };
      const [r] = await sql`INSERT INTO crm_kyc (status, company, gstin, data, source, submitted_at, created_at)
        VALUES ('submitted', ${data.company}, ${data.gstin || null}, ${JSON.stringify(full)}::jsonb, 'import', ${when || new Date().toISOString()}, ${when || new Date().toISOString()}) RETURNING id, created_at`;
      await sql`UPDATE crm_kyc SET ref = ${refOf(r.id, r.created_at)} WHERE id = ${r.id}`;
      for (const [type, url] of links) for (const u of String(url).split(/[\s,]+/).filter(x => /^https?:\/\//.test(x)))
        await sql`INSERT INTO crm_files (kind, ref, doc_type, name, url, pathname, uploaded_by) VALUES ('kyc', ${String(r.id)}, ${type}, ${KYC_DOCS[type] + ' (Google Drive)'}, ${u}, NULL, ${me.email})`;
      added++;
    }
    // Link imported requests whose GSTIN is already a SAP customer
    await sql`UPDATE crm_kyc k SET card_code = c.card_code, status = 'created' FROM crm_customers c
              WHERE k.source = 'import' AND k.card_code IS NULL AND k.gstin IS NOT NULL AND c.gstin = k.gstin`;
    const linked = await sql`SELECT * FROM crm_kyc WHERE source = 'import' AND status = 'created' AND card_code IS NOT NULL`;
    for (const r of linked) await applyProfile(sql, r, me.email);
    await audit(me.email, 'kyc_import', { added, skipped });
    return send(res, 200, { ok: true, added, skipped, problems: problems.slice(0, 50) });
  }

  if (b.action === 'delete') {
    if (!isAdmin(me)) throw fail(403, 'Admins only');
    const fl = await sql`SELECT url, pathname FROM crm_files WHERE kind = 'kyc' AND ref = ${String(Number(b.id))}`;
    for (const f of fl) if (f.pathname) { try { await del(f.url); } catch (e) { console.warn('blob delete failed', e.message); } }
    await sql`DELETE FROM crm_files WHERE kind = 'kyc' AND ref = ${String(Number(b.id))}`;
    await sql`DELETE FROM crm_kyc WHERE id = ${Number(b.id)}`;
    await audit(me.email, 'kyc_delete', { id: Number(b.id) });
    return send(res, 200, { ok: true });
  }
  return send(res, 400, { error: 'Unknown action' });
});
