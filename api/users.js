import { route, send, readBody, getSql, needUser, hashPassword, audit, loadConfig, DEFAULT_CFG, emailOk, clean, commonPassword, phoneDigits } from './_lib.js';

const ROLES = ['admin', 'sales', 'viewer'];

// POST {action: list | add | import | update | reset_password | delete | config | save_config | audit}   (admins)
const mobileOf = v => { const d = phoneDigits(v); return /^[6-9]\d{9}$/.test(d) ? d : null; };
const roleFor = (role, dept) => ROLES.includes(String(role || '').toLowerCase()) ? String(role).toLowerCase() : /management/i.test(dept || '') ? 'admin' : 'sales';
export default route(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const me = await needUser(req, { admin: true });
  const b = await readBody(req);
  const sql = getSql();

  if (b.action === 'list') {
    const users = await sql`SELECT id, email, name, role, slp_code, active, created_at, emp_code, mobile, designation, dept, must_change FROM crm_users ORDER BY active DESC, name, email`;
    const slps = await sql`SELECT slp_code, MAX(slp_name) AS slp_name, COUNT(*)::int AS customers FROM crm_customers
                           WHERE slp_code IS NOT NULL GROUP BY slp_code ORDER BY MAX(slp_name)`;
    return send(res, 200, { users, slps });
  }
  if (b.action === 'add') {
    const email = String(b.email || '').trim().toLowerCase() || null;
    const emp = clean(b.emp_code, 30).toUpperCase() || null;
    if (email && !emailOk(email)) return send(res, 400, { error: 'Enter a valid email' });
    if (!email && !emp) return send(res, 400, { error: 'Enter an email or an employee code (used to sign in)' });
    const mobile = b.mobile ? mobileOf(b.mobile) : null;
    if (b.mobile && !mobile) return send(res, 400, { error: 'Mobile must be a 10-digit Indian number' });
    const rows = await sql`INSERT INTO crm_users (email, emp_code, mobile, name, designation, dept, role, slp_code, pw_hash, must_change)
      VALUES (${email}, ${emp}, ${mobile}, ${clean(b.name, 80)}, ${clean(b.designation, 80) || null}, ${clean(b.dept, 40) || null},
              ${roleFor(b.role, b.dept)}, ${b.slp_code ? Number(b.slp_code) : null}, ${hashPassword(commonPassword())}, true)
      ON CONFLICT DO NOTHING RETURNING id`;
    if (!rows.length) return send(res, 400, { error: 'That email or employee code already has an account' });
    await audit(me.email, 'user_add', { email, emp });
    return send(res, 200, { ok: true, password: commonPassword() });
  }
  if (b.action === 'import') {
    // Rows pasted from Excel: Emp No | Name | Designation | Dept | Mobile [| Email] [| Role]. Existing employee codes are updated.
    let added = 0, updated = 0; const problems = [];
    for (const r of (Array.isArray(b.rows) ? b.rows : []).slice(0, 500)) {
      const emp = clean(r.emp_code, 30).toUpperCase(), name = clean(r.name, 80);
      if (!emp || !name) { problems.push(`Skipped a row without Emp No / Name (${emp || name || 'blank'})`); continue; }
      const mobile = r.mobile ? mobileOf(r.mobile) : null;
      if (r.mobile && !mobile) problems.push(`${emp}: mobile "${r.mobile}" is not a 10-digit Indian number — saved without mobile`);
      const email = String(r.email || '').trim().toLowerCase();
      const em = email && emailOk(email) ? email : null;
      const [ex] = await sql`SELECT id FROM crm_users WHERE upper(emp_code) = ${emp} OR (${!!em} AND lower(email) = ${em || ''}) LIMIT 1`;
      if (ex) {
        await sql`UPDATE crm_users SET emp_code = ${emp}, name = ${name}, designation = ${clean(r.designation, 80) || null}, dept = ${clean(r.dept, 40) || null},
                  mobile = COALESCE(${mobile}, mobile), email = COALESCE(email, ${em}) WHERE id = ${ex.id}`;
        updated++;
      } else {
        await sql`INSERT INTO crm_users (email, emp_code, mobile, name, designation, dept, role, pw_hash, must_change)
                  VALUES (${em}, ${emp}, ${mobile}, ${name}, ${clean(r.designation, 80) || null}, ${clean(r.dept, 40) || null},
                          ${roleFor(r.role, r.dept)}, ${hashPassword(commonPassword())}, true)`;
        added++;
      }
    }
    await audit(me.email, 'user_import', { added, updated });
    return send(res, 200, { ok: true, added, updated, problems, password: commonPassword() });
  }
  if (b.action === 'update') {
    const id = Number(b.id);
    if (id === me.id && (b.role !== 'admin' || b.active === false)) return send(res, 400, { error: 'You cannot remove your own admin access' });
    const mobile = b.mobile === undefined ? undefined : (b.mobile ? mobileOf(b.mobile) : null);
    if (b.mobile && !mobile) return send(res, 400, { error: 'Mobile must be a 10-digit Indian number' });
    await sql`UPDATE crm_users SET name = ${clean(b.name, 80)}, role = ${ROLES.includes(b.role) ? b.role : 'sales'},
              slp_code = ${b.slp_code ? Number(b.slp_code) : null}, active = ${b.active !== false} WHERE id = ${id}`;
    if (mobile !== undefined) await sql`UPDATE crm_users SET mobile = ${mobile} WHERE id = ${id}`;
    await audit(me.email, 'user_update', { id, role: b.role, active: b.active !== false });
    return send(res, 200, { ok: true });
  }
  if (b.action === 'reset_password') {
    await sql`UPDATE crm_users SET pw_hash = ${hashPassword(commonPassword())}, must_change = true WHERE id = ${Number(b.id)}`;
    await audit(me.email, 'user_reset', { id: Number(b.id) });
    return send(res, 200, { ok: true, password: commonPassword() });
  }
  if (b.action === 'delete') {
    if (Number(b.id) === me.id) return send(res, 400, { error: 'You cannot delete yourself' });
    await sql`DELETE FROM crm_users WHERE id = ${Number(b.id)}`;
    await audit(me.email, 'user_delete', { id: Number(b.id) });
    return send(res, 200, { ok: true });
  }
  if (b.action === 'config') return send(res, 200, { config: await loadConfig() });
  if (b.action === 'save_config') {
    const cur = await loadConfig();
    const c = b.config || {};
    const list = (v, d) => Array.isArray(v) ? v.map(x => clean(x, 80)).filter(Boolean).slice(0, 40) : d;
    const next = {
      ...cur,
      discountPerTon: Math.max(0, Number(c.discountPerTon ?? cur.discountPerTon) || 0),
      lowScore: Math.min(4, Math.max(1, Number(c.lowScore ?? cur.lowScore) || 2)),
      dormantDays: Math.min(730, Math.max(30, Number(c.dormantDays ?? cur.dormantDays) || 90)),
      kycOpen: c.kycOpen !== false, feedbackOpen: c.feedbackOpen !== false,
      leadSources: list(c.leadSources, cur.leadSources || DEFAULT_CFG.leadSources),
      products: list(c.products, cur.products || DEFAULT_CFG.products),
      lostReasons: list(c.lostReasons, cur.lostReasons || DEFAULT_CFG.lostReasons)
    };
    await sql`UPDATE crm_config SET data = ${JSON.stringify(next)}::jsonb, updated_at = now(), updated_by = ${me.email} WHERE id = 1`;
    await audit(me.email, 'settings', {});
    return send(res, 200, { ok: true, config: next });
  }
  if (b.action === 'audit') {
    const rows = await sql`SELECT who, action, detail, at FROM crm_audit ORDER BY id DESC LIMIT 300`;
    return send(res, 200, { rows });
  }
  return send(res, 400, { error: 'Unknown action' });
});
