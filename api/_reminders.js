// WhatsApp follow-up reminders to the owner, run by the 15-minute cron job (/api/cron?job=mail or ?job=reminders).
// A follow-up with a time is due at that time; one with only a date is due at 09:30 IST that day.
// Only follow-ups that fell due in the last 6 hours are sent, so a long outage never floods anyone.
import { getSql, audit } from './_lib.js';
import { sendFollowupReminder } from './_notify.js';

const IST = 330 * 60000;
const fmtWhen = d => new Date(new Date(d).getTime() + IST).toISOString().replace(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d).*/, (m, y, mo, da, h, mi) => {
  const hh = +h % 12 || 12; return `${da}-${mo}-${y} ${hh}:${mi} ${+h < 12 ? 'AM' : 'PM'}`; });

export async function runReminders() {
  const sql = getSql();
  const due = await sql`
    SELECT a.id, a.subject, a.type, a.owner_email, a.card_code, a.lead_id, a.enquiry_id,
      COALESCE(a.follow_up_ts, (a.follow_up_at + time '09:30') AT TIME ZONE 'Asia/Kolkata') AS due_at,
      COALESCE(c.name, l.company, e.company) AS customer, e.ref AS enq_ref
    FROM crm_activities a
    LEFT JOIN crm_customers c ON c.card_code = a.card_code
    LEFT JOIN crm_leads l ON l.id = a.lead_id
    LEFT JOIN crm_enquiries e ON e.id = a.enquiry_id
    WHERE NOT a.done AND a.reminded_at IS NULL AND a.follow_up_at IS NOT NULL
      AND COALESCE(a.follow_up_ts, (a.follow_up_at + time '09:30') AT TIME ZONE 'Asia/Kolkata') <= now()
      AND COALESCE(a.follow_up_ts, (a.follow_up_at + time '09:30') AT TIME ZONE 'Asia/Kolkata') > now() - interval '6 hours'
    ORDER BY due_at LIMIT 60`;
  if (!due.length) return { reminders: 0 };
  const keys = [...new Set(due.map(d => d.owner_email).filter(Boolean))];
  const staff = keys.length ? await sql`SELECT COALESCE(email, 'emp:' || lower(emp_code), 'uid:' || id) AS k, name, mobile FROM crm_users
    WHERE active AND COALESCE(email, 'emp:' || lower(emp_code), 'uid:' || id) = ANY(${keys}::text[])` : [];
  const by = Object.fromEntries(staff.map(s => [s.k, s]));
  let sent = 0;
  for (const a of due) {
    const u = by[a.owner_email];
    const task = [a.enq_ref, a.subject].filter(Boolean).join(' – ').slice(0, 180) || a.type;
    const r = !u ? { ok: false, message: 'No owner' } : !u.mobile ? { ok: false, message: 'Owner has no mobile number in the CRM' }
      : await sendFollowupReminder(u.mobile, { name: (u.name || '').split(' ')[0] || u.name, customer: a.customer || '-', task, time: fmtWhen(a.due_at) });
    await sql`UPDATE crm_activities SET reminded_at = now(), remind_result = ${(r.ok ? '✓ ' : '✗ ') + String(r.message || '').slice(0, 180)} WHERE id = ${a.id}`;
    if (r.ok) sent++;
  }
  await audit('cron', 'followup_reminders', { due: due.length, sent });
  return { reminders: sent, due: due.length };
}
