/**
 * Chef Nem API (Api.gs)
 *
 * The data connection for the Chef Nem Home Screen app (hosted on GitHub Pages).
 * Add this file to the Apps Script project attached to the Chef Nem sheet.
 *
 * It adds only:
 *   doPost      the app's data connection (passcode protected)
 *   cnSetup     run once from the editor: grants permissions, turns on reminders
 *   cnTick      runs every 15 minutes and sends notifications when due
 *   cnTestPush  optional: run from the editor to send a test notification
 *
 * It does not define doGet, so an existing app served by doGet keeps working.
 * Everything family-specific is read from the sheet's Settings tab.
 */

var CN_VERSION = '1.0.0';

function doPost(e) { return CN.handle(e); }

function cnSetup() { return CN.setup(); }

function cnTick() { CN.tick(); }

function cnTestPush() {
  var r = CN.sendTo('all', 'Chef Nem test', 'Notifications are working.', '#more');
  Logger.log(JSON.stringify(r));
  return r;
}

var CN = (function () {
  var TAB = {
    thisWeek: 'This Week',
    plan: 'Meal Plan',
    grocery: 'Grocery List',
    recipes: 'Recipes',
    favorites: 'Favorites',
    settings: 'Settings',
    devices: 'App Devices'
  };
  var FAV_HEADERS = ['ID', 'Week of', 'Meal', 'Name', 'Servings', 'Time', 'Ingredients', 'Steps', 'Kids note', 'Starred by', 'Starred at'];
  var DEVICE_HEADERS = ['Who', 'Token', 'Device', 'Updated'];
  var EDITABLE_FIELDS = { 'Delivery choice': true, 'New dish decision': true, 'Notes': true };
  var ALLERGEN_GROUPS = {
    shellfish: ['shellfish', 'shrimp', 'prawn', 'crab', 'lobster', 'crawfish', 'crayfish', 'langoustine',
      'scallop', 'clam', 'mussel', 'oyster', 'krill', 'cockle', 'whelk', 'abalone', 'conch', 'scampi'],
    peanut: ['peanut'],
    'tree nut': ['almond', 'walnut', 'pecan', 'cashew', 'pistachio', 'hazelnut', 'macadamia', 'brazil nut', 'pine nut'],
    fish: ['salmon', 'tuna', 'cod', 'tilapia', 'halibut', 'trout', 'anchov', 'sardine', 'mahi', 'fish'],
    egg: ['egg'],
    dairy: ['milk', 'cheese', 'butter', 'yogurt', 'cream'],
    gluten: ['wheat', 'flour', 'bread', 'pasta', 'barley', 'rye', 'couscous', 'farro']
  };
  // Phrases that contain an allergen word but are not that allergen.
  var ALLERGEN_EXCEPTIONS = ['oyster mushroom', 'crab apple', 'crabapple', 'almond milk', 'oat milk', 'coconut milk',
    'cream of tartar', 'peanut-free', 'nut-free', 'butternut', 'eggplant', 'buttermilk biscuit mix'];

  // ---------- basics ----------

  function ss() {
    var id = PropertiesService.getScriptProperties().getProperty('CN_SHEET_ID');
    return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  }
  function props() { return PropertiesService.getScriptProperties(); }
  function out(obj) {
    return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
  }
  function fail(msg) { var e = new Error(msg); e.cnUser = true; throw e; }
  function str(v) { return v === null || v === undefined ? '' : String(v).trim(); }
  function lc(v) { return str(v).toLowerCase(); }

  var _settings = null;
  function settings() {
    if (_settings) return _settings;
    var s = {};
    var sh = ss().getSheetByName(TAB.settings);
    if (sh && sh.getLastRow() > 1) {
      var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getDisplayValues();
      vals.forEach(function (r) { if (str(r[0])) s[lc(r[0])] = str(r[1]); });
    }
    _settings = s;
    return s;
  }
  function setting(name, dflt) { var v = settings()[lc(name)]; return v ? v : (dflt === undefined ? '' : dflt); }
  function list(name, dflt) {
    return setting(name, dflt || '').split(',').map(str).filter(function (x) { return x; });
  }
  function tz() { return setting('Time zone') || Session.getScriptTimeZone() || 'America/Denver'; }
  function fmt(d, pattern) { return Utilities.formatDate(d, tz(), pattern); }
  function nowIso() { return fmt(new Date(), "yyyy-MM-dd'T'HH:mm:ssXXX"); }

  function dateStr(v) {
    if (v instanceof Date) return fmt(v, 'yyyy-MM-dd');
    var s = str(v);
    var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return m[3] + '-' + pad(m[1]) + '-' + pad(m[2]);
    return s.slice(0, 10);
  }
  function pad(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
  // Date math on yyyy-MM-dd strings (timezone-safe: done at UTC noon).
  function addDays(ymd, n) {
    var p = ymd.split('-');
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 12));
    d.setUTCDate(d.getUTCDate() + n);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }
  function dayDiff(a, b) { // b - a in days
    var pa = a.split('-'), pb = b.split('-');
    return Math.round((Date.UTC(+pb[0], +pb[1] - 1, +pb[2]) - Date.UTC(+pa[0], +pa[1] - 1, +pa[2])) / 86400000);
  }
  function hhmm(v, dflt) {
    var m = str(v).match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (!m) return dflt;
    var h = +m[1];
    if (m[3]) { var ap = m[3].toLowerCase(); if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0; }
    return pad(h) + ':' + m[2];
  }
  function cellOut(v) {
    if (v instanceof Date) return fmt(v, "yyyy-MM-dd'T'HH:mm:ssXXX");
    return v;
  }

  // ---------- sheet tables ----------

  function table(name) {
    var sh = ss().getSheetByName(name);
    if (!sh || sh.getLastRow() < 1) return { sheet: sh, headers: [], idx: {}, rows: [] };
    var values = sh.getDataRange().getValues();
    var headers = values[0].map(str);
    var idx = {};
    headers.forEach(function (h, i) { if (h) idx[h.toLowerCase()] = i; });
    var rows = [];
    for (var r = 1; r < values.length; r++) {
      rows.push({ row: r + 1, v: values[r] });
    }
    return { sheet: sh, headers: headers, idx: idx, rows: rows };
  }
  function get(t, row, name) {
    var i = t.idx[name.toLowerCase()];
    return i === undefined ? '' : row.v[i];
  }
  function setCell(t, rowNum, name, value) {
    var i = t.idx[name.toLowerCase()];
    if (i === undefined) fail('The ' + t.sheet.getName() + ' tab has no "' + name + '" column.');
    t.sheet.getRange(rowNum, i + 1).setValue(value);
  }
  function ensureSheet(name, headers) {
    var book = ss();
    var sh = book.getSheetByName(name);
    if (!sh) {
      sh = book.insertSheet(name);
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
    } else if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    }
    return sh;
  }
  function appendByHeaders(t, obj) {
    var row = t.headers.map(function (h) {
      var k = Object.keys(obj).filter(function (key) { return key.toLowerCase() === h.toLowerCase(); })[0];
      return k ? obj[k] : '';
    });
    t.sheet.appendRow(row);
  }

  function readThisWeek() {
    var sh = ss().getSheetByName(TAB.thisWeek);
    if (!sh) fail('No "This Week" tab found.');
    var vals = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 2).getValues();
    var map = {}, rows = {};
    vals.forEach(function (r, i) {
      var k = str(r[0]);
      if (!k || k === 'Field') return;
      var v = r[1];
      if (/week of$/i.test(k)) v = dateStr(v);
      map[k] = cellOut(v);
      rows[k] = i + 1;
    });
    return { sheet: sh, map: map, rows: rows };
  }
  function writeThisWeek(tw, fields) {
    Object.keys(fields).forEach(function (k) {
      var r = tw.rows[k];
      if (!r) { tw.sheet.appendRow([k, fields[k]]); r = tw.sheet.getLastRow(); tw.rows[k] = r; }
      else tw.sheet.getRange(r, 2).setValue(fields[k]);
      tw.map[k] = fields[k];
    });
  }

  // ---------- reading the week ----------

  function lunchPeople(t) {
    return t.headers.filter(function (h) { return / lunch$/i.test(h); }).map(function (h) { return h.replace(/ lunch$/i, ''); });
  }
  function planRow(t, row, people) {
    var lunches = {};
    people.forEach(function (p) { lunches[p] = str(get(t, row, p + ' lunch')); });
    return {
      weekOf: dateStr(get(t, row, 'Week of')),
      date: dateStr(get(t, row, 'Date')),
      day: str(get(t, row, 'Day')),
      dinner: str(get(t, row, 'Dinner')),
      lunches: lunches,
      note: str(get(t, row, 'Note')),
      made: str(get(t, row, 'Made')),
      rating: str(get(t, row, 'Rating'))
    };
  }
  function groceryKey(store, kind, item) { return [str(store), str(kind), str(item)].join('|'); }
  function isChecked(v) { return v === true || lc(v) === 'true' || lc(v) === 'yes' || lc(v) === 'x'; }
  function lines(v) {
    return str(v).split(/\r?\n/).map(str).filter(function (x) { return x; });
  }
  function recipeRow(t, row) {
    return {
      id: str(get(t, row, 'ID')),
      weekOf: dateStr(get(t, row, 'Week of')),
      day: str(get(t, row, 'Day')),
      meal: str(get(t, row, 'Meal')),
      name: str(get(t, row, 'Name')),
      servings: str(get(t, row, 'Servings')),
      time: str(get(t, row, 'Time')),
      ingredients: lines(get(t, row, 'Ingredients')),
      steps: lines(get(t, row, 'Steps')),
      kidsNote: str(get(t, row, 'Kids note'))
    };
  }

  function allergenTerms() {
    var terms = [];
    list('Never include', 'shellfish').forEach(function (a) {
      var g = ALLERGEN_GROUPS[a.toLowerCase()];
      terms = terms.concat(g ? g : [a.toLowerCase()]);
    });
    return terms;
  }
  function allergyHits(texts) {
    var terms = allergenTerms();
    var hits = [];
    texts.forEach(function (t) {
      var s = ' ' + lc(t.text) + ' ';
      ALLERGEN_EXCEPTIONS.forEach(function (x) { s = s.split(x).join(' '); });
      terms.forEach(function (term) {
        var re = new RegExp('\\b' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(e?s)?\\b', 'i');
        if (re.test(s)) hits.push({ where: t.where, text: t.text, term: term });
      });
    });
    return hits;
  }

  function state() {
    var tw = readThisWeek();
    var weekOf = tw.map['Week of'] || '';
    var pt = table(TAB.plan), people = lunchPeople(pt);
    var plan = [], checkin = [];
    var ciStart = weekOf ? addDays(weekOf, -9) : '', ciEnd = weekOf ? addDays(weekOf, -3) : '';
    var seenCheckin = {};
    pt.rows.forEach(function (row) {
      var p = planRow(pt, row, people);
      if (!p.date) return;
      if (p.weekOf === weekOf) plan.push(p);
      if (weekOf && p.date >= ciStart && p.date <= ciEnd) seenCheckin[p.date] = p; // latest row per date wins
    });
    Object.keys(seenCheckin).sort().forEach(function (d) { if (seenCheckin[d].dinner) checkin.push(seenCheckin[d]); });
    plan.sort(function (a, b) { return a.date < b.date ? -1 : 1; });

    var gt = table(TAB.grocery), groceries = [];
    gt.rows.forEach(function (row) {
      if (dateStr(get(gt, row, 'Week of')) !== weekOf) return;
      var item = str(get(gt, row, 'Item'));
      if (!item) return;
      groceries.push({
        key: groceryKey(get(gt, row, 'Store'), get(gt, row, 'Kind'), item),
        store: str(get(gt, row, 'Store')),
        kind: str(get(gt, row, 'Kind')),
        item: item,
        qty: str(get(gt, row, 'Qty')),
        forWhat: str(get(gt, row, 'For')),
        cost: get(gt, row, 'Est cost'),
        change: str(get(gt, row, 'Change')),
        checked: isChecked(get(gt, row, 'Checked')),
        checkedBy: str(get(gt, row, 'Checked by'))
      });
    });

    var rt = table(TAB.recipes), recipes = [];
    rt.rows.forEach(function (row) {
      var r = recipeRow(rt, row);
      if (r.weekOf === weekOf && r.name) recipes.push(r);
    });

    var ft = table(TAB.favorites), favorites = [];
    ft.rows.forEach(function (row) {
      var name = str(get(ft, row, 'Name'));
      if (!name) return;
      favorites.push({
        id: str(get(ft, row, 'ID')) || str(get(ft, row, 'Recipe ID')),
        name: name,
        meal: str(get(ft, row, 'Meal')),
        ingredients: lines(get(ft, row, 'Ingredients')),
        steps: lines(get(ft, row, 'Steps')),
        kidsNote: str(get(ft, row, 'Kids note')),
        starredBy: str(get(ft, row, 'Starred by'))
      });
    });

    var texts = [];
    plan.forEach(function (p) {
      texts.push({ where: p.day + ' dinner', text: p.dinner });
      people.forEach(function (n) { texts.push({ where: p.day + ' ' + n + ' lunch', text: p.lunches[n] }); });
      texts.push({ where: p.day + ' note', text: p.note });
    });
    groceries.forEach(function (g) { if (g.change !== 'Remove') texts.push({ where: g.store + ' list', text: g.item }); });
    recipes.forEach(function (r) { texts.push({ where: r.name + ' recipe', text: r.name + '\n' + r.ingredients.join('\n') }); });
    texts.push({ where: 'New dish', text: str(tw.map['New dish']) + '\n' + str(tw.map['New dish details']) });

    return {
      ok: true,
      version: CN_VERSION,
      at: nowIso(),
      settings: {
        appName: setting('App name', 'Chef Nem'),
        familyName: setting('Family name'),
        people: list('People', people.join(',')),
        approvers: list('Approvers', setting('People', people.join(','))),
        budget: Number(setting('Food budget', tw.map['Budget'] || '250')) || 250,
        deliveryDays: list('Delivery days', 'Saturday,Sunday,Monday'),
        never: list('Never include', 'shellfish'),
        firebase: firebasePublic()
      },
      week: tw.map,
      people: people,
      plan: plan,
      checkin: checkin,
      groceries: groceries,
      recipes: recipes,
      favorites: favorites,
      allergy: allergyHits(texts)
    };
  }

  // ---------- writes ----------

  function withLock(fn) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(15000)) fail('Busy, try again in a moment.');
    try { return fn(); } finally { SpreadsheetApp.flush(); lock.releaseLock(); }
  }
  function requireWeek(tw, weekOf) {
    if (weekOf && tw.map['Week of'] !== weekOf) fail('This week\'s plan changed. Pull down to refresh.');
  }

  function approve(a) {
    return withLock(function () {
      var tw = readThisWeek();
      requireWeek(tw, a.weekOf);
      var status = str(tw.map['Status']);
      if (status === 'Approved' || status === 'Done') return { ok: true, already: true, week: tw.map };
      var s = state();
      if (s.allergy.length) fail('Blocked: this plan includes ' + s.allergy[0].term + ' (' + s.allergy[0].where + '). Fix the plan first.');
      writeThisWeek(tw, { 'Status': 'Approved', 'Approved by': str(a.who), 'Approved at': nowIso() });
      return { ok: true, week: tw.map };
    });
  }

  function setField(a) {
    var field = str(a.field), value = str(a.value);
    if (!EDITABLE_FIELDS[field]) fail('That field can\'t be changed from the app.');
    if (field === 'New dish decision' && ['', 'Yes', 'Later', 'No'].indexOf(value) < 0) fail('Pick Yes, Later or No.');
    if (value.length > 2000) fail('That note is too long.');
    return withLock(function () {
      var tw = readThisWeek();
      requireWeek(tw, a.weekOf);
      var o = {}; o[field] = value;
      writeThisWeek(tw, o);
      return { ok: true };
    });
  }

  function checkin(a) {
    var made = str(a.made), rating = str(a.rating), date = str(a.date);
    if (['', 'Made', 'Skipped'].indexOf(made) < 0) fail('Pick Made or Skipped.');
    if (['', 'Liked', 'Pass'].indexOf(rating) < 0) fail('Pick Liked or Pass.');
    return withLock(function () {
      var t = table(TAB.plan), hit = null;
      t.rows.forEach(function (row) { if (dateStr(get(t, row, 'Date')) === date) hit = row; });
      if (!hit) fail('Couldn\'t find that day in the Meal Plan tab.');
      setCell(t, hit.row, 'Made', made);
      setCell(t, hit.row, 'Rating', made === 'Made' ? rating : '');
      return { ok: true };
    });
  }

  function grocery(a) {
    return withLock(function () {
      var t = table(TAB.grocery), hit = null;
      t.rows.forEach(function (row) {
        if (dateStr(get(t, row, 'Week of')) === str(a.weekOf) &&
            groceryKey(get(t, row, 'Store'), get(t, row, 'Kind'), get(t, row, 'Item')) === str(a.key)) hit = row;
      });
      if (!hit) fail('That item isn\'t on the list anymore. Pull down to refresh.');
      setCell(t, hit.row, 'Checked', !!a.checked);
      setCell(t, hit.row, 'Checked by', a.checked ? str(a.who) : '');
      return { ok: true };
    });
  }

  function star(a) {
    return withLock(function () {
      ensureSheet(TAB.favorites, FAV_HEADERS);
      var ft = table(TAB.favorites);
      var hasId = ft.idx['id'] !== undefined;
      var matches = ft.rows.filter(function (row) {
        return hasId ? str(get(ft, row, 'ID')) === str(a.id) : lc(get(ft, row, 'Name')) === lc(a.name);
      });
      if (a.starred) {
        if (matches.length) return { ok: true };
        var rt = table(TAB.recipes), rec = null;
        rt.rows.forEach(function (row) { if (str(get(rt, row, 'ID')) === str(a.id)) rec = recipeRow(rt, row); });
        if (!rec) fail('Couldn\'t find that recipe.');
        appendByHeaders(ft, {
          'ID': rec.id, 'Recipe ID': rec.id, 'Week of': rec.weekOf, 'Meal': rec.meal, 'Name': rec.name,
          'Servings': rec.servings, 'Time': rec.time, 'Ingredients': rec.ingredients.join('\n'),
          'Steps': rec.steps.join('\n'), 'Kids note': rec.kidsNote, 'Starred by': str(a.who),
          'Starred at': nowIso(), 'Starred on': fmt(new Date(), 'yyyy-MM-dd'), 'Source week': rec.weekOf
        });
      } else {
        matches.map(function (r) { return r.row; }).sort(function (x, y) { return y - x; })
          .forEach(function (r) { ft.sheet.deleteRow(r); });
      }
      return { ok: true };
    });
  }

  // ---------- devices and push ----------

  function registerDevice(a) {
    var token = str(a.token);
    if (token.length < 20) fail('Bad notification token.');
    return withLock(function () {
      ensureSheet(TAB.devices, DEVICE_HEADERS);
      var t = table(TAB.devices), hit = null;
      t.rows.forEach(function (row) { if (str(get(t, row, 'Token')) === token) hit = row; });
      var vals = [str(a.who), token, str(a.device).slice(0, 120), nowIso()];
      if (hit) t.sheet.getRange(hit.row, 1, 1, 4).setValues([vals]);
      else t.sheet.appendRow(vals);
      return { ok: true };
    });
  }
  function unregisterDevice(a) {
    return withLock(function () { removeTokens([str(a.token)]); return { ok: true }; });
  }
  function removeTokens(tokens) {
    var t = table(TAB.devices);
    if (!t.sheet) return;
    t.rows.filter(function (row) { return tokens.indexOf(str(get(t, row, 'Token'))) >= 0; })
      .map(function (r) { return r.row; }).sort(function (x, y) { return y - x; })
      .forEach(function (r) { t.sheet.deleteRow(r); });
  }

  function parseLooseObject(text) {
    var o = {};
    var re = /["']?(\w+)["']?\s*:\s*["']([^"']*)["']/g, m;
    while ((m = re.exec(str(text)))) o[m[1]] = m[2];
    return o;
  }
  function firebasePublic() {
    var cfg = parseLooseObject(setting('Firebase web config'));
    var vapid = setting('Firebase VAPID key');
    if (!cfg.apiKey || !cfg.projectId || !cfg.messagingSenderId || !cfg.appId || !vapid) return null;
    return {
      config: { apiKey: cfg.apiKey, authDomain: cfg.authDomain || '', projectId: cfg.projectId,
        storageBucket: cfg.storageBucket || '', messagingSenderId: cfg.messagingSenderId, appId: cfg.appId },
      vapidKey: vapid
    };
  }
  function serviceAccount() {
    var raw = props().getProperty('CN_FCM_SERVICE_ACCOUNT');
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { fail('CN_FCM_SERVICE_ACCOUNT isn\'t valid JSON. Paste the whole key file.'); }
  }
  function b64url(s) { return Utilities.base64EncodeWebSafe(s).replace(/=+$/, ''); }
  function fcmAuth() {
    var sa = serviceAccount();
    if (!sa) fail('Notifications aren\'t set up yet: add the CN_FCM_SERVICE_ACCOUNT script property.');
    var cache = CacheService.getScriptCache();
    var cached = cache.get('cn_fcm_token');
    if (cached) return { token: cached, projectId: sa.project_id };
    var now = Math.floor(Date.now() / 1000);
    var head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    var claim = b64url(JSON.stringify({
      iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
    }));
    var sig = b64url(Utilities.computeRsaSha256Signature(head + '.' + claim, sa.private_key));
    var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
      method: 'post', muteHttpExceptions: true,
      payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + claim + '.' + sig }
    });
    var body = JSON.parse(res.getContentText() || '{}');
    if (!body.access_token) fail('Google refused the notification key: ' + (body.error_description || body.error || res.getResponseCode()));
    cache.put('cn_fcm_token', body.access_token, 3000);
    return { token: body.access_token, projectId: sa.project_id };
  }

  /** who: 'all', a name, or a list of names. */
  function sendTo(who, title, body, hash) {
    var t = table(TAB.devices);
    if (!t.sheet || !t.rows.length) return { sent: 0, failed: 0, note: 'No phones have turned on notifications yet.' };
    var names = who === 'all' ? null : [].concat(who).map(lc);
    var tokens = t.rows.filter(function (row) {
      return !names || names.indexOf(lc(get(t, row, 'Who'))) >= 0;
    }).map(function (row) { return str(get(t, row, 'Token')); }).filter(function (x) { return x; });
    if (!tokens.length) return { sent: 0, failed: 0, note: 'No phones found for ' + [].concat(who).join(', ') + '.' };
    var auth = fcmAuth();
    var link = setting('App URL') + (hash || '');
    var reqs = tokens.map(function (tok) {
      return {
        url: 'https://fcm.googleapis.com/v1/projects/' + auth.projectId + '/messages:send',
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { Authorization: 'Bearer ' + auth.token },
        payload: JSON.stringify({ message: {
          token: tok,
          data: { title: str(title), body: str(body), url: link, tag: 'chefnem-' + Date.now() },
          webpush: { headers: { Urgency: 'high', TTL: '43200' } }
        } })
      };
    });
    var res = UrlFetchApp.fetchAll(reqs), sent = 0, dead = [], errors = [];
    res.forEach(function (r, i) {
      var code = r.getResponseCode(), text = r.getContentText();
      if (code === 200) { sent++; return; }
      if (code === 404 || /UNREGISTERED|registration-token-not-registered/i.test(text)) dead.push(tokens[i]);
      else errors.push(code + ': ' + text.slice(0, 200));
    });
    if (dead.length) removeTokens(dead);
    return { sent: sent, failed: tokens.length - sent, removed: dead.length, errors: errors };
  }

  function testPush(a) {
    var r = sendTo(a.who ? [a.who] : 'all', setting('App name', 'Chef Nem'), 'Test notification. You\'re all set.', '#more');
    return { ok: true, result: r };
  }

  // ---------- reminders (cnTick, every 15 minutes) ----------

  function sentKey(type, id) { return 'CN_SENT_' + type + '_' + id; }
  function wasSent(type, id) { return props().getProperty(sentKey(type, id)); }
  function markSent(type, id) { props().setProperty(sentKey(type, id), String(Date.now())); }
  function cleanupSent(today) {
    var all = props().getProperties();
    Object.keys(all).forEach(function (k) {
      var m = k.match(/^CN_SENT_\w+?_(\d{4}-\d{2}-\d{2})$/);
      if (m && dayDiff(m[1], today) > 21) props().deleteProperty(k);
    });
  }
  function nextMonday(today) {
    var p = today.split('-');
    var dow = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 12)).getUTCDay(); // 0 Sun .. 6 Sat
    var add = ((8 - dow) % 7) || 7;
    return addDays(today, add);
  }
  function money(v) { var n = Number(String(v).replace(/[^0-9.]/g, '')); return isNaN(n) || !String(v) ? '' : '$' + Math.round(n); }

  function tick() {
    if (!serviceAccount()) return;
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) return;
    try {
      var now = new Date();
      var today = fmt(now, 'yyyy-MM-dd'), hm = fmt(now, 'HH:mm'), dow = fmt(now, 'EEEE');
      cleanupSent(today);
      var tw = readThisWeek().map;
      var weekOf = tw['Week of'] || '', status = str(tw['Status']);
      var planDay = setting('Plan day', 'Saturday');
      var appName = setting('App name', 'Chef Nem');
      var budget = Number(setting('Food budget', tw['Budget'] || '250')) || 250;

      if (dow.toLowerCase() === planDay.toLowerCase()) {
        var coming = nextMonday(today);
        var checkT = hhmm(setting('Plan check time'), '05:30');
        var readyT = hhmm(setting('Plan ready time'), '06:00');
        var nudgeT = hhmm(setting('Approval nudge time'), '06:30');

        if (hm >= checkT && hm < '12:00' && weekOf !== coming && !wasSent('check', today)) {
          sendTo(list('Alerts to', setting('People')), appName + ': plan didn\'t run',
            'Open the ' + appName + ' project in Claude and say: run ' + appName + '.', '#plan');
          markSent('check', today);
        }
        if (weekOf === coming && status === 'Draft' && hm < '12:00') {
          if (hm >= readyT && !wasSent('ready', weekOf)) {
            var est = money(tw['Food estimate']);
            sendTo('all', 'This week\'s plan is ready',
              (est ? 'Food ' + est + ' of $' + budget + '. ' : '') + 'Tap to review and approve.', '#plan');
            markSent('ready', weekOf);
          } else if (hm >= nudgeT && wasSent('ready', weekOf) && !wasSent('nudge', weekOf) &&
                     Date.now() - Number(wasSent('ready', weekOf)) > 25 * 60000) {
            sendTo('all', 'Plan still needs approval', 'One tap and the carts can be filled.', '#plan');
            markSent('nudge', weekOf);
          }
        }
      }

      // Week set: wrap-up finished in the last 6 hours.
      var wrapped = str(tw['Wrapped up at']);
      if (weekOf && status === 'Done' && wrapped && !wasSent('done', weekOf)) {
        var wrappedMs = Date.parse(wrapped);
        if (!isNaN(wrappedMs) && Date.now() - wrappedMs < 6 * 3600000) {
          sendTo('all', 'Week set', 'Recipes are ready and dinners are on the calendar.', '#recipes');
        }
        markSent('done', weekOf);
      }

      var pt = table(TAB.plan), people = lunchPeople(pt), byDate = {};
      pt.rows.forEach(function (row) { var p = planRow(pt, row, people); if (p.date) byDate[p.date] = p; });

      var dinnerT = hhmm(setting('Dinner reminder time'), '15:00');
      var todayPlan = byDate[today];
      if (hm >= dinnerT && hm < '20:00' && todayPlan && todayPlan.dinner && !wasSent('dinner', today)) {
        sendTo('all', 'Dinner tonight', todayPlan.dinner + (todayPlan.note ? ' · ' + todayPlan.note : ''), '#recipes');
        markSent('dinner', today);
      }

      var prepT = hhmm(setting('Prep reminder time'), '19:30');
      var tomorrow = addDays(today, 1), tPlan = byDate[tomorrow];
      if (hm >= prepT && hm < '22:30' && tPlan && tPlan.dinner && !wasSent('prep', tomorrow)) {
        var prep = prepStep(tPlan);
        if (prep) sendTo('all', 'Prep tonight for tomorrow', prep, '#recipes');
        markSent('prep', tomorrow);
      }
    } finally {
      lock.releaseLock();
    }
  }

  function prepStep(p) {
    var re = /\b(thaw|defrost|marinat\w*|overnight|soak|brine)\b/i;
    var rt = table(TAB.recipes), found = '';
    rt.rows.forEach(function (row) {
      if (found) return;
      var r = recipeRow(rt, row);
      if (r.weekOf !== p.weekOf || lc(r.day) !== lc(p.day) || !/dinner/i.test(r.meal)) return;
      var step = r.steps.concat([r.name]).filter(function (s) { return re.test(s); })[0];
      if (step) found = step.replace(/^\d+\.\s*/, '');
    });
    if (!found && re.test(p.note)) found = p.note;
    if (!found) return '';
    return (found.length > 140 ? found.slice(0, 137) + '…' : found) + ' (' + p.dinner + ')';
  }

  // ---------- setup and passcode ----------

  function hash(pass, salt) {
    var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + pass, Utilities.Charset.UTF_8);
    return Utilities.base64Encode(bytes);
  }
  function checkPass(pass) {
    var stored = props().getProperty('CN_PASS_HASH');
    if (!stored) fail('not-configured');
    var cache = CacheService.getScriptCache();
    var fails = Number(cache.get('cn_fails') || 0);
    if (fails >= 10) fail('Too many wrong passcodes. Wait 10 minutes.');
    if (hash(str(pass), props().getProperty('CN_PASS_SALT')) !== stored) {
      cache.put('cn_fails', String(fails + 1), 600);
      fail('wrong-passcode');
    }
  }
  function createPasscode(a) {
    return withLock(function () {
      if (props().getProperty('CN_PASS_HASH')) fail('A passcode is already set.');
      var pass = str(a.newPass);
      if (pass.length < 6) fail('Use at least 6 characters.');
      var salt = Utilities.getUuid();
      props().setProperty('CN_PASS_SALT', salt);
      props().setProperty('CN_PASS_HASH', hash(pass, salt));
      return { ok: true };
    });
  }

  function setup() {
    ensureSheet(TAB.devices, DEVICE_HEADERS);
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === 'cnTick') ScriptApp.deleteTrigger(t);
    });
    ScriptApp.newTrigger('cnTick').timeBased().everyMinutes(15).create();
    UrlFetchApp.getRequest('https://fcm.googleapis.com/'); // asks for the "connect to external service" permission now
    var msg = 'Chef Nem API ' + CN_VERSION + ' is set up. Reminders check every 15 minutes. ' +
      (serviceAccount() ? 'Notification key found.' : 'Next: add the CN_FCM_SERVICE_ACCOUNT script property.') +
      (props().getProperty('CN_PASS_HASH') ? ' Passcode is set.' : ' Create the passcode from the app.');
    Logger.log(msg);
    return msg;
  }

  // ---------- request handling ----------

  var ACTIONS = {
    state: function () { return state(); },
    approve: approve,
    setField: setField,
    checkin: checkin,
    grocery: grocery,
    star: star,
    registerDevice: registerDevice,
    unregisterDevice: unregisterDevice,
    testPush: testPush
  };

  function handle(e) {
    try {
      var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
      var action = str(req.action);
      if (action === 'hello') {
        return out({ ok: true, app: 'chef-nem-api', version: CN_VERSION, configured: !!props().getProperty('CN_PASS_HASH') });
      }
      if (action === 'createPasscode') return out(createPasscode(req.args || {}));
      checkPass(req.pass);
      var fn = ACTIONS[action];
      if (!fn) fail('Unknown action.');
      return out(fn(req.args || {}));
    } catch (err) {
      var msg = err && err.cnUser ? err.message : 'Something went wrong: ' + (err && err.message ? err.message : err);
      return out({ ok: false, error: msg });
    }
  }

  return { handle: handle, setup: setup, tick: tick, sendTo: sendTo };
})();
