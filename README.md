# Customer CRM — Bharat Steel (Chennai) Pvt. Ltd.

**https://crm.bharatsteels.in** · Static page + Vercel serverless routes + Neon Postgres (same setup as SAIL Branding). Customer data comes from **SAP Business One through a scheduled task on the SAP server every 15 minutes** — the same model as refresh_stock.ps1 for MIS/QMS.

## What's in it

| Screen | What it does |
|---|---|
| **Dashboard** | Sales this month / FY (from SAP), receivable ageing, customers over credit limit, top customers, *win-back* list (regular buyers gone quiet), dormant count, follow-ups due, ledger forms to review, feedback score, open leads, sales by industry segment |
| **Customers** | Every SAP customer (refreshed every 15 min) with search, salesperson / segment / dormant / over-limit / "My customers" filters, Excel export |
| **Customer page** | From SAP (≤15 min old): balance vs credit limit, open orders, monthly purchases, ageing, invoices (24 months), payments, open invoices, addresses, contacts. Plus CRM: activity timeline, follow-ups, feedback, ledger form, segment / buyer type / tags / owner, other ledgers with the same PAN. One-click WhatsApp, feedback link per invoice, ledger form invite |
| **Ledger forms (KYC)** | Same questions as the Google Form "SAP Ledger Creation Data Sheet". Public form at **/kyc** (with GST certificate + cancelled cheque upload, GSTIN check-digit validation, pincode → district/state and IFSC → bank lookup). Personal pre-filled links per customer/lead. Review flow *New → Under review → Approved → Created in SAP*, duplicate checks against SAP (same GSTIN / same PAN), state-vs-GSTIN and PAN-type warnings, SAP-ready Excel sheet, import of old Google Form responses. Auto-links to the SAP customer when the GSTIN appears in SAP |
| **Feedback** | Same 9 questions as the Microsoft Form. Public form at **/feedback** (`/feedback?inv=…` pre-fills the invoice). Each response is matched to the SAP invoice → customer + salesperson. Analytics: average score, CSAT %, score by question (distribution), monthly trend, by salesperson, by segment, comments. Low scores open a follow-up automatically. Tracks the Rs.50/ton discount (due / given / not applicable). Import of old Microsoft Forms responses |
| **Follow-ups** | Overdue / today / next 7 days, mine vs everyone; mark done and set the next one |
| **Leads** | Pipeline board (New → Contacted → Quoted → Negotiation → Won / Lost) with MT/month potential, lost reasons, activity, and "send ledger form" when won |
| **Receivables** | Open invoices from the same `receivables.csv` the MIS portal uses: ageing, overdue / over-60 totals, by executive, per-customer bills, WhatsApp payment reminder, log a payment call, Excel export |
| **Mail** | info@bharatsteels.in read by Claude every 15 min: customer mails only, one data sheet per company (contact, phones, GSTIN, address, requirement), checked against SAP (In SAP / Check match / New), one-click lead or ledger form, Excel export, full log of every mail (section 7) |
| **Admin** | Users & roles (Admin / Sales / Viewer), link users to their SAP sales employee, settings (discount, low-score level, dormant days, lead sources, products), activity log |

SAP is **read-only** from the CRM — nothing is written to SAP.

## How SAP data reaches the CRM

```
SAP server: Task Scheduler every 15 min → C:\scripts\refresh_crm.ps1 → reads BSC_FINAL_2707 (SELECT only)
            → HTTPS POST with a secret key → crm.bharatsteels.in/api/sap-push → Neon
```

Same pattern as `refresh_stock.ps1` (same `config.ini`, same SQL connection code, lock file and log). The one difference: it posts the data straight to the CRM and does not commit CSVs to GitHub. `bsc-stock-data` is a public repository, and this data is customer balances, GSTINs, phone numbers and invoices. Nothing on the SAP server is opened to the internet.

Each run sends every customer (balances, credit limits, roll-ups) and the open sales orders. The first run of the day also sends 24 months of invoices and payments, 13 months of net sales per customer, and all addresses and contacts. Later runs send only what changed in the last 3 days. Cancelled invoices and payments are removed.

### 1. Scheduled task on the SAP server

Follow `sap-sync/INSTALL.md`: copy `refresh_crm.ps1` to `C:\scripts`, add `crm_url` and `crm_push_secret` to `config.ini`, run it once by hand with `-Full`, then create the 15-minute task with the `schtasks` line given there. If a query fails because of a column name in your SAP version, the log names it — send that line over.

### 2. Deploy the CRM (Vercel + Neon)

1. **GitHub** – repo `BSC23609/bsc-crm` (the `sap-sync` folder can stay in it; Vercel ignores it).
2. **Neon** – new project `bsc-crm`, region Singapore, copy the **pooled** connection string.
3. **Vercel** – Add New → Project → import `BSC23609/bsc-crm`, Framework **Other**, no build command. Environment variables:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | Neon connection string |
   | `SESSION_SECRET` | long random text (32+ characters) |
   | `ADMIN_EMAIL` / `ADMIN_PASSWORD` | first admin (only used while there are no users; remove the password after first sign-in) |
   | `SAP_PUSH_SECRET` | random text, 16+ characters — the same value as `crm_push_secret` in config.ini |
   | `CRON_SECRET` | random text (daily clean-up of abandoned form drafts, and the 15-minute mail check — step 7) |
   | `GROUP_SSO_SECRET` | from the group portal: Admin → Apps → Customer CRM → Show the secret |

   Tables are created automatically on first load.
4. **File storage** – Vercel → Storage → Create → **Blob** (Private) → connect to the project → redeploy. Needed for the GST certificate / cheque uploads (without it the form still works and says documents will be collected separately).
5. **Domain** – Vercel → Settings → Domains → `crm.bharatsteels.in`; DNS: CNAME `crm` → `cname.vercel-dns.com`.

### 3. Group portal tile

PR **BSC23609/bsg-hub#1** adds "Customer CRM" (single sign-on, email identity) to app.thebharatsteelgroup.com. Merge it, then copy the app secret into `GROUP_SSO_SECRET` above. People opening the CRM from the portal get a Sales account automatically; admins change roles under Admin → Users.

### 4. Move existing data in

- **Ledger forms**: Google Form → Responses → download .csv → CRM → Ledger forms → *Import Google Form responses*. Drive links to the uploaded documents are kept.
- **Feedback**: Microsoft Forms → Responses → *Open results in Excel* → CRM → Feedback → *Import Microsoft Forms*.
- Change the feedback e-mail link `bit.ly/bsc-customer-feedback-form` to point at `https://crm.bharatsteels.in/feedback` (and regenerate the QR from the Feedback page). Replace the Google Form link with `https://crm.bharatsteels.in/kyc`.

### 5. Email and WhatsApp for the ledger-form link

"Send ledger form" (Ledger forms page, customer page or lead) sends the **standard** form link
`https://crm.bharatsteels.in/kyc` and its QR code: an **email from info@bharatsteels.in** (button + QR) and a **WhatsApp
message via WATI**. Every customer gets the same link and QR. When the customer submits the form with the same mobile,
email or GSTIN, the submission is matched to the request (SAP code, lead and send history carried over).
"Send link again" re-sends it; every send is logged on the request.

Add to Vercel → bsc-crm → Environment Variables, then redeploy:

| Name | Value |
|---|---|
| `SMTP_HOST` | `smtp.office365.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | `info@bharatsteels.in` |
| `SMTP_PASS` | the mailbox password (or app password) |
| `SMTP_FROM` | `info@bharatsteels.in` |
| `SMTP_FROM_NAME` | `Bharat Steel (Chennai) Pvt. Ltd.` (optional) |
| `WATI_BASE_URL` | same as in the other group apps |
| `WATI_TOKEN` | same as in the other group apps |
| `WATI_KYC_TEMPLATE` | `bsc_ledger_form_8` (optional, this is the default) |

Microsoft 365: *Authenticated SMTP* must be enabled for the info@ mailbox (M365 admin centre → Users → info@ → Mail → Manage email apps → tick **Authenticated SMTP**).

WATI: template **bsc_ledger_form_8** (category **Utility**):

- **Header:** Image → **Upload Media** → `public/img/ledger-form-qr.png` (the standard QR for https://crm.bharatsteels.in/kyc)
- **Body:** uses `{{name}}` and `{{company}}`
- **Button:** Visit website, **Static**, `https://crm.bharatsteels.in/kyc`

The CRM sends `name` (contact person) and `company`.

### 6. Staff sign-in

- Staff sign in with their **email, employee code (e.g. BSC/017) or mobile**. Admin → Users → **Import staff** takes rows pasted
  from Excel (Emp No · Name · Designation · Dept · Mobile [· Email · Role]); Dept "Management" becomes Admin, others Sales.
- New and reset accounts get the common starting password (`Bsg@1234`, change with `COMMON_PASSWORD`) and must choose their own at first sign-in.
- **Forgot password?** on the sign-in page sends a 6-digit code to the account's mobile by WhatsApp (WATI template
  `otp_password2`, `{{1}}` = code; change with `WATI_OTP_TEMPLATE`). Valid 10 minutes, 5 tries, one code per minute.


- Feedback Q3 in the current Microsoft Form shows "Fair" twice; the CRM uses Excellent / Very good / Good / Fair / Poor.
- Scores: first option = 5 … last = 1. CSAT = share of answers in the top two options.
- Invoice matching uses the digits at the end of what the customer types (e.g. `BSC/25-26/24005` → DocNum 24005) and prefers the series whose printed number matches. Feedback for an invoice made in the last 15 minutes is matched on the next SAP run.
- The header shows the time of the last SAP update; a failed run or no update for 45 minutes shows a warning with the reason.
- Sales figures are taxable value (DocTotal − VAT/GST); quantities are the invoice line quantity (MT for steel items).

### 7. Mail reader (info@bharatsteels.in → Claude → customer data sheets)

Every 15 minutes the CRM reads new mail in info@bharatsteels.in (all folders). Internal mail, newsletters, auto-replies and no-reply senders are filtered out without AI. Every other mail goes to **Claude** (Anthropic API). Claude reads the body, the signature and any PDF or image attachments (GST certificate, PO, enquiry list, visiting card). It decides whether the sender is a customer and extracts the company, contact, phones, emails, GSTIN, address and the products and quantities asked for. Each company gets one **data sheet** (Mail tab), checked against the SAP customers by GSTIN, then email, phone, email domain and company name. The result is **In SAP**, **Check match** or **New customer**. New customers can be turned into a lead or sent the ledger form in one click. Existing customers' mails also appear on their customer page (Mails tab). The first run goes back `MAIL_BACKFILL_DAYS` (90) days; after that it only reads new mail. IndiaMART / TradeIndia / JustDial buy-leads are read too, taking the buyer's details rather than the portal's.

1. **Microsoft 365 app**: reuse the existing **Enquiry Capture** app registration (Azure portal → Entra ID → App registrations). It needs the application permission **Mail.Read** with admin consent. Note its **Directory (tenant) ID** and **Application (client) ID**, and create a new **client secret** under Certificates & secrets if you no longer have the old one.
2. **Claude**: console.anthropic.com → API keys → create a key `bsc-crm-mail` (or reuse the key the Enquiry Capture pipeline used).
3. **Vercel** → Settings → Environment Variables, then **Redeploy**:

   | Name | Value |
   |---|---|
   | `MS_TENANT_ID` | Directory (tenant) ID |
   | `MS_CLIENT_ID` | Application (client) ID |
   | `MS_CLIENT_SECRET` | client secret **value** |
   | `ANTHROPIC_API_KEY` | `sk-ant-…` |
   | `MAIL_MAILBOX` | optional, default `info@bharatsteels.in` |
   | `MAIL_BACKFILL_DAYS` | optional, default `90` |
   | `MAIL_AI_MODEL` | optional, default `claude-haiku-5-5` |
   | `MAIL_IGNORE_DOMAINS` | optional, extra domains never to read, comma separated |

4. **Cron job, every 15 minutes** (cron-job.org or any scheduler):
   - URL: `https://crm.bharatsteels.in/api/cron?job=mail`, method **GET**
   - Header: `Authorization` = `Bearer <CRON_SECRET>`, with the same value as `CRON_SECRET` in Vercel
   - Schedule: every 15 minutes. The CRM answers at once (`202 started`) and keeps reading in the background for up to 4 minutes, so a 30-second timeout is fine.
   - To run it at once: **Check mail now** on the Mail tab (admins). Add `&wait=1` to the URL to wait for the result when testing.
5. **Retire the old pipeline**: in the old Enquiry Capture repo, Actions → its workflow → ⋯ → **Disable workflow**, so mails are not processed twice.

The first run of 90 days of mail takes a few runs (about 100–150 mails a run); the Mail tab shows "more to go" until it catches up. Cost: roughly ₹0.3–1 per mail read by Claude (more when PDFs are read); filtered mail costs nothing. "All mails" on the Mail tab shows every mail and what was done with it, including token usage.

### 8. Payment reminders (Receivables tab)

**Send** on a customer row, or **Send reminder** (choose several companies), sends each company:
- **Email** from info@bharatsteels.in (same SMTP settings as step 5): company name, total outstanding, overdue amount and a table of the open bills.
- **WhatsApp** through WATI using a template. Create it in WATI → Templates → New, category **Utility**, name `bsc_payment_reminder` (or set `WATI_AR_TEMPLATE` to your name), language English, with this body:

  > Dear {{company}}, this is a gentle reminder from Bharat Steel (Chennai) Pvt. Ltd. An amount of {{amount}} is outstanding in your account with us ({{bills}} bill(s), {{overdue}} overdue). Kindly arrange the payment at the earliest. Please ignore this message if already paid. For queries call 044 6791 7800.

  Sample values for approval: company `ABC Steels Pvt Ltd`, amount `₹1,25,000`, bills `3`, overdue `₹80,000`.

Amounts and contacts are read fresh from the receivables file when sending, never from the screen. The mobile and email are the ones in SAP. Every reminder is logged: "Sent <date>" on the row, an activity on the customer page, and the admin activity log. Optional: `AR_REMINDER_CC` (copy every reminder email to e.g. accounts@bharatsteels.in) and `AR_REMINDER_REPLY_TO`.

### 9. Feedback requests (Feedback tab → Customer list)

**Customer list** shows every customer invoiced in the selected period, with invoices, quantity (sortable, like every column), value, last invoice, last feedback and when the form was last sent. **Send** on a row, or **Send feedback** (choose several), sends the feedback form link with that customer's latest invoice number already filled in:
- **Email** from info@bharatsteels.in with a button and the QR code.
- **WhatsApp** through WATI using a template. Create it in WATI, category **Utility**, name `bsc_feedback_request` (or set `WATI_FEEDBACK_TEMPLATE`), with this body:

  > Dear {{company}}, thank you for buying from Bharat Steel (Chennai) Pvt. Ltd. We would value your feedback on invoice {{invoice}}. It takes 2 minutes: {{link}} Thank you.

  Sample values: company `ABC Steels Pvt Ltd`, invoice `BSC/5101`, link `https://crm.bharatsteels.in/feedback?inv=BSC%2F5101`.

Every send is logged on the row ("Feedback sent") and as an activity on the customer page.

## Files

```
api/_lib.js       schema, sessions, validation (GSTIN check digit), form definitions
api/_sap.js       reads the SAP data in Neon (customer page, dashboard, invoice lookup)
api/sap-push.js   receives the data from the SAP scheduled task
api/customers.js  customer list + customer 360          api/kyc.js       ledger form (public + review)
api/feedback.js   feedback form (public + analytics)    api/crm.js       dashboard, activities, leads
api/users.js      users, settings, log (admins)         api/sso.js       group portal sign-in
api/upload.js     direct-to-Blob uploads                api/files.js     open / register / delete documents
api/cron.js       daily draft clean-up
public/index.html + app.js + app.css   staff app        public/kyc.html, feedback.html   customer forms
sap-sync/         refresh_crm.ps1 (all SQL), INSTALL.md, readonly-login.sql
scripts/dev.js    local test server    tests/  api_smoke.py, simulate_push.js (plays the SAP task with demo data)
```
