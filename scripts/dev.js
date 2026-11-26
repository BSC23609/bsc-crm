// Local test server: serves public/ and the api/ routes against a local Postgres (not used on Vercel).
//   DATABASE_URL_LOCAL=postgres://postgres@localhost:5433/crm SESSION_SECRET=... node scripts/dev.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { setSql } from '../api/_lib.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_LOCAL });
// Same calling style as the Neon driver: sql`...` and sql.query(text, params)
const sql = (strings, ...vals) => pool.query(strings.reduce((a, s, i) => a + '$' + i + s), vals).then(r => r.rows);
sql.query = (text, params) => pool.query(text, params).then(r => r.rows);
setSql(sql);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
const rewrites = Object.fromEntries((vercel.rewrites || []).map(r => [r.source, r.destination]));

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = rewrites[url.pathname] || url.pathname;
  if (p.startsWith('/qr/')) { req.url = '/api/files?qr=' + p.slice(4) + (url.search ? '&' + url.search.slice(1) : ''); p = '/api/files'; }
  if (p.startsWith('/api/')) {
    const name = p.slice(5).split('?')[0].replace(/[^a-z_-]/g, '');
    try {
      const mod = await import(path.join(root, 'api', name + '.js'));
      req.headers['x-forwarded-proto'] = 'http';
      return mod.default(req, res);
    } catch (e) { res.statusCode = 404; return res.end('no route ' + name); }
  }
  if (p === '/') p = '/index.html';
  const file = path.join(root, 'public', path.normalize(p));
  const tryFiles = [file, file + '.html'];
  for (const f of tryFiles) if (f.startsWith(path.join(root, 'public')) && fs.existsSync(f) && fs.statSync(f).isFile()) {
    res.setHeader('Content-Type', TYPES[path.extname(f)] || 'application/octet-stream');
    return fs.createReadStream(f).pipe(res);
  }
  res.statusCode = 404; res.end('not found');
}).listen(Number(process.env.PORT || 3000), () => console.log('dev on http://localhost:' + (process.env.PORT || 3000)));
