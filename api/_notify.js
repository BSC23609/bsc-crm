// Sends the ledger-form link to a customer by email (from info@bharatsteels.in) and WhatsApp (WATI).
// Same settings names the other group apps use (Vercel → Environment Variables):
//   SMTP_HOST (smtp.office365.com), SMTP_PORT (587), SMTP_USER, SMTP_PASS, SMTP_FROM (info@bharatsteels.in), SMTP_FROM_NAME
//   WATI_BASE_URL, WATI_TOKEN, WATI_KYC_TEMPLATE (default bsc_ledger_form_8)
import nodemailer from 'nodemailer';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { BSC_MARK } from './_logo.js';

const env = (k, d = '') => String(process.env[k] ?? d).trim().replace(/^['"]|['"]$/g, '').trim();
export const emailReady = () => !!(env('SMTP_HOST') && env('SMTP_USER') && env('SMTP_PASS'));
export const whatsappReady = () => !!(watiBase() && env('WATI_TOKEN'));
// Links sent to customers always use the official address, whichever address staff opened the CRM on.
export const appUrl = () => {
  const u = env('APP_URL').replace(/\/+$/, '');
  return u && !/\.vercel\.app$/i.test(u) ? u : 'https://crm.bharatsteels.in';   // never hand customers a *.vercel.app address
};

function watiBase() {
  let b = env('WATI_BASE_URL').replace(/\/+$/, '');
  for (const t of ['/api/v1/sendTemplateMessage', '/api/v1', '/api/v2']) if (b.endsWith(t)) b = b.slice(0, -t.length);
  return b;
}
export function waNumber(raw) {
  // SAP fields often hold several numbers ("98401 81909, 9840067170, 044-42107549"): use the first Indian mobile.
  const parts = String(raw || '').split(/[,;/|]|\s{2,}|\bor\b|&/i).map(p => p.replace(/\D/g, '')).filter(Boolean);
  for (let d of parts.length ? parts : ['']) {
    if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
    if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
    if (d.length === 10 && /^[6-9]/.test(d)) return '91' + d;
  }
  const all = String(raw || '').replace(/\D/g, '');   // a single number written with odd separators
  if (all.length === 10 && /^[6-9]/.test(all)) return '91' + all;
  if (all.length === 12 && /^91[6-9]/.test(all)) return all;
  return null;
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function sendKycEmail({ to, name, company, url, logoUrl }) {
  if (!emailReady()) return { ok: false, message: 'Email is not set up (SMTP_* settings)' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to || ''))) return { ok: false, message: 'No valid email address' };
  const qr = await qrPng(url, 420);
  const hello = name ? `Dear ${esc(name)},` : 'Dear Sir / Madam,';
  const html = `<!doctype html><html><body style="margin:0;background:#F4F6F8;font-family:Arial,Helvetica,sans-serif;color:#1E1D1D">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6F8;padding:24px 0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden">
  <tr><td style="height:6px;background:#0A2B66"></td></tr>
  <tr><td style="padding:22px 28px 6px"><img src="${esc(logoUrl)}" alt="Bharat Steel (Chennai) Pvt. Ltd." height="44" style="display:block;height:44px"></td></tr>
  <tr><td style="padding:10px 28px 0;font-size:15px;line-height:1.55">
    <p style="margin:0 0 12px">${hello}</p>
    <p style="margin:0 0 12px">Thank you for choosing Bharat Steel (Chennai) Pvt. Ltd. To open${company ? ` the customer ledger for <b>${esc(company)}</b>` : ' your customer ledger'} in our system, please fill in the Ledger Creation Data Sheet using the button or QR code below. It takes about 5 minutes.</p>
    <p style="margin:0 0 6px">Please keep these ready to upload:</p>
    <ul style="margin:0 0 16px;padding-left:20px"><li>GST certificate (billing address, and shipping address if different)</li><li>Cancelled cheque</li></ul>
  </td></tr>
  <tr><td align="center" style="padding:4px 28px 8px">
    <a href="${esc(url)}" style="display:inline-block;background:#0A2B66;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:13px 30px;border-radius:8px">Fill the ledger form</a>
  </td></tr>
  <tr><td align="center" style="padding:14px 28px 4px"><img src="cid:kycqr" alt="QR code for the ledger form" width="180" height="180" style="display:block;width:180px;height:180px"></td></tr>
  <tr><td align="center" style="padding:0 28px 18px;font-size:12px;color:#5b6475">Scan with your phone camera to open the form.<br>Or open: <a href="${esc(url)}" style="color:#01578C;word-break:break-all">${esc(url)}</a></td></tr>
  <tr><td style="padding:0 28px 24px;font-size:14px;line-height:1.5">For any help, reply to this email or WhatsApp us at <a href="https://wa.me/919500680093" style="color:#01578C">+91 95006 80093</a>.<br><br>Regards,<br><b>Bharat Steel (Chennai) Pvt. Ltd.</b></td></tr>
  <tr><td style="background:#F4F6F8;padding:14px 28px;font-size:11.5px;color:#5b6475;line-height:1.5">No.147, Survey No. 133, Thirunilai Village, Ponneri Taluk, Chennai - 600103 · 044 6791 7800 · info@bharatsteels.in · www.bharatsteels.in</td></tr>
</table></td></tr></table></body></html>`;
  const text = `${name ? 'Dear ' + name : 'Dear Sir / Madam'},\n\nTo open${company ? ' the customer ledger for ' + company : ' your customer ledger'} with Bharat Steel (Chennai) Pvt. Ltd., please fill in the Ledger Creation Data Sheet:\n${url}\n\nKeep your GST certificate and a cancelled cheque ready to upload.\n\nRegards,\nBharat Steel (Chennai) Pvt. Ltd.\n044 6791 7800 · info@bharatsteels.in`;
  try {
    const port = Number(env('SMTP_PORT', '587'));
    const t = nodemailer.createTransport({ host: env('SMTP_HOST'), port, secure: port === 465, requireTLS: port !== 465 && env('SMTP_REQUIRE_TLS', '1') !== '0',
      auth: { user: env('SMTP_USER'), pass: env('SMTP_PASS') }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000 });
    const from = env('SMTP_FROM', 'info@bharatsteels.in');
    await t.sendMail({ from: { name: env('SMTP_FROM_NAME', 'Bharat Steel (Chennai) Pvt. Ltd.'), address: from }, replyTo: from, to,
      subject: `Ledger creation form – Bharat Steel (Chennai) Pvt. Ltd.${company ? ' | ' + company : ''}`, text, html,
      attachments: [{ filename: 'ledger-form-qr.png', content: qr, cid: 'kycqr', contentType: 'image/png' }] });
    return { ok: true, message: 'Email sent to ' + to };
  } catch (e) {
    const hint = /535|auth/i.test(e.message) ? ' (check SMTP_USER / SMTP_PASS, and that SMTP AUTH is allowed for this mailbox in Microsoft 365)' : '';
    return { ok: false, message: 'Email failed: ' + String(e.message).slice(0, 160) + hint };
  }
}

// WhatsApp template "bsc_ledger_form_8" (approved in WATI):
//   Header  Image — the standard ledger-form QR (public/img/ledger-form-qr.png, uploaded once in WATI)
//   Body    Dear {{name}}, ... ledger for {{company}} ...
//   Button  Visit website, static  https://crm.bharatsteels.in/kyc
export async function sendKycWhatsApp({ phone, name, company }) {
  if (!whatsappReady()) return { ok: false, message: 'WhatsApp is not set up (WATI_* settings)' };
  const to = waNumber(phone);
  if (!to) return { ok: false, message: 'No valid mobile number' };
  const token = env('WATI_TOKEN');
  try {
    const r = await fetch(`${watiBase()}/api/v1/sendTemplateMessage?whatsappNumber=${to}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; BSC-CRM/1.0)',
                 Authorization: /^bearer /i.test(token) ? token : `Bearer ${token}` },
      body: JSON.stringify({ template_name: env('WATI_KYC_TEMPLATE', 'bsc_ledger_form_8'), broadcast_name: `crm_kyc_${Date.now()}`,
        parameters: [{ name: 'name', value: name || 'Sir / Madam' }, { name: 'company', value: company || 'your company' }] }),
      signal: AbortSignal.timeout(15000)
    });
    const text = await r.text();
    let d = {}; try { d = JSON.parse(text); } catch { /* not json */ }
    if (!r.ok) return { ok: false, message: `WhatsApp failed: WATI HTTP ${r.status}${r.status === 401 ? ' (WATI_TOKEN wrong or expired)' : ''} ${text.slice(0, 120)}` };
    if (d.result === false || d.result === 'false' || d.validWhatsAppNumber === false)
      return { ok: false, message: 'WhatsApp failed: ' + (d.info || d.message || text.slice(0, 160)) };
    return { ok: true, message: 'WhatsApp sent to +' + to };
  } catch (e) { return { ok: false, message: 'WhatsApp failed: ' + e.message }; }
}

// QR code with the BSC mark in the centre. Error correction H (30%) keeps it scannable with the centre covered.
export async function qrPng(url, size = 600) {
  const qr = await QRCode.toBuffer(url, { errorCorrectionLevel: 'H', width: size, margin: 2, color: { dark: '#0A2B66', light: '#FFFFFF' } });
  const badge = Math.round(size * 0.26), mark = Math.round(badge * 0.86);
  const plate = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${badge}" height="${badge}"><circle cx="${badge / 2}" cy="${badge / 2}" r="${badge / 2}" fill="#fff"/></svg>`);
  const logo = await sharp(BSC_MARK).resize(mark, mark, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } }).png().toBuffer();
  const at = v => Math.round((size - v) / 2);
  return sharp(qr).composite([{ input: plate, left: at(badge), top: at(badge) }, { input: logo, left: at(mark), top: at(mark) }]).png().toBuffer();
}

// Password-reset code by WhatsApp: WATI template otp_password2 (the one the group portal uses), {{1}} = the code.
export async function sendOtpWhatsApp(phone, code) {
  if (!whatsappReady()) return { ok: false, message: 'WhatsApp is not set up' };
  const to = waNumber(phone);
  if (!to) return { ok: false, message: 'No valid mobile number on this account' };
  const token = env('WATI_TOKEN');
  try {
    const r = await fetch(`${watiBase()}/api/v1/sendTemplateMessage?whatsappNumber=${to}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; BSC-CRM/1.0)',
                 Authorization: /^bearer /i.test(token) ? token : `Bearer ${token}` },
      body: JSON.stringify({ template_name: env('WATI_OTP_TEMPLATE', 'otp_password2'), broadcast_name: `crm_reset_${Date.now()}`, parameters: [{ name: '1', value: code }] }),
      signal: AbortSignal.timeout(15000)
    });
    const text = await r.text(); let d = {}; try { d = JSON.parse(text); } catch { /* not json */ }
    if (!r.ok || d.result === false || d.result === 'false' || d.validWhatsAppNumber === false)
      return { ok: false, message: 'Could not send the WhatsApp code: ' + (d.info || d.message || `WATI HTTP ${r.status}`) };
    return { ok: true };
  } catch (e) { return { ok: false, message: 'Could not send the WhatsApp code: ' + e.message }; }
}

/* ---------------- Payment reminders (Receivables tab) ---------------- */
// WhatsApp template (create + get approved in WATI, category Utility), name in WATI_AR_TEMPLATE (default bsc_payment_reminder):
//   Body: Dear {{company}}, this is a gentle reminder from Bharat Steel (Chennai) Pvt. Ltd. An amount of {{amount}} is overdue
//         in your account with us against {{bills}} bill(s) past the due date. Kindly arrange the payment at the earliest.
//         Please ignore this message if already paid. For queries call 044 6791 7800.
// Only overdue bills (unpaid and past the due date) are included; g.amount is the overdue total.
export async function watiTemplate(phone, template, params, tag = 'crm') {
  if (!whatsappReady()) return { ok: false, message: 'WhatsApp is not set up (WATI_* settings)' };
  const to = waNumber(phone);
  if (!to) return { ok: false, message: 'No valid mobile number' };
  const token = env('WATI_TOKEN');
  try {
    const r = await fetch(`${watiBase()}/api/v1/sendTemplateMessage?whatsappNumber=${to}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; BSC-CRM/1.0)',
                 Authorization: /^bearer /i.test(token) ? token : `Bearer ${token}` },
      body: JSON.stringify({ template_name: template, broadcast_name: `${tag}_${Date.now()}`, parameters: Object.entries(params).map(([name, value]) => ({ name, value: String(value) })) }),
      signal: AbortSignal.timeout(15000)
    });
    const text = await r.text(); let d = {}; try { d = JSON.parse(text); } catch { /* not json */ }
    if (!r.ok) return { ok: false, message: `WhatsApp failed: WATI HTTP ${r.status}${r.status === 401 ? ' (WATI_TOKEN wrong or expired)' : ''} ${text.slice(0, 120)}` };
    if (d.result === false || d.result === 'false' || d.validWhatsAppNumber === false) return { ok: false, message: 'WhatsApp failed: ' + (d.info || d.message || text.slice(0, 160)) };
    return { ok: true, message: 'WhatsApp sent to +' + to };
  } catch (e) { return { ok: false, message: 'WhatsApp failed: ' + e.message }; }
}
const inr = v => '₹' + Math.round(Number(v) || 0).toLocaleString('en-IN');
const dmy = s => { const d = String(s || '').slice(0, 10).split('-'); return d.length === 3 ? `${d[2]}-${d[1]}-${d[0]}` : String(s || ''); };
let _tx = null;
function mailer() {
  if (_tx) return _tx;
  const port = Number(env('SMTP_PORT', '587'));
  _tx = nodemailer.createTransport({ host: env('SMTP_HOST'), port, secure: port === 465, requireTLS: port !== 465 && env('SMTP_REQUIRE_TLS', '1') !== '0', pool: true, maxConnections: 2,
    auth: { user: env('SMTP_USER'), pass: env('SMTP_PASS') }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000 });
  return _tx;
}
// g: { company, amount, overdue, bills:[{bill_no,bill_date,due_date,days,amount}] }
export function reminderText(g) {
  return `Dear ${g.company}, this is a gentle reminder from Bharat Steel (Chennai) Pvt. Ltd. An amount of ${inr(g.amount)} is overdue in your account with us against ${g.bills.length} bill(s) past the due date. Kindly arrange the payment at the earliest. Please ignore this message if already paid. For queries call 044 6791 7800.`;
}
export async function sendReminderWhatsApp(phone, g) {
  return watiTemplate(phone, env('WATI_AR_TEMPLATE', 'bsc_payment_reminder'),
    { company: g.company, amount: inr(g.amount), bills: g.bills.length }, 'crm_ar');
}
export async function sendReminderEmail(to, g, logoUrl) {
  if (!emailReady()) return { ok: false, message: 'Email is not set up (SMTP_* settings)' };
  const list = String(to || '').split(/[;,\s]+/).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)).slice(0, 3);
  if (!list.length) return { ok: false, message: 'No valid email address' };
  const rows = g.bills.map(b => `<tr><td style="padding:6px 8px;border-bottom:1px solid #e3e8f0">${esc(b.bill_no)}</td><td style="padding:6px 8px;border-bottom:1px solid #e3e8f0">${esc(dmy(b.bill_date))}</td>
    <td style="padding:6px 8px;border-bottom:1px solid #e3e8f0">${esc(dmy(b.due_date))}</td><td style="padding:6px 8px;border-bottom:1px solid #e3e8f0;text-align:right;${b.days > 0 ? 'color:#B42318;font-weight:bold' : ''}">${b.days > 0 ? b.days : '-'}</td>
    <td style="padding:6px 8px;border-bottom:1px solid #e3e8f0;text-align:right">${inr(b.amount)}</td></tr>`).join('');
  const html = `<!doctype html><html><body style="margin:0;background:#F4F6F8;font-family:Arial,Helvetica,sans-serif;color:#1E1D1D">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6F8;padding:24px 0"><tr><td align="center">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden">
  <tr><td style="height:6px;background:#0A2B66"></td></tr>
  <tr><td style="padding:22px 28px 6px"><img src="${esc(logoUrl)}" alt="Bharat Steel (Chennai) Pvt. Ltd." height="44" style="display:block;height:44px"></td></tr>
  <tr><td style="padding:10px 28px 0;font-size:15px;line-height:1.55">
    <p style="margin:0 0 12px">Dear <b>${esc(g.company)}</b>,</p>
    <p style="margin:0 0 12px">This is a gentle reminder that an amount of <b style="color:#B42318">${inr(g.amount)}</b> is overdue in your account with Bharat Steel (Chennai) Pvt. Ltd. The bills past their due date are listed below.</p>
  </td></tr>
  <tr><td style="padding:4px 28px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;border-collapse:collapse">
    <tr style="background:#0A2B66;color:#ffffff"><th align="left" style="padding:7px 8px">Bill no.</th><th align="left" style="padding:7px 8px">Bill date</th><th align="left" style="padding:7px 8px">Due date</th><th align="right" style="padding:7px 8px">Days overdue</th><th align="right" style="padding:7px 8px">Outstanding</th></tr>
    ${rows}
    <tr><td colspan="4" style="padding:8px;font-weight:bold;border-top:2px solid #0A2B66">Total overdue</td><td style="padding:8px;text-align:right;font-weight:bold;border-top:2px solid #0A2B66">${inr(g.amount)}</td></tr>
  </table></td></tr>
  <tr><td style="padding:16px 28px 24px;font-size:14px;line-height:1.55">Kindly arrange the payment at the earliest and share the payment details by reply to this email. Please ignore this reminder if the payment has already been made.<br><br>For any clarification call 044 6791 7800 or WhatsApp <a href="https://wa.me/919500680093" style="color:#01578C">+91 95006 80093</a>.<br><br>Regards,<br><b>Accounts – Bharat Steel (Chennai) Pvt. Ltd.</b></td></tr>
  <tr><td style="background:#F4F6F8;padding:14px 28px;font-size:11.5px;color:#5b6475;line-height:1.5">No.147, Survey No. 133, Thirunilai Village, Ponneri Taluk, Chennai - 600103 · 044 6791 7800 · info@bharatsteels.in · www.bharatsteels.in</td></tr>
</table></td></tr></table></body></html>`;
  const text = `${reminderText(g)}\n\n${g.bills.map(b => `${b.bill_no}  dt ${dmy(b.bill_date)}  due ${dmy(b.due_date)}  ${inr(b.amount)}${b.days > 0 ? `  (${b.days} days overdue)` : ''}`).join('\n')}\n\nRegards,\nAccounts – Bharat Steel (Chennai) Pvt. Ltd.`;
  try {
    const from = env('SMTP_FROM', 'info@bharatsteels.in');
    const cc = env('AR_REMINDER_CC');
    await mailer().sendMail({ from: { name: env('SMTP_FROM_NAME', 'Bharat Steel (Chennai) Pvt. Ltd.'), address: from }, replyTo: env('AR_REMINDER_REPLY_TO', from), to: list, ...(cc ? { cc } : {}),
      subject: `Payment reminder – ${inr(g.amount)} overdue | ${g.company}`, text, html });
    return { ok: true, message: 'Email sent to ' + list.join(', ') };
  } catch (e) {
    _tx = null;
    const hint = /535|auth/i.test(e.message) ? ' (check SMTP_USER / SMTP_PASS)' : '';
    return { ok: false, message: 'Email failed: ' + String(e.message).slice(0, 160) + hint };
  }
}

/* ---------------- Feedback requests (Feedback tab → Customer list) ---------------- */
// WhatsApp template (create + get approved in WATI, category Utility), name in WATI_FEEDBACK_TEMPLATE (default bsc_feedback_request):
//   Body: Dear {{company}}, thank you for buying from Bharat Steel (Chennai) Pvt. Ltd. We would value your feedback on invoice {{invoice}}.
//         It takes 2 minutes: {{link}} Thank you.
export async function sendFeedbackWhatsApp(phone, f) {
  return watiTemplate(phone, env('WATI_FEEDBACK_TEMPLATE', 'bsc_feedback_request'), { company: f.company, invoice: f.invoice || '-', link: f.link }, 'crm_fb');
}
export async function sendFeedbackEmail(to, f, logoUrl) {
  if (!emailReady()) return { ok: false, message: 'Email is not set up (SMTP_* settings)' };
  const list = String(to || '').split(/[;,\s]+/).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)).slice(0, 3);
  if (!list.length) return { ok: false, message: 'No valid email address' };
  const qr = await qrPng(f.link, 420);
  const html = `<!doctype html><html><body style="margin:0;background:#F4F6F8;font-family:Arial,Helvetica,sans-serif;color:#1E1D1D">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6F8;padding:24px 0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden">
  <tr><td style="height:6px;background:#0A2B66"></td></tr>
  <tr><td style="padding:22px 28px 6px"><img src="${esc(logoUrl)}" alt="Bharat Steel (Chennai) Pvt. Ltd." height="44" style="display:block;height:44px"></td></tr>
  <tr><td style="padding:10px 28px 0;font-size:15px;line-height:1.55">
    <p style="margin:0 0 12px">Dear <b>${esc(f.company)}</b>,</p>
    <p style="margin:0 0 12px">Thank you for buying from Bharat Steel (Chennai) Pvt. Ltd. We would value your feedback on our material, delivery and service${f.invoice ? ` for invoice <b>${esc(f.invoice)}</b>` : ''}. It takes about 2 minutes and helps us serve you better.</p>
  </td></tr>
  <tr><td align="center" style="padding:6px 28px 8px"><a href="${esc(f.link)}" style="display:inline-block;background:#0A2B66;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:13px 30px;border-radius:8px">Give feedback</a></td></tr>
  <tr><td align="center" style="padding:14px 28px 4px"><img src="cid:fbqr" alt="QR code for the feedback form" width="170" height="170" style="display:block;width:170px;height:170px"></td></tr>
  <tr><td align="center" style="padding:0 28px 18px;font-size:12px;color:#5b6475">Scan with your phone camera, or open: <a href="${esc(f.link)}" style="color:#01578C;word-break:break-all">${esc(f.link)}</a></td></tr>
  <tr><td style="padding:0 28px 24px;font-size:14px;line-height:1.5">Regards,<br><b>Bharat Steel (Chennai) Pvt. Ltd.</b></td></tr>
  <tr><td style="background:#F4F6F8;padding:14px 28px;font-size:11.5px;color:#5b6475;line-height:1.5">No.147, Survey No. 133, Thirunilai Village, Ponneri Taluk, Chennai - 600103 · 044 6791 7800 · info@bharatsteels.in · www.bharatsteels.in</td></tr>
</table></td></tr></table></body></html>`;
  const text = `Dear ${f.company},\n\nThank you for buying from Bharat Steel (Chennai) Pvt. Ltd. We would value your feedback${f.invoice ? ' on invoice ' + f.invoice : ''}. It takes about 2 minutes:\n${f.link}\n\nRegards,\nBharat Steel (Chennai) Pvt. Ltd.\n044 6791 7800 · info@bharatsteels.in`;
  try {
    const from = env('SMTP_FROM', 'info@bharatsteels.in');
    await mailer().sendMail({ from: { name: env('SMTP_FROM_NAME', 'Bharat Steel (Chennai) Pvt. Ltd.'), address: from }, replyTo: from, to: list,
      subject: `Your feedback please${f.invoice ? ' – invoice ' + f.invoice : ''} | Bharat Steel (Chennai) Pvt. Ltd.`, text, html,
      attachments: [{ filename: 'feedback-qr.png', content: qr, cid: 'fbqr' }] });
    return { ok: true, message: 'Email sent to ' + list.join(', ') };
  } catch (e) {
    _tx = null;
    return { ok: false, message: 'Email failed: ' + String(e.message).slice(0, 160) + (/535|auth/i.test(e.message) ? ' (check SMTP_USER / SMTP_PASS)' : '') };
  }
}

/* ---------------- Staff WhatsApp: enquiry assigned / transferred, follow-up reminder ---------------- */
// Templates (WATI, category Utility). Body text is in README section 10.
//   bsc_enquiry_assigned : {{name}} {{ref}} {{company}} {{details}} {{by}}
//   bsc_followup_reminder: {{name}} {{customer}} {{task}} {{time}}
export async function sendEnquiryAssigned(phone, f) {
  return watiTemplate(phone, env('WATI_ENQ_TEMPLATE', 'bsc_enquiry_assigned'),
    { name: f.name || 'Team', ref: f.ref, company: f.company, details: f.details || '-', by: f.by || 'CRM' }, 'crm_enq');
}
export async function sendFollowupReminder(phone, f) {
  return watiTemplate(phone, env('WATI_FOLLOWUP_TEMPLATE', 'bsc_followup_reminder'),
    { name: f.name || 'Team', customer: f.customer || '-', task: f.task || '-', time: f.time }, 'crm_fu');
}
