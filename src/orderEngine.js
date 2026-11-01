/*
 * orderEngine.js: reads incoming B2B orders (email text, PDF, Excel), checks them against the company's
 * own product and customer lists, and builds the Business Central requests. The page and the tests load
 * this same file.
 *
 * In the demo the reader is rule-based (German order formats) so it runs without any key. In the
 * delivered product an LLM fills the same fields through a strict JSON schema; everything after reading
 * (matching, checks, duplicates, Business Central) is this code.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrderEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- numbers, money, dates ----------

  // German and English number formats: "2.000" -> 2000, "0,19" -> 0.19, "1.250,00" -> 1250, "1,250.00" -> 1250
  function parseNum(s) {
    if (s === null || s === undefined) return null;
    var t = String(s).trim().replace(/\s|€|EUR/gi, '');
    if (!t) return null;
    if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) return parseFloat(t.replace(/\./g, '').replace(',', '.'));
    if (/^\d+,\d+$/.test(t)) return parseFloat(t.replace(',', '.'));
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return parseFloat(t.replace(/,/g, ''));
    if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
    return null;
  }

  // Commercial rounding without float noise: 5 x 3.705 = 18.525 rounds to 18.53, not 18.52.
  function round(x, d) {
    d = d === undefined ? 2 : d;
    var y = parseFloat(x.toFixed(9));
    if (Math.abs(y) < 1e-6) return 0;
    var s = y < 0 ? -1 : 1;
    return s * Number(Math.round(Number(Math.abs(y) + 'e' + d)) + 'e-' + d);
  }

  function fmtNum(x, dec) {
    var neg = x < 0, v = Math.abs(x).toFixed(dec);
    var parts = v.split('.'), int = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (neg ? '-' : '') + int + (dec ? ',' + parts[1] : '');
  }
  function fmtMoney(x) { return fmtNum(x, 2) + ' €'; }
  function fmtQty(x) { return Math.round(x) === x ? fmtNum(x, 0) : fmtNum(x, 2); }

  function iso(d) { return d.toISOString().slice(0, 10); }
  function toDate(isoStr) { var p = isoStr.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
  function addDays(isoStr, n) { return iso(new Date(toDate(isoStr).getTime() + n * 864e5)); }
  function daysBetween(a, b) { return Math.round((toDate(b) - toDate(a)) / 864e5); }
  function fmtDate(isoStr) { var p = isoStr.split('-'); return p[2] + '.' + p[1] + '.' + p[0]; }
  var WD = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  var WD_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function weekday(isoStr) { return WD[toDate(isoStr).getUTCDay()]; }
  function weekdayEn(isoStr) { return WD_EN[toDate(isoStr).getUTCDay()]; }

  // Monday of ISO calendar week ("KW 46")
  function isoWeekMonday(week, year) {
    var jan4 = new Date(Date.UTC(year, 0, 4)), dow = (jan4.getUTCDay() + 6) % 7;
    return iso(new Date(Date.UTC(year, 0, 4 - dow) + (week - 1) * 7 * 864e5));
  }

  // ISO calendar week of a date: 2026-11-09 -> { week: 46, year: 2026 }
  function isoWeek(isoStr) {
    var d = toDate(isoStr), thu = new Date(d.getTime() + (3 - (d.getUTCDay() + 6) % 7) * 864e5), y = thu.getUTCFullYear();
    var jan4 = new Date(Date.UTC(y, 0, 4)), firstThu = new Date(jan4.getTime() + (3 - (jan4.getUTCDay() + 6) % 7) * 864e5);
    return { week: 1 + Math.round((thu - firstThu) / (7 * 864e5)), year: y };
  }

  // "03.11.2026", "3.11.26", "06.11." (year from today), "2026-11-03", "KW 46", "KW 46/2026"
  function parseDate(s, today) {
    if (!s) return null;
    var t = String(s).trim(), m, year = +today.slice(0, 4);
    if ((m = /^KW\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?$/i.exec(t))) {
      var y = m[2] ? (+m[2] < 100 ? 2000 + +m[2] : +m[2]) : year;
      if (!m[2] && isoWeekMonday(+m[1], y) < addDays(today, -60)) y++;
      var mon = isoWeekMonday(+m[1], y);
      return +m[1] >= 1 && +m[1] <= 53 && isoWeek(mon).week === +m[1] ? mon : null;
    }
    if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t))) return valid(+m[1], +m[2], +m[3]);
    if ((m = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})?$/.exec(t))) {
      var yy = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : year;
      return valid(yy, +m[2], +m[1]);
    }
    return null;
    function valid(y2, mo, d) {
      var dt = new Date(Date.UTC(y2, mo - 1, d));
      return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? iso(dt) : null;
    }
  }

  // Easter Sunday (anonymous Gregorian algorithm) and German public holidays for all 16 states (rules from 2023 on)
  function easter(y) {
    var a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25),
      g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4,
      l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
      month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
    return iso(new Date(Date.UTC(y, month - 1, day)));
  }
  var STATES = { BW: 'Baden-Württemberg', BY: 'Bayern', BE: 'Berlin', BB: 'Brandenburg', HB: 'Bremen', HH: 'Hamburg', HE: 'Hessen',
    MV: 'Mecklenburg-Vorpommern', NI: 'Niedersachsen', NW: 'Nordrhein-Westfalen', RP: 'Rheinland-Pfalz', SL: 'Saarland',
    SN: 'Sachsen', ST: 'Sachsen-Anhalt', SH: 'Schleswig-Holstein', TH: 'Thüringen' };
  // Buß- und Bettag: the Wednesday before 23 November
  function bussUndBettag(y) { var d = new Date(Date.UTC(y, 10, 22)); while (d.getUTCDay() !== 3) d = new Date(d.getTime() - 864e5); return iso(d); }
  // Statewide days only. Local ones (Mariä Himmelfahrt outside Catholic towns in BY, Fronleichnam in parts of SN and TH,
  // Augsburg's Friedensfest) are a per-company setting in the product.
  function holidays(year, state) {
    var e = easter(year), h = {};
    function add(d, name, states) { if (!states || states.indexOf(state) >= 0) h[d] = name; }
    add(year + '-01-01', 'Neujahr');
    add(year + '-01-06', 'Heilige Drei Könige', ['BW', 'BY', 'ST']);
    add(year + '-03-08', 'Internationaler Frauentag', ['BE', 'MV']);
    add(addDays(e, -2), 'Karfreitag');
    add(addDays(e, 1), 'Ostermontag');
    add(year + '-05-01', 'Tag der Arbeit');
    add(addDays(e, 39), 'Christi Himmelfahrt');
    add(addDays(e, 50), 'Pfingstmontag');
    add(addDays(e, 60), 'Fronleichnam', ['BW', 'BY', 'HE', 'NW', 'RP', 'SL']);
    add(year + '-08-15', 'Mariä Himmelfahrt', ['BY', 'SL']);
    add(year + '-09-20', 'Weltkindertag', ['TH']);
    add(year + '-10-03', 'Tag der Deutschen Einheit');
    add(year + '-10-31', 'Reformationstag', ['BB', 'HB', 'HH', 'MV', 'NI', 'SN', 'ST', 'SH', 'TH']);
    add(year + '-11-01', 'Allerheiligen', ['BW', 'BY', 'NW', 'RP', 'SL']);
    add(bussUndBettag(year), 'Buß- und Bettag', ['SN']);
    add(year + '-12-25', '1. Weihnachtstag');
    add(year + '-12-26', '2. Weihnachtstag');
    return h;
  }
  function dayInfo(isoStr, state) {
    var dow = toDate(isoStr).getUTCDay();
    return { weekend: dow === 0 || dow === 6, holiday: holidays(+isoStr.slice(0, 4), state)[isoStr] || null };
  }

  // ---------- text helpers ----------

  var UNIT_WORDS = {
    STK: ['stk', 'stk.', 'st', 'st.', 'stück', 'stueck', 'pcs', 'pc', 'piece', 'pieces'],
    KAR: ['kar', 'karton', 'kartons', 'ktn', 'ctn', 'carton', 'cartons'],
    VE: ['ve', 'verpackungseinheit'],
    PAAR: ['paar', 'pr', 'pair', 'pairs'],
    KI: ['ki', 'kiste', 'kisten', 'kasten', 'kästen', 'crate', 'crates'],
    FL: ['fl', 'fl.', 'flasche', 'flaschen', 'bottle', 'bottles'],
    KG: ['kg', 'kilo', 'kilogramm'],
    PAL: ['pal', 'pal.', 'palette', 'paletten'],
    M: ['m', 'meter', 'mtr', 'mtr.', 'lfm'],
    L: ['liter', 'ltr', 'ltr.'],
    ROL: ['rol', 'rolle', 'rollen', 'rl'],
    PAK: ['pak', 'paket', 'pakete', 'pkt', 'pkt.', 'pack', 'packung']
  };
  // A bare "l" is left out on purpose: "0,75 l" belongs to a bottle's description, not to the quantity.
  var UNIT_RE = '(KAR|Kartons?|Ktn|VE|Stk\\.?|St\\.|Stück|Stueck|Paar|Kisten?|Kästen|Kasten|Fl\\.?|Flaschen?|kg|Pal\\.?|Paletten?|Meter|Mtr\\.?|lfm|m|Liter|Ltr\\.?|Rollen?|Pakete?|Pkt\\.?|Packung)';
  function normUnit(u) {
    if (!u) return null;
    var t = String(u).trim().toLowerCase();
    for (var k in UNIT_WORDS) if (UNIT_WORDS[k].indexOf(t) >= 0) return k;
    return null;
  }

  function tokens(s) {
    return String(s || '').toLowerCase().replace(/ß/g, 'ss').replace(/(\d),(\d)/g, '$1.$2')
      .split(/[^a-z0-9äöü.]+/).map(function (t) { return t.replace(/^\.+|\.+$/g, ''); })
      .filter(function (t) { return t && STOP.indexOf(t) < 0; });
  }
  var STOP = ['und', 'mit', 'für', 'fuer', 'der', 'die', 'das', 'stk', 'st', 'stück', 'kar', 'karton', 've', 'x', 'mm', 'din',
    'verzinkt', 'l', 'g', 'kg', 'glas', 'the', 'and'];
  function isSize(t) { return /^m\d+(x\d+)?$/.test(t) || /^\d+(\.\d+)?$/.test(t); }

  // Optimal string alignment distance (Levenshtein + adjacent swaps)
  function editDistance(a, b) {
    var d = [], i, j;
    for (i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (j = 0; j <= b.length; j++) d[0][j] = j;
    for (i = 1; i <= a.length; i++) {
      for (j = 1; j <= b.length; j++) {
        var cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
    return d[a.length][b.length];
  }

  function isCodeLike(t) {
    t = String(t || '').replace(/[,:;]+$/, '');
    if (!/\d/.test(t) || /^m\d+(x\d+)?$/i.test(t) || /^\d{1,2}\.\d{1,2}\.(\d{2,4})?$/.test(t) || /^\d+([.,]\d+)?$/.test(t) && !/^\d{8,14}$/.test(t)) return false;
    return /^\d{8,14}$/.test(t) || /[-\/]/.test(t) || (t.length >= 5 && /[a-z]/i.test(t));
  }

  // ---------- reading a document ----------

  // Every piece of text the reader looks at, with a pointer back into the document for highlighting.
  function textLines(doc) {
    var out = [];
    out.push({ t: doc.subject || '', src: { part: 'subject' } });
    out.push({ t: doc.from || '', src: { part: 'from' } });
    (doc.body || []).forEach(function (t, i) { out.push({ t: t, src: { part: 'body', i: i } }); });
    if (doc.page) {
      (doc.page.lines || []).forEach(function (t, i) { out.push({ t: t, src: { part: 'page', i: i } }); });
      (doc.page.footer || []).forEach(function (t, i) { out.push({ t: t, src: { part: 'footer', i: i } }); });
    }
    if (doc.sheet) {
      doc.sheet.forEach(function (row, r) {
        row.forEach(function (cell, c) { if (cell) out.push({ t: String(cell), src: { part: 'cell', r: r, c: c } }); });
      });
    }
    return out;
  }

  function sub(src, line, piece) {
    var a = line.indexOf(piece);
    if (src.part === 'cell' || src.part === 'tcell' || a < 0) return src;
    return { part: src.part, i: src.i, a: a, b: a + piece.length };
  }

  function senderDomain(from) {
    var m = /@([a-z0-9.\-]+)/i.exec(from || '');
    return m ? m[1].toLowerCase() : null;
  }

  var PO_RE = /(?:Bestell(?:-|\s)?(?:Nr|nummer|nr)\.?|Bestellnummer|Bestellung(?:\s+Nr\.?)?|PO(?:\s*(?:Nr|number|No)\.?)?|Order\s*(?:No|Number)\.?)\s*[:#]?\s*([A-Z]{0,4}-?\d[\w\-\/]{2,})/i;
  var DATE_RE = /(?:^|\s)(?:Datum|Date)\s*:?\s*(\d{1,2}\.\d{1,2}\.\d{2,4})/i;
  var DELIVERY_RE = /(Liefertermin|Lieferdatum|Wunschtermin|Lieferung\s+(?:bis|am)|liefern(?:\s+Sie)?(?:\s+(?:bis|am))?|bis\s+(?:zum|spätestens)|Delivery(?:\s+date)?)\s*(?:am\s+|bis\s+)?(?:[A-Za-zäöü]+,\s*)?:?\s*(KW\s*\d{1,2}(?:\s*\/\s*\d{2,4})?|\d{1,2}\.\d{1,2}\.(?:\d{2,4})?)/i;
  var TOTAL_RE = /(?:Gesamtsumme|Summe|Gesamtbetrag|Total)\s*(?:netto)?\s*:?\s*(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})/i;
  var VAT_RE = /\bDE\s?\d{9}\b/;
  var CUSTNO_RE = /(?:Kunden-?Nr\.?|Kundennummer|Kd\.?-?Nr\.?|Customer\s*No\.?)(?:\s+bei\s+Ihnen)?\s*:?\s*([A-Z]-?\d{4,6}|\d{4,8})/i;

  function readHeader(doc, tenant, today) {
    var lines = textLines(doc), h = { customer: null, po: null, orderDate: null, deliveryDate: null, statedTotal: null };
    var byNo = {}, byVat = {}, byDomain = {};
    tenant.customers.forEach(function (c) {
      byNo[c.no] = c;
      if (c.vat) byVat[c.vat.replace(/\s/g, '')] = c;
      (c.domains || []).forEach(function (d) { byDomain[d] = c; });
    });
    var poBody = null, poSubject = null;
    lines.forEach(function (L) {
      var m;
      if (!h.customer && (m = CUSTNO_RE.exec(L.t)) && byNo[m[1]]) h.customer = { no: m[1], how: 'customer number', conf: 0.99, src: sub(L.src, L.t, m[1]) };
      if ((m = VAT_RE.exec(L.t))) {
        var vat = m[0].replace(/\s/g, '');
        if (!h.customer && byVat[vat]) h.customer = { no: byVat[vat].no, how: 'VAT ID', conf: 0.99, src: sub(L.src, L.t, m[0]) };
        else if (!byVat[vat]) h.unknownVat = { value: vat, src: sub(L.src, L.t, m[0]) };
      }
      if ((m = PO_RE.exec(L.t))) {
        var po = { value: m[1].replace(/[.,;:]+$/, ''), src: sub(L.src, L.t, m[1]) };
        if (L.src.part === 'subject') { if (!poSubject) poSubject = po; } else if (!poBody) poBody = po;
      }
      if (!h.orderDate && (m = DATE_RE.exec(L.t))) {
        var od = parseDate(m[1], today);
        if (od) h.orderDate = { value: od, src: sub(L.src, L.t, m[1]) };
      }
      if (!h.deliveryDate && (m = DELIVERY_RE.exec(L.t))) {
        var dd = parseDate(m[2], today);
        h.deliveryDate = dd ? { value: dd, raw: m[2], src: sub(L.src, L.t, m[2]) } : { value: null, raw: m[2], src: sub(L.src, L.t, m[2]) };
      }
      if (!h.statedTotal && (m = TOTAL_RE.exec(L.t))) h.statedTotal = { value: parseNum(m[1]), src: sub(L.src, L.t, m[1]) };
    });
    h.po = poBody || poSubject;
    if (!h.customer) {
      var dom = senderDomain(doc.from);
      if (dom && byDomain[dom]) h.customer = { no: byDomain[dom].no, how: 'sender address', conf: 0.97, src: { part: 'from' } };
    }
    if (!h.orderDate && doc.received) h.orderDate = { value: doc.received.slice(0, 10), src: { part: 'received' } };
    return h;
  }

  // ---------- order lines ----------

  var FIELD_SYN = {
    itemNo: ['artikelnummer', 'artikelnr', 'artnr', 'artikel', 'materialnummer', 'material', 'sku', 'itemno', 'item', 'ean', 'nummer'],
    desc: ['bezeichnung', 'beschreibung', 'artikelbezeichnung', 'artikel', 'text', 'description', 'name'],
    qty: ['menge', 'anzahl', 'stückzahl', 'stueckzahl', 'qty', 'quantity'],
    unit: ['me', 'einheit', 'mengeneinheit', 'unit', 'uom'],
    price: ['einzelpreis', 'preis', 'ep', 'stückpreis', 'nettopreis', 'vkpreis', 'verkaufspreis', 'listenpreis', 'vk', 'unitprice', 'price'],
    total: ['gesamt', 'gesamtpreis', 'summe', 'betrag', 'total']
  };
  function normHeader(h) { return String(h || '').toLowerCase().replace(/€|eur/g, '').replace(/[^a-z0-9äöüß]/g, ''); }

  // Map table headers to fields. Each field takes the best-scoring column that is still free.
  function mapColumns(headers, fields, synTable) {
    synTable = synTable || FIELD_SYN;
    fields = fields || ['itemNo', 'desc', 'qty', 'unit', 'price', 'total'];
    var taken = {}, map = {};
    fields.forEach(function (f) {
      var best = null;
      headers.forEach(function (h, c) {
        if (taken[c]) return;
        var n = normHeader(h), syn = synTable[f], score = 0;
        syn.forEach(function (s, idx) {
          if (n === s) score = Math.max(score, 200 - idx);
          else if (n && n.indexOf(s) === 0 && s.length >= 3) score = Math.max(score, 100 - idx);
        });
        if (score && (!best || score > best.score)) best = { c: c, score: score };
      });
      if (best) { map[f] = best.c; taken[best.c] = true; }
    });
    return map;
  }

  function tableLines(doc) {
    var rows = [], head, kind;
    if (doc.page && doc.page.table) {
      head = doc.page.table.head; kind = 'tcell';
      doc.page.table.rows.forEach(function (r, i) { rows.push({ cells: r, r: i }); });
    } else if (doc.sheet) {
      kind = 'cell';
      for (var r = 0; r < doc.sheet.length; r++) {
        var m = mapColumns(doc.sheet[r]);
        if ((m.itemNo !== undefined || m.desc !== undefined) && m.qty !== undefined) {
          head = doc.sheet[r];
          for (var k = r + 1; k < doc.sheet.length; k++) {
            if (doc.sheet[k].every(function (c) { return !String(c).trim(); })) break;
            rows.push({ cells: doc.sheet[k], r: k });
          }
          break;
        }
      }
    }
    if (!head) return null;
    var map = mapColumns(head), out = [];
    rows.forEach(function (row) {
      function cell(f) { return map[f] !== undefined ? String(row.cells[map[f]] || '').trim() : ''; }
      function src(f) { return map[f] !== undefined ? { part: kind, r: row.r, c: map[f] } : null; }
      var code = cell('itemNo');
      out.push({
        raw: row.cells.join(' | '), src: { part: kind, r: row.r, c: -1 },
        code: code && isCodeLike(code) ? code : null, codeSrc: src('itemNo'),
        desc: cell('desc') || (!isCodeLike(code) ? code : ''), descSrc: src('desc'),
        qty: parseNum(cell('qty')), qtySrc: src('qty'),
        unitRaw: cell('unit'), unit: normUnit(cell('unit')),
        price: parseNum(cell('price')), priceSrc: src('price'), total: parseNum(cell('total'))
      });
    });
    return out;
  }

  var NUM = '(\\d{1,3}(?:\\.\\d{3})+(?:,\\d+)?|\\d+(?:,\\d+)?)';
  var BUL = '^\\s*(?:[-•*]\\s*)?';
  var P_QTY_CODE = new RegExp(BUL + NUM + '\\s*(?:x\\s*)?' + UNIT_RE + '?\\.?\\s+(?:Art\\.?-?Nr\\.?\\s*)?(\\S+)\\s*(.*)$', 'i');
  var P_CODE_QTY = new RegExp(BUL + '(?:Art\\.?-?Nr\\.?\\s*)?(\\S+)\\s+(?:(.*?)\\s+)?(?:x\\s*)?' + NUM + '\\s*' + UNIT_RE + '?\\.?\\s*$', 'i');
  var P_QTY_DESC = new RegExp(BUL + NUM + '\\s*' + UNIT_RE + '\\.?\\s+(.{3,}?)\\s*$', 'i');
  var P_DESC_QTY = new RegExp(BUL + '(.{3,}?)\\s+' + NUM + '\\s*' + UNIT_RE + '\\.?\\s*$', 'i');
  var PRICE_RE = /(?:à|a|je|zu|@)\s*(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})\s*(?:€|EUR)?|(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})\s*(?:€|EUR)/i;

  function freeTextLines(doc) {
    var out = [];
    (doc.body || []).forEach(function (t, i) {
      var src = { part: 'body', i: i }, m, line = null, price = null, pm, work = t;
      if (/:\s*$/.test(t) || !/\d/.test(t)) return;
      if ((pm = PRICE_RE.exec(t))) { price = parseNum(pm[1] || pm[2]); work = t.replace(pm[0], ' '); }
      if ((m = P_QTY_CODE.exec(work)) && isCodeLike(m[3])) {
        line = { qty: parseNum(m[1]), unitRaw: m[2], code: m[3].replace(/[,:;]+$/, ''), desc: m[4] };
      } else if ((m = P_CODE_QTY.exec(work)) && isCodeLike(m[1])) {
        line = { code: m[1].replace(/[,:;]+$/, ''), desc: m[2] || '', qty: parseNum(m[3]), unitRaw: m[4] };
      } else if ((m = P_QTY_DESC.exec(work))) {
        line = { qty: parseNum(m[1]), unitRaw: m[2], code: null, desc: m[3] };
      } else if ((m = P_DESC_QTY.exec(work)) && !/(KW|Liefer|Bestell|Datum|Tel|Fax)/i.test(m[1])) {
        line = { desc: m[1], qty: parseNum(m[2]), unitRaw: m[3], code: null };
      }
      if (!line || line.qty === null) return;
      line.raw = t; line.src = src;
      line.unit = normUnit(line.unitRaw);
      line.desc = (line.desc || '').replace(/\s{2,}/g, ' ').trim();
      line.codeSrc = line.code ? sub(src, t, line.code) : null;
      line.descSrc = line.desc ? sub(src, t, line.desc) : null;
      line.qtySrc = src;
      line.price = price; line.priceSrc = price !== null ? sub(src, t, pm[1] || pm[2]) : null;
      out.push(line);
    });
    return out;
  }

  function extract(doc, tenant, today) {
    var lines = tableLines(doc);
    var how = 'table';
    if (!lines || !lines.length) { lines = freeTextLines(doc); how = 'text'; }
    return { header: readHeader(doc, tenant, today), lines: lines, how: how };
  }

  // ---------- matching against the product list ----------

  function catalogIndex(tenant) {
    if (tenant._idx) return tenant._idx;
    var idx = { byNo: {}, byEan: {}, items: tenant.items };
    tenant.items.forEach(function (it) {
      idx.byNo[it.no.toUpperCase()] = it;
      if (it.ean) idx.byEan[it.ean] = it;
      it._tok = tokens(it.desc);
    });
    Object.defineProperty(tenant, '_idx', { value: idx, enumerable: false, configurable: true, writable: true });
    return idx;
  }

  function descScore(lineDesc, item) {
    var lt = tokens(lineDesc);
    if (!lt.length) return 0;
    var hit = 0, conflicts = 0;
    lt.forEach(function (t) {
      if (item._tok.indexOf(t) >= 0) { hit++; return; }
      if (isSize(t)) {
        var sizes = item._tok.filter(isSize);
        if (sizes.some(function (s) { return s.indexOf(t + 'x') === 0; })) hit += 0.5;
        else if (sizes.length && /^m\d/.test(t) && sizes.some(function (s) { return /^m\d/.test(s); })) conflicts++;
        else if (sizes.length && /^\d/.test(t) && sizes.some(function (s) { return /^\d+\.\d+$/.test(s) && /\./.test(t); })) conflicts++;
        return;
      }
      if (t.length >= 4 && item._tok.some(function (s) { return s.indexOf(t) >= 0 || (s.length >= 4 && t.indexOf(s) >= 0); })) hit += 0.9;
    });
    return hit / lt.length - 0.6 * conflicts;
  }

  function matchLine(line, tenant, customer) {
    var idx = catalogIndex(tenant), code = line.code ? line.code.toUpperCase() : null, it;
    if (code) {
      if ((it = idx.byNo[code])) return { item: it, how: 'article number', conf: 0.99 };
      if (customer && customer.xref) {
        for (var k in customer.xref) if (k.toUpperCase() === code && idx.byNo[customer.xref[k].toUpperCase()]) {
          return { item: idx.byNo[customer.xref[k].toUpperCase()], how: "customer's own number " + k, conf: 0.98 };
        }
      }
      if ((it = idx.byEan[code])) return { item: it, how: 'EAN ' + code, conf: 0.99 };
      var cands = [];
      tenant.items.forEach(function (x) {
        var d = editDistance(code, x.no.toUpperCase());
        if (d <= 2) cands.push({ item: x, d: d, why: d === 1 && code.length === x.no.length && code.split('').sort().join('') === x.no.toUpperCase().split('').sort().join('') ? 'two characters swapped' : d + ' character' + (d > 1 ? 's' : '') + ' different' });
      });
      cands.sort(function (a, b) { return a.d - b.d || descScore(line.desc, b.item) - descScore(line.desc, a.item); });
      return { item: null, how: 'unknown article ' + line.code, conf: 0.3, suggestions: cands.slice(0, 3) };
    }
    var scored = tenant.items.map(function (x) { return { item: x, s: descScore(line.desc, x) }; })
      .filter(function (x) { return x.s > 0; }).sort(function (a, b) { return b.s - a.s; });
    if (scored.length && scored[0].s >= 0.6 && (scored.length === 1 || scored[0].s - scored[1].s >= 0.2)) {
      return { item: scored[0].item, how: 'description', conf: 0.75 };
    }
    return { item: null, how: 'no article number', conf: 0.3, suggestions: scored.slice(0, 3).map(function (x) { return { item: x.item, why: 'similar description' }; }) };
  }

  function agreedPrice(item, customer) {
    if (customer && customer.prices && customer.prices[item.no] !== undefined) return { price: customer.prices[item.no], basis: 'special price' };
    var disc = customer ? customer.discount || 0 : 0;
    return { price: round(item.price * (1 - disc / 100), 4), basis: disc ? 'list price less ' + disc + '%' : 'list price' };
  }

  // ---------- checking an order ----------

  function findCustomer(tenant, no) {
    for (var i = 0; i < tenant.customers.length; i++) if (tenant.customers[i].no === no) return tenant.customers[i];
    return null;
  }
  function findItem(tenant, no) { return catalogIndex(tenant).byNo[String(no).toUpperCase()] || null; }

  function linesKey(lines) {
    return lines.filter(function (l) { return l.item; }).map(function (l) { return l.item.no + ':' + l.qtyBase; }).sort().join('|');
  }

  /*
   * process(doc, tenant, ctx) -> order. ctx: { today, seen: [{docId, customer, po, key, date}], fix: overrides for this doc }
   * fix: { customer, deliveryDate, po, notDuplicate, lines: { i: { itemNo, price: 'agreed'|'ordered', roundUp } } }
   */
  function process(doc, tenant, ctx) {
    ctx = ctx || {};
    var today = ctx.today, fix = ctx.fix || {}, lf = fix.lines || {};
    var ex = extract(doc, tenant, today), h = ex.header, issues = [];
    function issue(sev, code, msg, extra) { var x = { sev: sev, code: code, msg: msg }; for (var k in extra || {}) x[k] = extra[k]; issues.push(x); return x; }

    var customer = null;
    if (fix.customer) { customer = findCustomer(tenant, fix.customer); h.customer = { no: fix.customer, how: 'chosen by you', conf: 1, src: null }; }
    else if (h.customer) customer = findCustomer(tenant, h.customer.no);
    if (!customer) {
      issue('error', 'NO_CUSTOMER', 'Customer not found: ' + (senderDomain(doc.from) || 'unknown sender') + (h.unknownVat ? ' (VAT ID ' + h.unknownVat.value + ' is not in your customer list)' : '') + '.',
        { fixes: tenant.customers.map(function (c) { return { label: c.name + ' (' + c.no + ')', set: { customer: c.no } }; }), header: 'customer' });
    }

    var po = fix.po ? { value: fix.po, src: null } : h.po;
    if (!po) issue('warning', 'NO_PO', 'No customer order number found; the sales order will have no external document number.', { header: 'po' });

    var dd = fix.deliveryDate ? { value: fix.deliveryDate, src: null } : h.deliveryDate;
    if (!dd || !dd.value) {
      issue('warning', 'NO_DATE', dd && dd.raw ? 'Delivery date "' + dd.raw + '" could not be read.' : 'No delivery date in the order.',
        { header: 'deliveryDate', fixes: [{ label: 'Use ' + fmtDate(addDays(today, 3)) + ' (standard 3 days)', set: { deliveryDate: addDays(today, 3) } }] });
    } else {
      var info = dayInfo(dd.value, tenant.state);
      if (dd.value < today) {
        issue('error', 'PAST_DATE', 'Delivery date ' + fmtDate(dd.value) + ' is in the past.', { header: 'deliveryDate', fixes: [{ label: 'Use ' + fmtDate(addDays(today, 3)), set: { deliveryDate: addDays(today, 3) } }] });
      } else if (info.holiday) {
        issue('warning', 'HOLIDAY', 'Delivery date ' + fmtDate(dd.value) + ' is a public holiday (' + info.holiday + ').', { header: 'deliveryDate', fixes: [{ label: 'Move to ' + fmtDate(nextWorkday(dd.value, tenant.state)), set: { deliveryDate: nextWorkday(dd.value, tenant.state) } }] });
      } else if (info.weekend) {
        issue('warning', 'WEEKEND', 'Delivery date ' + fmtDate(dd.value) + ' is a ' + weekdayEn(dd.value) + '.', { header: 'deliveryDate', fixes: [{ label: 'Move to ' + fmtDate(nextWorkday(dd.value, tenant.state)), set: { deliveryDate: nextWorkday(dd.value, tenant.state) } }] });
      }
    }

    var tol = tenant.settings.priceTolerancePct;
    var lines = ex.lines.map(function (raw, i) {
      var f = lf[i] || {}, L = { n: i + 1, raw: raw, issues: [] };
      function li(sev, code, msg, extra) { var x = issue(sev, code, 'Line ' + (i + 1) + ': ' + msg, extra); x.line = i; L.issues.push(x); return x; }
      var m = f.itemNo ? { item: findItem(tenant, f.itemNo), how: 'chosen by you', conf: 1 } : matchLine(raw, tenant, customer);
      L.item = m.item; L.how = m.how; L.conf = m.conf;
      L.qtyOrdered = raw.qty; L.unitOrdered = raw.unit || raw.unitRaw || null;
      if (!L.item) {
        li('error', 'UNKNOWN_ITEM', raw.code ? 'article ' + raw.code + ' is not in the product list.' : '"' + raw.desc + '" could not be matched to a product.',
          { fixes: (m.suggestions || []).map(function (s) { return { label: 'Use ' + s.item.no + ' ' + s.item.desc + ' (' + s.why + ')', setLine: { itemNo: s.item.no } }; }) });
      } else if (m.how === 'description') {
        li('warning', 'DESC_MATCH', 'no article number; matched "' + raw.desc + '" to ' + L.item.no + ' by description.', { fixes: [{ label: 'Confirm ' + L.item.no, setLine: { itemNo: L.item.no } }] });
      }
      if (L.item && L.item.discontinued) {
        var rep = L.item.replacement && findItem(tenant, L.item.replacement);
        li('error', 'DISCONTINUED', L.item.no + ' is discontinued' + (rep ? '; successor ' + rep.no + ' at ' + fmtMoney(agreedPrice(rep, customer).price) : '') + '.',
          { fixes: rep ? [{ label: 'Use successor ' + rep.no, setLine: { itemNo: rep.no } }] : [] });
      }
      if (raw.qty === null || raw.qty === undefined || !(raw.qty > 0)) { li('error', 'NO_QTY', 'no quantity.'); L.qtyBase = 0; }
      if (L.item && raw.qty > 0) {
        var unit = raw.unit, factor = null;
        if (!unit) { unit = L.item.unit; factor = 1; if (raw.unitRaw) li('error', 'UNIT', 'unit "' + raw.unitRaw + '" is unknown.'); else li('info', 'UNIT_ASSUMED', 'no unit given; read as ' + L.item.unit + '.'); }
        else if (unit === L.item.unit) factor = 1;
        else if (L.item.pack && L.item.pack[unit]) factor = L.item.pack[unit];
        else li('error', 'UNIT', unit + ' is not a sales unit of ' + L.item.no + ' (base unit ' + L.item.unit + ').');
        L.unitOrdered = unit; L.factor = factor || 1; L.qtyOrdered = raw.qty;
        L.qtyBase = round(raw.qty * L.factor, 4);
        if (L.item.moq && L.qtyBase < L.item.moq) {
          if (f.roundUp) L.qtyBase = L.item.moq;
          else li('warning', 'MOQ', L.item.no + ' has a minimum order of ' + L.item.moq + ' ' + L.item.unit + '; ordered ' + fmtQty(L.qtyBase) + '.', { fixes: [{ label: 'Round up to ' + L.item.moq, setLine: { roundUp: true } }] });
        }
        var ag = agreedPrice(L.item, customer);
        L.agreed = ag.price; L.priceBasis = ag.basis;
        L.ordered = raw.price !== null && raw.price !== undefined ? round(raw.price / L.factor, 4) : null;
        L.unitPrice = ag.price;
        if (L.ordered !== null) {
          var dev = round((L.ordered - ag.price) / ag.price * 100, 1);
          L.priceDev = dev;
          if (Math.abs(dev) > tol && f.price !== 'agreed' && f.price !== 'ordered') {
            li('warning', 'PRICE', 'customer wrote ' + fmtMoney(L.ordered) + ', agreed price is ' + fmtMoney(ag.price) + ' (' + (dev > 0 ? '+' : '') + fmtNum(dev, 1) + '%).',
              { fixes: [{ label: 'Keep agreed ' + fmtMoney(ag.price), setLine: { price: 'agreed' } }, { label: 'Accept ' + fmtMoney(L.ordered), setLine: { price: 'ordered' } }] });
          }
          if (f.price === 'ordered') L.unitPrice = L.ordered;
        }
        L.total = round(L.qtyBase * L.unitPrice, 2);
      }
      if (f.itemNo || f.price) L.conf = 1;
      return L;
    });

    if (!lines.length) issue('error', 'NO_LINES', 'No order lines found in this message.');

    var net = round(lines.reduce(function (s, l) { return s + (l.total || 0); }, 0), 2);
    if (h.statedTotal && h.statedTotal.value !== null) {
      var orderedNet = round(lines.reduce(function (s, l) { return s + (l.ordered !== null && l.ordered !== undefined ? l.qtyBase * l.ordered : l.total || 0); }, 0), 2);
      if (Math.abs(orderedNet - h.statedTotal.value) > 0.01) issue('warning', 'TOTAL', 'The order says ' + fmtMoney(h.statedTotal.value) + ' net; its own lines add up to ' + fmtMoney(orderedNet) + '.');
    }

    var key = linesKey(lines), dup = null;
    if (customer && !fix.notDuplicate) {
      (ctx.seen || []).concat((tenant.history || []).map(function (x) {
        return { docId: x.id, customer: x.customer, po: x.po, key: x.lines.map(function (l) { return l[0] + ':' + l[1]; }).sort().join('|'), date: x.date };
      })).forEach(function (s) {
        if (dup || s.docId === doc.id || s.customer !== customer.no) return;
        if (po && s.po && s.po === po.value) dup = { of: s.docId, why: 'same customer and order number ' + po.value };
        else if (key && s.key === key && Math.abs(daysBetween(s.date, today)) <= tenant.settings.duplicateWindowDays) dup = { of: s.docId, why: 'same customer and identical lines within ' + tenant.settings.duplicateWindowDays + ' days' };
      });
      if (dup) issue('error', 'DUPLICATE', 'Duplicate of ' + dup.of + ' (' + dup.why + ').', { header: 'po', fixes: [{ label: 'Not a duplicate, process it', set: { notDuplicate: true } }] });
    }

    var errors = issues.filter(function (x) { return x.sev === 'error'; }).length;
    var warnings = issues.filter(function (x) { return x.sev === 'warning'; }).length;
    var conf = Math.min(customer ? (h.customer ? h.customer.conf : 1) : 0.3, lines.length ? Math.min.apply(null, lines.map(function (l) { return l.conf; })) : 0.3);
    if (!po) conf -= 0.05;
    if (!dd || !dd.value) conf -= 0.05;
    conf = Math.max(0, round(conf, 2));
    var status = errors ? 'blocked' : warnings ? 'review' : 'ready';
    return {
      id: doc.id, doc: doc, tenantId: tenant.id, customer: customer, header: h, po: po, deliveryDate: dd, lines: lines, issues: issues,
      status: status, confidence: conf, autoApprove: status === 'ready' && conf >= tenant.settings.autoApproveMin,
      totals: { net: net, vat: round(net * tenant.vat, 2), gross: round(net * (1 + tenant.vat), 2) },
      key: key, duplicateOf: dup ? dup.of : null, readBy: ex.how
    };
  }

  function nextWorkday(isoStr, state) {
    var d = isoStr;
    do { d = addDays(d, 1); } while (dayInfo(d, state).weekend || dayInfo(d, state).holiday);
    return d;
  }

  // Process an inbox in arrival order, so a later copy of an order is caught as a duplicate of the earlier one.
  function processInbox(tenant, today, fixes, sent) {
    var seen = (sent || []).slice(), out = [];
    tenant.docs.forEach(function (doc) {
      var o = process(doc, tenant, { today: today, seen: seen, fix: (fixes || {})[doc.id] });
      out.push(o);
      if (o.customer && !o.duplicateOf) seen.push({ docId: doc.id, customer: o.customer.no, po: o.po ? o.po.value : null, key: o.key, date: today });
    });
    return out;
  }

  // ---------- Business Central ----------

  // The customer's order number becomes the external document number. Without one, the intake id is used, so the
  // "look first" request below still stops a second sales order. Business Central allows 35 characters.
  function externalDocNo(order) { return String(order.po && order.po.value ? order.po.value : 'OD-' + order.id).slice(0, 35); }

  function bcRequests(order, tenant) {
    var bc = tenant.bc, base = 'https://api.businesscentral.dynamics.com/v2.0/' + bc.tenantId + '/' + bc.environment + '/api/v2.0/companies(' + bc.companyId + ')';
    var c = order.customer, st = c.shipTo || {}, po = externalDocNo(order);
    var header = {
      customerNumber: c.no,
      externalDocumentNumber: po,
      orderDate: order.header.orderDate ? order.header.orderDate.value : null,
      requestedDeliveryDate: order.deliveryDate ? order.deliveryDate.value : null,
      shipToName: st.name, shipToAddressLine1: st.line1, shipToCity: st.city, shipToPostCode: st.postCode, shipToCountry: st.country
    };
    var reqs = [
      { step: 'Sign in (service-to-service, once per hour)', method: 'POST', url: 'https://login.microsoftonline.com/' + bc.tenantId + '/oauth2/v2.0/token',
        body: 'grant_type=client_credentials&client_id=<app id>&client_secret=<from the vault>&scope=https://api.businesscentral.dynamics.com/.default' },
      { step: 'Never twice: look for this order number first', method: 'GET', url: base + "/salesOrders?$filter=externalDocumentNumber eq '" + po.replace(/'/g, "''") + "'&$select=id,number" },
      { step: 'Create the sales order', method: 'POST', url: base + '/salesOrders', body: header }
    ];
    order.lines.forEach(function (l) {
      reqs.push({ step: 'Add line ' + l.n, method: 'POST', url: base + '/salesOrders({id from the step above})/salesOrderLines',
        body: { lineType: 'Item', lineObjectNumber: l.item.no, quantity: l.qtyBase, unitOfMeasureCode: l.item.unit, unitPrice: l.unitPrice, shipmentDate: header.requestedDeliveryDate } });
    });
    return reqs;
  }

  // ---------- clarification email (German) ----------

  function clarification(order, tenant) {
    var c = order.customer, asks = [];
    order.issues.forEach(function (x) {
      var l = x.line !== undefined ? order.lines[x.line] : null, pos = l ? 'Position ' + l.n + ': ' : '';
      if (x.code === 'UNKNOWN_ITEM') {
        var s = x.fixes && x.fixes[0] ? x.fixes[0].setLine.itemNo : null, it = s ? findItem(tenant, s) : null;
        asks.push(pos + (l.raw.code ? 'Die Artikelnummer ' + l.raw.code + ' ist uns nicht bekannt.' : 'Den Artikel "' + l.raw.desc + '" konnten wir nicht eindeutig zuordnen.') +
          (it ? ' Meinten Sie ' + it.no + ' (' + it.desc + ')?' : ' Bitte nennen Sie uns die Artikelnummer.'));
      } else if (x.code === 'DISCONTINUED') {
        var rep = l.item.replacement && findItem(tenant, l.item.replacement);
        asks.push(pos + 'Der Artikel ' + l.item.no + ' ist ausgelaufen.' + (rep ? ' Wir können den Nachfolger ' + rep.no + ' zum Preis von ' + fmtMoney(agreedPrice(rep, c).price) + ' liefern. Sind Sie einverstanden?' : ''));
      } else if (x.code === 'PRICE') {
        asks.push(pos + 'Sie nennen ' + fmtMoney(l.ordered) + ', vereinbart sind ' + fmtMoney(l.agreed) + ' je ' + l.item.unit + '. Bitte bestätigen Sie den Preis.');
      } else if (x.code === 'MOQ') {
        asks.push(pos + 'Die Mindestabnahme für ' + l.item.no + ' beträgt ' + l.item.moq + ' ' + l.item.unit + '. Dürfen wir auf ' + l.item.moq + ' erhöhen?');
      } else if (x.code === 'NO_DATE') {
        asks.push('Bitte nennen Sie uns Ihren gewünschten Liefertermin.');
      } else if (x.code === 'PAST_DATE' || x.code === 'HOLIDAY' || x.code === 'WEEKEND') {
        var nd = x.fixes && x.fixes[0] ? x.fixes[0].set.deliveryDate : null;
        asks.push('Der Liefertermin ' + fmtDate(order.deliveryDate.value) + (x.code === 'PAST_DATE' ? ' liegt in der Vergangenheit.' : x.code === 'HOLIDAY' ? ' ist ein Feiertag.' : ' fällt auf einen ' + weekday(order.deliveryDate.value) + '.') +
          (nd ? ' Passt Ihnen der ' + fmtDate(nd) + '?' : ''));
      } else if (x.code === 'UNIT') {
        asks.push(pos + 'Die Mengeneinheit ist uns unklar. Bitte geben Sie die Menge in ' + (l.item ? l.item.unit : 'Stück') + ' an.');
      }
    });
    if (!asks.length) return null;
    var name = c && c.contact ? (/^Frau/.test(c.contact) ? 'Sehr geehrte ' : 'Sehr geehrter ') + c.contact : 'Sehr geehrte Damen und Herren';
    var ref = order.po ? ' ' + order.po.value : '';
    return {
      subject: 'Rückfrage zu Ihrer Bestellung' + ref,
      body: [name + ',', '', 'vielen Dank für Ihre Bestellung' + ref + '. Bevor wir sie freigeben, bitten wir um eine kurze Bestätigung:', '']
        .concat(asks.map(function (a, i) { return (i + 1) + '. ' + a; }))
        .concat(['', 'Mit freundlichen Grüßen', tenant.user, tenant.name]).join('\n')
    };
  }

  // ---------- onboarding: product list import ----------

  function parseCSV(text) {
    var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').filter(function (l) { return l.trim(); });
    if (!lines.length) return { rows: [], delimiter: ';' };
    var first = lines[0], counts = { ';': (first.match(/;/g) || []).length, ',': (first.match(/,/g) || []).length, '\t': (first.match(/\t/g) || []).length };
    var delim = counts['\t'] >= counts[';'] && counts['\t'] >= counts[','] && counts['\t'] > 0 ? '\t' : counts[';'] >= counts[','] ? ';' : ',';
    var rows = lines.map(function (line) {
      var out = [], cur = '', q = false;
      for (var i = 0; i < line.length; i++) {
        var ch = line[i];
        if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
        else if (ch === '"') q = true;
        else if (ch === delim) { out.push(cur.trim()); cur = ''; }
        else cur += ch;
      }
      out.push(cur.trim());
      return out;
    });
    return { rows: rows, delimiter: delim };
  }

  // A mapping chosen on screen ({ field: column index, -1 = none }) overrides the automatic one.
  function chosenMap(mapping, fields, n) {
    var m = {};
    fields.forEach(function (f) { var c = mapping[f]; if (typeof c === 'number' && c >= 0 && c < n) m[f] = c; });
    return m;
  }

  function importCatalog(text, mapping) {
    var p = parseCSV(text), head = p.rows[0] || [], fields = ['itemNo', 'desc', 'unit', 'price'];
    var map = mapping ? chosenMap(mapping, fields, head.length) : mapColumns(head, fields);
    var items = [], skipped = [], seen = {};
    p.rows.slice(1).forEach(function (r, i) {
      var row = i + 2;
      function cell(f) { return map[f] !== undefined ? String(r[map[f]] || '').trim() : ''; }
      var no = cell('itemNo'), price = parseNum(cell('price')), unit = normUnit(cell('unit')) || (cell('unit') ? cell('unit').toUpperCase() : 'STK');
      if (!no) return skipped.push({ row: row, reason: 'no article number' });
      if (seen[no.toUpperCase()]) return skipped.push({ row: row, reason: 'article ' + no + ' appears twice' });
      if (price === null) return skipped.push({ row: row, reason: 'price "' + cell('price') + '" is not a number' });
      seen[no.toUpperCase()] = true;
      items.push({ no: no, desc: cell('desc') || no, unit: unit, pack: {}, price: price });
    });
    var named = {}; Object.keys(map).forEach(function (f) { named[f] = head[map[f]]; });
    return { items: items, skipped: skipped, mapping: named, map: map, headers: head, delimiter: p.delimiter, missing: ['itemNo', 'desc', 'price'].filter(function (f) { return map[f] === undefined; }) };
  }

  var CUST_SYN = {
    no: ['kundennummer', 'kundennr', 'kdnr', 'debitorennummer', 'debitornr', 'debitor', 'customerno', 'customernumber', 'nummer', 'nr'],
    name: ['name', 'firma', 'firmenname', 'kundenname', 'kunde', 'company', 'companyname'],
    email: ['email', 'emailadresse', 'bestelladresse', 'mail', 'domain', 'emaildomain'],
    vat: ['ustidnr', 'ustid', 'umsatzsteueridnr', 'umsatzsteuerid', 'vatid', 'vatno', 'vat'],
    discount: ['rabatt', 'rabattprozent', 'kundenrabatt', 'discount'],
    city: ['ort', 'stadt', 'city']
  };

  // Customer list: a row needs a number and a name; a bad e-mail, VAT ID or discount is dropped with a warning.
  function importCustomers(text, mapping) {
    var p = parseCSV(text), head = p.rows[0] || [], fields = ['no', 'name', 'email', 'vat', 'discount', 'city'];
    var map = mapping ? chosenMap(mapping, fields, head.length) : mapColumns(head, fields, CUST_SYN);
    var customers = [], skipped = [], warnings = [], seen = {};
    p.rows.slice(1).forEach(function (r, i) {
      var row = i + 2;
      function cell(f) { return map[f] !== undefined ? String(r[map[f]] || '').trim() : ''; }
      var no = cell('no'), name = cell('name');
      if (!no) return skipped.push({ row: row, reason: 'no customer number' });
      if (seen[no.toUpperCase()]) return skipped.push({ row: row, reason: 'customer ' + no + ' appears twice' });
      if (!name) return skipped.push({ row: row, reason: 'no name for ' + no });
      seen[no.toUpperCase()] = true;
      var mail = cell('email').toLowerCase(), dom = null;
      if (mail) {
        dom = mail.indexOf('@') >= 0 ? mail.split('@').pop() : mail;
        if (!/^[a-z0-9äöü-]+(\.[a-z0-9äöü-]+)+$/.test(dom)) { warnings.push({ row: row, reason: 'e-mail "' + cell('email') + '" ignored, not an address or domain' }); dom = null; }
      }
      var vat = cell('vat').replace(/\s/g, '').toUpperCase();
      if (vat && !/^DE\d{9}$/.test(vat) && !/^(AT|BE|CZ|DK|ES|FR|IT|LU|NL|PL)[0-9A-Z]{8,12}$/.test(vat)) { warnings.push({ row: row, reason: 'VAT ID "' + cell('vat') + '" ignored, wrong format' }); vat = ''; }
      var disc = cell('discount') ? parseNum(cell('discount').replace('%', '')) : 0;
      if (disc === null || disc < 0 || disc > 100) { warnings.push({ row: row, reason: 'discount "' + cell('discount') + '" ignored' }); disc = 0; }
      customers.push({ no: no, name: name, city: cell('city'), vat: vat || null, domains: dom ? [dom] : [], discount: disc, contact: null,
        shipTo: { name: name, line1: '', postCode: '', city: cell('city'), country: 'DE' } });
    });
    var named = {}; Object.keys(map).forEach(function (f) { named[f] = head[map[f]]; });
    return { customers: customers, skipped: skipped, warnings: warnings, mapping: named, map: map, headers: head, delimiter: p.delimiter,
      missing: ['no', 'name'].filter(function (f) { return map[f] === undefined; }) };
  }

  // ---------- onboarding: a new customer company ----------

  var GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function slugify(s) {
    return String(s || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .replace(/\b(gmbh|kg|ag|ohg|ug|e\.\s?k)\b\.?/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'firma';
  }

  // input: { name, city, state, user, priceTolerancePct, autoApprovePct, duplicateWindowDays, bcTenantId, bcEnvironment, bcCompanyId }
  function newTenant(input, items, customers) {
    var s = input || {}, errors = [], warnings = [], name = String(s.name || '').trim();
    var tol = Number(s.priceTolerancePct), auto = Number(s.autoApprovePct), win = Number(s.duplicateWindowDays);
    var bcT = String(s.bcTenantId || '').trim(), bcC = String(s.bcCompanyId || '').trim(), env = String(s.bcEnvironment || '').trim() || 'Production';
    if (name.length < 2) errors.push('Company name is missing.');
    if (!STATES[s.state]) errors.push('Choose the federal state; it decides which public holidays are checked.');
    if (!items || !items.length) errors.push('Import at least one product.');
    if (!(tol >= 0 && tol <= 50)) errors.push('Price tolerance must be between 0 and 50%.');
    if (!(auto >= 50 && auto <= 100)) errors.push('Auto-approve confidence must be between 50 and 100%.');
    if (!(win >= 1 && win <= 90 && Math.floor(win) === win)) errors.push('Duplicate window must be a whole number of days from 1 to 90.');
    if (bcT && !GUID_RE.test(bcT)) errors.push('Business Central tenant ID must be a GUID, like 7c1f4a2e-5b8d-4e1f-9a63-2d0b8e4c71a5.');
    if (bcC && !GUID_RE.test(bcC)) errors.push('Business Central company ID must be a GUID, like a3e9d1b4-0c27-4f6e-8d55-91b7c2e0f418.');
    if (!/^[A-Za-z0-9_-]{1,30}$/.test(env)) errors.push('Environment name: letters, digits, - and _ only (for example Production or Sandbox).');
    if (!bcT || !bcC) warnings.push('Business Central is not connected yet: orders are read and checked, but cannot be sent until the tenant and company ID are added.');
    if (!customers || !customers.length) warnings.push('No customers imported: every order will ask which customer it is.');
    if (errors.length) return { errors: errors, warnings: warnings, tenant: null };
    var slug = slugify(name);
    return { errors: [], warnings: warnings, tenant: {
      id: slug, name: name, city: String(s.city || '').trim(), state: s.state, inbox: 'orders+' + slug + '@your-saas.example',
      user: String(s.user || '').trim() || 'You', vat: 0.19,
      settings: { priceTolerancePct: tol, autoApproveMin: round(auto / 100, 2), duplicateWindowDays: win },
      bc: { tenantId: bcT || null, environment: env, companyId: bcC || null },
      items: items, customers: customers || [], history: [], docs: [] } };
  }

  // ---------- running costs and price ----------

  function monthlyCost(input, costs) {
    var errors = [];
    function whole(label, v, lo, hi) {
      if (typeof v !== 'number' || !isFinite(v) || Math.floor(v) !== v || v < lo || v > hi) errors.push(label + ' must be a whole number from ' + fmtNum(lo, 0) + ' to ' + fmtNum(hi, 0) + '.');
    }
    whole('Orders per month', input.orders, 1, 1000000);
    whole('Pages per order', input.pages, 1, 50);
    whole('Customer companies', input.companies, 1, 1000);
    if (!costs.models[input.model]) errors.push('Choose a model.');
    if (errors.length) return { errors: errors };
    var m = costs.models[input.model];
    var tokensIn = costs.tokensPerPage * input.pages + costs.baseTokens;
    var perOrder = (tokensIn * m.in + costs.outTokens * m.out) / 1e6;
    var llm = round(perOrder * input.orders, 2);
    var hosting = costs.hostingBase + costs.hostingPerCompany * input.companies;
    var total = round(llm + hosting + costs.email + costs.monitoring, 2);
    return { errors: [], perOrder: round(perOrder, 4), llm: llm, hosting: hosting, email: costs.email, monitoring: costs.monitoring,
      total: total, perCompany: round(total / input.companies, 2), model: m.name };
  }

  function pricing(p, rate) {
    rate = rate || p.rate;
    function block(list) {
      var ms = list.map(function (x) { return { name: x.name, hours: x.hours, amount: x.hours * rate, done: x.done }; });
      return { milestones: ms, hours: ms.reduce(function (s, x) { return s + x.hours; }, 0), amount: ms.reduce(function (s, x) { return s + x.amount; }, 0) };
    }
    var mvp = block(p.mvp), full = block(p.full);
    return { rate: rate, mvp: mvp, full: full, total: mvp.amount + full.amount, totalHours: mvp.hours + full.hours };
  }

  return {
    parseNum: parseNum, round: round, fmtMoney: fmtMoney, fmtNum: fmtNum, fmtQty: fmtQty, fmtDate: fmtDate, weekday: weekday,
    weekdayEn: weekdayEn, isoWeekMonday: isoWeekMonday, isoWeek: isoWeek, parseDate: parseDate, easter: easter, holidays: holidays, dayInfo: dayInfo,
    nextWorkday: nextWorkday, STATES: STATES,
    normUnit: normUnit, editDistance: editDistance, isCodeLike: isCodeLike, mapColumns: mapColumns,
    extract: extract, matchLine: matchLine, agreedPrice: agreedPrice, process: process, processInbox: processInbox,
    bcRequests: bcRequests, externalDocNo: externalDocNo, clarification: clarification, parseCSV: parseCSV, importCatalog: importCatalog,
    importCustomers: importCustomers, newTenant: newTenant, slugify: slugify,
    monthlyCost: monthlyCost, pricing: pricing, findItem: findItem, findCustomer: findCustomer, senderDomain: senderDomain
  };
});
