// Mailbox reader for info@bharatsteels.in.
//   Microsoft Graph (app-only, Mail.Read)  ->  quick local filter  ->  Claude reads body + signature (+ PDF/image attachments)
//   ->  checked against the SAP customers already in the CRM  ->  one "customer data sheet" per company (crm_mail_party).
// Runs from /api/cron?job=mail (GitHub Actions every 15 min) or the "Check mail now" button.
import { getSql, gstinProblem, phoneDigits, clean } from './_lib.js';

const env = (...names) => { for (const n of names) if (process.env[n]) return process.env[n].trim(); return ''; };
const G = () => ({
  tenant: env('MS_TENANT_ID', 'AZURE_TENANT_ID', 'GRAPH_TENANT_ID', 'TENANT_ID'),
  client: env('MS_CLIENT_ID', 'AZURE_CLIENT_ID', 'GRAPH_CLIENT_ID', 'CLIENT_ID'),
  secret: env('MS_CLIENT_SECRET', 'AZURE_CLIENT_SECRET', 'GRAPH_CLIENT_SECRET', 'CLIENT_SECRET'),
  mailbox: env('MAIL_MAILBOX') || 'info@bharatsteels.in'
});
const AI_KEY = () => env('ANTHROPIC_API_KEY', 'CLAUDE_API_KEY');
const AI_MODEL = () => env('MAIL_AI_MODEL') || 'claude-haiku-5-5';
const BACKFILL_DAYS = () => Math.max(0, Number(env('MAIL_BACKFILL_DAYS')) || 90);
export const mailReady = () => { const g = G(); return { graph: !!(g.tenant && g.client && g.secret), ai: !!AI_KEY(), mailbox: g.mailbox, model: AI_MODEL() }; };

const OWN_DOMAINS = ['bharatsteels.in', 'metfraa.com', 'crayonroofings.com', 'thebharatsteelgroup.com', 'vestrics.com', 'g2steel.in',
  ...env('MAIL_IGNORE_DOMAINS').toLowerCase().split(/[,\s]+/).filter(Boolean)];
const OWN_PHONES = ['4467917800', '9444085016', '9500680093', '9884042222', '7401233000'];
export const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.in', 'ymail.com', 'rediffmail.com', 'rediff.com', 'hotmail.com',
  'outlook.com', 'outlook.in', 'live.com', 'live.in', 'msn.com', 'icloud.com', 'me.com', 'aol.com', 'protonmail.com', 'proton.me', 'zoho.com', 'zohomail.in', 'mail.com', 'gmx.com']);
const PORTALS = ['indiamart.com', 'tradeindia.com', 'justdial.com', 'exportersindia.com', 'sulekha.com', 'steelmint.com', 'bigmint.co', 'indiamart.in'];
const domainOf = e => String(e || '').toLowerCase().split('@')[1] || '';
const isOwn = d => OWN_DOMAINS.some(o => d === o || d.endsWith('.' + o));
const isPortal = d => PORTALS.some(o => d === o || d.endsWith('.' + o));

/* ---------------- Microsoft Graph ---------------- */
let tok = null;
async function token() {
  if (tok && tok.exp > Date.now() + 60000) return tok.value;
  const g = G();
  const r = await fetch(`https://login.microsoftonline.com/${g.tenant}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: g.client, client_secret: g.secret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Microsoft sign-in failed: ' + (d.error_description || d.error || r.status).toString().split('\r')[0]);
  tok = { value: d.access_token, exp: Date.now() + (d.expires_in || 3000) * 1000 };
  return tok.value;
}
async function graph(path, extraHeaders = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch('https://graph.microsoft.com/v1.0' + path, { headers: { Authorization: 'Bearer ' + await token(), ...extraHeaders }, signal: AbortSignal.timeout(30000) });
    if ((r.status === 429 || r.status >= 500) && attempt < 2) { await sleep(Math.min(20, Number(r.headers.get('retry-after')) || 5) * 1000); continue; }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Mailbox read failed (${r.status}): ${d.error?.message || ''}`);
    return d;
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SELECT = 'id,internetMessageId,receivedDateTime,from,sender,toRecipients,ccRecipients,subject,body,hasAttachments,isDraft,internetMessageHeaders';

/* ---------------- quick filter (no AI) ---------------- */
const BOT_LOCAL = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?|alerts?|newsletter|news|updates|marketing|promotions?|digest|support-noreply|system|automated|auto-?confirm)([._+-].*)?$/i;
const AUTO_SUBJ = /^(automatic reply|auto(matic)?[- ]?reply|out of (the )?office|undeliverable|delivery (status|has failed)|mail delivery|returned mail|read:|not read:|accepted:|declined:|tentative:)/i;
function prefilter(m) {
  const from = (m.from?.emailAddress?.address || m.sender?.emailAddress?.address || '').toLowerCase();
  const d = domainOf(from), local = from.split('@')[0];
  if (m.isDraft) return 'draft';
  if (!from) return 'no sender';
  if (isOwn(d)) return 'internal / group mail';
  if (isPortal(d)) return null;                                     // IndiaMART etc. buy-leads go to Claude even though they look automated
  if (AUTO_SUBJ.test(m.subject || '')) return 'auto-reply / delivery report';
  if (BOT_LOCAL.test(local)) return 'automated sender';
  const h = Object.fromEntries((m.internetMessageHeaders || []).map(x => [String(x.name).toLowerCase(), String(x.value)]));
  if (h['list-unsubscribe'] || /bulk|list|junk/i.test(h.precedence || '')) return 'newsletter / bulk mail';
  if (/^auto-(generated|replied)/i.test(h['auto-submitted'] || '')) return 'auto-generated';
  return null;
}
const htmlToText = h => String(h || '').replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"');
const tidy = t => String(t || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();

/* ---------------- Claude ---------------- */
const CATEGORIES = ['customer_enquiry', 'customer_order', 'customer_payment_or_accounts', 'customer_complaint_or_quality', 'customer_documents_or_kyc', 'customer_other',
  'vendor_or_supplier', 'transporter_or_logistics', 'bank_or_finance', 'government_or_tax', 'job_application', 'marketing_or_spam', 'other'];
const S = { type: 'string' }, SA = { type: 'array', items: { type: 'string' } };
const TOOL = {
  name: 'save_mail',
  description: 'Save what this email is and the customer details found in it.',
  input_schema: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: CATEGORIES },
      is_customer: { type: 'boolean', description: 'true only if the sender (or the buyer in a lead-portal mail) buys or wants to buy from us' },
      confidence: { type: 'number', description: '0 to 1' },
      via_portal: { type: 'string', description: 'IndiaMART / TradeIndia / JustDial etc. if this is a lead-portal mail, else empty' },
      company: S, contact_name: S, designation: S,
      emails: SA, mobiles: SA, landlines: SA, website: S,
      gstin: { type: 'string', description: '15-character GSTIN exactly as written, only if present' }, pan: S,
      address: S, city: S, state: S, pincode: S,
      segment: { type: 'string', description: 'their business/industry if clear, e.g. Fabricator, OEM, Contractor, Trader, Auto ancillary, PEB, Boilers' },
      products: { type: 'array', items: { type: 'object', properties: { item: S, grade: S, size: S, qty: S, unit: S } } },
      summary: { type: 'string', description: 'one plain-English line: what they want / what this mail is' },
      action_needed: { type: 'string', description: 'what our sales team should do next, short; empty if nothing' },
      attachments_worth_reading: { type: 'boolean', description: 'true if the attachments probably hold customer details or requirements (GST certificate, PO, enquiry list, drawing, visiting card, letterhead)' },
      documents_seen: { ...SA, description: 'kinds of documents in the attachments, e.g. GST certificate, Purchase order, Enquiry list' }
    },
    required: ['category', 'is_customer', 'summary']
  }
};
const SYSTEM = `You read emails that arrive at info@bharatsteels.in, the shared mailbox of Bharat Steel (Chennai) Pvt. Ltd. (BSC), a steel stockist and processor in Chennai and Salem (HR/CR coils and sheets, plates, structural sections, slitting and cut-to-length). Group companies: Metfraa Steel Buildings (pre-engineered buildings), Crayon Roofings & Structures (roofing), G2 Steel Services.

Decide what each email is and extract the customer's details for our CRM. Always answer by calling save_mail.

Who is a customer: a business or person that buys or may buy from us — enquiries/RFQs, quotations they asked for, purchase orders, order or dispatch follow-ups, payment or remittance advice from a buyer, account statements from a buyer, complaints, KYC / GST documents for opening their account. NOT customers: steel producers and suppliers sending us offers or invoices, transporters, service providers, software or marketing vendors, banks, government/GST notices, job seekers, newsletters, internal mail.

Lead-portal emails (IndiaMART, TradeIndia, JustDial ...): the BUYER described in the email is the customer. Set via_portal and take the buyer's name, company, phone, city and requirement from the email body — never the portal's own details.

Rules:
- Take details from the sender's own latest message and email signature first; earlier quoted messages may help, but never extract OUR details: domains bharatsteels.in, metfraa.com, crayonroofings.com; phones 044 6791 7800, 94440 85016, 95006 80093; our Ponneri / Thirunilai / Coimbatore addresses; our GSTIN.
- Use only what is written. Leave a field empty rather than guess. Copy GSTIN, PAN, phone numbers and emails exactly.
- products: each item they ask about or order, with grade, size/thickness and quantity as written (e.g. item "HR Plate", grade "E250", size "10mm x 2500 x 6300", qty "15", unit "MT").
- summary: one short line, e.g. "Enquiry for 20 MT E350 plates 12mm for a PEB project, Hosur".`;

async function claude(content) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(90000),
      headers: { 'x-api-key': AI_KEY(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: AI_MODEL(), max_tokens: 2000, system: SYSTEM, tools: [TOOL], tool_choice: { type: 'tool', name: 'save_mail' }, messages: [{ role: 'user', content }] })
    });
    const d = await r.json().catch(() => ({}));
    if ((r.status === 429 || r.status === 529 || r.status >= 500) && attempt < 2) { await sleep(Math.min(30, Number(r.headers.get('retry-after')) || 8) * 1000); continue; }
    if (!r.ok) { const e = new Error(`Claude API ${r.status}: ${d.error?.message || ''}`); e.transient = r.status === 429 || r.status >= 500 || r.status === 401; throw e; }
    const use = (d.content || []).find(c => c.type === 'tool_use');
    if (!use) throw new Error('Claude did not return the details');
    return { x: use.input || {}, tokens: (d.usage?.input_tokens || 0) + (d.usage?.output_tokens || 0) };
  }
}
const ATT_TYPES = { 'application/pdf': 'document', 'image/jpeg': 'image', 'image/jpg': 'image', 'image/png': 'image', 'image/webp': 'image', 'image/gif': 'image' };
const extType = n => ({ pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' })[String(n).split('.').pop().toLowerCase()];

/* ---------------- SAP matching ---------------- */
const STOP = new Set(['m', 's', 'ms', 'the', 'pvt', 'private', 'ltd', 'limited', 'llp', 'co', 'company', 'and', 'india', 'inc', 'corp', 'corporation', 'opc']);
export const normName = s => String(s || '').toLowerCase().replace(/m\/s\.?/g, ' ').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w && !STOP.has(w)).join(' ');
const p10 = v => { const d = phoneDigits(v); return d.length >= 10 ? d.slice(-10) : ''; };
const splitEmails = v => String(v || '').toLowerCase().split(/[;,\s]+/).filter(e => e.includes('@'));
export async function loadMatcher(sql) {
  const cust = await sql`SELECT card_code, name, gstin, phone, email, data FROM crm_customers WHERE in_sap`;
  const extra = await sql`SELECT section, card_code, data FROM crm_sap WHERE section IN ('contacts', 'addresses') AND card_code IS NOT NULL`;
  const M = { gst: new Map(), email: new Map(), domain: new Map(), phone: new Map(), name: new Map(), names: [], byCode: new Map() };
  const addSet = (map, k, code) => { if (!k) return; if (!map.has(k)) map.set(k, new Set()); map.get(k).add(code); };
  const addEmail = (e, code) => { for (const x of splitEmails(e)) { if (!M.email.has(x)) M.email.set(x, code); const d = domainOf(x); if (d && !FREE_MAIL.has(d) && !isOwn(d)) addSet(M.domain, d, code); } };
  for (const c of cust) {
    M.byCode.set(c.card_code, c.name);
    if (c.gstin) M.gst.set(c.gstin.toUpperCase(), c.card_code);
    addEmail(c.email, c.card_code); addEmail(c.data?.E_Mail, c.card_code);
    for (const p of [c.phone, c.data?.Phone1, c.data?.Phone2, c.data?.Cellular]) { const k = p10(p); if (k && !OWN_PHONES.includes(k)) addSet(M.phone, k, c.card_code); }
    const n = normName(c.name); if (n) { addSet(M.name, n, c.card_code); M.names.push([n, c.card_code]); }
  }
  for (const r of extra) {
    if (r.section === 'addresses' && r.data?.GSTIN) { const g = String(r.data.GSTIN).toUpperCase().trim(); if (g && !M.gst.has(g)) M.gst.set(g, r.card_code); }
    if (r.section === 'contacts') { addEmail(r.data?.Email, r.card_code); for (const p of [r.data?.Mobile, r.data?.Tel1]) { const k = p10(p); if (k && !OWN_PHONES.includes(k)) addSet(M.phone, k, r.card_code); } }
  }
  return M;
}
const one = set => (set && set.size === 1 ? [...set][0] : null);
const jaccard = (a, b) => { const A = new Set(a.split(' ')), B = new Set(b.split(' ')); let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i); };
// x: {gstin, emails[], phones[], company, domain}
export function matchSap(M, x) {
  if (x.gstin && M.gst.has(x.gstin)) return { status: 'existing', code: M.gst.get(x.gstin), basis: 'GSTIN' };
  for (const e of x.emails || []) if (M.email.has(e)) return { status: 'existing', code: M.email.get(e), basis: 'email address' };
  for (const p of x.phones || []) { const c = one(M.phone.get(p)); if (c) return { status: 'existing', code: c, basis: 'phone number' }; }
  if (x.domain) { const s = M.domain.get(x.domain); if (s && s.size === 1) return { status: 'existing', code: [...s][0], basis: 'email domain' }; if (s) return { status: 'possible', suggest: [...s][0], basis: 'same email domain as ' + s.size + ' SAP customers' }; }
  const n = normName(x.company);
  if (n) {
    const c = one(M.name.get(n)); if (c) return { status: 'existing', code: c, basis: 'company name' };
    let best = null; if (n.split(' ').length >= 1) for (const [nn, code] of M.names) { const j = jaccard(n, nn); if (j >= 0.6 && (!best || j > best.j)) best = { j, code }; }
    if (best) return { status: 'possible', suggest: best.code, basis: `similar name (${Math.round(best.j * 100)}%)` };
  }
  for (const p of x.phones || []) { const s = M.phone.get(p); if (s && s.size > 1) return { status: 'possible', suggest: [...s][0], basis: 'phone shared by several SAP customers' }; }
  return { status: 'new' };
}

/* ---------------- data sheet (one row per company) ---------------- */
const FIELDS = ['company', 'contact', 'designation', 'mobile', 'phone', 'email', 'website', 'gstin', 'pan', 'address', 'city', 'state', 'pincode', 'segment'];
function sheetFrom(x, fromEmail, fromName) {
  const emails = [...new Set([fromEmail, ...(x.emails || []).map(e => String(e).toLowerCase().trim())].filter(e => e && e.includes('@') && !isOwn(domainOf(e))))];
  const portal = !!clean(x.via_portal, 40);
  if (portal) emails.splice(emails.indexOf(fromEmail), 1);           // the portal's address is not the buyer's
  const mobiles = (x.mobiles || []).map(p10).filter(p => p && !OWN_PHONES.includes(p));
  const lands = (x.landlines || []).map(v => phoneDigits(v)).filter(p => p.length >= 8 && !OWN_PHONES.includes(p.slice(-10)));
  let gstin = String(x.gstin || '').toUpperCase().replace(/\s/g, ''); if (gstin && gstinProblem(gstin)) gstin = '';
  const dom = emails.map(domainOf).find(d => d && !FREE_MAIL.has(d) && !isPortal(d)) || '';
  return {
    company: clean(x.company, 200), contact: clean(x.contact_name, 120) || (portal ? '' : clean(fromName, 120)), designation: clean(x.designation, 100),
    mobile: mobiles[0] || '', phone: lands[0] || mobiles[1] || '', email: emails[0] || '', emails, website: clean(x.website, 160).toLowerCase(), domain: dom,
    gstin, pan: (String(x.pan || '').toUpperCase().match(/[A-Z]{5}[0-9]{4}[A-Z]/) || [gstin ? gstin.slice(2, 12) : ''])[0],
    address: clean(x.address, 400), city: clean(x.city, 80), state: clean(x.state, 60), pincode: (String(x.pincode || '').match(/[1-9][0-9]{5}/) || [''])[0],
    segment: clean(x.segment, 80), via_portal: clean(x.via_portal, 40),
    products: (x.products || []).slice(0, 20).map(p => ({ item: clean(p.item, 80), grade: clean(p.grade, 40), size: clean(p.size, 80), qty: clean(p.qty, 20), unit: clean(p.unit, 12) })).filter(p => p.item),
    phones: [...mobiles, ...lands.map(l => l.slice(-10))]
  };
}
async function upsertParty(sql, M, sh, mail, x) {
  // the same company may already have a sheet: same GSTIN, same company domain, or one of the same email addresses
  let [p] = sh.gstin ? await sql`SELECT * FROM crm_mail_party WHERE gstin = ${sh.gstin} LIMIT 1` : [];
  if (!p && sh.domain) [p] = await sql`SELECT * FROM crm_mail_party WHERE domain = ${sh.domain} ORDER BY id LIMIT 1`;
  if (!p && sh.emails.length) [p] = await sql`SELECT * FROM crm_mail_party WHERE emails && ${sh.emails}::text[] ORDER BY id LIMIT 1`;
  if (!p && sh.mobile) [p] = await sql`SELECT * FROM crm_mail_party WHERE mobile = ${sh.mobile} ORDER BY id LIMIT 1`;
  const at = mail.received_at;
  if (!p) {
    const m = matchSap(M, sh);
    const [{ id }] = await sql`INSERT INTO crm_mail_party (company, contact, designation, mobile, phone, email, emails, website, domain, gstin, pan, address, city, state, pincode, segment,
        products, last_summary, last_category, sap_status, card_code, match_basis, suggest_code, via_portal, mails, first_at, last_at)
      VALUES (${sh.company || null}, ${sh.contact || null}, ${sh.designation || null}, ${sh.mobile || null}, ${sh.phone || null}, ${sh.email || null}, ${sh.emails}, ${sh.website || null},
        ${sh.domain || null}, ${sh.gstin || null}, ${sh.pan || null}, ${sh.address || null}, ${sh.city || null}, ${sh.state || null}, ${sh.pincode || null}, ${sh.segment || null},
        ${JSON.stringify(sh.products)}::jsonb, ${clean(x.summary, 300)}, ${x.category}, ${m.status}, ${m.code || null}, ${m.basis || null}, ${m.suggest || null}, ${sh.via_portal || null}, 1, ${at}, ${at})
      RETURNING id`;
    return { id, card: m.code || null };
  }
  // fill only the blanks, never overwrite what staff edited; newest summary wins
  const v = {}; for (const f of FIELDS) v[f] = p[f] || (p.edited_fields.includes(f) ? p[f] : sh[f]) || null;
  const emails = [...new Set([...(p.emails || []), ...sh.emails])].slice(0, 20);
  const seen = new Set((p.products || []).map(q => (q.item + '|' + q.size).toLowerCase()));
  const products = [...sh.products.filter(q => !seen.has((q.item + '|' + q.size).toLowerCase())), ...(p.products || [])].slice(0, 40);
  let { sap_status: st, card_code: card, match_basis: basis, suggest_code: sug } = p;
  if (st !== 'ignored' && basis !== 'set by staff') {
    const m = matchSap(M, { gstin: v.gstin, emails, phones: [v.mobile, v.phone, ...sh.phones].map(p10).filter(Boolean), company: v.company, domain: p.domain || sh.domain });
    st = m.status; card = m.code || null; basis = m.basis || null; sug = m.suggest || null;
  }
  const newer = !p.last_at || new Date(at) >= new Date(p.last_at);
  await sql`UPDATE crm_mail_party SET company = ${v.company}, contact = ${v.contact}, designation = ${v.designation}, mobile = ${v.mobile}, phone = ${v.phone}, email = ${v.email},
      emails = ${emails}, website = ${v.website}, domain = COALESCE(domain, ${sh.domain || null}), gstin = ${v.gstin}, pan = ${v.pan}, address = ${v.address}, city = ${v.city}, state = ${v.state},
      pincode = ${v.pincode}, segment = ${v.segment}, products = ${JSON.stringify(products)}::jsonb,
      last_summary = CASE WHEN ${newer} THEN ${clean(x.summary, 300)} ELSE last_summary END, last_category = CASE WHEN ${newer} THEN ${x.category} ELSE last_category END,
      sap_status = ${st}, card_code = ${card}, match_basis = ${basis}, suggest_code = ${sug}, via_portal = COALESCE(via_portal, ${sh.via_portal || null}),
      mails = mails + 1, first_at = LEAST(first_at, ${at}), last_at = GREATEST(last_at, ${at}), updated_at = now() WHERE id = ${p.id}`;
  return { id: p.id, card };
}

/* ---------------- one email ---------------- */
async function handle(sql, M, m, stats) {
  const id = m.internetMessageId || m.id;
  const [seen] = await sql`SELECT status FROM crm_mail WHERE id = ${id}`;
  if (seen && seen.status !== 'error') return;
  const from = (m.from?.emailAddress?.address || m.sender?.emailAddress?.address || '').toLowerCase(), fromName = m.from?.emailAddress?.name || '';
  const bodyText = tidy(m.body?.contentType === 'html' ? htmlToText(m.body?.content) : m.body?.content);
  const base = { id, graph: m.id, at: m.receivedDateTime, from, fromName, subject: clean(m.subject, 300), snippet: clean(bodyText, 400), att: !!m.hasAttachments };
  const save = (status, reason, extra = {}) => sql`INSERT INTO crm_mail (id, graph_id, received_at, from_email, from_name, subject, snippet, has_attachments, attachments, status, reason,
      category, is_customer, extracted, party_id, card_code, tokens)
    VALUES (${base.id}, ${base.graph}, ${base.at}, ${from}, ${clean(fromName, 160)}, ${base.subject}, ${base.snippet}, ${base.att}, ${JSON.stringify(extra.atts || [])}::jsonb, ${status}, ${reason || null},
      ${extra.category || null}, ${!!extra.customer}, ${extra.x ? JSON.stringify(extra.x) : null}::jsonb, ${extra.party || null}, ${extra.card || null}, ${extra.tokens || 0})
    ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, reason = EXCLUDED.reason, category = EXCLUDED.category, is_customer = EXCLUDED.is_customer, extracted = EXCLUDED.extracted,
      party_id = EXCLUDED.party_id, card_code = EXCLUDED.card_code, tokens = crm_mail.tokens + EXCLUDED.tokens, attachments = EXCLUDED.attachments, snippet = EXCLUDED.snippet
    WHERE crm_mail.status = 'error'`;
  const skip = prefilter(m);
  if (skip) { stats.skipped++; return save('skipped', skip); }

  // attachment names first (cheap) so Claude knows what is attached
  let atts = [];
  if (m.hasAttachments) {
    try {
      const a = await graph(`/users/${encodeURIComponent(G().mailbox)}/messages/${encodeURIComponent(m.id)}/attachments?$select=id,name,contentType,size,isInline`);
      atts = (a.value || []).filter(x => !x.isInline && x['@odata.type'] === '#microsoft.graph.fileAttachment').map(x => ({ id: x.id, name: x.name, type: (x.contentType || '').toLowerCase(), size: x.size }));
    } catch { /* names are optional */ }
  }
  const head = `From: ${fromName} <${from}>\nTo: ${(m.toRecipients || []).map(r => r.emailAddress?.address).join(', ')}\nDate: ${m.receivedDateTime}\nSubject: ${m.subject || ''}\n`
    + (atts.length ? `Attachments: ${atts.map(a => a.name).join(', ')}\n` : '') + '\n';
  let { x, tokens } = await claude([{ type: 'text', text: head + bodyText.slice(0, 14000) }]);

  // second look with the PDFs / images when the mail is from a customer and the files are likely useful
  const readable = atts.map(a => ({ ...a, type: ATT_TYPES[a.type] ? a.type : extType(a.name) })).filter(a => ATT_TYPES[a.type] && a.size <= 4.5e6).slice(0, 3);
  if (x.is_customer && readable.length && x.attachments_worth_reading !== false) {
    const blocks = [];
    for (const a of readable) {
      try { const f = await graph(`/users/${encodeURIComponent(G().mailbox)}/messages/${encodeURIComponent(m.id)}/attachments/${encodeURIComponent(a.id)}`);
        if (f.contentBytes) blocks.push({ type: ATT_TYPES[a.type], source: { type: 'base64', media_type: a.type === 'image/jpg' ? 'image/jpeg' : a.type, data: f.contentBytes } }); a.read = true;
      } catch { /* skip that file */ }
    }
    if (blocks.length) {
      try {
        const r2 = await claude([...blocks, { type: 'text', text: head + bodyText.slice(0, 8000) + '\n\n---\nThe attached files are included above. Read them too (GST certificate, PO, enquiry list, visiting card, letterhead) and give the complete details.' }]);
        x = { ...x, ...Object.fromEntries(Object.entries(r2.x).filter(([, v]) => v !== '' && v != null && !(Array.isArray(v) && !v.length))) }; tokens += r2.tokens;
      } catch (e) { if (e.transient) throw e; }
    }
  }
  const category = CATEGORIES.includes(x.category) ? x.category : 'other';
  x.category = category;
  const attList = atts.map(a => ({ name: a.name, size: a.size, read: !!readable.find(r => r.id === a.id && r.read) }));
  stats.read++; stats.tokens += tokens;
  if (!x.is_customer) return save('done', null, { category, x: { summary: x.summary, category, confidence: x.confidence }, tokens, atts: attList });
  const sh = sheetFrom(x, from, fromName);
  const { id: party, card } = await upsertParty(sql, M, sh, { received_at: base.at }, x);
  stats.customers++;
  return save('done', null, { category, customer: true, x: { ...x, documents_seen: x.documents_seen || [] }, party, card, tokens, atts: attList });
}

/* ---------------- run ---------------- */
export async function runMailSync({ budgetMs = 240000, who = 'cron' } = {}) {
  const t0 = Date.now(), sql = getSql(), r = mailReady();
  if (!r.graph) return { ok: false, error: 'Mailbox not connected — add MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET in Vercel' };
  if (!r.ai) return { ok: false, error: 'Claude not connected — add ANTHROPIC_API_KEY in Vercel' };
  // one run at a time
  const [lock] = await sql`INSERT INTO crm_mail_state (key, value, at) VALUES ('lock', ${who}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, at = now() WHERE crm_mail_state.at < now() - interval '6 minutes' RETURNING key`;
  if (!lock) return { ok: false, busy: true, error: 'Another mail check is already running' };
  const stats = { listed: 0, skipped: 0, read: 0, customers: 0, errors: 0, tokens: 0, more: false };
  try {
    const [c] = await sql`SELECT value FROM crm_mail_state WHERE key = 'cursor'`;
    let cursor = c?.value || new Date(Date.now() - BACKFILL_DAYS() * 864e5).toISOString();
    const M = await loadMatcher(sql);
    const mb = encodeURIComponent(G().mailbox);
    // retry mails that failed earlier (up to 3 tries each)
    for (const e of await sql`SELECT id, graph_id FROM crm_mail WHERE status = 'error' AND tries < 3 AND graph_id IS NOT NULL ORDER BY received_at LIMIT 8`) {
      try { await handle(sql, M, await graph(`/users/${mb}/messages/${encodeURIComponent(e.graph_id)}?$select=${SELECT}`, { Prefer: 'outlook.body-content-type="text"' }), stats); stats.retried = (stats.retried || 0) + 1; }
      catch (err) { await sql`UPDATE crm_mail SET tries = tries + 1, reason = ${clean(err.message, 300)} WHERE id = ${e.id}`; if (err.transient) throw err; }
    }
    outer: while (Date.now() - t0 < budgetMs) {
      const q = `$filter=${encodeURIComponent(`receivedDateTime ge ${cursor.replace(/\.\d+Z$/, 'Z')}`)}&$orderby=receivedDateTime%20asc&$top=40&$select=${SELECT}`;
      const page = (await graph(`/users/${mb}/messages?${q}`, { Prefer: 'outlook.body-content-type="text"' })).value || [];
      if (!page.length) break;
      stats.listed += page.length;
      const ids = page.map(m => m.internetMessageId || m.id);
      const done = new Set((await sql`SELECT id FROM crm_mail WHERE id = ANY(${ids}::text[]) AND status <> 'error'`).map(x => x.id));
      const todo = page.filter(m => !done.has(m.internetMessageId || m.id));
      if (!todo.length) {   // whole page already handled — step past it
        const last = page[page.length - 1].receivedDateTime;
        cursor = last === cursor ? new Date(Date.parse(last) + 1000).toISOString() : last;
        if (page.length < 40) break; else continue;
      }
      for (let i = 0; i < todo.length; i += 4) {
        if (Date.now() - t0 > budgetMs) { stats.more = true; break outer; }
        const chunk = todo.slice(i, i + 4);
        const res = await Promise.allSettled(chunk.map(m => handle(sql, M, m, stats)));
        let stopAt = null; const errs = [];
        res.forEach((x, k) => {
          if (x.status === 'fulfilled') return;
          const e = x.reason;
          if (e?.transient || /Mailbox read failed|sign-in/.test(e?.message || '')) { if (!stopAt || chunk[k].receivedDateTime < stopAt) stopAt = chunk[k].receivedDateTime; stats.lastError = e.message; }
          else { stats.errors++; stats.lastError = e?.message; errs.push(sql`INSERT INTO crm_mail (id, graph_id, received_at, from_email, subject, status, reason) VALUES (${chunk[k].internetMessageId || chunk[k].id}, ${chunk[k].id},
              ${chunk[k].receivedDateTime}, ${(chunk[k].from?.emailAddress?.address || '').toLowerCase()}, ${clean(chunk[k].subject, 300)}, 'error', ${clean(e?.message, 300)}) ON CONFLICT (id) DO UPDATE SET tries = crm_mail.tries + 1, reason = EXCLUDED.reason WHERE crm_mail.status = 'error'`.catch(() => {})); }
        });
        await Promise.all(errs);
        if (stopAt) { cursor = stopAt; stats.more = true; throw Object.assign(new Error(stats.lastError), { keepCursor: cursor }); }
        cursor = chunk[chunk.length - 1].receivedDateTime;
        await sql`INSERT INTO crm_mail_state (key, value, at) VALUES ('cursor', ${cursor}, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, at = now()`;
      }
      if (page.length < 40) break;          // reached the newest mail
    }
    if (Date.now() - t0 >= budgetMs) stats.more = true;
    await sql`INSERT INTO crm_mail_state (key, value, at) VALUES ('cursor', ${cursor}, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, at = now()`;
    await saveRun(sql, { ok: true, ...stats, ms: Date.now() - t0, who });
    return { ok: true, ...stats };
  } catch (e) {
    if (e.keepCursor) await sql`INSERT INTO crm_mail_state (key, value, at) VALUES ('cursor', ${e.keepCursor}, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, at = now()`;
    await saveRun(sql, { ok: false, error: e.message, ...stats, ms: Date.now() - t0, who });
    return { ok: false, error: e.message, ...stats };
  } finally {
    await sql`DELETE FROM crm_mail_state WHERE key = 'lock'`;
  }
}
async function saveRun(sql, run) {
  await sql`INSERT INTO crm_mail_state (key, value, at) VALUES ('last_run', ${JSON.stringify({ ...run, at: new Date().toISOString() })}, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, at = now()`;
}
export async function mailStatus(sql) {
  const rows = await sql`SELECT key, value, at FROM crm_mail_state WHERE key IN ('cursor', 'last_run', 'lock')`;
  const k = Object.fromEntries(rows.map(r => [r.key, r]));
  let last = null; try { last = k.last_run ? JSON.parse(k.last_run.value) : null; } catch { /* */ }
  return { ...mailReady(), cursor: k.cursor?.value || null, last, running: !!k.lock };
}
