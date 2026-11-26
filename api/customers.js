import { route, send, readBody, getSql, needUser, query, audit, clean, cleanMulti, SEGMENTS, BUYER_TYPES, USAGE, REG_TYPES } from './_lib.js';
import { sapStatus, customer360, moreRows } from './_sap.js';
import { sendReminderWhatsApp, sendReminderEmail, appUrl } from './_notify.js';

// Accounts receivable: the same receivables.csv the MIS portal reads (published by refresh_receivables.ps1 on the SAP box).
const AR_URL = () => process.env.AR_CSV_URL || 'https://raw.githubusercontent.com/BSC23609/bsc-stock-data/main/receivables.csv';
let arCache = null;
function parseCsv(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const [head, ...body] = rows.filter(r => r.some(x => x.trim()));
  return body.map(r => Object.fromEntries((head || []).map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}
async function receivables() {
  if (arCache && Date.now() - arCache.at < 60000) return arCache;
  const headers = { 'Cache-Control': 'no-cache' };
  if (process.env.AR_CSV_TOKEN) headers.Authorization = `token ${process.env.AR_CSV_TOKEN}`;   // if the data repo is made private
  const r = await fetch(AR_URL() + '?t=' + Date.now(), { headers, signal: AbortSignal.timeout(15000) });
  if (!r.ok) { const e = new Error(`Receivables file not reachable (${r.status})`); e.status = 502; throw e; }
  const rows = parseCsv(await r.text()).map(x => ({
    branch: x.Branch, card_code: x.CardCode, name: x.CardName, bill_no: x.BillNo, bill_date: x.BillDate, due_date: x.DueDate,
    days: parseInt(x.DelayDays, 10) || 0, executive: x.Executive, amount: Number(x.Outstanding) || 0, mobile: x.Mobile, phone: x.Phone, email: x.Email
  }));
  arCache = { at: Date.now(), fetched: new Date().toISOString(), rows };
  return arCache;
}

// GET                      -> all customers (as pushed from SAP every 15 min) + CRM details
// GET ?code=C10001         -> customer 360 (SAP data + CRM history)
// GET ?code=..&more=invoices|payments&limit=200
// POST {action:'profile', code, ...}
export default route(async (req, res) => {
  const sql = getSql();
  if (req.method === 'POST') {
    const me = await needUser(req, { edit: true });
    const b = await readBody(req);
    if (b.action === 'profile') {
      const code = clean(b.code, 40);
      const [c] = await sql`SELECT card_code FROM crm_customers WHERE card_code = ${code}`;
      if (!c) return send(res, 404, { error: 'Unknown customer' });
      const segment = SEGMENTS.includes(b.segment) ? b.segment : clean(b.segment, 80) || null;
      const buyers = (Array.isArray(b.buyer_types) ? b.buyer_types : []).map(x => clean(x, 60)).filter(Boolean).slice(0, 10);
      const tags = (Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(',')).map(x => clean(x, 30)).filter(Boolean).slice(0, 12);
      await sql`INSERT INTO crm_profiles (card_code, segment, buyer_types, usage, reg_type, owner_email, tags, notes, updated_at, updated_by)
        VALUES (${code}, ${segment}, ${buyers}, ${USAGE.includes(b.usage) ? b.usage : null}, ${REG_TYPES.includes(b.reg_type) ? b.reg_type : null},
                ${clean(b.owner_email, 120).toLowerCase() || null}, ${tags}, ${cleanMulti(b.notes, 4000) || null}, now(), ${me.email})
        ON CONFLICT (card_code) DO UPDATE SET segment = EXCLUDED.segment, buyer_types = EXCLUDED.buyer_types, usage = EXCLUDED.usage,
          reg_type = EXCLUDED.reg_type, owner_email = EXCLUDED.owner_email, tags = EXCLUDED.tags, notes = EXCLUDED.notes,
          updated_at = now(), updated_by = EXCLUDED.updated_by`;
      await audit(me.email, 'profile', { code });
      return send(res, 200, { ok: true });
    }
    if (b.action === 'ar_remind') {   // payment reminder by WhatsApp + email; amounts are re-read here, never taken from the browser
      const codes = [...new Set((Array.isArray(b.codes) ? b.codes : []).map(c => clean(c, 40)).filter(Boolean))].slice(0, 150);
      if (!codes.length) return send(res, 400, { error: 'Select at least one customer' });
      const ar = await receivables();
      const logo = appUrl() + '/img/bsc-logo.png';
      const known = new Set((await sql`SELECT card_code FROM crm_customers WHERE card_code = ANY(${codes}::text[])`).map(r => r.card_code));
      const one = async code => {
        const inv = ar.rows.filter(r => r.card_code === code);
        if (!inv.length) return { code, ok: false, message: 'No open bills any more' };
        const g = { company: inv[0].name, amount: inv.reduce((a, r) => a + r.amount, 0), overdue: inv.filter(r => r.days > 0).reduce((a, r) => a + r.amount, 0),
          bills: inv.slice().sort((x, y) => y.days - x.days) };
        if (g.amount <= 0) return { code, company: g.company, ok: false, message: 'Nothing outstanding' };
        const phone = inv.map(r => r.mobile).find(p => String(p || '').replace(/\D/g, '').length >= 10) || inv.map(r => r.phone).find(p => /^(\+?91|0)?[6-9]\d{9}$/.test(String(p || '').replace(/[\s-]/g, ''))) || '';
        const email = inv.map(r => r.email).find(e => /@/.test(e || '')) || '';
        const [wa, em] = await Promise.all([b.whatsapp === false ? null : sendReminderWhatsApp(phone, g), b.email === false ? null : sendReminderEmail(email, g, logo)]);
        await sql`INSERT INTO crm_ar_reminders (card_code, company, amount, overdue, bills, phone, email, wa_ok, email_ok, detail, sent_by)
          VALUES (${code}, ${g.company}, ${g.amount}, ${g.overdue}, ${g.bills.length}, ${phone || null}, ${email || null}, ${wa ? wa.ok : null}, ${em ? em.ok : null},
                  ${JSON.stringify({ wa: wa?.message, email: em?.message })}::jsonb, ${me.email})`;
        if (known.has(code) && (wa?.ok || em?.ok)) await sql`INSERT INTO crm_activities (card_code, type, subject, notes, done, owner_email, created_by)
          VALUES (${code}, ${wa?.ok ? 'whatsapp' : 'email'}, ${'Payment reminder sent – ' + Math.round(g.amount).toLocaleString('en-IN')},
                  ${[wa?.message, em?.message].filter(Boolean).join('\n')}, true, ${me.email}, ${me.email})`;
        return { code, company: g.company, amount: g.amount, ok: !!(wa?.ok || em?.ok), wa, email: em };
      };
      const results = [];
      for (let i = 0; i < codes.length; i += 4) results.push(...await Promise.all(codes.slice(i, i + 4).map(c => one(c).catch(e => ({ code: c, ok: false, message: e.message })))));
      await audit(me.email, 'ar_remind', { n: codes.length, ok: results.filter(r => r.ok).length });
      return send(res, 200, { results });
    }
    return send(res, 400, { error: 'Unknown action' });
  }

  const me = await needUser(req);
  const q = query(req);

  if (q.get('ar')) {
    const ar = await receivables();
    const codes = [...new Set(ar.rows.map(r => r.card_code))];
    const known = codes.length ? await sql.query(`SELECT c.card_code, c.credit_line::float AS credit_line, c.slp_name, p.owner_email,
        (SELECT MAX(created_at) FROM crm_activities a WHERE a.card_code = c.card_code) AS last_activity,
        (SELECT COUNT(*)::int FROM crm_activities a WHERE a.card_code = c.card_code AND NOT a.done AND a.follow_up_at IS NOT NULL) AS open_followups
      FROM crm_customers c LEFT JOIN crm_profiles p ON p.card_code = c.card_code WHERE c.card_code = ANY($1::text[])`, [codes]) : [];
    const rem = codes.length ? await sql`SELECT DISTINCT ON (card_code) card_code, sent_at, sent_by, wa_ok, email_ok, amount::float AS amount FROM crm_ar_reminders
      WHERE card_code = ANY(${codes}::text[]) ORDER BY card_code, sent_at DESC` : [];
    return send(res, 200, { rows: ar.rows, fetched: ar.fetched, customers: Object.fromEntries(known.map(k => [k.card_code, k])), reminders: Object.fromEntries(rem.map(r => [r.card_code, r])) });
  }

  const code = q.get('code');
  if (code && q.get('more')) {
    const kind = q.get('more') === 'payments' ? 'payments' : 'invoices';
    return send(res, 200, { [kind]: await moreRows(code, kind, Number(q.get('limit')) || 200) });
  }

  if (code) {
    const [cached] = await sql`SELECT * FROM crm_customers WHERE card_code = ${code}`;
    if (!cached) return send(res, 404, { error: 'Customer not found (it reaches the CRM within 15 minutes of being created in SAP)' });
    const live = await customer360(code);
    const sap = await sapStatus();
    const [profile] = await sql`SELECT * FROM crm_profiles WHERE card_code = ${code}`;
    const kyc = await sql`SELECT id, ref, status, company, gstin, source, submitted_at, created_at, data->>'segment' AS segment FROM crm_kyc
                          WHERE card_code = ${code} OR (gstin IS NOT NULL AND gstin = ${cached?.gstin || '#'}) ORDER BY id DESC`;
    const feedback = await sql`SELECT id, invoice_no, invoice_date, score, comment, status, discount, created_at,
                                      q_delivery, q_quality, q_response, q_comm, q_relation, q_docs, q_pricing
                               FROM crm_feedback WHERE card_code = ${code} ORDER BY created_at DESC`;
    const activities = await sql`SELECT * FROM crm_activities WHERE card_code = ${code} ORDER BY created_at DESC LIMIT 200`;
    const leads = await sql`SELECT id, company, stage, product, est_mt, updated_at FROM crm_leads WHERE card_code = ${code} ORDER BY id DESC`;
    // Other SAP ledgers of the same company (same PAN, different GSTIN/state) — helps spot duplicates and branches.
    const related = cached?.pan ? await sql`SELECT card_code, name, gstin, state FROM crm_customers WHERE pan = ${cached.pan} AND card_code <> ${code}` : [];
    const mails = await sql`SELECT m.id, m.received_at, m.from_email, m.from_name, m.subject, m.category, m.party_id, m.attachments,
        m.extracted->>'summary' AS summary, m.extracted->>'action_needed' AS action_needed, m.extracted->'products' AS products
      FROM crm_mail m WHERE m.card_code = ${code} ORDER BY m.received_at DESC LIMIT 100`;
    return send(res, 200, { cached, live, sap, profile: profile || null, kyc, feedback, activities, leads, related, mails });
  }

  const rows = await sql`
    SELECT c.card_code, c.name, c.gstin, c.slp_code, c.slp_name, c.group_name, c.city, c.state, c.phone, c.email,
           c.balance::float AS balance, c.orders_bal::float AS orders_bal, c.credit_line::float AS credit_line,
           c.sales365::float AS sales365, c.sales90::float AS sales90, c.qty365::float AS qty365, c.invoices365,
           c.last_invoice, c.frozen, c.in_sap, c.created_sap,
           p.segment, p.buyer_types, p.usage, p.owner_email, p.tags,
           f.n AS fb_count, f.avg AS fb_avg,
           a.open AS open_followups, a.last_at AS last_activity
    FROM crm_customers c
    LEFT JOIN crm_profiles p ON p.card_code = c.card_code
    LEFT JOIN (SELECT card_code, COUNT(*)::int AS n, ROUND(AVG(score), 2)::float AS avg FROM crm_feedback WHERE card_code IS NOT NULL GROUP BY card_code) f
           ON f.card_code = c.card_code
    LEFT JOIN (SELECT card_code, COUNT(*) FILTER (WHERE follow_up_at IS NOT NULL AND NOT done)::int AS open, MAX(created_at) AS last_at
               FROM crm_activities WHERE card_code IS NOT NULL GROUP BY card_code) a ON a.card_code = c.card_code
    ORDER BY c.name`;
  return send(res, 200, { customers: rows, sync: await sapStatus(), me: { slp_code: me.slp_code } });
});
