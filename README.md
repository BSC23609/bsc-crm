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
   | `CRON_SECRET` | random text (daily clean-up of abandoned form drafts) |
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

"Send ledger form" (Ledger forms page, customer page or lead) creates a personal link and sends it to the customer:
an **email from info@bharatsteels.in** with a button and QR code, and a **WhatsApp message via WATI** with the link.
"Send link again" on a request re-sends it (e.g. to a corrected email or number); every send is logged on the request.

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
| `WATI_KYC_TEMPLATE` | `bsc_ledger_form` (optional, this is the default) |
| `APP_URL` | optional — the address put in every customer link and QR code; default `https://crm.bharatsteels.in` |

Microsoft 365: *Authenticated SMTP* must be enabled for the info@ mailbox (M365 admin centre → Users → info@ → Mail → Manage email apps → tick **Authenticated SMTP**).

WATI: create and get approved a template named **bsc_ledger_form** (category **Utility**):

- **Header:** Media → **Image**, URL `https://crm.bharatsteels.in/qr/{{qr_image}}.png` — the CRM fills `qr_image` with the
  customer's link code, so the picture is that customer's own QR. (The address also answers WATI's check with a sample QR.)
- **Body**, for example:

    Dear {{1}},
    To open the customer ledger for {{2}} with Bharat Steel (Chennai) Pvt. Ltd., please fill in the Ledger Creation Data Sheet here: {{3}}
    Please keep your GST certificate and a cancelled cheque ready to upload. Thank you.

({{1}} contact name, {{2}} company, {{3}} the form link.) If you prefer a text-only template (no image header), set `WATI_KYC_QR=0`.

## Notes

- Feedback Q3 in the current Microsoft Form shows "Fair" twice; the CRM uses Excellent / Very good / Good / Fair / Poor.
- Scores: first option = 5 … last = 1. CSAT = share of answers in the top two options.
- Invoice matching uses the digits at the end of what the customer types (e.g. `BSC/25-26/24005` → DocNum 24005) and prefers the series whose printed number matches. Feedback for an invoice made in the last 15 minutes is matched on the next SAP run.
- The header shows the time of the last SAP update; a failed run or no update for 45 minutes shows a warning with the reason.
- Sales figures are taxable value (DocTotal − VAT/GST); quantities are the invoice line quantity (MT for steel items).

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
