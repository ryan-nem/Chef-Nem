/* Chef Nem Home Screen app. Talks to the Apps Script API in the family's sheet. */
'use strict';

const VERSION = '1.0.0';
const FIREBASE = 'https://www.gstatic.com/firebasejs/10.12.2';
const TABS = ['plan', 'groceries', 'recipes', 'saved', 'more'];

// ---------- storage ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('cn.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('cn.' + k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } },
  del(k) { try { localStorage.removeItem('cn.' + k); } catch (e) { /* ignore */ } }
};

let cfg = store.get('cfg', {});            // { api, pass, who }
let S = store.get('state', null);          // last state from the server
let queue = store.get('queue', []);        // changes not yet saved
let tab = 'plan';
let lastRefresh = 0;
let flushing = false;
let refreshing = false;
const ui = { open: {}, groceryFilter: store.get('groceryFilter', 'all'), confirmApprove: false, setup: null };

const $ = (s) => document.querySelector(s);
const view = $('#view');
const esc = (v) => String(v === undefined || v === null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- helpers ----------
function toast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms || 3200);
}
function setSync(text, cls) {
  const el = $('#sync');
  el.textContent = text;
  el.className = 'sync ' + (cls || '');
}
function dayLabel(ymd, opts) {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US',
    Object.assign({ weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }, opts || {}));
}
function timeLabel(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso || '';
  return d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}
function money(v) {
  const n = Number(String(v === undefined ? '' : v).replace(/[^0-9.]/g, ''));
  return String(v || '').trim() === '' || isNaN(n) ? '' : '$' + Math.round(n);
}
function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }
function deviceName() {
  const ua = navigator.userAgent;
  const m = ua.match(/\(([^)]+)\)/);
  return (m ? m[1] : ua).slice(0, 100);
}

// ---------- server ----------
async function api(action, args) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  let res;
  try {
    res = await fetch(cfg.api, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, pass: cfg.pass, args: args || {} }),
      redirect: 'follow',
      signal: ctrl.signal
    });
  } catch (e) {
    const err = new Error('offline'); err.network = true; throw err;
  } finally {
    clearTimeout(timer);
  }
  let data;
  try { data = await res.json(); } catch (e) {
    const err = new Error('The app link didn\'t answer correctly. Check it in More → Connection.'); err.server = true; throw err;
  }
  if (!data.ok) {
    const err = new Error(data.error || 'Something went wrong.'); err.server = true;
    if (data.error === 'wrong-passcode') { err.message = 'Wrong passcode.'; err.auth = true; }
    if (data.error === 'not-configured') { err.message = 'Set up a passcode first.'; err.auth = true; }
    throw err;
  }
  return data;
}

async function refresh(quiet) {
  if (!cfg.api || refreshing) return;
  refreshing = true;
  if (!quiet) setSync('Updating…');
  try {
    const s = await api('state');
    queue.forEach((op) => applyOp(s, op));
    S = s;
    store.set('state', S);
    lastRefresh = Date.now();
    render();
    setSync(queue.length ? 'Saving…' : 'Updated ' + new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }));
    syncPushToken();
  } catch (e) {
    if (e.auth) return signOut(e.message);
    setSync(e.network ? 'Offline · showing saved copy' : 'Couldn\'t update', 'warn');
    if (!e.network) toast(e.message, 5000);
  } finally {
    refreshing = false;
  }
}

// Changes show instantly, then save in the background (and survive going offline).
function change(action, args) {
  const op = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), action, args };
  queue.push(op);
  store.set('queue', queue);
  applyOp(S, op);
  store.set('state', S);
  render();
  flush();
}

function applyOp(s, op) {
  if (!s) return;
  const a = op.args;
  if (op.action === 'grocery') {
    const g = s.groceries.find((x) => x.key === a.key);
    if (g) { g.checked = a.checked; g.checkedBy = a.checked ? a.who : ''; }
  } else if (op.action === 'checkin') {
    const c = s.checkin.find((x) => x.date === a.date);
    if (c) { c.made = a.made; c.rating = a.made === 'Made' ? a.rating : ''; }
  } else if (op.action === 'setField') {
    s.week[a.field] = a.value;
  } else if (op.action === 'approve') {
    if (s.week.Status === 'Draft') {
      s.week.Status = 'Approved'; s.week['Approved by'] = a.who; s.week['Approved at'] = new Date().toISOString();
    }
  } else if (op.action === 'star') {
    s.favorites = s.favorites.filter((f) => f.id !== a.id);
    if (a.starred) {
      const r = s.recipes.find((x) => x.id === a.id);
      if (r) s.favorites.unshift({ id: r.id, name: r.name, meal: r.meal, ingredients: r.ingredients, steps: r.steps, kidsNote: r.kidsNote, starredBy: a.who });
    }
  }
}

let retryTimer = null;
async function flush() {
  if (flushing || !queue.length) return;
  flushing = true;
  setSync('Saving…');
  let needRefresh = false;
  while (queue.length) {
    const op = queue[0];
    try {
      await api(op.action, op.args);
      queue.shift();
      store.set('queue', queue);
    } catch (e) {
      if (e.network) {
        setSync('Offline · will save when connected', 'warn');
        clearTimeout(retryTimer);
        retryTimer = setTimeout(flush, 8000);
        flushing = false;
        return;
      }
      if (e.auth) { flushing = false; return signOut(e.message); }
      queue.shift();
      store.set('queue', queue);
      toast(e.message, 6000);
      needRefresh = true;
    }
  }
  flushing = false;
  setSync('Saved');
  // Pick up anything the other phone changed, without blocking taps.
  clearTimeout(flush._r);
  flush._r = setTimeout(() => refresh(true), needRefresh ? 0 : 2500);
}

// ---------- rendering ----------
function render() {
  if (!cfg.api || !cfg.pass || !cfg.who) { $('#tabs').hidden = true; return renderSetup(); }
  $('#tabs').hidden = false;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  if (S && S.settings) {
    $('#appName').textContent = S.settings.appName || 'Chef Nem';
    document.title = S.settings.appName || 'Chef Nem';
  }
  if (!S) { view.innerHTML = '<div class="empty">Loading your week…</div>'; return; }
  const fn = { plan: renderPlan, groceries: renderGroceries, recipes: renderRecipes, saved: renderSaved, more: renderMore }[tab];
  view.innerHTML = fn();
}

function seg(options, current, act, extra) {
  return '<div class="seg">' + options.map(([val, label]) =>
    `<button class="${val === current ? 'on' : ''}" data-act="${act}" data-val="${esc(val)}" ${extra || ''}>${esc(label)}</button>`).join('') + '</div>';
}

function renderPlan() {
  const w = S.week || {};
  const status = w.Status || 'Draft';
  const locked = status === 'Done';
  const budget = S.settings.budget || 250;
  const est = Number(String(w['Food estimate'] || '').replace(/[^0-9.]/g, ''));
  let h = '';

  h += `<section class="hero">
    <div class="eyebrow">Week of ${esc(dayLabel(w['Week of'], { weekday: 'long' }))}</div>
    <h1>${esc(w.Headline || 'This week')}</h1>
    <div class="row gap">
      <span class="pill ${status.toLowerCase()}">${esc(status)}</span>
      ${w['Food estimate'] !== undefined && w['Food estimate'] !== '' ? `<span class="pill ${est > budget ? 'over' : ''}">Food ${esc(money(w['Food estimate']))} of $${budget}</span>` : ''}
    </div>
    ${status !== 'Draft' && w['Approved by'] ? `<div class="sub">Approved by ${esc(w['Approved by'])} · ${esc(timeLabel(w['Approved at']))}</div>` : ''}
  </section>`;

  if (S.allergy && S.allergy.length) {
    const a = S.allergy[0];
    h += `<div class="alert"><b>Heads up: ${esc(a.term)} found</b> in ${esc(a.where)}: “${esc(a.text.split('\n')[0])}”. Approval is blocked until the plan is fixed.</div>`;
  }

  if (S.checkin && S.checkin.length) {
    h += `<section><h2>How did last week go?</h2><p class="hint">Tap what you made, then how it went.</p>`;
    S.checkin.forEach((c) => {
      h += `<div class="card checkin">
        <div class="ci-top"><span class="day">${esc(dayLabel(c.date))}</span><span class="meal">${esc(c.dinner)}</span></div>
        <div class="row gap wrap">
          ${seg([['Made', 'Made it'], ['Skipped', 'Skipped']], c.made, 'made', `data-date="${esc(c.date)}" ${locked ? 'disabled' : ''}`)}
          ${c.made === 'Made' ? seg([['Liked', '👍 Liked'], ['Pass', 'Pass']], c.rating, 'rating', `data-date="${esc(c.date)}" ${locked ? 'disabled' : ''}`) : ''}
        </div></div>`;
    });
    h += `</section>`;
  }

  h += `<section><h2>Meals</h2>`;
  if (!S.plan.length) h += `<div class="empty">No meals planned for this week yet.</div>`;
  S.plan.forEach((p) => {
    const lunches = Object.keys(p.lunches || {}).filter((k) => p.lunches[k]);
    h += `<div class="card day">
      <div class="day-name">${esc(dayLabel(p.date))}</div>
      <div class="dinner">${esc(p.dinner || 'No dinner planned')}</div>
      ${lunches.map((k) => `<div class="lunch"><span>${esc(k)}</span>${esc(p.lunches[k])}</div>`).join('')}
      ${p.note ? `<div class="note">${esc(p.note)}</div>` : ''}
    </div>`;
  });
  h += `</section>`;

  if (w['New dish']) {
    const open = ui.open.newdish;
    h += `<section><h2>New dish to try</h2><div class="card">
      <div class="dinner">${esc(w['New dish'])}</div>
      ${w['New dish why'] ? `<p>${esc(w['New dish why'])}</p>` : ''}
      ${w['New dish details'] ? `<button class="link" data-act="toggle" data-key="newdish">${open ? 'Hide details' : 'Show details'}</button>
        ${open ? `<p class="pre">${esc(w['New dish details'])}</p>` : ''}` : ''}
      ${seg([['Yes', 'Yes'], ['Later', 'Maybe later'], ['No', 'No']], w['New dish decision'] || '', 'decision', locked ? 'disabled' : '')}
    </div></section>`;
  }

  const days = S.settings.deliveryDays && S.settings.deliveryDays.length ? S.settings.deliveryDays : ['Saturday', 'Sunday', 'Monday'];
  const chosen = w['Delivery choice'] || w['Delivery default'] || '';
  h += `<section><h2>Delivery day</h2>
    ${seg(days.map((d) => [d, d.slice(0, 3) + (d === w['Delivery default'] ? ' (usual)' : '')]), chosen, 'delivery', locked ? 'disabled' : '')}
  </section>`;

  h += `<section><h2>Notes for ${esc(S.settings.appName || 'Chef Nem')}</h2>
    <textarea id="notes" rows="3" placeholder="Swaps or changes for this week" ${locked ? 'disabled' : ''}>${esc(w.Notes || '')}</textarea>
  </section>`;

  if (status === 'Draft') {
    const blocked = S.allergy && S.allergy.length;
    h += `<div class="approve-bar"><button class="primary big ${ui.confirmApprove ? 'confirm' : ''}" data-act="approve" ${blocked ? 'disabled' : ''}>
      ${blocked ? 'Fix the plan to approve' : ui.confirmApprove ? 'Tap again to approve' : 'Approve plan'}</button></div>`;
  } else if (locked) {
    h += `<p class="hint center">This week is wrapped up. Recipes are in the Recipes tab.</p>`;
  }
  return h;
}

function renderGroceries() {
  const w = S.week || {};
  const all = S.groceries || [];
  const active = all.filter((g) => g.change !== 'Remove');
  const removed = all.filter((g) => g.change === 'Remove');
  const f = ui.groceryFilter;
  const kindOf = (g) => /in store/i.test(g.kind) ? 'store' : /household/i.test(g.kind) ? 'extra' : 'cart';
  const shown = active.filter((g) => f === 'all' || kindOf(g) === f);
  const rank = { store: 0, cart: 1, extra: 2 };
  const groups = {};
  shown.forEach((g) => { (groups[g.store + '|' + kindOf(g)] = groups[g.store + '|' + kindOf(g)] || []).push(g); });
  const keys = Object.keys(groups).sort((a, b) => rank[a.split('|')[1]] - rank[b.split('|')[1]] || a.localeCompare(b));
  const label = { store: 'In store', cart: 'Online cart', extra: 'Household extras · check what you want' };

  let h = `<section class="hero slim"><div class="eyebrow">Week of ${esc(dayLabel(w['Week of']))}</div><h1>Groceries</h1>
    ${seg([['all', 'All'], ['store', 'In store'], ['cart', 'Cart'], ['extra', 'Extras']], f, 'gfilter')}</section>`;
  if (!shown.length) h += `<div class="empty">Nothing here this week.</div>`;
  keys.forEach((k) => {
    const [storeName, kind] = k.split('|');
    const rows = groups[k];
    const done = rows.filter((g) => g.checked).length;
    h += `<section><div class="group-head"><h2>${esc(storeName)}</h2><span class="count">${done}/${rows.length}</span></div>
      <div class="sub">${esc(label[kind])}</div><div class="list">`;
    rows.forEach((g) => {
      const newDish = /^new dish/i.test(g.forWhat) && w['New dish decision'] !== 'Yes';
      const badge = g.change && g.change !== 'Same' ? `<span class="badge ${esc(g.change.toLowerCase())}">${esc(g.change)}</span>` : '';
      h += `<button class="item ${g.checked ? 'done' : ''} ${newDish ? 'dim' : ''}" data-act="check" data-key="${esc(g.key)}">
        <span class="box">${g.checked ? '✓' : ''}</span>
        <span class="txt"><span class="name">${esc(g.item)}${g.qty ? ` <span class="qty">· ${esc(g.qty)}</span>` : ''}</span>
          ${g.forWhat ? `<span class="for">${esc(g.forWhat)}${newDish ? ' · only if the new dish is a Yes' : ''}</span>` : ''}</span>
        <span class="meta">${badge}${money(g.cost) ? `<span class="cost">${esc(money(g.cost))}</span>` : ''}
          ${g.checked && g.checkedBy ? `<span class="by">${esc(g.checkedBy.slice(0, 1))}</span>` : ''}</span>
      </button>`;
    });
    h += `</div></section>`;
  });
  if (removed.length && (f === 'all' || f === 'cart')) {
    h += `<section><details><summary>Not buying this week (${removed.length})</summary><div class="list">
      ${removed.map((g) => `<div class="item dim"><span class="box"></span><span class="txt"><span class="name">${esc(g.item)}</span><span class="for">${esc(g.store)} · last week ${esc(g.qty)}</span></span></div>`).join('')}
    </div></details></section>`;
  }
  return h;
}

function recipeCard(r, isFav) {
  const open = ui.open['r:' + r.id];
  const starred = (S.favorites || []).some((f) => f.id === r.id);
  return `<div class="card recipe">
    <div class="recipe-head">
      <button class="recipe-title" data-act="toggle" data-key="r:${esc(r.id)}">
        <span class="eyebrow">${esc([r.day, r.meal].filter(Boolean).join(' · '))}</span>
        <span class="dinner">${esc(r.name)}</span>
        <span class="sub">${esc([r.time, r.servings ? r.servings + ' servings' : ''].filter(Boolean).join(' · '))}</span>
      </button>
      ${r.id ? `<button class="star ${starred ? 'on' : ''}" data-act="star" data-id="${esc(r.id)}" aria-label="Save recipe">${starred ? '★' : '☆'}</button>` : ''}
    </div>
    ${open ? `
      ${r.ingredients && r.ingredients.length ? `<h3>Ingredients</h3><ul>${r.ingredients.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
      ${r.steps && r.steps.length ? `<h3>Steps</h3><ol>${r.steps.map((s) => `<li>${esc(s.replace(/^\d+\.\s*/, ''))}</li>`).join('')}</ol>` : ''}
      ${r.kidsNote ? `<div class="kids"><b>For the kids:</b> ${esc(r.kidsNote)}</div>` : ''}
      ${isFav && r.starredBy ? `<div class="sub">Saved by ${esc(r.starredBy)}</div>` : ''}
    ` : ''}
  </div>`;
}

function renderRecipes() {
  const list = S.recipes || [];
  let h = `<section class="hero slim"><div class="eyebrow">Week of ${esc(dayLabel((S.week || {})['Week of']))}</div><h1>Recipes</h1>
    <p class="sub">Tap a recipe to open it. ☆ saves it to your favorites.</p></section>`;
  if (!list.length) h += `<div class="empty">Recipes show up here after the plan is approved and wrapped up.</div>`;
  h += list.map((r) => recipeCard(r, false)).join('');
  return h;
}

function renderSaved() {
  const list = S.favorites || [];
  let h = `<section class="hero slim"><h1>Saved recipes</h1><p class="sub">${list.length} saved. These get worked back into future plans.</p></section>`;
  if (!list.length) h += `<div class="empty">Tap ☆ on a recipe to save it here.</div>`;
  h += list.map((r) => recipeCard(r, true)).join('');
  return h;
}

function renderMore() {
  const fb = S.settings && S.settings.firebase;
  const pushToken = store.get('pushToken', null);
  let push;
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!supported && isIOS() && !isStandalone()) {
    push = `<p>Add the app to your Home Screen first: tap <b>Share</b> → <b>Add to Home Screen</b>, then open it from the icon and come back here.</p>`;
  } else if (!supported) {
    push = `<p>This browser can't show notifications.</p>`;
  } else if (!fb) {
    push = `<p>Notifications aren't connected yet. Fill in the Firebase rows on the Settings tab of the sheet.</p>`;
  } else if (Notification.permission === 'denied') {
    push = `<p>Notifications are blocked. Turn them on in iPhone Settings → Notifications → ${esc(S.settings.appName || 'Chef Nem')}.</p>`;
  } else if (Notification.permission === 'granted' && pushToken) {
    push = `<p>On for this phone.</p><div class="row gap wrap">
      <button class="secondary" data-act="testpush">Send a test</button>
      <button class="ghost" data-act="pushoff">Turn off</button></div>`;
  } else {
    push = `<p>Get the Saturday plan alert, approval nudges and tonight's dinner.</p>
      <button class="primary" data-act="pushon">Turn on notifications</button>`;
  }
  const people = (S.settings && S.settings.people) || [];
  return `<section class="hero slim"><h1>More</h1></section>
    <section><h2>Notifications</h2><div class="card">${push}</div></section>
    <section><h2>You are</h2>${seg(people.map((p) => [p, p]), cfg.who, 'who')}</section>
    <section><h2>Add someone in your family</h2><div class="card">
      <p>Send them the app link, then tell them the passcode in person.</p>
      <button class="secondary" data-act="share">Share app link</button></div></section>
    <section><h2>This phone</h2><div class="card">
      <div class="row gap wrap"><button class="secondary" data-act="refresh">Refresh now</button>
      <button class="ghost" data-act="signout">Disconnect</button></div>
      <p class="sub">Version ${VERSION}${S.version ? ' · server ' + esc(S.version) : ''}${queue.length ? ' · ' + queue.length + ' change(s) waiting to save' : ''}</p></div></section>`;
}

// ---------- setup ----------
function renderSetup() {
  const st = ui.setup || (ui.setup = { step: 'connect', api: cfg.api || store.get('connectHint', '') || '', people: [] });
  let h = `<section class="hero"><h1>Welcome</h1><p class="sub">Connect this phone to your family's meal plan.</p></section>`;
  if (st.step === 'connect') {
    h += `<section class="card form">
      <label>App connection link<input id="setApi" type="url" inputmode="url" autocomplete="off" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(st.api)}"></label>
      <label>Family passcode<input id="setPass" type="password" autocomplete="current-password" placeholder="Passcode"></label>
      <button class="primary big" data-act="connect">Connect</button>
      ${st.error ? `<p class="error">${esc(st.error)}</p>` : ''}
      <p class="sub">The link comes from whoever set up the app. The passcode should be shared in person, not in the link.</p>
    </section>`;
  } else if (st.step === 'create') {
    h += `<section class="card form"><p><b>First time here.</b> Create the family passcode. Everyone in the family uses this same passcode.</p>
      <label>New passcode (6+ characters)<input id="newPass" type="password" autocomplete="new-password"></label>
      <label>Type it again<input id="newPass2" type="password" autocomplete="new-password"></label>
      <button class="primary big" data-act="createpass">Create passcode</button>
      ${st.error ? `<p class="error">${esc(st.error)}</p>` : ''}</section>`;
  } else if (st.step === 'who') {
    h += `<section><h2>Who's using this phone?</h2>
      ${st.people.map((p) => `<button class="choice" data-act="pickwho" data-val="${esc(p)}">${esc(p)}</button>`).join('')}</section>`;
  }
  if (isIOS() && !isStandalone()) {
    h += `<section class="card"><p><b>Tip:</b> tap <b>Share</b> → <b>Add to Home Screen</b> so it opens like an app and can send notifications.</p></section>`;
  }
  view.innerHTML = h;
}

async function doConnect() {
  const st = ui.setup;
  const url = $('#setApi').value.trim();
  const pass = $('#setPass').value;
  st.api = url; st.error = '';
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) { st.error = 'That doesn\'t look like the app link. It starts with https://script.google.com and ends with /exec.'; return renderSetup(); }
  cfg = { api: url, pass };
  setSync('Connecting…');
  try {
    const hello = await api('hello');
    if (!hello.configured) { st.step = 'create'; setSync(''); return renderSetup(); }
    if (!pass) { st.error = 'Enter the passcode.'; setSync(''); return renderSetup(); }
    const s = await api('state');
    S = s; store.set('state', S);
    st.people = (s.settings && s.settings.people) || [];
    st.step = 'who';
    setSync('');
    renderSetup();
  } catch (e) {
    st.error = e.network ? 'Couldn\'t reach the app link. Check the link and your connection.' : e.message;
    setSync('');
    renderSetup();
  }
}

async function doCreatePass() {
  const st = ui.setup;
  const a = $('#newPass').value, b = $('#newPass2').value;
  st.error = '';
  if (a.length < 6) { st.error = 'Use at least 6 characters.'; return renderSetup(); }
  if (a !== b) { st.error = 'Those don\'t match.'; return renderSetup(); }
  try {
    await api('createPasscode', { newPass: a });
    cfg.pass = a;
    const s = await api('state');
    S = s; store.set('state', S);
    st.people = (s.settings && s.settings.people) || [];
    st.step = 'who';
    renderSetup();
  } catch (e) { st.error = e.message; renderSetup(); }
}

function signOut(msg) {
  cfg = {}; S = null; queue = [];
  ['cfg', 'state', 'queue', 'pushToken', 'pushAt'].forEach(store.del);
  ui.setup = null;
  if (msg) toast(msg, 5000);
  render();
}

// ---------- notifications ----------
let fbMessaging = null;
async function messaging() {
  if (fbMessaging) return fbMessaging;
  const fb = S.settings.firebase;
  const appMod = await import(FIREBASE + '/firebase-app.js');
  const msgMod = await import(FIREBASE + '/firebase-messaging.js');
  const app = appMod.getApps().length ? appMod.getApps()[0] : appMod.initializeApp(fb.config);
  fbMessaging = { m: msgMod.getMessaging(app), getToken: msgMod.getToken, deleteToken: msgMod.deleteToken };
  return fbMessaging;
}
async function currentToken() {
  const reg = await navigator.serviceWorker.ready;
  const fm = await messaging();
  return fm.getToken(fm.m, { vapidKey: S.settings.firebase.vapidKey, serviceWorkerRegistration: reg });
}
async function pushOn() {
  const perm = await Notification.requestPermission(); // must run straight from the tap
  if (perm !== 'granted') { toast('Notifications weren\'t allowed.'); return render(); }
  setSync('Turning on…');
  try {
    const token = await currentToken();
    await api('registerDevice', { token, who: cfg.who, device: deviceName() });
    store.set('pushToken', token); store.set('pushAt', Date.now());
    setSync('Notifications on');
    toast('Notifications are on. Try “Send a test”.');
  } catch (e) {
    setSync('');
    toast('Couldn\'t turn on notifications: ' + e.message, 7000);
  }
  render();
}
async function pushOff() {
  const token = store.get('pushToken', null);
  try {
    if (token) await api('unregisterDevice', { token });
    const fm = await messaging(); await fm.deleteToken(fm.m);
  } catch (e) { /* still forget it locally */ }
  store.del('pushToken'); store.del('pushAt');
  toast('Notifications are off for this phone.');
  render();
}
// iPhones sometimes drop push registrations, so re-check quietly on each open.
async function syncPushToken() {
  try {
    if (!S || !S.settings.firebase || !('Notification' in window) || Notification.permission !== 'granted') return;
    const old = store.get('pushToken', null);
    if (!old) return;
    const token = await currentToken();
    const stale = Date.now() - store.get('pushAt', 0) > 3 * 86400000;
    if (token && (token !== old || stale)) {
      await api('registerDevice', { token, who: cfg.who, device: deviceName() });
      if (token !== old) await api('unregisterDevice', { token: old }).catch(() => {});
      store.set('pushToken', token); store.set('pushAt', Date.now());
    }
  } catch (e) { /* try again next open */ }
}

// ---------- events ----------
view.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const act = b.dataset.act, val = b.dataset.val;
  const w = (S && S.week) || {};
  switch (act) {
    case 'connect': return doConnect();
    case 'createpass': return doCreatePass();
    case 'pickwho':
      cfg.who = val; store.set('cfg', cfg); ui.setup = null; tab = 'plan'; render(); refresh(); return;
    case 'who': cfg.who = val; store.set('cfg', cfg); render(); return;
    case 'toggle': ui.open[b.dataset.key] = !ui.open[b.dataset.key]; render(); return;
    case 'made': {
      const c = S.checkin.find((x) => x.date === b.dataset.date);
      const made = c && c.made === val ? '' : val;
      return change('checkin', { date: b.dataset.date, made, rating: made === 'Made' ? (c && c.rating) || '' : '' });
    }
    case 'rating': {
      const c = S.checkin.find((x) => x.date === b.dataset.date);
      return change('checkin', { date: b.dataset.date, made: 'Made', rating: c && c.rating === val ? '' : val });
    }
    case 'decision': return change('setField', { weekOf: w['Week of'], field: 'New dish decision', value: w['New dish decision'] === val ? '' : val });
    case 'delivery': return change('setField', { weekOf: w['Week of'], field: 'Delivery choice', value: val });
    case 'approve':
      if (!ui.confirmApprove) {
        ui.confirmApprove = true; render();
        setTimeout(() => { ui.confirmApprove = false; if (tab === 'plan') render(); }, 3500);
        return;
      }
      ui.confirmApprove = false;
      return change('approve', { weekOf: w['Week of'], who: cfg.who });
    case 'gfilter': ui.groceryFilter = val; store.set('groceryFilter', val); render(); return;
    case 'check': {
      const g = S.groceries.find((x) => x.key === b.dataset.key);
      if (g) change('grocery', { weekOf: w['Week of'], key: g.key, checked: !g.checked, who: cfg.who });
      return;
    }
    case 'star': {
      const id = b.dataset.id;
      const starred = !(S.favorites || []).some((f) => f.id === id);
      return change('star', { weekOf: w['Week of'], id, starred, who: cfg.who });
    }
    case 'pushon': return pushOn();
    case 'pushoff': return pushOff();
    case 'testpush':
      try {
        const r = await api('testPush', { who: cfg.who });
        const res = r.result || {};
        toast(res.sent ? 'Sent. It should arrive in a few seconds.' : (res.note || (res.errors || [])[0] || 'Nothing was sent.'), 7000);
      } catch (err) { toast(err.message, 7000); }
      return;
    case 'share': {
      const link = location.origin + location.pathname + '#connect=' + encodeURIComponent(cfg.api);
      const title = (S.settings && S.settings.appName) || 'Chef Nem';
      try {
        if (navigator.share) await navigator.share({ title, text: 'Our meal plan app. Open this link, then Share → Add to Home Screen. I\'ll tell you the passcode.', url: link });
        else { await navigator.clipboard.writeText(link); toast('Link copied.'); }
      } catch (err) { /* share sheet closed */ }
      return;
    }
    case 'refresh': return refresh();
    case 'signout': return signOut('Disconnected this phone.');
  }
});

view.addEventListener('focusout', (e) => {
  if (e.target.id === 'notes' && S) {
    const v = e.target.value;
    if (v !== (S.week.Notes || '')) change('setField', { weekOf: S.week['Week of'], field: 'Notes', value: v });
  }
});

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  tab = b.dataset.tab;
  history.replaceState(null, '', '#' + tab);
  window.scrollTo(0, 0);
  render();
});
$('#sync').addEventListener('click', () => refresh());

// Pull down to refresh.
let pullY = null;
window.addEventListener('touchstart', (e) => { pullY = window.scrollY <= 0 ? e.touches[0].clientY : null; }, { passive: true });
window.addEventListener('touchend', (e) => {
  if (pullY !== null && e.changedTouches[0].clientY - pullY > 90) refresh();
  pullY = null;
}, { passive: true });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && cfg.api && Date.now() - lastRefresh > 30000) { flush(); refresh(true); }
});
window.addEventListener('online', () => { flush(); refresh(true); });

function readHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith('connect=')) {
    const url = h.slice(8);
    store.set('connectHint', url);
    if (!cfg.api) ui.setup = { step: 'connect', api: url, people: [] };
    history.replaceState(null, '', location.pathname);
  } else if (TABS.includes(h)) {
    tab = h;
  }
}
window.addEventListener('hashchange', () => { readHash(); render(); });

// ---------- start ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
readHash();
render();
if (cfg.api && cfg.pass && cfg.who) { flush(); refresh(!!S); }
