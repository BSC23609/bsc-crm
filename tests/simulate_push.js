// Plays the scheduled task (sap-sync/refresh_crm.ps1) against a local CRM using invented demo data:
// same sections, modes, batch size and JSON shape the PowerShell script sends.
//   node tests/simulate_push.js http://localhost:3000 <SAP_PUSH_SECRET> [--incremental]
import { mock } from './sap_mock.js';
const [base, secret] = process.argv.slice(2);
const full = !process.argv.includes('--incremental');
const run = new Date().toISOString().replace(/\D/g, '').slice(0, 14) + '-' + Math.floor(Math.random() * 99999);
const iso = v => (v instanceof Date ? new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10) : v);
const clean = r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, iso(v)]));
async function post(body) {
  const r = await fetch(base + '/api/sap-push', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + secret }, body: JSON.stringify(body) });
  const d = await r.json(); if (!r.ok) throw new Error(body.section + ': ' + JSON.stringify(d)); return d;
}
async function section(name, rows, mode) {
  rows = rows.map(clean);
  if (!rows.length) { await post({ run, section: name, mode, rows: [], last: true }); return 0; }
  for (let i = 0; i < rows.length; i += 1000) await post({ run, section: name, mode, rows: rows.slice(i, i + 1000), last: i + 1000 >= rows.length });
  return rows.length;
}
const customers = mock('customers');
const per = (q, p = {}) => customers.flatMap(c => mock(q, { code: c.CardCode, limit: 1000, ...p }).map(r => ({ CardCode: c.CardCode, ...r })));
const counts = {};
counts.customers = await section('customers', customers, 'replace');
counts.orders = await section('orders', per('orders'), 'replace');
counts.invoices = await section('invoices', per('invoices').map(r => ({ ...r, CardName: customers.find(c => c.CardCode === r.CardCode).CardName, CANCELED: 'N', Items: 'HR COIL 2.00 X 1250 E250' })), full ? 'replace' : 'upsert');
counts.payments = await section('payments', per('payments').map(r => ({ ...r, Canceled: 'N' })), full ? 'replace' : 'upsert');
counts.monthly = await section('monthly', per('monthly'), full ? 'replace' : 'upsert');
counts.addresses = await section('addresses', per('addresses'), full ? 'replace' : 'upsert');
counts.contacts = await section('contacts', per('contacts').map((r, i) => ({ ...r, CntctCode: i + 1 })), full ? 'replace' : 'upsert');
console.log(counts, await post({ run, section: 'done', full, counts }));
