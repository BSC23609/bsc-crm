<#
  refresh_crm.ps1 - SAP Business One -> Customer CRM (crm.bharatsteels.in)
  Same model as refresh_stock.ps1: runs on the SAP server every 15 minutes (Task Scheduler), queries
  BSC_FINAL_2707 READ-ONLY, and sends the results to the CRM over HTTPS. No git, no CSV files, no inbound port.

  What it sends each run:
    customers   all customers with balance, credit limit, open orders, last invoice, 365-day sales   (every run, full)
    orders      open sales orders                                                                   (every run, full)
    invoices    A/R invoices          - first run of the day: last 24 months; otherwise changed in the last 3 days
    payments    incoming payments     - same
    monthly     net sales per customer per month (13 months; otherwise this + last month)
    addresses / contacts              - first run of the day: all; otherwise customers changed in the last 3 days

  Run by hand first (PowerShell, NOT cmd):
      powershell -ExecutionPolicy Bypass -File C:\scripts\refresh_crm.ps1            (normal run)
      powershell -ExecutionPolicy Bypass -File C:\scripts\refresh_crm.ps1 -Full      (force the full 24-month run)
  Then schedule it - see INSTALL.md.

  Config: the same C:\scripts\config.ini as refresh_stock.ps1, plus two lines:
      crm_url=https://crm.bharatsteels.in
      crm_push_secret=<same value as SAP_PUSH_SECRET in the CRM's Vercel settings>
#>
param([switch]$Full)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Cfg       = "C:\scripts\config.ini"
$LogFile   = "C:\scripts\refresh_crm.log"
$StateFile = "C:\scripts\refresh_crm.state"      # date of the last successful full run
$BatchSize = 1000

function Log($m){ "$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss'))  $m" | Tee-Object -FilePath $LogFile -Append }

# ---- keep the log small (last ~5000 lines) ----
if((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 2MB){ $t=Get-Content $LogFile -Tail 5000; Set-Content $LogFile $t }

# ---- read config.ini ----
$ini=@{}; Get-Content $Cfg | ForEach-Object {
  if($_ -match '^\s*([^=;#\[]+)=(.*)$'){ $ini[$matches[1].Trim().ToLower()]=$matches[2].Trim() }
}
$dbUser = if($ini.crm_db_user){$ini.crm_db_user}elseif($ini.username){$ini.username}else{$ini.user}
$dbPass = if($ini.crm_db_user){$ini.crm_db_password}else{$ini.password}
$CrmUrl = if($ini.crm_url){$ini.crm_url.TrimEnd('/')}else{'https://crm.bharatsteels.in'}
$Secret = $ini.crm_push_secret
if(-not $ini.server -or -not $dbUser){ Log "ERROR: config.ini missing server/username - check $Cfg"; exit 1 }
if(-not $Secret -or $Secret.Length -lt 16){ Log "ERROR: crm_push_secret missing in $Cfg (16+ characters, same as SAP_PUSH_SECRET on Vercel)"; exit 1 }
$db = if($ini.database){$ini.database}else{'BSC_FINAL_2707'}
$connStr="Server=$($ini.server);Database=$db;User Id=$dbUser;Password=$dbPass;TrustServerCertificate=True;Connect Timeout=30;ApplicationIntent=ReadOnly"

function Invoke-Sql($sql){
  $conn=New-Object System.Data.SqlClient.SqlConnection $connStr
  $conn.Open()
  try{
    $cmd=$conn.CreateCommand(); $cmd.CommandText=$sql; $cmd.CommandTimeout=300
    $da=New-Object System.Data.SqlClient.SqlDataAdapter $cmd
    $dt=New-Object System.Data.DataTable; [void]$da.Fill($dt)
  } finally { $conn.Close() }
  return ,$dt   # comma stops PowerShell unrolling the table into rows
}
# Some SAP versions lack a localisation column (CRD1.GSTRegnNo, NNM1.BeginStr): fall back to the simpler query.
function Invoke-SqlTry($sql, $lite){
  try { return ,(Invoke-Sql $sql) }
  catch { if($lite -and $_.Exception.Message -match 'Invalid (column|object) name'){ Log "  (using simpler query: $($_.Exception.Message))"; return ,(Invoke-Sql $lite) } throw }
}

# DataTable -> array of plain objects for JSON (dates as yyyy-MM-dd, decimals as numbers, NULL as null)
function Get-Rows([System.Data.DataTable]$dt){
  $cols=@($dt.Columns | ForEach-Object { $_.ColumnName })
  $out=New-Object System.Collections.Generic.List[object]
  foreach($r in $dt.Rows){
    $h=[ordered]@{}
    foreach($c in $cols){
      $v=$r[$c]
      if($v -is [DBNull]){ $v=$null }
      elseif($v -is [DateTime]){ $v=$v.ToString('yyyy-MM-dd') }
      elseif($v -is [decimal] -or $v -is [single]){ $v=[double]$v }
      elseif($v -is [string]){ $v=$v.Trim() }
      $h[$c]=$v
    }
    $out.Add($h)
  }
  return ,$out.ToArray()
}

$Run = [DateTime]::Now.ToString('yyyyMMddHHmmss') + '-' + (Get-Random -Maximum 99999)
function Send-Crm($body){
  $json  = $body | ConvertTo-Json -Depth 6 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $tries = 0
  while($true){
    try {
      return Invoke-RestMethod -Uri "$CrmUrl/api/sap-push" -Method Post -Body $bytes -ContentType 'application/json; charset=utf-8' `
                               -Headers @{ Authorization = "Bearer $Secret" } -TimeoutSec 120 -UseBasicParsing
    } catch {
      $tries++
      if($tries -ge 3){ throw "CRM upload failed ($($body.section)): $($_.Exception.Message)" }
      Start-Sleep -Seconds (5 * $tries)
    }
  }
}
# mode: replace = this run sends the whole section (CRM removes what was not sent);  upsert = only changed rows
function Send-Section($section, [System.Data.DataTable]$dt, $mode){
  $rows=Get-Rows $dt; $n=$rows.Count
  if($n -eq 0){ $null=Send-Crm @{ run=$Run; section=$section; mode=$mode; rows=@(); last=$true }; return 0 }
  for($i=0; $i -lt $n; $i+=$BatchSize){
    $j=[Math]::Min($i+$BatchSize, $n)-1
    $null=Send-Crm @{ run=$Run; section=$section; mode=$mode; rows=@($rows[$i..$j]); last=($j -eq $n-1) }
  }
  return $n
}

# ---- single instance ----
$LockPath="$env:TEMP\refresh_crm.lock"
if(Test-Path $LockPath){
  $age=(Get-Date)-(Get-Item $LockPath).LastWriteTime
  if($age.TotalMinutes -lt 30){ Log "Another instance is running (lock age $([int]$age.TotalSeconds)s). Exiting."; exit 0 }
  Remove-Item $LockPath -Force
}
New-Item $LockPath -ItemType File -Force | Out-Null

$today = [DateTime]::Now.ToString('yyyy-MM-dd')
$lastFull = if(Test-Path $StateFile){ (Get-Content $StateFile -Raw).Trim() } else { '' }
$isFull = $Full -or ($lastFull -ne $today)

# ======================= QUERIES (read-only) =======================
$SINCE = "DATEADD(day,-3,CAST(GETDATE() AS date))"

$custCols = @"
  C.CardCode, C.CardName, C.CardFName, C.GroupCode, G.GroupName, C.Phone1, C.Phone2, C.Cellular, C.E_Mail, C.CntctPrsn,
  C.Balance, C.OrdersBal, C.DNotesBal, C.CreditLine, C.DebtLine, C.SlpCode, S.SlpName, T.PymntGroup,
  C.City, C.ZipCode, C.County, C.frozenFor, C.validFor, C.CreateDate, C.UpdateDate,
  (SELECT TOP 1 A.State FROM CRD1 A WHERE A.CardCode = C.CardCode AND A.AdresType = 'B') AS State,
  (SELECT TOP 1 A.City  FROM CRD1 A WHERE A.CardCode = C.CardCode AND A.AdresType = 'B') AS BillCity,
  L.LastInvoice, ISNULL(L.Sales365,0) AS Sales365, ISNULL(L.Sales90,0) AS Sales90, ISNULL(L.Invoices365,0) AS Invoices365, ISNULL(Q.Qty365,0) AS Qty365
"@
$custFrom = @"
FROM OCRD C
LEFT JOIN OCRG G ON G.GroupCode = C.GroupCode
LEFT JOIN OSLP S ON S.SlpCode = C.SlpCode
LEFT JOIN OCTG T ON T.GroupNum = C.GroupNum
LEFT JOIN (
  SELECT I.CardCode, MAX(I.DocDate) AS LastInvoice,
         SUM(CASE WHEN I.DocDate >= DATEADD(day,-365,CAST(GETDATE() AS date)) THEN I.DocTotal - I.VatSum ELSE 0 END) AS Sales365,
         SUM(CASE WHEN I.DocDate >= DATEADD(day,-90, CAST(GETDATE() AS date)) THEN I.DocTotal - I.VatSum ELSE 0 END) AS Sales90,
         COUNT(CASE WHEN I.DocDate >= DATEADD(day,-365,CAST(GETDATE() AS date)) THEN 1 END) AS Invoices365
  FROM OINV I WHERE I.CANCELED = 'N' GROUP BY I.CardCode
) L ON L.CardCode = C.CardCode
LEFT JOIN (
  SELECT I.CardCode, SUM(R.Quantity) AS Qty365
  FROM OINV I JOIN INV1 R ON R.DocEntry = I.DocEntry
  WHERE I.CANCELED = 'N' AND I.DocDate >= DATEADD(day,-365,CAST(GETDATE() AS date))
  GROUP BY I.CardCode
) Q ON Q.CardCode = C.CardCode
WHERE C.CardType = 'C'
"@
$custSql  = "SELECT (SELECT TOP 1 A.GSTRegnNo FROM CRD1 A WHERE A.CardCode = C.CardCode AND A.AdresType = 'B' AND ISNULL(A.GSTRegnNo,'') <> '') AS GSTIN, $custCols $custFrom"
$custLite = "SELECT C.LicTradNum AS GSTIN, $custCols $custFrom"

$custChanged = if($isFull){ "" } else { " AND A.CardCode IN (SELECT CardCode FROM OCRD WHERE CardType = 'C' AND UpdateDate >= $SINCE)" }
$addrSql  = "SELECT A.CardCode, A.Address AS Name, A.AdresType AS Type, A.Street, A.Block, A.Building, A.City, A.County, A.ZipCode, A.State, A.Country, A.GSTRegnNo AS GSTIN FROM CRD1 A JOIN OCRD C ON C.CardCode = A.CardCode AND C.CardType = 'C' WHERE 1 = 1 $custChanged"
$addrLite = "SELECT A.CardCode, A.Address AS Name, A.AdresType AS Type, A.Street, A.Block, A.Building, A.City, A.County, A.ZipCode, A.State, A.Country, NULL AS GSTIN FROM CRD1 A JOIN OCRD C ON C.CardCode = A.CardCode AND C.CardType = 'C' WHERE 1 = 1 $custChanged"
$contSql  = "SELECT A.CardCode, A.CntctCode, A.Name, A.FirstName, A.LastName, A.Position, A.Tel1, A.Cellolar AS Mobile, A.E_MailL AS Email, A.Active FROM OCPR A JOIN OCRD C ON C.CardCode = A.CardCode AND C.CardType = 'C' WHERE 1 = 1 $custChanged"

$ordersSql = @"
SELECT O.DocEntry, O.DocNum, O.CardCode, O.DocDate, O.DocDueDate, O.DocTotal, O.NumAtCard, O.CANCELED,
       (SELECT SUM(R.Quantity) FROM RDR1 R WHERE R.DocEntry = O.DocEntry) AS Qty,
       (SELECT SUM(R.OpenQty)  FROM RDR1 R WHERE R.DocEntry = O.DocEntry) AS OpenQty
FROM ORDR O JOIN OCRD C ON C.CardCode = O.CardCode AND C.CardType = 'C'
WHERE O.DocStatus = 'O' AND O.CANCELED = 'N'
"@

$invWhere = if($isFull){ "I.CANCELED = 'N' AND I.DocDate >= DATEADD(month,-24,CAST(GETDATE() AS date))" } else { "I.UpdateDate >= $SINCE" }
$invCols = @"
  I.DocEntry, I.DocNum, I.CardCode, I.CardName, I.DocDate, I.DocDueDate, I.DocTotal, I.VatSum, I.PaidToDate, I.DocStatus, I.CANCELED,
  I.NumAtCard, I.SlpCode, S.SlpName,
  (SELECT SUM(R.Quantity) FROM INV1 R WHERE R.DocEntry = I.DocEntry) AS Qty,
  (SELECT TOP 1 R.Dscription FROM INV1 R WHERE R.DocEntry = I.DocEntry ORDER BY R.LineTotal DESC)
    + CASE WHEN (SELECT COUNT(*) FROM INV1 R WHERE R.DocEntry = I.DocEntry) > 1
           THEN ' +' + CAST((SELECT COUNT(*) FROM INV1 R WHERE R.DocEntry = I.DocEntry) - 1 AS varchar(10)) + ' more' ELSE '' END AS Items
"@
$invSql  = "SELECT ISNULL(N.BeginStr,'') + CAST(I.DocNum AS varchar(20)) + ISNULL(N.EndStr,'') AS InvoiceNo, $invCols FROM OINV I LEFT JOIN NNM1 N ON N.Series = I.Series LEFT JOIN OSLP S ON S.SlpCode = I.SlpCode JOIN OCRD C ON C.CardCode = I.CardCode AND C.CardType = 'C' WHERE $invWhere"
$invLite = "SELECT CAST(I.DocNum AS varchar(20)) AS InvoiceNo, $invCols FROM OINV I LEFT JOIN OSLP S ON S.SlpCode = I.SlpCode JOIN OCRD C ON C.CardCode = I.CardCode AND C.CardType = 'C' WHERE $invWhere"

$payWhere = if($isFull){ "P.Canceled = 'N' AND P.DocDate >= DATEADD(month,-24,CAST(GETDATE() AS date))" } else { "P.UpdateDate >= $SINCE" }
$paySql = "SELECT P.DocEntry, P.DocNum, P.CardCode, P.DocDate, P.DocTotal, P.TrsfrRef, P.Comments, P.Canceled FROM ORCT P JOIN OCRD C ON C.CardCode = P.CardCode AND C.CardType = 'C' WHERE $payWhere"

$monthFrom = if($isFull){ "DATEADD(month, -12, DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1))" } else { "DATEADD(month, -1, DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1))" }
$monthlySql = @"
SELECT Z.CardCode, Z.M, SUM(Z.Amt) AS Sales, SUM(Z.Qty) AS Qty FROM (
  SELECT I.CardCode, CONVERT(char(7), I.DocDate, 126) AS M, I.DocTotal - I.VatSum AS Amt,
         (SELECT SUM(R.Quantity) FROM INV1 R WHERE R.DocEntry = I.DocEntry) AS Qty
  FROM OINV I WHERE I.CANCELED = 'N' AND I.DocDate >= $monthFrom
  UNION ALL
  SELECT X.CardCode, CONVERT(char(7), X.DocDate, 126), -(X.DocTotal - X.VatSum),
         -(SELECT SUM(R.Quantity) FROM RIN1 R WHERE R.DocEntry = X.DocEntry)
  FROM ORIN X WHERE X.CANCELED = 'N' AND X.DocDate >= $monthFrom
) Z JOIN OCRD C ON C.CardCode = Z.CardCode AND C.CardType = 'C'
GROUP BY Z.CardCode, Z.M
"@

# ======================= RUN =======================
try {
  Log "CRM refresh ($(if($isFull){'FULL'}else{'incremental'})) run $Run"
  $up = if($isFull){'replace'}else{'upsert'}
  $counts=[ordered]@{}

  $t=Invoke-SqlTry $custSql $custLite
  if($t.Rows.Count -eq 0){ throw "Customer query returned 0 rows - not sending (would mark everyone as removed)." }
  $counts.customers = Send-Section 'customers' $t 'replace';           Log "  customers $($counts.customers)"
  $t=Invoke-Sql $ordersSql;              $counts.orders    = Send-Section 'orders'    $t 'replace'; Log "  open orders $($counts.orders)"
  $t=Invoke-SqlTry $invSql $invLite;     $counts.invoices  = Send-Section 'invoices'  $t $up;       Log "  invoices $($counts.invoices)"
  $t=Invoke-Sql $paySql;                 $counts.payments  = Send-Section 'payments'  $t $up;       Log "  payments $($counts.payments)"
  $t=Invoke-Sql $monthlySql;             $counts.monthly   = Send-Section 'monthly'   $t $up;       Log "  monthly rows $($counts.monthly)"
  $t=Invoke-SqlTry $addrSql $addrLite;   $counts.addresses = Send-Section 'addresses' $t $up;       Log "  addresses $($counts.addresses)"
  $t=Invoke-Sql $contSql;                $counts.contacts  = Send-Section 'contacts'  $t $up;       Log "  contacts $($counts.contacts)"

  $r = Send-Crm @{ run=$Run; section='done'; full=[bool]$isFull; counts=$counts }
  if($isFull){ Set-Content -Path $StateFile -Value $today }
  Log "Done. Feedback matched to invoices: $($r.feedbackMatched)"
}
catch {
  Log "ERROR: $($_.Exception.Message)"
  try { $null = Send-Crm @{ run=$Run; section='error'; message=$_.Exception.Message } } catch { }
  exit 1
}
finally {
  if(Test-Path $LockPath){ Remove-Item $LockPath -Force -ErrorAction SilentlyContinue }
}
