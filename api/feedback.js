// Customer feedback form (same 9 questions as the Microsoft Form).
// Public: options | submit        Staff: list | customers | update | relink | import | delete | send
import { route, send, readBody, getSql, needUser, audit, loadConfig, clientIp, rateLimit, fail, FEEDBACK_QS, scoreOf, clean, cleanMulti, isAdmin, canEdit } from './_lib.js';
import { invoiceLookup } from './_sap.js';
import { sendFeedbackWhatsApp, sendFeedbackEmail, appUrl } from './_notify.js';

// Find the SAP invoice for the number the customer typed (from the SAP data pushed every 15 min).
async function lookupInvoice(no) {
  try { return no ? await invoiceLookup(no) : null; } catch (e) { console.warn('invoice lookup failed', e.message); return null; }
}
const invFields = m => m ? {
  card_code: m.CardCode, customer_name: m.CardName, invoice_date: String(m.DocDate || '').slice(0, 10) || null,
  invoice_qty: m.Qty != null ? Number(m.Qty) : null, slp_name: m.SlpName || null, invoice_no_sap: m.InvoiceNo || String(m.DocNum)
} : {};

function scoreAnswers(answers, lowScore) {
  const s = {};
  for (const q of FEEDBACK_QS) s[q.key] = answers[q.key] ? scoreOf(q, answers[q.key]) : null;
  const vals = Object.values(s).filter(v => v != null);
  const score = vals.length ? Math.round((vals.reduce((a, v) => a + v, 0) / vals.length) * 100) / 100 : null;
  const low = vals.some(v => v <= lowScore);
  return { s, score, low };
}

async function insertFeedback(sql, { invoiceNo, answers, comment, inv, cfg, source, ip, when }) {
  const { s, score, low } = scoreAnswers(answers, cfg.lowScore);
  const f = invFields(inv);
  // One discount per invoice: a repeat response for the same invoice is not eligible again.
  const [prev] = invoiceNo ? await sql`SELECT id FROM crm_feedback WHERE lower(invoice_no) = lower(${invoiceNo}) LIMIT 1` : [null];
  const old = when && Date.now() - Date.parse(when) > 90 * 864e5;   // imported responses older than 90 days
  const discount = !invoiceNo || prev || old ? 'na' : 'eligible';
  const note = prev ? 'Repeat response for the same invoice' : !invoiceNo ? 'No invoice number given' : old ? 'Imported, older than 90 days' : null;
  const [r] = await sql`INSERT INTO crm_feedback (invoice_no, card_code, customer_name, invoice_date, invoice_qty, slp_name,
      q_delivery, q_quality, q_response, q_comm, q_relation, q_docs, q_pricing, score, comment, answers, status, discount, discount_note, source, ip, created_at)
    VALUES (${invoiceNo || null}, ${f.card_code || null}, ${f.customer_name || null}, ${f.invoice_date || null}, ${f.invoice_qty ?? null}, ${f.slp_name || null},
      ${s.q_delivery}, ${s.q_quality}, ${s.q_response}, ${s.q_comm}, ${s.q_relation}, ${s.q_docs}, ${s.q_pricing}, ${score}, ${comment || null},
      ${JSON.stringify({ ...answers, _sap_invoice: f.invoice_no_sap || null })}::jsonb, ${low ? 'followup' : 'new'}, ${discount}, ${note}, ${source}, ${ip || null},
      ${when || new Date().toISOString()})
    RETURNING id, status`;
  if (low && f.card_code && source === 'form') {
    // Put a follow-up on the customer's timeline so it shows in everyone's "Follow-ups due".
    const due = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
    await sql`INSERT INTO crm_activities (card_code, feedback_id, type, subject, notes, follow_up_at, created_by)
      VALUES (${f.card_code}, ${r.id}, 'complaint', ${'Low feedback score' + (invoiceNo ? ' · invoice ' + invoiceNo : '')},
              ${comment || 'Customer gave a low rating — call and understand the issue.'}, ${due}, 'feedback form')`;
  }
  return r;
}

/* ---------- Microsoft Forms export import ---------- */
const MS_MAP = [
  [/invoice number/i, 'invoice'], [/delivery commitment/i, 'q_delivery'], [/quality of the supplied/i, 'q_quality'],
  [/response to your queries/i, 'q_response'], [/clear and timely/i, 'q_comm'], [/working relationship/i, 'q_relation'],
  [/documentation provided/i, 'q_docs'], [/pricing and commercial/i, 'q_pricing'], [/suggestion or comment/i, 'comment'],
  [/^completion time$/i, 'when'], [/^start time$/i, 'start']
];

export default route(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const b = await readBody(req);
  const sql = getSql();

  if (b.action === 'options') {
    const cfg = await loadConfig();
    return send(res, 200, { open: cfg.feedbackOpen, questions: FEEDBACK_QS, discountPerTon: cfg.discountPerTon });
  }

  if (b.action === 'submit') {
    const cfg = await loadConfig();
    if (!cfg.feedbackOpen) throw fail(403, 'The feedback form is closed.');
    await rateLimit('crm_feedback', clientIp(req), 15);
    const answers = {}, errors = {};
    for (const q of FEEDBACK_QS) {
      const v = String((b.answers || {})[q.key] || '');
      if (v && !q.options.includes(v)) errors[q.key] = 'Pick one of the options';
      else if (v) answers[q.key] = v;
      else if (q.required) errors[q.key] = 'This question is required';
    }
    if (Object.keys(errors).length) return send(res, 400, { error: 'Please answer the required questions', errors });
    const invoiceNo = clean(b.invoice_no, 40);
    const inv = await lookupInvoice(invoiceNo);
    const r = await insertFeedback(sql, { invoiceNo, answers, comment: cleanMulti(b.comment, 2000), inv, cfg, source: 'form', ip: clientIp(req) });
    await audit('public', 'feedback_submit', { id: r.id, invoice: invoiceNo });
    return send(res, 200, { ok: true });
  }

  /* ================= staff ================= */
  const me = await needUser(req);

  if (b.action === 'list') {
    const rows = await sql`SELECT f.*, f.score::float AS score, f.invoice_qty::float AS invoice_qty, c.name AS sap_name, c.slp_name AS cust_slp,
        p.segment, p.owner_email
      FROM crm_feedback f LEFT JOIN crm_customers c ON c.card_code = f.card_code LEFT JOIN crm_profiles p ON p.card_code = f.card_code
      ORDER BY f.created_at DESC LIMIT 5000`;
    for (const r of rows) delete r.ip;
    const cfg = await loadConfig();
    return send(res, 200, { rows, questions: FEEDBACK_QS, discountPerTon: cfg.discountPerTon, lowScore: cfg.lowScore });
  }


  if (b.action === 'customers') {   // customers invoiced in the period: quantity, value, last invoice, last feedback, last request
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(b.from || '')) ? b.from : '2000-01-01';
    const rows = await sql`WITH inv AS (
        SELECT card_code, COUNT(*)::int AS invoices, COALESCE(SUM((data->>'Qty')::numeric), 0)::float AS qty,
               COALESCE(SUM((data->>'DocTotal')::numeric - COALESCE((data->>'VatSum')::numeric, 0)), 0)::float AS value,
               MAX(doc_date) AS last_date,
               (ARRAY_AGG(COALESCE(data->>'InvoiceNo', data->>'DocNum') ORDER BY doc_date DESC, (data->>'DocEntry')::int DESC))[1] AS last_inv,
               (ARRAY_AGG(data->>'SlpName' ORDER BY doc_date DESC))[1] AS inv_slp
        FROM crm_sap WHERE section = 'invoices' AND card_code IS NOT NULL AND doc_date >= ${from}::date AND COALESCE(data->>'CANCELED', 'N') <> 'Y'
        GROUP BY card_code)
      SELECT i.*, c.name, c.phone, c.email, c.slp_name, c.data->>'Cellular' AS mobile, c.data->>'CntctPrsn' AS contact,
        (SELECT MAX(created_at) FROM crm_feedback f WHERE f.card_code = i.card_code) AS last_feedback,
        (SELECT score::float FROM crm_feedback f WHERE f.card_code = i.card_code ORDER BY created_at DESC LIMIT 1) AS last_score,
        (SELECT row_to_json(r) FROM (SELECT sent_at, sent_by, wa_ok, email_ok, invoice_no FROM crm_fb_requests q WHERE q.card_code = i.card_code ORDER BY sent_at DESC LIMIT 1) r) AS last_request
      FROM inv i LEFT JOIN crm_customers c ON c.card_code = i.card_code ORDER BY i.qty DESC`;
    return send(res, 200, { rows });
  }

  if (!canEdit(me)) throw fail(403, 'You have view-only access');

  if (b.action === 'send') {   // feedback form link (with the latest invoice filled in) by WhatsApp + email
    const codes = [...new Set((Array.isArray(b.codes) ? b.codes : []).map(c => clean(c, 40)).filter(Boolean))].slice(0, 150);
    if (!codes.length) return send(res, 400, { error: 'Select at least one customer' });
    const base = appUrl(), logo = base + '/img/bsc-logo.png';
    const one = async code => {
      const [c] = await sql`SELECT card_code, name, phone, email, data FROM crm_customers WHERE card_code = ${code}`;
      if (!c) return { code, ok: false, message: 'Not an SAP customer' };
      const [inv] = await sql`SELECT COALESCE(data->>'InvoiceNo', data->>'DocNum') AS no FROM crm_sap WHERE section = 'invoices' AND card_code = ${code}
        AND COALESCE(data->>'CANCELED', 'N') <> 'Y' ORDER BY doc_date DESC, (data->>'DocEntry')::int DESC LIMIT 1`;
      const invoice = inv?.no || '';
      const f = { company: c.name, invoice, link: base + '/feedback' + (invoice ? '?inv=' + encodeURIComponent(invoice) : '') };
      const phone = [c.data?.Cellular, c.phone, c.data?.Phone1, c.data?.Phone2].find(p => String(p || '').replace(/\D/g, '').length >= 10) || '';
      const email = c.email || c.data?.E_Mail || '';
      const [wa, em] = await Promise.all([b.whatsapp === false ? null : sendFeedbackWhatsApp(phone, f), b.email === false ? null : sendFeedbackEmail(email, f, logo)]);
      await sql`INSERT INTO crm_fb_requests (card_code, company, invoice_no, link, phone, email, wa_ok, email_ok, detail, sent_by)
        VALUES (${code}, ${c.name}, ${invoice || null}, ${f.link}, ${phone || null}, ${email || null}, ${wa ? wa.ok : null}, ${em ? em.ok : null},
                ${JSON.stringify({ wa: wa?.message, email: em?.message })}::jsonb, ${me.email})`;
      if (wa?.ok || em?.ok) await sql`INSERT INTO crm_activities (card_code, type, subject, notes, done, owner_email, created_by)
        VALUES (${code}, ${wa?.ok ? 'whatsapp' : 'email'}, ${'Feedback form sent' + (invoice ? ' – invoice ' + invoice : '')}, ${[wa?.message, em?.message].filter(Boolean).join('\n')}, true, ${me.email}, ${me.email})`;
      return { code, company: c.name, invoice, ok: !!(wa?.ok || em?.ok), wa, email: em };
    };
    const results = [];
    for (let i = 0; i < codes.length; i += 4) results.push(...await Promise.all(codes.slice(i, i + 4).map(c => one(c).catch(e => ({ code: c, ok: false, message: e.message })))));
    await audit(me.email, 'feedback_send', { n: codes.length, ok: results.filter(r => r.ok).length });
    return send(res, 200, { results });
  }


  if (b.action === 'update') {
    const id = Number(b.id);
    const [r] = await sql`SELECT * FROM crm_feedback WHERE id = ${id}`;
    if (!r) return send(res, 404, { error: 'Not found' });
    const status = ['new', 'followup', 'closed'].includes(b.status) ? b.status : r.status;
    const discount = ['eligible', 'applied', 'na'].includes(b.discount) ? b.discount : r.discount;
    let card = b.card_code === undefined ? r.card_code : (clean(b.card_code, 40) || null);
    let name = r.customer_name;
    if (card && card !== r.card_code) {
      const [c] = await sql`SELECT name FROM crm_customers WHERE card_code = ${card}`;
      if (!c) return send(res, 400, { error: 'Unknown SAP customer code' });
      name = c.name;
    }
    await sql`UPDATE crm_feedback SET status = ${status}, assigned_to = ${clean(b.assigned_to ?? r.assigned_to, 120) || null},
              action_note = ${cleanMulti(b.action_note ?? r.action_note, 2000) || null}, discount = ${discount},
              discount_note = ${cleanMulti(b.discount_note ?? r.discount_note, 300) || null}, card_code = ${card}, customer_name = ${name},
              closed_at = ${status === 'closed' ? (r.closed_at || new Date().toISOString()) : null} WHERE id = ${id}`;
    if (status === 'closed') await sql`UPDATE crm_activities SET done = true, updated_at = now() WHERE feedback_id = ${id}`;
    await audit(me.email, 'feedback_update', { id, status, discount });
    return send(res, 200, { ok: true });
  }

  if (b.action === 'relink') {   // retry the SAP invoice lookup for responses that were not matched
    const rows = await sql`SELECT id, invoice_no FROM crm_feedback WHERE card_code IS NULL AND invoice_no IS NOT NULL ORDER BY id DESC LIMIT 200`;
    let linked = 0;
    for (const r of rows) {
      const f = invFields(await lookupInvoice(r.invoice_no));
      if (!f.card_code) continue;
      await sql`UPDATE crm_feedback SET card_code = ${f.card_code}, customer_name = ${f.customer_name}, invoice_date = ${f.invoice_date},
                invoice_qty = ${f.invoice_qty ?? null}, slp_name = ${f.slp_name} WHERE id = ${r.id}`;
      linked++;
    }
    return send(res, 200, { ok: true, checked: rows.length, linked });
  }

  if (b.action === 'import') {
    const headers = (Array.isArray(b.headers) ? b.headers : []).map(h => String(h || '').trim());
    const col = {};
    headers.forEach((h, i) => { for (const [re, k] of MS_MAP) if (re.test(h) && col[k] == null) col[k] = i; });
    if (col.q_delivery == null || col.q_quality == null) return send(res, 400, { error: 'This does not look like the feedback form export (question columns not found).' });
    const cfg = await loadConfig();
    let added = 0, skipped = 0;
    for (const row of (Array.isArray(b.rows) ? b.rows : []).slice(0, 5000)) {
      const get = k => (col[k] == null ? '' : String(row[col[k]] ?? '').trim());
      const answers = {};
      for (const q of FEEDBACK_QS) { const v = get(q.key); if (q.options.includes(v)) answers[q.key] = v; }
      if (!Object.keys(answers).length) { skipped++; continue; }
      const whenRaw = get('when') || get('start');
      const when = whenRaw && !isNaN(Date.parse(whenRaw)) ? new Date(whenRaw).toISOString() : null;
      const invoiceNo = clean(get('invoice'), 40);
      const [dup] = await sql`SELECT id FROM crm_feedback WHERE source = 'import' AND COALESCE(invoice_no,'') = ${invoiceNo}
                              AND created_at = ${when || '1970-01-01'}::timestamptz`;
      if (dup) { skipped++; continue; }
      await insertFeedback(sql, { invoiceNo, answers, comment: cleanMulti(get('comment'), 2000), inv: await lookupInvoice(invoiceNo), cfg, source: 'import', when });
      added++;
    }
    await audit(me.email, 'feedback_import', { added, skipped });
    return send(res, 200, { ok: true, added, skipped });
  }

  if (b.action === 'delete') {
    if (!isAdmin(me)) throw fail(403, 'Admins only');
    await sql`DELETE FROM crm_activities WHERE feedback_id = ${Number(b.id)}`;
    await sql`DELETE FROM crm_feedback WHERE id = ${Number(b.id)}`;
    await audit(me.email, 'feedback_delete', { id: Number(b.id) });
    return send(res, 200, { ok: true });
  }
  return send(res, 400, { error: 'Unknown action' });
});
