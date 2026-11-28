// Receives SAP Business One data from the scheduled task on the SAP server (sap-sync/refresh_crm.ps1).
// POST, header  Authorization: Bearer <SAP_PUSH_SECRET>, JSON body:
//   {run, section, mode: 'replace'|'upsert', rows: [...], last: true|false}    one batch (≤ 1,500 rows) of one section
//   {run, section: 'done', full: true|false, counts: {...}}                      end of a successful run
//   {run, section: 'error', message}                                             the task failed (shown in the CRM)
// 'replace' = this run sends the whole section; on the batch marked last, rows not sent in this run are removed.
import crypto from 'node:crypto';
import { route, send, readBody, getSql, panOf } from './_lib.js';
import { bpCheck } from './_mail.js';

const d = v => (v ? String(v).slice(0, 10) : null);
const num = v => Number(v) || 0;
// key / customer / date for each section (SAP column names as sent by the task)
const KEYS = {
  addresses: r => [`${r.CardCode}|${r.Type}|${r.Name}`, r.CardCode, null],
  contacts:  r => [`${r.CardCode}|${r.CntctCode ?? r.Name}`, r.CardCode, null],
  orders:    r => [String(r.DocEntry), r.CardCode, d(r.DocDate)],
  invoices:  r => [String(r.DocEntry), r.CardCode, d(r.DocDate)],
  payments:  r => [String(r.DocEntry), r.CardCode, d(r.DocDate)],
  monthly:   r => [`${r.CardCode}|${r.M}`, r.CardCode, r.M ? r.M + '-01' : null]
};
const CANCELLABLE = new Set(['invoices', 'payments', 'orders']);

function authorised(req) {
  const want = process.env.SAP_PUSH_SECRET || '';
  const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (want.length < 16 || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

async function pushCustomers(sql, rows, run) {
  const list = rows.filter(c => c && c.CardCode).map(c => ({
    card_code: String(c.CardCode), name: c.CardName || String(c.CardCode), gstin: String(c.GSTIN || '').toUpperCase().trim() || null,
    pan: panOf(String(c.GSTIN || '').toUpperCase().trim()), slp_code: c.SlpCode === '' || c.SlpCode == null ? null : Number(c.SlpCode), slp_name: c.SlpName || null,
    group_name: c.GroupName || null, city: c.BillCity || c.City || null, state: c.State || null, phone: c.Cellular || c.Phone1 || null, email: c.E_Mail || null,
    balance: num(c.Balance), orders_bal: num(c.OrdersBal), credit_line: num(c.CreditLine), sales365: num(c.Sales365), sales90: num(c.Sales90),
    qty365: num(c.Qty365), invoices365: num(c.Invoices365), last_invoice: d(c.LastInvoice), frozen: c.frozenFor === 'Y', created_sap: d(c.CreateDate), data: c
  }));
  if (!list.length) return 0;
  await sql.query(`
    INSERT INTO crm_customers (card_code, name, gstin, pan, slp_code, slp_name, group_name, city, state, phone, email, balance, orders_bal, credit_line,
      sales365, sales90, qty365, invoices365, last_invoice, frozen, created_sap, data, in_sap, run_id, synced_at)
    SELECT card_code, name, gstin, pan, slp_code, slp_name, group_name, city, state, phone, email, balance, orders_bal, credit_line,
      sales365, sales90, qty365, invoices365, last_invoice, frozen, created_sap, data, true, $2, now()
    FROM jsonb_to_recordset($1::jsonb) AS x(card_code text, name text, gstin text, pan text, slp_code int, slp_name text, group_name text, city text,
      state text, phone text, email text, balance numeric, orders_bal numeric, credit_line numeric, sales365 numeric, sales90 numeric, qty365 numeric,
      invoices365 int, last_invoice date, frozen boolean, created_sap date, data jsonb)
    ON CONFLICT (card_code) DO UPDATE SET name = EXCLUDED.name, gstin = EXCLUDED.gstin, pan = EXCLUDED.pan, slp_code = EXCLUDED.slp_code,
      slp_name = EXCLUDED.slp_name, group_name = EXCLUDED.group_name, city = EXCLUDED.city, state = EXCLUDED.state, phone = EXCLUDED.phone,
      email = EXCLUDED.email, balance = EXCLUDED.balance, orders_bal = EXCLUDED.orders_bal, credit_line = EXCLUDED.credit_line,
      sales365 = EXCLUDED.sales365, sales90 = EXCLUDED.sales90, qty365 = EXCLUDED.qty365, invoices365 = EXCLUDED.invoices365,
      last_invoice = EXCLUDED.last_invoice, frozen = EXCLUDED.frozen, created_sap = EXCLUDED.created_sap, data = EXCLUDED.data,
      in_sap = true, run_id = EXCLUDED.run_id, synced_at = now()`, [JSON.stringify(list), run]);
  return list.length;
}

async function pushRows(sql, section, rows, run) {
  const key = KEYS[section];
  const keepMap = new Map(), drop = [];
  for (const r of rows) {
    if (!r || r.CardCode == null) continue;
    const [k, c, dt] = key(r);
    if (CANCELLABLE.has(section) && r.CANCELED && r.CANCELED !== 'N') drop.push(k);     // cancelled in SAP since last run
    else if (CANCELLABLE.has(section) && r.Canceled && r.Canceled !== 'N') drop.push(k);
    else keepMap.set(k, { k, c: String(c), d: dt, r });        // same key twice in a batch: last one wins
  }
  const keep = [...keepMap.values()];
  if (drop.length) await sql.query(`DELETE FROM crm_sap WHERE section = $1 AND key = ANY($2::text[])`, [section, drop]);
  if (keep.length) await sql.query(`
    INSERT INTO crm_sap (section, key, card_code, doc_date, data, run_id, synced_at)
    SELECT $1, x->>'k', x->>'c', (x->>'d')::date, x->'r', $2, now() FROM jsonb_array_elements($3::jsonb) x
    ON CONFLICT (section, key) DO UPDATE SET card_code = EXCLUDED.card_code, doc_date = EXCLUDED.doc_date, data = EXCLUDED.data,
      run_id = EXCLUDED.run_id, synced_at = now()`, [section, run, JSON.stringify(keep)]);
  return keep.length;
}

export default route(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  if (!authorised(req)) return send(res, 401, { error: 'bad push secret (SAP_PUSH_SECRET)' });
  const b = await readBody(req);
  const sql = getSql();
  const run = String(b.run || '').slice(0, 40);
  if (!run) return send(res, 400, { error: 'run id missing' });

  if (b.section === 'error') {
    await sql`INSERT INTO crm_sync (id, at, ok, message) VALUES (1, now(), false, ${String(b.message || 'failed').slice(0, 500)})
              ON CONFLICT (id) DO UPDATE SET ok = false, message = EXCLUDED.message`;
    return send(res, 200, { ok: true });
  }

  if (b.section === 'done') {
    const counts = b.counts || {};
    // Feedback that arrived before its invoice reached the CRM: match it now.
    const fb = await sql`SELECT id, invoice_no FROM crm_feedback WHERE card_code IS NULL AND invoice_no IS NOT NULL AND created_at > now() - interval '120 days' LIMIT 300`;
    const { invoiceLookup } = await import('./_sap.js');
    let matched = 0;
    for (const f of fb) {
      const m = await invoiceLookup(f.invoice_no);
      if (!m) continue;
      await sql`UPDATE crm_feedback SET card_code = ${m.CardCode}, customer_name = ${m.CardName}, invoice_date = ${d(m.DocDate)},
                invoice_qty = ${m.Qty == null ? null : num(m.Qty)}, slp_name = ${m.SlpName || null} WHERE id = ${f.id}`;
      matched++;
    }
    // A ledger request whose GSTIN now exists in SAP is linked and marked "created".
    await sql`UPDATE crm_kyc k SET card_code = c.card_code, status = 'created', updated_at = now()
              FROM crm_customers c WHERE k.card_code IS NULL AND k.status IN ('submitted','review','approved')
                AND k.gstin IS NOT NULL AND c.gstin = k.gstin AND c.in_sap`;
    // enquiries waiting for their BP: move to "BP created" once the customer is in SAP
    let bp = null; try { bp = await bpCheck(sql); } catch (e) { bp = { error: e.message }; }
    const msg = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'ok';
    await sql`INSERT INTO crm_sync (id, at, ok, message, count, full_at) VALUES (1, now(), true, ${msg}, ${num(counts.customers) || null}, ${b.full ? new Date().toISOString() : null})
              ON CONFLICT (id) DO UPDATE SET at = now(), ok = true, message = EXCLUDED.message,
                count = COALESCE(EXCLUDED.count, crm_sync.count), full_at = COALESCE(EXCLUDED.full_at, crm_sync.full_at)`;
    return send(res, 200, { ok: true, feedbackMatched: matched, bp });
  }

  const rows = Array.isArray(b.rows) ? b.rows : [];
  if (rows.length > 5000) return send(res, 413, { error: 'send at most 5000 rows per batch' });
  let n;
  if (b.section === 'customers') {
    n = await pushCustomers(sql, rows, run);
    if (b.last && b.mode === 'replace') {
      const [{ c }] = await sql`SELECT COUNT(*)::int AS c FROM crm_customers WHERE run_id = ${run}`;
      if (c > 0) await sql`UPDATE crm_customers SET in_sap = false WHERE in_sap AND COALESCE(run_id, '') <> ${run}`;   // removed from SAP
    }
  } else if (KEYS[b.section]) {
    n = await pushRows(sql, b.section, rows, run);
    if (b.last && b.mode === 'replace') {
      const [{ c }] = await sql`SELECT COUNT(*)::int AS c FROM crm_sap WHERE section = ${b.section} AND run_id = ${run}`;
      // Never wipe a whole section because one run came back empty by mistake (orders can legitimately be 0, so allow that one).
      if (c > 0 || b.section === 'orders') await sql`DELETE FROM crm_sap WHERE section = ${b.section} AND COALESCE(run_id, '') <> ${run}`;
    }
  } else return send(res, 400, { error: 'unknown section ' + b.section });
  return send(res, 200, { ok: true, section: b.section, stored: n });
});
