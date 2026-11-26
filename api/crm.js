// Activities & follow-ups, leads pipeline, dashboard.
import { route, send, readBody, getSql, needUser, audit, loadConfig, fail, clean, cleanMulti, phoneDigits, canEdit, isAdmin, gstinProblem, SEGMENTS, BUYER_TYPES, USAGE, REG_TYPES } from './_lib.js';
import { sapStatus, summary } from './_sap.js';
import { emailReady, whatsappReady, appUrl } from './_notify.js';
import { runMailSync, mailStatus } from './_mail.js';

const TYPES = ['call', 'visit', 'whatsapp', 'email', 'meeting', 'complaint', 'note'];
const STAGES = ['new', 'contacted', 'quoted', 'negotiation', 'won', 'lost'];
const dateOrNull = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);

export default route(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const me = await needUser(req);
  const b = await readBody(req);
  const sql = getSql();

  if (b.action === 'meta') {   // lists the screens need
    const cfg = await loadConfig();
    const staff = await sql`SELECT email, name, role FROM crm_users WHERE active AND role <> 'viewer' ORDER BY name, email`;
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
      const rows = await sql`SELECT a.*, c.name AS customer, l.company AS lead_company FROM crm_activities a
          LEFT JOIN crm_customers c ON c.card_code = a.card_code LEFT JOIN crm_leads l ON l.id = a.lead_id
          WHERE NOT a.done AND a.follow_up_at IS NOT NULL AND (${!b.mine} OR a.owner_email = ${me.email} OR a.created_by = ${me.email})
          ORDER BY a.follow_up_at, a.id LIMIT 1000`;
      return send(res, 200, { rows });
    }
    const rows = await sql`SELECT a.*, c.name AS customer, l.company AS lead_company FROM crm_activities a
        LEFT JOIN crm_customers c ON c.card_code = a.card_code LEFT JOIN crm_leads l ON l.id = a.lead_id
        WHERE (${!b.lead_id} OR a.lead_id = ${Number(b.lead_id) || 0}) ORDER BY a.created_at DESC LIMIT 500`;
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
    const rows = await sql`SELECT email, name, role FROM crm_users WHERE active AND role <> 'viewer' ORDER BY name, email`;
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

  if (!canEdit(me)) throw fail(403, 'You have view-only access');

  if (b.action === 'activity_save') {
    const type = TYPES.includes(b.type) ? b.type : 'note';
    const card = clean(b.card_code, 40) || null, lead = b.lead_id ? Number(b.lead_id) : null;
    if (!card && !lead) return send(res, 400, { error: 'Pick a customer or a lead' });
    const subject = clean(b.subject, 200);
    if (!subject) return send(res, 400, { error: 'Write a short subject' });
    const vals = { notes: cleanMulti(b.notes, 4000) || null, due: dateOrNull(b.follow_up_at), owner: clean(b.owner_email, 120).toLowerCase() || me.email };
    let id = Number(b.id) || null;
    if (id) {
      await sql`UPDATE crm_activities SET type = ${type}, subject = ${subject}, notes = ${vals.notes}, follow_up_at = ${vals.due},
                owner_email = ${vals.owner}, done = ${!!b.done}, updated_at = now() WHERE id = ${id}`;
    } else {
      [{ id }] = await sql`INSERT INTO crm_activities (card_code, lead_id, type, subject, notes, follow_up_at, owner_email, done, created_by)
        VALUES (${card}, ${lead}, ${type}, ${subject}, ${vals.notes}, ${vals.due}, ${vals.owner}, ${!!b.done}, ${me.email}) RETURNING id`;
      if (lead) await sql`UPDATE crm_leads SET updated_at = now(), stage = CASE WHEN stage = 'new' THEN 'contacted' ELSE stage END WHERE id = ${lead}`;
    }
    return send(res, 200, { ok: true, id });
  }
  if (b.action === 'activity_done') {
    await sql`UPDATE crm_activities SET done = ${b.done !== false}, updated_at = now() WHERE id = ${Number(b.id)}`;
    // Rescheduling: mark done and open the next follow-up in one go
    if (b.next_at && dateOrNull(b.next_at)) {
      const [a] = await sql`SELECT * FROM crm_activities WHERE id = ${Number(b.id)}`;
      await sql`INSERT INTO crm_activities (card_code, lead_id, type, subject, notes, follow_up_at, owner_email, created_by)
        VALUES (${a.card_code}, ${a.lead_id}, ${a.type}, ${a.subject}, ${cleanMulti(b.note, 2000) || null}, ${b.next_at}, ${a.owner_email}, ${me.email})`;
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
      next: dateOrNull(b.next_action_at), notes: cleanMulti(b.notes, 4000) || null, card: clean(b.card_code, 40) || null
    };
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
    await audit(me.email, 'lead_save', { id, stage });
    return send(res, 200, { ok: true, id });
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
  if (b.action === 'lead_delete') {
    if (!isAdmin(me)) throw fail(403, 'Admins only');
    await sql`DELETE FROM crm_activities WHERE lead_id = ${Number(b.id)}`;
    await sql`DELETE FROM crm_leads WHERE id = ${Number(b.id)}`;
    return send(res, 200, { ok: true });
  }
  return send(res, 400, { error: 'Unknown action' });
});
