// Shared helpers (files starting with "_" are not exposed as routes on Vercel)
import { neon } from '@neondatabase/serverless';
import crypto from 'node:crypto';

let _sql = null;
export function getSql() {
  if (_sql) return _sql;
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error('DATABASE_URL is not set. Add your Neon connection string in Vercel → Settings → Environment Variables.');
  _sql = neon(url);
  return _sql;
}
export function setSql(fn) { _sql = fn; _ready = null; } // local tests only

/* ============================== form definitions ============================== */
// Ledger (KYC) form — same questions and options as "BHARAT STEEL GROUP - LEDGER DATA" (Google Form).
export const BUYER_TYPES = ['OEM', 'Government Contractor Project', 'Fabricator', 'Capex / Expansion Work', 'Individual House Buyer', 'Maintenance Activity', 'Re-seller'];
export const SEGMENTS = ['Agriculture', 'Auto Ancillary/Body', 'Auto OEM', 'Boilers & Pressure Valves', 'Cold - Forming', 'Containers', 'Defence',
  'Earth Moving Equipments', 'Electrical Equipment', 'Electrode manufacturer', 'Forging', 'Furniture', 'General fabrication', 'Heavy Machinery',
  'Housing Construction', 'Infrastructure', 'LPG Cylinder', 'Machine Tools', 'MSME Plant Based', 'Packaging', 'Power', 'Pre-eng Building Str',
  'Railways', 'Re Sale', 'Re-rolling', 'Ship building', 'Distributor', 'Project Sales', 'Tube-making'];
export const USAGE = ['Once', 'Monthly Requirement'];
export const REG_TYPES = ['PVT LTD', 'GOVT PSU', 'LLP', 'Proprietorship'];
export const KYC_DOCS = { gst_billing: 'GST Certificate (Billing Address)', cheque: 'Cancelled Cheque Copy', gst_shipping: 'GST Certificate (Shipping Address)' };
export const KYC_STATUSES = ['invited', 'submitted', 'review', 'approved', 'created', 'rejected'];

// Feedback form — same questions as "Customer Feedback Form – Bharat Steel (Chennai) Pvt Ltd" (Microsoft Form).
const SAT = ['Very satisfied', 'Somewhat satisfied', 'Neither satisfied nor dissatisfied', 'Somewhat dissatisfied', 'Very dissatisfied'];
const RATE5 = ['Excellent', 'Good', 'Fair', 'Poor', 'Very poor'];
export const FEEDBACK_QS = [
  { key: 'q_delivery', n: 2, short: 'Delivery', text: 'How satisfied are you with our delivery commitment (timeliness and reliability)?', options: SAT, required: true },
  { key: 'q_quality', n: 3, short: 'Material quality', text: 'How would you rate the quality of the supplied material?', options: ['Excellent', 'Very good', 'Good', 'Fair', 'Poor'], required: true },
  { key: 'q_response', n: 4, short: 'Query response', text: 'How satisfied are you with our response to your queries, issues, or complaints?', options: SAT, required: true },
  { key: 'q_comm', n: 5, short: 'Communication', text: 'How clear and timely is our communication with you?', options: RATE5, required: true },
  { key: 'q_relation', n: 6, short: 'Relationship', text: 'How would you rate your overall working relationship with us?', options: RATE5, required: true },
  { key: 'q_docs', n: 7, short: 'Documentation', text: 'How satisfied are you with the documentation provided (Invoice, DC, Test Certificates, etc.)?', options: SAT, required: true },
  { key: 'q_pricing', n: 8, short: 'Pricing & terms', text: 'How satisfied are you with our pricing and commercial terms?', options: SAT, required: true }
];
// First option = 5 points … last option = 1 point.
export const scoreOf = (q, label) => { const i = q.options.indexOf(label); return i < 0 ? null : 5 - i; };

/* ============================== settings ============================== */
export const DEFAULT_CFG = {
  discountPerTon: 100,           // promised on the feedback form: Rs.100 per ton on the next purchase
  lowScore: 2,                   // any answer at or below this score opens a follow-up
  kycOpen: true,                 // public /kyc form accepts responses
  feedbackOpen: true,            // public /feedback form accepts responses
  dormantDays: 90,               // no invoice for this many days = dormant
  leadSources: ['Website', 'WhatsApp', 'Phone call', 'Referral', 'Existing customer', 'IndiaMART', 'Exhibition', 'Field visit', 'Other'],
  products: ['HR Coil', 'HR Sheet / Plate', 'CR Coil / Sheet', 'Structural (Beam/Channel/Angle)', 'Chequered Plate', 'Slitting / CTL job work', 'Ready-to-use (base plates, flanges, webs, flats)', 'Other'],
  lostReasons: ['Price', 'Delivery time', 'Grade / size not available', 'Credit terms', 'Went to competitor', 'Requirement dropped', 'Other']
};
export async function loadConfig() {
  const rows = await getSql()`SELECT data FROM crm_config WHERE id = 1`;
  return { ...DEFAULT_CFG, ...(rows[0]?.data || {}) };
}

/* ============================== schema ============================== */
let _ready = null;
export function ensureSchema() {
  if (!_ready) _ready = (async () => {
    const sql = getSql();
    await sql`CREATE TABLE IF NOT EXISTS crm_users (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'sales',          -- admin | sales | viewer
      slp_code INT,                                -- SAP sales employee, for "My customers"
      pw_hash TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    // Staff sign in with email, employee code (BSC/017) or mobile; password reset by WhatsApp code.
    await sql`ALTER TABLE crm_users ALTER COLUMN email DROP NOT NULL`;
    await sql`ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS emp_code TEXT`;
    await sql`ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS mobile TEXT`;
    await sql`ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS designation TEXT`;
    await sql`ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS dept TEXT`;
    await sql`ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS must_change BOOLEAN NOT NULL DEFAULT false`;
    await sql`ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS reset_hash TEXT`;
    await sql`ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS reset_expires TIMESTAMPTZ`;
    await sql`ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS reset_tries INT NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE crm_users ADD COLUMN IF NOT EXISTS reset_sent_at TIMESTAMPTZ`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS crm_users_emp ON crm_users (upper(emp_code)) WHERE emp_code IS NOT NULL`;
    await sql`CREATE TABLE IF NOT EXISTS crm_config (id INT PRIMARY KEY DEFAULT 1, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_by TEXT)`;
    // Customer master from SAP, pushed every 15 minutes by the scheduled task on the SAP server (see /api/sap-push).
    await sql`CREATE TABLE IF NOT EXISTS crm_customers (
      card_code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      gstin TEXT,
      pan TEXT,
      slp_code INT,
      slp_name TEXT,
      group_name TEXT,
      city TEXT,
      state TEXT,
      phone TEXT,
      email TEXT,
      balance NUMERIC(16,2) NOT NULL DEFAULT 0,
      orders_bal NUMERIC(16,2) NOT NULL DEFAULT 0,
      credit_line NUMERIC(16,2) NOT NULL DEFAULT 0,
      sales365 NUMERIC(16,2) NOT NULL DEFAULT 0,
      sales90 NUMERIC(16,2) NOT NULL DEFAULT 0,
      qty365 NUMERIC(16,3) NOT NULL DEFAULT 0,
      invoices365 INT NOT NULL DEFAULT 0,
      last_invoice DATE,
      frozen BOOLEAN NOT NULL DEFAULT false,
      created_sap DATE,
      data JSONB NOT NULL,
      in_sap BOOLEAN NOT NULL DEFAULT true,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS crm_customers_gstin ON crm_customers(gstin)`;
    await sql`CREATE INDEX IF NOT EXISTS crm_customers_pan ON crm_customers(pan)`;
    await sql`ALTER TABLE crm_customers ADD COLUMN IF NOT EXISTS run_id TEXT`;
    await sql`CREATE TABLE IF NOT EXISTS crm_sync (id INT PRIMARY KEY DEFAULT 1, at TIMESTAMPTZ, ok BOOLEAN, message TEXT, count INT, full_at TIMESTAMPTZ)`;
    await sql`ALTER TABLE crm_sync ADD COLUMN IF NOT EXISTS full_at TIMESTAMPTZ`;
    // Other SAP data pushed by the scheduled task, kept with SAP's own column names.
    await sql`CREATE TABLE IF NOT EXISTS crm_sap (
      section TEXT NOT NULL,                     -- addresses | contacts | orders | invoices | payments | monthly
      key TEXT NOT NULL,
      card_code TEXT,
      doc_date DATE,
      data JSONB NOT NULL,
      run_id TEXT,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (section, key)
    )`;
    await sql`CREATE INDEX IF NOT EXISTS crm_sap_card ON crm_sap(section, card_code, doc_date)`;
    await sql`CREATE INDEX IF NOT EXISTS crm_sap_docnum ON crm_sap((data->>'DocNum')) WHERE section = 'invoices'`;
    // CRM-side details about a customer (segment, buyer type ... from the ledger form; owner and tags from staff).
    await sql`CREATE TABLE IF NOT EXISTS crm_profiles (
      card_code TEXT PRIMARY KEY,
      segment TEXT,
      buyer_types TEXT[] NOT NULL DEFAULT '{}',
      usage TEXT,
      reg_type TEXT,
      owner_email TEXT,
      tags TEXT[] NOT NULL DEFAULT '{}',
      notes TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT
    )`;
    await sql`CREATE TABLE IF NOT EXISTS crm_kyc (
      id SERIAL PRIMARY KEY,
      ref TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'submitted',
      token TEXT UNIQUE,                         -- invite link token (/kyc?t=...)
      draft_key TEXT,                            -- lets the public form attach files to its own draft only
      card_code TEXT,                            -- SAP customer once created / linked
      company TEXT,
      gstin TEXT,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      source TEXT NOT NULL DEFAULT 'form',       -- form | invite | import | staff
      invited_by TEXT,
      lead_ref INT,
      reviewed_by TEXT,
      review_note TEXT,
      ip TEXT,
      submitted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS crm_kyc_status ON crm_kyc(status)`;
    await sql`CREATE INDEX IF NOT EXISTS crm_kyc_card ON crm_kyc(card_code)`;
    await sql`CREATE TABLE IF NOT EXISTS crm_files (
      id SERIAL PRIMARY KEY,
      kind TEXT NOT NULL,                        -- kyc
      ref TEXT NOT NULL,                         -- kyc id
      doc_type TEXT NOT NULL,
      name TEXT NOT NULL,
      size BIGINT NOT NULL DEFAULT 0,
      content_type TEXT,
      url TEXT NOT NULL,
      pathname TEXT,                             -- null for outside links (e.g. Google Drive files from imported responses)
      uploaded_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS crm_files_ref ON crm_files(kind, ref)`;
    await sql`CREATE TABLE IF NOT EXISTS crm_feedback (
      id SERIAL PRIMARY KEY,
      invoice_no TEXT,
      card_code TEXT,
      customer_name TEXT,
      invoice_date DATE,
      invoice_qty NUMERIC(14,3),
      slp_name TEXT,
      q_delivery SMALLINT, q_quality SMALLINT, q_response SMALLINT, q_comm SMALLINT,
      q_relation SMALLINT, q_docs SMALLINT, q_pricing SMALLINT,
      score NUMERIC(4,2),
      comment TEXT,
      answers JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'new',        -- new | followup | closed
      assigned_to TEXT,
      action_note TEXT,
      closed_at TIMESTAMPTZ,
      discount TEXT NOT NULL DEFAULT 'eligible', -- eligible | applied | na
      discount_note TEXT,
      source TEXT NOT NULL DEFAULT 'form',       -- form | import
      ip TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS crm_feedback_card ON crm_feedback(card_code)`;
    await sql`CREATE INDEX IF NOT EXISTS crm_feedback_created ON crm_feedback(created_at)`;
    await sql`CREATE TABLE IF NOT EXISTS crm_leads (
      id SERIAL PRIMARY KEY,
      company TEXT NOT NULL,
      contact TEXT, phone TEXT, email TEXT, city TEXT,
      segment TEXT, product TEXT, est_mt NUMERIC(12,2), source TEXT,
      stage TEXT NOT NULL DEFAULT 'new',         -- new | contacted | quoted | negotiation | won | lost
      lost_reason TEXT,
      owner_email TEXT,
      next_action_at DATE,
      notes TEXT,
      card_code TEXT, kyc_id INT,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS crm_activities (
      id SERIAL PRIMARY KEY,
      card_code TEXT,
      lead_id INT,
      feedback_id INT,
      type TEXT NOT NULL,                        -- call | visit | whatsapp | email | meeting | complaint | note
      subject TEXT NOT NULL DEFAULT '',
      notes TEXT,
      follow_up_at DATE,
      done BOOLEAN NOT NULL DEFAULT false,
      owner_email TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS crm_act_card ON crm_activities(card_code)`;
    await sql`CREATE INDEX IF NOT EXISTS crm_act_follow ON crm_activities(follow_up_at) WHERE done = false`;
    await sql`CREATE TABLE IF NOT EXISTS crm_audit (id SERIAL PRIMARY KEY, who TEXT, action TEXT NOT NULL, detail JSONB, at TIMESTAMPTZ NOT NULL DEFAULT now())`;
    // Mailbox reader (info@bharatsteels.in): every mail read, and one "customer data sheet" per company found in them.
    await sql`CREATE TABLE IF NOT EXISTS crm_mail (
      id TEXT PRIMARY KEY,                       -- internetMessageId
      graph_id TEXT,
      received_at TIMESTAMPTZ NOT NULL,
      from_email TEXT, from_name TEXT, subject TEXT, snippet TEXT,
      has_attachments BOOLEAN NOT NULL DEFAULT false,
      attachments JSONB NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,                      -- skipped | done | error
      reason TEXT,                               -- why skipped / error text
      category TEXT, is_customer BOOLEAN NOT NULL DEFAULT false,
      extracted JSONB,
      party_id INT, card_code TEXT,
      tokens INT NOT NULL DEFAULT 0, tries INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS crm_mail_recv ON crm_mail(received_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS crm_mail_by_party ON crm_mail(party_id)`;
    await sql`CREATE INDEX IF NOT EXISTS crm_mail_card ON crm_mail(card_code) WHERE card_code IS NOT NULL`;
    await sql`CREATE TABLE IF NOT EXISTS crm_mail_party (
      id SERIAL PRIMARY KEY,
      company TEXT, contact TEXT, designation TEXT, mobile TEXT, phone TEXT, email TEXT, emails TEXT[] NOT NULL DEFAULT '{}',
      website TEXT, domain TEXT, gstin TEXT, pan TEXT, address TEXT, city TEXT, state TEXT, pincode TEXT,
      segment TEXT, products JSONB NOT NULL DEFAULT '[]', last_summary TEXT, last_category TEXT,
      sap_status TEXT NOT NULL DEFAULT 'new',    -- existing | possible | new | ignored
      card_code TEXT, match_basis TEXT, suggest_code TEXT,
      lead_id INT, via_portal TEXT,
      mails INT NOT NULL DEFAULT 0, first_at TIMESTAMPTZ, last_at TIMESTAMPTZ,
      edited_fields TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS crm_party_gstin ON crm_mail_party(gstin)`;
    await sql`CREATE INDEX IF NOT EXISTS crm_party_domain ON crm_mail_party(domain)`;
    // Enquiries: actual purchase requests (separate from leads, which are the marketing database of prospects)
    await sql`CREATE TABLE IF NOT EXISTS crm_enquiries (
      id SERIAL PRIMARY KEY, ref TEXT UNIQUE,
      enq_date DATE NOT NULL DEFAULT CURRENT_DATE,
      company TEXT NOT NULL, contact TEXT, designation TEXT, phone TEXT, email TEXT, gstin TEXT,
      address TEXT, city TEXT, state TEXT, pincode TEXT,
      source TEXT, source_detail TEXT,
      items JSONB NOT NULL DEFAULT '[]', total_qty NUMERIC(14,3),
      required_by DATE, delivery_at TEXT, remarks TEXT,
      status TEXT NOT NULL DEFAULT 'new',           -- new | in_progress | quoted | won | lost | on_hold
      quote_value NUMERIC(16,2), lost_reason TEXT,
      owner_email TEXT, transfers JSONB NOT NULL DEFAULT '[]',
      card_code TEXT, sap_status TEXT, match_basis TEXT, suggest_code TEXT, lead_id INT,
      created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS crm_enq_owner ON crm_enquiries(owner_email, status)`;
    await sql`CREATE INDEX IF NOT EXISTS crm_enq_date ON crm_enquiries(enq_date DESC)`;
    // Follow-ups: date AND time, enquiry link, WhatsApp reminder bookkeeping
    await sql`ALTER TABLE crm_activities ADD COLUMN IF NOT EXISTS follow_up_ts TIMESTAMPTZ`;
    await sql`ALTER TABLE crm_activities ADD COLUMN IF NOT EXISTS enquiry_id INT`;
    await sql`ALTER TABLE crm_activities ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ`;
    await sql`ALTER TABLE crm_activities ADD COLUMN IF NOT EXISTS remind_result TEXT`;
    await sql`CREATE INDEX IF NOT EXISTS crm_act_remind ON crm_activities(follow_up_ts) WHERE done = false AND reminded_at IS NULL`;
    // Leads: more contact detail and the SAP check result
    for (const col of ['gstin', 'address', 'state', 'pincode', 'designation', 'sap_status', 'match_basis', 'suggest_code'])
      await sql.query(`ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS ${col} TEXT`);
    // Feedback requests sent from the Feedback tab (customer list)
    await sql`CREATE TABLE IF NOT EXISTS crm_fb_requests (
      id SERIAL PRIMARY KEY, card_code TEXT NOT NULL, company TEXT, invoice_no TEXT, link TEXT, phone TEXT, email TEXT,
      wa_ok BOOLEAN, email_ok BOOLEAN, detail JSONB, sent_by TEXT, sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS crm_fbreq_card ON crm_fb_requests(card_code, sent_at DESC)`;
    // Payment reminders sent from the Receivables tab
    await sql`CREATE TABLE IF NOT EXISTS crm_ar_reminders (
      id SERIAL PRIMARY KEY, card_code TEXT NOT NULL, company TEXT, amount NUMERIC(16,2), overdue NUMERIC(16,2), bills INT,
      phone TEXT, email TEXT, wa_ok BOOLEAN, email_ok BOOLEAN, detail JSONB, sent_by TEXT, sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS crm_ar_rem_card ON crm_ar_reminders(card_code, sent_at DESC)`;
    await sql`CREATE TABLE IF NOT EXISTS crm_mail_state (key TEXT PRIMARY KEY, value TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now())`;
    await sql`INSERT INTO crm_config (id, data) VALUES (1, ${JSON.stringify(DEFAULT_CFG)}::jsonb) ON CONFLICT (id) DO NOTHING`;
    // One-time change (Nov 2026): feedback discount Rs.50 -> Rs.100 per ton. Runs once; later edits in Admin → Settings stay.
    const [mig] = await sql`INSERT INTO crm_mail_state (key, value) VALUES ('migr_discount_100', 'done') ON CONFLICT (key) DO NOTHING RETURNING key`;
    if (mig) await sql`UPDATE crm_config SET data = jsonb_set(data, '{discountPerTon}', '100'::jsonb) WHERE id = 1 AND (data->>'discountPerTon')::numeric = 50`;
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM crm_users`;
    const em = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const pw = process.env.ADMIN_PASSWORD || '';
    if (n === 0 && em && pw) {
      await sql`INSERT INTO crm_users (email, name, role, pw_hash) VALUES (${em}, 'Admin', 'admin', ${hashPassword(pw)}) ON CONFLICT (email) DO NOTHING`;
    }
  })().catch(e => { _ready = null; throw e; });
  return _ready;
}

export async function audit(who, action, detail = {}) {
  try { await getSql()`INSERT INTO crm_audit (who, action, detail) VALUES (${who || null}, ${action}, ${JSON.stringify(detail)}::jsonb)`; }
  catch (e) { console.warn('audit failed', e.message); }
}

/* ============================== passwords & sessions ============================== */
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
export function checkPassword(pw, stored) {
  try {
    const [alg, s, h] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const hash = crypto.scryptSync(String(pw), Buffer.from(s, 'hex'), 64);
    return crypto.timingSafeEqual(hash, Buffer.from(h, 'hex'));
  } catch { return false; }
}
export const randomToken = (n = 24) => crypto.randomBytes(n).toString('base64url');

const COOKIE = 'crm_session';
const DAYS = 30;
function secret() {
  const s = process.env.SESSION_SECRET || '';
  if (s.length < 16) throw new Error('SESSION_SECRET is not set (use at least 16 random characters) in Vercel → Settings → Environment Variables.');
  return s;
}
const b64 = s => Buffer.from(s).toString('base64url');
function sign(payload) {
  const body = b64(JSON.stringify(payload));
  return `${body}.${crypto.createHmac('sha256', secret()).update(body).digest('base64url')}`;
}
function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const good = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  if (mac.length !== good.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}
function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(c => { const i = c.indexOf('='); if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); });
  return out;
}
const secureFlag = req => (req.headers['x-forwarded-proto'] === 'http' || /^localhost|^127\./.test(req.headers.host || '')) ? '' : '; Secure';
export function setSession(req, res, uid) {
  const tok = sign({ uid, exp: Date.now() + DAYS * 864e5 });
  res.setHeader('Set-Cookie', `${COOKIE}=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DAYS * 86400}${secureFlag(req)}`);
}
export function clearSession(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag(req)}`);
}
// One identity string per staff member, used for owners / assigned-to / created-by: their email, else emp:<code>.
export const userKey = u => u.email || (u.emp_code ? 'emp:' + String(u.emp_code).toLowerCase() : 'uid:' + u.id);
export const USER_KEY_SQL = "COALESCE(email, 'emp:' || lower(emp_code), 'uid:' || id)";
export async function currentUser(req) {
  const p = verify(cookies(req)[COOKIE]);
  if (!p) return null;
  const rows = await getSql()`SELECT id, email, name, role, slp_code, emp_code, mobile, must_change FROM crm_users WHERE id = ${p.uid} AND active = true`;
  const u = rows[0] || null;
  if (u) { u.login_email = u.email; u.email = userKey(u); }   // staff imported without email are keyed by employee code
  return u;
}
// The common starting password for new and imported staff (they must change it at first sign-in).
export const commonPassword = () => String(process.env.COMMON_PASSWORD || 'Bsg@1234');
export function passwordProblem(pw) {
  pw = String(pw || '');
  if (pw.length < 8) return 'Password must be at least 8 characters';
  if (/^\d+$/.test(pw) || /^[a-z]+$/i.test(pw)) return 'Use a mix of letters and numbers';
  if (pw === commonPassword()) return 'Choose your own password, not the common starting one';
  return null;
}
// Find a staff account by email, employee code or mobile number.
export async function findUser(id) {
  const v = String(id || '').trim();
  if (!v) return null;
  const digits = v.replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
  const [u] = await getSql()`SELECT * FROM crm_users WHERE lower(email) = ${v.toLowerCase()} OR upper(emp_code) = ${v.toUpperCase()}
                             OR (${digits.length === 10} AND mobile = ${digits}) ORDER BY active DESC LIMIT 1`;
  return u || null;
}
export const canEdit = u => u && (u.role === 'admin' || u.role === 'sales');
export const isAdmin = u => u && u.role === 'admin';

/* ============================== validation ============================== */
export const STATE_CODES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi',
  '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands', '36': 'Telangana',
  '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory'
};
const GST_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function gstinProblem(g) {
  g = String(g || '').toUpperCase().trim();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) return 'GSTIN must be 15 characters like 33AAACB1234C1Z5';
  if (!STATE_CODES[g.slice(0, 2)]) return 'GSTIN state code ' + g.slice(0, 2) + ' is not valid';
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GST_CHARS.indexOf(g[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(v / 36) + (v % 36);
  }
  if (GST_CHARS[(36 - (sum % 36)) % 36] !== g[14]) return 'GSTIN check digit does not match — please re-check the number';
  return null;
}
export const panOf = g => (g && g.length >= 12 ? String(g).toUpperCase().slice(2, 12) : null);
export const ifscOk = v => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(v || '').toUpperCase().trim());
export const pinOk = v => /^[1-9][0-9]{5}$/.test(String(v || '').trim());
export const phoneDigits = v => String(v || '').replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
export const emailOk = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
export const clean = (v, max = 500) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
export const cleanMulti = (v, max = 1000) => String(v ?? '').replace(/\r/g, '').trim().slice(0, max);

/* ============================== http ============================== */
export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
export async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
export const query = req => new URL(req.url, 'http://x').searchParams;
export const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
export function route(fn) {
  return async (req, res) => {
    try { await ensureSchema(); await fn(req, res); }
    catch (e) { console.error(e); send(res, e.status || 500, { error: e.message || 'Server error' }); }
  };
}
export function fail(status, message) { const e = new Error(message); e.status = status; return e; }
export async function needUser(req, { edit = false, admin = false } = {}) {
  const me = await currentUser(req);
  if (!me) throw fail(401, 'Please sign in');
  if (admin && !isAdmin(me)) throw fail(403, 'Admins only');
  if (edit && !canEdit(me)) throw fail(403, 'You have view-only access');
  return me;
}
// Public forms: at most `max` submissions from one address per hour.
export async function rateLimit(table, ip, max = 15) {
  if (!ip) return;
  const sql = getSql();
  const rows = table === 'crm_kyc'
    ? await sql`SELECT COUNT(*)::int AS n FROM crm_kyc WHERE ip = ${ip} AND created_at > now() - interval '1 hour'`
    : await sql`SELECT COUNT(*)::int AS n FROM crm_feedback WHERE ip = ${ip} AND created_at > now() - interval '1 hour'`;
  if (rows[0].n >= max) throw fail(429, 'Too many submissions from this network. Please try again in an hour.');
}
