// SAP Business One data, as pushed by the scheduled task on the SAP server (sap-sync/refresh_crm.ps1, every 15 min).
// The CRM never connects to SAP: it only reads what the task posted to /api/sap-push into these Neon tables.
//   crm_customers           customer master + 365-day roll-ups (one row per customer)
//   crm_sap(section, key)   addresses | contacts | orders | invoices | payments | monthly  (SAP column names kept in `data`)
import { getSql } from './_lib.js';

const n = v => Number(v) || 0;
export const STALE_MINUTES = 45;   // 3 missed runs

/** Last push from the SAP task: {at, ok, message, count, connected, stale}. */
export async function sapStatus() {
  const [s] = await getSql()`SELECT at, ok, message, count, full_at FROM crm_sync WHERE id = 1`;
  if (!s || !s.at) return { connected: false, at: null, ok: null };
  const age = (Date.now() - new Date(s.at).getTime()) / 60000;
  return { ...s, connected: true, stale: age > STALE_MINUTES };
}

const rows = (section, code, extra = '') => getSql().query(
  `SELECT data FROM crm_sap WHERE section = $1 AND card_code = $2 ${extra}`, [section, code]).then(r => r.map(x => x.data));

function agingBuckets(open) {
  const b = { notDue: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0, total: 0 };
  for (const r of open) {
    const a = n(r.OpenAmt), d = n(r.DaysOverdue);
    b.total += a;
    if (d <= 0) b.notDue += a; else if (d <= 30) b.d1_30 += a; else if (d <= 60) b.d31_60 += a; else if (d <= 90) b.d61_90 += a; else b.d90plus += a;
  }
  return b;
}

/** Everything the customer page shows from SAP, in the same shape for every customer. */
export async function customer360(code, { invoices = 25, payments = 15 } = {}) {
  const sql = getSql();
  const [c] = await sql`SELECT data FROM crm_customers WHERE card_code = ${code}`;
  if (!c) return null;
  const [addresses, contacts, orders, monthly, inv, pay, open] = await Promise.all([
    rows('addresses', code, 'ORDER BY data->>\'Type\', key'),
    rows('contacts', code, 'ORDER BY key'),
    rows('orders', code, 'ORDER BY doc_date DESC'),
    rows('monthly', code, 'ORDER BY data->>\'M\''),
    rows('invoices', code, `ORDER BY doc_date DESC, (data->>'DocEntry')::int DESC LIMIT ${Math.min(500, invoices)}`),
    rows('payments', code, `ORDER BY doc_date DESC LIMIT ${Math.min(500, payments)}`),
    sql`SELECT data, (CURRENT_DATE - (data->>'DocDueDate')::date) AS days FROM crm_sap
        WHERE section = 'invoices' AND card_code = ${code} AND data->>'DocStatus' = 'O' ORDER BY data->>'DocDueDate'`
  ]);
  const openRows = open.map(({ data: i, days }) => ({ DocNum: i.InvoiceNo || i.DocNum, DocDate: i.DocDate, DocDueDate: i.DocDueDate, DocTotal: i.DocTotal,
    PaidToDate: i.PaidToDate, OpenAmt: n(i.DocTotal) - n(i.PaidToDate), DaysOverdue: Number(days) })).filter(r => r.OpenAmt > 0.5);
  return { master: c.data, addresses, contacts, orders, monthly, invoices: inv, payments: pay, aging: { buckets: agingBuckets(openRows), open: openRows } };
}

export async function moreRows(code, kind, limit) {
  return rows(kind === 'payments' ? 'payments' : 'invoices', code, `ORDER BY doc_date DESC LIMIT ${Math.min(1000, Math.max(1, limit || 200))}`);
}

/** Company-wide numbers for the dashboard (same shape the old live API used). */
export async function summary() {
  const sql = getSql();
  const st = await sapStatus();
  if (!st.connected) return null;
  const monthly = await sql`SELECT data->>'M' AS "M", SUM((data->>'Sales')::numeric)::float AS "Sales",
      COUNT(*) FILTER (WHERE (data->>'Sales')::numeric > 0)::int AS "Customers"
    FROM crm_sap WHERE section = 'monthly' GROUP BY 1 ORDER BY 1`;
  const now = new Date(Date.now() + 330 * 60000);                 // IST
  const ym = d => d.toISOString().slice(0, 7);
  const cur = ym(now), prev = ym(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
  const fy = `${now.getUTCMonth() < 3 ? now.getUTCFullYear() - 1 : now.getUTCFullYear()}-04`;
  const by = Object.fromEntries(monthly.map(m => [m.M, m.Sales]));
  const [{ active }] = await sql`SELECT COUNT(*)::int AS active FROM crm_customers WHERE in_sap AND last_invoice >= CURRENT_DATE - 90`;
  const [aging] = await sql`SELECT
      COALESCE(SUM(o) FILTER (WHERE d <= 0), 0)::float AS "NotDue",            COALESCE(SUM(o) FILTER (WHERE d BETWEEN 1 AND 30), 0)::float AS "D1_30",
      COALESCE(SUM(o) FILTER (WHERE d BETWEEN 31 AND 60), 0)::float AS "D31_60", COALESCE(SUM(o) FILTER (WHERE d BETWEEN 61 AND 90), 0)::float AS "D61_90",
      COALESCE(SUM(o) FILTER (WHERE d > 90), 0)::float AS "D90Plus"
    FROM (SELECT (data->>'DocTotal')::numeric - (data->>'PaidToDate')::numeric AS o, CURRENT_DATE - (data->>'DocDueDate')::date AS d
          FROM crm_sap WHERE section = 'invoices' AND data->>'DocStatus' = 'O') x WHERE o > 0.5`;
  return {
    sales: { SalesMTD: by[cur] || 0, SalesLastMonth: by[prev] || 0, SalesFYTD: monthly.filter(m => m.M >= fy).reduce((a, m) => a + m.Sales, 0), Active90: active },
    aging, monthly, at: st.at
  };
}

/** Invoice the customer typed on the feedback form: "24005", "BSC/25-26/24005" ... (newest first). */
export async function invoiceLookup(raw) {
  raw = String(raw || '').trim();
  const digits = (raw.match(/(\d+)\D*$/) || [])[1];
  if (!digits || digits.length > 10) return null;
  const found = await getSql()`SELECT data FROM crm_sap WHERE section = 'invoices' AND data->>'DocNum' = ${String(Number(digits))} ORDER BY doc_date DESC LIMIT 10`;
  if (!found.length) return null;
  const norm = s => String(s || '').replace(/[^0-9A-Z]/gi, '').toUpperCase();
  return (found.find(r => norm(r.data.InvoiceNo) === norm(raw)) || found[0]).data;
}
