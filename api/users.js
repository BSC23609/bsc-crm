import { route, send, readBody, getSql, needUser, hashPassword, randomToken, audit, loadConfig, DEFAULT_CFG, emailOk, clean } from './_lib.js';

const ROLES = ['admin', 'sales', 'viewer'];

// POST {action: list | add | update | reset_password | delete | config | save_config | audit}   (admins)
export default route(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const me = await needUser(req, { admin: true });
  const b = await readBody(req);
  const sql = getSql();

  if (b.action === 'list') {
    const users = await sql`SELECT id, email, name, role, slp_code, active, created_at FROM crm_users ORDER BY active DESC, name, email`;
    const slps = await sql`SELECT slp_code, MAX(slp_name) AS slp_name, COUNT(*)::int AS customers FROM crm_customers
                           WHERE slp_code IS NOT NULL GROUP BY slp_code ORDER BY MAX(slp_name)`;
    return send(res, 200, { users, slps });
  }
  if (b.action === 'add') {
    const email = String(b.email || '').trim().toLowerCase();
    if (!emailOk(email)) return send(res, 400, { error: 'Enter a valid email' });
    const role = ROLES.includes(b.role) ? b.role : 'sales';
    const pw = String(b.password || '') || randomToken(9);
    if (pw.length < 8) return send(res, 400, { error: 'Password must be at least 8 characters' });
    const rows = await sql`INSERT INTO crm_users (email, name, role, slp_code, pw_hash)
      VALUES (${email}, ${clean(b.name, 80)}, ${role}, ${b.slp_code ? Number(b.slp_code) : null}, ${hashPassword(pw)})
      ON CONFLICT (email) DO NOTHING RETURNING id`;
    if (!rows.length) return send(res, 400, { error: 'That email already has an account' });
    await audit(me.email, 'user_add', { email, role });
    return send(res, 200, { ok: true, password: b.password ? null : pw });
  }
  if (b.action === 'update') {
    const id = Number(b.id);
    if (id === me.id && (b.role !== 'admin' || b.active === false)) return send(res, 400, { error: 'You cannot remove your own admin access' });
    await sql`UPDATE crm_users SET name = ${clean(b.name, 80)}, role = ${ROLES.includes(b.role) ? b.role : 'sales'},
              slp_code = ${b.slp_code ? Number(b.slp_code) : null}, active = ${b.active !== false} WHERE id = ${id}`;
    await audit(me.email, 'user_update', { id, role: b.role, active: b.active !== false });
    return send(res, 200, { ok: true });
  }
  if (b.action === 'reset_password') {
    const pw = randomToken(9);
    await sql`UPDATE crm_users SET pw_hash = ${hashPassword(pw)} WHERE id = ${Number(b.id)}`;
    await audit(me.email, 'user_reset', { id: Number(b.id) });
    return send(res, 200, { ok: true, password: pw });
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
