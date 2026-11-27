import crypto from 'node:crypto';
import { route, send, readBody, getSql, checkPassword, hashPassword, setSession, clearSession, currentUser, audit, findUser, passwordProblem } from './_lib.js';
import { sendOtpWhatsApp, whatsappReady } from './_notify.js';

const pub = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, slp_code: u.slp_code, emp_code: u.emp_code, mobile: u.mobile || '', must_change: !!u.must_change });
const codeHash = (id, code) => crypto.createHmac('sha256', String(process.env.SESSION_SECRET || '')).update(`${id}:${code}`).digest('hex');
const maskMobile = m => (m ? `+91 ••••• ${String(m).slice(-4)}` : '');

// POST {action: login | logout | me | change_password | forgot | reset}
export default route(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const b = await readBody(req);
  const sql = getSql();

  if (b.action === 'login') {   // email, employee code (BSC/017) or mobile number
    const u = await findUser(b.email);
    if (!u || !u.active || !checkPassword(b.password || '', u.pw_hash)) return send(res, 401, { error: 'Wrong login or password' });
    setSession(req, res, u.id);
    await audit(u.email || u.emp_code, 'login');
    return send(res, 200, { user: pub(u) });
  }
  if (b.action === 'logout') { clearSession(req, res); return send(res, 200, { ok: true }); }

  // Forgot password: a 6-digit code by WhatsApp (template otp_password2), valid 10 minutes, 5 tries.
  if (b.action === 'forgot') {
    if (!whatsappReady()) return send(res, 503, { error: 'Password reset by WhatsApp is not set up yet. Ask an admin to reset your password.' });
    const u = await findUser(b.id);
    if (!u || !u.active || !u.mobile) return send(res, 400, { error: 'No active account with a mobile number found for that email, employee code or mobile. Ask an admin.' });
    if (u.reset_sent_at && Date.now() - new Date(u.reset_sent_at).getTime() < 60000) return send(res, 429, { error: 'A code was just sent. Wait a minute before asking again.' });
    const code = String(crypto.randomInt(100000, 1000000));
    const r = await sendOtpWhatsApp(u.mobile, code);
    if (!r.ok) return send(res, 502, { error: r.message });
    await sql`UPDATE crm_users SET reset_hash = ${codeHash(u.id, code)}, reset_expires = now() + interval '10 minutes', reset_tries = 0, reset_sent_at = now() WHERE id = ${u.id}`;
    await audit(u.email || u.emp_code, 'reset_code_sent');
    return send(res, 200, { ok: true, to: maskMobile(u.mobile) });
  }
  if (b.action === 'reset') {
    const u = await findUser(b.id);
    if (!u || !u.reset_hash || !u.reset_expires || new Date(u.reset_expires) < new Date()) return send(res, 400, { error: 'The code has expired. Ask for a new one.' });
    if (u.reset_tries >= 5) return send(res, 400, { error: 'Too many wrong codes. Ask for a new one.' });
    const ok = crypto.timingSafeEqual(Buffer.from(codeHash(u.id, String(b.code || '').trim())), Buffer.from(u.reset_hash));
    if (!ok) { await sql`UPDATE crm_users SET reset_tries = reset_tries + 1 WHERE id = ${u.id}`; return send(res, 400, { error: 'Wrong code' }); }
    const p = passwordProblem(b.password); if (p) return send(res, 400, { error: p });
    await sql`UPDATE crm_users SET pw_hash = ${hashPassword(b.password)}, must_change = false, reset_hash = NULL, reset_expires = NULL, reset_tries = 0 WHERE id = ${u.id}`;
    setSession(req, res, u.id);
    await audit(u.email || u.emp_code, 'password_reset');
    return send(res, 200, { ok: true, user: pub({ ...u, must_change: false }) });
  }

  const me = await currentUser(req);
  if (b.action === 'me') return send(res, 200, { user: me ? pub(me) : null, hub: process.env.GROUP_HUB_URL || 'https://app.thebharatsteelgroup.com', sso: !!process.env.GROUP_SSO_SECRET, forgot: whatsappReady() });
  if (!me) return send(res, 401, { error: 'Please sign in again' });

  if (b.action === 'change_password') {
    const [row] = await sql`SELECT pw_hash FROM crm_users WHERE id = ${me.id}`;
    if (!checkPassword(b.current || '', row.pw_hash)) return send(res, 400, { error: 'Current password is wrong' });
    const p = passwordProblem(b.next); if (p) return send(res, 400, { error: p });
    await sql`UPDATE crm_users SET pw_hash = ${hashPassword(b.next)}, must_change = false WHERE id = ${me.id}`;
    return send(res, 200, { ok: true });
  }
  return send(res, 400, { error: 'Unknown action' });
});
