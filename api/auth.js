import { route, send, readBody, getSql, checkPassword, hashPassword, setSession, clearSession, currentUser, audit } from './_lib.js';

// POST {action: login | logout | me | change_password}
export default route(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const b = await readBody(req);
  const sql = getSql();

  if (b.action === 'login') {
    const email = String(b.email || '').trim().toLowerCase();
    const [u] = await sql`SELECT id, email, name, role, slp_code, pw_hash, active FROM crm_users WHERE email = ${email}`;
    if (!u || !u.active || !checkPassword(b.password || '', u.pw_hash)) return send(res, 401, { error: 'Wrong email or password' });
    setSession(req, res, u.id);
    await audit(u.email, 'login');
    return send(res, 200, { user: { id: u.id, email: u.email, name: u.name, role: u.role, slp_code: u.slp_code } });
  }
  if (b.action === 'logout') { clearSession(req, res); return send(res, 200, { ok: true }); }

  const me = await currentUser(req);
  if (b.action === 'me') return send(res, 200, { user: me, hub: process.env.GROUP_HUB_URL || 'https://app.thebharatsteelgroup.com', sso: !!process.env.GROUP_SSO_SECRET });
  if (!me) return send(res, 401, { error: 'Please sign in again' });

  if (b.action === 'change_password') {
    const [row] = await sql`SELECT pw_hash FROM crm_users WHERE id = ${me.id}`;
    if (!checkPassword(b.current || '', row.pw_hash)) return send(res, 400, { error: 'Current password is wrong' });
    if (String(b.next || '').length < 8) return send(res, 400, { error: 'New password must be at least 8 characters' });
    await sql`UPDATE crm_users SET pw_hash = ${hashPassword(b.next)} WHERE id = ${me.id}`;
    return send(res, 200, { ok: true });
  }
  return send(res, 400, { error: 'Unknown action' });
});
