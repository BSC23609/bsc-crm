# Smoke test of the CRM API against the local dev server + mock SAP bridge.
import json, urllib.request, http.cookiejar, sys
B = 'http://localhost:3000'
cj = http.cookiejar.CookieJar(); op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
pub = urllib.request.build_opener()
def call(path, body=None, o=None, expect=200):
    o = o or op
    req = urllib.request.Request(B + path, data=json.dumps(body).encode() if body is not None else None, headers={'content-type': 'application/json'})
    try: r = o.open(req); code, data = r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e: code, data = e.code, json.loads(e.read() or b'{}')
    if code != expect: print('!!', path, body and body.get('action'), code, data); sys.exit(1)
    return data
call('/api/auth', {'action': 'login', 'email': 'ai@bharatsteels.in', 'password': 'Admin@1234'})
form = {'company': 'Kaveri Test Fabricators Pvt Ltd', 'company_type': 'Manufacturer', 'phone': '+91 98400 12345', 'email': 'purchase@kaveritest.in',
  'buyer_types': ['Fabricator', 'OEM'], 'segment': 'General fabrication', 'usage': 'Monthly Requirement',
  'bill_address': 'No 12, SIDCO Estate, Ambattur', 'bill_district': 'Chennai', 'bill_pincode': '600058', 'bill_state': 'Tamil Nadu',
  'gstin': '27AAPFU0939F1ZV', 'reg_type': 'PVT LTD', 'bank_name': 'State Bank of India', 'bank_account': '00001234567890', 'ifsc': 'SBIN0001234',
  'ship_same': True}
bad = call('/api/kyc', {'action': 'submit', 'data': {**form, 'gstin': '33AAACB1234C1Z0', 'ifsc': 'XX'}}, pub, 400); print('bad form errors:', list(bad['errors']))
ok = call('/api/kyc', {'action': 'submit', 'data': form}, pub); print('kyc submit', ok)
lst = call('/api/kyc', {'action': 'list'}); r = lst['rows'][0]; print('kyc list', r['ref'], r['status'], 'warn', r['warn_n'], 'dup', r['dup_n'])
g = call('/api/kyc', {'action': 'get', 'id': r['id']}); print('warnings', g['row']['data']['_warnings'])
inv = call('/api/kyc', {'action': 'invite', 'card_code': 'C10003'}); print('invite', inv['token'][:6], inv['company'])
opt = call('/api/kyc', {'action': 'options', 't': inv['token']}, pub); print('prefill', opt['prefill']['company'], opt['prefill'].get('gstin'))
call('/api/kyc', {'action': 'update', 'id': r['id'], 'status': 'created', 'card_code': 'C10001', 'review_note': 'Created in SAP'})
c = call('/api/customers?code=C10001'); print('360 live', bool(c['live']), 'profile seg', c['profile']['segment'], 'kyc n', len(c['kyc']))
# Google form import
hdr = ['Timestamp','Company Name','Company Type','Contact Number','Email Address','Type of Buyer','Customer Industry Segment','Usage','Billing Address','District','Pincode','State','GST Certificate (Billing Address)','GST Number','Company Registration Type','Bank Trade Name','Bank Account Number','IFSC Code','Cancelled Cheque Copy','Trade Name','Shipping Address','District','Pincode','State','GST Number','GST Certificate (Shipping Address)']
row = ['2025/11/03 11:20:31 AM GMT+5:30','Old Import Co','Trader','9840011111','a@b.in','Re-seller, Fabricator','Re Sale','Once','Addr','Chennai','600001','tamil nadu','https://drive.google.com/open?id=abc','27AAPFU0939F1ZV','Prorietorship','HDFC','123456789','HDFC0000123','https://drive.google.com/open?id=def','Old Import Co','Ship addr','Thiruvallur','601201','Tamil Nadu','27AAPFU0939F1ZV','https://drive.google.com/open?id=ghi']
im = call('/api/kyc', {'action': 'import', 'headers': hdr, 'rows': [row, row]}); print('import', im)
# Feedback
fo = call('/api/feedback', {'action': 'options'}, pub)
ans = {q['key']: q['options'][0] for q in fo['questions']}
call('/api/feedback', {'action': 'submit', 'invoice_no': 'BSC/25-26/24005', 'answers': ans, 'comment': 'Good service'}, pub)
low = {**ans, 'q_delivery': 'Very dissatisfied'}
call('/api/feedback', {'action': 'submit', 'invoice_no': '24020', 'answers': low, 'comment': 'Late by 4 days'}, pub)
call('/api/feedback', {'action': 'submit', 'invoice_no': '24020', 'answers': ans}, pub)
e = call('/api/feedback', {'action': 'submit', 'answers': {}}, pub, 400); print('fb required', list(e['errors']))
fl = call('/api/feedback', {'action': 'list'})
for x in fl['rows']: print(' fb', x['invoice_no'], x['card_code'], x['customer_name'], x['score'], x['status'], x['discount'], x['discount_note'])
mh = ['ID','Start time','Completion time','Email','Name','1. Please enter the Invoice Number for the delivery','2. How satisfied are you with our delivery commitment (timeliness and reliability) ?','3. How would you rate the quality of the supplied material?','4. How satisfied are you with our response to your queries, issues, or complaints?','5. How clear and timely is our communication with you?','6. How would you rate your overall working relationship with us?','7. How satisfied are you with the documentation provided (Invoice, DC, Test Certificates, etc.)?','8. How satisfied are you with our pricing and commercial terms?','9. Any suggestion or comment to help us improve?']
mr = [1,'2026-10-01 10:00:00','2026-10-01 10:02:00','anonymous','', '24030','Somewhat satisfied','Very good','Very satisfied','Good','Excellent','','','Keep it up']
print('ms import', call('/api/feedback', {'action': 'import', 'headers': mh, 'rows': [mr, mr]}))
due = call('/api/crm', {'action': 'activities', 'due': True}); print('followups', [(a['subject'], a['follow_up_at'][:10]) for a in due['rows']])
call('/api/crm', {'action': 'activity_save', 'card_code': 'C10003', 'type': 'call', 'subject': 'Price discussion', 'follow_up_at': '2026-11-20'})
ld = call('/api/crm', {'action': 'lead_save', 'company': 'New Prospect Industries', 'phone': '9876543210', 'stage': 'quoted', 'est_mt': 40, 'source': 'WhatsApp', 'product': 'HR Coil'})
call('/api/crm', {'action': 'activity_save', 'lead_id': ld['id'], 'type': 'visit', 'subject': 'Factory visit'})
print('leads', [(l['company'], l['stage']) for l in call('/api/crm', {'action': 'leads'})['rows']])
d = call('/api/crm', {'action': 'dashboard'}); print('dash fu', d['fu'], 'kyc', d['kyc'], 'fb', d['fb'], 'leads', d['leads'])
print('users', len(call('/api/users', {'action': 'list'})['users']))
call('/api/customers', {'action': 'profile', 'code': 'C10003', 'segment': 'Auto OEM', 'buyer_types': ['OEM'], 'tags': 'key account, monthly'})
print('ALL OK')
