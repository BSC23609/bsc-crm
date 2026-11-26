import { handleUpload, handleUploadPresigned } from '@vercel/blob/client';
import { issueSignedToken } from '@vercel/blob';
import { route, send, readBody, getSql, currentUser, canEdit } from './_lib.js';
import { blobReady, blobMode } from './_blob.js';

// Paths:  kyc/<id>/<draftKey>/<file>  (customer filling the public form)   kyc/<id>/staff/<file>  (signed-in staff)
const PATH_RE = /^kyc\/(\d{1,9})\/(staff|[A-Za-z0-9_-]{12,40})\/[^/]{1,160}$/;
const MAX = 15 * 1024 * 1024;

async function allowed(req, pathname) {
  const m = PATH_RE.exec(pathname);
  if (!m) throw new Error('Bad file path');
  const [, id, key] = m;
  if (key === 'staff') {
    const me = await currentUser(req);
    if (!canEdit(me)) throw new Error('Please sign in');
    return;
  }
  const [r] = await getSql()`SELECT id FROM crm_kyc WHERE id = ${Number(id)} AND draft_key = ${key} AND status IN ('draft','invited')`;
  if (!r) throw new Error('Form session expired — please reload the page');
}

export default route(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  if (!blobReady()) return send(res, 503, { error: 'File storage is not connected yet. In Vercel: Storage → Create → Blob (Private) → connect it to this project, then redeploy.' });
  const body = await readBody(req);
  if (blobMode() === 'presigned') {
    const json = await handleUploadPresigned({
      body, request: req,
      getSignedToken: async pathname => {
        await allowed(req, pathname);
        const token = await issueSignedToken({ pathname, operations: ['put'], validUntil: Date.now() + 30 * 60 * 1000, maximumSizeInBytes: MAX });
        return { token, urlOptions: { addRandomSuffix: true, maximumSizeInBytes: MAX } };
      }
    });
    return send(res, 200, json);
  }
  const json = await handleUpload({
    body, request: req,
    onBeforeGenerateToken: async pathname => {
      await allowed(req, pathname);
      return { maximumSizeInBytes: MAX, addRandomSuffix: true,
               allowedContentTypes: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] };
    }
  });
  return send(res, 200, json);
});
