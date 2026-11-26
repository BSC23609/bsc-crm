import { route, send, readBody, getSql, needUser, query, audit, clean, cleanMulti, SEGMENTS, BUYER_TYPES, USAGE, REG_TYPES } from './_lib.js';
import { sapStatus, customer360, moreRows } from './_sap.js';

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
    return send(res, 400, { error: 'Unknown action' });
  }

  const me = await needUser(req);
  const q = query(req);

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
    return send(res, 200, { cached, live, sap, profile: profile || null, kyc, feedback, activities, leads, related });
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
