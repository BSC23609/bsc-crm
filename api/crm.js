// Activities & follow-ups, leads pipeline, dashboard.
import { route, send, readBody, getSql, needUser, audit, loadConfig, fail, clean, cleanMulti, phoneDigits, canEdit, isAdmin, SEGMENTS, BUYER_TYPES, USAGE, REG_TYPES } from './_lib.js';
import { sapStatus, summary } from './_sap.js';
import { emailReady, whatsappReady } from './_notify.js';

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
      dormantDays: cfg.dormantDays, lowScore: cfg.lowScore, staff, sapConnected: (await sapStatus()).connected, emailReady: emailReady(), whatsappReady: whatsappReady() });
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
  if (b.action === 'lead_delete') {
    if (!isAdmin(me)) throw fail(403, 'Admins only');
    await sql`DELETE FROM crm_activities WHERE lead_id = ${Number(b.id)}`;
    await sql`DELETE FROM crm_leads WHERE id = ${Number(b.id)}`;
    return send(res, 200, { ok: true });
  }
  return send(res, 400, { error: 'Unknown action' });
});
