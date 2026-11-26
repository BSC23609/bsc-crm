// ?job=mail  -> read new mail from info@bharatsteels.in (see _mail.js)
// Daily clean-up of abandoned ledger-form drafts (and their uploaded files). Called by Vercel Cron.
//   GET /api/cron   header  Authorization: Bearer <CRON_SECRET>   (Vercel adds it automatically)
import { del } from '@vercel/blob';
import { route, send, getSql, query } from './_lib.js';
import { runMailSync } from './_mail.js';
import { waitUntil } from '@vercel/functions';

export default route(async (req, res) => {
  const want = process.env.CRON_SECRET || '';
  if (!want || req.headers.authorization !== `Bearer ${want}`) return send(res, 401, { error: 'bad cron secret' });
  // Mailbox reader: called every 15 minutes by an external cron job (cron-job.org / Task Scheduler).
  // Answers at once and keeps reading in the background (up to ~4 min), so short cron timeouts are fine.
  // Add &wait=1 to wait for the result instead.
  if (query(req).get('job') === 'mail') {
    const run = runMailSync({ budgetMs: 240000, who: 'schedule' });
    if (query(req).get('wait')) return send(res, 200, await run);
    waitUntil(run.catch(() => {}));
    return send(res, 202, { ok: true, started: true, note: 'Reading mail in the background; see the Mail tab for the result' });
  }
  const sql = getSql();
  const stale = await sql`SELECT id FROM crm_kyc WHERE status = 'draft' AND created_at < now() - interval '3 days'`;
  for (const { id } of stale) {
    const files = await sql`SELECT url, pathname FROM crm_files WHERE kind = 'kyc' AND ref = ${String(id)}`;
    for (const f of files) if (f.pathname) { try { await del(f.url); } catch { /* ignore */ } }
    await sql`DELETE FROM crm_files WHERE kind = 'kyc' AND ref = ${String(id)}`;
    await sql`DELETE FROM crm_kyc WHERE id = ${id}`;
  }
  return send(res, 200, { ok: true, draftsRemoved: stale.length });
});
