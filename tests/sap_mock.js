// Demo data with the same column names SAP returns, so the CRM can be tried before the tunnel is live.
// Every company below is invented.
let rnd = 20261126;
const r = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = a => a[Math.floor(r() * a.length)];
const day = n => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - n); return d; };

const PRE = ['Sri', 'Annai', 'Velan', 'Kaveri', 'Ganesh', 'Murugan', 'Pallava', 'Chola', 'Sakthi', 'Lakshmi', 'Vetri', 'Arasu', 'Thirumalai', 'Bhavani', 'Kovai', 'Selvam', 'Om', 'Jaya', 'Mahalakshmi', 'Sundaram'];
const MID = ['Engineering', 'Fabricators', 'Structurals', 'Auto Components', 'Steel Traders', 'Infra Projects', 'Industries', 'Pressings', 'Boilers', 'Precision Works', 'Buildtech', 'Forgings'];
const SUF = ['Pvt Ltd', 'Pvt Ltd', 'LLP', '', 'Industries Pvt Ltd'];
const CITY = [['Chennai', 'Tamil Nadu', '33'], ['Sriperumbudur', 'Tamil Nadu', '33'], ['Hosur', 'Tamil Nadu', '33'], ['Coimbatore', 'Tamil Nadu', '33'], ['Salem', 'Tamil Nadu', '33'], ['Bengaluru', 'Karnataka', '29'], ['Tirupati', 'Andhra Pradesh', '37'], ['Puducherry', 'Puducherry', '34']];
const SLP = [[1, 'Venkatesh'], [2, 'Dhanraj'], [3, 'Karthik'], [4, 'Priya']];
const GRP = [[100, 'Domestic Customers'], [101, 'OEM'], [102, 'Fabricators'], [103, 'Traders']];

const customers = [];
const invoices = [];
let docNum = 24000, entry = 1;
for (let i = 0; i < 64; i++) {
  const [city, state, sc] = pick(CITY);
  const [slp, slpName] = pick(SLP);
  const [gc, gn] = pick(GRP);
  const name = `${pick(PRE)} ${pick(MID)} ${pick(SUF)}`.trim().replace(/\s+/g, ' ');
  const code = 'C' + String(10001 + i);
  const pan = 'AAB' + 'CDEFGHJK'[i % 8] + 'S' + String(1000 + i * 7).slice(-4) + 'Q';
  const dormant = r() < 0.18;
  const c = {
    CardCode: code, CardName: name, CardFName: null, GroupCode: gc, GroupName: gn,
    Phone1: '044' + Math.floor(20000000 + r() * 7e7), Phone2: null, Cellular: '9' + Math.floor(100000000 + r() * 899999999),
    E_Mail: name.split(' ')[1].toLowerCase() + i + '@example.in', CntctPrsn: pick(['Ramesh', 'Suresh', 'Anitha', 'Kumar', 'Prakash', 'Deepa']),
    Balance: 0, OrdersBal: 0, DNotesBal: 0, CreditLine: pick([0, 500000, 1000000, 2500000, 5000000]), DebtLine: 0,
    SlpCode: slp, SlpName: slpName, PymntGroup: pick(['Advance', '30 Days', '45 Days', '60 Days']),
    City: city, ZipCode: String(600001 + Math.floor(r() * 900)), County: city,
    frozenFor: r() < 0.04 ? 'Y' : 'N', validFor: 'Y', CreateDate: day(200 + Math.floor(r() * 2000)), UpdateDate: day(Math.floor(r() * 90)),
    GSTIN: `${sc}${pan}1Z${'0123456789'[i % 10]}`, State: state, BillCity: city,
    LastInvoice: null, Sales365: 0, Sales90: 0, Invoices365: 0, Qty365: 0
  };
  const n = dormant ? 1 + Math.floor(r() * 3) : 3 + Math.floor(r() * 14);
  for (let k = 0; k < n; k++) {
    const age = dormant ? 120 + Math.floor(r() * 300) : Math.floor(r() * 360);
    const qty = Math.round((2 + r() * 38) * 1000) / 1000;
    const rate = 52000 + Math.floor(r() * 14000);
    const net = Math.round(qty * rate), vat = Math.round(net * 0.18);
    const due = new Date(day(age)); due.setDate(due.getDate() + 30);
    const paid = age > 75 || r() < 0.55 ? net + vat : (r() < 0.4 ? Math.round((net + vat) / 2) : 0);
    invoices.push({ DocEntry: entry++, DocNum: docNum++, CardCode: code, CardName: name, DocDate: day(age), DocDueDate: due, DocTotal: net + vat, VatSum: vat, PaidToDate: paid, Qty: qty, SlpCode: slp, SlpName: slpName });
  }
  customers.push(c);
}
for (const c of customers) {
  const mine = invoices.filter(x => x.CardCode === c.CardCode);
  c.LastInvoice = mine.reduce((a, x) => (!a || x.DocDate > a ? x.DocDate : a), null);
  for (const x of mine) {
    const age = (Date.now() - x.DocDate) / 864e5;
    if (age <= 365) { c.Sales365 += x.DocTotal - x.VatSum; c.Invoices365++; c.Qty365 += x.Qty; }
    if (age <= 90) c.Sales90 += x.DocTotal - x.VatSum;
    c.Balance += x.DocTotal - x.PaidToDate;
  }
  c.OrdersBal = r() < 0.3 ? Math.round(200000 + r() * 1500000) : 0;
  c.Qty365 = Math.round(c.Qty365 * 1000) / 1000;
}
customers.sort((a, b) => a.CardName.localeCompare(b.CardName));

const inv = x => ({ ...x, InvoiceNo: 'BSC/25-26/' + x.DocNum, DocStatus: x.PaidToDate >= x.DocTotal ? 'C' : 'O', NumAtCard: 'PO-' + (x.DocNum % 977), SlpName: x.SlpName });
const ym = d => d.toISOString().slice(0, 7);

export function mock(name, p) {
  const mineAll = () => invoices.filter(x => x.CardCode === p.code).sort((a, b) => b.DocDate - a.DocDate);
  switch (name) {
    case 'customers': return customers;
    case 'customer': return customers.filter(c => c.CardCode === p.code);
    case 'addresses': {
      const c = customers.find(x => x.CardCode === p.code); if (!c) return [];
      return [
        { Name: 'Bill To', Type: 'B', Street: 'No. ' + (10 + c.CardCode.slice(-2) * 1) + ', SIDCO Industrial Estate', Block: 'Phase II', Building: null, City: c.City, County: c.County, ZipCode: c.ZipCode, State: c.State, Country: 'IN', GSTIN: c.GSTIN },
        { Name: 'Factory', Type: 'S', Street: 'Plot ' + c.CardCode.slice(-3) + ', SIPCOT', Block: null, Building: null, City: c.City, County: c.County, ZipCode: c.ZipCode, State: c.State, Country: 'IN', GSTIN: c.GSTIN }
      ];
    }
    case 'contacts': { const c = customers.find(x => x.CardCode === p.code); return c ? [{ Name: c.CntctPrsn, FirstName: c.CntctPrsn, LastName: '', Position: 'Purchase', Tel1: c.Phone1, Mobile: c.Cellular, Email: c.E_Mail, Active: 'Y' }] : []; }
    case 'invoices': return mineAll().slice(0, p.limit || 25).map(inv);
    case 'invoiceLines': { const x = invoices.find(i => i.DocEntry === p.entry); return x ? [{ LineNum: 0, ItemCode: 'HRC2.00X1250', Item: 'HR COIL 2.00 X 1250 E250', Quantity: x.Qty, Uom: 'MT', Price: Math.round((x.DocTotal - x.VatSum) / x.Qty), LineTotal: x.DocTotal - x.VatSum }] : []; }
    case 'orders': { const c = customers.find(x => x.CardCode === p.code); return c && c.OrdersBal ? [{ DocEntry: 9000 + Number(c.CardCode.slice(-2)), DocNum: 5100 + Number(c.CardCode.slice(-2)), DocDate: day(6), DocDueDate: day(-8), DocTotal: c.OrdersBal, NumAtCard: 'PO-OPEN', Qty: 18.5, OpenQty: 12.25 }] : []; }
    case 'payments': return mineAll().filter(x => x.PaidToDate > 0).slice(0, p.limit || 15).map((x, k) => ({ DocEntry: 7000 + x.DocEntry, DocNum: 3000 + x.DocEntry, DocDate: day(Math.max(0, (Date.now() - x.DocDate) / 864e5 - 20)), DocTotal: x.PaidToDate, TrsfrRef: 'UTR' + (88000 + x.DocEntry), Comments: null }));
    case 'aging': return mineAll().filter(x => x.PaidToDate < x.DocTotal).map(x => ({ DocNum: x.DocNum, DocDate: x.DocDate, DocDueDate: x.DocDueDate, DocTotal: x.DocTotal, PaidToDate: x.PaidToDate, OpenAmt: x.DocTotal - x.PaidToDate, DaysOverdue: Math.floor((Date.now() - x.DocDueDate) / 864e5) }));
    case 'monthly': {
      const m = {}; for (const x of mineAll()) { const k = ym(x.DocDate); m[k] = m[k] || { M: k, Sales: 0, Qty: 0 }; m[k].Sales += x.DocTotal - x.VatSum; m[k].Qty += x.Qty; }
      return Object.values(m).sort((a, b) => a.M.localeCompare(b.M)).slice(-13);
    }
    case 'invoiceLookup': return invoices.filter(x => x.DocNum === p.num).map(inv);
    case 'summarySales': {
      const now = new Date(), mStart = new Date(now.getFullYear(), now.getMonth(), 1), lStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const fy = new Date(now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear(), 3, 1);
      const s = { SalesMTD: 0, SalesLastMonth: 0, SalesFYTD: 0, Active90: new Set() };
      for (const x of invoices) {
        const v = x.DocTotal - x.VatSum;
        if (x.DocDate >= mStart) s.SalesMTD += v; else if (x.DocDate >= lStart) s.SalesLastMonth += v;
        if (x.DocDate >= fy) s.SalesFYTD += v;
        if ((Date.now() - x.DocDate) / 864e5 <= 90) s.Active90.add(x.CardCode);
      }
      return [{ ...s, Active90: s.Active90.size }];
    }
    case 'summaryAging': {
      const b = { NotDue: 0, D1_30: 0, D31_60: 0, D61_90: 0, D90Plus: 0 };
      for (const x of invoices) {
        const open = x.DocTotal - x.PaidToDate; if (open <= 0) continue;
        const d = Math.floor((Date.now() - x.DocDueDate) / 864e5);
        if (d <= 0) b.NotDue += open; else if (d <= 30) b.D1_30 += open; else if (d <= 60) b.D31_60 += open; else if (d <= 90) b.D61_90 += open; else b.D90Plus += open;
      }
      return [b];
    }
    case 'summaryMonthly': {
      const m = {}; for (const x of invoices) { const k = ym(x.DocDate); m[k] = m[k] || { M: k, Sales: 0, c: new Set() }; m[k].Sales += x.DocTotal - x.VatSum; m[k].c.add(x.CardCode); }
      return Object.values(m).sort((a, b) => a.M.localeCompare(b.M)).slice(-13).map(x => ({ M: x.M, Sales: x.Sales, Customers: x.c.size }));
    }
    default: throw new Error('mock: unknown query ' + name);
  }
}
