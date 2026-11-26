/* Customer CRM — Bharat Steel (Chennai) Pvt. Ltd.   Single-page app, no build step. */
'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = { me: null, meta: null, customers: null, sync: null, cache: {} };

/* ---------------- formatting ---------------- */
const num = v => Number(v) || 0;
const inr = v => '₹' + Math.round(num(v)).toLocaleString('en-IN');
function inrShort(v) {
  v = num(v); const a = Math.abs(v), s = v < 0 ? '-' : '';
  if (a >= 1e7) return s + '₹' + (a / 1e7).toFixed(a >= 1e9 ? 0 : 2) + ' Cr';
  if (a >= 1e5) return s + '₹' + (a / 1e5).toFixed(a >= 1e7 ? 0 : 1) + ' L';
  if (a >= 1e3) return s + '₹' + (a / 1e3).toFixed(0) + 'K';
  return s + '₹' + Math.round(a);
}
const mt = v => (v == null || v === '' ? '—' : num(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }) + ' MT');
const d10 = v => (v ? String(v).slice(0, 10) : '');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fdate(v) { const s = d10(v); if (!s) return '—'; const [y, m, d] = s.split('-'); return `${+d} ${MON[+m - 1]} ${y}`; }
function fdt(v) { if (!v) return '—'; const d = new Date(v); return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }); }
const ym = m => { const [y, mo] = String(m).split('-'); return MON[+mo - 1] + ' ' + y.slice(2); };
const today = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);   // IST date
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysSince = v => (v ? Math.floor((Date.parse(today()) - Date.parse(d10(v))) / 864e5) : null);
const canEdit = () => S.me && (S.me.role === 'admin' || S.me.role === 'sales');
const isAdmin = () => S.me && S.me.role === 'admin';
const waLink = (phone, text) => { let p = String(phone || '').replace(/\D/g, ''); if (p.length === 10) p = '91' + p; return `https://wa.me/${p}?text=${encodeURIComponent(text)}`; };
// Public address used in every link given to customers (APP_URL, default https://crm.bharatsteels.in)
const origin = () => (S.meta && S.meta.appUrl) || 'https://crm.bharatsteels.in';

/* ---------------- api / ui helpers ---------------- */
async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && !path.includes('/api/auth')) { showLogin(); throw new Error('Please sign in'); }
  if (!r.ok) { const e = new Error(d.error || 'Request failed'); e.data = d; throw e; }
  return d;
}
let toastT;
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), 3200); }
function modal(html, cls = '') {
  $('#modalRoot').innerHTML = `<div class="modal-bg" id="mbg"><div class="modal ${cls}">${html}</div></div>`;
  $('#mbg').addEventListener('mousedown', e => { if (e.target.id === 'mbg') closeModal(); });
  return $('#modalRoot .modal');
}
const closeModal = () => { $('#modalRoot').innerHTML = ''; };
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
const loading = () => { $('#main').innerHTML = '<div class="empty">Loading…</div>'; };
const opts = (list, cur, blank = '') => (blank !== null ? `<option value="">${esc(blank)}</option>` : '') + list.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(v) === String(cur ?? '') ? 'selected' : ''}>${esc(l)}</option>`; }).join('');
function copy(text) { navigator.clipboard.writeText(text).then(() => toast('Copied'), () => prompt('Copy this:', text)); }

/* tooltip for any element with data-tip */
document.addEventListener('mouseover', e => {
  const el = e.target.closest('[data-tip]'); const tip = $('#tip');
  if (!el) { tip.classList.add('hidden'); return; }
  tip.innerHTML = el.dataset.tip; tip.classList.remove('hidden');
});
document.addEventListener('mousemove', e => {
  const tip = $('#tip'); if (tip.classList.contains('hidden')) return;
  const w = tip.offsetWidth, x = e.clientX + 14 + w > innerWidth ? e.clientX - w - 14 : e.clientX + 14;
  tip.style.left = x + 'px'; tip.style.top = (e.clientY + 14) + 'px';
});

/* ---------------- charts (plain SVG, single axis, hover tooltips) ---------------- */
function niceMax(v) { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p; return 10 * p; }
// Vertical bars. data: [{label, value, tip}]
function barChart(data, { h = 200, fmt = inrShort, color = 'var(--s1)', max } = {}) {
  if (!data.length) return '<div class="empty">No data yet</div>';
  const W = 640, L = 54, B = 26, T = 10, top = max || niceMax(Math.max(...data.map(d => num(d.value))));
  const iw = W - L - 8, ih = h - B - T, bw = Math.min(42, iw / data.length - 6);
  let g = '';
  for (let i = 0; i <= 4; i++) { const y = T + ih - (ih * i) / 4; g += `<line x1="${L}" x2="${W - 4}" y1="${y}" y2="${y}" stroke="#e8ecf2"/><text x="${L - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="#5b6475">${esc(fmt((top * i) / 4))}</text>`; }
  data.forEach((d, i) => {
    const cx = L + (iw / data.length) * (i + 0.5), v = Math.max(0, num(d.value)), bh = (ih * v) / top, y = T + ih - bh;
    const r = Math.min(4, bh / 2, bw / 2);
    g += `<rect x="${cx - iw / data.length / 2}" y="${T}" width="${iw / data.length}" height="${ih}" fill="transparent" data-tip="${esc(d.tip || `<b>${esc(d.label)}</b><br>${esc(fmt(d.value))}`)}"/>`;
    if (bh > 0) g += `<path d="M${cx - bw / 2},${T + ih} V${y + r} q0,-${r} ${r},-${r} H${cx + bw / 2 - r} q${r},0 ${r},${r} V${T + ih} Z" fill="${d.color || color}" pointer-events="none"/>`;
    if (data.length <= 14 || i % 2 === 0) g += `<text x="${cx}" y="${h - 8}" text-anchor="middle" font-size="11" fill="#5b6475">${esc(d.label)}</text>`;
  });
  g += `<line x1="${L}" x2="${W - 4}" y1="${T + ih}" y2="${T + ih}" stroke="#b9c2cf"/>`;
  return `<svg viewBox="0 0 ${W} ${h}" width="100%" role="img">${g}</svg>`;
}
// Line with points on a fixed scale (e.g. score 1–5)
function lineChart(data, { h = 200, min = 1, max = 5, fmt = v => num(v).toFixed(2) } = {}) {
  const pts = data.filter(d => d.value != null);
  if (!pts.length) return '<div class="empty">No data yet</div>';
  const W = 640, L = 40, B = 26, T = 12, iw = W - L - 30, ih = h - B - T;
  const x = i => L + (data.length === 1 ? iw / 2 : (iw * i) / (data.length - 1)), y = v => T + ih - (ih * (v - min)) / (max - min);
  let g = '';
  for (let v = min; v <= max; v++) g += `<line x1="${L}" x2="${W - 6}" y1="${y(v)}" y2="${y(v)}" stroke="#e8ecf2"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#5b6475">${v}</text>`;
  const path = data.map((d, i) => d.value == null ? null : `${x(i)},${y(d.value)}`).filter(Boolean);
  g += `<polyline points="${path.join(' ')}" fill="none" stroke="var(--s1)" stroke-width="2" stroke-linejoin="round"/>`;
  data.forEach((d, i) => {
    if (d.value != null) g += `<circle cx="${x(i)}" cy="${y(d.value)}" r="4.5" fill="var(--s1)" stroke="#fff" stroke-width="2"/>`;
    g += `<rect x="${x(i) - iw / data.length / 2}" y="${T}" width="${iw / data.length}" height="${ih}" fill="transparent" data-tip="${esc(d.tip || `<b>${esc(d.label)}</b><br>${d.value == null ? 'No responses' : fmt(d.value)}`)}"/>`;
    g += `<text x="${x(i)}" y="${h - 8}" text-anchor="middle" font-size="11" fill="#5b6475">${esc(d.label)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${h}" width="100%" role="img">${g}</svg>`;
}
// One horizontal stacked bar with a legend that carries the values. parts: [{label, value, color}]
function stackBar(parts, fmt = inrShort) {
  const tot = parts.reduce((a, p) => a + Math.max(0, num(p.value)), 0);
  if (!tot) return '<div class="muted small">Nothing outstanding</div>';
  return `<div class="stack">${parts.filter(p => num(p.value) > 0).map(p => `<span style="width:${(100 * num(p.value)) / tot}%;background:${p.color}" data-tip="<b>${esc(p.label)}</b><br>${esc(fmt(p.value))} · ${Math.round((100 * num(p.value)) / tot)}%"></span>`).join('')}</div>
    <div class="lg">${parts.map(p => `<span><i style="background:${p.color}"></i>${esc(p.label)} <b style="color:var(--ink)">${esc(fmt(p.value))}</b></span>`).join('')}</div>`;
}
const AGE_COLORS = ['#b6d5f8', '#6aabf1', '#2370cd', '#1757ac', '#0e3d7e'];   // ordinal: further overdue = darker
const agingParts = a => [
  { label: 'Not due', value: a.notDue ?? a.NotDue, color: AGE_COLORS[0] }, { label: '1–30 days', value: a.d1_30 ?? a.D1_30, color: AGE_COLORS[1] },
  { label: '31–60', value: a.d31_60 ?? a.D31_60, color: AGE_COLORS[2] }, { label: '61–90', value: a.d61_90 ?? a.D61_90, color: AGE_COLORS[3] },
  { label: '90+ days', value: a.d90plus ?? a.D90Plus, color: AGE_COLORS[4] }];
const last13 = () => { const out = []; const d = new Date(today() + 'T00:00:00Z'); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 12); for (let i = 0; i < 13; i++) { out.push(d.toISOString().slice(0, 7)); d.setUTCMonth(d.getUTCMonth() + 1); } return out; };

/* ---------------- Excel ---------------- */
let _xl = null;
async function excel() { if (!_xl) await new Promise((ok, no) => { const s = document.createElement('script'); s.src = '/exceljs.min.js'; s.onload = ok; s.onerror = no; document.head.appendChild(s); }); _xl = window.ExcelJS; return _xl; }
// cols: [{h, k|v(row), w, fmt:'inr'|'mt'|'date'|'num'}]
async function downloadXlsx(name, sheet, cols, rows, title) {
  const X = await excel(); const wb = new X.Workbook(); const ws = wb.addWorksheet(sheet, { views: [{ state: 'frozen', ySplit: title ? 2 : 1 }] });
  let r0 = 1;
  if (title) { ws.mergeCells(1, 1, 1, cols.length); const c = ws.getCell(1, 1); c.value = title; c.font = { bold: true, size: 13, color: { argb: 'FF0A2B66' } }; ws.getRow(1).height = 22; r0 = 2; }
  const hr = ws.getRow(r0); cols.forEach((c, i) => { const cell = hr.getCell(i + 1); cell.value = c.h; cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A2B66' } }; cell.alignment = { vertical: 'middle', wrapText: true }; cell.border = { bottom: { style: 'thin', color: { argb: 'FF01578C' } } }; ws.getColumn(i + 1).width = c.w || 16; });
  hr.height = 30;
  rows.forEach((row, ri) => {
    const xr = ws.getRow(r0 + 1 + ri);
    cols.forEach((c, i) => {
      let v = c.v ? c.v(row) : row[c.k]; const cell = xr.getCell(i + 1);
      if (c.fmt === 'date') { v = d10(v) ? new Date(d10(v) + 'T00:00:00Z') : null; cell.numFmt = 'dd-mmm-yyyy'; }
      else if (c.fmt === 'inr') { v = v == null || v === '' ? null : num(v); cell.numFmt = '#,##,##0;[Red]-#,##,##0'; }
      else if (c.fmt === 'mt') { v = v == null || v === '' ? null : num(v); cell.numFmt = '#,##0.000'; }
      else if (c.fmt === 'num') { v = v == null || v === '' ? null : num(v); cell.numFmt = '0.00'; }
      else if (Array.isArray(v)) v = v.join(', ');
      cell.value = v ?? null;
      if (ri % 2) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F6F8' } };
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFD9DEE6' } } };
    });
  });
  ws.autoFilter = { from: { row: r0, column: 1 }, to: { row: r0, column: cols.length } };
  const buf = await wb.xlsx.writeBuffer();
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
// Read the first sheet of an .xlsx or a .csv into {headers, rows}
async function readTable(file) {
  if (/\.csv$/i.test(file.name)) {
    const text = await file.text(); const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
      else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
      else f += c;
    }
    if (f || row.length) { row.push(f); rows.push(row); }
    const clean = rows.filter(r => r.some(x => String(x).trim()));
    return { headers: clean[0] || [], rows: clean.slice(1) };
  }
  const X = await excel(); const wb = new X.Workbook(); await wb.xlsx.load(await file.arrayBuffer());
  const ws = wb.worksheets[0]; const out = [];
  const val = v => v == null ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? (v.text ?? v.hyperlink ?? (v.richText ? v.richText.map(t => t.text).join('') : v.result ?? '')) : v;
  ws.eachRow({ includeEmpty: false }, r => { const a = []; for (let i = 1; i <= ws.columnCount; i++) a.push(val(r.getCell(i).value)); out.push(a); });
  return { headers: (out[0] || []).map(String), rows: out.slice(1) };
}

/* ---------------- QR / share ---------------- */
function qrSvg(text) { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); }
function qrPng(text, name) { const q = qrcode(0, 'M'); q.addData(text); q.make(); const a = document.createElement('a'); a.href = q.createDataURL(10, 4); a.download = name; a.click(); }
function shareBox(url, label, waText) {
  return `<div class="share"><div class="qr">${qrSvg(url)}</div><div style="flex:1;min-width:240px"><div class="b" style="margin-bottom:6px">${esc(label)}</div><code>${esc(url)}</code>
    <div class="toolbar" style="margin:10px 0 0"><button class="btn sm sec" data-copy="${esc(url)}">Copy link</button>
    <button class="btn sm sec" data-qr="${esc(url)}" data-qrname="${esc(label.replace(/\W+/g, '-').toLowerCase())}-qr.png">Download QR</button>
    ${waText ? `<a class="btn sm wa" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(waText)}">Share on WhatsApp</a>` : ''}</div></div></div>`;
}
document.addEventListener('click', e => {
  const c = e.target.closest('[data-copy]'); if (c) { copy(c.dataset.copy); return; }
  const q = e.target.closest('[data-qr]'); if (q) qrPng(q.dataset.qr, q.dataset.qrname || 'qr.png');
});
const fbText = (inv) => `Dear Customer,\nWe value your feedback. Please take 1 minute to share your experience${inv ? ' for invoice ' + inv : ''}:\n${origin()}/feedback${inv ? '?inv=' + encodeURIComponent(inv) : ''}\n${S.meta?.discountPerTon ? `As a token of appreciation, you will receive an additional discount of Rs.${S.meta.discountPerTon} per ton on your next purchase.\n` : ''}- Bharat Steel (Chennai) Pvt. Ltd.`;
const kycText = (url, company) => `Dear ${company || 'Customer'},\nTo open / update your ledger with Bharat Steel (Chennai) Pvt. Ltd., please fill in this form and upload your GST certificate and a cancelled cheque:\n${url}\nThank you.`;

/* ---------------- auth ---------------- */
function showLogin(msg) {
  $('#shell').classList.add('hidden'); const L = $('#login'); L.classList.remove('hidden');
  L.innerHTML = `<div class="loginbox"><img src="/img/bsc-logo.png" alt="Bharat Steel"><h1>Customer CRM</h1><p class="muted" style="margin:0 0 18px">Sign in with your work email.</p>
    <form id="lf"><div class="f"><label>Email</label><input name="email" type="email" autocomplete="username" required></div>
    <div class="f"><label>Password</label><input name="password" type="password" autocomplete="current-password" required></div>
    <div class="err" id="lerr">${esc(msg || '')}</div><button class="btn" style="width:100%;justify-content:center;margin-top:8px">Sign in</button></form>
    <p class="small muted" style="margin-top:16px">Or open the CRM from the <a href="${esc(S.hub || 'https://app.thebharatsteelgroup.com')}">Bharat Steel Group portal</a> to sign in automatically.</p></div>`;
  $('#lf').onsubmit = async e => {
    e.preventDefault(); const f = new FormData(e.target);
    try { const d = await api('/api/auth', { action: 'login', email: f.get('email'), password: f.get('password') }); S.me = d.user; start(); }
    catch (err) { $('#lerr').textContent = err.message; }
  };
}
async function start() {
  $('#login').classList.add('hidden'); $('#shell').classList.remove('hidden');
  $('#who').textContent = `${S.me.name || S.me.email} · ${S.me.role}`;
  $('#navAdmin').classList.toggle('hidden', !isAdmin());
  S.meta = await api('/api/crm', { action: 'meta' });
  route();
  refreshBadges();
}
$('#logout').onclick = async () => { await api('/api/auth', { action: 'logout' }); S.me = null; showLogin(); };
async function refreshBadges() {
  try {
    const [fu, k, fb] = await Promise.all([api('/api/crm', { action: 'activities', due: true, mine: S.me.role === 'sales' }), api('/api/kyc', { action: 'list' }), api('/api/feedback', { action: 'list' })]);
    const due = fu.rows.filter(a => d10(a.follow_up_at) <= today()).length;
    $('#nbFu').textContent = due || ''; $('#nbKyc').textContent = k.rows.filter(r => r.status === 'submitted').length || '';
    $('#nbFb').textContent = fb.rows.filter(r => r.status === 'followup').length || '';
    S.cache.kyc = k; S.cache.fb = fb;
  } catch (_) { /* badges are optional */ }
}
function setSap(sync) {
  S.sync = sync || S.sync; const s = S.sync || {}; const el = $('#sapState');
  if (!s.connected) { el.className = 'sapst'; el.innerHTML = '<i></i>No SAP data yet'; el.dataset.tip = 'The scheduled task on the SAP server has not sent data yet (README, step 1).'; return; }
  const ok = s.ok !== false && !s.stale;
  el.className = 'sapst ' + (ok ? 'ok' : 'bad');
  el.innerHTML = `<i></i>SAP ${fdt(s.at).split(', ')[1] || ''}`;
  el.dataset.tip = esc(`SAP data as of ${fdt(s.at)} (pushed every 15 min by the SAP server).${s.ok === false ? ' Last run failed: ' + (s.message || '') : s.stale ? ' No update for a while — check the scheduled task.' : ' ' + (s.message || '')}`);
}
// Banner when the SAP task failed or has stopped sending
function sapWarn(s) {
  if (!s || !s.connected) return '';
  if (s.ok === false) return `<div class="banner bad">The last SAP update failed: ${esc(s.message || '')}. Showing data from ${fdt(s.at)}.</div>`;
  if (s.stale) return `<div class="banner warn">No SAP update since ${fdt(s.at)} — check the “BSC CRM Refresh” scheduled task on the SAP server. Figures below are from that time.</div>`;
  return '';
}

/* ---------------- router ---------------- */
const ROUTES = { '': viewDash, customers: viewCustomers, c: viewCustomer, followups: viewFollowups, leads: viewLeads, kyc: viewKyc, feedback: viewFeedback, admin: viewAdmin };
function route() {
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  S.hq = new URLSearchParams(qs || '');
  const parts = path.split('/');
  const fn = ROUTES[parts[0]] || viewDash;
  const navKey = { '': 'dash', c: 'customers' }[parts[0]] ?? parts[0];
  $$('#nav a').forEach(a => a.classList.toggle('on', a.dataset.r === (navKey || 'dash')));
  closeModal(); window.scrollTo(0, 0);
  fn(...parts.slice(1).map(decodeURIComponent)).catch(e => { $('#main').innerHTML = `<div class="banner bad">${esc(e.message)}</div>`; });
}
window.addEventListener('hashchange', route);

/* ---------------- customer list cache + global search ---------------- */
async function loadCustomers(force) {
  if (S.customers && !force && Date.now() - S.customersAt < 120000) return S.customers;
  const d = await api('/api/customers'); S.customers = d.customers; S.customersAt = Date.now(); setSap(d.sync); return S.customers;
}
const norm = s => String(s || '').toLowerCase();
function matchCustomer(c, q) {
  const t = norm(q).trim(); if (!t) return true;
  const digits = t.replace(/\D/g, '');
  return norm(c.name).includes(t) || norm(c.card_code).includes(t) || norm(c.gstin).includes(t) || norm(c.city).includes(t) || (digits.length >= 4 && String(c.phone || '').includes(digits));
}
(() => {
  const inp = $('#gq'), box = $('#gres'); let sel = 0, list = [];
  const draw = () => { box.innerHTML = list.length ? list.map((c, i) => `<a href="#/c/${encodeURIComponent(c.card_code)}" class="${i === sel ? 'on' : ''}">${esc(c.name)}<small>${esc(c.card_code)} · ${esc(c.city || '')} ${c.gstin ? '· ' + esc(c.gstin) : ''}</small></a>`).join('') : '<div class="empty">No match</div>'; box.classList.remove('hidden'); };
  inp.addEventListener('input', async () => { if (!inp.value.trim()) { box.classList.add('hidden'); return; } const all = await loadCustomers(); list = all.filter(c => matchCustomer(c, inp.value)).slice(0, 12); sel = 0; draw(); });
  inp.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { sel = Math.min(list.length - 1, sel + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter' && list[sel]) { location.hash = '#/c/' + encodeURIComponent(list[sel].card_code); inp.value = ''; box.classList.add('hidden'); }
  });
  document.addEventListener('click', e => { if (!e.target.closest('.gsearch')) box.classList.add('hidden'); else if (e.target.closest('a')) { inp.value = ''; box.classList.add('hidden'); } });
})();

/* ================================================================= DASHBOARD */
async function viewDash() {
  loading();
  const d = await api('/api/crm', { action: 'dashboard' }); setSap(d.sync);
  const s = d.sap?.sales || {}, kyc = Object.fromEntries(d.kyc.map(k => [k.status, k.n]));
  const months = last13(); const sm = Object.fromEntries((d.sap?.monthly || []).map(m => [m.M, m]));
  const growth = s.SalesLastMonth ? Math.round((100 * (num(s.SalesMTD) - num(s.SalesLastMonth))) / num(s.SalesLastMonth)) : null;
  const leadOpen = d.leads.filter(l => !['won', 'lost'].includes(l.stage));
  $('#main').innerHTML = `
    <h1 class="pg">Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, ${esc((S.me.name || '').split(' ')[0] || 'there')}</h1>
    <p class="pgsub">${d.sync.connected ? `SAP data as of ${fdt(d.sync.at)} · refreshed every 15 minutes` : 'No SAP data yet — set up the scheduled task on the SAP server (README, step 1).'}</p>
    ${sapWarn(d.sync)}
    <div class="kpis">
      ${d.sap ? `<div class="kpi"><div class="l">Sales this month (taxable)</div><div class="v">${inrShort(s.SalesMTD)}</div><div class="s">Last month ${inrShort(s.SalesLastMonth)}</div></div>
      <div class="kpi"><div class="l">Sales this financial year</div><div class="v">${inrShort(s.SalesFYTD)}</div><div class="s">from 1 April</div></div>` : ''}
      <a class="kpi" href="#/customers"><div class="l">Customers in SAP</div><div class="v">${d.cust.total.toLocaleString('en-IN')}</div><div class="s">${d.cust.active90} bought in last 90 days</div></a>
      <a class="kpi ${d.cust.dormant ? 'alert' : ''}" href="#/customers?f=dormant"><div class="l">Dormant customers</div><div class="v">${d.cust.dormant}</div><div class="s">no invoice for ${d.dormantDays}+ days</div></a>
      <div class="kpi"><div class="l">Receivables (SAP balance)</div><div class="v">${inrShort(d.cust.receivable)}</div><div class="s">${d.cust.over_credit} customers over credit limit</div></div>
      <a class="kpi ${d.fu.overdue ? 'alert' : ''}" href="#/followups"><div class="l">Follow-ups due</div><div class="v">${d.fu.overdue + d.fu.today}</div><div class="s">${d.fu.overdue} overdue · ${d.fu.week} next 7 days</div></a>
      <a class="kpi" href="#/kyc"><div class="l">Ledger forms to review</div><div class="v">${(kyc.submitted || 0) + (kyc.review || 0)}</div><div class="s">${kyc.approved || 0} approved, waiting for SAP</div></a>
      <a class="kpi" href="#/feedback"><div class="l">Feedback score (90 days)</div><div class="v">${d.fb.avg != null ? d.fb.avg.toFixed(2) + '<span class="muted" style="font-size:14px"> / 5</span>' : '—'}</div><div class="s">${d.fb.n} responses · ${d.fbOpen.open_issues} open issues</div></a>
      <a class="kpi" href="#/leads"><div class="l">Open leads</div><div class="v">${leadOpen.reduce((a, l) => a + l.n, 0)}</div><div class="s">${Math.round(leadOpen.reduce((a, l) => a + l.mt, 0))} MT/month potential</div></a>
    </div>
    <div class="row">
      ${d.sap ? `<div class="card" style="flex:2"><h2>Monthly sales (taxable value) <span class="sp"></span><small>${growth == null ? '' : `This month so far: ${growth >= 0 ? '+' : ''}${growth}% vs last month`}</small></h2>
        ${barChart(months.map(m => ({ label: ym(m), value: sm[m]?.Sales || 0, tip: `<b>${ym(m)}</b><br>${inr(sm[m]?.Sales || 0)}<br>${sm[m]?.Customers || 0} customers invoiced` })))}</div>` : ''}
      <div class="card"><h2>Receivable ageing <span class="sp"></span><small>open invoices, by days past due</small></h2>
        ${d.sap ? stackBar(agingParts(d.sap.aging)) : '<div class="muted small">Needs the live SAP connection.</div>'}
        <h2 style="margin-top:22px">Over credit limit</h2>
        ${d.overCredit.length ? `<table><tr><th>Customer</th><th class="n">Balance</th><th class="n">Limit</th></tr>${d.overCredit.slice(0, 6).map(c => `<tr class="click" data-go="#/c/${encodeURIComponent(c.card_code)}"><td>${esc(c.name)}</td><td class="n">${inrShort(c.balance)}</td><td class="n muted">${inrShort(c.credit_line)}</td></tr>`).join('')}</table>` : '<div class="muted small">None</div>'}
      </div>
    </div>
    <div class="row">
      <div class="card"><h2>Top customers <small>last 365 days</small></h2>
        <table><tr><th>Customer</th><th class="n">Sales</th><th class="n">Qty</th><th>Last invoice</th></tr>
        ${d.top.map(c => `<tr class="click" data-go="#/c/${encodeURIComponent(c.card_code)}"><td>${esc(c.name)}<div class="ibar" style="width:${(100 * c.sales365) / (d.top[0]?.sales365 || 1)}%"></div></td><td class="n">${inrShort(c.sales365)}</td><td class="n">${mt(c.qty365)}</td><td class="nowrap">${fdate(c.last_invoice)}</td></tr>`).join('')}</table></div>
      <div class="card"><h2>Win back <small>regular buyers who went quiet</small></h2>
        ${d.winback.length ? `<table><tr><th>Customer</th><th>Last invoice</th><th class="n">365-day sales</th><th></th></tr>${d.winback.map(c => `<tr><td><a href="#/c/${encodeURIComponent(c.card_code)}">${esc(c.name)}</a><div class="small muted">${esc(c.slp_name || '')}</div></td><td class="nowrap">${fdate(c.last_invoice)}<div class="small muted">${daysSince(c.last_invoice)} days</div></td><td class="n">${inrShort(c.sales365)}</td><td>${canEdit() ? `<button class="btn sm sec" data-log="${esc(c.card_code)}">Log call</button>` : ''}</td></tr>`).join('')}</table>` : '<div class="muted small">Nobody — good.</div>'}</div>
    </div>
    <div class="row">
      <div class="card"><h2>Sales by industry segment <small>365 days, from ledger forms / profiles</small></h2>
        ${segTable(d.segments)}
        ${d.cust.no_segment ? `<div class="small muted" style="margin-top:8px">${d.cust.no_segment} customers have no segment yet — it fills in from approved ledger forms, or set it on the customer page.</div>` : ''}</div>
      <div class="card"><h2>Feedback score by month <small>average of all answers, 1–5</small></h2>
        ${lineChart(lastN(12).map(m => { const f = d.fbMonthly.find(x => x.m === m); return { label: ym(m), value: f ? f.avg : null, tip: `<b>${ym(m)}</b><br>${f ? `Average ${f.avg.toFixed(2)} · ${f.n} responses` : 'No responses'}` }; }))}</div>
    </div>`;
  bindRowLinks();
  $$('[data-log]').forEach(b => b.onclick = () => activityModal({ card_code: b.dataset.log, type: 'call', subject: 'Win-back call' }, () => toast('Saved')));
}
const lastN = n => last13().slice(13 - n);
function segTable(rows) {
  const top = rows.filter(r => r.segment !== 'Not captured').slice(0, 10), max = Math.max(1, ...top.map(r => r.sales));
  if (!top.length) return '<div class="muted small">No segments captured yet.</div>';
  return `<table><tr><th>Segment</th><th class="n">Customers</th><th class="n">Sales</th></tr>${top.map(r => `<tr><td>${esc(r.segment)}<div class="ibar" style="width:${(100 * r.sales) / max}%"></div></td><td class="n">${r.n}</td><td class="n">${inrShort(r.sales)}</td></tr>`).join('')}</table>`;
}
function bindRowLinks(root = document) { root.querySelectorAll('[data-go]').forEach(r => r.onclick = e => { if (!e.target.closest('a,button,input,select')) location.hash = r.dataset.go; }); }

/* ================================================================= CUSTOMERS */
const CF = { q: '', f: 'all', slp: '', seg: '', sort: 'sales365', dir: -1, limit: 200 };
async function viewCustomers() {
  loading();
  if (S.hq.get('f')) CF.f = S.hq.get('f');
  const all = await loadCustomers(true);
  const dd = S.meta.dormantDays;
  const slps = [...new Map(all.filter(c => c.slp_code != null).map(c => [String(c.slp_code), c.slp_name || 'Code ' + c.slp_code])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const segs = [...new Set(all.map(c => c.segment).filter(Boolean))].sort();
  const FILTERS = [['all', 'All'], ['mine', 'My customers'], ['active', 'Active (90 days)'], ['dormant', `Dormant (${dd}+ days)`], ['over', 'Over credit limit'], ['nokyc', 'No segment / KYC'], ['frozen', 'Frozen in SAP'], ['followup', 'Has open follow-up']];
  const test = {
    all: () => true, mine: c => (S.me.slp_code != null && c.slp_code === S.me.slp_code) || c.owner_email === S.me.email,
    active: c => daysSince(c.last_invoice) != null && daysSince(c.last_invoice) <= 90, dormant: c => daysSince(c.last_invoice) > dd,
    over: c => c.credit_line > 0 && c.balance > c.credit_line, nokyc: c => !c.segment, frozen: c => c.frozen, followup: c => c.open_followups > 0
  };
  $('#main').innerHTML = `<h1 class="pg">Customers</h1>${sapWarn(S.sync)}<p class="pgsub">${all.length.toLocaleString('en-IN')} customers from SAP Business One · SAP data as of ${fdt(S.sync?.at)} (updated every 15 minutes)</p>
    <div class="toolbar"><input type="search" id="cq" placeholder="Search name, code, GSTIN, city, phone" value="${esc(CF.q)}">
      <select id="cf">${opts(FILTERS, CF.f, null)}</select>
      <select id="cslp">${opts(slps, CF.slp, 'All salespersons')}</select>
      <select id="cseg">${opts(segs, CF.seg, 'All segments')}</select>
      <span class="sp"></span><span class="muted small" id="ccount"></span>
<button class="btn sm sec" id="cxl">Export Excel</button></div>
    <div class="tw" id="ctab"></div><div id="cmore" style="margin-top:10px"></div>`;
  const COLS = [['name', 'Customer'], ['city', 'City'], ['slp_name', 'Salesperson'], ['segment', 'Segment'], ['sales365', 'Sales 365d', 1], ['qty365', 'Qty 365d', 1], ['last_invoice', 'Last invoice'], ['balance', 'Balance', 1], ['fb_avg', 'Feedback', 1]];
  let rows = [];
  const draw = () => {
    rows = all.filter(c => test[CF.f](c) && matchCustomer(c, CF.q) && (!CF.slp || String(c.slp_code) === CF.slp) && (!CF.seg || c.segment === CF.seg));
    rows.sort((a, b) => { const x = a[CF.sort], y = b[CF.sort]; if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * CF.dir; });
    $('#ccount').textContent = `${rows.length.toLocaleString('en-IN')} shown`;
    $('#ctab').innerHTML = `<table><tr>${COLS.map(([k, l, n]) => `<th class="sort ${n ? 'n' : ''}" data-s="${k}">${l}${CF.sort === k ? (CF.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr>
      ${rows.slice(0, CF.limit).map(c => {
        const ds = daysSince(c.last_invoice), over = c.credit_line > 0 && c.balance > c.credit_line;
        return `<tr class="click" data-go="#/c/${encodeURIComponent(c.card_code)}"><td><b>${esc(c.name)}</b> ${c.frozen ? '<span class="chip bad">Frozen</span>' : ''} ${c.open_followups ? `<span class="chip warn">${c.open_followups} follow-up</span>` : ''}<div class="small muted">${esc(c.card_code)}${c.gstin ? ' · ' + esc(c.gstin) : ''}</div></td>
        <td>${esc(c.city || '')}<div class="small muted">${esc(c.state || '')}</div></td><td>${esc(c.slp_name || '—')}</td><td>${esc(c.segment || '—')}</td>
        <td class="n">${c.sales365 ? inrShort(c.sales365) : '—'}</td><td class="n">${c.qty365 ? mt(c.qty365) : '—'}</td>
        <td class="nowrap">${fdate(c.last_invoice)}${ds != null ? `<div class="small ${ds > dd ? '' : 'muted'}" style="${ds > dd ? 'color:var(--bad)' : ''}">${ds} days ago</div>` : ''}</td>
        <td class="n" style="${over ? 'color:var(--bad);font-weight:600' : ''}">${inrShort(c.balance)}${c.credit_line ? `<div class="small muted">limit ${inrShort(c.credit_line)}</div>` : ''}</td>
        <td class="n">${c.fb_avg != null ? `${c.fb_avg.toFixed(1)}<div class="small muted">${c.fb_count} resp.</div>` : '—'}</td></tr>`;
      }).join('')}</table>${rows.length ? '' : '<div class="empty">No customers match.</div>'}`;
    $('#cmore').innerHTML = rows.length > CF.limit ? `<button class="btn sec sm" id="cm">Show ${Math.min(500, rows.length - CF.limit)} more</button>` : '';
    if ($('#cm')) $('#cm').onclick = () => { CF.limit += 500; draw(); };
    $$('#ctab th.sort').forEach(th => th.onclick = () => { if (CF.sort === th.dataset.s) CF.dir *= -1; else { CF.sort = th.dataset.s; CF.dir = ['name', 'city', 'slp_name', 'segment'].includes(th.dataset.s) ? 1 : -1; } draw(); });
    bindRowLinks($('#ctab'));
  };
  $('#cq').oninput = e => { CF.q = e.target.value; CF.limit = 200; draw(); };
  $('#cf').onchange = e => { CF.f = e.target.value; draw(); };
  $('#cslp').onchange = e => { CF.slp = e.target.value; draw(); };
  $('#cseg').onchange = e => { CF.seg = e.target.value; draw(); };
  $('#cxl').onclick = () => downloadXlsx(`BSC-customers-${today()}.xlsx`, 'Customers', [
    { h: 'SAP Code', k: 'card_code', w: 12 }, { h: 'Customer', k: 'name', w: 38 }, { h: 'GSTIN', k: 'gstin', w: 18 }, { h: 'City', k: 'city', w: 16 }, { h: 'State', k: 'state', w: 14 },
    { h: 'Salesperson', k: 'slp_name', w: 16 }, { h: 'Segment', k: 'segment', w: 20 }, { h: 'Phone', k: 'phone', w: 14 }, { h: 'Email', k: 'email', w: 26 },
    { h: 'Sales 365 days (₹)', k: 'sales365', fmt: 'inr', w: 16 }, { h: 'Qty 365 days (MT)', k: 'qty365', fmt: 'mt', w: 14 }, { h: 'Last invoice', k: 'last_invoice', fmt: 'date', w: 13 },
    { h: 'Balance (₹)', k: 'balance', fmt: 'inr', w: 15 }, { h: 'Credit limit (₹)', k: 'credit_line', fmt: 'inr', w: 15 }, { h: 'Open orders (₹)', k: 'orders_bal', fmt: 'inr', w: 15 },
    { h: 'Feedback avg', k: 'fb_avg', fmt: 'num', w: 11 }, { h: 'Frozen', v: r => r.frozen ? 'Yes' : '', w: 8 }], rows, `Bharat Steel (Chennai) Pvt. Ltd. — Customers (${FILTERS.find(f => f[0] === CF.f)[1]}) — ${fdate(today())}`);
  draw();
}

/* ================================================================= CUSTOMER 360 */
const ACT_IC = { call: '📞', visit: '🚗', whatsapp: '💬', email: '✉️', meeting: '🤝', complaint: '⚠️', note: '📝' };
const ACT_L = { call: 'Call', visit: 'Visit', whatsapp: 'WhatsApp', email: 'Email', meeting: 'Meeting', complaint: 'Complaint', note: 'Note' };
let C360tab = 'activity';
async function viewCustomer(code) {
  loading();
  const d = await api('/api/customers?code=' + encodeURIComponent(code));
  const L = d.live, m = L?.master || d.cached?.data || {}, c = d.cached || {};
  const bal = num(m.Balance ?? c.balance), cl = num(m.CreditLine ?? c.credit_line), phone = m.Cellular || m.Phone1 || c.phone;
  const p = d.profile || {};
  const ds = daysSince(m.LastInvoice || c.last_invoice);
  const kycOk = d.kyc.find(k => ['approved', 'created'].includes(k.status));
  const fbAvg = d.feedback.length ? d.feedback.reduce((a, f) => a + num(f.score), 0) / d.feedback.length : null;
  $('#main').innerHTML = `
    ${sapWarn(d.sap)}
    <div class="card"><div class="c360h"><div>
      <h1>${esc(m.CardName || c.name)}</h1>
      <div class="meta"><span>${esc(code)}</span>${(m.GSTIN || c.gstin) ? `<span>GSTIN ${esc(m.GSTIN || c.gstin)}</span>` : ''}<span>${esc(m.GroupName || c.group_name || '')}</span>
        <span>Salesperson: <b>${esc(m.SlpName || c.slp_name || '—')}</b></span><span>Terms: ${esc(m.PymntGroup || '—')}</span>
        ${m.frozenFor === 'Y' ? '<span class="chip bad">Frozen in SAP</span>' : ''}${c.in_sap === false ? '<span class="chip bad">Removed from SAP</span>' : ''}
        ${kycOk ? `<span class="chip ok">KYC ${esc(kycOk.ref || '')}</span>` : '<span class="chip warn">No ledger form on file</span>'}
        ${p.segment ? `<span class="chip info">${esc(p.segment)}</span>` : ''}${(p.tags || []).map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div>
      <div class="meta">${m.CntctPrsn ? `<span>👤 ${esc(m.CntctPrsn)}</span>` : ''}${phone ? `<span>📞 <a href="tel:${esc(phone)}">${esc(phone)}</a></span>` : ''}${m.E_Mail || c.email ? `<span>✉️ <a href="mailto:${esc(m.E_Mail || c.email)}">${esc(m.E_Mail || c.email)}</a></span>` : ''}${p.owner_email ? `<span>Account owner: ${esc(p.owner_email)}</span>` : ''}</div>
    </div><div class="acts">
      ${canEdit() ? '<button class="btn" id="aLog">+ Log activity</button>' : ''}
      ${phone ? `<a class="btn wa" target="_blank" rel="noopener" href="${waLink(phone, '')}">WhatsApp</a>` : ''}
      <button class="btn sec" id="aFb">Send feedback link</button>
      ${canEdit() && !kycOk ? '<button class="btn sec" id="aKyc">Send ledger form</button>' : ''}
      ${canEdit() ? '<button class="btn sec" id="aProf">Edit profile</button>' : ''}
    </div></div></div>
    <div class="kpis">
      <div class="kpi ${cl && bal > cl ? 'alert' : ''}"><div class="l">Balance (SAP)</div><div class="v">${inrShort(bal)}</div><div class="s">${cl ? `Credit limit ${inrShort(cl)} · ${Math.round((100 * bal) / cl)}% used` : 'No credit limit set'}</div></div>
      <div class="kpi"><div class="l">Open sales orders</div><div class="v">${inrShort(m.OrdersBal ?? c.orders_bal)}</div><div class="s">${L ? L.orders.length + ' order(s)' : ''}</div></div>
      <div class="kpi"><div class="l">Sales, last 365 days</div><div class="v">${inrShort(m.Sales365 ?? c.sales365)}</div><div class="s">${mt(m.Qty365 ?? c.qty365)} · ${num(m.Invoices365 ?? c.invoices365)} invoices</div></div>
      <div class="kpi ${ds > S.meta.dormantDays ? 'alert' : ''}"><div class="l">Last invoice</div><div class="v" style="font-size:18px">${fdate(m.LastInvoice || c.last_invoice)}</div><div class="s">${ds != null ? ds + ' days ago' : 'Never invoiced'}</div></div>
      <div class="kpi"><div class="l">Feedback</div><div class="v">${fbAvg != null ? fbAvg.toFixed(2) : '—'}</div><div class="s">${d.feedback.length} response(s)</div></div>
    </div>
    ${L ? `<div class="row"><div class="card" style="flex:2"><h2>Monthly purchases <small>net of credit notes, taxable value · SAP as of ${fdt(d.sap?.at)}</small></h2>
      ${(() => { const mm = Object.fromEntries(L.monthly.map(x => [x.M, x])); return barChart(last13().map(k => ({ label: ym(k), value: mm[k]?.Sales || 0, tip: `<b>${ym(k)}</b><br>${inr(mm[k]?.Sales || 0)}<br>${mt(mm[k]?.Qty || 0)}` })), { h: 180 }); })()}</div>
      <div class="card"><h2>Outstanding ageing <small>${inrShort(L.aging.buckets.total)} open</small></h2>${stackBar(agingParts(L.aging.buckets))}
      ${d.related.length ? `<h2 style="margin-top:20px">Other ledgers, same PAN</h2>${d.related.map(r => `<div><a href="#/c/${encodeURIComponent(r.card_code)}">${esc(r.name)}</a> <span class="small muted">${esc(r.card_code)} · ${esc(r.state || '')}</span></div>`).join('')}` : ''}</div></div>` : ''}
    <div class="card"><div class="tabs" id="ctabs">${[['activity', `Activity (${d.activities.length})`], ['invoices', 'Invoices'], ['orders', 'Open orders'], ['payments', 'Payments'], ['aging', 'Open invoices'], ['feedback', `Feedback (${d.feedback.length})`], ['kyc', `Ledger form (${d.kyc.length})`], ['details', 'Addresses & contacts']].map(([k, l]) => `<button data-t="${k}" class="${C360tab === k ? 'on' : ''}">${l}</button>`).join('')}</div><div id="cbody"></div></div>`;
  const body = {
    activity: () => timeline(d.activities, () => viewCustomer(code)) + (d.leads.length ? `<h2 style="margin-top:16px">Leads</h2>${d.leads.map(l => `<div>${esc(l.company)} · <span class="chip">${esc(l.stage)}</span> ${esc(l.product || '')}</div>`).join('')}` : ''),
    invoices: () => !L ? needLive() : `<table><tr><th>Invoice</th><th>Date</th><th>Due</th><th class="n">Qty</th><th class="n">Total</th><th class="n">Paid</th><th>Status</th><th>PO / Ref</th><th></th></tr>
      ${L.invoices.map(i => `<tr><td class="nowrap b">${esc(i.InvoiceNo)}${i.Items ? `<div class="small muted" style="font-weight:400;white-space:normal;max-width:280px">${esc(i.Items)}</div>` : ''}</td><td class="nowrap">${fdate(i.DocDate)}</td><td class="nowrap">${fdate(i.DocDueDate)}</td><td class="n">${mt(i.Qty)}</td><td class="n">${inr(i.DocTotal)}</td><td class="n">${inr(i.PaidToDate)}</td>
        <td>${i.DocStatus === 'C' ? '<span class="chip ok">Closed</span>' : num(i.PaidToDate) > 0 ? '<span class="chip warn">Part paid</span>' : '<span class="chip">Open</span>'}</td><td>${esc(i.NumAtCard || '')}</td>
        <td><button class="btn sm sec" data-fbinv="${esc(i.InvoiceNo)}" title="Send feedback link for this invoice">Feedback link</button></td></tr>`).join('')}</table>${L.invoices.length >= 25 ? '<button class="btn sm sec" id="moreInv" style="margin-top:10px">Load 200 invoices</button>' : ''}`,
    orders: () => !L ? needLive() : L.orders.length ? `<table><tr><th>Order</th><th>Date</th><th>Delivery due</th><th class="n">Qty</th><th class="n">Open qty</th><th class="n">Value</th><th>PO / Ref</th></tr>
      ${L.orders.map(o => `<tr><td>${esc(o.DocNum)}</td><td>${fdate(o.DocDate)}</td><td>${fdate(o.DocDueDate)} ${d10(o.DocDueDate) < today() ? '<span class="chip bad">Late</span>' : ''}</td><td class="n">${mt(o.Qty)}</td><td class="n">${mt(o.OpenQty)}</td><td class="n">${inr(o.DocTotal)}</td><td>${esc(o.NumAtCard || '')}</td></tr>`).join('')}</table>` : '<div class="empty">No open sales orders.</div>',
    payments: () => !L ? needLive() : L.payments.length ? `<table><tr><th>Receipt</th><th>Date</th><th class="n">Amount</th><th>Reference</th><th>Remarks</th></tr>
      ${L.payments.map(p => `<tr><td>${esc(p.DocNum)}</td><td>${fdate(p.DocDate)}</td><td class="n">${inr(p.DocTotal)}</td><td>${esc(p.TrsfrRef || '')}</td><td>${esc(p.Comments || '')}</td></tr>`).join('')}</table>` : '<div class="empty">No payments recorded.</div>',
    aging: () => !L ? needLive() : L.aging.open.length ? `<table><tr><th>Invoice</th><th>Date</th><th>Due</th><th class="n">Total</th><th class="n">Open</th><th class="n">Days overdue</th></tr>
      ${L.aging.open.map(a => `<tr><td>${esc(a.DocNum)}</td><td>${fdate(a.DocDate)}</td><td>${fdate(a.DocDueDate)}</td><td class="n">${inr(a.DocTotal)}</td><td class="n b">${inr(a.OpenAmt)}</td><td class="n" style="${a.DaysOverdue > 0 ? 'color:var(--bad);font-weight:600' : ''}">${a.DaysOverdue > 0 ? a.DaysOverdue : 'not due'}</td></tr>`).join('')}</table>` : '<div class="empty">No open invoices.</div>',
    feedback: () => d.feedback.length ? `<table><tr><th>Date</th><th>Invoice</th>${S.FBQ ? '' : ''}<th class="n">Score</th><th>Comment</th><th>Status</th><th>Discount</th></tr>
      ${d.feedback.map(f => `<tr class="click" data-fb="${f.id}"><td class="nowrap">${fdate(f.created_at)}</td><td>${esc(f.invoice_no || '—')}</td><td class="n b">${num(f.score).toFixed(2)}</td><td>${esc(f.comment || '')}</td><td>${fbStatusChip(f.status)}</td><td>${discChip(f.discount)}</td></tr>`).join('')}</table>` : '<div class="empty">No feedback from this customer yet. Use “Send feedback link”.</div>',
    kyc: () => d.kyc.length ? `<table><tr><th>Ref</th><th>Status</th><th>Company (as filled)</th><th>GSTIN</th><th>Segment</th><th>Submitted</th></tr>
      ${d.kyc.map(k => `<tr class="click" data-go="#/kyc/${k.id}"><td>${esc(k.ref || '#' + k.id)}</td><td>${kycChip(k.status)}</td><td>${esc(k.company || '')}</td><td>${esc(k.gstin || '')}</td><td>${esc(k.segment || '')}</td><td>${fdate(k.submitted_at)}</td></tr>`).join('')}</table>` : '<div class="empty">No ledger form linked to this customer.</div>',
    details: () => `<div class="row"><div>${L ? L.addresses.map(a => `<div style="margin-bottom:14px"><div class="b">${a.Type === 'B' ? 'Bill to' : 'Ship to'} · ${esc(a.Name)}</div><div>${esc([a.Building, a.Street, a.Block].filter(Boolean).join(', '))}</div><div>${esc([a.City, a.County, a.ZipCode].filter(Boolean).join(', '))}</div><div>${esc(a.State || '')}</div>${a.GSTIN ? `<div class="small muted">GSTIN ${esc(a.GSTIN)}</div>` : ''}</div>`).join('') || '<div class="muted">No addresses in SAP</div>' : needLive()}</div>
      <div>${L ? `<table><tr><th>Contact</th><th>Position</th><th>Mobile</th><th>Email</th></tr>${L.contacts.map(p => `<tr><td>${esc(p.Name)}</td><td>${esc(p.Position || '')}</td><td>${p.Mobile ? `<a href="tel:${esc(p.Mobile)}">${esc(p.Mobile)}</a>` : ''}</td><td>${esc(p.Email || '')}</td></tr>`).join('')}</table>` : ''}
      ${p.notes ? `<h2 style="margin-top:16px">Notes</h2><div style="white-space:pre-line">${esc(p.notes)}</div>` : ''}
      <dl class="kv" style="margin-top:16px"><dt>Buyer type</dt><dd>${esc((p.buyer_types || []).join(', ') || '—')}</dd><dt>Usage</dt><dd>${esc(p.usage || '—')}</dd><dt>Registration</dt><dd>${esc(p.reg_type || '—')}</dd><dt>In SAP since</dt><dd>${fdate(m.CreateDate || c.created_sap)}</dd></dl></div></div>`
  };
  const show = t => { C360tab = t; $$('#ctabs button').forEach(b => b.classList.toggle('on', b.dataset.t === t)); $('#cbody').innerHTML = body[t](); bindTab(); };
  const bindTab = () => {
    bindRowLinks($('#cbody')); bindTimeline($('#cbody'), () => viewCustomer(code));
    $$('#cbody [data-fbinv]').forEach(b => b.onclick = () => sendFeedback(phone, b.dataset.fbinv));
    $$('#cbody [data-fb]').forEach(r => r.onclick = () => feedbackModal(+r.dataset.fb, () => viewCustomer(code)));
    if ($('#moreInv')) $('#moreInv').onclick = async () => { const r = await api(`/api/customers?code=${encodeURIComponent(code)}&more=invoices&limit=200`); L.invoices = r.invoices; show('invoices'); };
  };
  $$('#ctabs button').forEach(b => b.onclick = () => show(b.dataset.t));
  show(C360tab);
  if ($('#aLog')) $('#aLog').onclick = () => activityModal({ card_code: code }, () => { C360tab = 'activity'; viewCustomer(code); });
  $('#aFb').onclick = () => sendFeedback(phone, L?.invoices?.[0]?.InvoiceNo);
  if ($('#aKyc')) $('#aKyc').onclick = () => inviteKyc({ card_code: code, company: m.CardName || c.name, phone });
  if ($('#aProf')) $('#aProf').onclick = () => profileModal(code, p, () => viewCustomer(code));
}
const needLive = () => '<div class="empty">No SAP data for this customer yet.</div>';
function sendFeedback(phone, inv) {
  const url = `${origin()}/feedback${inv ? '?inv=' + encodeURIComponent(inv) : ''}`;
  modal(`<h2>Feedback link${inv ? ' · invoice ' + esc(inv) : ''}</h2>${shareBox(url, 'Customer feedback form')}
    <div class="f" style="margin-top:14px"><label>Message</label><textarea id="fbmsg" rows="6">${esc(fbText(inv))}</textarea></div>
    <div class="acts"><button class="btn sec" onclick="closeModal()">Close</button>${phone ? `<a class="btn wa" id="fbwa" target="_blank" rel="noopener" href="#">Send on WhatsApp to ${esc(phone)}</a>` : ''}</div>`);
  if ($('#fbwa')) $('#fbwa').onclick = () => { $('#fbwa').href = waLink(phone, $('#fbmsg').value); };
}
function profileModal(code, p, done) {
  const M = S.meta;
  const el = modal(`<h2>Customer profile</h2><p class="small muted" style="margin-top:-8px">CRM details (SAP is not changed). Segment, buyer type and usage fill in automatically from an approved ledger form.</p>
    <div class="fg"><div class="f"><label>Industry segment</label><select id="pSeg">${opts(M.segments, p.segment, '—')}</select></div>
    <div class="f"><label>Usage</label><select id="pUse">${opts(M.usage, p.usage, '—')}</select></div>
    <div class="f"><label>Registration type</label><select id="pReg">${opts(M.regTypes, p.reg_type, '—')}</select></div>
    <div class="f"><label>Account owner</label><select id="pOwn">${opts(M.staff.map(s => [s.email, s.name || s.email]), p.owner_email, '—')}</select></div></div>
    <div class="f"><label>Type of buyer</label><div class="fg">${M.buyerTypes.map(b => `<label style="font-weight:500;color:var(--ink)"><input type="checkbox" class="pBuy" value="${esc(b)}" ${(p.buyer_types || []).includes(b) ? 'checked' : ''}> ${esc(b)}</label>`).join('')}</div></div>
    <div class="f"><label>Tags (comma separated)</label><input id="pTags" value="${esc((p.tags || []).join(', '))}" placeholder="key account, monthly buyer, price sensitive"></div>
    <div class="f"><label>Notes</label><textarea id="pNotes" rows="4">${esc(p.notes || '')}</textarea></div>
    <div class="err" id="pErr"></div><div class="acts"><button class="btn sec" onclick="closeModal()">Cancel</button><button class="btn" id="pSave">Save</button></div>`);
  $('#pSave').onclick = async () => {
    try { await api('/api/customers', { action: 'profile', code, segment: $('#pSeg').value, usage: $('#pUse').value, reg_type: $('#pReg').value, owner_email: $('#pOwn').value,
      buyer_types: $$('.pBuy:checked').map(x => x.value), tags: $('#pTags').value, notes: $('#pNotes').value }); closeModal(); toast('Profile saved'); S.customers = null; done(); }
    catch (e) { $('#pErr').textContent = e.message; }
  };
}

/* ---------------- activities ---------------- */
function timeline(list, refresh) {
  if (!list.length) return '<div class="empty">Nothing logged yet. Log calls, visits and complaints here so the whole team sees the history.</div>';
  return `<ul class="timeline">${list.map(a => `<li><div class="ic">${ACT_IC[a.type] || '📝'}</div><div class="bd">
    <div class="t">${esc(a.subject)} ${a.follow_up_at && !a.done ? `<span class="chip ${d10(a.follow_up_at) < today() ? 'bad' : d10(a.follow_up_at) === today() ? 'warn' : 'info'}">Follow up ${fdate(a.follow_up_at)}</span>` : ''} ${a.follow_up_at && a.done ? '<span class="chip ok">Done</span>' : ''}</div>
    <div class="m">${ACT_L[a.type] || a.type} · ${fdt(a.created_at)} · ${esc(a.created_by || '')}${a.owner_email && a.owner_email !== a.created_by ? ' → ' + esc(a.owner_email) : ''}${a.customer && !refresh ? ' · ' + esc(a.customer) : ''}</div>
    ${a.notes ? `<div class="nt">${esc(a.notes)}</div>` : ''}</div>
    ${canEdit() ? `<div class="nowrap">${a.follow_up_at && !a.done ? `<button class="btn sm sec" data-adone="${a.id}">Done</button> ` : ''}<button class="btn sm sec" data-aedit="${a.id}">Edit</button></div>` : ''}</li>`).join('')}</ul>`;
}
function bindTimeline(root, refresh, list) {
  root.querySelectorAll('[data-adone]').forEach(b => b.onclick = () => doneModal(+b.dataset.adone, refresh));
  root.querySelectorAll('[data-aedit]').forEach(b => b.onclick = async () => {
    const all = list || (await api('/api/crm', { action: 'activities' })).rows; const a = all.find(x => x.id === +b.dataset.aedit) || {};
    activityModal(a, refresh);
  });
}
function doneModal(id, refresh) {
  modal(`<h2>Mark follow-up done</h2><div class="f"><label>What happened? (optional)</label><textarea id="dNote" rows="3"></textarea></div>
    <div class="f"><label>Next follow-up (optional)</label><input type="date" id="dNext" min="${today()}"></div>
    <div class="acts"><button class="btn sec" onclick="closeModal()">Cancel</button><button class="btn" id="dGo">Save</button></div>`);
  $('#dGo').onclick = async () => { await api('/api/crm', { action: 'activity_done', id, done: true, note: $('#dNote').value, next_at: $('#dNext').value || undefined }); closeModal(); toast('Follow-up closed'); refreshBadges(); refresh(); };
}
function activityModal(a, done) {
  const M = S.meta;
  modal(`<h2>${a.id ? 'Edit activity' : 'Log activity'}</h2>
    ${!a.card_code && !a.lead_id ? `<div class="f"><label>Customer</label><input id="aCust" list="custList" placeholder="Type a customer name or code"><datalist id="custList"></datalist></div>` : ''}
    <div class="fg"><div class="f"><label>Type</label><select id="aType">${opts(M.types.map(t => [t, ACT_L[t]]), a.type || 'call', null)}</select></div>
    <div class="f"><label>Follow up on</label><input type="date" id="aDue" value="${esc(d10(a.follow_up_at))}"></div>
    <div class="f"><label>Assigned to</label><select id="aOwn">${opts(M.staff.map(s => [s.email, s.name || s.email]), a.owner_email || S.me.email, null)}</select></div></div>
    <div class="toolbar" style="margin-top:-4px">${[['Tomorrow', 1], ['In 3 days', 3], ['Next week', 7], ['In a month', 30]].map(([l, n]) => `<button class="btn sm sec" data-dd="${n}">${l}</button>`).join('')}<button class="btn sm sec" data-dd="">No follow-up</button></div>
    <div class="f"><label>Subject</label><input id="aSub" value="${esc(a.subject || '')}" placeholder="e.g. Discussed December requirement of 2mm HR coils"></div>
    <div class="f"><label>Notes</label><textarea id="aNotes" rows="4">${esc(a.notes || '')}</textarea></div>
    ${a.id && a.follow_up_at ? `<label><input type="checkbox" id="aDone" ${a.done ? 'checked' : ''}> Follow-up done</label>` : ''}
    <div class="err" id="aErr"></div>
    <div class="acts">${a.id ? '<button class="btn danger" id="aDel">Delete</button><span class="sp"></span>' : ''}<button class="btn sec" onclick="closeModal()">Cancel</button><button class="btn" id="aGo">Save</button></div>`);
  $$('[data-dd]').forEach(b => b.onclick = () => { $('#aDue').value = b.dataset.dd ? addDays(today(), +b.dataset.dd) : ''; });
  if ($('#aCust')) loadCustomers().then(all => { $('#custList').innerHTML = all.map(c => `<option value="${esc(c.card_code)}">${esc(c.name)}</option>`).join(''); });
  if ($('#aDel')) $('#aDel').onclick = async () => { if (!confirm('Delete this activity?')) return; try { await api('/api/crm', { action: 'activity_delete', id: a.id }); closeModal(); done(); } catch (e) { $('#aErr').textContent = e.message; } };
  $('#aGo').onclick = async () => {
    try {
      await api('/api/crm', { action: 'activity_save', id: a.id, card_code: a.card_code || ($('#aCust') ? $('#aCust').value.trim() : ''), lead_id: a.lead_id, type: $('#aType').value, subject: $('#aSub').value,
        notes: $('#aNotes').value, follow_up_at: $('#aDue').value, owner_email: $('#aOwn').value, done: $('#aDone') ? $('#aDone').checked : !!a.done });
      closeModal(); toast('Saved'); refreshBadges(); done();
    } catch (e) { $('#aErr').textContent = e.message; }
  };
}

/* ================================================================= FOLLOW-UPS */
let FUmine = null;
async function viewFollowups() {
  loading();
  if (FUmine === null) FUmine = S.me.role === 'sales';
  const { rows } = await api('/api/crm', { action: 'activities', due: true, mine: FUmine });
  const t = today(), groups = [['Overdue', r => d10(r.follow_up_at) < t], ['Today', r => d10(r.follow_up_at) === t], ['Next 7 days', r => d10(r.follow_up_at) > t && d10(r.follow_up_at) <= addDays(t, 7)], ['Later', r => d10(r.follow_up_at) > addDays(t, 7)]];
  $('#main').innerHTML = `<h1 class="pg">Follow-ups</h1><p class="pgsub">Open follow-ups from calls, visits, leads and low feedback scores.</p>
    <div class="toolbar"><div class="seg"><button data-m="1" class="${FUmine ? 'on' : ''}">Mine</button><button data-m="0" class="${FUmine ? '' : 'on'}">Everyone</button></div><span class="sp"></span>${canEdit() ? '<button class="btn" id="fuNew">+ Log activity</button>' : ''}</div>
    ${groups.map(([l, f]) => { const g = rows.filter(f); return g.length ? `<div class="card"><h2>${l} <span class="chip ${l === 'Overdue' ? 'bad' : l === 'Today' ? 'warn' : ''}">${g.length}</span></h2>
      <table><tr><th>Due</th><th>Customer / lead</th><th>What</th><th>Assigned to</th><th></th></tr>${g.map(a => `<tr><td class="nowrap">${fdate(a.follow_up_at)}</td>
      <td>${a.card_code ? `<a href="#/c/${encodeURIComponent(a.card_code)}">${esc(a.customer || a.card_code)}</a>` : a.lead_id ? `<a href="#/leads?id=${a.lead_id}">${esc(a.lead_company || 'Lead')}</a> <span class="chip">lead</span>` : ''}</td>
      <td>${ACT_IC[a.type] || ''} <b>${esc(a.subject)}</b>${a.notes ? `<div class="small muted" style="white-space:pre-line">${esc(a.notes.slice(0, 220))}</div>` : ''}</td><td>${esc(a.owner_email || '')}</td>
      <td class="nowrap">${canEdit() ? `<button class="btn sm" data-adone="${a.id}">Done</button> <button class="btn sm sec" data-aedit="${a.id}">Edit</button>` : ''}</td></tr>`).join('')}</table></div>` : ''; }).join('') || '<div class="card empty">No open follow-ups. 🎉</div>'}`;
  $$('[data-m]').forEach(b => b.onclick = () => { FUmine = b.dataset.m === '1'; viewFollowups(); });
  bindTimeline($('#main'), viewFollowups, rows);
  if ($('#fuNew')) $('#fuNew').onclick = () => activityModal({}, viewFollowups);
}

/* ================================================================= LEADS */
const STAGE_L = { new: 'New', contacted: 'Contacted', quoted: 'Quoted', negotiation: 'Negotiation', won: 'Won', lost: 'Lost' };
async function viewLeads() {
  loading();
  const d = await api('/api/crm', { action: 'leads' });
  const focus = S.hq.get('id');
  const t = today();
  $('#main').innerHTML = `<h1 class="pg">Leads</h1><p class="pgsub">Enquiries from new buyers until they get a SAP ledger. Send the ledger form from a lead when it is won.</p>
    <div class="toolbar"><input type="search" id="lq" placeholder="Search leads"><span class="sp"></span>${canEdit() ? '<button class="btn" id="lNew">+ New lead</button>' : ''}</div>
    <div class="kanban" id="kb"></div>`;
  const draw = () => {
    const q = norm($('#lq').value);
    const rows = d.rows.filter(l => !q || norm([l.company, l.contact, l.city, l.phone, l.product].join(' ')).includes(q));
    $('#kb').innerHTML = d.stages.map(s => { const g = rows.filter(l => l.stage === s); return `<div class="col"><h3><span>${STAGE_L[s]}</span><span>${g.length}${g.some(l => l.est_mt) ? ' · ' + Math.round(g.reduce((a, l) => a + num(l.est_mt), 0)) + ' MT' : ''}</span></h3>
      ${g.map(l => `<div class="lead" data-lead="${l.id}"><div class="c">${esc(l.company)}</div><div class="m">${esc([l.contact, l.city].filter(Boolean).join(' · '))}</div>
        <div class="m">${esc(l.product || '')}${l.est_mt ? ` · ${num(l.est_mt)} MT/month` : ''}</div>
        ${l.next_action_at ? `<div class="m"><span class="chip ${d10(l.next_action_at) < t ? 'bad' : 'info'}">Next: ${fdate(l.next_action_at)}</span></div>` : ''}
        ${l.kyc_ref ? `<div class="m">Ledger form ${esc(l.kyc_ref)} · ${kycChip(l.kyc_status)}</div>` : ''}${l.lost_reason ? `<div class="m">Lost: ${esc(l.lost_reason)}</div>` : ''}</div>`).join('')}</div>`; }).join('');
    $$('[data-lead]').forEach(e => e.onclick = () => leadModal(d.rows.find(l => l.id === +e.dataset.lead), d));
  };
  $('#lq').oninput = draw; draw();
  if ($('#lNew')) $('#lNew').onclick = () => leadModal({ stage: 'new' }, d);
  if (focus) { const l = d.rows.find(x => x.id === +focus); if (l) leadModal(l, d); }
}
async function leadModal(l, d) {
  const M = S.meta, ro = !canEdit();
  const acts = l.id ? (await api('/api/crm', { action: 'activities', lead_id: l.id })).rows : [];
  modal(`<h2>${l.id ? esc(l.company) : 'New lead'} ${l.id ? `<span class="chip">${STAGE_L[l.stage]}</span>` : ''}</h2>
    <div class="fg"><div class="f"><label>Company *</label><input id="lc" value="${esc(l.company || '')}"></div><div class="f"><label>Contact person</label><input id="lp" value="${esc(l.contact || '')}"></div>
    <div class="f"><label>Phone</label><input id="lph" value="${esc(l.phone || '')}"></div><div class="f"><label>Email</label><input id="le" value="${esc(l.email || '')}"></div>
    <div class="f"><label>City</label><input id="lci" value="${esc(l.city || '')}"></div><div class="f"><label>Industry segment</label><select id="ls">${opts(M.segments, l.segment, '—')}</select></div>
    <div class="f"><label>Product interest</label><select id="lpr">${opts(d.products, l.product, '—')}</select></div><div class="f"><label>Estimated MT / month</label><input id="lmt" type="number" min="0" step="0.5" value="${esc(l.est_mt ?? '')}"></div>
    <div class="f"><label>Source</label><select id="lso">${opts(d.sources, l.source, '—')}</select></div><div class="f"><label>Stage</label><select id="lst">${opts(d.stages.map(s => [s, STAGE_L[s]]), l.stage, null)}</select></div>
    <div class="f"><label>Lost reason</label><select id="llr">${opts(d.lostReasons, l.lost_reason, '—')}</select></div><div class="f"><label>Next action on</label><input id="lnx" type="date" value="${esc(d10(l.next_action_at))}"></div>
    <div class="f"><label>Owner</label><select id="low">${opts(M.staff.map(s => [s.email, s.name || s.email]), l.owner_email || S.me.email, null)}</select></div><div class="f"><label>SAP code (once created)</label><input id="lcc" value="${esc(l.card_code || '')}" placeholder="e.g. C10234"></div></div>
    <div class="f"><label>Notes</label><textarea id="ln">${esc(l.notes || '')}</textarea></div>
    ${l.id ? `<h2 style="font-size:14px;margin-top:6px">Activity ${canEdit() ? '<button class="btn sm sec" id="lAct">+ Log</button>' : ''}</h2>${acts.length ? timeline(acts, true) : '<div class="muted small">No activity yet.</div>'}` : ''}
    <div class="err" id="lErr"></div>
    <div class="acts">${l.id && isAdmin() ? '<button class="btn danger" id="lDel">Delete</button>' : ''}${l.id && canEdit() && !l.kyc_id ? '<button class="btn sec" id="lKyc">Send ledger form</button>' : ''}<span class="sp"></span>
      <button class="btn sec" onclick="closeModal()">Close</button>${ro ? '' : '<button class="btn" id="lGo">Save</button>'}</div>`, 'wide');
  bindTimeline($('#modalRoot'), viewLeads, acts);
  if ($('#lAct')) $('#lAct').onclick = () => activityModal({ lead_id: l.id, type: 'call' }, () => { viewLeads(); });
  if ($('#lKyc')) $('#lKyc').onclick = () => inviteKyc({ company: l.company, phone: l.phone, email: l.email, contact_person: l.contact, lead_id: l.id });
  if ($('#lDel')) $('#lDel').onclick = async () => { if (confirm('Delete this lead and its activity?')) { await api('/api/crm', { action: 'lead_delete', id: l.id }); closeModal(); viewLeads(); } };
  if ($('#lGo')) $('#lGo').onclick = async () => {
    try {
      await api('/api/crm', { action: 'lead_save', id: l.id, company: $('#lc').value, contact: $('#lp').value, phone: $('#lph').value, email: $('#le').value, city: $('#lci').value, segment: $('#ls').value,
        product: $('#lpr').value, est_mt: $('#lmt').value, source: $('#lso').value, stage: $('#lst').value, lost_reason: $('#llr').value, next_action_at: $('#lnx').value, owner_email: $('#low').value,
        card_code: $('#lcc').value, notes: $('#ln').value });
      closeModal(); toast('Lead saved'); viewLeads();
    } catch (e) { $('#lErr').textContent = e.message; }
  };
}

/* ================================================================= LEDGER (KYC) FORMS */
const KYC_L = { invited: 'Link sent', submitted: 'New', review: 'Under review', approved: 'Approved', created: 'Created in SAP', rejected: 'Rejected' };
const KYC_C = { invited: '', submitted: 'warn', review: 'info', approved: 'info', created: 'ok', rejected: 'bad' };
const kycChip = s => `<span class="chip ${KYC_C[s] || ''}">${esc(KYC_L[s] || s)}</span>`;
let KF = 'open';
async function viewKyc(id) {
  if (id) return kycDetail(+id);
  loading();
  const d = await api('/api/kyc', { action: 'list' });
  const groups = { open: r => ['submitted', 'review', 'approved'].includes(r.status), invited: r => r.status === 'invited', created: r => r.status === 'created', rejected: r => r.status === 'rejected', all: () => true };
  const cnt = k => d.rows.filter(groups[k]).length;
  $('#main').innerHTML = `<h1 class="pg">Ledger forms (KYC)</h1><p class="pgsub">Customer ledger creation data sheets. New → review → approve → create in SAP. Requests are linked to the SAP customer automatically when the same GSTIN appears in SAP.</p>
    <div class="card">${shareBox(origin() + '/kyc', 'Public ledger form link', kycText(origin() + '/kyc'))}</div>
    <div class="toolbar"><div class="seg">${[['open', 'To process'], ['invited', 'Links sent'], ['created', 'In SAP'], ['rejected', 'Rejected'], ['all', 'All']].map(([k, l]) => `<button data-k="${k}" class="${KF === k ? 'on' : ''}">${l} (${cnt(k)})</button>`).join('')}</div>
      <input type="search" id="kq" placeholder="Search company, GSTIN, ref"><span class="sp"></span>
      ${canEdit() ? '<button class="btn" id="kInv">+ Send form to a customer</button><button class="btn sec" id="kImp">Import Google Form responses</button><button class="btn sec" id="kXl">SAP sheet (Excel)</button>' : ''}</div>
    <div class="tw" id="ktab"></div>`;
  const draw = () => {
    const q = norm($('#kq').value);
    const rows = d.rows.filter(groups[KF]).filter(r => !q || norm([r.company, r.gstin, r.ref, r.card_code, r.phone].join(' ')).includes(q));
    $('#ktab').innerHTML = rows.length ? `<table><tr><th>Ref</th><th>Company</th><th>GSTIN</th><th>Segment</th><th>Location</th><th>Docs</th><th>Checks</th><th>Status</th><th>Received</th></tr>
      ${rows.map(r => `<tr class="click" data-go="#/kyc/${r.id}"><td class="nowrap">${esc(r.ref || '#' + r.id)}<div class="small muted">${esc(r.source)}</div></td><td><b>${esc(r.company || '')}</b><div class="small muted">${esc(r.phone || '')} ${esc(r.email || '')}</div></td>
        <td>${esc(r.gstin || '')}</td><td>${esc(r.segment === 'Other' ? r.segment_other : r.segment || '')}<div class="small muted">${esc(r.usage || '')}</div></td><td>${esc([r.district, r.state].filter(Boolean).join(', '))}</td>
        <td class="n">${r.files || '—'}</td><td>${r.dup_n ? `<span class="chip bad">${r.dup_n} duplicate?</span> ` : ''}${r.warn_n ? `<span class="chip warn">${r.warn_n} to check</span>` : ''}</td>
        <td>${kycChip(r.status)}${r.card_code ? `<div class="small"><a href="#/c/${encodeURIComponent(r.card_code)}">${esc(r.card_code)}</a></div>` : ''}</td><td class="nowrap">${fdate(r.submitted_at || r.created_at)}</td></tr>`).join('')}</table>` : '<div class="empty">Nothing here.</div>';
    bindRowLinks($('#ktab'));
  };
  $$('.seg [data-k]').forEach(b => b.onclick = () => { KF = b.dataset.k; viewKyc(); });
  $('#kq').oninput = draw; draw();
  if ($('#kInv')) $('#kInv').onclick = () => inviteKyc({});
  if ($('#kImp')) $('#kImp').onclick = () => importModal('Import ledger form responses', 'In Google Forms open Responses → Link to Sheets (or the ⋮ menu → Download responses .csv). Upload that CSV or the Excel download of the sheet. Rows already imported are skipped; Drive links to the documents are kept.', async t => {
    const r = await api('/api/kyc', { action: 'import', headers: t.headers, rows: t.rows });
    return `${r.added} added, ${r.skipped} skipped.${r.problems.length ? '\n\nTo check:\n' + r.problems.join('\n') : ''}`;
  }, () => viewKyc());
  if ($('#kXl')) $('#kXl').onclick = async () => {
    const st = KF === 'open' ? 'approved' : '';
    const { rows } = await api('/api/kyc', { action: 'export', status: st });
    const R = rows.map(r => ({ ...r.data, ref: r.ref, status: KYC_L[r.status], card_code: r.card_code, submitted_at: r.submitted_at, review_note: r.review_note,
      segmentX: r.data.segment === 'Other' ? r.data.segment_other : r.data.segment, buyers: [...(r.data.buyer_types || []), r.data.buyer_other].filter(Boolean).join(', '), pan: (r.data.gstin || '').slice(2, 12) }));
    await downloadXlsx(`BSC-ledger-forms-${st || 'all'}-${today()}.xlsx`, 'Ledger data', [
      { h: 'Ref', k: 'ref', w: 13 }, { h: 'Status', k: 'status', w: 14 }, { h: 'SAP Code', k: 'card_code', w: 11 }, { h: 'Company Name', k: 'company', w: 34 }, { h: 'Company Type', k: 'company_type', w: 16 },
      { h: 'Contact Person', k: 'contact_person', w: 16 }, { h: 'Contact Number', k: 'phone', w: 14 }, { h: 'Email', k: 'email', w: 26 }, { h: 'Type of Buyer', k: 'buyers', w: 24 }, { h: 'Industry Segment', k: 'segmentX', w: 20 },
      { h: 'Usage', k: 'usage', w: 12 }, { h: 'Registration Type', k: 'reg_type', w: 14 }, { h: 'GSTIN (Billing)', k: 'gstin', w: 18 }, { h: 'PAN', k: 'pan', w: 12 },
      { h: 'Billing Address', k: 'bill_address', w: 40 }, { h: 'Billing District', k: 'bill_district', w: 14 }, { h: 'Billing Pincode', k: 'bill_pincode', w: 10 }, { h: 'Billing State', k: 'bill_state', w: 14 },
      { h: 'Ship-to Trade Name', k: 'ship_trade_name', w: 28 }, { h: 'Shipping Address', k: 'ship_address', w: 40 }, { h: 'Shipping District', k: 'ship_district', w: 14 }, { h: 'Shipping Pincode', k: 'ship_pincode', w: 10 },
      { h: 'Shipping State', k: 'ship_state', w: 14 }, { h: 'GSTIN (Shipping)', k: 'ship_gstin', w: 18 }, { h: 'Bank Trade Name', k: 'bank_name', w: 24 }, { h: 'Bank Account No.', v: r => r.bank_account ? String(r.bank_account) : '', w: 18 },
      { h: 'IFSC', k: 'ifsc', w: 13 }, { h: 'Received', k: 'submitted_at', fmt: 'date', w: 12 }, { h: 'Review note', k: 'review_note', w: 30 }], R, `Bharat Steel (Chennai) Pvt. Ltd. — SAP ledger creation data — ${st ? 'approved, to create' : 'all'} — ${fdate(today())}`);
  };
}
async function kycDetail(id) {
  loading();
  const { row: r, files, sap, checks, docs } = await api('/api/kyc', { action: 'get', id });
  const k = r.data || {}, ed = canEdit();
  const F = (label, v) => `<dt>${esc(label)}</dt><dd>${v == null || v === '' ? '<span class="muted">—</span>' : esc(v)}</dd>`;
  const segment = k.segment === 'Other' ? `Other: ${k.segment_other || ''}` : k.segment;
  $('#main').innerHTML = `<p><a href="#/kyc">← Ledger forms</a></p>
    <div class="card"><div class="c360h"><div><h1>${esc(r.company || k.company || 'Ledger request')}</h1><div class="meta"><span>${esc(r.ref || '#' + r.id)}</span>${kycChip(r.status)}<span>Source: ${esc(r.source)}</span>
      <span>Received ${fdt(r.submitted_at || r.created_at)}</span>${r.reviewed_by ? `<span>Last action by ${esc(r.reviewed_by)}</span>` : ''}</div></div>
      <div class="acts">${r.status === 'invited' ? `<button class="btn sec" data-copy="${esc(origin() + '/kyc')}">Copy form link</button>${ed ? '<button class="btn" id="kRes">Send link again</button>' : ''}` : ''}${isAdmin() ? '<button class="btn danger" id="kDel">Delete</button>' : ''}</div></div></div>
    ${(k._sent || []).length ? `<div class="card"><h2>Form link sent</h2>${k._sent.slice().reverse().map(x => `<div class="small" style="padding:4px 0">${x.ok ? '✅' : '❌'} ${x.via === 'email' ? 'Email' : 'WhatsApp'} · ${fdt(x.at)} · ${esc(x.by || '')} — ${esc(x.message)}</div>`).join('')}</div>` : ''}
    ${checks.length ? `<div class="banner bad"><b>Possible duplicate:</b><br>${checks.map(esc).join('<br>')}</div>` : ''}
    ${(k._warnings || []).length ? `<div class="banner warn"><b>Please check:</b><br>${k._warnings.map(esc).join('<br>')}</div>` : ''}
    <div class="row"><div class="card" style="flex:2"><h2>Company</h2><dl class="kv">${F('Company Name', k.company)}${F('Company Type', k.company_type)}${F('Contact Person', k.contact_person)}${F('Contact Number', k.phone)}${F('Email', k.email)}
      ${F('Type of Buyer', [...(k.buyer_types || []), k.buyer_other].filter(Boolean).join(', '))}${F('Industry Segment', segment)}${F('Usage', k.usage)}${F('Registration Type', k.reg_type)}</dl>
      <h2 style="margin-top:18px">Billing address</h2><dl class="kv">${F('Address', k.bill_address)}${F('District', k.bill_district)}${F('Pincode', k.bill_pincode)}${F('State', k.bill_state)}${F('GST Number', k.gstin)}${F('PAN', (k.gstin || '').slice(2, 12))}</dl>
      <h2 style="margin-top:18px">Bank details</h2><dl class="kv">${F('Bank Trade Name', k.bank_name)}${F('Account Number', k.bank_account)}${F('IFSC', k.ifsc)}</dl>
      <h2 style="margin-top:18px">Shipping address</h2><dl class="kv">${k.ship_same ? '<dt></dt><dd><span class="chip">Same as billing</span></dd>' : ''}${F('Trade Name', k.ship_trade_name)}${F('Address', k.ship_address)}${F('District', k.ship_district)}${F('Pincode', k.ship_pincode)}${F('State', k.ship_state)}${F('GST Number', k.ship_gstin)}</dl>
      <h2 style="margin-top:18px">Documents</h2><div class="files">${files.length ? files.map(f => `<a href="/api/files?id=${f.id}" target="_blank" rel="noopener">📄 ${esc(docs[f.doc_type] || f.doc_type)}${f.external ? ' (Drive)' : ''}</a>`).join('') : '<span class="muted">No documents uploaded.</span>'}</div>
    </div>
    <div class="card"><h2>Review</h2>
      ${sap ? `<div class="banner ok">Linked to SAP: <a href="#/c/${encodeURIComponent(sap.card_code)}"><b>${esc(sap.card_code)}</b> · ${esc(sap.name)}</a></div>` : ''}
      ${ed ? `<div class="f"><label>Status</label><select id="kSt">${opts(Object.entries(KYC_L).filter(([s]) => s !== 'invited' || r.status === 'invited'), r.status, null)}</select></div>
      <div class="f"><label>SAP customer code</label><input id="kCode" value="${esc(r.card_code || '')}" placeholder="Fill when created in SAP, e.g. C10234" list="kCust"><datalist id="kCust"></datalist></div>
      <div class="f"><label>Note</label><textarea id="kNote" rows="4">${esc(r.review_note || '')}</textarea></div><div class="err" id="kErr"></div>
      <div class="toolbar"><button class="btn" id="kSave">Save</button><button class="btn sec" id="kEdit">Correct details</button></div>
      <p class="small muted">“Approved” = details checked, ready for accounts to create the ledger in SAP (download the SAP sheet). Marking “Created in SAP” needs the SAP code; the customer's segment, buyer type and usage are then copied to the CRM profile.</p>`
      : `<dl class="kv">${F('Note', r.review_note)}</dl>`}
      ${k.phone ? `<a class="btn wa sm" target="_blank" rel="noopener" href="${waLink(k.phone, `Dear ${k.contact_person || 'Sir/Madam'}, regarding your ledger form ${r.ref} with Bharat Steel (Chennai) Pvt. Ltd.: `)}">WhatsApp customer</a>` : ''}
    </div></div>`;
  if ($('#kCode')) loadCustomers().then(all => { $('#kCust').innerHTML = all.map(c => `<option value="${esc(c.card_code)}">${esc(c.name)}</option>`).join(''); });
  if ($('#kSave')) $('#kSave').onclick = async () => {
    try { await api('/api/kyc', { action: 'update', id, status: $('#kSt').value, card_code: $('#kCode').value.trim(), review_note: $('#kNote').value }); toast('Saved'); refreshBadges(); kycDetail(id); }
    catch (e) { $('#kErr').textContent = e.message; }
  };
  if ($('#kEdit')) $('#kEdit').onclick = () => kycEditModal(r, () => kycDetail(id));
  if ($('#kRes')) $('#kRes').onclick = () => resendKyc(r, () => kycDetail(id));
  if ($('#kDel')) $('#kDel').onclick = async () => { if (confirm('Delete this ledger request and its documents?')) { await api('/api/kyc', { action: 'delete', id }); location.hash = '#/kyc'; } };
}
function kycEditModal(r, done) {
  const k = r.data || {};
  const fields = [['company', 'Company Name'], ['company_type', 'Company Type'], ['contact_person', 'Contact Person'], ['phone', 'Contact Number'], ['email', 'Email'], ['gstin', 'GST Number (billing)'],
    ['bill_address', 'Billing Address'], ['bill_district', 'Billing District'], ['bill_pincode', 'Billing Pincode'], ['bill_state', 'Billing State'], ['bank_name', 'Bank Trade Name'], ['bank_account', 'Account Number'], ['ifsc', 'IFSC'],
    ['ship_trade_name', 'Ship-to Trade Name'], ['ship_address', 'Shipping Address'], ['ship_district', 'Shipping District'], ['ship_pincode', 'Shipping Pincode'], ['ship_state', 'Shipping State'], ['ship_gstin', 'GST Number (shipping)']];
  modal(`<h2>Correct details</h2><div class="fg">${fields.map(([f, l]) => `<div class="f"><label>${l}</label><input data-f="${f}" value="${esc(k[f] || '')}"></div>`).join('')}
    <div class="f"><label>Industry Segment</label><select data-f="segment">${opts([...S.meta.segments, 'Other'], k.segment, '—')}</select></div><div class="f"><label>Usage</label><select data-f="usage">${opts(S.meta.usage, k.usage, '—')}</select></div>
    <div class="f"><label>Registration Type</label><select data-f="reg_type">${opts(S.meta.regTypes, k.reg_type, '—')}</select></div></div>
    <div class="err" id="keErr"></div><div class="acts"><button class="btn sec" onclick="closeModal()">Cancel</button><button class="btn" id="keGo">Save corrections</button></div>`, 'wide');
  $('#keGo').onclick = async () => {
    const data = { buyer_types: k.buyer_types, buyer_other: k.buyer_other, segment_other: k.segment_other, ship_same: false };
    $$('[data-f]').forEach(i => { data[i.dataset.f] = i.value; });
    try { await api('/api/kyc', { action: 'update', id: r.id, data }); closeModal(); toast('Corrected'); done(); } catch (e) { $('#keErr').textContent = e.message; }
  };
}
const sentList = sent => (sent || []).map(x => `<div class="banner ${x.ok ? 'ok' : 'bad'}" style="margin:8px 0 0">${x.via === 'email' ? '✉️' : '💬'} ${esc(x.message)}</div>`).join('');
const sendChecks = () => `<div class="f"><label>Send the link to the customer</label>
  <label style="display:block;font-weight:500;color:var(--ink);margin:4px 0"><input type="checkbox" id="iSE" ${S.meta.emailReady ? 'checked' : 'disabled'}> By email from info@bharatsteels.in (with QR code)${S.meta.emailReady ? '' : ' <span class="muted small">— email not set up yet</span>'}</label>
  <label style="display:block;font-weight:500;color:var(--ink);margin:4px 0"><input type="checkbox" id="iSW" ${S.meta.whatsappReady ? 'checked' : 'disabled'}> By WhatsApp (WATI)${S.meta.whatsappReady ? '' : ' <span class="muted small">— WhatsApp not set up yet</span>'}</label></div>`;
function inviteKyc(pre) {
  modal(`<h2>Send ledger form</h2><p class="small muted" style="margin-top:-8px">Sends the ledger form link and QR code to the customer. When they submit it with this mobile, email or GSTIN, the form is matched to this request${pre.card_code || pre.lead_id ? ' (and to the SAP customer / lead)' : ''}.</p>
    <div class="fg"><div class="f"><label>Company *</label><input id="iC" value="${esc(pre.company || '')}"></div><div class="f"><label>Contact person</label><input id="iP" value="${esc(pre.contact_person || '')}"></div>
    <div class="f"><label>Mobile (WhatsApp)</label><input id="iM" value="${esc(pre.phone || '')}"></div><div class="f"><label>Email</label><input id="iE" type="email" value="${esc(pre.email || '')}"></div></div>
    ${pre.card_code ? `<div class="banner info">For SAP customer ${esc(pre.card_code)}.</div>` : ''}
    ${sendChecks()}
    <div class="err" id="iErr"></div><div id="iOut"></div><div class="acts"><button class="btn sec" onclick="closeModal()">Close</button><button class="btn" id="iGo">Send</button></div>`);
  $('#iGo').onclick = async () => {
    const email = $('#iE').value.trim(), phone = $('#iM').value.trim(), se = $('#iSE').checked, sw = $('#iSW').checked;
    if (se && email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { $('#iErr').textContent = 'Check the email address'; return; }
    if (se && !email && sw && !phone) { $('#iErr').textContent = 'Enter an email or a mobile number to send the link to'; return; }
    $('#iGo').disabled = true; $('#iGo').textContent = 'Sending…'; $('#iErr').textContent = '';
    try {
      const r = await api('/api/kyc', { action: 'invite', company: $('#iC').value, contact_person: $('#iP').value, phone, email, card_code: pre.card_code, lead_id: pre.lead_id,
        send_email: se && !!email, send_wa: sw && !!phone });
      const url = `${origin()}/kyc`;
      $('#iGo').remove();
      const skipped = [se && !email ? 'No email entered, so no email was sent.' : '', sw && !phone ? 'No mobile entered, so no WhatsApp was sent.' : ''].filter(Boolean);
      $('#iOut').innerHTML = `${sentList(r.sent)}${skipped.map(t => `<div class="banner warn" style="margin:8px 0 0">${t}</div>`).join('')}
        <div style="margin-top:12px">${shareBox(url, 'Ledger form link', kycText(url, r.company))}</div>`;
      refreshBadges();
    } catch (e) { $('#iErr').textContent = e.message; $('#iGo').disabled = false; $('#iGo').textContent = 'Send'; }
  };
}
function resendKyc(r, done) {
  const k = r.data || {};
  modal(`<h2>Send the form link again</h2>
    <div class="fg"><div class="f"><label>Mobile (WhatsApp)</label><input id="iM" value="${esc(k.phone || '')}"></div><div class="f"><label>Email</label><input id="iE" type="email" value="${esc(k.email || '')}"></div></div>
    ${sendChecks()}<div class="err" id="iErr"></div><div id="iOut"></div>
    <div class="acts"><button class="btn sec" id="iCl">Close</button><button class="btn" id="iGo">Send</button></div>`);
  $('#iCl').onclick = () => { closeModal(); done(); };
  $('#iGo').onclick = async () => {
    $('#iGo').disabled = true;
    try { const x = await api('/api/kyc', { action: 'resend', id: r.id, email: $('#iE').value, phone: $('#iM').value, send_email: $('#iSE').checked && !!$('#iE').value.trim(), send_wa: $('#iSW').checked && !!$('#iM').value.trim() });
      $('#iOut').innerHTML = sentList(x.sent) || '<div class="banner warn" style="margin:8px 0 0">Nothing sent — enter an email or a mobile number.</div>'; }
    catch (e) { $('#iErr').textContent = e.message; } finally { $('#iGo').disabled = false; }
  };
}
function importModal(title, help, run, done) {
  modal(`<h2>${esc(title)}</h2><p class="small muted">${esc(help)}</p><input type="file" id="imF" accept=".csv,.xlsx"><div class="err" id="imErr" style="margin-top:10px"></div>
    <pre id="imOut" class="small" style="white-space:pre-wrap;max-height:300px;overflow:auto"></pre><div class="acts"><button class="btn sec" id="imClose">Close</button><button class="btn" id="imGo">Import</button></div>`);
  $('#imClose').onclick = () => { closeModal(); done(); };
  $('#imGo').onclick = async () => {
    const f = $('#imF').files[0]; if (!f) { $('#imErr').textContent = 'Choose the file first'; return; }
    $('#imGo').disabled = true; $('#imOut').textContent = 'Importing…';
    try { const t = await readTable(f); $('#imOut').textContent = `${t.rows.length} rows read. ` + await run(t); }
    catch (e) { $('#imErr').textContent = e.message; $('#imOut').textContent = ''; }
    finally { $('#imGo').disabled = false; }
  };
}

/* ================================================================= FEEDBACK */
const FB_C = { new: ['New', ''], followup: ['Needs follow-up', 'bad'], closed: ['Closed', 'ok'] };
const fbStatusChip = s => `<span class="chip ${FB_C[s]?.[1] || ''}">${FB_C[s]?.[0] || esc(s)}</span>`;
const DISC = { eligible: ['Discount due', 'warn'], applied: ['Discount given', 'ok'], na: ['No discount', ''] };
const discChip = s => `<span class="chip ${DISC[s]?.[1] || ''}">${DISC[s]?.[0] || esc(s)}</span>`;
const DIV = ['#1b64be', '#84b9f3', '#d4d7dd', '#f0908f', '#dc3c3d'];   // 5 → 1 : blue = good, grey = neutral, red = poor
const FBF = { period: '90', slp: '', tab: 'analytics', st: 'followup' };
async function viewFeedback() {
  loading();
  const d = await api('/api/feedback', { action: 'list' }); S.cache.fb = d;
  const Q = d.questions;
  const fyStart = (() => { const t = today(); const y = +t.slice(0, 4) - (+t.slice(5, 7) < 4 ? 1 : 0); return `${y}-04-01`; })();
  const from = FBF.period === 'all' ? '0000' : FBF.period === 'fy' ? fyStart : addDays(today(), -+FBF.period);
  const slps = [...new Set(d.rows.map(r => r.slp_name || r.cust_slp).filter(Boolean))].sort();
  const rows = d.rows.filter(r => d10(r.created_at) >= from && (!FBF.slp || (r.slp_name || r.cust_slp) === FBF.slp));
  const answers = rows.flatMap(r => Q.map(q => r[q.key]).filter(v => v != null));
  const avg = rows.length ? rows.reduce((a, r) => a + num(r.score), 0) / rows.length : null;
  const csat = answers.length ? Math.round((100 * answers.filter(v => v >= 4).length) / answers.length) : null;
  const lowN = rows.filter(r => Q.some(q => r[q.key] != null && r[q.key] <= d.lowScore)).length;
  const linked = rows.filter(r => r.card_code).length;
  const open = d.rows.filter(r => r.status === 'followup'), discDue = d.rows.filter(r => r.discount === 'eligible');
  $('#main').innerHTML = `<h1 class="pg">Customer feedback</h1><p class="pgsub">Responses to the feedback form, matched to the SAP invoice and customer.</p>
    <div class="card">${shareBox(origin() + '/feedback', 'Public feedback form link', fbText())}<p class="small muted" style="margin:10px 0 0">Tip: add <code>?inv=INVOICE-NO</code> to the link (the customer page does this for you) so the invoice number is filled in. Put the QR on invoices / delivery challans.</p></div>
    <div class="toolbar"><div class="seg">${[['analytics', 'Analytics'], ['responses', 'Responses']].map(([k, l]) => `<button data-tab="${k}" class="${FBF.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <select id="fbP">${opts([['30', 'Last 30 days'], ['90', 'Last 90 days'], ['180', 'Last 6 months'], ['365', 'Last 12 months'], ['fy', 'This financial year'], ['all', 'All time']], FBF.period, null)}</select>
      <select id="fbS">${opts(slps, FBF.slp, 'All salespersons')}</select><span class="sp"></span>
      ${canEdit() ? '<button class="btn sec" id="fbRel">Re-match invoices</button><button class="btn sec" id="fbImp">Import Microsoft Forms</button>' : ''}<button class="btn sec" id="fbXl">Export Excel</button></div>
    <div id="fbBody"></div>`;
  $$('[data-tab]').forEach(b => b.onclick = () => { FBF.tab = b.dataset.tab; viewFeedback(); });
  $('#fbP').onchange = e => { FBF.period = e.target.value; viewFeedback(); };
  $('#fbS').onchange = e => { FBF.slp = e.target.value; viewFeedback(); };
  if ($('#fbRel')) $('#fbRel').onclick = async () => { const r = await api('/api/feedback', { action: 'relink' }); toast(`${r.linked} of ${r.checked} unmatched responses matched to SAP`); viewFeedback(); };
  if ($('#fbImp')) $('#fbImp').onclick = () => importModal('Import Microsoft Forms responses', 'In Microsoft Forms open the form → Responses → Open results in Excel, save it, and upload the .xlsx here. Already-imported rows are skipped. Imported responses older than 90 days are marked “no discount”.', async t => {
    const r = await api('/api/feedback', { action: 'import', headers: t.headers, rows: t.rows }); return `${r.added} added, ${r.skipped} skipped.`; }, viewFeedback);
  $('#fbXl').onclick = () => downloadXlsx(`BSC-feedback-${today()}.xlsx`, 'Feedback', [
    { h: 'Date', k: 'created_at', fmt: 'date', w: 12 }, { h: 'Invoice No.', k: 'invoice_no', w: 16 }, { h: 'SAP Code', k: 'card_code', w: 11 }, { h: 'Customer', v: r => r.sap_name || r.customer_name, w: 32 },
    { h: 'Salesperson', v: r => r.slp_name || r.cust_slp, w: 14 }, { h: 'Segment', k: 'segment', w: 18 }, ...Q.map(q => ({ h: q.short + ' (1–5)', k: q.key, fmt: 'num', w: 12 })),
    { h: 'Average', k: 'score', fmt: 'num', w: 9 }, { h: 'Comment', k: 'comment', w: 40 }, { h: 'Status', v: r => FB_C[r.status]?.[0], w: 14 }, { h: 'Action taken', k: 'action_note', w: 30 },
    { h: 'Discount', v: r => DISC[r.discount]?.[0], w: 13 }, { h: 'Discount note', k: 'discount_note', w: 24 }, { h: 'Source', k: 'source', w: 8 }], rows, `Bharat Steel (Chennai) Pvt. Ltd. — Customer feedback — ${fdate(today())}`);

  if (FBF.tab === 'responses') {
    const list = FBF.st === 'all' ? d.rows : FBF.st === 'disc' ? discDue : FBF.st === 'unlinked' ? d.rows.filter(r => !r.card_code) : open;
    $('#fbBody').innerHTML = `<div class="toolbar"><div class="seg">${[['followup', `Needs follow-up (${open.length})`], ['disc', `Discount due (${discDue.length})`], ['unlinked', `Not matched to SAP (${d.rows.filter(r => !r.card_code).length})`], ['all', `All (${d.rows.length})`]].map(([k, l]) => `<button data-st="${k}" class="${FBF.st === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <div class="tw">${list.length ? `<table><tr><th>Date</th><th>Customer</th><th>Invoice</th>${Q.map(q => `<th class="n" title="${esc(q.text)}">${esc(q.short)}</th>`).join('')}<th class="n">Avg</th><th>Comment</th><th>Status</th><th>Discount</th></tr>
      ${list.map(r => `<tr class="click" data-fb="${r.id}"><td class="nowrap">${fdate(r.created_at)}</td><td>${r.card_code ? `<b>${esc(r.sap_name || r.customer_name)}</b><div class="small muted">${esc(r.card_code)} · ${esc(r.slp_name || r.cust_slp || '')}</div>` : '<span class="chip warn">Not matched</span>'}</td>
        <td>${esc(r.invoice_no || '—')}${r.invoice_qty ? `<div class="small muted">${mt(r.invoice_qty)}</div>` : ''}</td>${Q.map(q => `<td class="n" style="${r[q.key] != null && r[q.key] <= d.lowScore ? 'color:var(--bad);font-weight:700' : ''}">${r[q.key] ?? '—'}</td>`).join('')}
        <td class="n b">${num(r.score).toFixed(2)}</td><td style="max-width:260px">${esc(r.comment || '')}</td><td>${fbStatusChip(r.status)}</td><td>${discChip(r.discount)}</td></tr>`).join('')}</table>` : '<div class="empty">Nothing here.</div>'}</div>`;
    $$('[data-st]').forEach(b => b.onclick = () => { FBF.st = b.dataset.st; viewFeedback(); });
    $$('[data-fb]').forEach(r => r.onclick = () => feedbackModal(+r.dataset.fb, viewFeedback));
    return;
  }
  // ---- analytics ----
  const qStats = Q.map(q => { const v = rows.map(r => r[q.key]).filter(x => x != null); const dist = [5, 4, 3, 2, 1].map(s => v.filter(x => x === s).length);
    return { q, n: v.length, avg: v.length ? v.reduce((a, x) => a + x, 0) / v.length : null, dist }; });
  const months = lastN(12);
  const byM = Object.fromEntries(months.map(m => [m, d.rows.filter(r => String(r.created_at).slice(0, 7) === m && (!FBF.slp || (r.slp_name || r.cust_slp) === FBF.slp))]));
  const group = key => { const g = {}; for (const r of rows) { const k = key(r) || '—'; (g[k] = g[k] || []).push(r); } return Object.entries(g).map(([k, v]) => ({ k, n: v.length, avg: v.reduce((a, r) => a + num(r.score), 0) / v.length, low: v.filter(r => Q.some(q => r[q.key] != null && r[q.key] <= d.lowScore)).length })).sort((a, b) => b.n - a.n); };
  const gTable = (title, list) => `<div class="card"><h2>${title}</h2>${list.length ? `<table><tr><th></th><th class="n">Responses</th><th class="n">Avg score</th><th class="n">With a low rating</th></tr>${list.slice(0, 12).map(x => `<tr><td>${esc(x.k)}</td><td class="n">${x.n}</td><td class="n b">${x.avg.toFixed(2)}</td><td class="n" style="${x.low ? 'color:var(--bad)' : ''}">${x.low}</td></tr>`).join('')}</table>` : '<div class="muted small">No data</div>'}</div>`;
  const best = qStats.filter(s => s.avg != null).sort((a, b) => b.avg - a.avg);
  $('#fbBody').innerHTML = rows.length ? `
    <div class="kpis"><div class="kpi"><div class="l">Responses</div><div class="v">${rows.length}</div><div class="s">${linked} matched to SAP invoices</div></div>
      <div class="kpi"><div class="l">Average score</div><div class="v">${avg.toFixed(2)}<span class="muted" style="font-size:14px"> / 5</span></div><div class="s">all answers, 5 = best</div></div>
      <div class="kpi"><div class="l">Satisfaction (CSAT)</div><div class="v">${csat}%</div><div class="s">answers in the top two options</div></div>
      <div class="kpi ${lowN ? 'alert' : ''}"><div class="l">Responses with a low rating</div><div class="v">${lowN}</div><div class="s">any answer scored ${d.lowScore} or below</div></div>
      <a class="kpi ${open.length ? 'alert' : ''}" href="#/feedback" id="kOpen"><div class="l">Open issues (all time)</div><div class="v">${open.length}</div><div class="s">waiting for follow-up</div></a>
      <a class="kpi" href="#/feedback" id="kDisc"><div class="l">Discounts due</div><div class="v">${discDue.length}</div><div class="s">Rs.${d.discountPerTon}/ton on next purchase</div></a></div>
    <div class="row"><div class="card" style="flex:1.3"><h2>Score by question <small>average, 1–5</small></h2>
      ${qStats.map(s => `<div class="qbar"><div>${esc(s.q.short)}${s.q.required ? '' : ' <span class="small muted">(optional)</span>'}</div>
        <div class="stack" style="height:18px">${s.dist.map((n, i) => n ? `<span style="width:${(100 * n) / s.n}%;background:${DIV[i]}" data-tip="<b>${esc(s.q.short)}</b><br>${esc(s.q.options[i])}: ${n} (${Math.round((100 * n) / s.n)}%)"></span>` : '').join('')}</div>
        <div class="s">${s.avg != null ? s.avg.toFixed(2) : '—'}</div></div>`).join('')}
      <div class="lg">${['Top option (5)', '4', 'Middle (3)', '2', 'Lowest option (1)'].map((l, i) => `<span><i style="background:${DIV[i]}"></i>${l}</span>`).join('')}</div>
      ${best.length > 1 ? `<p class="small muted" style="margin:12px 0 0">Strongest: <b>${esc(best[0].q.short)}</b> (${best[0].avg.toFixed(2)}). Weakest: <b>${esc(best[best.length - 1].q.short)}</b> (${best[best.length - 1].avg.toFixed(2)}).</p>` : ''}</div>
      <div class="card"><h2>Responses per month <small>last 12 months</small></h2>${barChart(months.map(m => ({ label: ym(m), value: byM[m].length, tip: `<b>${ym(m)}</b><br>${byM[m].length} responses` })), { h: 170, fmt: v => String(Math.round(v)) })}
        <h2 style="margin-top:14px">Average score per month</h2>${lineChart(months.map(m => ({ label: ym(m), value: byM[m].length ? byM[m].reduce((a, r) => a + num(r.score), 0) / byM[m].length : null, tip: `<b>${ym(m)}</b><br>${byM[m].length ? (byM[m].reduce((a, r) => a + num(r.score), 0) / byM[m].length).toFixed(2) + ' average · ' + byM[m].length + ' responses' : 'No responses'}` })), { h: 170 })}</div></div>
    <div class="row">${gTable('By salesperson', group(r => r.slp_name || r.cust_slp))}${gTable('By industry segment', group(r => r.segment))}</div>
    <div class="card"><h2>Latest comments</h2>${rows.filter(r => r.comment).slice(0, 15).map(r => `<div style="padding:8px 0;border-bottom:1px solid var(--line)"><span class="chip ${num(r.score) < 3 ? 'bad' : num(r.score) < 4 ? 'warn' : 'ok'}">${num(r.score).toFixed(1)}</span> ${esc(r.comment)} <span class="small muted">— ${esc(r.sap_name || r.customer_name || 'not matched')}, ${fdate(r.created_at)}</span></div>`).join('') || '<div class="muted small">No comments in this period.</div>'}</div>`
    : '<div class="card empty">No responses in this period.</div>';
  if ($('#kOpen')) $('#kOpen').onclick = e => { e.preventDefault(); FBF.tab = 'responses'; FBF.st = 'followup'; viewFeedback(); };
  if ($('#kDisc')) $('#kDisc').onclick = e => { e.preventDefault(); FBF.tab = 'responses'; FBF.st = 'disc'; viewFeedback(); };
}
async function feedbackModal(id, done) {
  const d = S.cache.fb && S.cache.fb.rows.find(r => r.id === id) ? S.cache.fb : (S.cache.fb = await api('/api/feedback', { action: 'list' }));
  const r = d.rows.find(x => x.id === id); if (!r) return;
  const ed = canEdit(), M = S.meta;
  modal(`<h2>Feedback · ${fdate(r.created_at)} ${fbStatusChip(r.status)}</h2>
    <dl class="kv"><dt>Customer</dt><dd>${r.card_code ? `<a href="#/c/${encodeURIComponent(r.card_code)}">${esc(r.sap_name || r.customer_name)}</a> (${esc(r.card_code)})` : '<span class="chip warn">Not matched to SAP</span>'}</dd>
      <dt>Invoice</dt><dd>${esc(r.invoice_no || '—')}${r.invoice_date ? ` · ${fdate(r.invoice_date)}` : ''}${r.invoice_qty ? ` · ${mt(r.invoice_qty)}` : ''}${r.slp_name ? ` · ${esc(r.slp_name)}` : ''}</dd>
      ${d.questions.map(q => `<dt>${esc(q.short)}</dt><dd><b style="${r[q.key] != null && r[q.key] <= d.lowScore ? 'color:var(--bad)' : ''}">${esc(r.answers?.[q.key] || '—')}</b>${r[q.key] != null ? ` <span class="muted">(${r[q.key]}/5)</span>` : ''}</dd>`).join('')}
      <dt>Comment</dt><dd>${esc(r.comment || '—')}</dd><dt>Source</dt><dd>${esc(r.source)}</dd></dl>
    ${ed ? `<hr style="border:0;border-top:1px solid var(--line);margin:14px 0"><div class="fg">
      <div class="f"><label>Status</label><select id="fSt">${opts(Object.entries(FB_C).map(([k, v]) => [k, v[0]]), r.status, null)}</select></div>
      <div class="f"><label>Assigned to</label><select id="fAs">${opts(M.staff.map(s => [s.email, s.name || s.email]), r.assigned_to, '—')}</select></div>
      <div class="f"><label>Discount (Rs.${d.discountPerTon}/ton)</label><select id="fDi">${opts(Object.entries(DISC).map(([k, v]) => [k, v[0]]), r.discount, null)}</select></div>
      <div class="f"><label>SAP customer code</label><input id="fCc" value="${esc(r.card_code || '')}"></div></div>
      <div class="f"><label>Action taken</label><textarea id="fAn" rows="3" placeholder="What was done about this feedback">${esc(r.action_note || '')}</textarea></div>
      <div class="f"><label>Discount note</label><input id="fDn" value="${esc(r.discount_note || '')}" placeholder="e.g. Given on invoice BSC/25-26/24311"></div>` : `<dl class="kv"><dt>Action</dt><dd>${esc(r.action_note || '—')}</dd><dt>Discount</dt><dd>${discChip(r.discount)} ${esc(r.discount_note || '')}</dd></dl>`}
    <div class="err" id="fErr"></div>
    <div class="acts">${isAdmin() ? '<button class="btn danger" id="fDel">Delete</button>' : ''}<span class="sp"></span><button class="btn sec" onclick="closeModal()">Close</button>${ed ? '<button class="btn" id="fGo">Save</button>' : ''}</div>`, 'wide');
  if ($('#fDel')) $('#fDel').onclick = async () => { if (confirm('Delete this response?')) { await api('/api/feedback', { action: 'delete', id }); S.cache.fb = null; closeModal(); done(); } };
  if ($('#fGo')) $('#fGo').onclick = async () => {
    try { await api('/api/feedback', { action: 'update', id, status: $('#fSt').value, assigned_to: $('#fAs').value, discount: $('#fDi').value, card_code: $('#fCc').value.trim(), action_note: $('#fAn').value, discount_note: $('#fDn').value });
      S.cache.fb = null; closeModal(); toast('Saved'); refreshBadges(); done(); }
    catch (e) { $('#fErr').textContent = e.message; }
  };
}

/* ================================================================= ADMIN */
let ADtab = 'users';
async function viewAdmin() {
  if (!isAdmin()) { $('#main').innerHTML = '<div class="banner bad">Admins only.</div>'; return; }
  loading();
  const [u, c] = await Promise.all([api('/api/users', { action: 'list' }), api('/api/users', { action: 'config' })]);
  const cfg = c.config, slpOpts = u.slps.map(s => [s.slp_code, `${s.slp_name || 'Code ' + s.slp_code} (${s.customers})`]);
  $('#main').innerHTML = `<h1 class="pg">Admin</h1><div class="tabs">${[['users', 'Users'], ['settings', 'Settings'], ['log', 'Activity log']].map(([k, l]) => `<button data-ad="${k}" class="${ADtab === k ? 'on' : ''}">${l}</button>`).join('')}</div><div id="adb"></div>`;
  $$('[data-ad]').forEach(b => b.onclick = () => { ADtab = b.dataset.ad; viewAdmin(); });
  if (ADtab === 'users') {
    $('#adb').innerHTML = `<div class="card"><h2>Users <span class="sp"></span><button class="btn sm" id="uNew">+ Add user</button></h2>
      <p class="small muted">People who open the CRM from the Bharat Steel Group portal get an account automatically (Sales role). Link a salesperson to their SAP sales employee so “My customers” works.</p>
      <table><tr><th>Name</th><th>Email</th><th>Role</th><th>SAP sales employee</th><th>Active</th><th></th></tr>${u.users.map(x => `<tr><td><input data-u="${x.id}" data-k="name" value="${esc(x.name)}" style="width:100%;border:1px solid var(--line);border-radius:6px;padding:5px"></td><td>${esc(x.email)}</td>
        <td><select data-u="${x.id}" data-k="role">${opts([['admin', 'Admin'], ['sales', 'Sales'], ['viewer', 'Viewer']], x.role, null)}</select></td><td><select data-u="${x.id}" data-k="slp_code">${opts(slpOpts, x.slp_code, '—')}</select></td>
        <td><input type="checkbox" data-u="${x.id}" data-k="active" ${x.active ? 'checked' : ''}></td><td class="nowrap"><button class="btn sm sec" data-reset="${x.id}">Reset password</button> ${x.id !== S.me.id ? `<button class="btn sm danger" data-udel="${x.id}">Delete</button>` : ''}</td></tr>`).join('')}</table>
      <p class="small muted">Roles: <b>Admin</b> everything incl. users and settings · <b>Sales</b> view everything, log activity, manage leads, review ledger forms and feedback · <b>Viewer</b> read only (bank account numbers hidden).</p></div>`;
    $$('[data-u]').forEach(el => el.onchange = async () => {
      const id = +el.dataset.u, g = k => $(`[data-u="${id}"][data-k="${k}"]`);
      try { await api('/api/users', { action: 'update', id, name: g('name').value, role: g('role').value, slp_code: g('slp_code').value, active: g('active').checked }); toast('Saved'); } catch (e) { toast(e.message); viewAdmin(); }
    });
    $$('[data-reset]').forEach(b => b.onclick = async () => { if (!confirm('Set a new random password for this user?')) return; const r = await api('/api/users', { action: 'reset_password', id: +b.dataset.reset }); modal(`<h2>New password</h2><p>Share it privately: <code style="font-size:16px">${esc(r.password)}</code></p><div class="acts"><button class="btn" data-copy="${esc(r.password)}">Copy</button><button class="btn sec" onclick="closeModal()">Close</button></div>`); });
    $$('[data-udel]').forEach(b => b.onclick = async () => { if (confirm('Delete this user?')) { await api('/api/users', { action: 'delete', id: +b.dataset.udel }); viewAdmin(); } });
    $('#uNew').onclick = () => {
      modal(`<h2>Add user</h2><div class="fg"><div class="f"><label>Name</label><input id="nN"></div><div class="f"><label>Email</label><input id="nE" type="email"></div>
        <div class="f"><label>Role</label><select id="nR">${opts([['sales', 'Sales'], ['admin', 'Admin'], ['viewer', 'Viewer']], 'sales', null)}</select></div><div class="f"><label>SAP sales employee</label><select id="nS">${opts(slpOpts, '', '—')}</select></div></div>
        <div class="err" id="nErr"></div><div class="acts"><button class="btn sec" onclick="closeModal()">Cancel</button><button class="btn" id="nGo">Add</button></div>`);
      $('#nGo').onclick = async () => { try { const r = await api('/api/users', { action: 'add', name: $('#nN').value, email: $('#nE').value, role: $('#nR').value, slp_code: $('#nS').value });
        modal(`<h2>User added</h2><p>Temporary password (share privately): <code style="font-size:16px">${esc(r.password)}</code></p><div class="acts"><button class="btn" data-copy="${esc(r.password)}">Copy</button><button class="btn sec" id="nDone">Close</button></div>`); $('#nDone').onclick = () => { closeModal(); viewAdmin(); }; }
        catch (e) { $('#nErr').textContent = e.message; } };
    };
  } else if (ADtab === 'settings') {
    $('#adb').innerHTML = `<div class="card" style="max-width:820px"><h2>Settings</h2><div class="fg">
      <div class="f"><label>Feedback discount (Rs. per ton)</label><input id="sD" type="number" min="0" value="${esc(cfg.discountPerTon)}"></div>
      <div class="f"><label>Low score (opens a follow-up) at or below</label><select id="sL">${opts([1, 2, 3], cfg.lowScore, null)}</select></div>
      <div class="f"><label>Dormant after (days without invoice)</label><input id="sDd" type="number" min="30" value="${esc(cfg.dormantDays)}"></div></div>
      <label style="display:block;margin-bottom:8px"><input type="checkbox" id="sK" ${cfg.kycOpen ? 'checked' : ''}> Ledger form (/kyc) accepts responses</label>
      <label style="display:block;margin-bottom:14px"><input type="checkbox" id="sF" ${cfg.feedbackOpen ? 'checked' : ''}> Feedback form (/feedback) accepts responses</label>
      <div class="f"><label>Lead sources (one per line)</label><textarea id="sSo" rows="5">${esc(cfg.leadSources.join('\n'))}</textarea></div>
      <div class="f"><label>Products (one per line)</label><textarea id="sPr" rows="6">${esc(cfg.products.join('\n'))}</textarea></div>
      <div class="f"><label>Lost reasons (one per line)</label><textarea id="sLr" rows="5">${esc(cfg.lostReasons.join('\n'))}</textarea></div>
      <button class="btn" id="sGo">Save settings</button></div>`;
    const lines = id => $(id).value.split('\n').map(s => s.trim()).filter(Boolean);
    $('#sGo').onclick = async () => { await api('/api/users', { action: 'save_config', config: { discountPerTon: +$('#sD').value, lowScore: +$('#sL').value, dormantDays: +$('#sDd').value, kycOpen: $('#sK').checked, feedbackOpen: $('#sF').checked, leadSources: lines('#sSo'), products: lines('#sPr'), lostReasons: lines('#sLr') } }); S.meta = await api('/api/crm', { action: 'meta' }); toast('Settings saved'); };
  } else {
    const { rows } = await api('/api/users', { action: 'audit' });
    $('#adb').innerHTML = `<div class="card"><div class="tw"><table><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr>${rows.map(r => `<tr><td class="nowrap">${fdt(r.at)}</td><td>${esc(r.who || '')}</td><td>${esc(r.action)}</td><td class="small muted">${esc(JSON.stringify(r.detail || {}))}</td></tr>`).join('')}</table></div></div>`;
  }
}

/* ================================================================= BOOT */
(async () => {
  try {
    const d = await api('/api/auth', { action: 'me' }); S.hub = d.hub;
    if (d.user) { S.me = d.user; start(); } else showLogin();
  } catch (e) { showLogin(e.message); }
})();
