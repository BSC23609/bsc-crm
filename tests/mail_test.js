// Offline test of the mailbox reader: fakes Microsoft Graph and the Claude API, runs runMailSync twice
// against the local Postgres, and checks filtering, SAP matching, data-sheet merging and de-duplication.
//   DATABASE_URL_LOCAL=postgres://postgres@localhost:5433/crm node tests/mail_test.js
import pg from 'pg';
import assert from 'node:assert/strict';
import { setSql, ensureSchema } from '../api/_lib.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_LOCAL });
const sql = (s, ...v) => pool.query(s.reduce((a, x, i) => a + '$' + i + x), v).then(r => r.rows);
sql.query = (t, p) => pool.query(t, p).then(r => r.rows);
setSql(sql);
Object.assign(process.env, { MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', ANTHROPIC_API_KEY: 'k' });
const { runMailSync } = await import('../api/_mail.js');
await ensureSchema();
await sql`DELETE FROM crm_mail`; await sql`DELETE FROM crm_mail_party`; await sql`DELETE FROM crm_mail_state`;
await sql`INSERT INTO crm_customers (card_code, name, gstin, phone, email, data) VALUES
  ('TST001', 'SRI MURUGAN FABRICATORS PVT LTD', '33AAACB1234C1ZM', '9840011111', 'purchase@murugan.co.in', '{}'),
  ('TST002', 'KAVERI ENGINEERING WORKS', NULL, '9840022222', 'kaveri.eng@gmail.com', '{}')
  ON CONFLICT (card_code) DO UPDATE SET gstin = EXCLUDED.gstin, email = EXCLUDED.email, phone = EXCLUDED.phone, in_sap = true`;

const t = m => new Date(Date.now() - m * 60000).toISOString().replace(/\.\d+Z$/, 'Z');
const msg = (n, from, name, subject, body, extra = {}) => ({ id: 'g' + n, internetMessageId: `<m${n}@x>`, receivedDateTime: t(300 - n), from: { emailAddress: { address: from, name } },
  subject, body: { contentType: 'text', content: body }, hasAttachments: false, isDraft: false, internetMessageHeaders: [], toRecipients: [{ emailAddress: { address: 'info@bharatsteels.in' } }], ...extra });
const MAILS = [
  msg(1, 'raj@newbuild.in', 'Raj Kumar', 'Enquiry - E350 plates', 'Please quote 20 MT E350 plates 12mm.\n\nRegards\nRaj Kumar, Purchase Manager\nNewBuild Structures Pvt Ltd\n+91 98765 43210\nGSTIN 33AAACB1234C1ZM'),
  msg(2, 'sales@bharatsteels.in', 'BSC', 'Re: quote', 'internal reply'),
  msg(3, 'newsletter@steelnews.com', 'Steel News', 'Weekly prices', 'prices', { internetMessageHeaders: [{ name: 'List-Unsubscribe', value: '<x>' }] }),
  msg(4, 'kaveri.eng@gmail.com', 'Kaveri', 'PO 778', 'Please find PO for 5 MT HR coil 2mm', { hasAttachments: true }),
  msg(5, 'offers@jswsteel.in', 'JSW', 'Price offer for December', 'Our December base price is ...'),
  msg(6, 'buyleads@indiamart.com', 'IndiaMART', 'Buy lead: MS angles', 'Buyer: Senthil, Senthil Traders, Madurai, 9443300000. Needs MS angle 50x50x6 10 MT', { internetMessageHeaders: [{ name: 'List-Unsubscribe', value: '<x>' }] }),
  msg(7, 'accounts@newbuild.in', 'Priya', 'Payment advice', 'We have transferred Rs 5,00,000 against inv 5755.\nPriya, Accounts, NewBuild Structures'),
  msg(8, 'x@y.com', 'Auto', 'Automatic reply: away', 'I am away'),
  msg(9, 'ravi@sriramaengg.com', 'Ravi', 'Requirement', 'Need CR sheets 1mm 3 MT.\nRavi, Sri Rama Engg Works, Hosur, 9000011111')
];
const AI = {
  'Enquiry - E350 plates': { category: 'customer_enquiry', is_customer: true, company: 'NewBuild Structures Pvt Ltd', contact_name: 'Raj Kumar', designation: 'Purchase Manager', mobiles: ['+91 98765 43210'], gstin: '33AAACB1234C1ZM', products: [{ item: 'Plate', grade: 'E350', size: '12mm', qty: '20', unit: 'MT' }], summary: 'Enquiry 20 MT E350 plates' },
  'PO 778': { category: 'customer_order', is_customer: true, company: 'Kaveri Engineering Works', products: [{ item: 'HR coil', size: '2mm', qty: '5', unit: 'MT' }], summary: 'PO for 5 MT HR coil', attachments_worth_reading: true },
  'Price offer for December': { category: 'vendor_or_supplier', is_customer: false, summary: 'Supplier price offer' },
  'Buy lead: MS angles': { category: 'customer_enquiry', is_customer: true, via_portal: 'IndiaMART', company: 'Senthil Traders', contact_name: 'Senthil', mobiles: ['9443300000'], city: 'Madurai', products: [{ item: 'MS angle', size: '50x50x6', qty: '10', unit: 'MT' }], summary: 'IndiaMART lead for MS angles' },
  'Payment advice': { category: 'customer_payment_or_accounts', is_customer: true, company: 'NewBuild Structures', contact_name: 'Priya', summary: 'Payment of Rs 5 lakh against inv 5755' },
  'Requirement': { category: 'customer_enquiry', is_customer: true, company: 'Sri Rama Engg Works', contact_name: 'Ravi', mobiles: ['9000011111'], city: 'Hosur', summary: 'Needs CR sheets 1mm 3 MT' }
};
const calls = { claude: 0, withFiles: 0, list: [] };
let failOnce = 'Requirement';
globalThis.fetch = async (url, opt = {}) => {
  url = String(url);
  const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  if (url.includes('login.microsoftonline.com')) return json({ access_token: 'tok', expires_in: 3600 });
  if (url.includes('/attachments/')) return json({ contentBytes: Buffer.from('%PDF-1.4 fake').toString('base64') });
  if (url.includes('/attachments')) return json({ value: [{ '@odata.type': '#microsoft.graph.fileAttachment', id: 'a1', name: 'PO-778.pdf', contentType: 'application/pdf', size: 20000, isInline: false }] });
  if (/messages\/g\d+\?/.test(url)) return json(MAILS.find(m => url.includes('/messages/' + m.id + '?')));
  if (url.includes('graph.microsoft.com')) {
    calls.list.push(decodeURIComponent(url));
    const ge = decodeURIComponent(url).match(/receivedDateTime ge (\S+?)&/)[1];
    const top = Number(url.match(/\$top=(\d+)/)[1]);
    return json({ value: MAILS.filter(m => m.receivedDateTime >= ge).sort((a, b) => a.receivedDateTime.localeCompare(b.receivedDateTime)).slice(0, top) });
  }
  if (url.includes('api.anthropic.com')) {
    const b = JSON.parse(opt.body); calls.claude++;
    const parts = b.messages[0].content; if (parts.some(p => p.type === 'document')) calls.withFiles++;
    const subj = parts.map(p => p.text || '').join('').match(/Subject: (.*)/)[1];
    if (subj === failOnce) { failOnce = null; return json({ error: { message: 'overloaded' } }, 400); }   // a permanent error -> error row, run continues
    const x = AI[subj] || { category: 'other', is_customer: false, summary: '?' };
    if (parts.some(p => p.type === 'document')) x.gstin = undefined, x.address = 'Plot 4, SIDCO, Coimbatore 641021', x.pincode = '641021';
    return json({ content: [{ type: 'tool_use', name: 'save_mail', input: x }], usage: { input_tokens: 1000, output_tokens: 100 } });
  }
  throw new Error('unexpected fetch ' + url);
};

const r1 = await runMailSync({ budgetMs: 60000 });
console.log('run 1', r1);
assert.equal(r1.ok, true);
const rows = await sql`SELECT id, status, reason, category, is_customer, card_code, party_id FROM crm_mail ORDER BY received_at`;
console.table(rows);
const by = Object.fromEntries(rows.map(r => [r.id, r]));
assert.equal(by['<m2@x>'].reason, 'internal / group mail');
assert.equal(by['<m3@x>'].status, 'skipped');
assert.equal(by['<m8@x>'].reason, 'auto-reply / delivery report');
assert.equal(by['<m6@x>'].is_customer, true, 'IndiaMART lead must reach Claude');
assert.equal(by['<m5@x>'].is_customer, false);
assert.equal(by['<m9@x>'].status, 'error');
assert.equal(by['<m1@x>'].card_code, 'TST001', 'GSTIN match');
assert.equal(by['<m4@x>'].card_code, 'TST002', 'email match');
assert.equal(by['<m1@x>'].party_id, by['<m7@x>'].party_id, 'same company domain -> one data sheet');
assert.equal(calls.withFiles, 1, 'PO attachment read once');
const parties = await sql`SELECT id, company, contact, mobile, email, emails, gstin, city, address, sap_status, card_code, match_basis, mails, via_portal, products FROM crm_mail_party ORDER BY id`;
console.table(parties.map(p => ({ ...p, products: JSON.stringify(p.products).slice(0, 60), emails: p.emails.join(' ') })));
const sen = parties.find(p => p.company === 'Senthil Traders');
assert.equal(sen.sap_status, 'new'); assert.equal(sen.email, null, 'portal address is not the buyer'); assert.equal(sen.mobile, '9443300000');
assert.equal(parties.find(p => p.card_code === 'TST001').mails, 2);
assert.equal(parties.find(p => p.card_code === 'TST002').address, 'Plot 4, SIDCO, Coimbatore 641021', 'details from the attachment');

const before = calls.claude;
const r2 = await runMailSync({ budgetMs: 60000 });
console.log('run 2', r2);
assert.equal(calls.claude, before + 1, 'only the failed mail is retried on the second run');
assert.equal((await sql`SELECT status FROM crm_mail WHERE id = '<m9@x>'`)[0].status, 'done');
assert.equal((await sql`SELECT sap_status FROM crm_mail_party WHERE company = 'Sri Rama Engg Works'`)[0].sap_status, 'new');
console.log('Graph list call:', calls.list[0]);
console.log('ALL MAIL TESTS PASSED');
await pool.end();
