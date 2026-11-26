# SAP → CRM scheduled task (on the SAP server)

Same setup as `refresh_stock.ps1`: a PowerShell job in Task Scheduler, every 15 minutes, reading SAP Business One
(`BSC_FINAL_2707`) read-only and sending the data to https://crm.bharatsteels.in. Nothing is pushed to GitHub.

## 1. Files
Copy `refresh_crm.ps1` to `C:\scripts\`.

## 2. config.ini
Add two lines to `C:\scripts\config.ini` (the file refresh_stock.ps1 already uses — server, database, username, password stay as they are):

    crm_url=https://crm.bharatsteels.in
    crm_push_secret=<long random text — the SAME value as SAP_PUSH_SECRET in the CRM's Vercel settings>

Make a secret in PowerShell: `[Convert]::ToBase64String((1..36 | % {Get-Random -Max 256}))`

Optional (recommended): a read-only SQL login just for this job — run `readonly-login.sql` in SSMS, then add
`crm_db_user=crm_reader` and `crm_db_password=...`. Without these it uses the existing `username` / `password`.

## 3. First run by hand
PowerShell (not cmd):

    powershell -ExecutionPolicy Bypass -File C:\scripts\refresh_crm.ps1 -Full

Watch `C:\scripts\refresh_crm.log`. A good run ends with `Done.` and shows counts for customers, open orders, invoices,
payments, monthly rows, addresses and contacts. The first full run sends 24 months of invoices, so it takes a few minutes.
If a query fails, the log names the SAP column — send that line over.

## 4. Schedule every 15 minutes
Administrator Command Prompt (one line):

    schtasks /Create /TN "BSC CRM Refresh" /RU SYSTEM /RL HIGHEST /SC MINUTE /MO 15 /F /TR "powershell -NoProfile -ExecutionPolicy Bypass -File C:\scripts\refresh_crm.ps1"

Run it now: `schtasks /Run /TN "BSC CRM Refresh"`.
The first run each day is a full run (24 months); the others send only what changed in the last 3 days, plus every
customer's balance and the open orders. Force a full run any time with `-Full`.

## Checks
- The CRM header shows the time of the last SAP update. If the task stops for 45 minutes, or a run fails, the CRM shows a
  warning banner with the error.
- Stop: `schtasks /End /TN "BSC CRM Refresh"`. Remove: `schtasks /Delete /TN "BSC CRM Refresh" /F`.
