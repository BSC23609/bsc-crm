// Vercel Blob (private file storage for ledger documents)
export const blobAccess = () => (process.env.BLOB_ACCESS === 'public' ? 'public' : 'private');
// Two ways Vercel connects a Blob store: a read-write token, or (newer) BLOB_STORE_ID + the project's OIDC token.
export const blobMode = () => process.env.BLOB_READ_WRITE_TOKEN ? 'token' : (process.env.BLOB_STORE_ID ? 'presigned' : null);
export const blobReady = () => !!blobMode();
