-- Optional but recommended: a read-only SQL login just for the CRM scheduled task (run in SSMS as sa / sysadmin).
-- Then put  crm_db_user=crm_reader  and  crm_db_password=...  in C:\scripts\config.ini
CREATE LOGIN crm_reader WITH PASSWORD = 'CHANGE-ME-Strong#Pass1', CHECK_POLICY = ON;
USE BSC_FINAL_2707;
CREATE USER crm_reader FOR LOGIN crm_reader;
ALTER ROLE db_datareader ADD MEMBER crm_reader;
