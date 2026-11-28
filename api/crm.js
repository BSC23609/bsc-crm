// Activities & follow-ups, leads pipeline, dashboard.
import { route, send, readBody, getSql, needUser, audit, loadConfig, fail, clean, cleanMulti, phoneDigits, canEdit, isAdmin, gstinProblem, SEGMENTS, BUYER_TYPES, USAGE, REG_TYPES } from './_lib.js';
import { sapStatus, summary } from './_sap.js';
import { emailReady, whatsappReady, appUrl, sendKycWhatsApp, sendKycEmail, sendReminderWhatsApp, sendReminderEmail, sendFeedbackWhatsApp, sendFeedbackEmail } from './_notify.js';
import { runMailSync, mailStatus, sapCheck } from './_mail.js';
import { sendEnquiryAssigned } from './_notify.js';

const TYPES = ['call', 'visit', 'whatsapp', 'email', 'meeting', 'complaint', 'note'];
const STAGES = ['new', 'contacted', 'quoted', 'negotiation', 'won', 'lost'];
const ENQ_STATUS = ['new', 'in_progress', 'quoted', 'won', 'lost', 'on_hold'];
const ENQ_SOURCES = ['Phone call', 'Walk-in', 'Email', 'WhatsApp', 'Website – organic', 'Website – paid campaign', 'Google Ads', 'IndiaMART', 'Reference', 'Existing customer', 'Sales visit', 'Other'];
// follow-up date (YYYY-MM-DD) + optional time (HH:MM, IST) -> timestamptz
const followTs = (date, time) => (/^\d{4}-\d{2}-\d{2}$/.test(date || '') && /^\d{2}:\d{2}$/.test(time || '')) ? `${date}T${time}:00+05:30` : null;
const dateOrNull = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);

export default route(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const me = await needUser(req);
  const b = await readBody(req);
  const sql = getSql();

  if (b.action === 'meta') {   // lists the screens need
    const cfg = await loadConfig();
    const staff = await sql`SELECT COALESCE(email, 'emp:' || lower(emp_code), 'uid:' || id) AS email, name, role, designation, dept FROM crm_users WHERE active AND role <> 'viewer' ORDER BY name, email`;
    return send(res, 200, { segments: SEGMENTS, buyerTypes: BUYER_TYPES, usage: USAGE, regTypes: REG_TYPES, stages: STAGES, types: TYPES,
      sources: cfg.leadSources, products: cfg.products, lostReasons: cfg.lostReasons, discountPerTon: cfg.discountPerTon,
      dormantDays: cfg.dormantDays, lowScore: cfg.lowScore, staff, sapConnected: (await sapStatus()).connected, emailReady: emailReady(), whatsappReady: whatsappReady(), appUrl: appUrl() });
  }

  /* ---------------- dashboard ---------------- */
  if (b.action === 'dashboard') {
    const cfg = await loadConfig();
    const sync = await sapStatus();
    const sap = await summary();
    const dd = cfg.dormantDays;
    const [cust] = await sql`SELECT COUNT(*) FILTER (WHERE in_sap)::int AS total,
        COUNT(*) FILTER (WHERE in_sap AND last_invoice >= CURRENT_DATE - 90)::int AS active90,
        COUNT(*) FILTER (WHERE in_sap AND last_invoice < CURRENT_DATE - ${dd}::int)::int AS dormant,
        COUNT(*) FILTER (WHERE in_sap AND last_invoice IS NULL)::int AS never,
        COALESCE(SUM(balance) FILTER (WHERE in_sap AND balance > 0), 0)::float AS receivable,
        COUNT(*) FILTER (WHERE in_sap AND credit_line > 0 AND balance > credit_line)::int AS over_credit,
        COUNT(*) FILTER (WHERE in_sap AND NOT EXISTS (SELECT 1 FROM crm_kyc k WHERE k.card_code = crm_customers.card_code AND k.status IN ('approved','created')))::int AS no_kyc,
        COUNT(*) FILTER (WHERE in_sap AND NOT EXISTS (SELECT 1 FROM crm_profiles p WHERE p.card_code = crm_customers.card_code AND p.segment IS NOT NULL))::int AS no_segment
      FROM crm_customers`;
    const kyc = await sql`SELECT status, COUNT(*)::int AS n FROM crm_kyc WHERE status <> 'draft' GROUP BY status`;
    const [fb] = await sql`SELECT COUNT(*)::int AS n, ROUND(AVG(score), 2)::float AS avg,
        COUNT(*) FILTER (WHERE status = 'followup')::int AS open_issues,
        COUNT(*) FILTER (WHERE discount = 'eligible')::int AS discount_pending
      FROM crm_feedback WHERE created_at >= now() - interval '90 days'`;
    const [fbOpen] = await sql`SELECT COUNT(*) FILTER (WHERE status = 'followup')::int AS open_issues, COUNT(*) FILTER (WHERE discount = 'eligible')::int AS discount_pending FROM crm_feedback`;
    const [fu] = await sql`SELECT COUNT(*) FILTER (WHERE follow_up_at < CURRENT_DATE)::int AS overdue, COUNT(*) FILTER (WHERE follow_up_at = CURRENT_DATE)::int AS today,
        COUNT(*) FILTER (WHERE follow_up_at > CURRENT_DATE AND follow_up_at <= CURRENT_DATE + 7)::int AS week
      FROM crm_activities WHERE NOT done AND follow_up_at IS NOT NULL AND (${me.role !== 'sales'} OR owner_email = ${me.email} OR created_by = ${me.email} OR owner_email IS NULL)`;
    const leads = await sql`SELECT stage, COUNT(*)::int AS n, COALESCE(SUM(est_mt), 0)::float AS mt FROM crm_leads GROUP BY stage`;
    const top = await sql`SELECT card_code, name, sales365::float AS sales365, qty365::float AS qty365, balance::float AS balance, last_invoice
                          FROM crm_customers WHERE in_sap ORDER BY sales365 DESC LIMIT 10`;
    // Win-back list: used to buy regularly, went quiet recently.
    const winback = await sql`SELECT card_code, name, last_invoice, sales365::float AS sales365, slp_name, phone FROM crm_customers
                              WHERE in_sap AND last_invoice < CURRENT_DATE - ${dd}::int AND last_invoice >= CURRENT_DATE - ${dd + 120}::int
                              ORDER BY sales365 DESC LIMIT 12`;
    const overCredit = await sql`SELECT card_code, name, balance::float AS balance, credit_line::float AS credit_line FROM crm_customers
                                 WHERE in_sap AND credit_line > 0 AND balance > credit_line ORDER BY balance - credit_line DESC LIMIT 10`;
    const segments = await sql`SELECT COALESCE(p.segment, 'Not captured') AS segment, COUNT(*)::int AS n, COALESCE(SUM(c.sales365), 0)::float AS sales
                               FROM crm_customers c LEFT JOIN crm_profiles p ON p.card_code = c.card_code WHERE c.in_sap
                               GROUP BY 1 ORDER BY sales DESC`;
    const fbMonthly = await sql`SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS m, COUNT(*)::int AS n, ROUND(AVG(score), 2)::float AS avg
                                FROM crm_feedback WHERE created_at >= date_trunc('month', now()) - interval '11 months' GROUP BY 1 ORDER BY 1`;
    return send(res, 200, { sap, sync,
      cust, kyc, fb, fbOpen, fu, leads, top, winback, overCredit, segments, fbMonthly, dormantDays: dd });
  }

  /* ---------------- activities / follow-ups ---------------- */
  if (b.action === 'activities') {
    // due: open follow-ups (overdue first). Otherwise recent activity across all customers.
    if (b.due) {
      const rows = await sql`SELECT a.*, c.name AS customer, l.company AS lead_company, e.ref AS enq_ref, e.company AS enq_company FROM crm_activities a
          LEFT JOIN crm_customers c ON c.card_code = a.card_code LEFT JOIN crm_leads l ON l.id = a.lead_id LEFT JOIN crm_enquiries e ON e.id = a.enquiry_id
          WHERE NOT a.done AND a.follow_up_at IS NOT NULL AND (${!b.mine} OR a.owner_email = ${me.email} OR a.created_by = ${me.email})
          ORDER BY a.follow_up_at, a.follow_up_ts NULLS LAST, a.id LIMIT 1000`;
      return send(res, 200, { rows });
    }
    const rows = await sql`SELECT a.*, c.name AS customer, l.company AS lead_company, e.ref AS enq_ref, e.company AS enq_company FROM crm_activities a
        LEFT JOIN crm_customers c ON c.card_code = a.card_code LEFT JOIN crm_leads l ON l.id = a.lead_id LEFT JOIN crm_enquiries e ON e.id = a.enquiry_id
        WHERE (${!b.lead_id} OR a.lead_id = ${Number(b.lead_id) || 0}) AND (${!b.enquiry_id} OR a.enquiry_id = ${Number(b.enquiry_id) || 0})
        ORDER BY a.created_at DESC LIMIT 500`;
    return send(res, 200, { rows });
  }
  if (b.action === 'leads') {
    const cfg = await loadConfig();
    const rows = await sql`SELECT l.*, l.est_mt::float AS est_mt, k.ref AS kyc_ref, k.status AS kyc_status,
        (SELECT MAX(created_at) FROM crm_activities a WHERE a.lead_id = l.id) AS last_activity
      FROM crm_leads l LEFT JOIN crm_kyc k ON k.id = l.kyc_id ORDER BY l.updated_at DESC`;
    return send(res, 200, { rows, stages: STAGES, sources: cfg.leadSources, products: cfg.products, lostReasons: cfg.lostReasons });
  }
  if (b.action === 'staff') {   // people to assign work to
    const rows = await sql`SELECT COALESCE(email, 'emp:' || lower(emp_code), 'uid:' || id) AS email, name, role FROM crm_users WHERE active AND role <> 'viewer' ORDER BY name, email`;
    return send(res, 200, { rows });
  }


  /* ---------- Mail: customer data sheets built from info@bharatsteels.in ---------- */
  if (b.action === 'mail_overview') {
    const status = await mailStatus(sql);
    const [k] = await sql`SELECT COUNT(*)::int AS mails, COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped, COUNT(*) FILTER (WHERE is_customer)::int AS customer_mails,
        COUNT(*) FILTER (WHERE status = 'error')::int AS errors, COALESCE(SUM(tokens), 0)::int AS tokens,
        COUNT(*) FILTER (WHERE is_customer AND received_at > now() - interval '30 days')::int AS customer30, MIN(received_at) AS oldest, MAX(received_at) AS newest FROM crm_mail`;
    const parties = await sql`SELECT p.id, p.company, p.contact, p.designation, p.mobile, p.phone, p.email, p.city, p.state, p.gstin, p.segment, p.products, p.last_summary, p.last_category,
        p.sap_status, p.card_code, p.match_basis, p.suggest_code, p.lead_id, p.via_portal, p.mails, p.first_at, p.last_at, c.name AS sap_name, s.name AS suggest_name, l.stage AS lead_stage
      FROM crm_mail_party p LEFT JOIN crm_customers c ON c.card_code = p.card_code LEFT JOIN crm_customers s ON s.card_code = p.suggest_code LEFT JOIN crm_leads l ON l.id = p.lead_id
      ORDER BY p.last_at DESC NULLS LAST LIMIT 3000`;
    const cats = await sql`SELECT COALESCE(category, 'skipped: ' || COALESCE(reason, '')) AS k, COUNT(*)::int AS n FROM crm_mail WHERE status <> 'error' GROUP BY 1 ORDER BY 2 DESC`;
    return send(res, 200, { status, k, parties, cats });
  }
  if (b.action === 'mail_party') {
    const [p] = await sql`SELECT p.*, c.name AS sap_name, s.name AS suggest_name FROM crm_mail_party p LEFT JOIN crm_customers c ON c.card_code = p.card_code
      LEFT JOIN crm_customers s ON s.card_code = p.suggest_code WHERE p.id = ${Number(b.id)}`;
    if (!p) throw fail(404, 'Not found');
    const mails = await sql`SELECT id, received_at, from_email, from_name, subject, category, extracted->>'summary' AS summary, extracted->>'action_needed' AS action_needed,
        extracted->'products' AS products, extracted->'documents_seen' AS docs, attachments, snippet FROM crm_mail WHERE party_id = ${p.id} ORDER BY received_at DESC LIMIT 100`;
    return send(res, 200, { party: p, mails, mailbox: (await mailStatus(sql)).mailbox });
  }
  if (b.action === 'mail_log') {
    const f = String(b.filter || 'all');
    const rows = await sql`SELECT id, received_at, from_email, from_name, subject, status, reason, category, is_customer, extracted->>'summary' AS summary, party_id, card_code
      FROM crm_mail WHERE (${f} = 'all' OR (${f} = 'skipped' AND status = 'skipped') OR (${f} = 'read' AND status = 'done' AND NOT is_customer)
        OR (${f} = 'customer' AND is_customer) OR (${f} = 'error' AND status = 'error'))
        AND (${clean(b.q, 80)} = '' OR from_email ILIKE ${'%' + clean(b.q, 80) + '%'} OR subject ILIKE ${'%' + clean(b.q, 80) + '%'})
      ORDER BY received_at DESC LIMIT 500`;
    return send(res, 200, { rows });
  }


  /* ---------- WhatsApp / email: setup status, test send, log (Ledger forms, Receivables, Feedback) ---------- */
  if (b.action === 'msg_log') {
    const kind = ['kyc', 'ar', 'feedback'].includes(b.kind) ? b.kind : 'kyc';
    const E = (k, d) => String(process.env[k] || d).trim();
    const setup = {
      whatsapp: whatsappReady(), email: emailReady(), from: E('SMTP_FROM', 'info@bharatsteels.in'),
      wati: (E('WATI_BASE_URL', '').match(/^https?:\/\/[^/]+/) || [''])[0],
      template: kind === 'kyc' ? E('WATI_KYC_TEMPLATE', 'bsc_ledger_form_8') : kind === 'ar' ? E('WATI_AR_TEMPLATE', 'bsc_payment_reminder') : E('WATI_FEEDBACK_TEMPLATE', 'bsc_feedback_request'),
      params: kind === 'kyc' ? ['name', 'company'] : kind === 'ar' ? ['company', 'amount', 'bills'] : ['company', 'invoice', 'link']
    };
    const tests = (await sql`SELECT who, detail, at FROM crm_audit WHERE action = 'test_send' AND detail->>'kind' = ${kind} ORDER BY at DESC LIMIT 30`)
      .flatMap(t => (t.detail.results || []).map(r => ({ at: t.at, by: t.who, company: 'TEST', to: r.to, via: r.via, ok: r.ok, message: r.message, test: true })));
    let real = [];
    if (kind === 'kyc') {
      real = (await sql`SELECT k.company, x.value AS s FROM crm_kyc k, jsonb_array_elements(COALESCE(k.data->'_sent', '[]'::jsonb)) x
          ORDER BY (x.value->>'at') DESC LIMIT 100`).map(r => ({ at: r.s.at, by: r.s.by, company: r.company, via: r.s.via, ok: r.s.ok, message: r.s.message }));
    } else {
      const rows = kind === 'ar'
        ? await sql`SELECT company, phone, email, wa_ok, email_ok, detail, sent_by, sent_at FROM crm_ar_reminders ORDER BY sent_at DESC LIMIT 60`
        : await sql`SELECT company, phone, email, wa_ok, email_ok, detail, sent_by, sent_at FROM crm_fb_requests ORDER BY sent_at DESC LIMIT 60`;
      real = rows.flatMap(r => [r.wa_ok != null && { at: r.sent_at, by: r.sent_by, company: r.company, to: r.phone, via: 'whatsapp', ok: r.wa_ok, message: r.detail?.wa },
        r.email_ok != null && { at: r.sent_at, by: r.sent_by, company: r.company, to: r.email, via: 'email', ok: r.email_ok, message: r.detail?.email }].filter(Boolean));
    }
    const log = [...tests, ...real].sort((a, b2) => new Date(b2.at) - new Date(a.at)).slice(0, 150);
    return send(res, 200, { setup, log });
  }


  /* ---------- Enquiries (purchase requests) ---------- */
  if (b.action === 'sap_check') {   // live check while filling a lead / enquiry form
    const r = await sapCheck(sql, { company: clean(b.company, 200), gstin: clean(b.gstin, 15).toUpperCase(), phone: b.phone, email: b.email, city: clean(b.city, 80), pincode: b.pincode });
    const g = clean(b.gstin, 15).toUpperCase(), digits = phoneDigits(b.phone).slice(-10), nm = clean(b.company, 200).toLowerCase();
    const dup = (g || digits || nm) ? await sql`SELECT id, ref, company, status, enq_date, owner_email FROM crm_enquiries
        WHERE id <> ${Number(b.id) || 0} AND status NOT IN ('won', 'lost') AND enq_date > CURRENT_DATE - 90
          AND ((${g} <> '' AND gstin = ${g}) OR (${digits} <> '' AND right(phone, 10) = ${digits}) OR (${nm} <> '' AND lower(company) = ${nm}))
        ORDER BY enq_date DESC LIMIT 5` : [];
    const leads = (g || digits || nm) ? await sql`SELECT id, company, stage FROM crm_leads WHERE id <> ${Number(b.lead_id) || 0}
        AND ((${g} <> '' AND gstin = ${g}) OR (${digits} <> '' AND right(phone, 10) = ${digits}) OR (${nm} <> '' AND lower(company) = ${nm})) LIMIT 5` : [];
    return send(res, 200, { ...r, open_enquiries: dup, leads });
  }
  if (b.action === 'enq_list') {
    const rows = await sql`SELECT e.id, e.ref, e.enq_date, e.company, e.contact, e.phone, e.email, e.city, e.state, e.gstin, e.source, e.items, e.total_qty::float AS total_qty,
        e.required_by, e.status, e.quote_value::float AS quote_value, e.lost_reason, e.owner_email, e.card_code, e.sap_status, e.match_basis, e.suggest_code, e.lead_id,
        e.created_by, e.created_at, e.updated_at, jsonb_array_length(e.transfers) AS transfers,
        COALESCE(c.name, s2.name) AS sap_name,
        (SELECT MIN(COALESCE(a.follow_up_ts, (a.follow_up_at + time '09:30') AT TIME ZONE 'Asia/Kolkata')) FROM crm_activities a WHERE a.enquiry_id = e.id AND NOT a.done AND a.follow_up_at IS NOT NULL) AS next_follow,
        (SELECT MAX(a.created_at) FROM crm_activities a WHERE a.enquiry_id = e.id) AS last_activity
      FROM crm_enquiries e LEFT JOIN crm_customers c ON c.card_code = e.card_code LEFT JOIN crm_customers s2 ON s2.card_code = e.suggest_code
      ORDER BY e.enq_date DESC, e.id DESC LIMIT 3000`;
    return send(res, 200, { rows, statuses: ENQ_STATUS, sources: ENQ_SOURCES });
  }
  if (b.action === 'enq_get') {
    const [e] = await sql`SELECT e.*, e.total_qty::float AS total_qty, e.quote_value::float AS quote_value, COALESCE(c.name, s2.name) AS sap_name
      FROM crm_enquiries e LEFT JOIN crm_customers c ON c.card_code = e.card_code LEFT JOIN crm_customers s2 ON s2.card_code = e.suggest_code WHERE e.id = ${Number(b.id)}`;
    if (!e) throw fail(404, 'Enquiry not found');
    const acts = await sql`SELECT * FROM crm_activities WHERE enquiry_id = ${e.id} ORDER BY created_at DESC`;
    return send(res, 200, { enquiry: e, activities: acts });
  }

  if (!canEdit(me)) throw fail(403, 'You have view-only access');

  if (b.action === 'activity_save') {
    const type = TYPES.includes(b.type) ? b.type : 'note';
    const card = clean(b.card_code, 40) || null, lead = b.lead_id ? Number(b.lead_id) : null, enq = b.enquiry_id ? Number(b.enquiry_id) : null;
    if (!card && !lead && !enq) return send(res, 400, { error: 'Pick a customer, lead or enquiry' });
    const subject = clean(b.subject, 200);
    if (!subject) return send(res, 400, { error: 'Write a short subject' });
    const due = dateOrNull(b.follow_up_at), ts = due ? followTs(due, b.follow_up_time) : null;
    const vals = { notes: cleanMulti(b.notes, 4000) || null, due, ts, owner: clean(b.owner_email, 120).toLowerCase() || me.email };
    let id = Number(b.id) || null;
    if (id) {
      // a new date/time re-arms the WhatsApp reminder
      await sql`UPDATE crm_activities SET type = ${type}, subject = ${subject}, notes = ${vals.notes},
                reminded_at = CASE WHEN follow_up_at IS DISTINCT FROM ${vals.due}::date OR follow_up_ts IS DISTINCT FROM ${vals.ts}::timestamptz OR owner_email IS DISTINCT FROM ${vals.owner} THEN NULL ELSE reminded_at END,
                follow_up_at = ${vals.due}, follow_up_ts = ${vals.ts}, owner_email = ${vals.owner}, done = ${!!b.done}, updated_at = now() WHERE id = ${id}`;
    } else {
      [{ id }] = await sql`INSERT INTO crm_activities (card_code, lead_id, enquiry_id, type, subject, notes, follow_up_at, follow_up_ts, owner_email, done, created_by)
        VALUES (${card}, ${lead}, ${enq}, ${type}, ${subject}, ${vals.notes}, ${vals.due}, ${vals.ts}, ${vals.owner}, ${!!b.done}, ${me.email}) RETURNING id`;
      if (lead) await sql`UPDATE crm_leads SET updated_at = now(), stage = CASE WHEN stage = 'new' THEN 'contacted' ELSE stage END WHERE id = ${lead}`;
      if (enq) await sql`UPDATE crm_enquiries SET updated_at = now(), status = CASE WHEN status = 'new' THEN 'in_progress' ELSE status END WHERE id = ${enq}`;
    }
    return send(res, 200, { ok: true, id });
  }
  if (b.action === 'activity_done') {
    await sql`UPDATE crm_activities SET done = ${b.done !== false}, updated_at = now() WHERE id = ${Number(b.id)}`;
    // Rescheduling: mark done and open the next follow-up in one go
    if (b.next_at && dateOrNull(b.next_at)) {
      const [a] = await sql`SELECT * FROM crm_activities WHERE id = ${Number(b.id)}`;
      await sql`INSERT INTO crm_activities (card_code, lead_id, enquiry_id, type, subject, notes, follow_up_at, follow_up_ts, owner_email, created_by)
        VALUES (${a.card_code}, ${a.lead_id}, ${a.enquiry_id}, ${a.type}, ${a.subject}, ${cleanMulti(b.note, 2000) || null}, ${b.next_at}, ${followTs(b.next_at, b.next_time)}, ${a.owner_email}, ${me.email})`;
    }
    return send(res, 200, { ok: true });
  }
  if (b.action === 'activity_delete') {
    const [a] = await sql`SELECT created_by FROM crm_activities WHERE id = ${Number(b.id)}`;
    if (a && a.created_by !== me.email && !isAdmin(me)) throw fail(403, 'Only the person who logged it (or an admin) can delete it');
    await sql`DELETE FROM crm_activities WHERE id = ${Number(b.id)}`;
    return send(res, 200, { ok: true });
  }

  if (b.action === 'lead_save') {
    const company = clean(b.company, 200);
    if (!company) return send(res, 400, { error: 'Enter the company name' });
    const stage = STAGES.includes(b.stage) ? b.stage : 'new';
    if (stage === 'lost' && !clean(b.lost_reason, 80)) return send(res, 400, { error: 'Pick why the lead was lost' });
    const v = {
      contact: clean(b.contact, 120) || null, phone: phoneDigits(b.phone) || null, email: clean(b.email, 160).toLowerCase() || null, city: clean(b.city, 80) || null,
      segment: clean(b.segment, 80) || null, product: clean(b.product, 120) || null, est: b.est_mt === '' || b.est_mt == null ? null : Math.max(0, Number(b.est_mt) || 0),
      source: clean(b.source, 60) || null, lost: stage === 'lost' ? clean(b.lost_reason, 80) : null, owner: clean(b.owner_email, 120).toLowerCase() || me.email,
      next: dateOrNull(b.next_action_at), notes: cleanMulti(b.notes, 4000) || null, card: clean(b.card_code, 40) || null,
      gstin: clean(b.gstin, 15).toUpperCase() || null, address: clean(b.address, 400) || null, state: clean(b.state, 60) || null,
      pincode: (String(b.pincode || '').match(/[1-9][0-9]{5}/) || [null])[0], designation: clean(b.designation, 100) || null
    };
    if (v.gstin) { const e = gstinProblem(v.gstin); if (e) return send(res, 400, { error: e }); }
    const chk = await sapCheck(sql, { company, gstin: v.gstin, phone: v.phone, email: v.email, city: v.city, pincode: v.pincode });
    if (v.card) { const [c] = await sql`SELECT 1 FROM crm_customers WHERE card_code = ${v.card}`; if (!c) return send(res, 400, { error: 'Unknown SAP customer code' }); }
    let id = Number(b.id) || null;
    if (id) {
      await sql`UPDATE crm_leads SET company = ${company}, contact = ${v.contact}, phone = ${v.phone}, email = ${v.email}, city = ${v.city}, segment = ${v.segment},
                product = ${v.product}, est_mt = ${v.est}, source = ${v.source}, stage = ${stage}, lost_reason = ${v.lost}, owner_email = ${v.owner},
                next_action_at = ${v.next}, notes = ${v.notes}, card_code = ${v.card}, updated_at = now() WHERE id = ${id}`;
    } else {
      [{ id }] = await sql`INSERT INTO crm_leads (company, contact, phone, email, city, segment, product, est_mt, source, stage, lost_reason, owner_email, next_action_at, notes, card_code, created_by)
        VALUES (${company}, ${v.contact}, ${v.phone}, ${v.email}, ${v.city}, ${v.segment}, ${v.product}, ${v.est}, ${v.source}, ${stage}, ${v.lost}, ${v.owner}, ${v.next}, ${v.notes}, ${v.card}, ${me.email})
        RETURNING id`;
    }
    await sql`UPDATE crm_leads SET gstin = ${v.gstin}, address = ${v.address}, state = ${v.state}, pincode = ${v.pincode}, designation = ${v.designation},
      sap_status = ${chk.status}, match_basis = ${chk.basis || null}, suggest_code = ${chk.code || chk.suggest || null} WHERE id = ${id}`;
    await audit(me.email, 'lead_save', { id, stage });
    return send(res, 200, { ok: true, id, sap: chk });
  }


  if (b.action === 'test_send') {   // send the real template with sample values to a staff number / email
    const kind = ['kyc', 'ar', 'feedback'].includes(b.kind) ? b.kind : 'kyc';
    const phone = clean(b.phone, 30), email = clean(b.email, 160).toLowerCase();
    if (!phone && !email) return send(res, 400, { error: 'Enter a mobile number or an email to test with' });
    const base = appUrl(), logo = base + '/img/bsc-logo.png';
    const company = 'TEST – ABC Steels Pvt Ltd';
    const results = [];
    if (kind === 'kyc') {
      if (phone) results.push({ via: 'whatsapp', to: phone, ...(await sendKycWhatsApp({ phone, name: me.name || 'Test', company })) });
      if (email) results.push({ via: 'email', to: email, ...(await sendKycEmail({ to: email, name: me.name || 'Test', company, url: base + '/kyc', logoUrl: logo })) });
    } else if (kind === 'ar') {
      const g = { company, amount: 80000, maxDays: 45, bills: [
        { bill_no: 'TEST/0001', bill_date: '2026-09-01', due_date: '2026-10-01', days: 45, amount: 50000 },
        { bill_no: 'TEST/0002', bill_date: '2026-10-05', due_date: '2026-11-04', days: 11, amount: 30000 }] };
      if (phone) results.push({ via: 'whatsapp', to: phone, ...(await sendReminderWhatsApp(phone, g)) });
      if (email) results.push({ via: 'email', to: email, ...(await sendReminderEmail(email, g, logo)) });
    } else {
      const f = { company, invoice: 'TEST/0001', link: base + '/feedback?inv=TEST%2F0001' };
      if (phone) results.push({ via: 'whatsapp', to: phone, ...(await sendFeedbackWhatsApp(phone, f)) });
      if (email) results.push({ via: 'email', to: email, ...(await sendFeedbackEmail(email, f, logo)) });
    }
    await audit(me.email, 'test_send', { kind, results: results.map(r => ({ via: r.via, to: r.to, ok: r.ok, message: r.message })) });
    return send(res, 200, { results });
  }
  if (b.action === 'mail_sync') {
    if (!isAdmin(me)) throw fail(403, 'Admins only');
    return send(res, 200, await runMailSync({ budgetMs: 80000, who: me.email }));
  }
  if (b.action === 'mail_party_save') {   // staff corrections, SAP link, ignore
    const id = Number(b.id); const [p] = await sql`SELECT * FROM crm_mail_party WHERE id = ${id}`;
    if (!p) throw fail(404, 'Not found');
    const F = ['company', 'contact', 'designation', 'mobile', 'phone', 'email', 'website', 'gstin', 'pan', 'address', 'city', 'state', 'pincode', 'segment'];
    const v = {}, edited = new Set(p.edited_fields);
    for (const f of F) { v[f] = p[f]; if (b.fields && f in b.fields) { const n = clean(b.fields[f], f === 'address' ? 400 : 200) || null; if (n !== p[f]) { v[f] = n; edited.add(f); } } }
    if (v.gstin) { v.gstin = v.gstin.toUpperCase(); const e = gstinProblem(v.gstin); if (e) return send(res, 400, { error: e }); }
    let { sap_status: st, card_code: card, match_basis: basis } = p;
    if (b.sap === 'ignore') { st = 'ignored'; }
    else if (b.sap === 'new') { st = 'new'; card = null; basis = 'set by staff'; }
    else if (b.sap === 'unignore') { st = card ? 'existing' : 'new'; }
    else if (b.sap) {
      const code = clean(b.sap, 40).toUpperCase(); const [c] = await sql`SELECT card_code FROM crm_customers WHERE upper(card_code) = ${code}`;
      if (!c) return send(res, 400, { error: 'No SAP customer with code ' + code });
      st = 'existing'; card = c.card_code; basis = 'set by staff';
    }
    await sql`UPDATE crm_mail_party SET company = ${v.company}, contact = ${v.contact}, designation = ${v.designation}, mobile = ${v.mobile}, phone = ${v.phone}, email = ${v.email},
        website = ${v.website}, gstin = ${v.gstin}, pan = ${v.pan}, address = ${v.address}, city = ${v.city}, state = ${v.state}, pincode = ${v.pincode}, segment = ${v.segment},
        sap_status = ${st}, card_code = ${card}, match_basis = ${basis}, suggest_code = CASE WHEN ${st} = 'existing' THEN NULL ELSE suggest_code END,
        edited_fields = ${[...edited]}, updated_at = now() WHERE id = ${id}`;
    await sql`UPDATE crm_mail SET card_code = ${st === 'existing' ? card : null} WHERE party_id = ${id}`;
    await audit(me.email, 'mail_party_save', { id, sap: b.sap || null });
    return send(res, 200, { ok: true });
  }
  if (b.action === 'mail_party_lead') {   // new customer from mail -> lead
    const [p] = await sql`SELECT * FROM crm_mail_party WHERE id = ${Number(b.id)}`;
    if (!p) throw fail(404, 'Not found');
    if (p.lead_id) return send(res, 200, { ok: true, id: p.lead_id });
    const prod = (p.products || []).slice(0, 3).map(x => [x.item, x.grade, x.size].filter(Boolean).join(' ')).join('; ');
    const est = (p.products || []).reduce((a, x) => a + (/^(mt|ton|tons|tonne|tonnes|t)$/i.test(x.unit || '') ? Number(String(x.qty).replace(/[^\d.]/g, '')) || 0 : 0), 0);
    const notes = [p.last_summary, p.gstin && 'GSTIN ' + p.gstin, p.address, p.via_portal && 'Via ' + p.via_portal, `From ${p.mails} mail(s) to info@bharatsteels.in`].filter(Boolean).join('\n');
    const [{ id }] = await sql`INSERT INTO crm_leads (company, contact, phone, email, city, segment, product, est_mt, source, stage, owner_email, next_action_at, notes, created_by)
      VALUES (${p.company || p.contact || p.email || 'Unknown'}, ${p.contact}, ${phoneDigits(p.mobile || p.phone) || null}, ${p.email}, ${p.city}, ${null}, ${clean(prod, 120) || null},
        ${est || null}, ${p.via_portal || 'Email'}, 'new', ${clean(b.owner_email, 120).toLowerCase() || me.email}, ${new Date(Date.now() + 864e5 + 330 * 6e4).toISOString().slice(0, 10)}, ${notes}, ${me.email})
      RETURNING id`;
    await sql`UPDATE crm_mail_party SET lead_id = ${id}, updated_at = now() WHERE id = ${p.id}`;
    await audit(me.email, 'mail_party_lead', { party: p.id, lead: id });
    return send(res, 200, { ok: true, id });
  }

  if (b.action === 'enq_save') {
    const company = clean(b.company, 200), contact = clean(b.contact, 120), phone = phoneDigits(b.phone);
    if (!company) return send(res, 400, { error: 'Enter the company name' });
    if (!contact) return send(res, 400, { error: 'Enter the contact person' });
    if (phone.replace(/^(91|0)(?=\d{10}$)/, '').length < 10) return send(res, 400, { error: 'Enter a valid mobile number' });
    const gstin = clean(b.gstin, 15).toUpperCase() || null;
    if (gstin) { const e = gstinProblem(gstin); if (e) return send(res, 400, { error: e }); }
    const status = ENQ_STATUS.includes(b.status) ? b.status : 'new';
    if (status === 'lost' && !clean(b.lost_reason, 120)) return send(res, 400, { error: 'Pick why the enquiry was lost' });
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 30).map(x => ({ product: clean(x.product, 120), grade: clean(x.grade, 40), size: clean(x.size, 80),
      qty: Math.max(0, Number(x.qty) || 0), unit: ['MT', 'Kg', 'Nos', 'Sheets', 'Coils', 'Mtr'].includes(x.unit) ? x.unit : 'MT' })).filter(x => x.product);
    if (!items.length) return send(res, 400, { error: 'Add at least one product line' });
    const total = items.reduce((a, x) => a + (x.unit === 'MT' ? x.qty : x.unit === 'Kg' ? x.qty / 1000 : 0), 0);
    const staffKeys = (await sql`SELECT COALESCE(email, 'emp:' || lower(emp_code), 'uid:' || id) AS k FROM crm_users WHERE active AND role <> 'viewer'`).map(r => r.k);
    let owner = clean(b.owner_email, 120).toLowerCase() || me.email;
    if (!staffKeys.includes(owner)) return send(res, 400, { error: 'Pick the enquiry owner from the staff list' });
    const transferTo = clean(b.transfer_to, 120).toLowerCase();
    if (transferTo && !staffKeys.includes(transferTo)) return send(res, 400, { error: 'Pick who to transfer to from the staff list' });
    const v = { designation: clean(b.designation, 100) || null, email: clean(b.email, 160).toLowerCase() || null, address: clean(b.address, 400) || null,
      city: clean(b.city, 80) || null, state: clean(b.state, 60) || null, pincode: (String(b.pincode || '').match(/[1-9][0-9]{5}/) || [null])[0],
      source: ENQ_SOURCES.includes(b.source) ? b.source : 'Other', source_detail: clean(b.source_detail, 160) || null,
      required_by: dateOrNull(b.required_by), delivery_at: clean(b.delivery_at, 200) || null, remarks: cleanMulti(b.remarks, 4000) || null,
      quote: b.quote_value === '' || b.quote_value == null ? null : Math.max(0, Number(b.quote_value) || 0),
      lost: status === 'lost' ? clean(b.lost_reason, 120) : null, lead: Number(b.lead_id) || null, enq_date: dateOrNull(b.enq_date) };
    const chk = await sapCheck(sql, { company, gstin, phone, email: v.email, city: v.city, pincode: v.pincode });
    const card = chk.status === 'existing' ? chk.code : (clean(b.card_code, 40) || null);
    let id = Number(b.id) || null, prev = null, ref;
    if (id) {
      [prev] = await sql`SELECT owner_email, ref FROM crm_enquiries WHERE id = ${id}`;
      if (!prev) throw fail(404, 'Enquiry not found');
      ref = prev.ref;
      await sql`UPDATE crm_enquiries SET enq_date = COALESCE(${v.enq_date}::date, enq_date), company = ${company}, contact = ${contact}, designation = ${v.designation}, phone = ${phone}, email = ${v.email},
          gstin = ${gstin}, address = ${v.address}, city = ${v.city}, state = ${v.state}, pincode = ${v.pincode}, source = ${v.source}, source_detail = ${v.source_detail},
          items = ${JSON.stringify(items)}::jsonb, total_qty = ${total || null}, required_by = ${v.required_by}, delivery_at = ${v.delivery_at}, remarks = ${v.remarks},
          status = ${status}, quote_value = ${v.quote}, lost_reason = ${v.lost}, owner_email = ${owner}, card_code = ${card}, sap_status = ${chk.status},
          match_basis = ${chk.basis || null}, suggest_code = ${chk.code || chk.suggest || null}, lead_id = ${v.lead}, updated_at = now() WHERE id = ${id}`;
    } else {
      const yy = String(new Date(Date.now() + 330 * 6e4).getUTCFullYear()).slice(2);
      for (let attempt = 0; attempt < 3 && !id; attempt++) {
        const [{ n }] = await sql`SELECT COALESCE(MAX(substring(ref from 8)::int), 0) + 1 + ${attempt} AS n FROM crm_enquiries WHERE ref LIKE ${'ENQ-' + yy + '-%'}`;
        ref = `ENQ-${yy}-${String(n).padStart(4, '0')}`;
        try {
          [{ id }] = await sql`INSERT INTO crm_enquiries (ref, enq_date, company, contact, designation, phone, email, gstin, address, city, state, pincode, source, source_detail,
              items, total_qty, required_by, delivery_at, remarks, status, quote_value, lost_reason, owner_email, card_code, sap_status, match_basis, suggest_code, lead_id, created_by)
            VALUES (${ref}, COALESCE(${v.enq_date}::date, CURRENT_DATE), ${company}, ${contact}, ${v.designation}, ${phone}, ${v.email}, ${gstin}, ${v.address}, ${v.city}, ${v.state}, ${v.pincode},
              ${v.source}, ${v.source_detail}, ${JSON.stringify(items)}::jsonb, ${total || null}, ${v.required_by}, ${v.delivery_at}, ${v.remarks}, ${status}, ${v.quote}, ${v.lost},
              ${owner}, ${card}, ${chk.status}, ${chk.basis || null}, ${chk.code || chk.suggest || null}, ${v.lead}, ${me.email}) RETURNING id`;
        } catch (e) { if (!/duplicate key/.test(e.message)) throw e; }
      }
      if (!id) throw fail(500, 'Could not number the enquiry, please try again');
    }
    // first follow-up straight from the form
    const due = dateOrNull(b.follow_up_at);
    if (due) await sql`INSERT INTO crm_activities (enquiry_id, card_code, type, subject, follow_up_at, follow_up_ts, owner_email, created_by)
      VALUES (${id}, ${card}, 'call', ${clean(b.follow_up_note, 200) || 'Follow up on enquiry ' + ref}, ${due}, ${followTs(due, b.follow_up_time)}, ${transferTo || owner}, ${me.email})`;
    // tell the owner on WhatsApp when someone else gives them the enquiry
    const notes = [];
    const details = items.slice(0, 3).map(x => [x.product, x.grade, x.size, x.qty ? x.qty + ' ' + x.unit : ''].filter(Boolean).join(' ')).join('; ') + (items.length > 3 ? ` +${items.length - 3} more` : '');
    const tell = async (key, why) => {
      if (key === me.email) return;
      const [u] = await sql`SELECT name, mobile FROM crm_users WHERE COALESCE(email, 'emp:' || lower(emp_code), 'uid:' || id) = ${key}`;
      const r = u?.mobile ? await sendEnquiryAssigned(u.mobile, { name: (u.name || '').split(' ')[0], ref, company, details, by: me.name || me.email }) : { ok: false, message: 'No mobile number for ' + (u?.name || key) };
      notes.push({ why, to: u?.name || key, ok: r.ok, message: r.message });
    };
    if (transferTo && transferTo !== owner) {
      await sql`UPDATE crm_enquiries SET owner_email = ${transferTo}, transfers = transfers || ${JSON.stringify([{ from: owner, to: transferTo, by: me.email, at: new Date().toISOString(), note: clean(b.transfer_note, 300) || null }])}::jsonb WHERE id = ${id}`;
      await sql`UPDATE crm_activities SET owner_email = ${transferTo}, reminded_at = NULL, remind_result = NULL WHERE enquiry_id = ${id} AND NOT done`;
      await tell(transferTo, 'transfer');
      owner = transferTo;
    } else if (!prev ? owner !== me.email : prev.owner_email !== owner) {
      if (prev) {
        await sql`UPDATE crm_enquiries SET transfers = transfers || ${JSON.stringify([{ from: prev.owner_email, to: owner, by: me.email, at: new Date().toISOString() }])}::jsonb WHERE id = ${id}`;
        await sql`UPDATE crm_activities SET owner_email = ${owner}, reminded_at = NULL, remind_result = NULL WHERE enquiry_id = ${id} AND NOT done`;
      }
      await tell(owner, prev ? 'owner changed' : 'assigned');
    }
    await audit(me.email, 'enq_save', { id, ref, status, owner });
    return send(res, 200, { ok: true, id, ref, sap: chk, notified: notes });
  }
  if (b.action === 'enq_delete') {
    if (!isAdmin(me)) throw fail(403, 'Admins only');
    await sql`DELETE FROM crm_activities WHERE enquiry_id = ${Number(b.id)}`;
    await sql`DELETE FROM crm_enquiries WHERE id = ${Number(b.id)}`;
    await audit(me.email, 'enq_delete', { id: Number(b.id) });
    return send(res, 200, { ok: true });
  }
  if (b.action === 'lead_delete') {
    if (!isAdmin(me)) throw fail(403, 'Admins only');
    await sql`DELETE FROM crm_activities WHERE lead_id = ${Number(b.id)}`;
    await sql`DELETE FROM crm_leads WHERE id = ${Number(b.id)}`;
    return send(res, 200, { ok: true });
  }
  return send(res, 400, { error: 'Unknown action' });
});
