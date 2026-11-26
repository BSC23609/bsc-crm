// Sends the ledger-form link to a customer by email (from info@bharatsteels.in) and WhatsApp (WATI).
// Same settings names the other group apps use (Vercel → Environment Variables):
//   SMTP_HOST (smtp.office365.com), SMTP_PORT (587), SMTP_USER, SMTP_PASS, SMTP_FROM (info@bharatsteels.in), SMTP_FROM_NAME
//   WATI_BASE_URL, WATI_TOKEN, WATI_KYC_TEMPLATE (default bsc_ledger_form_8)
import nodemailer from 'nodemailer';
import QRCode from 'qrcode';

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
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = '91' + d;
  return d.length >= 11 ? d : null;
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function sendKycEmail({ to, name, company, url, logoUrl }) {
  if (!emailReady()) return { ok: false, message: 'Email is not set up (SMTP_* settings)' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to || ''))) return { ok: false, message: 'No valid email address' };
  const qr = await QRCode.toBuffer(url, { width: 360, margin: 2, color: { dark: '#0A2B66', light: '#FFFFFF' } });
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

export async function qrPng(url) { return QRCode.toBuffer(url, { width: 600, margin: 2, color: { dark: '#0A2B66', light: '#FFFFFF' } }); }
