// Node tests for src/orderEngine.js (the same file the page loads). Run: node tests/verify.js
const E = require('../src/orderEngine.js');
const D = require('../data/sample.json');
const fresh = () => JSON.parse(JSON.stringify(D));
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}
const byId = (orders) => Object.fromEntries(orders.map((o) => [o.id, o]));
const codes = (o) => o.issues.map((x) => x.code);

console.log('1. Numbers, money and dates');
ok('1.1 German and English number formats', E.parseNum('2.000') === 2000 && E.parseNum('0,19') === 0.19 && E.parseNum('1.250,00') === 1250 && E.parseNum('1,250.00') === 1250 && E.parseNum('abc') === null);
ok('1.2 commercial rounding: 5 x 3,705 = 18,53', E.round(5 * 3.705) === 18.53 && E.round(-2.675) === -2.68);
ok('1.3 money in German format', E.fmtMoney(1250.5) === '1.250,50 €');
ok('1.4 KW 46/2026 starts Monday 9 Nov', E.parseDate('KW 46', '2026-11-02') === '2026-11-09' && E.parseDate('KW 1/2027', '2026-11-02') === '2027-01-04');
ok('1.5 dates: 06.11. takes this year, 31.02. is refused', E.parseDate('06.11.', '2026-11-02') === '2026-11-06' && E.parseDate('31.02.2026', '2026-11-02') === null);
ok('1.6 Easter 2026 is 5 April; Fronleichnam 4 June in NW', E.easter(2026) === '2026-04-05' && E.holidays(2026, 'NW')['2026-06-04'] === 'Fronleichnam');
ok('1.7 holidays differ by state (6 Jan only in BY)', E.holidays(2026, 'BY')['2026-01-06'] && !E.holidays(2026, 'NW')['2026-01-06']);
ok('1.8 next workday after Christmas Day 2026 is Mon 28 Dec', E.nextWorkday('2026-12-25', 'NW') === '2026-12-28');

const t0 = fresh();
const A = byId(E.processInbox(t0.tenants[0], D.today));
const B = byId(E.processInbox(t0.tenants[1], D.today));

console.log('2. Reading the sample orders');
ok('2.1 plain email: 3 lines, cartons converted to pieces', A['M-1041'].lines.length === 3 && A['M-1041'].lines[0].qtyBase === 2000 && A['M-1041'].lines[0].item.no === '100-820');
ok('2.2 customer found by sender address, order number from the subject', A['M-1041'].customer.no === 'K-10001' && A['M-1041'].po.value === '4500012345');
ok('2.3 "KW 46" becomes 9 Nov; order is ready with no issues', A['M-1041'].deliveryDate.value === '2026-11-09' && A['M-1041'].status === 'ready' && A['M-1041'].issues.length === 0);
ok('2.4 agreed price with 5% customer discount, net 322,53 €', A['M-1041'].totals.net === 322.53, A['M-1041'].totals);
ok('2.5 PDF table read; customer found by "Kunden-Nr. bei Ihnen"', A['M-1042'].readBy === 'table' && A['M-1042'].header.customer.how === 'customer number');
ok('2.6 Excel: header row found below the title rows; 2 Karton gloves = 24 pairs', A['M-1043'].lines.length === 4 && A['M-1043'].lines[3].qtyBase === 24);
ok("2.7 customer's own article numbers mapped (MM-SR820 -> 100-820)", A['M-1047'].lines[0].item.no === '100-820' && /own number/.test(A['M-1047'].lines[0].how));
ok('2.8 EAN codes and "Kisten" read for the drinks wholesaler', B['H-201'].lines[0].item.no === 'G-1001' && B['H-201'].lines[0].qtyBase === 240);

console.log('3. Checks');
ok('3.1 Christmas Day delivery is flagged with the holiday name', codes(A['M-1042']).includes('HOLIDAY') && /Weihnachtstag/.test(A['M-1042'].issues.find((x) => x.code === 'HOLIDAY').msg));
ok('3.2 price 3,10 € vs agreed 3,40 € flagged (-8,8%)', A['M-1042'].lines[2].priceDev === -8.8 && codes(A['M-1042']).includes('PRICE'));
ok('3.3 stated total matches its own lines: no TOTAL warning', !codes(A['M-1042']).includes('TOTAL'));
ok('3.4 discontinued item blocks, successor offered', A['M-1043'].status === 'blocked' && A['M-1043'].issues.find((x) => x.code === 'DISCONTINUED').fixes[0].setLine.itemNo === '720-310');
ok('3.5 minimum order quantity flagged (6 of 12)', codes(A['M-1043']).includes('MOQ'));
ok('3.6 typo 100-280 suggests 100-820 first ("two characters swapped")', A['M-1044'].issues.find((x) => x.code === 'UNKNOWN_ITEM').fixes[0].setLine.itemNo === '100-820');
ok('3.7 lines without article numbers matched by description (M8 nut, 6,0 drill)', A['M-1044'].lines[1].item.no === '200-008' && A['M-1044'].lines[2].item.no === '520-006');
ok('3.8 forwarded copy is a duplicate of the first email', A['M-1045'].duplicateOf === 'M-1041' && A['M-1045'].status === 'blocked');
ok('3.9 unknown sender and unknown VAT ID: customer not found', codes(A['M-1046']).includes('NO_CUSTOMER') && /DE298765431/.test(A['M-1046'].issues[0].msg));
ok('3.10 Saturday delivery flagged; past delivery date blocks', codes(A['M-1046']).includes('WEEKEND') && codes(B['H-203']).includes('PAST_DATE') && B['H-203'].status === 'blocked');
ok('3.11 missing order number is a warning, not a block', codes(B['H-203']).includes('NO_PO'));

console.log('4. Fixes from the review screen');
const t1 = fresh();
const fixed = byId(E.processInbox(t1.tenants[0], D.today, { 'M-1044': { lines: { 0: { itemNo: '100-820' }, 1: { itemNo: '200-008' }, 2: { itemNo: '520-006' } } } }));
ok('4.1 choosing the suggestion clears the block', fixed['M-1044'].status === 'ready', codes(fixed['M-1044']));
const fixed2 = byId(E.processInbox(fresh().tenants[0], D.today, { 'M-1043': { deliveryDate: '2026-11-05', lines: { 1: { itemNo: '720-310' }, 2: { roundUp: true } } } }));
ok('4.2 successor + round up + date: Holtkamp order becomes ready, 12 cartridges', fixed2['M-1043'].status === 'ready' && fixed2['M-1043'].lines[2].qtyBase === 12);
const fixed3 = byId(E.processInbox(fresh().tenants[0], D.today, { 'M-1042': { deliveryDate: '2026-12-28', lines: { 2: { price: 'ordered' } } } }));
ok('4.3 accepting the customer price uses 3,10 € and the net becomes 531,00 €', fixed3['M-1042'].lines[2].unitPrice === 3.1 && fixed3['M-1042'].totals.net === 531);
const notDup = byId(E.processInbox(fresh().tenants[0], D.today, { 'M-1045': { notDuplicate: true } }));
ok('4.4 "not a duplicate" releases the forwarded copy', notDup['M-1045'].status === 'ready');

console.log('5. Business Central');
const reqs = E.bcRequests(A['M-1041'], t0.tenants[0]);
ok('5.1 sign-in, duplicate lookup, header, then one request per line', reqs.length === 6 && reqs[0].url.indexOf('login.microsoftonline.com') > 0 && reqs[1].method === 'GET');
ok('5.2 lookup filters on externalDocumentNumber before creating', reqs[1].url.indexOf("externalDocumentNumber eq '4500012345'") > 0);
ok('5.3 header uses Business Central field names', reqs[2].body.customerNumber === 'K-10001' && reqs[2].body.externalDocumentNumber === '4500012345' && reqs[2].body.requestedDeliveryDate === '2026-11-09');
ok('5.4 lines: lineType Item, lineObjectNumber, quantity in base unit', reqs[3].body.lineType === 'Item' && reqs[3].body.lineObjectNumber === '100-820' && reqs[3].body.quantity === 2000 && reqs[3].body.unitOfMeasureCode === 'STK');
ok('5.5 no secret in any request', !JSON.stringify(reqs).match(/secret=[^<]/));

console.log('6. Clarification email');
const mail = E.clarification(A['M-1043'], t0.tenants[0]);
ok('6.1 German draft asks about the discontinued item, the minimum and the date', /ausgelaufen/.test(mail.body) && /Mindestabnahme/.test(mail.body) && /Liefertermin/.test(mail.body) && mail.subject === 'Rückfrage zu Ihrer Bestellung HT-2026-118');
ok('6.2 nothing to ask on a clean order', E.clarification(A['M-1041'], t0.tenants[0]) === null);

console.log('7. Onboarding import');
const csv = 'Art.-Nr.;Bezeichnung;ME;VK-Preis\n"A-1";"Schraube ""Spezial""";Stk;1,25\nA-2;Mutter;Stück;0,40\n;ohne Nummer;Stk;1,00\nA-1;doppelt;Stk;2,00\nA-3;Preis fehlt;Stk;abc';
const imp = E.importCatalog(csv);
ok('7.1 semicolon CSV with German headers and decimals is mapped', imp.delimiter === ';' && imp.items.length === 2 && imp.items[0].price === 1.25 && imp.items[0].desc === 'Schraube "Spezial"');
ok('7.2 bad rows are skipped with a reason', imp.skipped.length === 3 && imp.skipped.map((s) => s.reason).join('|').indexOf('twice') > 0);
const t2 = fresh(), newT = { id: 'new', name: 'Test GmbH', state: 'NW', vat: 0.19, settings: t2.tenants[0].settings, bc: t2.tenants[0].bc, items: imp.items, customers: [], history: [], docs: [] };
const o = E.process({ id: 'X', type: 'email', from: 'a@b.de', subject: 'Bestellung 1', body: ['3 Stk A-2 Mutter'] }, newT, { today: D.today });
ok('7.3 an imported list is used right away (A-2 found)', o.lines[0].item.no === 'A-2' && o.status === 'blocked' && codes(o).includes('NO_CUSTOMER'));
ok('7.4 companies are separate: Brandt articles are unknown at Hofmann', E.matchLine({ code: '100-820', desc: '' }, t0.tenants[1], null).item === null);

console.log('8. Costs and price');
const c = E.monthlyCost({ orders: 2000, pages: 2, companies: 5, model: 'haiku' }, D.costs);
ok('8.1 Haiku 5.5: 5,500 tokens in + 1,000 out = 0,105 cent per order, 2,10 $ for 2,000 orders', c.perOrder === 0.0011 && c.llm === 2.1 && c.hosting === 100, c);
ok('8.2 total = model + hosting + email + monitoring', c.total === c.llm + c.hosting + c.email + c.monitoring);
const p = E.pricing(D.pricing, 35);
ok('8.3 MVP 180 hours, full product 396 hours', p.mvp.hours === 180 && p.totalHours === 396);
ok('8.4 price follows the rate: 180 h x 35 $ = 6,300 $', p.mvp.amount === 6300 && E.pricing(D.pricing, 25).mvp.amount === 4500);

console.log('9. Bad input');
const odd = E.process({ id: 'Y', type: 'email', from: '', subject: '', body: ['Hallo, wie geht es?', 'KW 99', '12.13.2026'] }, fresh().tenants[0], { today: D.today });
ok('9.1 a message with no order is reported, not crashed on', odd.status === 'blocked' && codes(odd).includes('NO_LINES'));
const unitBad = E.process({ id: 'Z', type: 'email', from: 'x@meier-metallbau.de', subject: 'Bestellung 9', body: ['3 Pal 520-006 Bohrer'] }, fresh().tenants[0], { today: D.today });
ok('9.2 a unit the item is not sold in is refused with a reason', codes(unitBad).includes('UNIT'));


console.log('10. Added for onboarding and the calendar');
const H = (st) => E.holidays(2026, st);
ok('10.1 all 16 states: Reformationstag in NI not NW, Buß- und Bettag 18 Nov only in SN, Frauentag in BE', Object.keys(E.STATES).length === 16 && H('NI')['2026-10-31'] && !H('NW')['2026-10-31'] && H('SN')['2026-11-18'] === 'Buß- und Bettag' && !H('BY')['2026-11-18'] && H('BE')['2026-03-08']);
ok('10.2 calendar weeks: 9 Nov = KW 46, 31 Dec 2026 = KW 53, 4 Jan 2027 = KW 1', E.isoWeek('2026-11-09').week === 46 && E.isoWeek('2026-12-31').week === 53 && E.isoWeek('2027-01-04').week === 1 && E.isoWeek('2027-01-04').year === 2027);
ok('10.3 "KW 53/2027" is refused (2027 has 52 weeks); "KW 53/2026" is 28 Dec', E.parseDate('KW 53/2027', D.today) === null && E.parseDate('KW 53/2026', D.today) === '2026-12-28');
const h203 = byId(E.processInbox(fresh().tenants[1], D.today, { 'H-203': { deliveryDate: '2026-11-05' } }))['H-203'];
const r203 = E.bcRequests(h203, fresh().tenants[1]);
ok('10.4 no customer order number: intake id OD-H-203 is the external document number and the lookup key', E.externalDocNo(h203) === 'OD-H-203' && r203[1].url.indexOf("eq 'OD-H-203'") > 0 && r203[2].body.externalDocumentNumber === 'OD-H-203');
const csv2 = 'Art.-Nr.;Bezeichnung;ME;VK-Preis;EK-Preis\nB-1;Kabel NYM 3x1,5;m;0,89;0,52\nB-2;Sicherung B16;Stk;2,40;1,10';
const auto = E.importCatalog(csv2), chosen = E.importCatalog(csv2, { itemNo: 0, desc: 1, unit: 2, price: 4 });
ok('10.5 column choice on screen overrides the automatic one (VK-Preis -> EK-Preis)', auto.items[0].price === 0.89 && chosen.items[0].price === 0.52 && chosen.headers.length === 5 && auto.map.price === 3);
const ccsv = 'Kunden-Nr.;Firma;E-Mail;USt-IdNr.;Rabatt %;Ort\nD-1;Elektro Krause GmbH;einkauf@krause-elektro.de;DE 811 234 567;3;Hannover\nD-2;Bau Nord KG;baunord.de;DE12;x;Celle\n;Ohne Nummer;a@b.de;;;\nD-1;Doppelt;c@d.de;;;\nD-3;;e@f.de;;;';
const ci = E.importCustomers(ccsv);
ok('10.6 customer list: e-mail becomes the matching domain, VAT ID cleaned, discount read', ci.customers.length === 2 && ci.customers[0].domains[0] === 'krause-elektro.de' && ci.customers[0].vat === 'DE811234567' && ci.customers[0].discount === 3);
ok('10.7 customer list: bad VAT ID and discount dropped with warnings, 3 bad rows skipped with reasons', ci.customers[1].vat === null && ci.customers[1].discount === 0 && ci.warnings.length === 2 && ci.skipped.length === 3 && /no name/.test(ci.skipped[2].reason));
const bad = E.newTenant({ name: 'K', state: 'XX', priceTolerancePct: 70, autoApprovePct: 95, duplicateWindowDays: 14, bcTenantId: 'not-a-guid' }, [], []);
ok('10.8 add-company form refuses bad input with one reason each', bad.tenant === null && bad.errors.length === 5 && bad.errors.some((e) => /GUID/.test(e)) && bad.errors.some((e) => /federal state/.test(e)));
const good = E.newTenant({ name: 'Krause Elektrogroßhandel GmbH', city: 'Hannover', state: 'NI', priceTolerancePct: 3, autoApprovePct: 90, duplicateWindowDays: 10, bcTenantId: '', bcCompanyId: '' }, auto.items, ci.customers);
ok('10.9 valid form creates the company (Lower Saxony calendar, own inbox, BC not yet connected warning)', good.tenant && good.tenant.id === 'krause-elektrogrosshandel' && good.tenant.settings.autoApproveMin === 0.9 && good.warnings.length === 1 && good.tenant.inbox.indexOf('krause-elektrogrosshandel') > 0);
const kOrder = E.process({ id: 'P-1', type: 'email', from: 'Einkauf <einkauf@krause-elektro.de>', subject: 'Bestellung 7781', body: ['100 m B-1 Kabel', '20 Stk B-2', 'Liefertermin: 31.10.2026'] }, good.tenant, { today: '2026-10-26' });
ok('10.10 the new company works at once: customer by e-mail, metres read, its prices less 3%, and its own holiday (Reformationstag 31 Oct in NI)', kOrder.customer && kOrder.customer.no === 'D-1' && kOrder.lines[0].unitOrdered === 'M' && kOrder.lines[1].unitPrice === 2.328 && kOrder.issues.some((x) => x.code === 'HOLIDAY' && /Reformationstag/.test(x.msg)));
const badCost = E.monthlyCost({ orders: 0, pages: 2.5, companies: 5, model: 'haiku' }, D.costs);
ok('10.11 cost calculator refuses 0 orders and 2.5 pages with reasons', badCost.errors.length === 2 && /Orders per month/.test(badCost.errors[0]) && badCost.total === undefined);
ok('10.12 cost per company: 5 companies share 127,10 $ = 25,42 $ each', c.perCompany === 25.42 && c.total === 127.1, c);


console.log('11. The examples the page offers');
const X = D.examples;
const xp = E.importCatalog(X.products), xc = E.importCustomers(X.customers);
ok('11.1 example product list: 9 products, 2 rows skipped (no number; price "auf Anfrage")', xp.items.length === 9 && xp.skipped.length === 2 && xp.skipped[0].row === 11 && /auf Anfrage/.test(xp.skipped[1].reason));
ok('11.2 example customer list: 4 customers, 2 warnings (VAT ID, discount), 1 row skipped (no name)', xc.customers.length === 4 && xc.warnings.length === 2 && xc.skipped.length === 1);
const xt = E.newTenant(X.company, xp.items, xc.customers);
ok('11.3 example company is valid and connected to Business Central', xt.errors.length === 0 && xt.tenant.bc.tenantId && xt.warnings.length === 0, xt.errors.concat(xt.warnings));
const toDoc = (o, id) => ({ id: id, type: 'email', from: o.from, subject: o.subject, received: D.today + ' 10:30', body: o.body.split('\n') });
const xb = E.process(toDoc(X.orders.brandt, 'P-1'), fresh().tenants[0], { today: D.today });
ok('11.4 Brandt example: Kruse found, 4 lines, blocked because pallets are not a unit of 410-650', xb.customer.no === 'K-10005' && xb.lines.length === 4 && xb.status === 'blocked' && codes(xb).join() === 'UNIT' && xb.lines[0].qtyBase === 400);
const xh = E.process(toDoc(X.orders.hofmann, 'P-2'), fresh().tenants[1], { today: D.today });
ok('11.5 Hofmann example: Friday 13 Nov read, crates to bottles, cheese matched by description for review', xh.deliveryDate.value === '2026-11-13' && xh.lines[0].qtyBase === 240 && xh.status === 'review' && codes(xh).join() === 'DESC_MATCH');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
