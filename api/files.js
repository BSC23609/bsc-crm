import { Readable } from 'node:stream';
import { del, get, issueSignedToken, presignUrl } from '@vercel/blob';
import { route, send, readBody, getSql, currentUser, canEdit, query, KYC_DOCS } from './_lib.js';
import { blobAccess } from './_blob.js';
import { qrPng, appUrl } from './_notify.js';

async function openFile(req, res) {
  const id = Number(query(req).get('id'));
  const [f] = await getSql()`SELECT * FROM crm_files WHERE id = ${id}`;
  if (!f) return send(res, 404, { error: 'File not found' });
  if (!f.pathname || blobAccess() === 'public') { res.statusCode = 302; res.setHeader('Location', f.url); return res.end(); }
  try {
    const tok = await issueSignedToken({ pathname: f.pathname, operations: ['get'], validUntil: Date.now() + 10 * 60 * 1000 });
    const { presignedUrl } = await presignUrl(tok, { operation: 'get', pathname: f.pathname, access: 'private' });
    res.statusCode = 302; res.setHeader('Location', presignedUrl); res.setHeader('Cache-Control', 'no-store'); return res.end();
  } catch (e) { console.warn('presign failed, streaming instead:', e.message); }
  const r = await get(f.pathname, { access: 'private' });
  if (!r || r.statusCode !== 200) return send(res, 404, { error: 'File not found in storage' });
  res.statusCode = 200;
  res.setHeader('Content-Type', r.blob.contentType || f.content_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  Readable.fromWeb(r.stream).pipe(res);
}

// GET ?id= open (staff).  POST {action: register | delete}  — public form (with its draft key) or staff.
export default route(async (req, res) => {
  const sql = getSql();
  const me = await currentUser(req);
  if (req.method === 'GET' && query(req).get('qr')) {
    // Public QR image of a personal ledger-form link (used as the WhatsApp message picture). Only while the link is open.
    const t = String(query(req).get('qr')).replace(/\.png$/i, '');
    if (t === 'feedback') {   // feedback form QR (optionally for one invoice: /qr/feedback.png?inv=...)
      const inv = String(query(req).get('inv') || '').slice(0, 40);
      const png = await qrPng(`${appUrl()}/feedback${inv ? '?inv=' + encodeURIComponent(inv) : ''}`);
      res.statusCode = 200; res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'public, max-age=3600'); return res.end(png);
    }
    const [r] = t ? await sql`SELECT token FROM crm_kyc WHERE token = ${t} AND status = 'invited'` : [];
    // Unknown, used or sample token (e.g. WATI checking the template URL): the QR of the public form instead.
    const png = await qrPng(r ? `${appUrl()}/kyc?t=${r.token}` : `${appUrl()}/kyc`);
    res.statusCode = 200; res.setHeader('Content-Type', 'image/png'); res.setHeader('Content-Length', png.length);
    res.setHeader('Cache-Control', r ? 'public, max-age=86400' : 'no-store'); return res.end(png);
  }
  if (req.method === 'GET') { if (!me) return send(res, 401, { error: 'Please sign in' }); return openFile(req, res); }
  if (req.method !== 'POST') return send(res, 405, { error: 'GET or POST only' });
  const b = await readBody(req);
  const id = Number(b.ref);
  const staff = canEdit(me);
  if (!staff) {
    const [r] = await sql`SELECT id FROM crm_kyc WHERE id = ${id} AND draft_key = ${String(b.key || '#')} AND status IN ('draft','invited')`;
    if (!r) return send(res, 403, { error: 'Form session expired — please reload the page' });
  }
  if (b.action === 'register') {
    if (!KYC_DOCS[b.docType]) return send(res, 400, { error: 'Unknown document' });
    let host = ''; try { host = new URL(b.url).hostname; } catch { /* bad */ }
    const prefix = `kyc/${id}/${staff && !b.key ? 'staff' : b.key}/`;
    if (!host.endsWith('.blob.vercel-storage.com') || !String(b.pathname || '').startsWith(prefix)) return send(res, 400, { error: 'Bad file location' });
    if (!staff) {   // the public form keeps one file per document type: replace the previous one
      const old = await sql`DELETE FROM crm_files WHERE kind = 'kyc' AND ref = ${String(id)} AND doc_type = ${b.docType} RETURNING url`;
      for (const o of old) { try { await del(o.url); } catch { /* ignore */ } }
    }
    const [r] = await sql`INSERT INTO crm_files (kind, ref, doc_type, name, size, content_type, url, pathname, uploaded_by)
      VALUES ('kyc', ${String(id)}, ${b.docType}, ${String(b.name || 'file').slice(0, 160)}, ${Math.max(0, Number(b.size) || 0)}, ${String(b.type || '').slice(0, 80)},
              ${b.url}, ${b.pathname}, ${me?.email || 'customer'}) RETURNING id`;
    return send(res, 200, { ok: true, id: r.id });
  }
  if (b.action === 'delete') {
    const [f] = await sql`SELECT id, url, pathname FROM crm_files WHERE id = ${Number(b.id)} AND kind = 'kyc' AND ref = ${String(id)}`;
    if (!f) return send(res, 200, { ok: true });
    if (f.pathname) { try { await del(f.url); } catch (e) { console.warn('blob delete failed:', e.message); } }
    await sql`DELETE FROM crm_files WHERE id = ${f.id}`;
    return send(res, 200, { ok: true });
  }
  return send(res, 400, { error: 'Unknown action' });
});
