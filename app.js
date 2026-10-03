/* ================================================================ config
   Filled in 2026-09-26. PUBLISHABLE key only — public by design. Never the secret key. */
const SUPABASE_URL = 'https://zkfhvognsenwvcknnitp.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Osqa5cuL0I_Qsw0pQmmLZQ_o8LkzYyQ';

/* The shop's number — question B in TODO.md, answered 2026-09-26. Shown in the privacy
   line, the "we're down" messages and a rejected booking. */
const SHOP_NAME  = 'Winter Air Services';
const SHOP_PHONE = '0909 958 0512';

const REF_KEY = 'ws_last_ref';
const ringUs = () => SHOP_PHONE ? 'ring us on ' + SHOP_PHONE : 'ring the shop';

/* ================================================================ small helpers */
const $  = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
/* Every value from the network goes into HTML through esc(). Nothing is trusted. */
const esc = v => String(v ?? '').replace(/[&<>"']/g, c =>
  ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() :
  ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));
const digits = s => String(s ?? '').replace(/\D/g, '');
/* A picture that may not exist (the GCash QR) removes itself. A listener, not an inline
   onerror=: the page's Content-Security-Policy runs no inline script at all. */
document.addEventListener('error', e => {
  if (e.target instanceof HTMLImageElement && e.target.hasAttribute('data-gone-if-missing')) e.target.remove();
}, true);
function lsGet(k, d){ try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
function lsSet(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
function lsDel(k){ try { localStorage.removeItem(k); } catch (e) {} }

/* The shop's today, not the phone's: the database checks against Asia/Manila. */
function manilaDate(plusDays){
  const d = new Date(Date.now() + (plusDays || 0) * 864e5);
  return d.toLocaleDateString('en-CA', {timeZone: 'Asia/Manila'});   // YYYY-MM-DD
}
const manilaDay = iso => iso ? new Date(iso).toLocaleDateString('en-CA', {timeZone: 'Asia/Manila'}) : null;
const niceDate = ymd => ymd ? new Date(ymd + 'T00:00:00')
  .toLocaleDateString('en-PH', {weekday: 'short', day: 'numeric', month: 'short'}) : '';
/* The time (33, Guile 2026-10-01): `slot` is a clock time, 'HH:MM' on the 24-hour clock, or —
   on every booking made before it, and from an APK not yet updated — 'am' / 'pm' alone. Every
   screen turns it into words HERE: slotWord in a sentence, slotShort on a row. */
const isClock = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || '');
const slotOk = s => s === 'am' || s === 'pm' || isClock(s);
const clock12 = s => { const h = +s.slice(0, 2); return ((h % 12) || 12) + ':' + s.slice(3) + ' ' + (h < 12 ? 'AM' : 'PM'); };
const slotWord = s => isClock(s) ? clock12(s) : s === 'am' ? 'morning' : s === 'pm' ? 'afternoon' : '';
const slotShort = s => isClock(s) ? clock12(s) : String(s || '').toUpperCase();
const slotKey = s => isClock(s) ? s : s === 'am' ? '00:00' : s === 'pm' ? '12:00' : 'z';   // morning first, then the times
const STATUS_LABEL = {new: 'New', accepted: 'Accepted', rejected: 'Rejected', cancelled: 'Cancelled',
  booked: 'Not scheduled', scheduled: 'Scheduled', in_progress: 'In progress', done: 'Done'};

/* ================================================================ talking to Supabase */
/* Errors the database wrote for a person to read. */
const HUMAN_CODES = ['22023', '53400', '42501', '55000'];
class Unreachable extends Error {}                    // try again later
class Refused extends Error {                         // the server said no
  constructor(msg, human){ super(msg); this.human = human; }
}

let session = lsGet('ws_session', null);   // {access_token, refresh_token, expires_at, email, uid}

async function authFetch(path, body, token){
  let r;
  try {
    r = await fetch(SUPABASE_URL + '/auth/v1' + path, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', apikey: SUPABASE_KEY,
                ...(token ? {Authorization: 'Bearer ' + token} : {})},
      body: JSON.stringify(body || {}),
    });
  } catch (e) { throw new Unreachable('offline'); }
  const b = await r.json().catch(() => ({}));
  if (r.status >= 500) throw new Unreachable('http ' + r.status);
  if (!r.ok){
    const e = new Refused(b.error_description || b.msg || b.message || 'That did not work.', true);
    // The sign-in itself is gone (not a rate limit, not a hiccup): only this ends a session.
    e.dead = r.status !== 429 && /refresh_token|invalid_grant|session_not_found|user_not_found|user_banned/i
      .test([b.error_code, b.code, b.error].filter(Boolean).join(' '));
    throw e;
  }
  return b;
}

function keepSession(b){
  session = {access_token: b.access_token, refresh_token: b.refresh_token,
             expires_at: Date.now() + (b.expires_in || 3600) * 1000,
             email: b.user && b.user.email, uid: b.user && b.user.id,
             role: session && session.uid === (b.user && b.user.id) ? session.role : null};
  lsSet('ws_session', session);
}

/* The saved sign-in stays until Log out (Guile, 2026-09-27: "save the login"). It was lost
   three ways: every call that found the token old refreshed it AT ONCE, with the same
   one-use refresh token; a refusal of ANY kind (a rate limit too) signed the phone out; and
   that sign-out deleted the saved session under every other tab of the same address. Now
   one refresh at a time, a tab takes a token another tab already refreshed, and only a
   sign-in the server says is gone ends it. */
let tokenBusy = null;
async function token(){
  if (!session) return null;
  if (Date.now() > session.expires_at - 60000){
    if (!tokenBusy) tokenBusy = refreshSession().finally(() => { tokenBusy = null; });
    if (!await tokenBusy) return null;
  }
  return session && session.access_token;
}
const newerSaved = () => {
  const s = lsGet('ws_session', null);
  return s && session && s.uid === session.uid && s.refresh_token !== session.refresh_token ? s : null;
};
async function refreshSession(){
  const saved = newerSaved();
  if (saved && Date.now() < saved.expires_at - 60000){ session = saved; return true; }
  try {
    keepSession(await authFetch('/token?grant_type=refresh_token', {refresh_token: session.refresh_token}));
    return true;
  } catch (e) {
    if (!(e instanceof Refused)) throw e;   // offline: keep the old token; the queue waits
    const other = newerSaved();             // another tab won the race: its token is the live one
    if (other){ session = other; return true; }
    if (e.dead){ signedOut('Your sign-in ran out. Please sign in again.'); return false; }
    throw new Unreachable('sign-in refresh: ' + e.message);   // try again later, still signed in
  }
}

async function rpc(fn, args, useSession = true, retried = false){
  const t = useSession ? await token() : null;
  let r;
  try {
    r = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', apikey: SUPABASE_KEY,
                Authorization: 'Bearer ' + (t || SUPABASE_KEY)},
      body: JSON.stringify(args || {}),
    });
  } catch (e) { throw new Unreachable('offline'); }
  const body = await r.json().catch(() => null);
  if (r.ok) return body;
  const code = body && body.code;
  // The server's clock says the sign-in ran out while this phone's clock says it has not —
  // a phone whose clock jumped (set by hand, or corrected by the network) kept sending the
  // old token and every write came back "JWT expired", for good (measured 2026-09-27 with a
  // faked clock). Refresh once and ask again.
  if (r.status === 401 && useSession && session && !retried && /jwt expired/i.test((body && body.message) || '')){
    session.expires_at = 0;
    return rpc(fn, args, useSession, true);
  }
  // A refusal the database words for people is a refusal, whatever the HTTP number: the
  // rate limit (53400) arrives as a 500, and was shown as "could not reach the booking
  // system" (scenario test, 2026-09-27) — and a queued write would have retried it for ever.
  if (HUMAN_CODES.includes(code)) throw new Refused(body.message || 'Refused.', true);
  if (r.status >= 500) throw new Unreachable('http ' + r.status);
  throw new Refused((body && body.message) || 'Refused.', HUMAN_CODES.includes(code));
}

/* ================================================================ the local copy (docs/rules/sync.md)
   Every signed-in screen reads THIS, never the server. Writes land here first and wait in
   the queue; the network is an optimisation, never a precondition. */
let db = null;       // {cursor, role, bookings:{}, customers:{}, jobs:{}, team:{}}
let queue = [];      // [{op_id, fn, args, label, at, touches:[ids], state, error}]
let notices = [];    // decisions that lost, and writes that were refused — shown until dismissed
let online = navigator.onLine;
let lastPullOk = null;
let pullStats = null;  // what the last good pull changed; null = it did not get through
let lastChangeAt = null;   // when a pull last brought something (R5)

const dbKey = () => 'ws_db_' + session.uid;
const qKey  = () => 'ws_queue_' + session.uid;
const nKey  = () => 'ws_notices_' + session.uid;
function emptyDb(){ return {cursor: null, role: null, repair: REPAIR_ID, bookings: {}, customers: {}, jobs: {}, team: {}, settings: {}}; }
/* docs/rules/sync.md: when what the server sends changes shape, bump this, so every phone
   takes one full fresh copy instead of keeping rows that predate the change. 2026-09-26:
   Team gained joined / last seen / on-off, and the owner's phone kept showing "never"
   for rows it already had. 3 (2026-09-26): no assignment — a technician's phone now holds
   every scheduled job, jobs carry status_by, customers carry checkup_snooze. */
const REPAIR_ID = 9;   // 4: customers carry photo_path; a technician's jobs carry customer_id
                       // 8 (0.1.8): jobs carry paid_*/followup_*; ZZ test rows deleted by hand
                       // 9 (0.1.9): ZZ test rows deleted by hand again
                       // 5: a customer's booking carries its job's aircons (17)
                       // 6: the test data was deleted in the SQL editor (2026-09-27); a phone
                       //    keeps deleted jobs and customers until it takes a full copy
                       // 7: a technician's jobs carry on_way_at, cancel_reason, and the price
                       //    with the office's switch on (19)
function loadLocal(){
  db = lsGet(dbKey(), null) || emptyDb();
  if (db.repair !== REPAIR_ID){ db.cursor = null; db.repair = REPAIR_ID; }
  queue = lsGet(qKey(), []);
  notices = lsGet(nKey(), []);
}
function saveLocal(){
  if (!session) return;
  const ok = lsSet(dbKey(), db) & lsSet(qKey(), queue) & lsSet(nKey(), notices);
  if (!ok) notice('This phone would not save the app\'s data (storage full or blocked). Changes are kept only until the page closes.', true);
}
function notice(text, bad){
  notices.push({id: uuid(), at: new Date().toISOString(), text, bad: !!bad});
  if (session) lsSet(nKey(), notices);
  render();
  // The card lives on the main screen; with a screen open on top it was hidden under it
  // (measured 2026-09-27: Book it's complaints). Say it on top as well.
  if (typeof stack !== 'undefined' && stack.length && typeof toast === 'function') toast(text, bad);
}

/* A write: apply it here, queue it, try to send. It always "succeeds" on the phone. */
function write(fn, args, label, touches, applyLocal, after){
  const op = {op_id: uuid(), fn, args: {...args}, label, at: new Date().toISOString(),
              touches: touches || [], state: 'pending'};
  // "after": this write only makes sense if that one lands (Accept → its job → its price)
  if (after) op.after = after;
  op.args.p_op_id = op.op_id;
  if ('p_decided_at' in op.args) op.args.p_decided_at = op.at;
  try { applyLocal && applyLocal(db, op); } catch (e) { console.error(e); }
  forgetStatus(op.touches);   // its history has a new line coming
  queue.push(op);
  saveLocal();
  render();
  flush();
  return op;
}

/* A write that was refused takes the writes that depended on it with it, unsent — Accept
   refused ("already accepted on another phone") used to send its job anyway, which was
   refused too, and a job that exists nowhere stayed on the phone (scenario test,
   2026-09-27). Their rows go with the full fresh copy the refusal asks for. */
function dropAfter(opId){
  const gone = queue.filter(o => o.after === opId);
  if (!gone.length) return;
  queue = queue.filter(o => !gone.includes(o));
  gone.forEach(o => dropAfter(o.op_id));
}
let flushing = false, flushAgain = false;
async function flush(){
  if (!session) return;
  if (flushing){ flushAgain = true; return; }
  flushing = true;
  let lost = false;
  try {
    for (const op of queue.filter(o => o.state === 'pending')){
      if (!queue.includes(op)) continue;   // dropped with the write it depended on
      try {
        const res = await rpc(op.fn, op.args);
        if (res && res.ok === false){
          lost = true;
          notice(op.label + ' — ' + ((res.messages || []).join(' ') || res.message || 'not kept.'), false);
          dropAfter(op.op_id);
        }
        queue = queue.filter(o => o !== op);
        // its history is asked again NOW it has landed: asked while the write was on its way,
        // it came back without the new line and stayed that way ("Seen" missing, 2026-09-27)
        forgetStatus(op.touches);
        if (op.cleanup_photo && !(res && res.ok === false)) deletePhotoFile(op.cleanup_photo);
        // a page photo taken off the list: its file goes too (30)
        if (op.fn === 'set_page_photos' && res && Array.isArray(res.gone))
          res.gone.forEach(p => storage('DELETE', p, null, false, 'page-photos').catch(() => {}));
      } catch (e) {
        if (e instanceof Unreachable){ online = false; break; }
        op.state = 'failed';
        // Staff and signed-in customers see the server's own words: "The server refused it"
        // hid a missing-parameter bug on 2026-09-26. The public page never reaches here.
        op.error = e.human ? e.message : 'The server refused it: ' + e.message;
        lost = true;
        dropAfter(op.op_id);
      }
      saveLocal();
    }
    if (lost) db.cursor = null;   // our local guess was wrong somewhere: take a full fresh copy
    await pull();
  } finally {
    flushing = false;
    render();
    if (flushAgain){ flushAgain = false; flush(); }
  }
}

/* Pull what changed since the cursor. A row with unsent local changes is skipped WHOLE —
   that is what keeps work done in a dead zone safe (sync.md). */
async function pull(){
  if (!session) return;
  // 38: the field now gets the jobs with no day too — older ones changed before this phone's
  // last refresh would never arrive by "what changed since", so one full copy, once
  if (inField(db.role) && !db.nodate38){ db.cursor = null; db.nodate38 = true; }
  let res;
  try { res = await rpc('pull', {p_since: db.cursor}); }
  catch (e) {
    if (e instanceof Unreachable){ online = false; render(); return; }
    notice('Could not refresh: ' + e.message, true);
    return;
  }
  online = true; lastPullOk = new Date();
  if (db.role && res.role && db.role !== res.role){
    // The account's role changed (Users, or switched off / on). What this phone holds was
    // for the old role: a switched-off technician kept every customer's name, number and
    // address, and a customer made technician got 1 of the 4 scheduled jobs — only what
    // had changed since (scenario test, 2026-09-27). Start again from a full copy; the
    // queue stays, and the server judges it under the new role.
    db = {...emptyDb(), role: res.role};
    session.role = res.role; lsSet('ws_session', session);
    forgetStatus(); saveLocal();
    return pull();
  }
  if (inField(db.role) && res.settings && 'show_prices_tech' in res.settings && db.cursor !== null
      && !!(db.settings || {}).show_prices_tech !== !!res.settings.show_prices_tech){
    // L5: the office switched prices on or off — the jobs themselves did not change, so an
    // ordinary pull would keep them with (or without) their price
    db.settings = res.settings; db.cursor = null; saveLocal();
    return pull();
  }
  const busy = new Set(queue.flatMap(o => o.touches));
  const before = {bookings: {...db.bookings}, customers: {...db.customers}, jobs: {...db.jobs}};
  if (db.cursor === null){           // a full copy: anything not in it is gone
    for (const k of ['bookings', 'customers', 'jobs', 'team'])
      for (const id of Object.keys(db[k])) if (!busy.has(id)) delete db[k][id];
  }
  for (const k of ['bookings', 'customers', 'jobs'])
    for (const row of res[k] || []) if (!busy.has(row.id)) db[k][row.id] = row;
  for (const row of res.team || []) db.team[row.id] = row;
  for (const id of res.removed_jobs || []) if (!busy.has(id)) delete db.jobs[id];
  for (const id of res.removed_bookings || []) if (!busy.has(id)) delete db.bookings[id];
  for (const id of res.removed_customers || []) if (!busy.has(id)) delete db.customers[id];   // 22
  db.cursor = res.cursor || db.cursor;
  if (res.profile) db.profile = res.profile;   // name and the "I work here" claim
  if (res.settings){   // the shop's own settings (admin only)
    // the page photos: not while a change to them is still on its way (the appliance race, 27)
    const keep = queue.some(o => o.fn === 'set_page_photos') && db.settings ? db.settings.page_photos : undefined;
    db.settings = res.settings;
    if (keep !== undefined) db.settings.page_photos = keep;
  }
  if (res.services) db.services = res.services; // the price list, sent whole (admin only)
  // what to bring, per service, the shop's three roles (37) — not while a change is on its way
  if (res.checklists && !queue.some(o => o.fn === 'save_checklist')) db.checklists = res.checklists;
  // the appliance list, every role (27) — not while a change to it is still on its way: two
  // quick "↑ Earlier" taps moved it one place, the second read from a copy pulled in between
  if (res.types && !queue.some(o => o.fn === 'save_unit_type')){
    const changed = JSON.stringify(res.types) !== JSON.stringify(db.types || null);
    db.types = res.types;
    // the booking form is drawn apart from render(): a signed-in customer's page kept the
    // phone's old list until reloaded (measured 2026-09-28: 4 shown, 5 on the list)
    if (changed) drawPubCart();
  }
  if (db.role !== res.role){ db.role = res.role; session.role = res.role; lsSet('ws_session', session); }
  pullStats = diffStats(before, db);
  if (pullStats.bookings || pullStats.jobs || pullStats.customers || pullStats.updated || pullStats.removed) lastChangeAt = new Date();
  // something changed, or a history failed to load earlier: ask again on the next draw
  if (pullStats.bookings || pullStats.jobs || pullStats.updated || pullStats.removed) forgetStatus();
  else Object.keys(statusLive).forEach(k => { if (statusLive[k].error) delete statusLive[k]; });
  saveLocal();
  render();
  textTick();
}
/* What a pull changed on this phone, by comparing before and after — so a full fresh copy
   that brought nothing new says "nothing new", not "40 received". */
function diffStats(before, now){
  const out = {bookings: 0, customers: 0, jobs: 0, updated: 0, removed: 0};
  for (const k of ['bookings', 'customers', 'jobs']){
    for (const id of Object.keys(now[k])){
      if (!before[k][id]) out[k]++;
      else if (JSON.stringify(before[k][id]) !== JSON.stringify(now[k][id])) out.updated++;
    }
    for (const id of Object.keys(before[k])) if (!now[k][id]) out.removed++;
  }
  return out;
}

/* ================================================================ drawing
   Changing the data is not changing the screen: every write ends in render(), the one
   function that redraws the views (docs/rules/ui.md). */
const ui = lsGet('ws_ui', {tab: 'inbox', inbox: 'new', day: 'today', techDay: 'today', search: '', teamSearch: ''});
const saveUi = () => lsSet('ws_ui', ui);
ui.viewMenu = false;   // the View as menu opens closed (37)
let authOpen = false, authMode = 'signin';

const ROLE_WORD = {admin: 'Office', technician: 'Technician', helper: 'Helper', customer: 'My account', disabled: 'Switched off'};
/* 37 (Guile, 2026-10-03): a helper rides along — the technician's Jobs, less. Both work in the field. */
const inField = r => r === 'technician' || r === 'helper';
/* The admin's "View as" (37): the Jobs tab drawn as a technician or a helper sees it. A drawing
   only — the admin's phone already holds everything, and every button still acts as the admin. */
const viewRole = () => db && db.role === 'admin' && ui.tab === 'jobs' && inField(ui.viewAs) ? ui.viewAs : db && db.role;
/* The price, as that view would have it: the office always; the field only with the owner's switch on. */
const seesPrice = () => { const v = viewRole(); return v === 'admin' || (inField(v) && !!(db.settings || {}).show_prices_tech); };

function render(){
  const role = session ? (db && db.role) || session.role : null;
  const staff = role === 'admin' || inField(role);
  const profile = (db && db.profile) || {};
  // Said "I work here" and not given a role yet: a person waiting on a person, not a form.
  const waiting = role === 'customer' && profile.signup_kind === 'employee';
  const off = role === 'disabled';

  $('#who').hidden = !session;
  $('#who').textContent = session ? (profile.display_name || session.email || '') : '';
  // Signed in, the top-right button is Settings (SukiRun's ⚙); Log out lives in there.
  const acct = $('#accountBtn');
  acct.textContent = session ? '⚙️' : 'Log in';
  acct.classList.toggle('icon-btn', !!session);
  acct.setAttribute('aria-label', session ? 'Settings' : 'Log in');
  $('#topSub').textContent = authOpen ? (authMode === 'signin' ? 'Log in' : 'Make an account')
    : session ? (waiting ? 'Waiting for the office' : ROLE_WORD[role] || 'Signing in…') : 'Book an aircon job';
  $('#backBtn').hidden = !authOpen;
  $('#backLabel').textContent = 'Back';
  acct.hidden = authOpen;   // already at the door; the button would lead to itself
  const rb = $('#refreshBtn');
  rb.hidden = !session || authOpen;
  rb.classList.toggle('spin', refreshing);

  const badge = $('#syncBadge');
  const unsent = queue.filter(o => o.state === 'pending').length;
  const failed = queue.filter(o => o.state === 'failed').length;
  // Quiet when all is well: the badge shows only when something waits or failed.
  badge.hidden = !session || (!unsent && !failed && online);
  badge.className = 'sync' + (failed ? ' bad' : unsent ? ' wait' : '');
  badge.textContent = failed ? failed + ' not sent'
    : unsent ? unsent + ' waiting' + (online ? '' : ' · offline')
    : 'Offline';

  const blocked = authOpen || waiting || off;
  $('#authForm').hidden = !authOpen;
  $('#waitView').hidden = authOpen || !waiting;
  $('#offView').hidden = authOpen || !off;
  $('#notices').hidden = authOpen || off;   // a switched-off account has nothing to act on
  $('#publicView').hidden = blocked || staff;
  document.body.classList.toggle('pub', !$('#publicView').hidden);   // the wide Travelista top
  $('#adminView').hidden = blocked || role !== 'admin';
  $('#techView').hidden = blocked || !inField(role);
  $('#customerView').hidden = role !== 'customer';
  $('#registerNudge').hidden = !!session;
  $('#heroText').innerHTML = heroTextHtml('pub');   // the shared photo top's words
  drawHeroPhotos();   // and the owner's photos behind them (30)
  const nav = !blocked && role === 'admin' && !!db;
  $('#bottomNav').hidden = !nav;
  if (nav) drawNav();
  document.body.classList.toggle('has-nav', nav);
  // View as (37): the field's screen has no Book a job, and the open menu must not be covered
  $('#fab').hidden = !nav || !['inbox', 'jobs', 'people', 'checkups'].includes(ui.tab)
    || (ui.tab === 'jobs' && (ui.viewMenu || inField(viewRole())));
  $('#fab2').hidden = $('#fab').hidden;

  drawNotices();
  if (session && db && !blocked){
    if (role === 'admin') keepTyping($('#adminBody'), drawAdmin);
    if (inField(role)) keepTyping($('#techBody'), drawTech);
    if (role === 'customer') keepTyping($('#myBookings'), drawMine);
  }
  drawPanels();
  showPubBar();
  if (session && db) hydratePhotos();
  fitQuotes();
}

/* A redraw never touches a field somebody is typing into, and typed values survive
   (docs/rules/ui.md). Inputs that must survive carry data-k. */
const deferred = new Set();
function keepTyping(box, draw){
  const a = document.activeElement;
  if (a && box.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)){ deferred.add(box); return; }
  const kept = {};
  $$('[data-k]', box).forEach(el => { kept[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value; });
  const open = $$('details[data-k]', box).filter(d => d.open).map(d => d.dataset.k);
  box.innerHTML = draw();
  $$('[data-k]', box).forEach(el => {
    if (!(el.dataset.k in kept)) return;
    if (el.tagName === 'DETAILS') return;
    if (el.type === 'checkbox') el.checked = kept[el.dataset.k]; else el.value = kept[el.dataset.k];
  });
  open.forEach(k => { const d = $(`details[data-k="${CSS.escape(k)}"]`, box); if (d) d.open = true; });
}
/* The held-back redraw waits for the finger to lift. Leaving a box by tapping a button
   (type the address, tap Window) redrew the screen between press and release, so the
   release landed on a new button and the tap did nothing — the first tap after typing was
   lost (Guile, 2026-09-28). Pointer up, then its click, then the redraw. */
let pressing = false;
function flushDeferred(){
  if (!deferred.size || pressing) return;
  const a = document.activeElement;
  for (const box of [...deferred]) if (!(a && box.contains(a))){ deferred.delete(box); render(); }
}
document.addEventListener('pointerdown', () => { pressing = true; }, true);
['pointerup', 'pointercancel'].forEach(t => document.addEventListener(t, () => { pressing = false; setTimeout(flushDeferred, 0); }, true));
document.addEventListener('focusout', () => setTimeout(flushDeferred, 0));

function drawNotices(){
  const box = $('#notices');
  const failed = queue.filter(o => o.state === 'failed');
  box.innerHTML = updateCardHtml(false) + newsHtml() +
    failed.map(o => `<div class="card notice bad"><p><b>Not sent:</b> ${esc(o.label)}</p>
      <p class="meta">${esc(o.error)}</p>
      <div class="actions"><button type="button" class="b" data-act="retry" data-id="${esc(o.op_id)}">Try again</button>
      <button type="button" class="b danger" data-act="discard" data-id="${esc(o.op_id)}">Throw it away</button></div></div>`).join('') +
    notices.map(n => `<div class="card notice ${n.bad ? 'bad' : ''}"><p>${esc(n.text)}</p>
      <div class="actions"><button type="button" class="b" data-act="dismiss" data-id="${esc(n.id)}">OK</button></div></div>`).join('');
}

/* ================================================================ refresh: the ↻ button and the swipe
   SukiRun's lesson (2026-09-22): a refresh always SAYS what it did. The old Refresh now was
   silent, so "did my Done go through?" had no answer short of Take the office's copy — the
   one button that throws unsent work away. */
let refreshing = false, toastTimer = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const count = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
function toast(text, bad){
  const el = $('#toast');
  el.textContent = text; el.className = 'toast' + (bad ? ' bad' : ''); el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 5000 : 3200);
}
async function refreshNow(){
  if (!session){ toast('Log in to reach the office.'); return; }
  if (navigator.onLine === false){
    online = false; render();
    toast('No internet — everything here is saved and goes by itself when there is signal.', true);
    return;
  }
  if (refreshing) return;
  refreshing = true; render();
  const started = Date.now();
  try {
    // A refresh landing on a sync already running must wait for it and then ask again —
    // walking away and saying "up to date" was SukiRun's BUG 7.
    for (let i = 0; flushing && i < 150; i++) await sleep(100);
    const pending = () => queue.filter(o => o.state === 'pending').length;
    const failed = () => queue.filter(o => o.state === 'failed').length;
    const waited = pending(), failedBefore = failed();
    // An open Full status is read from the server, so it is asked again too.
    forgetStatus();   // every "what has happened" on screen is asked again
    pullStats = null;
    await flush();
    const nowFailed = failed() - failedBefore, sent = Math.max(0, waited - pending() - nowFailed);
    if (!pullStats){
      toast(online ? 'Could not refresh — the card on screen says why.'
                   : 'No internet — everything here is saved and goes by itself when there is signal.', true);
      return;
    }
    const s = pullStats, bits = [];
    if (sent) bits.push(count(sent, 'change') + ' sent');
    if (nowFailed) bits.push(count(nowFailed, 'change') + ' not sent — see the red card');
    if (s.bookings) bits.push(count(s.bookings, 'new booking'));
    if (s.jobs) bits.push(count(s.jobs, 'new job'));
    if (s.customers) bits.push(count(s.customers, 'new customer'));
    if (s.updated) bits.push(s.updated + ' updated');
    if (s.removed) bits.push(s.removed + ' removed');
    // R5: the sync every 30 s had often just brought the change ↻ was pressed for, and
    // "Nothing new" then read as "your change did not arrive" (2026-09-27)
    const recent = lastChangeAt && Date.now() - lastChangeAt < 15 * 60000;
    toast(bits.length ? bits.join(' · ')
      : recent ? 'Up to date — the last change came in ' + timeAgo(lastChangeAt.toISOString())
      : 'Nothing new — everything here is up to date', !!nowFailed);
  } finally {
    // A refresh that answers in 80 ms would blink the spinner away unseen.
    await sleep(Math.max(0, 600 - (Date.now() - started)));
    refreshing = false; render();
  }
  if (updateCapable) checkForUpdate();
}

/* The swipe: at the top of a list, pull down and let go. Touch only — a computer has ↻. */
const PULL_GO = 70, PULL_MAX = 110;
let pullG = null;
function pullScroller(){
  if (!session || authOpen || !$('#unitSheet').hidden || !$('#cartSheet').hidden || !$('#mapSheet').hidden) return null;
  if (!stack.length) return document.scrollingElement || document.documentElement;
  const top = $('#panels').lastElementChild;
  return top && top.classList.contains('sheet') && !top.classList.contains('small') ? top : null;
}
function pullDraw(d){
  const r = $('#pullRing');
  r.classList.remove('settle');
  r.style.transform = `translate(-50%, ${Math.min(d, PULL_MAX)}px)`;
  r.style.opacity = String(Math.min(1, d / 36));
  r.classList.toggle('ready', d >= PULL_GO);
  $('span', r).style.transform = `rotate(${Math.round(d * 4)}deg)`;   // one turn by the time it is ready
}
function pullHide(){
  const r = $('#pullRing');
  r.classList.add('settle'); r.classList.remove('ready', 'busy');
  r.style.transform = 'translate(-50%, 0)'; r.style.opacity = '0';
}
document.addEventListener('touchstart', e => {
  if (e.touches.length !== 1 || refreshing) return;
  const sc = pullScroller();
  if (!sc || (sc.scrollTop || 0) > 2) return;
  pullG = {y0: e.touches[0].clientY, sc, d: 0};
}, {passive: true});
document.addEventListener('touchmove', e => {
  if (!pullG || e.touches.length !== 1) return;
  const dy = e.touches[0].clientY - pullG.y0;
  if (dy <= 0 || (pullG.sc.scrollTop || 0) > 2){ pullG = null; pullHide(); return; }
  if (e.cancelable) e.preventDefault();
  pullG.d = dy * 0.5;   // rubber band: the finger travels twice as far as the ring
  pullDraw(pullG.d);
}, {passive: false});
document.addEventListener('touchend', async () => {
  if (!pullG) return;
  const go = pullG.d >= PULL_GO;
  pullG = null;
  if (!go){ pullHide(); return; }
  const r = $('#pullRing');
  $('span', r).style.transform = '';   // the spin animation takes over
  r.classList.add('settle', 'busy'); r.classList.remove('ready');
  r.style.transform = `translate(-50%, ${PULL_GO}px)`; r.style.opacity = '1';
  try { await refreshNow(); } finally { pullHide(); }
}, {passive: true});
document.addEventListener('touchcancel', () => { pullG = null; pullHide(); }, {passive: true});

/* ================================================================ version, updates, What's new
   SukiRun's way: version.json + CHANGELOG.md are baked into version.js by
   tools/build_version.py, so the APK, About and the update check read one number. Only the
   APK can install an update; a browser already has the newest page, so there the update
   card is simply absent. */
const BUILD = {versionName: 'dev', versionCode: 0, releasedAt: '', notes: [], updateUrl: '', ...(window.WS_BUILD || {})};
const inApk = !!(window.AndroidBridge && window.AndroidBridge.fetchText);
const updateCapable = inApk && !!BUILD.updateUrl;
/* "**bold**" in the change log, and nothing else. */
const mdLite = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

/* Promises over the Android bridge: Java answers settle()/progress() with the call's id. */
window.wsNet = (function(){
  const pending = new Map(); let seq = 0;
  return {
    settle(id, ok, payload){
      const p = pending.get(id); if (!p) return;
      pending.delete(id);
      if (ok) p.resolve(payload); else p.reject(new Error(payload || 'that did not work'));
    },
    progress(id, done, total){ const p = pending.get(id); if (p && p.onProgress) p.onProgress(done, total); },
    installFailed(){ toast('This phone has no app that can install updates.', true); },
    call(fn, args, onProgress){
      return new Promise((resolve, reject) => {
        const id = 'n' + (++seq);
        pending.set(id, {resolve, reject, onProgress});
        try { window.AndroidBridge[fn](...args, id); } catch (e){ pending.delete(id); reject(e); return; }
        // a dropped connection can leave Java silent; never leave a button spinning for ever
        setTimeout(() => { if (pending.delete(id)) reject(new Error('this is taking too long — check the signal')); }, 6 * 60 * 1000);
      });
    }
  };
})();

let upd = {phase: 'idle', found: null, error: '', pct: 0, file: ''};
let laterThisRun = null;   // Later lasts until the app is next opened, no longer (SukiRun 0.17.1)
function setUpd(patch){ upd = {...upd, ...patch}; render(); }
const isNewer = info => !!info && Number(info.versionCode) > Number(BUILD.versionCode);

async function checkForUpdate(){
  if (!updateCapable || upd.phase === 'checking' || upd.phase === 'downloading') return null;
  setUpd({phase: 'checking', error: ''});
  const store = lsGet('ws_update', {});
  try {
    const info = JSON.parse(await wsNet.call('fetchText', [BUILD.updateUrl]));
    store.lastCheck = Date.now();
    if (!isNewer(info)){ store.found = null; lsSet('ws_update', store); setUpd({phase: 'idle', found: null}); return null; }
    const found = {
      versionCode: Number(info.versionCode), versionName: String(info.versionName || info.versionCode),
      notes: Array.isArray(info.notes) ? info.notes.slice(0, 20).map(String) : [],
      apkUrl: String(info.apkUrl || ''), sha256: String(info.sha256 || ''), size: Number(info.size) || 0,
    };
    // no https link or no checksum means it cannot be installed safely, so it is not offered
    if (!/^https:\/\//.test(found.apkUrl) || !/^[0-9a-f]{64}$/i.test(found.sha256))
      throw new Error('that release is missing its download — tell whoever looks after the app');
    store.found = found; lsSet('ws_update', store);
    setUpd({phase: 'ready', found, error: '', pct: 0, file: ''});
    return found;
  } catch (e){
    setUpd({phase: upd.found ? 'ready' : 'idle', error: (e && e.message) || 'could not check'});
    return null;
  }
}
async function downloadUpdate(){
  const f = upd.found; if (!f) return;
  setUpd({phase: 'downloading', pct: 0, error: ''});
  try {
    const name = ('WinterAir-' + f.versionName + '.apk').replace(/[^A-Za-z0-9._-]/g, '');
    const file = await wsNet.call('downloadUpdate', [f.apkUrl, f.sha256, name],
      (done, total) => { const pct = total > 0 ? Math.min(100, Math.round(done * 100 / total)) : 0; if (pct !== upd.pct) setUpd({pct}); });
    setUpd({phase: 'downloaded', pct: 100, file});
    installUpdate();
  } catch (e){ setUpd({phase: 'ready', pct: 0, error: (e && e.message) || 'the download did not finish'}); }
}
function installUpdate(){
  if (!upd.file) return;
  const r = window.AndroidBridge.installUpdate(upd.file);
  if (r === 'permission') setUpd({error: 'Android asks first: switch on “Allow from this source”, come back and press Install again.'});
  else if (r === 'missing') setUpd({phase: 'ready', file: '', pct: 0, error: 'The download is gone — please download it again.'});
  else setUpd({error: ''});
}
function updateOnLaunch(){
  if (!updateCapable) return;
  const store = lsGet('ws_update', {});
  if (isNewer(store.found)) upd = {...upd, phase: 'ready', found: store.found};
  else if (store.found){ store.found = null; lsSet('ws_update', store); }   // already installed
  setTimeout(checkForUpdate, 4000);
}
/* On the home screen only when there is something to install and nobody pressed Later;
   in Settings → About always, with Check for updates. */
function updateCardHtml(inSettings){
  if (!updateCapable) return '';
  const s = upd, f = s.found, busy = s.phase === 'downloading' || s.phase === 'downloaded';
  if (!inSettings && (!f || (!busy && laterThisRun === f.versionCode))) return '';
  let h = '';
  if (s.phase === 'downloading'){
    h = `<div class="update-title">Downloading Winter Air ${esc(f.versionName)}</div>
      <div class="update-bar"><span style="width:${s.pct}%"></span></div>
      <div class="update-note">${s.pct}% — bookings and jobs on this phone are not touched.</div>`;
  } else if (f){
    const label = s.phase === 'downloaded' ? 'Install now' : s.error ? 'Try again' : '⬇️ Download & install';
    h = `<div class="update-title">✨ Winter Air ${esc(f.versionName)} is available</div>
      ${f.notes.length ? `<ul class="notes-list">${f.notes.map(n => `<li>${mdLite(n)}</li>`).join('')}</ul>` : ''}
      <div class="actions"><button type="button" class="b primary" data-act="updget">${label}</button>
        ${inSettings ? '' : '<button type="button" class="b" data-act="updlater">Later</button>'}</div>
      <div class="update-note">${esc([f.size ? (f.size / 1048576).toFixed(1) + ' MB' : '', 'Everything on this phone is kept.'].filter(Boolean).join(' · '))}</div>`;
  } else {
    h = `<div class="st-loc">You have the newest version.</div>
      <div class="actions"><button type="button" class="b" data-act="updcheck"${s.phase === 'checking' ? ' disabled' : ''}>${s.phase === 'checking' ? 'Checking…' : '↻ Check for updates'}</button></div>`;
  }
  if (s.error) h += `<div class="update-note bad">${esc(s.error)}</div>`;
  return inSettings ? h : `<div class="card update">${h}</div>`;
}
/* One line after an update: "What's new in 0.1.1". Tapping it opens the change log right
   there, like Suki's (Guile, 2026-09-27: "a dropdown, not the About section"); Got it or ×
   and it is gone for this version. A brand-new install has nothing new, so it only records
   the number. Settings → About still lists the same notes. */
let newsOpen = false;
function newsHtml(){
  if (!session || !BUILD.versionCode || !BUILD.notes.length) return '';
  const seen = lsGet('ws_seen_build', null);
  if (seen === BUILD.versionCode) return '';
  if (seen === null){ lsSet('ws_seen_build', BUILD.versionCode); return ''; }
  return `<div class="card news${newsOpen ? ' open' : ''}">
    <div class="news-head">
      <button type="button" class="news-open" data-act="news" aria-expanded="${newsOpen}">
        <span class="news-chev" aria-hidden="true">▶</span> ✨ What’s new in Winter Air ${esc(BUILD.versionName)}</button>
      <button type="button" class="news-x" data-act="newsseen" aria-label="Close">×</button>
    </div>
    ${newsOpen ? `<div class="news-body">
      ${BUILD.releasedAt ? `<div class="news-date">${esc(BUILD.releasedAt)}</div>` : ''}
      <ul class="notes-list">${BUILD.notes.map(n => `<li>${mdLite(n)}</li>`).join('')}</ul>
      <div class="actions"><button type="button" class="b" data-act="newsseen">Got it</button></div>
    </div>` : ''}
  </div>`;
}
function aboutHtml(){
  return `<div class="sec" id="aboutSec">About</div>
    <div class="card">
      <div class="st-loc"><b>Winter Air Services</b> · version ${esc(BUILD.versionName)}${BUILD.releasedAt ? ' · ' + esc(BUILD.releasedAt) : ''}</div>
      <p class="hint">Works with no signal. Bookings and jobs are saved on this phone first and go to the office by themselves as soon as there is signal.</p>
      ${BUILD.notes.length ? `<div class="st-label">What’s new in ${esc(BUILD.versionName)}</div>
        <ul class="notes-list">${BUILD.notes.map(n => `<li>${mdLite(n)}</li>`).join('')}</ul>` : ''}
      ${updateCapable ? `<div class="st-label">Updates</div>${updateCardHtml(true)}`
        : inApk ? '' : '<p class="hint">In a browser the page is always the newest — no update needed.</p>'}
    </div>`;
}

/* ---------------------------------------------------------------- the office and the technicians
   SukiRun's shape (D:\Order Run\app_template.html), decided 2026-09-26 (docs/scope.md):
   compact rows; a tap opens a screen ON TOP with Back. Never a dropdown that unrolls a whole
   form inside the list, never a giant button. Phone first — this becomes an Android app. */

/* The owner's price list (12): one price per service per aircon type. Admins only — a
   technician and a customer never receive a price. */
/* The aircons and other appliances (27): the owner's list, not the code's. Staff get every
   one from pull (removed ones too, so an old job still shows its name); the page gets the
   shown ones from list_services. The first four until either has arrived. The key never
   changes (it is what bookings, jobs and prices store); the label is what people see. */
const BUILTIN_TYPES = [{key: 'Window', label: 'Window', icon: 'ac-window'}, {key: 'Split', label: 'Split', icon: 'ac-split'},
  {key: 'Floor-mounted', label: 'Floor-mounted', icon: 'ac-floor'}, {key: 'Cassette', label: 'Cassette', icon: 'ac-cassette'}];
// the pictures the owner can pick from (A3 adds his own PNG)
// chiller = the glass-door drinks chiller the owner meant (2026-09-28); the big outdoor unit
// that was drawn first stays as industrial-chiller
const TYPE_ICONS = ['ac-window', 'ac-split', 'ac-floor', 'ac-cassette', 'chiller', 'freezer', 'washing-machine', 'car-aircon',
  'industrial-chiller', 'fcu', 'solar', 'ducting', 'tire-inflator',   // the owner's 2026-09-30 additions
  'exhaust-fan', 'water-dispenser', 'cold-room', 'ice-machine'];      // drawn ahead, before he adds them
let pubTypes = lsGet('ws_types', null);
const typeRows = () => db && db.types && db.types.length ? db.types : pubTypes && pubTypes.length ? pubTypes : BUILTIN_TYPES;
const activeTypes = () => typeRows().filter(t => t.active !== false);
const typeOf = k => typeRows().find(t => t.key === k) || null;
const typeLabel = k => { const t = typeOf(k); return t ? t.label : (k || 'Aircon'); };
const typeOffers = (type, k) => { const t = typeOf(type); return !t || !Array.isArray(t.services) || t.services.includes(k); };
const typePic = k => { const i = (typeOf(k) || {}).icon || 'ac-split'; return i.startsWith('data:') ? i : 'icons/' + i + '.png'; };
const svcRows = () => (db && db.services) || [];
const svcLabel = k => { const r = svcRows().find(x => x.key === k); return r ? r.label : (serviceLabels[k] || k); };
const activeServiceKeys = () => svcRows().length ? svcRows().filter(x => x.active).map(x => x.key) : Object.keys(serviceLabels);
function priceFor(services, type, count){
  if (!type || !services || !services.length) return null;
  let sum = 0;
  for (const k of new Set(services)){
    const r = svcRows().find(x => x.key === k), p = r && r.prices ? r.prices[type] : null;
    if (p == null) return null;
    sum += Number(p);
  }
  return Math.round(sum * (Number(count) || 1) * 100) / 100;
}
const priceWords = (services, type, count) => {
  const p = priceFor(services, type, count);
  return p != null ? peso(p) : !type ? 'Needs the aircon type' : 'A service has no ' + type + ' price yet';
};
const peso0 = n => (Number(n) < 0 ? '−' : '') + '₱' + Math.abs(Number(n)).toLocaleString('en-PH', {maximumFractionDigits: 2});
const svcList = arr => (arr || []).map(svcLabel).join(', ');
const unsentFor = id => queue.some(o => o.touches.includes(id));
const unsentPill = id => unsentFor(id) ? ' <span class="pill unsent">not sent</span>' : '';
const custOf = id => db.customers[id];
const jobCust = j => j.customer || custOf(j.customer_id) || {};
const jobsOf = cid => Object.values(db.jobs).filter(j => j.customer_id === cid);
const personName = uid => { const t = db.team[uid]; return t ? (t.display_name || (t.email || '').split('@')[0]) : null; };
/* No assignment: a job is the shop's. What is kept is who pressed the last status. */
const whoPressed = j => !j.status_by ? null : j.status_by === session.uid ? 'you'
  : (j.status_by_name || personName(j.status_by) || 'someone');
const shortDate = ymd => ymd ? new Date(ymd + 'T00:00:00').toLocaleDateString('en-PH', {day: 'numeric', month: 'short'}) : '';
// −₱1,600.00, never ₱-1,600.00 (the receipt's adjustment, scenario test 2026-09-27)
const peso = n => (Number(n) < 0 ? '−' : '') + '₱' + Math.abs(Number(n)).toLocaleString('en-PH', {minimumFractionDigits: 2, maximumFractionDigits: 2});
const aircon = x => [x.unit_type ? x.unit_type + (x.unit_count > 1 ? ' × ' + x.unit_count : '') : '',
                     x.unit_brand, x.unit_model].filter(Boolean).join(' · ');
/* − 1 + : how many aircons, 1 to 20 (14). */
const countStepper = n => `<div class="stepper count">
    <button type="button" class="b" data-act="pcount" data-v="-1" aria-label="One less" ${n <= 1 ? 'disabled' : ''}>−</button>
    <b>${n}</b>
    <button type="button" class="b" data-act="pcount" data-v="1" aria-label="One more" ${n >= 20 ? 'disabled' : ''}>+</button></div>`;
const place = c => [c.address, c.landmark].filter(Boolean).join(' — ');
const initials = s => String(s || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
const pill = (cls, text) => `<span class="pill ${esc(cls)}">${esc(text)}</span>`;
const statusPill = s => pill(s, STATUS_LABEL[s] || s);
const ROLE_NAME = {admin: 'Admin', technician: 'Technician', helper: 'Helper', customer: 'Customer', disabled: 'Switched off'};
const rolePill = r => pill('role-' + r, ROLE_NAME[r] || r);
/* A label and a value, one line each. Empty values draw nothing. */
const kv = (k, v) => v ? `<div class="kv"><span>${esc(k)}</span><div>${v}</div></div>` : '';
const empty = t => `<div class="empty-state">${esc(t)}</div>`;
/* SukiRun's tab strip: small pills with a count, the chosen one filled in. */
const chips = (act, items, current) => `<div class="tabbar">${items.map(([k, t, n]) =>
  `<button type="button" class="tab-btn${current === k ? ' active' : ''}" data-act="${act}" data-v="${esc(k)}">${esc(t)}${n ? ' (' + n + ')' : ''}</button>`).join('')}</div>`;
/* ✏️ Edit — one button, the same on the booking and the job: opens the customer's whole
   booking form on the customer's photo (ui.md, Reuse). */
const editBtn = (kind, id) => `<button type="button" class="b edit-btn" data-act="open" data-kind="${kind}" data-id="${esc(id)}">✏️ Edit</button>`;
function callBtn(n){ return digits(n).length >= 7 ? `<a class="b" href="tel:${esc(digits(n))}">📞 Call</a>` : ''; }
function mapBtn(c){
  if (!c || !(c.address || c.lat != null) || c.address === '(removed)') return '';
  const pinned = c.lat != null && c.lng != null;
  const q = pinned ? c.lat + ',' + c.lng : [c.address, c.landmark, 'Bacolod'].filter(Boolean).join(', ');
  const href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q);
  if (pinned) return `<a class="b" target="_blank" rel="noopener" href="${href}">🗺️ Map</a>`;
  // No pin: say so first (Guile, 2026-09-27) — a search for the address stops at the street
  return `<button type="button" class="b" data-act="nopin" data-href="${esc(href)}" data-landmark="${esc(c.landmark || '')}">🗺️ Map</button>`;
}
function showNoPin(href, landmark){
  $('#infoTitle').textContent = 'No pin on the map';
  $('#infoText').textContent = 'The customer did not pin a map. Map can only search the address, so it may stop at the street, not the house.'
    + (landmark ? '\n\nLandmark: ' + landmark : '\n\nThere is no landmark either — ring them to ask.');
  const a = $('#infoLink'); a.href = href; a.textContent = 'Search the address'; a.hidden = false;
  $('#infoBox').hidden = false;
  $('#infoOk').focus();
}
function menuRow(kind, id, icon, title, sub, cls){
  return `<button type="button" class="menu-row ${cls || ''}" data-act="open" data-kind="${kind}" data-id="${esc(id || '')}">
    <span class="menu-ico">${icon}</span><span class="menu-main"><span class="menu-title">${esc(title)}</span>${sub ? `<span class="menu-sub">${esc(sub)}</span>` : ''}</span><span class="menu-chev">›</span></button>`;
}

/* Calendar days as plain YYYY-MM-DD in UTC arithmetic — local midnight slips a day in
   Bacolod (UTC+8), measured 2026-09-26. */
const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function addMonths(ymd, n){
  const d = new Date(ymd + 'T00:00:00Z'), day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}
function daysAgo(ymd){
  const n = Math.round((new Date(manilaDate(0) + 'T00:00:00Z') - new Date(ymd + 'T00:00:00Z')) / 864e5);
  return n < 1 ? 'today' : n < 45 ? n + ' day' + (n === 1 ? '' : 's') + ' ago' : Math.round(n / 30.4) + ' months ago';
}
const timeAgo = iso => {
  if (!iso) return 'never';
  const m = (Date.now() - new Date(iso)) / 60000;
  return m < 2 ? 'just now' : m < 60 ? Math.round(m) + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago'
    : m < 2880 ? 'yesterday' : new Date(iso).toLocaleDateString('en-PH', {day: 'numeric', month: 'short'});
};
const byTime = (a, b) => ((a.scheduled_on || '9999') + slotKey(a.slot)).localeCompare((b.scheduled_on || '9999') + slotKey(b.slot));
const byDoneDesc = (a, b) => (a.done_at || '') < (b.done_at || '') ? 1 : -1;

/* ---------------------------------------------------------------- ⓘ: the explanations
   Decided 2026-09-26: explanations do not sit on the screen taking room. A small ⓘ opens
   them in a little box with OK — not a whole screen. */
const INFO = {
  inbox: ['Inbox', 'Bookings customers made on the page. Accept one to make them a customer, then make the job. A call you take yourself goes through “+ Book a job” instead.'],
  jobs: ['Jobs', 'The schedule. Every technician sees every job that has a day — there is no assigning. The job remembers who pressed Start and Done.'],
  people: ['Customers', 'Everyone the shop has worked for. Tap one for their history, or to book them again.'],
  checkups: ['Check-ups', 'Customers whose regular check has come — set on each customer: Customers → tap them → 📅 Regular check (every month, 2, 3, 6 months or yearly, from a date you choose). Ring them, or Book it. ✓ Done moves them to their next date. Nobody with a job already booked shows here. At the top: jobs done a week ago, to ask “is it working well?”.'],
  team: ['Users', 'Anyone can make an account, and starts as a customer. Tap a person to make them a technician, a helper or an admin. “Says they work here” means they ticked that box when they signed up — it gives them nothing on its own.'],
  admin: ['Admin', 'Only admins see this tab. The price list and the services the booking page offers, the receipt, and the three numbers the app was built to answer.'],
  showprices: ['Show prices', 'Off: customers never see a price; you tell them on the call.\n\nOn: once a customer picks the aircon type and the services, the booking page shows the total from this list. If a service has no price for their aircon type, it says you will tell them on the call.'],
  service: ['A service', 'A price for each aircon type. Leave a type empty if the shop does not do it for that type — a booking with that type then shows no price until you set one. Customers never see prices.'],
  editbooking: ['After the call', 'Change what they need and which aircon they have. The price shows as soon as every service has a price for that aircon type. It is frozen onto the job when you make it.'],
  types: ['Aircon & Other Appliances', 'What a customer taps on the booking page — Window, Split, a chiller, a freezer… — in this order. Add one with its name, the services it offers (a freezer is not “installed” like a split) and a picture — one of ours, or ＋ Your own PNG; its prices go in Services & prices. A new service starts on every appliance — untick it where it does not belong.\n\nRemove takes it off the booking page only. Jobs that already have it keep it, and so do its prices; Bring it back puts it all back. Renaming changes the name everywhere, old jobs too.'],
  pagephotos: ['Page photos', 'The photos at the top of the booking page — the first thing a customer sees. Add up to six; with two or more the page fades from one to the next every 6 seconds, on its own. With none, the page shows its own photo.\n\nAnyone who opens the page can see these photos: never a customer’s house, a face or a plate number without their say-so. The phone makes each photo smaller before sending, so the page stays quick on mobile data. Remove deletes the photo for good.'],
  quote: ['Quotation', 'The shop’s own quotation, made from this booking: the lines start as the customer’s aircons at the price list’s prices, and every word, Qty and price is yours to change. The page on top is exactly the paper.\n\nSave keeps it on the booking. Send as PDF: in the app, the quotation goes as a PDF file straight to Messenger, Viber, email, Bluetooth or Drive — pick one. Print or save as PDF: the print screen, for paper.\n\nSigned by the customer on the Conforme line, it is your agreement. Accept, left blank, takes its TOTAL as the job’s price.'],
  quoteshop: ['Letterhead and signer', 'The lines at the top of every quotation, and the name under the signature. Blank lines are left out. Kept on the server for admins only, not in the public page.'],
  quotenote: ['The usual note', 'Every new quotation starts with this Note; change it on one quotation without changing it here. Each line is one ➢ point. A line that starts with a space is indented under the one above, like a price that belongs to it.'],
  quotesig: ['Signature', 'A photo of the signature on white paper: the white is taken out and the ink kept. It prints on every quotation.\n\nIt is kept on the server for admins only — never on the public page, never on a technician’s phone. Remove it and the quotation leaves the space to sign by hand.'],
  receipt: ['Receipt','A sample layout for now — say what to change. Amounts come from the price list; if the job’s price was changed by hand, the difference shows as an adjustment.'],
  tech: ['Jobs', 'Every job on the schedule. Anyone can take it — the job remembers who pressed Start and Done. Ring the office to change a day or cancel.'],
  schedule: ['Schedule', 'Every technician sees the job as soon as it has a day.'],
  book: ['Book a job', 'For a call you took yourself. It goes to the Inbox first, marked “By phone”: look it over, make the quotation, then Accept — as for a booking from the page.\n\nThe Numbers count the page’s bookings only, so these are left out of them.'],
  cancel: ['Cancel', 'Every technician stops seeing it as work. Undo on the job puts it back.'],
  roles: ['What they can do', 'Technician — sees every job on the schedule, marks jobs started and done.\n\nAdmin — everything: bookings, jobs, customers, team and settings.\n\nCustomer — books on the page and sees their own bookings. Nothing else.'],
  smssender: ['This phone sends the texts', 'Texts to customers go from this phone, on its own SIM and load — turn it on on the owner\'s phone only, or customers get the same text twice. Android asks once to allow it. What it sends, and when, is Admin → Texts.'],
  chksms: ['Texts allowed', 'Lets Winter Air send texts from this phone\'s SIM.\n\n1. Tap Allow beside this line.\n2. Android asks "Allow Winter Air to send and view SMS messages?" — tap Allow.\n\nPressed "Don\'t allow" twice? Android stops asking. Then:\n1. Tap Open settings.\n2. Permissions → SMS → Allow.\n3. If it says "Restricted setting": tap ⋮ at the top right → Allow restricted settings, then do step 2 again.'],
  chkbatterymi: ['Battery: No restrictions', 'Battery saving can stop the reminders from going on time.\n\n1. Tap Open settings beside this line — Winter Air\'s own settings open.\n2. Tap Battery saver.\n3. Choose No restrictions.\n4. Come back to Winter Air — the line turns ✔️.\n\nOr: Settings → Apps → Manage apps → Winter Air → Battery saver → No restrictions.'],
  chkbattery: ['Battery: No restrictions', 'Battery saving can stop the reminders from going on time.\n\n1. Tap Allow beside this line.\n2. Android asks to let the app always run in the background — tap Allow.\n3. Come back to Winter Air — the line turns ✔️.\n\nOr: Settings → Apps → Winter Air → Battery → Unrestricted.'],
  chkautostart: ['Background autostart', 'On a Xiaomi, Redmi or Poco phone, an app that is closed is not woken for its reminders unless Autostart is on (measured 2026-10-02: off, the reminder never went).\n\n1. Tap Open Autostart beside this line.\n2. Find Winter Air in the list (search "winter").\n3. Turn it on.\n4. Come back to Winter Air — the line turns ✔️.\n\nOr: Settings → Apps → Manage apps → Background autostart → search "winter" → turn it on.'],
  chksim: ['Sends from', 'Which SIM the texts go from, and so which number customers see and whose load pays.\n\nTap the SIM to use. "The phone\'s default" is the SIM Android uses for texts (Settings → SIM cards & mobile networks → Default for SMS).\n\nIf the line is ❌, the phone is set to "Ask every time": choose a SIM here.'],
  texter: ['Sends texts to customers', 'On: this person sees Texts to customers in Settings, 💬 Text on a job and Text all of Tomorrow, and their phone may be the sending phone. Off: none of it — and if their phone was the sending phone, it stops at its next refresh. Any admin can change it, for themselves too.'],
  textauto: ['Send texts by themselves', 'The phone with "This phone sends the texts" on sends them, at your times, even with the app closed — never the same text twice. A job is texted from the time this is turned on; jobs scheduled before then are not.\n\nThe reminders are written each time the app is open on that phone: a job cancelled on another phone after that can still get one. Open the app once in the evening and it is up to date.\n\nOff: nothing is sent unless you press 💬 Text on a job.'],
  slotcap: ['Most jobs a morning or afternoon', 'Counts the jobs on that day and time, and the bookings still waiting for it. When it is full, the booking page tells the customer to choose the afternoon or another day. — means no limit. Book a job (a call you take) is never refused.'],
  showpricestech: ['Show prices to technicians & helpers', 'On: a technician sees each job’s price, big, so they know what to collect — and can print or share the receipt. A helper sees the price on the job, nothing more.\n\nOff: technicians and helpers never see a price; the server does not even send it.'],
  closedwd: ['Closed every week', 'Tap the weekdays the shop never works. The booking page greys them out and will not take a booking for one. Book a job (a call you take) only warns you.'],
  closeddates: ['Days off', 'A holiday, a fiesta, a day off: tap the day in the calendar. Type a reason first if you want the customer to see it ("Christmas"). Past days drop off by themselves.'],
  shopfb: ['Facebook page', 'With a link here, the booking page shows “Message us on Facebook” beside the call button. Leave it empty to hide it.'],
  shopgcash: ['GCash', 'The receipt shows the number and the name, so the customer can pay on the spot. With a picture named gcash-qr.png in web/img, the receipt shows the QR code too.'],
  gap: ['Check-up gap', 'Counted from a customer’s last finished job. Every admin phone uses the same number.'],
  reset: ['Take the office’s copy', 'Throws away everything on this phone that has not been sent, and takes the office’s copy again. Nothing else ever overwrites what you did here.'],
};
const infoBtn = k => `<button type="button" class="info-btn" data-act="info" data-v="${k}" aria-label="What is this?">i</button>`;
function showInfo(k){
  const it = INFO[k]; if (!it) return;
  $('#infoTitle').textContent = it[0];
  $('#infoText').textContent = typeof it[1] === 'function' ? it[1]() : it[1];
  $('#infoLink').hidden = true;
  $('#infoBox').hidden = false;
  $('#infoOk').focus();
}
const hideInfo = () => { $('#infoBox').hidden = true; };

/* ---------------------------------------------------------------- the aircons: a cart (15)
   Decided 2026-09-27 (docs/scope.md), Suki's Store Visit: tap an aircon type, a small window
   asks what that aircon needs, and it joins a list — "Window #1 — Repair, Installation".
   The SAME cart on the public page and in the office's Book a job and Edit: one set of
   functions, two places the list lives — 'pub' on the page, 'panel' on the open screen. */
let pubUnits = [];
/* What the booking page may know about the shop (21): the weekdays and dates it is closed, and
   its Facebook link. From list_services(), kept for the next time with no signal. */
let pubShop = lsGet('ws_shop', null) || {closed_days: [], closed_dates: [], facebook_url: ''};
const PAY = {cash: 'cash', gcash: 'GCash', other: 'other'};
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/* Idea 4: is the shop closed that day? The office reads its own settings; the page, pubShop. */
function closedOn(ymd){
  if (!ymd) return null;
  const src = db && db.role === 'admin' && db.settings
    ? {closed_days: db.settings.closed_days || [], closed_dates: db.settings.closed_dates || []} : pubShop;
  const d = (src.closed_dates || []).find(x => x.on === ymd);
  if (d) return {why: d.why || '', date: true};
  const dow = new Date(ymd + 'T00:00:00Z').getUTCDay();
  return (src.closed_days || []).includes(dow) ? {why: 'closed on ' + WEEKDAYS[dow] + 's', date: false} : null;
}
const closedWords = (ymd, c) => 'We are closed on ' + niceDate(ymd) + (c.why ? ' — ' + c.why : '') + '. Please choose another day.';
let unitEd = null;   // the aircon being added or changed: {cart, index, unit}
const ico = (name, cls) => `<img class="ico${cls ? ' ' + cls : ''}" src="icons/${name}.png" alt="" aria-hidden="true">`;
/* A row made before the list existed still has one: n copies of its one aircon. */
function unitsOf(x){
  if (x && Array.isArray(x.units) && x.units.length) return x.units;
  if (!x || !(x.services || []).length) return [];
  const out = [];
  for (let i = 0; i < Math.max(1, x.unit_count || 1); i++)
    out.push({type: x.unit_type && x.unit_type !== 'Mixed' ? x.unit_type : null, services: [...x.services],
              brand: x.unit_brand || null, model: x.unit_model || null});
  return out;
}
/* One aircon, copied whole: what it is, what it needs, what is known about it — since 37
   (Guile, 2026-10-03) its serial number and its problem too. Every place that copies one uses
   this, so a new field is added once. */
const unitCopy = u => ({type: u.type, services: u.services.map(String), brand: u.brand || null, model: u.model || null,
                        serial: u.serial || null, problem: u.problem || null});
/* "Window #1", "Window #2", "Split #1". */
function unitNames(units){
  const seen = {};
  return units.map(u => { const t = typeLabel(u.type); seen[t] = (seen[t] || 0) + 1; return t + ' #' + seen[t]; });
}
const unitsLine = units => {
  const n = {};
  units.forEach(u => { const t = typeLabel(u.type); n[t] = (n[t] || 0) + 1; });
  return Object.entries(n).map(([t, k]) => t + (k > 1 ? ' ×' + k : '')).join(' · ');
};
const unionServices = units => [...new Set(units.flatMap(u => u.services))];
/* A price lookup, (service, type) → number or null. The page has one only while the owner
   shows prices; the office always has its list; a technician has none. */
const officePrice = (k, t) => { const r = svcRows().find(x => x.key === k); return r && r.prices && r.prices[t] != null ? Number(r.prices[t]) : null; };
const pagePrice = () => Object.values(pubPrices).some(Boolean)
  ? (k, t) => (pubPrices[k] && pubPrices[k][t] != null ? Number(pubPrices[k][t]) : null) : null;
function unitPrice(u, pf){
  if (!pf || !u.type) return null;
  let sum = 0;
  for (const k of u.services){ const p = pf(k, u.type); if (p == null) return null; sum += p; }
  return sum;
}
/* A half-known total is never shown as if it were the total. */
function unitsPrice(units, pf){
  if (!pf || !units.length) return null;
  let sum = 0;
  for (const u of units){ const p = unitPrice(u, pf); if (p == null) return null; sum += p; }
  return Math.round(sum * 100) / 100;
}
function cartUnits(cart){
  if (cart === 'pub') return pubUnits;
  const p = topPanel();
  return p ? (p.units || (p.units = [])) : [];
}
/* A technician holds the price list only while the office shows them prices (19); without
   it, no "₱ ?" either — the question of money is simply not on their screen. */
const staffPf = () => db && inField(db.role) && !svcRows().length ? null : officePrice;
const cartPrice = cart => cart === 'pub' ? pagePrice() : staffPf();
const cartKeys = cart => cart === 'pub' ? Object.keys(serviceLabels) : activeServiceKeys();
function afterCart(cart){
  const s = bkState(cart);
  if (s && s._bad && cartUnits(cart).length){ delete s._bad.units; if (!Object.keys(s._bad).length) s._msg = ''; }
  if (cart === 'pub') drawPubCart(); else render();
  if (!$('#cartSheet').hidden) drawCartSheet();
}

/* The owner's list, two by two (27). */
function typeGrid(cart){
  return `<div class="type-grid">${activeTypes().map(t =>
    `<button type="button" class="type-btn" data-act="unitnew" data-cart="${cart}" data-v="${esc(t.key)}"><img class="type-pic" src="${esc(typePic(t.key))}" alt="" aria-hidden="true"><span class="type-name"><span class="type-plus" aria-hidden="true">+</span>${esc(t.label)}</span></button>`).join('')}</div>`;
}
/* The list: each aircon, its services (× takes one off), its price when prices may show. */
function cartHtml(cart, units, opts){
  opts = opts || {};
  const editable = !!opts.editable, pf = 'pf' in opts ? opts.pf : cartPrice(cart);
  if (!units.length) return editable ? '<div class="cart-empty">Nothing yet — tap what it is, above.</div>' : '';
  const names = unitNames(units), total = unitsPrice(units, pf);
  return `<div class="cart-list">${units.map((u, i) => {
      const up = unitPrice(u, pf), meta = [u.brand, u.model, u.serial ? 'SN ' + u.serial : ''].filter(Boolean).join(' · ');
      return `<div class="cart-unit">
        <div class="cart-unit-head">
          ${editable ? `<button type="button" class="cart-unit-name" data-act="unitedit" data-cart="${cart}" data-i="${i}">${esc(names[i])} <span aria-hidden="true">›</span></button>`
                     : `<span class="cart-unit-name">${esc(names[i])}</span>`}
          <span class="cart-unit-meta">${esc(meta)}</span>
          ${pf ? `<span class="cart-unit-price">${up != null ? esc(peso0(up)) : '₱ ?'}</span>` : ''}
          ${editable ? `<button type="button" class="cart-x" data-act="unitdel" data-cart="${cart}" data-i="${i}" aria-label="Remove ${esc(names[i])}">🗑</button>` : ''}
        </div>
        <div class="cart-svcs">${u.services.map(k => {
          const p = pf && u.type ? pf(k, u.type) : null;
          return `<span class="svc-chip">${esc(svcLabel(k))}${p != null ? ` <i>${esc(peso0(p))}</i>` : ''}${editable
            ? `<button type="button" data-act="unitsvcx" data-cart="${cart}" data-i="${i}" data-v="${esc(k)}" aria-label="Take off ${esc(svcLabel(k))}">×</button>` : ''}</span>`; }).join('')}</div>
        ${u.problem ? `<div class="cart-problem"><b>Problem:</b> ${esc(u.problem)}</div>` : ''}
      </div>`; }).join('')}
    ${pf ? `<div class="cart-total"><span>Total</span><b>${total != null ? esc(peso(total)) : esc(opts.missing || 'We will tell you on the call')}</b></div>` : ''}
  </div>`;
}
/* The small window: "Window #2" — what it needs, brand and model if they know them. */
function drawUnitSheet(){
  const box = $('#unitSheet');
  if (!unitEd){ box.hidden = true; lockBody(); return; }
  const u = unitEd.unit, units = cartUnits(unitEd.cart), pf = cartPrice(unitEd.cart);
  const name = unitEd.index >= 0 ? unitNames(units)[unitEd.index] : typeLabel(u.type) + ' #' + (units.filter(x => x.type === u.type).length + 1);
  const keys = cartKeys(unitEd.cart).filter(k => typeOffers(u.type, k) || u.services.includes(k));   // A2 (28)
  box.hidden = false;
  $('.unit-card', box).innerHTML = `
    <div class="unit-head"><div class="unit-title">${esc(name)}</div>
      <button type="button" class="cart-x" data-act="unitclose" aria-label="Close">✕</button></div>
    <div class="fieldlabel">What services?</div>
    <div class="tabbar tight">${keys.map(k => {
      const p = pf ? pf(k, u.type) : null;
      return `<button type="button" class="tab-btn${u.services.includes(k) ? ' active' : ''}" data-act="unitsvc" data-v="${esc(k)}">${esc(svcLabel(k))}${p != null ? ' · ' + esc(peso0(p)) : ''}</button>`; }).join('')
      || '<p class="hint">The service list has not loaded — this needs signal.</p>'}</div>
    <div class="row">
      <label>Brand <span class="opt">— optional</span><input data-ued="brand" maxlength="60" value="${esc(u.brand || '')}" placeholder="Carrier, Koppel…" autocomplete="off"></label>
      <label>Model <span class="opt">— optional</span><input data-ued="model" maxlength="60" value="${esc(u.model || '')}" autocomplete="off"></label>
    </div>
    <label>Serial number <span class="opt">— optional</span><input data-ued="serial" maxlength="60" value="${esc(u.serial || '')}" autocomplete="off"></label>
    <label>Problem or complaint <span class="opt">— optional</span>
      <textarea data-ued="problem" maxlength="300" rows="2" placeholder="What is wrong with this ${esc(name)}? Not cold, leaking…">${esc(u.problem || '')}</textarea></label>
    <div class="unit-msg" id="unitMsg" aria-live="polite"></div>
    <div class="stack"><button type="button" class="b primary wide" data-act="unitdone">Finish</button></div>`;
  lockBody();
}
/* ================================================================ THE booking form
   Guile, 2026-09-27, "top 1 priority": every change on the customer's booking form is also
   the office's Book a job and its Edit. So there is ONE builder. bookFormHtml(ctx, s) draws
   the form for the public page (ctx 'pub', state pubBook) and for Book a job (ctx 'panel',
   state = the open panel); Edit draws its aircon part, bkAirconsHtml. Add or change a field
   HERE and every one of them changes. Only the words differ where the person differs
   ("Your name" / "Customer's name"); the boxes, their order and their look do not.
   The checks are shared too (bookProblems), and a problem is never silent: every box that
   needs something turns red and shakes, with a line under it saying what. The office's
   Book it used to put its complaint on the screen UNDER the one being typed in — measured
   2026-09-27, "Type the customer's name" hidden behind Book a job. */
const PRIVACY_TEXT = () => 'We keep your name, number, address and anything else you write here, so we can do the job. ' +
  'Only ' + SHOP_NAME + ' staff see it. To have it removed, ' + ringUs() + '.';
const freshPubBook = () => ({full_name: '', contact: '', address: '', landmark: '', lat: '', lng: '',
  date: '', slot: 'am', notes: '', website: '', consent: false});
let pubBook = freshPubBook();
const bkState = ctx => ctx === 'pub' ? pubBook : topPanel();
const BK_WORDS = {
  pub:   {name: 'Your name', auto: ['name', 'tel'], notes: 'What is wrong, how long it has been like that…',
          loc: 'Pin your house so we find your gate. At the house? Tap Pin. Anywhere else? Pick it on the map.'},
  panel: {name: 'Customer’s name', auto: ['off', 'off'], notes: 'What is wrong, the price you agreed…',
          loc: 'At the house now? Tap Pin. On the phone? Pick it on the map. A pinned house shows on the customers map.'},
};
const bkBad = (s, f) => (s && s._bad && s._bad[f]) || '';
const bkCls = (s, f) => bkBad(s, f) ? ' bk-bad' + (s._shake ? ' shake' : '') : '';
const bkWhy = (s, f) => bkBad(s, f) ? `<div class="bk-why" data-bkwhy="${f}">${esc(bkBad(s, f))}</div>` : '';
function bkInput(ctx, s, f, label, opt, attrs, side){
  const box = `<input data-bk="${f}" data-cart="${ctx}" value="${esc(s[f] || '')}" ${attrs}>`;
  return `<label class="bk-f${bkCls(s, f)}" data-bkf="${f}">${label}${opt ? ` <span class="opt">${opt}</span>` : ''}
    ${side ? `<span class="bk-row">${box}${side}</span>` : box}</label>${bkWhy(s, f)}`;
}
/* Phonebook (Guile for the owner, 2026-09-30): his phone-book icon beside the number box, and
   the phone's own picker fills the name and the number. The APK asks Android; the customer's
   page too (Guile, 2026-10-01), in a browser that has a contact picker — Chrome on Android.
   Nowhere else can a page reach the phonebook, so there the icon is not drawn at all. */
const pageContacts = () => !!(navigator.contacts && navigator.contacts.select);
const canPickContact = () => (inApk && !!window.AndroidBridge.pickContact) || pageContacts();
function bkBookBtn(ctx, s){
  if (s._lockWho || !canPickContact()) return '';
  return `<button type="button" class="b bk-book" data-act="bkcontact" data-cart="${ctx}" aria-label="Pick from the phonebook" title="Pick from the phonebook">${ico('phone-book')}</button>`;
}
/* "+63 917 123 4567" in the phonebook is "09171234567" here, so Same number still finds them. */
const phoneFromBook = n => { const d = digits(n); return /^63\d{10}$/.test(d) ? '0' + d.slice(2) : String(n || '').trim().slice(0, 30); };
async function bkContact(ctx){
  const s = bkState(ctx); if (!s) return;
  let got;
  try {
    if (inApk && window.AndroidBridge.pickContact) got = await wsNet.call('pickContact', []);
    else { const [c] = await navigator.contacts.select(['name', 'tel'], {multiple: false});   // nothing picked: []
      got = c ? JSON.stringify({name: (c.name || [])[0] || '', number: (c.tel || [])[0] || ''}) : ''; }
  } catch (e){ toast(e.message, true); return; }
  if (!got || bkState(ctx) !== s) return;   // backed out, or the form closed meanwhile
  const {name, number} = JSON.parse(got);
  if (number){ s.contact = phoneFromBook(number); bkClear(ctx, 'contact'); }
  if (/\p{L}/u.test(name || '')){ s.full_name = name.trim().slice(0, 120); bkClear(ctx, 'full_name'); }   // an unnamed contact's "name" is its number
  const a = document.activeElement;   // a redraw waits for a box that has focus; the pick replaced what was in it
  if (a && /INPUT|TEXTAREA/.test(a.tagName)) a.blur();
  bkRedraw(ctx);
}
function bkLocHtml(ctx, s){
  const has = !!(s.lat && s.lng);
  return `<div class="loc-row">
      <button type="button" class="b" data-act="bkpin" data-cart="${ctx}"${s._locBusy ? ' disabled' : ''}>${has ? '✕ Remove the pin' : '📍 Pin my location'}</button>
      <button type="button" class="b" data-act="bkmap" data-cart="${ctx}">🗺️ Pick on map</button></div>
    <div class="hint">${esc(s._loc || BK_WORDS[ctx].loc)}</div>`;
}
/* The aircons (15): tap a type, a small window asks what it needs, and it joins the Service
   summary — Suki's Store Visit. Type is required. Edit uses exactly this part. */
function bkAirconsHtml(ctx, s, label){
  const units = cartUnits(ctx);
  return `<div class="bk-sec${bkCls(s, 'units')}" data-bkf="units">
      <div class="fieldlabel">${esc(label || 'Aircon & Other Appliances')}</div>
      ${typeGrid(ctx)}${bkWhy(s, 'units')}
      ${units.length ? `<div class="fieldlabel">Service summary</div>${cartHtml(ctx, units, ctx === 'pub' ? {editable: true}
        : {editable: true, pf: staffPf(), missing: 'Not every service has a price yet'})}` : ''}
    </div>`;
}
/* The day and the time. opts.notYet: offer "Not yet" (the office, a job with no day yet);
   the time follows it on every one of them (bkTimeHtml). Schedule, Book a job, Edit and the page. */
function bkWhenHtml(ctx, s, opts){
  const pub = ctx === 'pub', today = manilaDate(0), d = s.date || '';
  opts = {notYet: !pub, ...(opts || {})};
  const chips = [...(opts.notYet ? [['', 'Not yet']] : []), [today, 'Today'], [addDays(today, 1), 'Tomorrow'],
    [addDays(today, 2), niceDate(addDays(today, 2))]];
  const chip = (f, v, t, on) => {
    // idea 4: a closed day stays in the row, greyed and marked; the page cannot choose it
    const c = f === 'date' && v ? closedOn(v) : null;
    return `<button type="button" class="tab-btn${on ? ' active' : ''}${c ? ' closed' : ''}" data-act="bkset" data-cart="${ctx}" data-f="${f}" data-v="${v}"${c && pub ? ' disabled' : ''}>${esc(t)}${c ? ' · Closed' : ''}</button>`;
  };
  const shut = closedOn(d);
  return `<div class="bk-sec${bkCls(s, 'date')}" data-bkf="date">
      <div class="fieldlabel">${pub ? 'Preferred date' : opts.notYet ? 'When <span class="opt">— or leave it for later</span>' : 'Day'}</div>
      <div class="tabbar tight">${chips.map(([v, t]) => chip('date', v, t, v === '' ? s.date === '' : d === v)).join('')}</div>
      <input type="date" data-bk="date" data-cart="${ctx}" value="${esc(d)}" min="${today}"${pub ? ` max="${manilaDate(120)}"` : ''} aria-label="Another day">
      ${bkWhy(s, 'date') || (shut ? `<div class="${pub ? 'bk-why' : 'hint warn-line'}">${esc(pub ? closedWords(d, shut)
        : '⚠ The shop is closed that day' + (shut.why ? ' — ' + shut.why : '') + '. You can still book it.')}</div>` : '')}
    </div>
    ${bkTimeHtml(ctx, s)}`;
}
/* The time (33): [hour] : [minute] [AM | PM], any hour, any minute — on every form that asks
   the day, always shown (Guile, 2026-10-01). No hour yet keeps 'am' / 'pm' alone in slot. */
const slotParts = s => {
  const t = s.slot || 'am';
  if (isClock(t)){ const h = +t.slice(0, 2); return {h: String((h % 12) || 12), m: t.slice(3), ap: h < 12 ? 'am' : 'pm'}; }
  return {h: '', m: s._mm || '', ap: t === 'pm' ? 'pm' : 'am'};
};
function bkTimeHtml(ctx, s){
  const p = slotParts(s);
  const pick = (part, now, blank, list) => `<select data-bktime="${part}" data-cart="${ctx}" aria-label="${part === 'h' ? 'Hour' : 'Minutes'}">
      <option value=""${now ? '' : ' selected'}>${blank}</option>${list.map(v => `<option${v === now ? ' selected' : ''}>${v}</option>`).join('')}</select>`;
  return `<div class="bk-sec${bkCls(s, 'slot')}" data-bkf="slot">
      <div class="fieldlabel">${ctx === 'pub' ? 'Preferred time' : 'Time'}</div>
      <div class="bk-time">${pick('h', p.h, 'HH', Array.from({length: 12}, (_, i) => String(i + 1)))}<b>:</b>${
        pick('m', p.h ? p.m : '', 'MM', Array.from({length: 60}, (_, i) => String(i).padStart(2, '0')))}
        <div class="segment">${[['am', 'AM'], ['pm', 'PM']].map(([k, t]) =>
          `<button type="button" class="${p.ap === k ? 'active' : ''}" data-act="bktime" data-cart="${ctx}" data-f="ap" data-v="${k}">${t}</button>`).join('')}</div>
      </div>${bkWhy(s, 'slot')}</div>`;
}
function bkTime(ctx, part, v){
  const s = bkState(ctx); if (!s) return;
  const p = {...slotParts(s), [part]: v};
  s._mm = p.m;
  s.slot = p.h ? String((+p.h % 12) + (p.ap === 'pm' ? 12 : 0)).padStart(2, '0') + ':' + (p.m || '00') : p.ap;
  bkClear(ctx, 'slot');
  if (ctx === 'pub') saveDraft();
  bkRedraw(ctx);
}
// a day needs its hour — except an old booking's AM / PM, left as it was
const timeMissing = s => !isClock(s.slot) && (s.slot || 'am') !== s._origSlot;
function bookFormHtml(ctx, s){
  const pub = ctx === 'pub', w = BK_WORDS[ctx], existing = !pub && s.mode === 'existing', edit = s.mode === 'edit';
  let who = '';
  if (!pub && !edit) who = `<div class="segment">${[['new', 'New customer'], ['existing', 'Customer files']].map(([k, t]) =>
      `<button type="button" class="${s.mode === k ? 'active' : ''}" data-act="pset" data-f="mode" data-v="${k}">${t}</button>`).join('')}</div>`;
  if (existing){
    const c = db.customers[s.customer_id];
    who += `<div class="bk-sec${bkCls(s, 'customer')}" data-bkf="customer">${c
      ? `<div class="lrow flat"><div class="avatar">${esc(initials(c.full_name))}</div>
          <div class="lrow-main"><div class="lrow-title">${esc(c.full_name)}</div><div class="lrow-sub">${esc(c.contact)} · ${esc(c.address)}</div></div>
          <button type="button" class="b" data-act="pset" data-f="customer_id" data-v="">Change</button></div>`
      : `<input type="search" class="find" data-pf="q" placeholder="🔎 Name or number" value="${esc(s.q || '')}" autocomplete="off">
          <div class="list" id="bookMatches">${bookMatches(s)}</div>`}${bkWhy(s, 'customer')}</div>`;
  } else if (!s._removed){   // a customer whose details were removed on request stays removed
    const lock = s._lockWho ? ' readonly class="locked"' : '';
    who += bkInput(ctx, s, 'full_name', w.name, '', `maxlength="120" autocomplete="${w.auto[0]}"${lock}`)
      + bkInput(ctx, s, 'contact', 'Contact number', '', `inputmode="tel" maxlength="30" autocomplete="${w.auto[1]}" placeholder="09XX XXX XXXX"${lock}`, bkBookBtn(ctx, s))
      + (s._lockWho ? '<div class="hint">🔒 Only the office changes the name and the number.</div>' : '')
      + (pub || edit ? '' : `<div id="bookSame">${bookSame(s)}</div>`)   // only a NEW customer can be a duplicate
      + bkInput(ctx, s, 'address', 'Address', '', `maxlength="300" autocomplete="${pub ? 'street-address' : 'off'}" placeholder="Street, barangay, city"`)
      + bkInput(ctx, s, 'landmark', 'Landmark', '— optional, but it is how we find you', `maxlength="200" autocomplete="off" placeholder="beside the chapel, blue gate…"`)
      + `<div class="hint">In Bacolod this matters more than the address. Please fill it in.</div>`
      + bkLocHtml(ctx, s);
  }
  if (pub && s._restored) who = `<div class="inline-note"><span>Filled in from last time, on this phone only.</span>
      <button type="button" class="b" data-act="pubreset">Start again</button></div>` + who;
  const n = (s._bad && Object.keys(s._bad).length) || 0;
  // Editing a job: the day only while the job is still open, and a word about the price,
  // which is frozen onto the job and changed by hand (docs/scope.md).
  // editing a booking asks the day like the page does; editing a job like the office does
  const when = edit ? (s._noWhen ? '' : bkWhenHtml(ctx, s, s._needDate ? {notYet: false} : {notYet: s._notYetOk || !s._origDate}))
                    : bkWhenHtml(ctx, s);
  const priceNote = edit && s._priceNote ? `<p class="hint">${esc(s._priceNote)}</p>` : '';
  // R1: the day the customer asked for, one tap away while the job has none
  const want = edit && !s._noWhen && s._want && !s._want.past && s.date !== s._want.on ? s._want : null;
  const wantChip = want ? `<div class="inline-note"><span>They asked for <b>${esc(niceDate(want.on) + ', ' + slotWord(want.slot))}</b>.</span>
      <button type="button" class="b" data-act="usewantform">Use their day</button></div>` : '';
  const send = pub ? 'Send the booking' : edit ? 'Save changes' : 'Book it';
  const act = pub ? '' : edit ? ` data-act="${s._saveAct || 'savejob'}" data-id="${esc(s.id || '')}"` : ' data-act="savebook"';
  return who + (s._removed ? `<p class="hint">${esc(s._removed)}</p>` : '') + bkAirconsHtml(ctx, s) + priceNote + wantChip + when + `
    <label>Anything else <span class="opt">— optional</span>
      <textarea data-bk="notes" data-cart="${ctx}" maxlength="1000" placeholder="${esc(w.notes)}">${esc(s.notes || '')}</textarea></label>
    ${pub ? `<!-- The honeypot. Hidden from people, filled in by bots. See book_job(). -->
      <div class="hp" aria-hidden="true"><label>Website<input data-bk="website" data-cart="pub" tabindex="-1" autocomplete="off" value="${esc(s.website)}"></label></div>
      <!-- RA 10173. Wording shown to the owner and approved (TODO.md, D). -->
      <label class="tick bk-sec${bkCls(s, 'consent')}" data-bkf="consent"><input type="checkbox" data-bk="consent" data-cart="pub"${s.consent ? ' checked' : ''}>
        <span>${esc(PRIVACY_TEXT())}</span></label>${bkWhy(s, 'consent')}` : ''}
    <button type="${pub ? 'submit' : 'button'}" class="bk-send${n && s._shake ? ' shake' : ''}"${act}${s._sending ? ' disabled' : ''}>${
      s._sending ? 'Sending…' : send}</button>
    <div class="msg${s._msg ? ' show ' + (s._msgOk ? 'ok' : 'err') : ''}"${pub ? ' id="bookMsg"' : ''} aria-live="polite">${esc(s._msg || '')}</div>`;
}
/* The photo top's words — the customer's page and the office's Book a job and Edit draw the
   SAME ones (docs/rules/ui.md, Reuse): the office sees what the customer sees. Only the lead
   line says who is holding the phone; the call button is the customer's alone. */
function heroTextHtml(ctx, s){
  const lede = ctx === 'pub'
    ? `<p class="lede" id="lede">${session && ((db && db.role) || session.role) === 'customer'
        ? 'Book another job below. We ring you back to agree a time.' : 'No account needed. We ring you back to agree a time.'}</p>`
    : ctx === 'edit'
      ? `<p class="lede">${esc((s && s.full_name) || 'The job')} — what the customer booked. Change it here.</p>`
      : '<p class="lede">The customer’s own page, as they see it — for a call you took yourself.</p>';
  return `<p class="hero-kicker">Aircon cleaning · repair · installation<span class="hero-where"> · Bacolod</span></p>
    <h1>${ctx === 'edit' ? (s && s._saveAct === 'editbooking' ? 'Edit the booking' : 'Edit the job') : 'Book an aircon job'}</h1>
    ${lede}
    ${ctx === 'pub' ? `<a class="hero-call" href="tel:${esc(digits(SHOP_PHONE))}">📞 Rather talk? ${esc(SHOP_PHONE)}</a>` : ''}
    ${ctx === 'pub' && pubShop.facebook_url ? `<a class="hero-call fb" href="${esc(pubShop.facebook_url)}" target="_blank" rel="noopener">💬 Message us on Facebook</a>` : ''}`;
}
/* The page's photos (30, TODO 16): the owner's own, in his order, fading from one to the next
   every 6 s; none = the built-in photo, one = no fading. Public Storage addresses (the bucket
   is public and read-only to strangers, supabase/30). Only the photo on show and the next one
   are fetched — six at once would be ~2 MB on mobile data. The office sees the same (ui.md). */
const PAGE_PHOTO_BASE = SUPABASE_URL + '/storage/v1/object/public/page-photos/';
function pagePhotos(){
  const l = db && db.role === 'admin' && db.settings && Array.isArray(db.settings.page_photos) ? db.settings.page_photos : pubShop.page_photos;
  return Array.isArray(l) ? l.filter(p => /^page\/[0-9a-f]{16,64}\.jpg$/.test(p)) : [];
}
let heroIdx = 0;
function heroPhotosHtml(){
  const l = pagePhotos();
  if (!l.length) return '';
  const on = heroIdx % l.length, next = (on + 1) % l.length;
  return `<div class="hero-photos" aria-hidden="true" data-photos="${esc(l.join(','))}">${l.map((p, i) =>
    `<i data-src="${esc(PAGE_PHOTO_BASE + p)}"${i === on ? ' class="on"' : ''}${i === on || i === next ? ` style="background-image:url('${esc(PAGE_PHOTO_BASE + p)}')"` : ''}></i>`).join('')}</div>`;
}
// the customer's page: its photo top is in the HTML, so the photos go in (or change) here
function drawHeroPhotos(){
  const sec = $('#publicView > .hero');
  if (!sec) return;
  const old = sec.querySelector(':scope > .hero-photos'), l = pagePhotos();
  if ((old ? old.dataset.photos : '') === l.join(',')) return;
  if (old) old.remove();
  sec.classList.toggle('has-photos', l.length > 0);
  if (l.length) sec.insertAdjacentHTML('afterbegin', heroPhotosHtml());
}
setInterval(() => {
  const l = pagePhotos();
  if (l.length < 2 || document.hidden) return;
  heroIdx = (heroIdx + 1) % l.length;
  const next = (heroIdx + 1) % l.length;
  $$('.hero-photos').forEach(box => [...box.children].forEach((el, i) => {
    if ((i === heroIdx || i === next) && !el.style.backgroundImage) el.style.backgroundImage = `url('${el.dataset.src}')`;
    el.classList.toggle('on', i === heroIdx);
  }));
}, 6000);
/* A booking form on the photo — Book a job and Edit the job, the customer's page's shape. */
const heroFormHtml = (ctx, s, form) => `<section class="hero${pagePhotos().length ? ' has-photos' : ''}">${heroPhotosHtml()}
    <div class="hero-text">${heroTextHtml(ctx, s)}</div>
    <div class="hero-card"><div class="panel bk-form">${form}</div></div>
  </section>`;

/* What is missing, as [field, what to do] — the same rules for a stranger and the office. */
function bookProblems(ctx, s){
  const pub = ctx === 'pub', out = [], today = manilaDate(0);
  if (!pub && s.mode === 'existing'){
    if (!db.customers[s.customer_id]) out.push(['customer', 'Choose the customer from the list — or tap New customer.']);
  } else if (!s._removed){
    if ((s.full_name || '').trim().length < 2) out.push(['full_name', pub ? 'Please give your name.' : 'Type the customer’s name.']);
    if (digits(s.contact).length < 7) out.push(['contact', pub ? 'Please give a number we can ring — at least 7 digits.' : 'Type a contact number — at least 7 digits.']);
    if ((s.address || '').trim().length < 4) out.push(['address', pub ? 'Please give the address.' : 'Type the address.']);
  }
  if (!cartUnits(ctx).length) out.push(['units', pub ? 'Add your aircon or appliance — tap what it is.' : 'Add at least one aircon — tap its type.']);
  // an edit is only asked about the day when the day was changed: a job done last week is fine
  const dayMoved = s.mode !== 'edit' || s.date !== (s._origDate || '');
  if ((pub || s._needDate) && !s.date) out.push(['date', pub ? 'Please choose a date.' : 'Choose the day they want.']);
  else if (!pub && s.date == null && s.mode !== 'edit') out.push(['date', 'Choose the day — or Not yet, if they have not said.']);
  else if (dayMoved && s.date && s.date < today) out.push(['date', 'That day has already passed.']);
  else if (pub && s.date > manilaDate(120)) out.push(['date', 'That is too far ahead. Please pick a date within the next few months.']);
  else if (pub && closedOn(s.date)) out.push(['date', closedWords(s.date, closedOn(s.date))]);
  if ((pub || s.date) && !s._noWhen && timeMissing(s)) out.push(['slot', pub ? 'Please choose the hour.' : 'Choose the hour.']);
  if (pub && !s.consent) out.push(['consent', 'Please tick the box to say you have read how we keep your details.']);
  return out;
}
const bkRoot = ctx => ctx === 'pub' ? $('#bookFields') : $('#panels').lastElementChild;
function bkRedraw(ctx){ if (ctx === 'pub') drawPubCart(); else render(); }
/* Every box that needs something turns red and shakes, the button says how many, and the
   first one comes into view. Typing in a red box takes its red away at once. */
function bkShow(ctx, s, list){
  s._bad = Object.fromEntries(list);
  s._shake = true;
  s._msgOk = false;
  s._msg = list.length === 1 ? list[0][1] : list.length + ' things still needed — they are marked in red.';
  bkRedraw(ctx);
  const root = bkRoot(ctx), first = root && $(`[data-bkf="${list[0][0]}"]`, root);
  if (first){
    first.scrollIntoView({block: 'center', behavior: 'smooth'});
    const box = $('input:not([type=checkbox]),textarea', first);
    if (box) setTimeout(() => box.focus({preventScroll: true}), 350);
  }
  setTimeout(() => { s._shake = false; }, 700);
}
function bkClear(ctx, f){
  const s = bkState(ctx);
  if (!s || !bkBad(s, f)) return;
  delete s._bad[f];
  const root = bkRoot(ctx); if (!root) return;
  const el = $(`[data-bkf="${f}"]`, root); if (el) el.classList.remove('bk-bad', 'shake');
  const why = $(`[data-bkwhy="${f}"]`, root); if (why) why.remove();
  if (!Object.keys(s._bad).length){ s._msg = ''; const m = $('.bk-send + .msg', root); if (m) m.className = 'msg'; }
}
/* Location, either form: one tap, and easy to take back. */
function bkPin(ctx){
  const s = bkState(ctx); if (!s) return;
  if (s.lat){ s.lat = s.lng = ''; s._loc = 'Location removed.'; bkRedraw(ctx); return; }
  if (!navigator.geolocation){ s._loc = 'This phone cannot share its location. The landmark will do.'; bkRedraw(ctx); return; }
  s._locBusy = true; s._loc = 'Finding you…'; bkRedraw(ctx);
  navigator.geolocation.getCurrentPosition(p => {
    s._locBusy = false; s.lat = p.coords.latitude.toFixed(6); s.lng = p.coords.longitude.toFixed(6);
    s._loc = 'Location added.'; bkRedraw(ctx);
  }, () => {
    s._locBusy = false; s._loc = 'Could not get the location. That is fine — the landmark will do.'; bkRedraw(ctx);
  }, {enableHighAccuracy: true, timeout: 15000, maximumAge: 60000});
}
function bkMap(ctx){
  const s = bkState(ctx); if (!s) return;
  openMapPick(s.lat ? {lat: +s.lat, lng: +s.lng} : null, p => {
    s.lat = p.lat.toFixed(6); s.lng = p.lng.toFixed(6);
    s._loc = 'Pinned on the map. Tap “Pick on map” again to move it.'; bkRedraw(ctx);
  });
}

/* The page's form, its summary, the bar, and the sheet the bar opens. */
/* R9 (2026-09-27): the unsent booking stays on THIS phone — a reload, a closed tab or a
   phone that killed the browser lost a half-filled form and its aircons. Kept in this
   browser only, never sent; gone when the booking is sent, on "Start again", or after a
   month. The privacy tick is not kept: it is asked again each time. */
const DRAFT_KEY = 'ws_pub_draft';
const DRAFT_FIELDS = ['full_name', 'contact', 'address', 'landmark', 'lat', 'lng', 'date', 'slot', 'notes'];
function saveDraft(){
  const has = pubUnits.length || DRAFT_FIELDS.some(f => f !== 'slot' && pubBook[f]);
  if (!has){ lsDel(DRAFT_KEY); return; }
  const d = {at: Date.now(), units: pubUnits};
  DRAFT_FIELDS.forEach(f => { d[f] = pubBook[f] || ''; });
  lsSet(DRAFT_KEY, d);
}
function loadDraft(){
  const d = lsGet(DRAFT_KEY, null);
  if (!d) return;
  if (!(Date.now() - (d.at || 0) < 30 * 864e5)){ lsDel(DRAFT_KEY); return; }
  DRAFT_FIELDS.forEach(f => { if (typeof d[f] === 'string') pubBook[f] = d[f]; });
  if (pubBook.date && pubBook.date < manilaDate(0)) pubBook.date = '';   // a day that has passed
  if (!slotOk(pubBook.slot)) pubBook.slot = 'am';
  pubUnits = (Array.isArray(d.units) ? d.units : [])
    .filter(u => u && typeOf(u.type) && Array.isArray(u.services) && u.services.length).slice(0, 20)
    .map(unitCopy);
  pubBook._restored = pubUnits.length > 0 || DRAFT_FIELDS.some(f => f !== 'slot' && pubBook[f]);
}
function drawPubCart(){
  saveDraft();
  const pf = pagePrice();
  keepTyping($('#bookFields'), () => bookFormHtml('pub', pubBook));
  $('#barCount').textContent = pubUnits.length;
  // "3 aircons", or "3 units" once a freezer or a car is in it (28)
  const acOnly = pubUnits.every(u => BUILTIN_TYPES.some(b => b.key === u.type)), word = acOnly ? 'aircon' : 'unit';
  $('#barWord').textContent = (word + (pubUnits.length === 1 ? '' : 's')).toUpperCase();
  const total = unitsPrice(pubUnits, pf);
  $('#barTotal').textContent = pf ? (total != null ? peso(total) : 'Price on the call') : pubUnits.length + ' ' + word + (pubUnits.length === 1 ? '' : 's');
  showPubBar();
}
function showPubBar(){
  const on = pubUnits.length > 0 && !$('#publicView').hidden && !$('#bookForm').hidden && !authOpen;
  $('#pubBar').hidden = !on;
  document.body.classList.toggle('has-bar', on);
}
function drawCartSheet(){
  const box = $('#cartSheet');
  box.hidden = false;
  $('.unit-card', box).innerHTML = `
    <div class="unit-head"><div class="unit-title">🛒 Service summary</div>
      <span class="muted">${pubUnits.length} aircon${pubUnits.length === 1 ? '' : 's'}</span>
      <button type="button" class="cart-x" data-act="cartclose" aria-label="Close">✕</button></div>
    ${pubUnits.length ? cartHtml('pub', pubUnits, {editable: true}) : '<div class="cart-empty">Nothing yet — tap what it is, on the form.</div>'}
    <div class="stack">
      <button type="button" class="b primary wide" data-act="pubsend" ${pubUnits.length ? '' : 'disabled'}>Send the booking</button>
      <button type="button" class="b wide" data-act="cartclose">Keep adding</button>
    </div>`;
  lockBody();
}
function lockBody(){
  const open = (typeof stack !== 'undefined' && stack.length > 0) || !$('#unitSheet').hidden || !$('#cartSheet').hidden || !$('#mapSheet').hidden;
  document.body.classList.toggle('locked', open);
}

/* ---------------------------------------------------------------- Full status (15)
   Suki's Full status, everywhere: where it is, what is on it, and every step with who and
   when. Read live from the server (full_status), so it needs signal — and says so. */
const STEP_NAMES = ['Booked', 'Accepted', 'Scheduled', 'In progress', 'Done'];
function stepAt(d){
  const b = d.booking, j = d.job;
  if (j){ return j.status === 'done' ? 4 : j.status === 'in_progress' ? 3 : j.scheduled_on ? 2 : 1; }
  return b && b.status === 'accepted' ? 1 : 0;
}
function headline(d){
  const b = d.booking, j = d.job;
  if (j && j.status === 'cancelled') return ['bad', 'Cancelled' + (j.cancel_reason ? ' — ' + j.cancel_reason : '')];
  if (!j && b && b.status === 'rejected') return ['bad', 'Rejected' + (b.reject_reason ? ' — ' + b.reject_reason : '')];
  if (!j && b && b.status === 'cancelled') return ['bad', 'Cancelled'];
  if (j && j.status === 'done') return ['good', 'Done' + (j.done_at ? ' — ' + new Date(j.done_at).toLocaleDateString('en-PH', {day: 'numeric', month: 'short'}) : '')];
  if (j && j.status === 'in_progress') return ['', 'The technician is on it'];
  // idea 1 (19): one tap by the technician on the way there — the customer sees it
  if (j && j.on_way_at && ['booked', 'scheduled'].includes(j.status)) return ['', 'The technician is on the way'];
  if (j && j.scheduled_on) return ['', 'Scheduled for ' + niceDate(j.scheduled_on) + ', ' + slotWord(j.slot)];
  if (j) return ['', 'A job — no day set yet'];   // the office made it (a call, or accepted): nobody is waiting to ring
  // Track my booking knows only the booking (trust-boundary.md): "will set the day" was
  // still said there with the job scheduled, started, even done (scenario test, 2026-09-27)
  if (b && b.status === 'accepted') return ['', d.track ? 'Accepted by the office' : 'Accepted — the office will set the day'];
  // a call the office took itself (26): nobody is waiting for a ring
  if (b && b.source === 'office') return ['', 'Booked by phone — quote it, then Accept'];
  return ['', 'Waiting for the office to ring'];
}
/* ---- Full status everywhere (Guile, 2026-09-27: "there should be always a full status
   everywhere"). Three shared pieces, drawn on every booking and job, for every role:
     stepsHtml(d)            the line and the five bars — from this phone's own copy
     statusBlockHtml(k, id)  what has happened, with who and when — live from full_status
     miniSteps(d)            the bars again, thin, on a list row
   The history is fetched once per booking or job and kept in statusLive; a write that
   touches it, a pull that changed something, or ↻ drops it so the next draw asks again. */
const statusLive = {};
const statusKey = (kind, id) => (kind === 'job' ? 'j:' : 'b:') + id;
function liveStatus(kind, id){
  const key = statusKey(kind, id);
  let e = statusLive[key];
  if (!e){
    e = statusLive[key] = {loading: true, data: null, error: ''};
    rpc('full_status', kind === 'job' ? {p_job: id} : {p_booking: id})
      .then(d => { e.data = d; e.error = ''; })
      .catch(err => { e.error = err instanceof Unreachable ? 'What has happened shows when there is signal.' : err.message; })
      .finally(() => { e.loading = false; render(); });
  }
  return e;
}
function forgetStatus(ids){
  if (!ids){ Object.keys(statusLive).forEach(k => delete statusLive[k]); return; }
  ids.forEach(id => { delete statusLive['j:' + id]; delete statusLive['b:' + id]; });
}
function statusBlockHtml(kind, id){
  const e = liveStatus(kind, id);
  return `<div class="st-label">🕒 What has happened to it</div>` +
    (e.data ? timelineHtml(e.data.events || [])
     : e.error ? `<p class="hint">${esc(e.error)}</p>` : '<div class="cart-empty">Loading what has happened…</div>');
}
/* The five bars, thin, under a list row. Picture only. */
function miniSteps(d){
  const [tone] = headline(d), at = stepAt(d);
  return tone === 'bad' ? '' : `<div class="mini-steps" aria-hidden="true">${STEP_NAMES.map((n, i) =>
    `<span class="${i <= at ? 'on' : ''}"></span>`).join('')}</div>`;
}
/* The booking a job came from, when this phone has it. */
const bookingOfJob = j => (j && j.booking_id && db.bookings[j.booking_id]) || null;

/* "Waiting for the office to ring" and the five bars. Picture only — nothing to tap. */
function stepsHtml(d){
  const [tone, head] = headline(d), at = stepAt(d);
  return `<div class="status-now ${tone}">${esc(head)}</div>
    ${tone === 'bad' ? '' : `<div class="steps">${STEP_NAMES.map((n, i) => `<span class="step${i <= at ? ' on' : ''}"><span class="step-bar"></span><span class="step-name">${n}</span></span>`).join('')}</div>`}`;
}
function unitDiff(before, after){
  const a = before || [], z = after || [], na = unitNames(a), nz = unitNames(z), out = [];
  const words = u => (u.services || []).map(svcLabel).join(', ');
  for (let i = 0; i < Math.max(a.length, z.length); i++){
    if (!a[i]) out.push(['+ ' + nz[i], '', words(z[i])]);
    else if (!z[i]) out.push(['− ' + na[i], words(a[i]), '']);
    else if (JSON.stringify(a[i]) !== JSON.stringify(z[i])) out.push([nz[i], na[i] !== nz[i] ? na[i] + ': ' + words(a[i]) : words(a[i]), words(z[i])]);
  }
  return out;
}
/* [icon, what, changes, who] — who is drawn bold after the words, as on Suki's screen. */
/* An edit, field by field: [what, was, now]. A booking and a job write the same shape (16);
   an older line holds the aircons alone, as a list (15). */
function editChanges(ch){
  const b0 = ch.before, a0 = ch.after;
  if (Array.isArray(b0) || Array.isArray(a0)) return unitDiff(b0, a0);
  const b = b0 || {}, a = a0 || {}, out = [];
  if ('units' in a) out.push(...unitDiff(b.units, a.units));
  if (a.customer){
    const cb = b.customer || {}, ca = a.customer;
    [['full_name', 'Name'], ['contact', 'Number'], ['address', 'Address'], ['landmark', 'Landmark']].forEach(([k, w]) => {
      if ((cb[k] || '') !== (ca[k] || '')) out.push([w, cb[k] || '', ca[k] || '(none)']); });
    if (!!cb.pinned !== !!ca.pinned) out.push(['Pin', cb.pinned ? 'set' : '', ca.pinned ? 'set' : 'removed']);
  }
  const day = w => w && w.on ? niceDate(w.on) + ' ' + slotShort(w.slot) : '';
  if (a.wanted) out.push(['Wanted', day(b.wanted), day(a.wanted)]);
  if ('notes' in a) out.push(['Notes', b.notes || '', a.notes || '(none)']);
  return out;
}
function eventRow(e){
  const by = e.by || '', ch = e.changes || {}, before = ch.before || {}, after = ch.after || {};
  const lab = s => STATUS_LABEL[s] || s || '—';
  switch (e.kind){
    case 'booked':    return ['📝', by ? 'Booked' : 'Booked on the page', null, by];
    case 'seen':      return ['👀', 'Seen by the office', null, by !== 'the office' ? by : ''];
    case 'accepted':  return ['✅', 'Accepted', null, by];
    case 'rejected':  return ['⛔', 'Rejected', null, by];
    case 'cancelled': return ['🚫', 'Cancelled', null, by];
    case 'claimed':   return ['🔗', 'Added to the customer’s account'];
    case 'edited':    return ['✏️', 'Edited', editChanges(ch), by];
    case 'job_edit':  return ['✏️', 'Edited', editChanges(ch), by];
    case 'job_created': return ['🛠️', 'Job made', null, by];
    case 'job_schedule': return ['📅', 'Scheduled', [['Day',
      before.scheduled_on ? niceDate(before.scheduled_on) + ' ' + slotShort(before.slot) : '',
      after.scheduled_on ? niceDate(after.scheduled_on) + ' ' + slotShort(after.slot) : '']], by];
    case 'job_status': {
      const to = after.status;
      const icon = {in_progress: '▶️', done: '🏁', cancelled: '🚫'}[to] || '•';
      const what = {in_progress: 'Started', done: 'Marked done', cancelled: 'Job cancelled'}[to] || 'Now ' + lab(to);
      return [icon, what, [['Status', lab(before.status), lab(to)]], by];
    }
    case 'job_onway': return ['🚐', 'On the way', null, by];
    case 'job_paid':  return ['💵', after.paid ? 'Paid · ' + (PAY[after.paid] || after.paid) : 'Marked not paid', null, by];   // 21
    case 'job_followup': return ['☎️', 'After-job call', after.note ? [['Note', '', after.note]] : null, by];
    case 'job_seen':  return ['👀', 'Seen', null, by];   // one per person who opened the job (20)
    case 'job_undo':  return ['↩️', 'Undone', [['Status', lab(before.status), lab(after.status)]], by];
    case 'job_photo': return ['📷', before.had ? 'New gate photo' : 'Gate photo', null, by];   // L3: the gate, for the next visit
    case 'job_price': return ['₱', 'Price', [['Price', before.price != null ? peso(before.price) : 'not set', after.price != null ? peso(after.price) : 'not set']], by];
  }
  return ['•', e.kind, null, by];
}
function timelineHtml(events){
  if (!events.length) return '<div class="cart-empty">Nothing has happened to it yet.</div>';
  const stamp = iso => new Date(iso).toLocaleString('en-PH', {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
  return `<div class="tl">${events.map(e => { const [icon, what, changes, who] = eventRow(e);
    return `<div class="tl-row"><span class="tl-icon">${icon}</span><span class="tl-body">
      <span class="tl-what">${esc(what)}${who ? ` · <b>${esc(who)}</b>` : ''}</span><span class="tl-when">${esc(stamp(e.at))}</span>
      ${e.kind === 'job_photo' && e.changes && e.changes.after && typeof e.changes.after.photo === 'string'
        ? housePhoto(e.changes.after.photo, 'tl-photo') : ''}
      ${(changes || []).length ? `<span class="tl-changes">${changes.map(([w, from, to]) =>
        `<span class="tl-change">${esc(w)}${from ? `: <s>${esc(from)}</s>` : ''}${to ? ` → <b>${esc(to)}</b>` : ''}</span>`).join('')}</span>` : ''}
    </span></div>`; }).join('')}</div>`;
}
function panelStatus(p){
  // the same live copy every other screen's status block uses
  const e = liveStatus(p.kind === 'jobstatus' ? 'job' : 'booking', p.id);
  if (!e.data && !e.error) return {title: 'Full status', body: '<div class="cart-empty">Loading…</div>'};
  if (!e.data) return {title: 'Full status', body: empty(e.error === 'What has happened shows when there is signal.'
    ? 'Full status needs signal. Try again when you are online.' : e.error)};
  const d = e.data, b = d.booking, j = d.job, who = d.customer || b || {};
  const units = (j && j.units && j.units.length ? j.units : b && b.units) || [];
  const pf = d.role === 'admin' ? officePrice : d.role === 'customer' && d.show_price ? pagePrice() : null;
  const [tone, head] = headline(d), stopped = tone === 'bad';
  // The job's own price is the one agreed; without it, the list's prices add up per aircon.
  const total = j && j.price != null && d.show_price ? Number(j.price) : null;
  const rowPf = total != null ? null : pf, names = unitNames(units);
  const sum = total != null ? total : unitsPrice(units, rowPf);
  const wanted = b ? (b.preferred_on ? niceDate(b.preferred_on) + ', ' + slotWord(b.slot) : 'No day yet') : '';
  const notes = (j && j.notes) || (b && b.notes) || '';
  const rows = units.map((u, i) => {
    const up = unitPrice(u, rowPf), meta = [u.brand, u.model].filter(Boolean).join(' ');
    return `<div class="st-row"><span>${esc(names[i])}${meta ? ` <span class="muted">${esc(meta)}</span>` : ''}
      <br><span class="muted">${esc(u.services.map(svcLabel).join(', '))}</span></span>
      <span>${rowPf ? esc(up != null ? peso(up) : '₱ ?') : ''}</span></div>`; }).join('');
  p.copy = [(b ? b.ref + ' — ' : '') + head, [who.full_name, who.contact].filter(Boolean).join(' · '),
    who.address, who.landmark ? 'Landmark: ' + who.landmark : '', wanted ? 'Wanted: ' + wanted : '',
    ...units.map((u, i) => names[i] + ': ' + u.services.map(svcLabel).join(', ')),
    sum != null ? 'Total: ' + peso(sum) : '', notes ? 'Notes: ' + notes : ''].filter(Boolean).join('\n');
  return {title: who.full_name || 'Full status', sub: (b ? b.ref + ' · ' : '') + head, body: `
    ${stepsHtml(d)}
    <div class="card">
      <div class="st-label">🏠 The customer</div>
      <div class="st-loc"><b>${esc(who.full_name || '')}</b>
        ${who.contact ? `<br>${esc(who.contact)}` : ''}
        ${who.address ? `<br>${esc(who.address)}` : ''}
        ${who.landmark ? `<br><span class="muted">Landmark: ${esc(who.landmark)}</span>` : ''}
        ${wanted ? `<br><span class="muted">Wanted: ${esc(wanted)}</span>` : ''}</div>
      ${d.role !== 'customer' ? `<div class="actions">${callBtn(who.contact)}${mapBtn(who)}</div>` : ''}
    </div>
    <div class="st-label">🛒 What was booked</div>
    <div class="st-sum">
      ${rows || '<div class="st-row"><span class="muted">No aircons on this one.</span></div>'}
      ${total != null || rowPf ? `<div class="st-total"><span>Total</span>${sum != null ? `<span>${esc(peso(sum))}</span>`
        : '<span class="muted">Not every service has a price yet</span>'}</div>` : ''}
    </div>
    ${notes ? `<div class="st-label">📝 Notes</div><p class="hint" style="font-size:13.5px;margin:0">${esc(notes)}</p>` : ''}
    <div class="st-label">🕒 What has happened to it</div>
    ${timelineHtml(d.events || [])}
    <button type="button" class="b st-copy" data-act="copystatus">📋 Copy summary</button>
    ${d.role === 'customer' && !stopped ? `<p class="hint">Something on it wrong? Ring the shop${SHOP_PHONE ? ' — ' + esc(SHOP_PHONE) : ''}.</p>` : ''}`};
}

/* ---------------------------------------------------------------- the check-up call list
   Guile, 2026-09-27 (24): a customer is checked on a REGULAR CHECK the office sets on them —
   every 1, 2, 3, 6 or 12 months, from a chosen date. The old rule (N months after the last
   finished job, set in Settings) is gone. Somebody with work already booked is not due: the
   call would be about a job they already have. A job finished on or after the check date
   counts as that check. */
const slotCap = () => Math.min(50, Math.max(0, parseInt(((db && db.settings) || {}).slot_capacity, 10) || 0));
const checkupMonths = () => Math.min(24, Math.max(1, parseInt(((db && db.settings) || {}).checkup_months, 10) || 1));
const ord = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
function checkDayIn(ym, day){   // 'YYYY-MM' → that month's check date; a 31st is a short month's last day
  const [y, m] = ym.split('-').map(Number), last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return ym + '-' + String(Math.min(day, last)).padStart(2, '0');
}
const monthOf = (ymd, delta) => { const [y, m] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7); };
const addEvery = (ymd, every, day) => checkDayIn(monthOf(ymd, every), day || Number(ymd.slice(8, 10)));
const EVERY = [[1, 'Monthly'], [2, '2 months'], [3, '3 months'], [6, '6 months'], [12, 'Yearly']];
const everyWord = n => n === 1 ? 'every month' : n === 12 ? 'every year' : 'every ' + n + ' months';
function checkupOf(c){
  if (!c.check_every || !c.check_next) return null;
  const js = jobsOf(c.id);
  const last = js.filter(j => j.status === 'done' && j.done_at).sort(byDoneDesc)[0];
  const busy = js.some(j => ['booked', 'scheduled', 'in_progress'].includes(j.status));
  const day = c.check_day || Number(c.check_next.slice(8, 10));
  let due = c.check_next;
  if (last) for (let i = 0; i < 60 && due <= manilaDay(last.done_at); i++) due = addEvery(due, c.check_every, day);
  return {last, due, busy, every: c.check_every, day};
}
/* After ✓ Done: the first check date after today. */
function checkAfterToday(k){
  let n = k.due; const t = manilaDate(0);
  for (let i = 0; i < 60 && n <= t; i++) n = addEvery(n, k.every, k.day);
  return n;
}
function checkups(){
  const today = manilaDate(0), out = [];
  for (const c of Object.values(db.customers)){
    if (c.full_name === '(removed)') continue;
    const k = checkupOf(c);
    if (!k || k.busy || k.due > today) continue;
    out.push({c, ...k});
  }
  return out.sort((a, b) => a.due.localeCompare(b.due));
}

/* ---------------------------------------------------------------- admin */
const newBookings = () => Object.values(db.bookings).filter(b => b.status === 'new');

/* ---------------------------------------------------------------- the red numbers
   Guile, 2026-09-27. Each list's number is what THIS account on THIS phone has not opened
   yet — kept on the phone (ws_seen_<uid>), never sent: two technicians each have their own.
   The one exception is the Inbox, which the whole office shares: a booking any admin has
   opened is seen (seen_at, 15). A number of 0 draws no circle at all.
     Jobs       an open job not opened here yet — a new one after Accept counts
     Check-ups  a customer due, not opened here since they came due
     Users      an account not opened here yet — somebody who just registered
   The very first time, everything already on the phone counts as seen, so the numbers
   start at 0 instead of at every job the shop ever had. */
const seenKey = () => 'ws_seen_' + (session ? session.uid : '');
function seenStore(){
  if (!session || !db || db.cursor == null) return null;   // not pulled yet: nothing to compare
  let s = lsGet(seenKey(), null);
  if (!s){
    s = {jobs: {}, users: {}, checkups: {}};
    Object.keys(db.jobs).forEach(id => { s.jobs[id] = 1; });
    Object.keys(db.team).forEach(id => { s.users[id] = 1; });
    checkups().forEach(k => { s.checkups[k.c.id] = k.due; });
    lsSet(seenKey(), s);
  }
  return s;
}
function markSeen(kind, id, value){
  const s = seenStore(); if (!s || !id) return;
  if (s[kind][id] === (value || 1)) return;
  s[kind][id] = value || 1;
  lsSet(seenKey(), s);
}
const isOpenJob = j => !['done', 'cancelled'].includes(j.status);
const jobUnseen = j => { const s = seenStore(); return !!s && isOpenJob(j) && !s.jobs[j.id]; };
const userUnseen = t => { const s = seenStore(); return !!s && t.id !== session.uid && !s.users[t.id]; };
const checkupUnseen = k => { const s = seenStore(); return !!s && s.checkups[k.c.id] !== k.due; };
function unseenCounts(){
  return {
    inbox: newBookings().filter(b => !b.seen_at).length,   // shared by the office (15)
    jobs: Object.values(db.jobs).filter(jobUnseen).length,
    // the after-job calls count until made (idea 11): they leave the list once rung
    checkups: db.role === 'admin' ? checkups().filter(checkupUnseen).length + followups().length : 0,
    team: db.role === 'admin' ? Object.values(db.team).filter(userUnseen).length : 0,
  };
}
/* The job for an accepted booking — Accept and Make the job both. "after": the Accept it
   depends on, when there is one. Returns {jid, op}. */
function makeJobFor(b, cid, after){
  const jid = uuid();
  const op = write('create_job', {p_id: jid, p_customer: cid, p_booking: b.id}, 'New job for ' + b.full_name, [jid, b.id], db => {
    db.jobs[jid] = {id: jid, customer_id: cid, booking_id: b.id, services: b.services, status: 'booked',
      unit_type: b.unit_type, unit_brand: b.unit_brand, unit_model: b.unit_model, notes: b.notes,
      scheduled_on: null, slot: b.slot, unit_count: b.unit_count || 1, units: unitsOf(b),
      price: unitsPrice(unitsOf(b), officePrice), created_at: new Date().toISOString()};
  }, after);
  return {jid, op};
}
function seenCheckup(cid){
  const k = checkups().find(x => x.c.id === cid);
  if (k) markSeen('checkups', cid, k.due);
}
/* The blue dot on a row this account has not opened. */
const newDot = on => on ? '<span class="new-dot" title="New — not opened yet">New</span>' : '';

/* SukiRun's stat strip: four numbers, each one a way in. One row, even on a phone. */
function drawStats(){
  const jobs = Object.values(db.jobs), today = manilaDate(0);
  const stats = [
    [newBookings().length, 'New', 'inbox', 'new'],
    [jobs.filter(j => j.scheduled_on === today && j.status !== 'cancelled').length, 'Today', 'jobs', 'today'],
    [jobs.filter(j => !j.scheduled_on && !['done', 'cancelled'].includes(j.status)).length, 'No date', 'jobs', 'unplanned'],
    [checkups().length + followups().length, 'Check-ups', 'checkups', ''],
  ];
  return `<div class="stat-strip">${stats.map(([n, label, tab, v]) =>
    `<button type="button" class="stat-card" data-act="gostat" data-tab="${tab}" data-v="${v}">
       <div class="stat-num">${n}</div><div class="stat-label">${esc(label)}</div></button>`).join('')}</div>`;
}

/* Guile's Flaticon icons (2026-09-27). The coloured ones stay coloured in dark mode — made
   one colour they turn into blobs (measured); the one-colour customer icon turns white. */
const ADMIN_TABS = [['inbox', 'inbox', 'Inbox'], ['jobs', 'jobs', 'Jobs'], ['people', 'customers', 'Customers'],
                    ['checkups', 'checkups', 'Check-ups'], ['team', 'users', 'Users'], ['admin', 'admin', 'Admin']];
const ADMIN_HEAD = {inbox: 'Inbox', jobs: 'Jobs', people: 'Customers', checkups: 'Check-ups', team: 'Users', admin: 'Admin'};
const pageHead = (title, k, extra) => `<div class="page-head"><h1>${esc(title)}</h1>${extra || ''}${infoBtn(k)}</div>`;
function drawNav(){
  const n = unseenCounts();
  // One red thing only: the number. The envelope no longer swaps to one with its own red
  // dot (it did, and the two read as one confusing blob — Guile, 2026-09-27).
  const as = inField(ui.viewAs) ? ui.viewAs : 'admin';
  $('#bottomNav').innerHTML = ADMIN_TABS.map(([k, icon, label]) => {
    // View as a helper: Jobs wears Guile's Helper.png (37)
    if (k === 'jobs' && as === 'helper') icon = 'helper';
    const b = `<button type="button" data-act="tab" data-v="${k}" aria-current="${ui.tab === k}">
       <span class="nav-ico">${ico(icon, icon === 'customers' ? 'mono' : '')}${n[k] ? `<span class="nav-badge">${n[k] > 99 ? '99+' : n[k]}</span>` : ''}</span><span class="nav-word">${label}</span></button>`;
    return k === 'jobs' && ui.tab === 'jobs' ? `<div class="nav-slot">${viewAsHtml(as)}${b}</div>` : b;
  }).join('');
}
/* View as (Guile, 2026-10-03): a pill above Jobs; it opens upward — Office · Technician · Helper.
   Not a <details> dropdown (scope.md: none on staff screens): a pill and three buttons. */
const VIEW_AS = [['admin', '🏢', 'Office'], ['technician', '🔧', 'Technician'], ['helper', '🤲', 'Helper']];
function viewAsHtml(as){
  const cur = VIEW_AS.find(x => x[0] === as);
  return `${ui.viewMenu ? `<div class="view-menu" role="menu">${VIEW_AS.map(([k, e, t]) =>
      `<button type="button" role="menuitemradio" aria-checked="${k === as}" class="view-opt${k === as ? ' on' : ''}" data-act="viewas" data-v="${k}">${e} ${t}${k === as ? ' <b>✓</b>' : ''}</button>`).join('')}</div>` : ''}
    <button type="button" class="view-pill${as !== 'admin' ? ' as' : ''}" data-act="viewmenu" aria-expanded="${!!ui.viewMenu}">👁 ${esc(cur[2])} <span aria-hidden="true">${ui.viewMenu ? '▾' : '▴'}</span></button>`;
}
function drawAdmin(){
  if (ui.tab === 'numbers') ui.tab = 'admin';
  if (!ADMIN_HEAD[ui.tab]) ui.tab = 'inbox';
  const body = {inbox: drawInbox, jobs: drawJobs, people: drawPeople, checkups: drawCheckups, team: drawTeam, admin: drawAdminTab}[ui.tab]();
  return pageHead(ADMIN_HEAD[ui.tab], ui.tab) +
    (ui.tab === 'inbox' || (ui.tab === 'jobs' && !inField(viewRole())) ? drawStats() : '') + body;
}

/* ---------------------------------------------------------------- inbox */
function drawInbox(){
  const all = Object.values(db.bookings);
  const jobbed = new Set(Object.values(db.jobs).map(j => j.booking_id).filter(Boolean));
  // No "Needs a job" (Guile, 2026-09-27): Accept makes the job in the same tap, so a
  // booking never waits between the two. One accepted before that, still without a job,
  // stays under New with its "Make the job" button, so nothing is lost.
  const lists = {
    new: all.filter(b => b.status === 'new' || (b.status === 'accepted' && !jobbed.has(b.id))),
    closed: all.filter(b => ['rejected', 'cancelled'].includes(b.status)),
  };
  const v = lists[ui.inbox] ? ui.inbox : 'new';
  const rows = lists[v].sort((a, b) => a.created_at < b.created_at ? 1 : -1);
  return chips('inbox', [['new', 'New', lists.new.length], ['closed', 'Rejected / cancelled']], v) +
    (rows.length ? `<div class="list">${rows.map(bookingRow).join('')}</div>`
                 : empty(v === 'new' ? 'No new bookings.' : 'Nothing here.'));
}
/* A saved quotation is the price agreed; without one, the price list's (25). */
const bookingPrice = b => b.quote && b.quote.total != null ? Number(b.quote.total) : unitsPrice(unitsOf(b), officePrice);
function bookingRow(b){
  return `<div class="lrow" role="button" tabindex="0" data-act="open" data-kind="booking" data-id="${esc(b.id)}" data-stamp="${esc(b.updated_at || '')}">
    <div class="avatar">${esc(initials(b.full_name))}</div>
    <div class="lrow-main">
      <div class="lrow-title">${newDot(b.status === 'new' && !b.seen_at)}${esc(b.full_name)}${b.source === 'office' ? ' ' + pill('kind', 'By phone') : ''}${unsentPill(b.id)}</div>
      <div class="lrow-sub">${esc(unitsLine(unitsOf(b)))} — ${esc(svcList(b.services))}</div>
      <div class="lrow-sub">${esc(b.preferred_on ? 'Wants ' + shortDate(b.preferred_on) + ' ' + slotShort(b.slot) : 'No day yet')} · ${esc(b.address)}</div>
      ${miniSteps({booking: b, job: Object.values(db.jobs).find(j => j.booking_id === b.id) || null})}
    </div>
    <div class="lrow-side">${pill(b.status, b.ref)}<span class="lrow-price">${esc(bookingPrice(b) != null ? peso0(bookingPrice(b)) : '₱ ?')}</span>
      <span class="lrow-time">${esc(timeAgo(b.created_at))}</span></div>
  </div>`;
}
function panelBooking(p){
  const b = db.bookings[p.id];
  if (!b) return {title: 'Booking', body: empty('This booking is no longer on this phone.')};
  const same = b.contact && b.status === 'new'
    ? Object.values(db.customers).filter(c => digits(c.contact) === digits(b.contact)) : [];
  const job = Object.values(db.jobs).find(j => j.booking_id === b.id);
  const listPrice = unitsPrice(unitsOf(b), officePrice);
  let acts = '';
  // Book a job from Customer files names the customer (26): Accept puts it on their file
  const mine = b.status === 'new' && b.for_customer && db.customers[b.for_customer];
  if (b.status === 'new'){
    /* Booked from a customer's file: ONE Accept, onto that file. With "Accept — new customer"
       under it, the owner's first real one (Rj tan, 2026-09-28) went onto a second file of the
       same person, his own file showed no job, and he booked it again. */
    acts = (mine ? `<button type="button" class="b primary wide" data-act="accept" data-id="${esc(b.id)}" data-link="${esc(mine.id)}">Accept — on ${esc(mine.full_name)}’s file</button>`
      : `<button type="button" class="b primary wide" data-act="accept" data-id="${esc(b.id)}">Accept — new customer</button>
      ${same.map(c => `<button type="button" class="b wide" data-act="accept" data-id="${esc(b.id)}" data-link="${esc(c.id)}">Accept — same as ${esc(c.full_name)}</button>`).join('')}`)
      + `<button type="button" class="b danger wide" data-act="open" data-kind="reject" data-id="${esc(b.id)}">Reject…</button>`;
  } else if (b.status === 'accepted' && !job){
    acts = `<button type="button" class="b primary wide" data-act="makejob" data-id="${esc(b.id)}">Make the job</button>`;
  } else if (job){
    acts = `<button type="button" class="b wide" data-act="open" data-kind="job" data-id="${esc(job.id)}">Open the job ›</button>`;
  }
  return {title: b.full_name, sub: b.ref + ' · ' + (b.source === 'office' ? 'booked by phone ' : 'booked ') + timeAgo(b.created_at), body: `
    ${stepsHtml({booking: b, job})}
    <div class="card" data-row="${esc(b.id)}" data-stamp="${esc(b.updated_at || '')}">
      ${kv('Status', statusPill(b.status) + unsentPill(b.id))}
      ${kv('Wants', esc(b.preferred_on ? niceDate(b.preferred_on) + ', ' + slotWord(b.slot) : 'No day yet'))}
      ${kv('Number', esc(b.contact))}
      ${kv('Address', esc(b.address))}
      ${kv('Landmark', esc(b.landmark || ''))}
      ${kv('Notes', b.notes ? esc(b.notes) : '')}
      ${kv('Why rejected', esc(b.reject_reason || ''))}
      <div class="actions">${callBtn(b.contact)}${mapBtn(b)}${['new', 'accepted'].includes(b.status) && !job ? editBtn('editbooking', b.id) : ''}</div>
    </div>
    <div class="sec">🛒 Aircons &amp; appliances</div>
    ${cartHtml('view', unitsOf(b), {pf: officePrice, missing: 'Not every service has a price yet'})}
    ${b.quote ? `<p class="hint">That is the price list’s. The quotation says <b>${esc(peso(b.quote.total))}</b>, and Accept uses it.</p>` : ''}
    <div class="menu">
      ${b.status === 'new' || b.quote ? menuRow('quote', b.id, '📄', 'Quotation', b.quote
        ? 'Saved ' + niceDate(manilaDay(b.quote.saved_at)) + ' · ' + peso(b.quote.total)
        : 'Make one to send — print it or save it as a PDF') : ''}
      ${menuRow('bookingstatus', b.id, ico('status'), 'Full status', 'As the customer sees it · Copy summary')}
      ${db.role === 'admin' ? menuRow('delbooking', b.id, '🗑️', 'Delete this booking', (job ? 'With its job. ' : '') + 'You will be warned first.', 'is-danger') : ''}
    </div>
    ${same.length && !mine ?`<p class="hint">Same number as ${same.map(c => esc(c.full_name) + ' (' + esc(c.address) + ')').join('; ')} — accept as the same customer so their history stays in one place.</p>` : ''}
    ${b.status === 'new' && b.quote ? `<label>Price for the job <span class="opt">— optional; the quotation says ${esc(peso(b.quote.total))}</span>
      <input data-pf="price" inputmode="decimal" maxlength="14" value="${esc(p.price || '')}" placeholder="${esc(String(b.quote.total))}" autocomplete="off"></label>
      <p class="hint">Accept makes ${mine ? 'the job on ' + esc(mine.full_name) + '’s file' : 'the customer and the job in one go'}, with this price — or the quotation’s, left blank.</p>`
    : b.status === 'new' ? `<label>Price for the job <span class="opt">— optional${listPrice != null ? '; the price list says ' + esc(peso(listPrice)) : ''}</span>
      <input data-pf="price" inputmode="decimal" maxlength="14" value="${esc(p.price || '')}" placeholder="${listPrice != null ? esc(String(listPrice)) : 'e.g. 1500'}" autocomplete="off"></label>
      <p class="hint">Accept makes ${mine ? 'the job on ' + esc(mine.full_name) + '’s file' : 'the customer and the job in one go'}, with this price${listPrice != null ? ' — or the price list’s, left blank' : ''}.</p>` : ''}
    <div class="stack">${acts}</div>
    ${statusBlockHtml('booking', b.id)}`};
}
/* Edit a booking: the customer's whole form on the customer's photo, filled in from the
   booking — name to "anything else" (ui.md, Reuse). */
function panelEditBooking(p){
  const b = db.bookings[p.id];
  if (!b) return {title: 'Edit', body: empty('This booking is no longer on this phone.')};
  // a booking by phone may have no day yet (26); the page's always has one
  const phone = b.source === 'office';
  if (!p._init) Object.assign(p, {_init: true, mode: 'edit', _saveAct: 'editbooking', _needDate: !phone, _notYetOk: phone,
    full_name: b.full_name || '', contact: b.contact || '', address: b.address || '', landmark: b.landmark || '',
    lat: b.lat != null ? String(b.lat) : '', lng: b.lng != null ? String(b.lng) : '',
    units: unitsOf(b).map(u => ({...u, services: [...u.services]})), notes: b.notes || '',
    date: b.preferred_on || '', slot: b.slot || 'am', _origDate: b.preferred_on || '', _origSlot: b.slot || 'am'});
  return {title: 'Edit the booking', sub: b.full_name + ' · ' + b.ref, info: 'editbooking',
    body: heroFormHtml('edit', p, bookFormHtml('panel', p))};
}
function panelReject(p){
  const b = db.bookings[p.id];
  if (!b) return {title: 'Reject', body: empty('This booking is no longer on this phone.')};
  return {title: 'Reject ' + b.ref, sub: b.full_name, body: `
    <label>Why <span class="opt">— optional; empty says “No reason”</span>
      <input data-pf="why" maxlength="300" value="${esc(p.why || '')}"></label>
    <div class="stack"><button type="button" class="b danger wide" data-act="reject" data-id="${esc(b.id)}">Reject this booking</button></div>`};
}

/* ---------------------------------------------------------------- jobs */
function jobDayFilter(j, day){
  const today = manilaDate(0);
  if (day === 'today') return j.scheduled_on === today && j.status !== 'cancelled';
  if (day === 'tomorrow') return j.scheduled_on === manilaDate(1) && j.status !== 'cancelled';
  if (day === 'unplanned') return !j.scheduled_on && !['done', 'cancelled'].includes(j.status);
  if (day === 'done') return j.status === 'done';
  if (day === 'cancelled') return j.status === 'cancelled';
  // upcoming: every job from today on, done ones too — Today and Tomorrow show those, and
  // "Tomorrow (4)" beside "Upcoming (3)" read as a job gone missing (R3, 2026-09-27)
  return j.scheduled_on >= today && j.status !== 'cancelled';
}
function jobList(day){
  const rows = Object.values(db.jobs).filter(j => jobDayFilter(j, day));
  return ['done', 'cancelled'].includes(day) ? rows.sort(byDoneDesc).slice(0, 60) : rows.sort(byTime);
}
/* L4 (Guile, 2026-09-27, ui.md Reuse): the office's Jobs and the technician's Jobs were two
   copies of one tab strip — the technician's had no Cancelled. One function draws both. Since
   38 (Guile, 2026-10-03) technicians and helpers get the jobs with no day too, so every tab
   is everyone's. */
const JOB_TABS = [['today', 'Today'], ['tomorrow', 'Tomorrow'], ['unplanned', 'No date'], ['all', 'Upcoming'],
                  ['done', 'Done'], ['cancelled', 'Cancelled']];
function jobTabsHtml(){
  // the admin's View as (37) draws the field's tabs on the admin's own day
  const tech = inField(viewRole()), key = db.role === 'admin' ? 'day' : 'techDay';
  const days = JOB_TABS;
  if (!days.some(d => d[0] === ui[key])) ui[key] = 'today';
  const n = k => ['done', 'cancelled'].includes(k) ? 0 : Object.values(db.jobs).filter(j => jobDayFilter(j, k)).length;
  const rows = jobList(ui[key]);
  // a helper has no map (37)
  return chips(key === 'day' ? 'day' : 'techday', days.map(([k, t]) => [k, t, n(k)]), ui[key]) + (viewRole() === 'helper' ? '' : routeBar(ui[key])) + (tech ? '' : textAllBar(ui[key])) +
    (rows.length ? `<div class="list">${rows.map(jobRow).join('')}</div>` : empty('No jobs here.'));
}
function drawJobs(){ return jobTabsHtml(); }
/* Idea 2 (2026-09-27): the day's jobs in order — morning first — on the map, and all of
   them in one Google Maps trip. Only jobs still to do; a stop is its pin, or its address. */
const stopOf = c => c.lat != null && c.lng != null ? c.lat + ',' + c.lng
  : [c.address, c.landmark, 'Bacolod'].filter(Boolean).join(', ');
function routeStops(day){
  if (!['today', 'tomorrow'].includes(day)) return [];
  return jobList(day).filter(j => !['done', 'cancelled'].includes(j.status))
    .filter(j => { const c = jobCust(j); return c.address && c.address !== '(removed)'; });
}
function routeUrl(stops){
  const s = stops.slice(0, 10).map(j => stopOf(jobCust(j)));   // Google takes 9 stops plus the end
  const dest = s.pop();
  return 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + encodeURIComponent(dest)
    + (s.length ? '&waypoints=' + encodeURIComponent(s.join('|')) : '');
}
function routeBar(day){
  const stops = routeStops(day); if (!stops.length) return '';
  return `<div class="route-bar"><span>${stops.length} stop${stops.length === 1 ? '' : 's'}, morning first</span>
    <button type="button" class="b" data-act="routemap" data-v="${esc(day)}">🗺️ Route</button>
    <a class="b primary" target="_blank" rel="noopener" href="${esc(routeUrl(stops))}">Open in Google Maps</a>
    ${stops.length > 10 ? '<span class="hint">Google Maps takes the first 10.</span>' : ''}</div>`;
}
/* The money badge (Guile, 2026-09-28: "very important on the eyes of the owner"): every open
   job — Not scheduled, Scheduled, In progress, Done — says Not paid in red until the office
   marks it (TODO 12, option A); GCash in blue; cash or other, Paid in green. Since 37 (Guile,
   2026-10-03) technicians and helpers see it too, to read — only the office marks it. */
function paidPill(j){
  if (!db || !(db.role === 'admin' || inField(db.role)) || !j || j.status === 'cancelled') return '';
  if (j.paid_method === 'gcash') return pill('gcash', 'GCash');
  if (j.paid_method) return pill('paid', 'Paid');
  return pill('unpaid', 'Not paid');
}
function jobRow(j){
  const c = jobCust(j);
  return `<div class="lrow" role="button" tabindex="0" data-act="open" data-kind="job" data-id="${esc(j.id)}" data-stamp="${esc(j.updated_at || '')}">
    <div class="lrow-when">${j.scheduled_on
      ? `<b>${esc(slotShort(j.slot))}</b><span>${esc(shortDate(j.scheduled_on))}</span>`
      : '<b>—</b><span>no date</span>'}</div>
    <div class="lrow-main">
      <div class="lrow-title">${newDot(jobUnseen(j))}${esc(c.full_name || '…')}${unsentPill(j.id)}</div>
      <div class="lrow-sub">${esc([unitsLine(unitsOf(j)), svcList(j.services)].filter(Boolean).join(' — '))}</div>
      <div class="lrow-sub">${esc(place(c))}</div>
      ${miniSteps({booking: bookingOfJob(j), job: j})}
    </div>
    <div class="lrow-side">${paidPill(j)}${statusPill(j.status)}${j.price != null && seesPrice() ? `<span class="lrow-price">${esc(peso0(j.price))}</span>` : ''}</div>
  </div>`;
}
function panelJob(p){
  const j = db.jobs[p.id];
  if (!j) return {title: 'Job', body: empty('This job is no longer on this phone.')};
  // the field's screen, for them and for the admin's View as (37); a helper's is less again:
  // no buttons that act, nothing that rings, maps or edits, no history (Guile, 2026-10-03)
  const v = viewRole(), tech = inField(v), helper = v === 'helper';
  const c = jobCust(j), open = !['done', 'cancelled'].includes(j.status);
  const acts = [];
  // idea 1: on the way there — before Start, once, while the job has a day
  if (['booked', 'scheduled'].includes(j.status) && j.scheduled_on && !j.on_way_at)
    acts.push(`<button type="button" class="b" data-act="onway" data-id="${esc(j.id)}">🚐 On my way</button>`);
  if (['booked', 'scheduled'].includes(j.status) && (!tech || j.scheduled_on))
    acts.push(`<button type="button" class="b primary" data-act="status" data-to="in_progress" data-id="${esc(j.id)}">▶ Start the job</button>`);
  if (open && (!tech || j.scheduled_on))
    acts.push(`<button type="button" class="b primary" data-act="status" data-to="done" data-id="${esc(j.id)}">✓ Mark done</button>`);
  // a job with no day is the field's to see, not to change (38): the server refuses it
  const canUndo = tech ? !!j.scheduled_on && ['in_progress', 'done'].includes(j.status) : ['in_progress', 'done', 'cancelled'].includes(j.status);
  if (canUndo) acts.push(`<button type="button" class="b" data-act="undo" data-id="${esc(j.id)}">↶ Undo last step</button>`);
  if (helper) acts.length = 0;
  const by = whoPressed(j);
  const cid = j.customer_id, photo = c.photo_path;
  // No "Change the time" row: ✏️ Edit changes the day with everything else (Guile, 2026-09-27)
  // L5: a technician sees the price only with the office's switch on — the server sends it
  // then and only then — and gives the receipt from it
  const techPrice = tech && j.price != null && seesPrice();
  const menu = helper ? '' : tech ? (techPrice ?`<div class="menu">${menuRow('receipt', j.id, '🧾', 'Receipt', 'Print or share it with the customer')}</div>` : '') : `<div class="menu">
      ${menuRow('price', j.id, '₱', j.price != null ? 'Change the price' : 'Set the price', j.price != null ? peso(j.price) : 'Not set yet')}
      ${open || j.quote ? menuRow('jobquote', j.id, '📄', 'Quotation', j.quote
        ? 'Saved ' + niceDate(manilaDay(j.quote.saved_at)) + ' · ' + peso(j.quote.total)
        : 'Make one to send — its total becomes the price') : ''}
      ${custOf(j.customer_id) ? menuRow('customer', j.customer_id, '👤', 'Customer’s history', c.full_name) : ''}
      ${menuRow('receipt', j.id, '🧾', 'Receipt', 'Print on A4')}
      ${open ? menuRow('cancel', j.id, '✕', 'Cancel the job', 'You will be asked why', 'is-danger') : ''}
      ${menuRow('deljob', j.id, '🗑️', 'Delete this job', (bookingOfJob(j) ? 'With its booking. ' : '') + 'You will be warned first.', 'is-danger')}
    </div>`;
  // L3: the gate photo first on a technician's screen — the first thing needed at the street
  return {title: c.full_name || 'Job', sub: svcList(j.services), body: `
    ${tech && !helper && photo ? `<div class="gate-top">${housePhoto(photo)}<div class="gate-cap">📷 The gate — to find the house</div></div>` : ''}
    ${stepsHtml({booking: bookingOfJob(j), job: j})}
    ${techPrice && !helper ? `<div class="big-price"><span>To collect when the job is done</span><b>${esc(peso(j.price))}</b></div>` : ''}
    <div class="card" data-row="${esc(j.id)}" data-stamp="${esc(j.updated_at || '')}">
      ${photo && !tech ? housePhoto(photo) : ''}
      ${kv('Status', paidPill(j) + ' ' + statusPill(j.status) + unsentPill(j.id) + (by && ['in_progress', 'done', 'cancelled'].includes(j.status) ? ` <span class="muted">by ${esc(by)}</span>` : ''))}
      ${j.on_way_at && ['booked', 'scheduled'].includes(j.status) ? kv('On the way', esc('since ' + new Date(j.on_way_at).toLocaleTimeString('en-PH', {hour: 'numeric', minute: '2-digit'}))) : ''}
      ${kv('When', esc(j.scheduled_on ? niceDate(j.scheduled_on) + ', ' + slotWord(j.slot) : 'No date yet'))}
      ${kv('Number', esc(c.contact || ''))}
      ${kv('Address', esc(c.address || ''))}
      ${kv('Landmark', esc(c.landmark || ''))}
      ${kv('Notes', j.notes ? esc(j.notes) : '')}
      ${tech ? (helper && techPrice ? kv('Price', esc(peso(j.price))) : '') : kv('Price', esc(j.price != null ? peso(j.price) : 'Not set yet'))}
      ${tech || j.status === 'cancelled' ? '' : `<div class="paid-row">${j.paid_method
        ? `<span class="pill done">Paid · ${esc(PAY[j.paid_method])}${j.paid_at ? ' · ' + esc(shortDate(manilaDay(j.paid_at))) : ''}</span>
           <button type="button" class="b" data-act="paid" data-id="${esc(j.id)}" data-v="">Not paid</button>`
        : `<span class="muted">Not paid yet</span>${['cash', 'gcash', 'other'].map(m =>
            `<button type="button" class="b" data-act="paid" data-id="${esc(j.id)}" data-v="${m}">${m === 'cash' ? '💵 Cash' : m === 'gcash' ? '📱 GCash' : 'Other'}</button>`).join('')}`}</div>`}
      ${j.status === 'done' && j.done_at ? kv('Done', esc(new Date(j.done_at).toLocaleString('en-PH', {dateStyle: 'medium', timeStyle: 'short'}))) : ''}
      ${j.status === 'cancelled' && !helper ? kv('Why cancelled', esc(j.cancel_reason || '')) : ''}
      ${helper ? '' : `<div class="actions">${callBtn(c.contact)}${tech ? '' : textBtn(j)}${mapBtn(c)}${cid && c.full_name !== '(removed)' && (!tech || j.scheduled_on) ? photoBtn(cid, photo) : ''}${!tech || (j.scheduled_on && j.status !== 'cancelled') ? editBtn('editjob', j.id) : ''}</div>`}
    </div>
    ${tech ? '' : wantNote(j)}
    ${tech ? '' : textsDoneHtml(j)}
    ${acts.length ? `<div class="actions fill">${acts.join('')}</div>` : ''}
    <div class="sec">🛒 Aircons &amp; appliances</div>
    ${cartHtml('view', unitsOf(j), {pf: helper || (tech && !techPrice) ? null : officePrice, missing: 'Not every service has a price yet'})}
    ${tech ? '' : listPriceNote(j)}
    ${prepHtml(j)}
    ${helper ? '' : `<div class="menu">${menuRow('jobstatus', j.id, ico('status'), 'Full status', 'As the customer sees it · Copy summary')}</div>`}
    ${menu}
    ${helper ? '' : statusBlockHtml('job', j.id)}`};
}
/* ---------------------------------------------------------------- what to bring (37)
   Guile, 2026-10-03: "so that the helper know what to do and what to bring and they dont
   forget it … also it lessen the things to bring on the service truck". The owner's list for
   each of the job's services (Admin → Services & prices), in his order, twins once; then what
   was added on this job — it stays on this job. Anyone of the shop ticks; a tick says who:
   "Checked by Guile (Technician)". A tick is keyed by the item's words, lower-cased. */
const prepKey = t => String(t || '').trim().toLowerCase();
function prepItems(j){
  const keys = new Set([...(j.services || []), ...unionServices(unitsOf(j))]);
  const seen = new Set(), out = [];
  const add = (text, extra) => { const k = prepKey(text); if (k && !seen.has(k)){ seen.add(k); out.push({text, key: k, extra}); } };
  (db.checklists || []).filter(l => keys.has(l.key)).forEach(l => (l.items || []).forEach(t => add(t)));
  ((j.prep || {}).extra || []).forEach(x => add(x.text, x));
  return out;
}
/* An add box (37): a redraw waits while a box is being typed in (keepTyping), and Enter leaves
   the cursor there — so let go, redraw, and put the cursor back, empty, for the next item. */
function againTyping(pf, draw){
  const a = document.activeElement, was = a && a.dataset && a.dataset.pf === pf;
  if (was) a.blur();
  draw();
  if (was){ const i = $$(`[data-pf="${pf}"]`, $('#panels')).pop(); if (i){ i.value = ''; i.focus(); } }   // the top panel's
}
const prepWho = x =>esc(x.name || 'Someone') + ' (' + esc(ROLE_NAME[x.role] || x.role || '') + ')';
function prepHtml(j){
  if (!db.checklists) return '';   // a server from before 37
  const items = prepItems(j), ticks = (j.prep || {}).ticks || {};
  const n = items.filter(i => ticks[i.key]).length, id = esc(j.id);
  const p = topPanel() || {};
  return `<div class="sec">🧰 What to bring${items.length ? ` <span class="prep-count${n === items.length ? ' all' : ''}">${n} of ${items.length}</span>` : ''}</div>
    <div class="card prep">
      ${items.map(i => { const t = ticks[i.key];
        return `<div class="prep-row${t ? ' ticked' : ''}">
          <button type="button" class="prep-tick" role="checkbox" aria-checked="${t ? 'true' : 'false'}" data-act="prep" data-id="${id}" data-do="${t ? 'untick' : 'tick'}" data-v="${esc(i.text)}">
            <span class="prep-box" aria-hidden="true">${t ? '✓' : ''}</span>
            <span class="prep-main"><span class="prep-text">${esc(i.text)}</span>
              ${t ? `<span class="prep-by">Checked by ${prepWho(t)}</span>`
                  : i.extra ? `<span class="prep-by">Added for this job by ${prepWho(i.extra)}</span>` : ''}</span>
          </button>
          ${i.extra ? `<button type="button" class="cart-x" data-act="prep" data-id="${id}" data-do="remove" data-v="${esc(i.text)}" aria-label="Take ${esc(i.text)} off this job">×</button>` : ''}
        </div>`; }).join('')
        || `<p class="hint">Nothing listed for these services yet.${db.role === 'admin' ? ' The lists are in Admin → Services &amp; prices.' : ''}</p>`}
      <div class="prep-add"><input data-pf="prepNew" maxlength="60" value="${esc(p.prepNew || '')}" placeholder="Add something for this job" autocomplete="off">
        <button type="button" class="b" data-act="prepadd" data-id="${id}">＋ Add</button></div>
    </div>`;
}
function prepWrite(id, how, text){
  const j = db.jobs[id]; if (!j) return;
  const words = {tick: 'Checked', untick: 'Unchecked', add: 'Added', remove: 'Took off'}[how];
  write('job_prep', {p_job: id, p_do: how, p_item: text}, words + ' — ' + text, [id], db => {
    const x = db.jobs[id]; if (!x) return;
    const prep = x.prep = {ticks: {...((x.prep || {}).ticks || {})}, extra: [...((x.prep || {}).extra || [])]};
    const me = {by: session.uid, name: (db.profile && db.profile.display_name) || 'Someone', role: db.role, at: new Date().toISOString()};
    const k = prepKey(text);
    if (how === 'tick') prep.ticks[k] = me;
    if (how === 'untick' || how === 'remove') delete prep.ticks[k];
    if (how === 'add' && !prep.extra.some(e => prepKey(e.text) === k)) prep.extra.push({text: text.trim(), ...me});
    if (how === 'remove') prep.extra = prep.extra.filter(e => prepKey(e.text) !== k);
  });
}

/* R1 (2026-09-27): Accept makes the job with no day, though the customer already chose one
   — WA-1970 asked for Mon Sep 28 PM and the day had to be picked again. Offer theirs. */
function wantOf(j){
  const b = bookingOfJob(j);
  if (!b || !b.preferred_on || j.scheduled_on || ['done', 'cancelled'].includes(j.status)) return null;
  return {on: b.preferred_on, slot: b.slot || 'am', past: b.preferred_on < manilaDate(0)};
}
function wantNote(j){
  const w = wantOf(j); if (!w) return '';
  const day = niceDate(w.on) + ', ' + slotWord(w.slot);
  return `<div class="inline-note"><span>${w.past
      ? `They asked for <b>${esc(day)}</b> — that day has passed. Choose one with ✏️ Edit.`
      : `No day yet. They asked for <b>${esc(day)}</b>.`}</span>${w.past ? ''
      : `<button type="button" class="b" data-act="usewant" data-id="${esc(j.id)}">Use their day</button>`}</div>`;
}
/* The job's price is frozen; the list above adds up today's aircons. When the two differ —
   an aircon added to a running job, say — the screen showed ₱1,800 and ₱3,300 with nothing
   between them (scenario test, 2026-09-27). Say so, and offer the list's in one tap. */
const listNow = j => unitsPrice(unitsOf(j), officePrice);
function listPriceNote(j){
  const l = listNow(j);
  if (l == null || !['booked', 'scheduled', 'in_progress', 'done'].includes(j.status)) return '';
  if (j.price != null && Math.abs(Number(j.price) - l) < 0.01) return '';
  // one span: .inline-note is a flex row, and each <b> on its own became a spaced-out piece
  return `<div class="inline-note"><span>${j.price != null
      ? `The price list says <b>${esc(peso(l))}</b> for these aircons; this job’s price is <b>${esc(peso(j.price))}</b>.`
      : `This job has no price yet; the price list says <b>${esc(peso(l))}</b>.`}</span>
    <button type="button" class="b" data-act="uselist" data-id="${esc(j.id)}">Use ${esc(peso(l))}</button></div>`;
}
function panelSchedule(p){
  const j = db.jobs[p.id];
  if (!j) return {title: 'Schedule', body: empty('This job is no longer on this phone.')};
  if (p.date == null){ p.date = j.scheduled_on || ''; p.slot = j.slot || 'am'; }
  const word = j.scheduled_on ? 'Change the time' : 'Schedule it';
  // the booking form's own day-and-time piece (ui.md, Reuse)
  return {title: word, sub: jobCust(j).full_name, body: `
    ${bkWhenHtml('panel', p, {notYet: false})}
    <div class="stack"><button type="button" class="b primary wide" data-act="schedule" data-id="${esc(j.id)}">${word}</button></div>`, info: 'schedule'};
}
function panelPrice(p){
  const j = db.jobs[p.id];
  if (!j) return {title: 'Price', body: empty('This job is no longer on this phone.')};
  return {title: j.price != null ? 'Change the price' : 'Set the price', sub: jobCust(j).full_name, body: `
    <label>Price agreed with the customer, in pesos
      <input data-pf="price" inputmode="decimal" placeholder="1500" value="${esc(p.price != null ? p.price : (j.price != null ? j.price : ''))}"></label>
    <div class="stack"><button type="button" class="b primary wide" data-act="price" data-id="${esc(j.id)}">Save the price</button></div>`};
}
function panelCancel(p){
  const j = db.jobs[p.id];
  if (!j) return {title: 'Cancel', body: empty('This job is no longer on this phone.')};
  return {title: 'Cancel the job', sub: jobCust(j).full_name, body: `
    <label>Why <span class="opt">— optional; empty says “No reason”</span>
      <input data-pf="why" maxlength="300" value="${esc(p.why || '')}" placeholder="Customer cancelled, no parts…"></label>
    <div class="stack"><button type="button" class="b danger wide" data-act="cancel" data-id="${esc(j.id)}">Cancel this job</button></div>`, info: 'cancel'};
}
/* Delete a job or a booking, whatever its status (31, the owner via Guile, 2026-10-01). A job
   and the booking it came from go together — half a pair shows on the customer's My bookings
   as a booking with no job. The customer's file stays. Warned, then a tick, as Delete customer. */
function workPair(p){
  const j = p.kind === 'deljob' ? db.jobs[p.id] : Object.values(db.jobs).find(x => x.booking_id === p.id);
  const b = p.kind === 'deljob' ? bookingOfJob(j) : db.bookings[p.id];
  return {j: j || null, b: b || null};
}
function panelDelete(p){
  const {j, b} = workPair(p), job = p.kind === 'deljob';
  if (!(job ? j : b)) return {title: 'Delete', body: empty('This is no longer on this phone.')};
  const name = (j && jobCust(j).full_name) || (b && b.full_name) || '';
  const what = j && b ? 'This job and its booking ' + b.ref : j ? 'This job' : 'Booking ' + b.ref;
  const warn = [];
  if (j && j.status === 'in_progress') warn.push('A technician has started it.');
  else if (j && ['booked', 'scheduled'].includes(j.status) && j.scheduled_on)
    warn.push('It is on ' + niceDate(j.scheduled_on) + ' — it leaves the technicians’ phones too.');
  if (j && j.status === 'done') warn.push('It is done' + (j.paid_method ? ' and paid' : '') + ' — Numbers stop counting it.');
  if (b && b.source === 'page') warn.push('The weekly count of bookings from the page drops it.');
  if ((b && b.quote) || (j && j.quote)) warn.push('Its quotation goes too.');
  if (b && b.account_id) warn.push('It leaves the customer’s own My bookings.');
  return {title: job ? 'Delete the job' : 'Delete the booking', sub: name, body: `
    <div class="inline-note"><span>⚠️ <b>${esc(what)}</b>${name ? ' for <b>' + esc(name) + '</b>' : ''}
      ${j && b ? 'are' : 'is'} deleted with ${j && b ? 'their' : 'its'} history — from every phone.
      ${esc(warn.join(' '))} ${(j && j.customer_id) || (b && b.customer_id) ? 'The customer’s file stays.' : ''}
      <b>This cannot be undone.</b></span></div>
    <label class="tick"><input type="checkbox" data-pf="ok" ${p.ok ? 'checked' : ''}> Yes, delete it</label>
    <div class="stack"><button type="button" class="b danger wide" data-act="delwork" data-id="${esc(p.id)}">Delete for good</button></div>`};
}

/* ---------------------------------------------------------------- customers */
function custList(){
  const q = (ui.search || '').toLowerCase().trim();
  return Object.values(db.customers)
    .filter(c => !q || (c.full_name + ' ' + c.contact + ' ' + c.address).toLowerCase().includes(q)
                    || (digits(q) && digits(c.contact).includes(digits(q))))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
}
function custListHtml(){
  const list = custList();
  return `<p class="count">${list.length} customer${list.length === 1 ? '' : 's'}</p>` +
    (list.length ? `<div class="list">${list.map(custRow).join('')}</div>`
                 : empty((ui.search || '').trim() ? 'Nobody matches that.' : 'No customers yet.'));
}
function drawPeople(){
  const pinned = Object.values(db.customers).filter(c => c.lat != null && c.full_name !== '(removed)').length;
  return `<div class="menu"><button type="button" class="menu-row" data-act="custmap">
      <span class="menu-ico">🗺️</span><span class="menu-main"><span class="menu-title">Customers on the map</span>
      <span class="menu-sub">${pinned} pinned · days since each one's last visit</span></span><span class="menu-chev">›</span></button></div>
    <input type="search" class="find" id="custSearch" placeholder="🔎 Name, number or address" value="${esc(ui.search || '')}" autocomplete="off">
    <div id="custList">${custListHtml()}</div>
    <div class="menu">${menuRow('tidy', '', '🧹', 'Tidy up old bookings', 'Delete rejected and cancelled ones')}</div>`;
}
function custRow(c){
  const n = jobsOf(c.id).length;
  return `<div class="lrow" role="button" tabindex="0" data-act="open" data-kind="customer" data-id="${esc(c.id)}" data-stamp="${esc(c.updated_at || '')}">
    <div class="avatar">${esc(initials(c.full_name))}</div>
    <div class="lrow-main"><div class="lrow-title">${esc(c.full_name)}${unsentPill(c.id)}</div>
      <div class="lrow-sub">${esc(c.contact)} · ${esc(c.address)}</div></div>
    <div class="lrow-side"><span class="lrow-time">${n} job${n === 1 ? '' : 's'}</span></div>
  </div>`;
}
function panelCustomer(p){
  const c = db.customers[p.id];
  if (!c) return {title: 'Customer', body: empty('This customer is no longer on this phone.')};
  const jobs = jobsOf(c.id).sort(byTime).reverse();
  const bookings = Object.values(db.bookings).filter(b => b.customer_id === c.id).sort((a, b) => a.created_at < b.created_at ? 1 : -1);
  const k = checkupOf(c), today = manilaDate(0);
  const cu = !k ? '' : k.busy && k.due <= today ? 'Due — but a job is already booked'
    : k.due <= today ? 'Due now — in Check-ups' : 'Next ' + niceDate(k.due);
  const removed = c.full_name === '(removed)';
  return {title: c.full_name, sub: c.contact, body: `
    <div class="card" data-row="${esc(c.id)}" data-stamp="${esc(c.updated_at || '')}">
      ${c.photo_path ? housePhoto(c.photo_path) : ''}
      ${kv('Number', esc(c.contact))}
      ${kv('Address', esc(c.address))}
      ${kv('Landmark', esc(c.landmark || ''))}
      ${kv('Customer since', esc(c.created_at ? new Date(c.created_at).toLocaleDateString('en-PH', {day: 'numeric', month: 'short', year: 'numeric'}) : ''))}
      <div class="actions">${callBtn(c.contact)}${mapBtn(c)}${removed ? '' : photoBtn(c.id, c.photo_path)}</div>
    </div>
    ${removed ? '' : `<div class="stack"><button type="button" class="b primary wide" data-act="book" data-id="${esc(c.id)}">+ New job for ${esc(c.full_name.split(' ')[0])}</button></div>
    <div class="sec">📅 Regular check${cu ? ` <span class="plan-now${k && k.due <= today ? ' due' : ''}">${esc(cu)}</span>` : ''}</div>
    <div class="card">${checkPlanHtml(c.id, c.check_every, c.check_next, c.check_day)}</div>`}
    ${airconHistoryHtml(c.id)}
    <div class="sec">Jobs</div>
    ${jobs.length ? `<div class="list">${jobs.map(jobRow).join('')}</div>` : empty('No jobs yet.')}
    <div class="sec">Bookings</div>
    ${bookings.length ? `<div class="list">${bookings.map(bookingRow).join('')}</div>` : empty('None.')}
    <div class="menu">${menuRow('forget', c.id, '🗑️', 'Delete this customer', 'With their bookings and jobs. Cannot be undone.', 'is-danger')}</div>`};
}
function panelForget(p){
  const c = db.customers[p.id];
  if (!c) return {title: 'Delete customer', body: empty('This customer is no longer on this phone.')};
  // 22 (Guile, 2026-09-27): delete means gone — not "(removed) 0000000"
  const js = jobsOf(c.id), bs = Object.values(db.bookings).filter(b => b.customer_id === c.id);
  const n = (k, w) => k + ' ' + w + (k === 1 ? '' : 's');
  return {title: 'Delete customer', sub: c.full_name, body: `
    <p class="hint" style="font-size:14px"><b>${esc(c.full_name)}</b> is deleted with ${esc(n(bs.length, 'booking'))},
      ${esc(n(js.length, 'job'))}, their history and their gate photo — from every phone. Numbers stop
      counting those jobs. <b>This cannot be undone.</b> A job on today or in progress stops it.</p>
    <label class="tick"><input type="checkbox" data-pf="ok" ${p.ok ? 'checked' : ''}> Yes, delete ${esc(c.full_name)}</label>
    <div class="stack"><button type="button" class="b danger wide" data-act="forget" data-id="${esc(c.id)}">Delete for good</button></div>`};
}
function panelTidy(p){
  return {title: 'Tidy up old bookings', body: `
    <p class="hint" style="font-size:14px">Deletes rejected and cancelled bookings older than the number
      of days you choose — <b>0 deletes all of them</b>, today's too. Accepted bookings stay: their
      jobs point to them. To delete a customer with everything, open them → Delete this customer.</p>
    <label>Older than (days) <input data-pf="days" inputmode="numeric" value="${esc(p.days != null ? p.days : '0')}"></label>
    <label class="tick"><input type="checkbox" data-pf="ok" ${p.ok ? 'checked' : ''}> Yes, delete them</label>
    <div class="stack"><button type="button" class="b danger wide" data-act="tidy">Delete rejected and cancelled bookings</button></div>`};
}

/* Idea 9: each aircon's own history, across jobs. An aircon has no serial number here, so
   it is known by its type, brand and model and its place among its twins ("Split #2"). */
function airconHistory(cid){
  const byKey = {};
  jobsOf(cid).filter(j => j.status === 'done' && j.done_at).sort(byDoneDesc).reverse().forEach(j => {
    const seen = {};
    unitsOf(j).forEach(u => {
      const base = [u.type || 'Aircon', (u.brand || '').trim().toLowerCase(), (u.model || '').trim().toLowerCase()].join('|');
      seen[base] = (seen[base] || 0) + 1;
      const key = base + '|' + seen[base], day = manilaDay(j.done_at);
      const h = byKey[key] || (byKey[key] = {type: u.type || 'Aircon', meta: [u.brand, u.model].filter(Boolean).join(' · '), n: seen[base], last: {}});
      u.services.forEach(k => { h.last[k] = day; });
      h.lastDone = day;
    });
  });
  const list = Object.values(byKey);
  const count = {}; list.forEach(h => { count[h.type] = (count[h.type] || 0) + 1; h.name = typeLabel(h.type) + ' #' + count[h.type]; });
  return list;
}
function airconHistoryHtml(cid){
  const list = airconHistory(cid); if (!list.length) return '';
  return `<div class="sec">🛒 Their aircons</div><div class="list">${list.map(h => `<div class="lrow flat">
      <div class="lrow-main"><div class="lrow-title">${esc(h.name)}${h.meta ? ` <span class="muted">${esc(h.meta)}</span>` : ''}</div>
      <div class="lrow-sub">${esc(Object.entries(h.last).map(([k, d]) => svcLabel(k) + ' ' + shortDate(d) + ' (' + daysAgo(d) + ')').join(' · '))}</div></div></div>`).join('')}</div>`;
}
/* The aircon whose last cleaning is oldest — what the check-up call is about. */
function oldestClean(cid){
  const list = airconHistory(cid).map(h => ({h, d: h.last.clean || h.lastDone})).sort((a, b) => a.d.localeCompare(b.d));
  return list[0] || null;
}

/* ---------------------------------------------------------------- check-ups */
/* Idea 11: a week after a job is done the office rings — "is it working well?". Jobs done 6
   to 30 days ago, not yet called. */
function followups(){
  const today = manilaDate(0);
  return Object.values(db.jobs).filter(j => j.status === 'done' && j.done_at && !j.followup_at)
    .filter(j => { const n = daysSince(manilaDay(j.done_at)); return n >= 6 && n <= 30; })
    .filter(j => { const c = jobCust(j); return c.full_name && c.full_name !== '(removed)'; })
    .sort((a, b) => a.done_at < b.done_at ? -1 : 1);
}
function followupHtml(){
  const list = followups(); if (!list.length) return '';
  return `<div class="sec">☎️ A week after the job</div><div class="list">${list.map(j => { const c = jobCust(j), d = manilaDay(j.done_at);
    return `<div class="lrow col"><div class="lrow-top" role="button" tabindex="0" data-act="open" data-kind="job" data-id="${esc(j.id)}">
        <div class="avatar">${esc(initials(c.full_name))}</div>
        <div class="lrow-main"><div class="lrow-title">${esc(c.full_name)}${unsentPill(j.id)}</div>
          <div class="lrow-sub">Done ${esc(shortDate(d))} · ${esc(daysAgo(d))} — ${esc(unitsLine(unitsOf(j)))}, ${esc(svcList(j.services))}</div>
          <div class="lrow-sub">Ask: is it working well?</div></div></div>
      <div class="actions">${callBtn(c.contact)}
        <button type="button" class="b primary" data-act="followup" data-id="${esc(j.id)}" data-v="All good">✓ All good</button>
        <button type="button" class="b" data-act="followup" data-id="${esc(j.id)}" data-v="A problem — a visit booked" data-book="1">A problem — book a visit</button></div>
    </div>`; }).join('')}</div>`;
}
function drawCheckups(){
  const list = checkups(), today = manilaDate(0);
  const planned = Object.values(db.customers).filter(c => c.check_every && c.check_next).length;
  return followupHtml() + (followups().length ? '<div class="sec">📅 Check-ups due</div>' : '') +
    (list.length ? `<div class="list">${list.map(checkupRow).join('')}</div>` : empty('Nobody is due for a check-up call.')) +
    `<p class="count" style="margin-top:10px">${planned ? planned + ' customer' + (planned === 1 ? ' has' : 's have') + ' a regular check.'
      : 'Nobody has a regular check yet.'} Set one on the customer: Customers → tap them → 📅 Regular check.</p>`;
}
function checkupRow(k){
  const {c, last} = k, doneDay = last ? manilaDay(last.done_at) : null;
  return `<div class="lrow col" data-row="${esc(c.id)}" data-stamp="${esc(c.updated_at || '')}">
    <div class="lrow-top" role="button" tabindex="0" data-act="open" data-kind="customer" data-id="${esc(c.id)}">
      <div class="avatar">${esc(initials(c.full_name))}</div>
      <div class="lrow-main"><div class="lrow-title">${newDot(checkupUnseen(k))}${esc(c.full_name)}${unsentPill(c.id)}</div>
        <div class="lrow-sub"><b>📅 Check ${esc(everyWord(k.every))}</b> · ${k.due === manilaDate(0) ? 'due today' : 'due since ' + esc(shortDate(k.due))}</div>
        ${doneDay ? `<div class="lrow-sub">Last job ${esc(shortDate(doneDay))} · ${esc(daysAgo(doneDay))}</div>` : '<div class="lrow-sub">No job yet</div>'}
        ${(o => o ? `<div class="lrow-sub">Longest since: ${esc(o.h.name)}${o.h.meta ? ' (' + esc(o.h.meta) + ')' : ''} — ${esc(daysAgo(o.d))}</div>` : '')(oldestClean(c.id))}
        <div class="lrow-sub">${esc(c.contact)} · ${esc(c.address)}</div></div>
    </div>
    <div class="actions">${callBtn(c.contact)}
      <button type="button" class="b primary" data-act="book" data-id="${esc(c.id)}" data-svc="checkup">Book it</button>
      <button type="button" class="b" data-act="later" data-id="${esc(c.id)}">✓ Done — next ${esc(shortDate(checkAfterToday(k)))}</button></div>
  </div>`;
}

/* 📅 Regular check (24): how often in one tap, then the first date; the next dates are
   spelled out so the owner sees what he set. `target` is a customer's id, or 'new' for the
   Add customer form. */
function checkPlanHtml(target, every, next, day){
  const on = !!(every && next), t = manilaDate(0);
  const chips = [[0, 'Off'], ...EVERY].map(([n, w]) =>
    `<button type="button" class="tab-btn${(every || 0) === n || (!on && n === 0) ? ' active' : ''}" data-act="ckevery" data-id="${esc(target)}" data-v="${n}">${w}</button>`).join('');
  let then = '';
  if (on){ const d = day || Number(next.slice(8, 10)), ds = [next]; for (let i = 0; i < 3; i++) ds.push(addEvery(ds[ds.length - 1], every, d));
    then = `<div class="plan-dates">${ds.map((x, i) => `<span${i ? '' : ' class="first"'}>${esc(shortDate(x))}</span>`).join('<i>→</i>')}<i>…</i></div>`; }
  return `<div class="plan">
      <div class="tabbar tight plan-every">${chips}</div>
      ${on ? `<label class="plan-date">${target === 'new' ? 'First check on' : 'Next check on'}
          <input type="date" data-ckdate="${esc(target)}" value="${esc(next)}" min="${t}"></label>
        ${then}
        <p class="hint">They show in Check-ups on each date — ${esc(everyWord(every))}, on the ${esc(ord(day || Number(next.slice(8, 10))))}.</p>`
      : '<p class="hint">Off: they never come up in Check-ups. Tap how often to start.</p>'}
    </div>`;
}
/* Add customer (Guile, 2026-09-27): a customer file on its own — no aircon, no job. */
function panelAddCust(p){
  const w = BK_WORDS.panel;
  const who = bkInput('panel', p, 'full_name', w.name, '', 'maxlength="120" autocomplete="off"')
    + bkInput('panel', p, 'contact', 'Contact number', '', 'inputmode="tel" maxlength="30" autocomplete="off" placeholder="09XX XXX XXXX"', bkBookBtn('panel', p))
    + (p._dup ? `<div class="inline-note">Same number as <b>${esc(p._dup)}</b>. Tap Save again to add them anyway.</div>` : '')
    + bkInput('panel', p, 'address', 'Address', '', 'maxlength="300" autocomplete="off" placeholder="Street, barangay, city"')
    + bkInput('panel', p, 'landmark', 'Landmark', '— optional', 'maxlength="200" autocomplete="off" placeholder="beside the chapel, blue gate…"')
    + bkLocHtml('panel', p);
  return {title: 'Add customer', sub: 'A customer file — no job', body: `<div class="card">${who}
      <div class="fieldlabel">📅 Regular check <span class="opt">— optional</span></div>
      ${checkPlanHtml('new', p.ck_every, p.ck_next, p.ck_day)}
      <div class="stack"><button type="button" class="b primary wide" data-act="saveaddcust">Save the customer</button></div>
      <div class="msg${p._msg ? ' show ' + (p._msgOk ? 'ok' : 'err') : ''}" aria-live="polite">${esc(p._msg || '')}</div></div>`};
}

function saveCheck(c, every, next, day, done){
  write('set_customer_check', {p_customer: c.id, p_every: every, p_next: next, p_day: every ? day : null},
    every ? (done ? 'Checked — ' : 'Regular check — ') + c.full_name + ', next ' + shortDate(next) : 'No regular check — ' + c.full_name, [c.id], () => {
      c.check_every = every; c.check_next = every ? next : null; c.check_day = every ? day : null;
    });
  toast(every ? (done ? 'Done. ' : '') + 'Next check ' + niceDate(next) + ' — ' + everyWord(every) + '.' : 'No regular check.');
}

/* ---------------------------------------------------------------- the owner books a call */
function openBook(customerId, services){
  // Booking a customer on file again starts from the aircons on their last job — the same
  // units, with the service asked for (a check-up) when there is one. Every line can go.
  let units = [];
  if (customerId){
    const last = jobsOf(customerId).sort(byTime).pop();
    if (last) units = unitsOf(last).filter(u => u.type)
      .map(u => ({...unitCopy(u), services: services && services.length ? [...services] : [...u.services]}));
  }
  openPanel({kind: 'book', mode: customerId ? 'existing' : 'new', customer_id: customerId || '', q: '',
    full_name: '', contact: '', address: '', landmark: '', lat: '', lng: '', units, notes: '', date: null, slot: 'am'});
}   // date null = not chosen yet: Save asks (2026-09-27, the job saved as Not scheduled unseen)
function bookMatches(p){
  const q = (p.q || '').toLowerCase().trim();
  const list = Object.values(db.customers).filter(c => c.full_name !== '(removed)')
    .filter(c => !q || c.full_name.toLowerCase().includes(q) || (digits(q) && digits(c.contact).includes(digits(q))))
    .sort((a, b) => a.full_name.localeCompare(b.full_name)).slice(0, 8);
  return list.map(c => `<div class="lrow" role="button" tabindex="0" data-act="pset" data-f="customer_id" data-v="${esc(c.id)}">
      <div class="avatar">${esc(initials(c.full_name))}</div>
      <div class="lrow-main"><div class="lrow-title">${esc(c.full_name)}</div><div class="lrow-sub">${esc(c.contact)} · ${esc(c.address)}</div></div></div>`).join('')
    || empty(q ? 'Nobody matches that.' : 'No customers yet.');
}
function bookSame(p){
  if (digits(p.contact).length < 7) return '';
  const same = Object.values(db.customers).filter(c => digits(c.contact) === digits(p.contact));
  return same.map(c => `<div class="inline-note">Same number as <b>${esc(c.full_name)}</b> (${esc(c.address)}).
    <button type="button" class="b" data-act="pickcust" data-v="${esc(c.id)}">Use them</button></div>`).join('');
}
/* The customer's form, word for word, in the same card — the ONE builder (bookFormHtml). */
function panelBook(p){
  return {title: 'Book a job', sub: 'A call you took yourself', info: 'book',
    body: heroFormHtml('panel', p, bookFormHtml('panel', p))};
}
/* Edit the job: the same form, the same photo, filled in from the job and its customer. */
function panelEditJob(p){
  const j = db.jobs[p.id];
  if (!j) return {title: 'Edit the job', body: empty('This job is no longer on this phone.')};
  if (!p._init){
    // a technician's phone keeps the customer ON the job, without an id: that is not "removed"
    const c = jobCust(j), removed = c.full_name === '(removed)' || (!c.id && !j.customer);
    Object.assign(p, {_init: true, mode: 'edit', full_name: c.full_name || '', contact: c.contact || '',
      address: c.address || '', landmark: c.landmark || '', lat: c.lat != null ? String(c.lat) : '', lng: c.lng != null ? String(c.lng) : '',
      units: unitsOf(j).map(u => ({...u, services: [...u.services]})), notes: j.notes || '',
      date: j.scheduled_on || '', slot: j.slot || 'am', _origDate: j.scheduled_on || '', _origSlot: j.slot || 'am',
      _noWhen: ['done', 'cancelled'].includes(j.status),
      _removed: removed ? 'This customer’s details were removed on request, so only the job itself can change.' : '',
      _want: wantOf(j)});
    // L2 (19): a technician at the house — the same form; the name, the number, the day and
    // the price stay the office's (the server refuses them too)
    if (db.role === 'technician') Object.assign(p, {_lockWho: true, _noWhen: true, _want: null});
  }
  // asked again on every draw: adding an aircon moves the list's total, never the job's price
  const l = unitsPrice(p.units || [], officePrice);
  p._priceNote = j.price == null || db.role === 'technician' ? ''
    : l != null && Math.abs(l - Number(j.price)) >= 0.01
      ? 'The job’s price stays ' + peso(j.price) + ' — the price list says ' + peso(l) + ' for these aircons. After saving, tap “Use ' + peso(l) + '” on the job, or Change the price.'
      : 'The price stays ' + peso(j.price) + ' — change it with Change the price.';
  return {title: 'Edit the job', sub: p.full_name || 'Job', body: heroFormHtml('edit', p, bookFormHtml('panel', p))};
}

/* ---------------------------------------------------------------- team (SukiRun's Admin → Team) */
function teamList(){
  const order = {admin: 1, technician: 2, helper: 3, customer: 4};
  const q = (ui.teamSearch || '').toLowerCase().trim();
  return Object.values(db.team)
    .filter(t => !q || ((t.display_name || '') + ' ' + (t.email || '') + ' ' + t.role).toLowerCase().includes(q))
    .sort((a, b) =>
      // somebody waiting for a role goes to the top, so a new name is not a mystery
      ((b.signup_kind === 'employee' && b.role === 'customer') - (a.signup_kind === 'employee' && a.role === 'customer'))
      || (order[a.role] - order[b.role]) || (a.display_name || a.email || '').localeCompare(b.display_name || b.email || ''));
}
function teamListHtml(){
  const rows = teamList();
  return rows.length ? `<div class="list">${rows.map(teamRow).join('')}</div>` : empty('Nobody matches that.');
}
function drawTeam(){
  const all = Object.values(db.team);
  const n = r => all.filter(t => t.role === r).length;
  return `<div class="stat-strip">
      <div class="stat-card"><div class="stat-num">${n('admin')}</div><div class="stat-label">Admins</div></div>
      <div class="stat-card"><div class="stat-num">${n('technician')}</div><div class="stat-label">Technicians</div></div>
      <div class="stat-card"><div class="stat-num">${n('helper')}</div><div class="stat-label">Helpers</div></div>
      <div class="stat-card"><div class="stat-num">${n('customer')}</div><div class="stat-label">Customers</div></div>
    </div>
    ${all.length > 6 ? `<input type="search" class="find" id="teamSearch" placeholder="🔎 Search ${all.length} people" value="${esc(ui.teamSearch || '')}" autocomplete="off">` : ''}
    <div id="teamList">${teamListHtml()}</div>`;
}
function teamRow(t){
  const off = t.active === false, waits = t.signup_kind === 'employee' && t.role === 'customer';
  return `<div class="lrow${off ? ' off' : ''}" role="button" tabindex="0" data-act="open" data-kind="member" data-id="${esc(t.id)}" data-stamp="${esc(t.updated_at || '')}">
    <div class="avatar">${esc(initials(t.display_name || t.email))}</div>
    <div class="lrow-main"><div class="lrow-title">${newDot(userUnseen(t))}${esc(t.display_name || (t.email || '').split('@')[0])}${unsentPill(t.id)}</div>
      <div class="lrow-sub">${esc(t.email || '')}</div></div>
    <div class="lrow-side">${rolePill(t.role)}
      ${t.id === session.uid ? '<span class="lrow-time">you</span>' : ''}
      ${waits ? '<span class="tag">says they work here</span>' : ''}
      ${off ? '<span class="tag bad">switched off</span>' : ''}</div>
  </div>`;
}
const ROLE_CHOICES = [
  ['technician', 'Technician', 'Sees every job on the schedule. Marks jobs started and done.'],
  ['helper', 'Helper', 'Rides along: sees the jobs on the schedule and ticks what to bring. No calls, no map, no buttons.'],
  ['admin', 'Admin', 'Everything: bookings, jobs, customers, team and settings.'],
  ['customer', 'Customer', 'Books on the page and sees their own bookings. Nothing else.'],
];
function panelMember(p){
  const t = db.team[p.id];
  if (!t) return {title: 'Person', body: empty('This person is no longer on this phone.')};
  const me = t.id === session.uid, off = t.active === false;
  const role = p.role || t.role, name = p.name != null ? p.name : (t.display_name || '');
  return {title: t.display_name || (t.email || '').split('@')[0], sub: t.email, body: `
    <div class="card" data-row="${esc(t.id)}" data-stamp="${esc(t.updated_at || '')}">
      ${kv('Role', rolePill(t.role) + unsentPill(t.id) + (off ? ' <span class="tag bad">switched off</span>' : ''))}
      ${kv('Signed up as', t.signup_kind === 'employee' ? 'Says they work here' : 'Customer')}
      ${kv('Joined', esc(t.created_at ? new Date(t.created_at).toLocaleDateString('en-PH', {day: 'numeric', month: 'short', year: 'numeric'}) : '—'))}
      ${kv('Last seen', esc(timeAgo(t.last_sign_in_at)))}
    </div>
    ${t.role === 'admin' ? `<div class="card row-between">
      <div class="lrow-main"><div class="menu-title">Sends texts to customers ${infoBtn('texter')}</div>
        <div class="sms-note">${textTexters().includes(t.id) ? 'Sees Texts to customers in Settings, 💬 Text on jobs and Text all.' : 'Sees none of the texting.'}</div></div>
      <div class="segment mini">${[[false, 'Off'], [true, 'On']].map(([v, l]) =>
        `<button type="button" class="${textTexters().includes(t.id) === v ? 'active' : ''}" data-act="texter" data-id="${esc(t.id)}" data-v="${v}">${l}</button>`).join('')}</div>
    </div>` : ''}
    ${me ? `<p class="hint">This is you. Another admin changes your role; nobody can switch themselves off.
      Your name is what technicians and customers see on the steps you take.</p>
    <label>Name <input data-pf="name" maxlength="60" value="${esc(name)}" placeholder="e.g. Guile"></label>
    <div class="stack"><button type="button" class="b primary wide" data-act="setrole" data-id="${esc(t.id)}">Save my name</button></div>` : `
    <div class="fieldlabel">What they can do ${infoBtn('roles')}</div>
    <div class="stack tight">${ROLE_CHOICES.map(([k, title]) =>
      `<button type="button" class="role-choice${role === k ? ' active' : ''}" data-act="pset" data-f="role" data-v="${k}">
         <span class="role-dot"></span><span class="role-choice-main"><span class="menu-title">${title}</span></span></button>`).join('')}</div>
    <label>Name <input data-pf="name" maxlength="60" value="${esc(name)}"></label>
    <div class="stack">
      <button type="button" class="b primary wide" data-act="setrole" data-id="${esc(t.id)}">Save changes</button>
      <button type="button" class="b ${off ? '' : 'danger'} wide" data-act="setactive" data-id="${esc(t.id)}" data-to="${off ? 'on' : 'off'}">${off ? 'Switch on' : 'Switch off'}</button>
    </div>`}`};
}

/* ---------------------------------------------------------------- the Admin tab */
function drawAdminTab(){
  const secs = [['services', 'Services & prices'], ['types', 'Appliances'], ['closed', 'Closed days'], ['shop', 'Shop'],
    ['photos', 'Page photos'], ['receipt', 'Receipt'], ['quote', 'Quotation'], ['texts', 'Texts'], ['numbers', 'Numbers']];
  const v = secs.some(x => x[0] === ui.adminSec) ? ui.adminSec : 'services';
  return chips('adminsec', secs.map(([k, t]) => [k, t]), v) +
    ({services: drawServices, types: drawTypes, closed: drawClosed, shop: drawShop, photos: drawPagePhotos, receipt: drawReceiptSample, quote: drawQuoteAdmin,
      texts: drawTexts, numbers: drawNumbers})[v]();
}
/* Idea 4 (Guile, 2026-09-27: "the admin marks his close days, maybe a calendar — improve
   it"): the weekdays the shop never works, and a month calendar to close particular dates —
   a holiday, a fiesta, a day off — each with a reason the customer is told. */
function drawClosed(){
  const set = db.settings || {}, wd = set.closed_days || [], dates = set.closed_dates || [];
  const today = manilaDate(0), month = ui.calMonth && ui.calMonth >= today.slice(0, 7) ? ui.calMonth : today.slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)), days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells = [];
  for (let i = 0; i < first.getUTCDay(); i++) cells.push('<span class="cal-pad"></span>');
  for (let d = 1; d <= days; d++){
    const ymd = month + '-' + String(d).padStart(2, '0'), past = ymd < today;
    const dated = dates.find(x => x.on === ymd), weekly = wd.includes(new Date(ymd + 'T00:00:00Z').getUTCDay());
    cells.push(`<button type="button" class="cal-day${dated ? ' shut' : weekly ? ' weekly' : ''}${ymd === today ? ' today' : ''}"
      data-act="closeddate" data-v="${ymd}" ${past || weekly ? 'disabled' : ''} title="${esc(dated ? (dated.why || 'Closed') : weekly ? 'Closed every ' + WEEKDAYS[new Date(ymd + 'T00:00:00Z').getUTCDay()] : 'Open — tap to close')}">${d}</button>`);
  }
  const prev = month > today.slice(0, 7), label = first.toLocaleDateString('en-PH', {month: 'long', year: 'numeric', timeZone: 'UTC'});
  return `<div class="card">
      <div class="menu-title">Closed every week ${infoBtn('closedwd')}</div>
      <div class="wd-row">${WEEKDAYS.map((w, i) => `<button type="button" class="tab-btn${wd.includes(i) ? ' active' : ''}" data-act="closedwd" data-v="${i}">${w.slice(0, 3)}</button>`).join('')}</div>
    </div>
    <div class="card">
      <div class="row-between"><div class="menu-title">Days off ${infoBtn('closeddates')}</div>
        <div class="cal-nav"><button type="button" class="b" data-act="calmonth" data-v="-1" ${prev ? '' : 'disabled'} aria-label="Month before">‹</button>
          <b>${esc(label)}</b><button type="button" class="b" data-act="calmonth" data-v="1" aria-label="Next month">›</button></div></div>
      <label>Reason for the next day you close <span class="opt">— optional, customers see it</span>
        <input data-k="closedWhy" id="closedWhy" maxlength="60" placeholder="Christmas, town fiesta, day off…" autocomplete="off"></label>
      <div class="cal">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(x => `<span class="cal-head">${x}</span>`).join('')}${cells.join('')}</div>
      <p class="hint">Tap a day to close it; tap it again to open it. Grey: closed every week.</p>
    </div>
    ${dates.length ? `<div class="sec">Coming days off</div><div class="list">${dates.map(x => `<div class="lrow flat">
        <div class="lrow-main"><div class="lrow-title">${esc(niceDate(x.on))}</div><div class="lrow-sub">${esc(x.why || 'Closed')}</div></div>
        <button type="button" class="b" data-act="closeddate" data-v="${esc(x.on)}">Open it</button></div>`).join('')}</div>` : ''}`;
}
/* Ideas 6 and 8: the shop's GCash for the receipt, and its Facebook page for the booking page. */
/* Admin → Page photos (30, TODO 16): he adds and removes the photos at the top of the booking
   page. The phone shrinks each to 1600 px before sending; six at most. Needs signal to add. */
let pagePhotoBusy = false;
function drawPagePhotos(){
  const l = pagePhotos();
  return `<div class="card">
    <div class="menu-title">The photos at the top of the booking page ${infoBtn('pagephotos')}</div>
    ${l.length ? `<div class="pp-grid">${l.map((p, i) => `<div class="pp-item">
        <img src="${esc(PAGE_PHOTO_BASE + p)}" alt="Page photo ${i + 1}" loading="lazy">
        <button type="button" class="b danger" data-act="ppremove" data-id="${esc(p)}">Remove</button></div>`).join('')}</div>`
      : '<p class="hint">None yet — the page shows its own photo.</p>'}
    <div class="actions">${l.length >= 6 ? '<span class="hint">Six is the most — remove one to add another.</span>'
      : pagePhotoBusy ? '<span class="b" aria-busy="true">Sending photo…</span>'
      : `<label class="b primary">📷 Add a photo<input type="file" accept="image/*" data-page-photo hidden></label>`}</div>
    <p class="hint">${l.length > 1 ? 'The page fades from one to the next every 6 seconds. ' : l.length ? 'Add another and the page fades from one to the next. ' : ''}Wide photos look best: the words sit over the left side.</p>
  </div>`;
}
function setPagePhotos(list, label){
  write('set_page_photos', {p_paths: list}, label, ['page_photos'],
    db => { db.settings = {...(db.settings || {}), page_photos: list}; });
  render(); drawHeroPhotos();
}
document.addEventListener('change', async e => {
  const inp = e.target;
  if (!inp.matches || !inp.matches('input[data-page-photo]')) return;
  const file = inp.files && inp.files[0];
  inp.value = '';
  if (!file || !session) return;
  // first the crop screen (Guile, 2026-09-28: "crop it first, adjust it first")
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImg(url);
    openPanel({kind: 'ppcrop', url, w: img.naturalWidth, h: img.naturalHeight, zoom: 1, cx: .5, cy: .5});
  } catch (err) { URL.revokeObjectURL(url); notice('That file is not a picture.', true); }
});
const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('not a picture')); i.src = src; });
/* Crop a page photo before it goes (Guile, 2026-09-28). The frame is 2 : 1 — a computer shows
   the photo in a band of ~2.6 : 1 (1366 × 520) and a phone in ~1.25 : 1 (375 × 300), the middle
   of the frame: the dashed box. Drag to move, the slider to zoom; "Use this photo" sends exactly
   the frame, 1600 × 800 at most (~200–300 KB). Sizes are fractions of the frame, so a redraw or
   a turned phone keeps the same crop. */
function ppGeom(p){
  const W = p.zoom * Math.max(1, (p.w / p.h) / 2), H = 2 * W / (p.w / p.h);   // image size, in frames
  const at = v => Number.isFinite(v) ? v : .5;
  const cx = Math.min(1 - 1 / (2 * W), Math.max(1 / (2 * W), at(p.cx))), cy = Math.min(1 - 1 / (2 * H), Math.max(1 / (2 * H), at(p.cy)));
  return {W, H, cx, cy};
}
function ppStyle(p){
  const g = ppGeom(p);
  p.cx = g.cx; p.cy = g.cy;
  return `width:${(g.W * 100).toFixed(3)}%;left:${((.5 - g.cx * g.W) * 100).toFixed(3)}%;top:${((.5 - g.cy * g.H) * 100).toFixed(3)}%`;
}
function panelPpcrop(p){
  if (!p.url) return {title: 'Crop the photo', body: empty('Pick the photo again — Admin → Page photos.')};
  return {title: 'Crop the photo', sub: 'Page photo', info: 'pagephotos', body: `
    <div class="pp-crop" data-ppcrop><img src="${esc(p.url)}" alt="" draggable="false" style="${ppStyle(p)}">
      <div class="pp-phone"><span>Phones show this part</span></div></div>
    <label class="pp-zoom">Zoom <input type="range" min="1" max="4" step="0.01" value="${esc(p.zoom)}" data-ppzoom aria-label="Zoom"></label>
    <p class="hint">Drag the photo to move it. Computers show the whole frame; phones show the dashed part — keep what matters inside it.</p>
    <div class="stack">${pagePhotoBusy ? '<span class="b wide" aria-busy="true">Sending photo…</span>'
      : '<button type="button" class="b primary wide" data-act="ppuse">Use this photo</button>'}</div>`};
}
let ppDrag = null;
document.addEventListener('pointerdown', e => {
  const box = e.target.closest && e.target.closest('[data-ppcrop]'), p = topPanel();
  if (!box || !p || p.kind !== 'ppcrop') return;
  ppDrag = {id: e.pointerId, x: e.clientX, y: e.clientY};
  try { box.setPointerCapture(e.pointerId); } catch (err) {}
  e.preventDefault();
});
document.addEventListener('pointermove', e => {
  const p = topPanel();
  if (!ppDrag || e.pointerId !== ppDrag.id || !p || p.kind !== 'ppcrop') return;
  // the frame on screen NOW: a sync redraw mid-drag replaces it (measured: the old one, gone,
  // measured 0 wide and the crop went NaN)
  const box = $('[data-ppcrop]'), r = box && box.getBoundingClientRect(), g = ppGeom(p);
  if (!r || !r.width) return;
  p.cx -= (e.clientX - ppDrag.x) / (g.W * r.width);
  p.cy -= (e.clientY - ppDrag.y) / (g.H * r.height);
  ppDrag.x = e.clientX; ppDrag.y = e.clientY;
  box.querySelector('img').setAttribute('style', ppStyle(p));
});
['pointerup', 'pointercancel'].forEach(t => document.addEventListener(t, e => { if (ppDrag && e.pointerId === ppDrag.id) ppDrag = null; }));
document.addEventListener('input', e => {
  const p = topPanel();
  if (!e.target.matches || !e.target.matches('[data-ppzoom]') || !p || p.kind !== 'ppcrop') return;
  p.zoom = Number(e.target.value) || 1;
  const img = $('[data-ppcrop] img');
  if (img) img.setAttribute('style', ppStyle(p));
});
async function usePagePhoto(){
  const p = topPanel();
  if (!p || p.kind !== 'ppcrop' || !p.url || pagePhotoBusy) return;
  pagePhotoBusy = true; render();
  try {
    const img = await loadImg(p.url), g = ppGeom(p);
    const sw = p.w / g.W, sh = p.h / g.H, sx = (g.cx - 1 / (2 * g.W)) * p.w, sy = (g.cy - 1 / (2 * g.H)) * p.h;
    const cv = document.createElement('canvas');
    cv.width = Math.max(2, Math.min(1600, Math.round(sw))); cv.height = Math.round(cv.width / 2);
    cv.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
    const jpeg = q => new Promise((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error('could not make the picture')), 'image/jpeg', q));
    // the bucket takes 600 KB at most; a busy photo goes out a little softer
    let blob = await jpeg(.72);
    if (blob.size > 590000) blob = await jpeg(.55);
    const path = 'page/' + await hashOf(blob) + '.jpg';
    const r = await storage('POST', path, blob, false, 'page-photos');
    if (!r.ok && r.status !== 409 && r.status !== 400){
      const b = await r.json().catch(() => ({}));
      throw new Error(b.message || b.error || 'HTTP ' + r.status);
    }
    if (r.status === 400){ const b = await r.json().catch(() => ({})); if (!/exist/i.test(b.message || b.error || '')) throw new Error(b.message || b.error || 'HTTP 400'); }
    URL.revokeObjectURL(p.url); p.url = null;
    closePanel();
    setPagePhotos([...pagePhotos().filter(x => x !== path), path], 'Page photos — one added');
  } catch (err) {
    notice(err instanceof TypeError ? 'The photo needs signal to send. Nothing was saved — try again when there is signal.'
                                    : 'The photo was not saved: ' + err.message, true);
  } finally { pagePhotoBusy = false; render(); }
}
function drawShop(){
  const set = db.settings || {};
  const field = (k, label, ph, extra) => `<label>${label}<input data-k="shop_${k}" id="shop_${k}" value="${esc(set[k] || '')}" placeholder="${esc(ph)}" autocomplete="off" ${extra || ''}></label>`;
  return `<div class="card">
      <div class="menu-title">Facebook page ${infoBtn('shopfb')}</div>
      ${field('facebook_url', 'Link', 'https://facebook.com/winterairservices', 'inputmode="url" maxlength="200"')}
      <div class="actions"><button type="button" class="b primary" data-act="saveshop" data-v="facebook_url">Save</button></div>
    </div>
    <div class="card">
      <div class="menu-title">GCash, on the receipt ${infoBtn('shopgcash')}</div>
      ${field('gcash_number', 'GCash number', '09XX XXX XXXX', 'inputmode="tel" maxlength="20"')}
      ${field('gcash_name', 'Name on the account', 'e.g. J. Dela Cruz', 'maxlength="60"')}
      <div class="actions"><button type="button" class="b primary" data-act="saveshop" data-v="gcash">Save</button></div>
    </div>`;
}
const typeShort = k => k === 'Floor-mounted' ? 'Floor' : typeLabel(k);
/* A1 (27): "Aircon & Other Appliances" — what a customer taps on the booking page, in the
   owner's order. Add, rename, picture, order, Remove (and bring back). */
function drawTypes(){
  const all = typeRows(), shown = all.filter(t => t.active !== false), gone = all.filter(t => t.active === false);
  const row = t => `<div class="lrow${t.active === false ? ' off' : ''}" role="button" tabindex="0" data-act="open" data-kind="utype" data-id="${esc(t.key)}">
      <img class="type-ico" src="${esc(typePic(t.key))}" alt="">
      <div class="lrow-main"><div class="lrow-title">${esc(t.label)}${unsentPill('type:' + t.key)}</div></div>
      <div class="lrow-side">${t.active === false ? pill('off', 'Removed') : pill('scheduled', 'On the page')}</div></div>`;
  return `<div class="card"><div class="menu-title">Aircon &amp; Other Appliances ${infoBtn('types')}</div>
      <p class="hint">What a customer taps on the booking page, in this order. Each one’s prices are in Services &amp; prices.</p></div>
    <div class="list">${shown.map(row).join('')}</div>
    <div class="stack"><button type="button" class="b primary wide" data-act="open" data-kind="utype" data-id="">+ Add an appliance</button></div>
    ${gone.length ? `<div class="sec">Removed — tap one to bring it back</div><div class="list">${gone.map(row).join('')}</div>` : ''}`;
}
function panelUtype(p){
  const t = p.id ? typeOf(p.id) : null;
  if (p.label == null){ p.label = t ? t.label : ''; p.icon = t ? t.icon : 'car-aircon';
    // A2 (28): what it offers — a new one starts with nothing ticked
    p.services = t ? (Array.isArray(t.services) ? [...t.services] : svcRows().map(x => x.key)) : []; }
  const svcs = svcRows().filter(x => x.active || p.services.includes(x.key));
  const shown = activeTypes(), i = t ? shown.findIndex(x => x.key === t.key) : -1;
  const own = p.icon && p.icon.startsWith('data:') ? [p.icon] : [];
  return {title: t ? t.label : 'New appliance', sub: 'Aircon & Other Appliances', info: 'types', body: `
    <label>Name <input data-pf="label" maxlength="40" value="${esc(p.label)}" placeholder="e.g. Chiller" autocomplete="off"></label>
    <div class="fieldlabel">Services it offers <span class="opt">— what a customer can pick for it</span></div>
    <div class="tabbar tight">${svcs.map(x => `<button type="button" class="tab-btn${p.services.includes(x.key) ? ' active' : ''}" data-act="typesvc" data-v="${esc(x.key)}">${p.services.includes(x.key) ? '✓ ' : ''}${esc(x.label)}</button>`).join('')
      || '<p class="hint">The service list has not come down yet.</p>'}</div>
    <div class="fieldlabel">Picture</div>
    <div class="icon-pick">${[...TYPE_ICONS, ...own].map(ic => `<button type="button" class="icon-opt${p.icon === ic ? ' active' : ''}" data-act="pset" data-f="icon" data-v="${esc(ic)}" aria-label="Picture ${esc(ic.startsWith('data:') ? 'of his own' : ic)}"><img src="${esc(ic.startsWith('data:') ? ic : 'icons/' + ic + '.png')}" alt=""></button>`).join('')}
      <label class="icon-opt icon-up">＋ Your own<input type="file" accept="image/png,image/*" data-typeicon hidden></label></div>
    <p class="hint">Your own: a PNG with a see-through background looks best. The phone shrinks it to 128 px.</p>
    ${t && t.active !== false && shown.length > 1 ? `<div class="fieldlabel">Place on the booking page — ${i + 1} of ${shown.length}</div>
      <div class="actions"><button type="button" class="b" data-act="typemove" data-id="${esc(t.key)}" data-v="-1"${i <= 0 ? ' disabled' : ''}>↑ Earlier</button>
        <button type="button" class="b" data-act="typemove" data-id="${esc(t.key)}" data-v="1"${i >= shown.length - 1 ? ' disabled' : ''}>↓ Later</button></div>` : ''}
    <div class="stack"><button type="button" class="b primary wide" data-act="savetype" data-id="${esc(t ? t.key : '')}">${t ? 'Save' : 'Add it'}</button>
      ${!t ? '' : t.active === false
        ? `<button type="button" class="b wide" data-act="typeshow" data-id="${esc(t.key)}" data-v="1">Bring it back</button>`
        : `<button type="button" class="b danger wide" data-act="typeshow" data-id="${esc(t.key)}" data-v="0">Remove</button>`}</div>
    ${t ? '<p class="hint">Remove takes it off the booking page. Jobs that already have it keep it, and so do its prices — Bring it back puts everything back.</p>' : ''}`};
}
/* One write per change; the phone's copy is changed at once (write → applyLocal). */
function saveType(t, change, label){
  const next = {...t, ...change};
  write('save_unit_type', {p_key: t.key, p_label: next.label, p_icon: next.icon, p_active: next.active !== false, p_sort: next.sort,
      p_services: 'services' in change ? change.services : null},
    label, ['type:' + t.key], db => {
      if (!db.types || !db.types.length) db.types = BUILTIN_TYPES.map((x, n) => ({...x, active: true, sort: (n + 1) * 10}));
      const r = db.types.find(x => x.key === t.key); if (r) Object.assign(r, change);
      db.types.sort((a, b) => (a.sort || 0) - (b.sort || 0));
    });
}
function drawServices(){
  const rows = svcRows(), on = !!((db.settings || {}).show_prices);
  const sw = `<div class="card row-between">
      <div class="menu-title">Show prices on the booking page ${infoBtn('showprices')}</div>
      <div class="segment mini">${[[false, 'Off'], [true, 'On']].map(([v, t]) =>
        `<button type="button" class="${on === v ? 'active' : ''}" data-act="showprices" data-v="${v}">${t}</button>`).join('')}</div>
    </div>
    <div class="card row-between">
      <div class="menu-title">Show prices to technicians &amp; helpers ${infoBtn('showpricestech')}</div>
      <div class="segment mini">${[[false, 'Off'], [true, 'On']].map(([v, t]) =>
        `<button type="button" class="${!!(db.settings || {}).show_prices_tech === v ? 'active' : ''}" data-act="showpricestech" data-v="${v}">${t}</button>`).join('')}</div>
    </div>`;
  const line = (s, ts) => ts.map(t => typeShort(t) + ' ' + (s.prices && s.prices[t] != null ? peso0(s.prices[t]) : '—')).join(' · ');
  // two to a line, only the appliances that offer it (28)
  const pairs = s => { const out = []; activeTypes().filter(t => typeOffers(t.key, s.key)).forEach((t, i) => {
    if (i % 2 === 0) out.push([t.key]); else out[out.length - 1].push(t.key); }); return out; };
  return sw + (rows.length ? `<div class="list">${rows.map(s => `<div class="lrow${s.active ? '' : ' off'}" role="button" tabindex="0" data-act="open" data-kind="service" data-id="${esc(s.key)}">
      <div class="lrow-main"><div class="lrow-title">${esc(s.label)}${unsentPill('svc:' + s.key)}</div>
        ${pairs(s).map(pr => `<div class="lrow-sub">${esc(line(s, pr))}</div>`).join('') || '<div class="lrow-sub">Not offered on any appliance</div>'}</div>
      <div class="lrow-side">${s.active ? pill('scheduled', 'On the page') : pill('off', 'Hidden')}</div></div>`).join('')}</div>`
    : empty('The service list has not come down yet.')) +
    `<div class="stack"><button type="button" class="b primary wide" data-act="open" data-kind="service" data-id="">+ Add a service</button></div>`;
}
/* The price boxes: every shown appliance for a new service, those that offer it after (28). */
const priceTypes = r => activeTypes().filter(t => !r || typeOffers(t.key, r.key));
function panelService(p){
  const r = p.id ? svcRows().find(x => x.key === p.id) : null;
  if (p.label == null){
    p.label = r ? r.label : ''; p.active = r && !r.active ? '0' : '1';
    p.check = r ? checklistOf(r.key) : []; p.check0 = JSON.stringify(p.check);   // 37
    activeTypes().forEach(t => { p['price_' + t.key] = r && r.prices && r.prices[t.key] != null ? String(r.prices[t.key]) : ''; });
  }
  return {title: r ? r.label : 'New service', sub: r ? 'Service' : 'Shows on the booking page', info: 'service', body: `
    <label>Name <input data-pf="label" maxlength="60" value="${esc(p.label)}" placeholder="Freon recharge"></label>
    <div class="fieldlabel">Price for each one ${r ? '<span class="opt">— the appliances that offer it; which ones is in Admin → Appliances</span>' : '<span class="opt">— a new service starts on every appliance</span>'}</div>
    <div class="price-grid">${priceTypes(r).map(t => `<label class="price-cell"><span>${esc(t.label)}</span>
      <span class="peso-in"><i>₱</i><input data-pf="price_${esc(t.key)}" inputmode="decimal" value="${esc(p['price_' + t.key] || '')}" placeholder="—"></span></label>`).join('')}</div>
    <div class="fieldlabel">On the booking page</div>
    <div class="segment">${[['1', 'Shown'], ['0', 'Hidden']].map(([k, t]) =>
      `<button type="button" class="${p.active === k ? 'active' : ''}" data-act="pset" data-f="active" data-v="${k}">${t}</button>`).join('')}</div>
    <div class="fieldlabel">🧰 What to bring <span class="opt">— technicians and helpers tick it on every job with this service</span></div>
    <div class="card prep">
      ${p.check.map((t, i) => `<div class="prep-row"><span class="prep-main"><span class="prep-text">${esc(t)}</span></span>
        <button type="button" class="cart-x" data-act="chkx" data-i="${i}" aria-label="Take ${esc(t)} off the list">×</button></div>`).join('')
        || `<p class="hint">Nothing yet.${STARTER_LISTS[p.id] ? '' : ' Add what the team must not forget.'}</p>`}
      ${!p.check.length && STARTER_LISTS[p.id] ? `<button type="button" class="b" data-act="chkstarter">Start from our usual list (${STARTER_LISTS[p.id].length})</button>` : ''}
      <div class="prep-add"><input data-pf="chkNew" maxlength="60" value="${esc(p.chkNew || '')}" placeholder="Wire tester, electrical tape…" autocomplete="off">
        <button type="button" class="b" data-act="chkadd">＋ Add</button></div>
    </div>
    <div class="stack"><button type="button" class="b primary wide" data-act="saveservice">Save</button></div>`};
}
/* A first list per service, for the owner to cut down (37, 2026-10-03): what a crew usually
   carries for each in the trade — not measured here. Offered only while his list is empty;
   nothing is saved until he taps Save. */
const STARTER_LISTS = {
  repair:    ['Wire tester', 'Multimeter', 'Clamp meter', 'Wires', 'Electrical tape', 'Spare capacitors', 'Manifold gauge', 'Freon', 'Screwdriver set'],
  install:   ['Hammer drill', 'Core drill bit', 'Jackhammer', 'Level', 'Copper pipe', 'Flaring tool', 'Pipe cutter', 'Vacuum pump', 'Manifold gauge', 'Bracket and anchors', 'Drain hose', 'Putty', 'Insulation tape', 'Ladder'],
  clean:     ['Pressure washer', 'Aircon cleaning bag (catches the water)', 'Coil cleaner', 'Pail', 'Brush', 'Rags', 'Drop cloth', 'Ladder', 'Extension cord'],
  relocate:  ['Manifold gauge', 'Wrenches', 'Pipe caps', 'Hammer drill', 'Copper pipe', 'Flaring tool', 'Vacuum pump', 'Bracket and anchors', 'Insulation tape', 'Ladder'],
  dismantle: ['Manifold gauge', 'Wrenches', 'Pipe caps', 'Tape', 'Screwdriver set', 'Ladder'],
  checkup:   ['Multimeter', 'Clamp meter', 'Manifold gauge', 'Thermometer', 'Flashlight'],
  survey:    ['Tape measure', 'Level', 'Flashlight', 'Phone for photos'],
};
const checklistOf = key => { const l = (db.checklists || []).find(x => x.key === key); return l ? [...(l.items || [])] : []; };

/* ---------------------------------------------------------------- the receipt
   A sample for Guile to mark up (2026-09-26): A4, from any printer's menu. The lines come
   from the price list; the total is the job's own frozen price, and any difference between
   the two is shown as an adjustment rather than hidden. */
function receiptOf(j){
  const c = jobCust(j), b = j.booking_id && db.bookings[j.booking_id];
  const units = unitsOf(j), names = unitNames(units);
  const lines = units.flatMap((u, i) => u.services.map(k => ({unit: names[i], label: svcLabel(k), type: u.type || '—',
    amount: u.type ? officePrice(k, u.type) : null})));
  const sum = lines.every(l => l.amount != null) ? lines.reduce((a, l) => a + l.amount, 0) : null;
  const total = j.price != null ? Number(j.price) : sum;
  // a technician's phone has no bookings: the job brings its booking's code (19)
  return {no: b ? b.ref : j.booking_ref || 'J-' + String(j.id).slice(0, 6).toUpperCase(),
    date: manilaDay(j.done_at) || manilaDate(0), customer: c, job: j, lines, total,
    adjust: total != null && sum != null && Math.abs(total - sum) >= 0.01 ? Math.round((total - sum) * 100) / 100 : null};
}
function receiptSample(){
  const ks = activeServiceKeys().slice(0, 2);
  const lines = [['Split #1', ks.slice(0, 1)], ['Split #2', ks]].flatMap(([unit, keys]) =>
    keys.map(k => ({unit, label: svcLabel(k), type: 'Split', amount: officePrice(k, 'Split') ?? 1000})));
  const sum = lines.reduce((a, l) => a + l.amount, 0);
  return {no: 'WA-0000', date: manilaDate(0), sample: true,
    customer: {full_name: 'ZZ Sample Customer', address: 'ZZ Street 1, ZZ Barangay, Bacolod City', contact: '0999 000 0000', landmark: 'ZZ blue gate'},
    job: {units: [{type: 'Split', services: ks.slice(0, 1), brand: 'ZZ Brand', model: 'ZZ-1'}, {type: 'Split', services: ks, brand: 'ZZ Brand', model: 'ZZ-2'}],
          unit_type: 'Split', unit_count: 2, unit_brand: 'ZZ Brand', unit_model: 'ZZ-1', scheduled_on: manilaDate(0), slot: 'am', notes: 'Sample only.'},
    lines, total: sum - 100, adjust: -100};
}
function receiptHtml(r){
  const d = ymd => new Date(ymd + 'T00:00:00').toLocaleDateString('en-PH', {day: 'numeric', month: 'long', year: 'numeric'});
  const money = n => n == null ? '—' : peso(n);
  const j = r.job, c = r.customer;
  return `<div class="receipt">
    ${r.sample ? '<div class="rc-sample">SAMPLE</div>' : ''}
    <div class="rc-head">
      <div><img class="rc-logo" src="img/winter-air-logo.png" alt="${esc(SHOP_NAME)}">
        <div class="rc-small">Aircon cleaning · repair · installation<br>Bacolod City · ${esc(SHOP_PHONE)}</div></div>
      <div class="rc-right"><div class="rc-title">SERVICE RECEIPT</div>
        <div class="rc-small">No. <b>${esc(r.no)}</b><br>Date: ${esc(d(r.date))}</div></div>
    </div>
    <div class="rc-parties">
      <div><div class="rc-label">Customer</div><b>${esc(c.full_name || '')}</b><br>${esc(c.address || '')}${c.landmark ? '<br>' + esc(c.landmark) : ''}<br>${esc(c.contact || '')}</div>
      <div><div class="rc-label">Aircons</div>${esc(unitsLine(unitsOf(j)) || '—')}
        <div class="rc-label" style="margin-top:10px">Service date</div>${esc(j.scheduled_on ? niceDate(j.scheduled_on) + ', ' + slotWord(j.slot) : '—')}</div>
    </div>
    <table class="rc-table">
      <thead><tr><th style="width:7%">#</th><th style="width:26%">Aircon</th><th>Service</th><th class="rc-num" style="width:22%">Amount</th></tr></thead>
      <tbody>${r.lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.unit || l.type)}</td><td>${esc(l.label)}</td><td class="rc-num">${esc(money(l.amount))}</td></tr>`).join('')}</tbody>
      <tfoot>
        ${r.adjust != null ? `<tr><td></td><td colspan="2" class="rc-num">Adjustment</td><td class="rc-num">${esc(money(r.adjust))}</td></tr>` : ''}
        <tr class="rc-total"><td></td><td colspan="2" class="rc-num">TOTAL</td><td class="rc-num">${esc(money(r.total))}</td></tr>
      </tfoot>
    </table>
    ${j.notes ? `<div class="rc-notes"><span class="rc-label">Notes</span> ${esc(j.notes)}</div>` : ''}
    <div class="rc-sign"><div>Received by (customer)</div><div>Technician</div></div>
    ${j.paid_method ? `<div class="rc-paid">PAID — ${esc(PAY[j.paid_method])}${j.paid_at ? ', ' + esc(d(manilaDay(j.paid_at))) : ''}</div>` : ''}
    ${(db && db.settings || {}).gcash_number && !j.paid_method ? `<div class="rc-gcash"><img src="img/gcash-qr.png" alt="" data-gone-if-missing>
      <div>Pay by GCash: <b>${esc(db.settings.gcash_number)}</b>${db.settings.gcash_name ? '<br>' + esc(db.settings.gcash_name) : ''}</div></div>` : ''}
    <div class="rc-foot">Thank you for choosing ${esc(SHOP_NAME)}.<br>This is not an official receipt.</div>
  </div>`;
}
function drawReceiptSample(){
  return `<div class="receipt-wrap">${receiptHtml(receiptSample())}</div>
    <div class="stack"><button type="button" class="b primary wide" data-act="print" data-id="">🖨️ Print the sample (A4)</button></div>`;
}
function panelReceipt(p){
  const j = db.jobs[p.id];
  if (!j) return {title: 'Receipt', body: empty('This job is no longer on this phone.')};
  return {title: 'Receipt', sub: jobCust(j).full_name, info: 'receipt', body: `
    <div class="receipt-wrap">${receiptHtml(receiptOf(j))}</div>
    <div class="stack"><button type="button" class="b primary wide" data-act="sharereceipt" data-id="${esc(j.id)}">📤 Share with the customer</button>
      <button type="button" class="b wide" data-act="print" data-id="${esc(j.id)}">🖨️ Print (A4)</button></div>`};
}

/* L5 (2026-09-27): on a job there is rarely a printer. Share sends the receipt as text to the
   customer's Messenger or Viber — the phone's own share sheet (the APK's, or the browser's);
   with neither, it is copied to paste. */
function receiptText(j){
  const r = receiptOf(j), c = r.customer || {};
  return [SHOP_NAME + ' — service receipt ' + r.no, 'Date: ' + niceDate(r.date), c.full_name ? 'Customer: ' + c.full_name : '',
    '', ...r.lines.map(l => '• ' + (l.unit || l.type) + ' — ' + l.label + (l.amount != null ? ': ' + peso(l.amount) : '')),
    r.adjust != null ? 'Adjustment: ' + peso(r.adjust) : '', 'TOTAL: ' + (r.total != null ? peso(r.total) : '—'),
    j.paid_method ? 'PAID — ' + PAY[j.paid_method] : ((db.settings || {}).gcash_number ? 'Pay by GCash: ' + db.settings.gcash_number + (db.settings.gcash_name ? ' (' + db.settings.gcash_name + ')' : '') : ''),
    '', 'Thank you for choosing ' + SHOP_NAME + '. ' + SHOP_PHONE, 'This is not an official receipt.'].filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n');
}
async function shareReceipt(id){
  const j = db.jobs[id]; if (!j) return;
  const text = receiptText(j), title = 'Receipt ' + receiptOf(j).no;
  try {
    if (window.AndroidBridge && window.AndroidBridge.shareText){ window.AndroidBridge.shareText(title, text); return; }
    if (navigator.share){ await navigator.share({title, text}); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const btn = $('[data-act="sharereceipt"]');
  if (btn) copyText(text, btn); else toast('Could not share from this phone.', true);
}

/* ---------------------------------------------------------------- the quotation (25)
   The owner's own quotation, laid out as his Word one (2026-09-28): letterhead, date, the
   address, SUBJECT, "Dear …", the table, a Note, his signature, the customer's Conforme
   line — signed, their contract. ONE piece, quoteHtml, draws the preview, the Admin sample
   and the paper. Made from a New booking and saved on it; Accept takes its total as the
   job's price. The letterhead and signer are Admin → Quotation, not written in this public
   file. The QR top right is the owner's own, taken from his Word one (2026-09-28):
   img/quote-qr.png, https://qr.page/g/1tCsNfQdMaC → qr-codes.io → his Facebook page. */
const SHOP_SHORT = 'Winter Air';
const QUOTE_NOTE = 'One (1) month workmanship warranty\nTerms of Payment: Full payment upon completion of work and test run';
function quoteShop(){
  const s = {name: SHOP_NAME, contact: 'Phone: ' + SHOP_PHONE};
  Object.entries((db && db.settings || {}).quote_shop || {}).forEach(([k, v]) => { if (v) s[k] = v; });
  return s;
}
/* The signature never comes with pull (~20 KB every 30 s): it is asked for once, when the
   server's stamp is newer than this phone's copy, and kept on this phone. */
let sigCache = null, sigAsking = false, sigTriedAt = 0;
const sigKey = () => 'ws_sig_' + (session && session.uid || '');
function quoteSig(){
  if (!session || !db || db.role !== 'admin') return '';
  if (!sigCache || sigCache.key !== sigKey()) sigCache = {key: sigKey(), ...lsGet(sigKey(), {at: null, png: ''})};
  const at = (db.settings || {}).quote_signature_at || null;
  if (at && at !== sigCache.at && !sigAsking && online && Date.now() - sigTriedAt > 60000){
    sigAsking = true; sigTriedAt = Date.now();
    rpc('quote_signature', {}).then(r => {
      sigCache = {key: sigKey(), at: (r && r.at) || at, png: (r && r.png) || ''};
      lsSet(sigKey(), {at: sigCache.at, png: sigCache.png});
      render();
    }).catch(() => {}).finally(() => { sigAsking = false; });
  }
  return at ? sigCache.png : '';
}
const qtNum = n => Number(n).toLocaleString('en-PH', {maximumFractionDigits: 2});
const qtMoney = n => Number(n).toLocaleString('en-PH', {minimumFractionDigits: 2, maximumFractionDigits: 2});
const qtAmount = l => l.qty != null && l.price != null ? Math.round(l.qty * l.price * 100) / 100 : null;
function qtTotal(lines){
  const a = lines.map(qtAmount);
  return a.length && a.every(x => x != null) ? Math.round(a.reduce((s, x) => s + x, 0) * 100) / 100 : null;
}
/* q: {date, to_address, salutation, subject, lines: [{text, qty, price}], note, sample} with
   numbers (or null) in qty and price. */
function quoteHtml(q){
  const s = quoteShop(), sig = quoteSig(), total = qtTotal(q.lines);
  const longDate = ymd => ymd ? new Date(ymd + 'T00:00:00').toLocaleDateString('en-US', {month: 'long', day: 'numeric', year: 'numeric'}) : '';
  const note = String(q.note || '').split('\n').filter(x => x.trim());
  return `<div class="quote">
    ${q.sample ? '<div class="rc-sample">SAMPLE</div>' : ''}
    <div class="qt-head"><img class="qt-logo" src="img/winter-air-logo.png" alt="">
      <div class="qt-lh"><div class="qt-name">${esc(s.name)}</div>
        ${s.tagline ? `<div class="qt-tag">${esc(s.tagline)}</div>` : ''}
        ${s.address ? `<div>${esc(s.address)}</div>` : ''}
        ${s.contact ? `<div class="qt-s">${esc(s.contact)}</div>` : ''}
        ${s.tin ? `<div class="qt-s">${esc(s.tin)}</div>` : ''}</div>
      <img class="qt-qr" src="img/quote-qr.png" alt="QR code: the shop's Facebook page"></div>
    <div class="qt-date">${esc(longDate(q.date))}</div>
    ${q.to_address ? `<div class="qt-to">${esc(q.to_address)}</div>` : ''}
    <div class="qt-subj">SUBJECT: ${esc(q.subject || '')}</div>
    ${q.salutation ? `<div class="qt-dear">${esc(q.salutation)}</div>` : ''}
    <p class="qt-p">Thank you for considering ${esc(SHOP_SHORT)} as your service provider! We are pleased to present this proposal and will
      furnish the equipment, labor and materials necessary as well as our expertise to do the following in compliance with
      your service request:</p>
    <table class="qt-table">
      <thead><tr><th>Supply of Labor, Materials and Services</th><th style="width:9%">Qty.</th><th style="width:14%">Unit Price</th><th style="width:19%">Amount</th></tr></thead>
      <tbody>${q.lines.map(l => `<tr><td>${esc(l.text || '')}</td><td class="qt-c">${l.qty != null ? esc(String(l.qty)) : '—'}</td>
        <td class="qt-c">${l.price != null ? esc(qtNum(l.price)) : '—'}</td><td class="qt-r">${qtAmount(l) != null ? esc(qtMoney(qtAmount(l))) : '—'}</td></tr>`).join('')}</tbody>
      <tfoot><tr class="qt-tot"><td colspan="3" class="qt-c">TOTAL</td><td class="qt-r">${total != null ? 'PHP ' + esc(qtMoney(total)) : '—'}</td></tr></tfoot>
    </table>
    ${note.length ? `<div class="qt-note">Note:<ul>${note.map(x => `<li${/^\s/.test(x) ? ' class="qt-in"' : ''}>${esc(x.trim())}</li>`).join('')}</ul></div>` : ''}
    <p class="qt-p">We strive to satisfy our clients to the best of our abilities and we hope you'll find our proposal suitable to your
      business needs.</p>
    <p class="qt-p">Should you find the above agreement acceptable, we have provided a space below for your valued signature. This
      will then serve as our contract.</p>
    <p class="qt-p">Sincerely yours,</p>
    ${sig ? `<img class="qt-sig" src="${esc(sig)}" alt="">` : '<div class="qt-sigspace"></div>'}
    <div>${esc(s.signer || '')}</div>${s.title ? `<div>${esc(s.title)}</div>` : ''}<div>${esc(s.name)}</div>
    <div class="qt-conf"><div>Conforme: <span class="ln" style="width:320px"></span><small>Signature over Printed Name &amp; Title</small></div>
      <div>Date: <span class="ln" style="width:170px"></span></div></div>
  </div>`;
}
let qtFull = false;
const quoteBox = (q, id) => `<div class="qt-wrap${qtFull ? ' full' : ''}"${id ? ` id="${id}"` : ''} data-act="qtzoom"
  title="${qtFull ? 'Tap to fit the screen' : 'Tap to see it full size'}"><div class="qt-scale">${quoteHtml(q)}</div></div>`;
/* Scale the A4 page to the box's width; full size scrolls instead. */
function fitQuotes(){
  $$('.qt-wrap').forEach(w => {
    const inner = w.firstElementChild, page = inner && inner.firstElementChild;
    if (!page || w.clientWidth < 60) return;
    const s = w.classList.contains('full') ? 1 : Math.min(1, (w.clientWidth - 16) / 794);
    inner.style.transform = s < 1 ? `scale(${s})` : '';
    w.style.height = s < 1 ? Math.ceil(page.offsetHeight * s + 16) + 'px' : '';
  });
}
window.addEventListener('resize', fitQuotes);

/* The booking's aircons as quotation lines: one per service and type, the count as Qty,
   the price list's price. Every word stays his to change. */
function quoteLinesFrom(units){
  const m = new Map();
  units.forEach(u => u.services.forEach(k => {
    const key = k + '|' + (u.type || ''), r = m.get(key);
    if (r) r.qty++; else m.set(key, {k, type: u.type, qty: 1});
  }));
  return [...m.values()].map(r => {
    const pr = r.type ? officePrice(r.k, r.type) : null;
    // "Repair of Split Type Aircon"; an appliance that is not one of the four, by its own name
    const what = !r.type ? 'Aircon' : BUILTIN_TYPES.some(b => b.key === r.type) ? typeLabel(r.type) + ' Type Aircon' : typeLabel(r.type);
    return {text: svcLabel(r.k) + ' of ' + what, qty: String(r.qty), price: pr != null ? String(pr) : ''};
  });
}
/* Where a quotation lives: a New booking (the Inbox), or a job until it is Done (26). A
   job's starts from its booking's, when it had one. Saving a job's sets its price. */
function quoteSrc(p){
  if (p.kind === 'jobquote'){
    const j = db.jobs[p.id]; if (!j) return null;
    const b = bookingOfJob(j), c = jobCust(j);
    return {row: j, job: true, name: c.full_name || '', ref: b ? b.ref : 'J-' + String(j.id).slice(0, 6).toUpperCase(),
      open: ['booked', 'scheduled', 'in_progress'].includes(j.status), state: (STATUS_LABEL[j.status] || j.status).toLowerCase(),
      saved: j.quote, start: j.quote || (b && b.quote) || null, address: c.address || '', units: unitsOf(j),
      fn: 'save_job_quote', arg: 'p_job'};
  }
  const b = db.bookings[p.id]; if (!b) return null;
  return {row: b, job: false, name: b.full_name, ref: b.ref, open: b.status === 'new', state: b.status,
    saved: b.quote, start: b.quote, address: b.address || '', units: unitsOf(b), fn: 'save_quote', arg: 'p_booking'};
}
/* What the screen edits: strings, as typed. */
function quoteStart(src){
  const q = src.start;
  if (q) return {date: q.date, to_address: q.to_address || '', salutation: q.salutation || '', subject: q.subject || '',
    note: q.note || '', lines: (q.lines || []).map(l => ({text: l.text, qty: String(l.qty), price: String(l.price)}))};
  const set = db.settings || {};
  return {date: manilaDate(0), to_address: src.address, salutation: 'Dear ' + src.name + ',',
    subject: 'ACU ' + unionServices(src.units).map(svcLabel).join(' & ').toUpperCase(),
    note: set.quote_note != null ? set.quote_note : QUOTE_NOTE, lines: quoteLinesFrom(src.units)};
}
/* Typed → drawn: a price that cannot be read shows as — (and Save refuses it). */
const quoteView = pq => ({...pq, lines: pq.lines.map(l => ({text: l.text,
  qty: /^\d{1,3}$/.test(String(l.qty).trim()) && Number(l.qty) >= 1 ? Number(l.qty) : null, price: parsePrice(l.price)}))});
function quoteCheck(pq){
  const v = quoteView(pq);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pq.date || '')) return {bad: 'Choose the date.'};
  if (!String(pq.subject || '').trim()) return {bad: 'Type the subject.'};
  if (!v.lines.length) return {bad: 'Add at least one line.'};
  for (let i = 0; i < v.lines.length; i++){
    const l = v.lines[i], n = 'Line ' + (i + 1);
    if (!String(l.text || '').trim()) return {bad: n + ' needs its words.'};
    if (l.qty == null) return {bad: n + ': Qty is a whole number, 1 to 999.'};
    if (l.price == null) return {bad: n + ': type the unit price in numbers, like 9500 or 9,500.50.'};
  }
  if (qtTotal(v.lines) > 99999999) return {bad: 'The total is too big.'};
  return {q: {date: pq.date, to_address: pq.to_address.trim(), salutation: pq.salutation.trim(), subject: pq.subject.trim(),
    note: pq.note, lines: v.lines.map(l => ({text: l.text.trim(), qty: l.qty, price: l.price}))}};
}
function panelQuote(p){
  const src = quoteSrc(p);
  if (!src) return {title: 'Quotation', body: empty('This ' + (p.kind === 'jobquote' ? 'job' : 'booking') + ' is no longer on this phone.')};
  if (!p.q) p.q = quoteStart(src);
  const open = src.open, saved = src.saved, sub = src.name + ' · ' + src.ref;
  const said = saved ? esc('Saved ' + timeAgo(saved.saved_at) + (saved.saved_by_name ? ' by ' + saved.saved_by_name : '')) + unsentPill(src.row.id)
    : src.start ? 'From the booking’s quotation — not saved on the job yet' : 'Not saved yet';
  // Send as PDF (TODO 13): in the app, the paper as a file straight to the share sheet; on the
  // website there is no file maker, so it opens the print screen like the button above it
  const printBtn = `<button type="button" class="b${open ? '' : ' primary'} wide" data-act="printquote">🖨️ Print or save as PDF</button>
    <button type="button" class="b wide" data-act="sharequote">📤 Send as PDF — Messenger, email…</button>`;
  if (!open) return {title: 'Quotation', sub, info: 'quote', body: `
    ${quoteBox(quoteView(p.q), 'quotePreview')}
    <p class="hint">${said}. The ${src.job ? 'job' : 'booking'} is ${esc(src.state)}, so the quotation stays as it was.</p>
    <div class="stack">${printBtn}</div>`};
  const tot = qtTotal(quoteView(p.q).lines);
  const priceHint = src.job ? `<p class="hint">Saving it makes the job’s price its TOTAL${src.row.price != null ? ' (now ' + esc(peso(src.row.price)) + ')' : ''}.</p>` : '';
  return {title: 'Quotation', sub, info: 'quote', body: `
    ${quoteBox(quoteView(p.q), 'quotePreview')}
    <p class="hint">${said}. Tap the page to see it full size.</p>
    <label>Date <input type="date" data-qf="date" value="${esc(p.q.date)}"></label>
    <label>Address <textarea data-qf="to_address" rows="2" maxlength="300">${esc(p.q.to_address)}</textarea></label>
    <label>Greeting <input data-qf="salutation" maxlength="160" value="${esc(p.q.salutation)}" autocomplete="off"></label>
    <label>Subject <input data-qf="subject" maxlength="150" value="${esc(p.q.subject)}" autocomplete="off"></label>
    <div class="fieldlabel">Supply of Labor, Materials and Services</div>
    ${p.q.lines.map((l, i) => `<div class="qt-line">
      <textarea data-ql="${i}:text" rows="2" maxlength="200" aria-label="Line ${i + 1}">${esc(l.text)}</textarea>
      <div class="qt-nums"><label class="qty">Qty <input data-ql="${i}:qty" inputmode="numeric" maxlength="3" value="${esc(l.qty)}"></label>
        <label>Unit price <span class="peso-in"><i>₱</i><input data-ql="${i}:price" inputmode="decimal" maxlength="14" value="${esc(l.price)}" placeholder="—"></span></label>
        <button type="button" class="b danger" data-act="qtline" data-v="del" data-i="${i}" aria-label="Remove line ${i + 1}">✕</button></div>
    </div>`).join('')}
    <div id="qtTotal" class="qt-total">${tot != null ? 'TOTAL ' + esc(peso(tot)) : 'TOTAL — a price is missing'}</div>
    <div class="actions"><button type="button" class="b" data-act="qtline" data-v="add">+ Add a line</button>
      <button type="button" class="b" data-act="qtfill">↺ Lines from the booking</button></div>
    <label>Note <span class="opt">— one point per line; start a line with a space to indent it</span>
      <textarea data-qf="note" rows="6" maxlength="3000">${esc(p.q.note)}</textarea></label>
    ${priceHint}
    <div class="stack"><button type="button" class="b primary wide" data-act="savequote">Save the quotation</button>
      ${printBtn}</div>`};
}
/* Typing redraws the page and the total only, never the box being typed in (ui.md). */
function drawQuotePreview(p){
  const w = $('#quotePreview');
  if (w) w.firstElementChild.innerHTML = quoteHtml(quoteView(p.q));
  const t = $('#qtTotal'), tot = qtTotal(quoteView(p.q).lines);
  if (t) t.textContent = tot != null ? 'TOTAL ' + peso(tot) : 'TOTAL — a price is missing';
  fitQuotes();
}
function quoteSample(){
  const set = db.settings || {}, ks = activeServiceKeys().slice(0, 2);
  return {sample: true, date: manilaDate(0), to_address: 'ZZ Street 1\nZZ Barangay, Bacolod City', salutation: 'Dear ZZ Sample Customer,',
    subject: 'ACU ' + ks.map(svcLabel).join(' & ').toUpperCase(),
    lines: ks.map((k, i) => ({text: svcLabel(k) + ' of ' + (i ? 'Window' : 'Split') + ' Type Aircon', qty: i + 1,
      price: officePrice(k, i ? 'Window' : 'Split') ?? 1000})),
    note: set.quote_note != null ? set.quote_note : QUOTE_NOTE};
}
function drawQuoteAdmin(){
  const set = db.settings || {}, s = set.quote_shop || {}, sig = quoteSig();
  const f = (k, label, ph) => `<label>${label}<input data-k="qs_${k}" id="qs_${k}" maxlength="160" value="${esc(s[k] || '')}" placeholder="${esc(ph)}" autocomplete="off"></label>`;
  return `<div class="card">
      <div class="menu-title">Letterhead and signer ${infoBtn('quoteshop')}</div>
      ${f('name', 'Shop name', SHOP_NAME)}${f('tagline', 'Tagline', 'A line under the name')}${f('address', 'Address', 'Street, barangay, city')}
      ${f('contact', 'Phone and email', 'Phone: …   Email: …')}${f('tin', 'TIN line', 'e.g. Non VAT Registered TIN: …')}
      ${f('signer', 'Signed by', 'The owner’s name')}${f('title', 'Their title', 'e.g. Proprietor')}
      <div class="actions"><button type="button" class="b primary" data-act="savequoteshop">Save</button></div>
    </div>
    <div class="card">
      <div class="menu-title">The usual note ${infoBtn('quotenote')}</div>
      <label><span class="opt">One point per line; start a line with a space to indent it</span>
        <textarea data-k="qs_note" id="qs_note" rows="6" maxlength="3000">${esc(set.quote_note != null ? set.quote_note : QUOTE_NOTE)}</textarea></label>
      <div class="actions"><button type="button" class="b primary" data-act="savequotenote">Save</button></div>
    </div>
    <div class="card">
      <div class="menu-title">Signature ${infoBtn('quotesig')}</div>
      ${sig ? `<img class="qt-sigprev" src="${esc(sig)}" alt="The signature">`
        : `<p class="hint">${set.quote_signature_at ? 'Loading the signature…' : 'None — the quotation leaves the space to sign by hand.'}</p>`}
      <div class="actions"><label class="b">✍️ ${sig ? 'New signature' : 'Add a signature'}<input type="file" accept="image/*" data-sig hidden></label>
        ${sig ? '<button type="button" class="b danger" data-act="sigremove">Remove</button>' : ''}</div>
    </div>
    ${quoteBox(quoteSample())}
    <div class="stack"><button type="button" class="b primary wide" data-act="printquote" data-id="">🖨️ Print the sample (A4)</button></div>`;
}
/* A photo of a signature on paper → the ink alone, on nothing: white goes clear, the pen's
   own colour stays, cropped to the ink. Small enough for a setting (< 80 KB). */
function inkOnly(file){
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      for (const side of [600, 400, 280]){
        const k = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(img.naturalWidth * k)); cv.height = Math.max(1, Math.round(img.naturalHeight * k));
        const cx = cv.getContext('2d');
        cx.drawImage(img, 0, 0, cv.width, cv.height);
        const d = cx.getImageData(0, 0, cv.width, cv.height), px = d.data;
        let x0 = cv.width, y0 = cv.height, x1 = -1, y1 = -1;
        for (let i = 0; i < px.length; i += 4){
          const lum = 0.3 * px[i] + 0.59 * px[i + 1] + 0.11 * px[i + 2];
          const a = Math.max(0, Math.min(1, (215 - lum) / 120)) * (px[i + 3] / 255);
          px[i + 3] = Math.round(a * 255);
          if (a > 0.1){ const x = (i / 4) % cv.width, y = Math.floor(i / 4 / cv.width);
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        }
        if (x1 < 0) return reject(new Error('no ink found — use a photo of the signature on white paper'));
        cx.putImageData(d, 0, 0);
        const out = document.createElement('canvas'), pad = 4;
        out.width = x1 - x0 + 1 + pad * 2; out.height = y1 - y0 + 1 + pad * 2;
        out.getContext('2d').drawImage(cv, x0, y0, x1 - x0 + 1, y1 - y0 + 1, pad, pad, x1 - x0 + 1, y1 - y0 + 1);
        const png = out.toDataURL('image/png');
        if (png.length <= 80000) return resolve(png);
      }
      reject(new Error('the picture is too big even when shrunk'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('that file is not a picture')); };
    img.src = url;
  });
}
document.addEventListener('change', async e => {
  const inp = e.target;
  if (!inp.matches || !inp.matches('input[data-sig]')) return;
  const file = inp.files && inp.files[0];
  inp.value = '';
  if (!file || !session) return;
  try {
    const png = await inkOnly(file), at = 'local-' + Date.now();
    write('set_shop_setting', {p_key: 'quote_signature', p_value: png}, 'Quotation — signature', ['quote_signature'], db => {
      db.settings = {...(db.settings || {}), quote_signature_at: at};
    });
    sigCache = {key: sigKey(), at, png}; lsSet(sigKey(), {at, png});
    render();
  } catch (err) { toast('Signature not added: ' + err.message + '.', true); }
});
/* A3: his own picture for an appliance — fitted into a 128 px square, its shape and its
   see-through kept, as a PNG small enough to travel with the list (list_services, pull).
   Says so when the picture has a solid background: on the dark page it shows as a box. */
function fitTypeIcon(file){
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      for (const side of [128, 96, 64]){
        const cv = document.createElement('canvas'); cv.width = cv.height = side;
        const k = side / Math.max(img.naturalWidth, img.naturalHeight), w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
        const cx = cv.getContext('2d'); cx.imageSmoothingQuality = 'high';
        cx.drawImage(img, Math.round((side - w) / 2), Math.round((side - h) / 2), w, h);
        // a corner of the picture itself, not of the square around it
        const x0 = Math.round((side - w) / 2), y0 = Math.round((side - h) / 2);
        const solid = cx.getImageData(x0, y0, 1, 1).data[3] === 255 && cx.getImageData(x0 + w - 1, y0 + h - 1, 1, 1).data[3] === 255;
        const png = cv.toDataURL('image/png');
        if (png.length <= 60000) return resolve({png, solid});
      }
      reject(new Error('the picture is too big even when shrunk'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('that file is not a picture')); };
    img.src = url;
  });
}
document.addEventListener('change', async e => {
  const inp = e.target;
  if (!inp.matches || !inp.matches('input[data-typeicon]')) return;
  const file = inp.files && inp.files[0], p = topPanel();
  inp.value = '';
  if (!file || !p || p.kind !== 'utype') return;
  try {
    const {png, solid} = await fitTypeIcon(file);
    p.icon = png; render();
    toast(solid ? 'Picture added — it has a solid background, so it will show as a box. A PNG with a see-through background looks better.'
                : 'Picture added. Save to keep it.', solid);
  } catch (err) { toast('Picture not added: ' + err.message + '.', true); }
});

/* The printer, or Android's print screen (Save as PDF) — the job name becomes the PDF's
   file name. Waits for the pictures, or the logo can be missing from the paper. */
// The quotation on paper (print) or as a PDF file (share). Admin's sample has no booking.
function quotePaper(share){
  const p = topPanel(), src = p && p.q && quoteSrc(p);
  if (!src) return printHtml(quoteHtml(quoteSample()), 'Quotation sample', share);
  // what is on the paper is what is saved: a changed (or never saved) quotation saves first
  if (src.open && (p.dirty || !src.saved) && !ACTIONS.savequote()) return;
  printHtml(quoteHtml(quoteView(p.q)), 'Quotation ' + src.ref + ' ' + src.name, share);
}
async function printHtml(html, name, share){
  $('#printArea').innerHTML = html;
  await Promise.all($$('#printArea img').map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; })));
  // Inside the APK window.print() does nothing; Android's own print screen does the job —
  // or, to share, Android writes the same paper to a PDF file and opens the share sheet.
  if (share && window.AndroidBridge && window.AndroidBridge.sharePdf) window.AndroidBridge.sharePdf(name);
  else if (window.AndroidBridge && window.AndroidBridge.print) window.AndroidBridge.print(name);
  else window.print();
}

/* ---------------------------------------------------------------- house photos (12)
   Taken by staff, never by a stranger (the trust boundary has no write for anon). One per
   customer: a new one replaces the old, and the old file is deleted once the server has
   the new path. The phone shrinks it to 1000 px before sending. Downloads go four at a
   time and are asked for again when dropped (docs/rules/pictures.md). */
const photoBusy = new Set();
function housePhoto(path, cls){ return `<img class="${cls || 'house-photo'}" data-house="${esc(path)}" alt="The gate">`; }
function photoBtn(cid, has){
  return photoBusy.has(cid) ? `<span class="b" aria-busy="true">Sending photo…</span>`
    : `<label class="b">📷 ${has ? 'New gate photo' : 'Gate photo'}<input type="file" accept="image/*" data-photo-for="${esc(cid)}" hidden></label>`;
}
function fitPhoto(file, maxSide){
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.naturalWidth * k); cv.height = Math.round(img.naturalHeight * k);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      cv.toBlob(b => b ? resolve(b) : reject(new Error('could not shrink the photo')), 'image/jpeg', 0.72);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('that file is not a picture')); };
    img.src = url;
  });
}
async function hashOf(blob){
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  return [...h.slice(0, 16)].map(x => x.toString(16).padStart(2, '0')).join('');
}
async function storage(method, path, body, retried, bucket = 'house-photos'){
  const t = await token();
  const r = await fetch(SUPABASE_URL + '/storage/v1/object/' + (method === 'GET' ? 'authenticated/' : '') + bucket + '/' + path, {
    method, headers: {apikey: SUPABASE_KEY, Authorization: 'Bearer ' + t, ...(body ? {'Content-Type': 'image/jpeg'} : {})}, body});
  // the same clock jump as rpc(): an expired token is refreshed once and the call asked again
  if (!retried && session && [400, 401, 403].includes(r.status)){
    const text = await r.clone().text().catch(() => '');
    if (/jwt expired|"exp" claim|token is expired/i.test(text)){ session.expires_at = 0; return storage(method, path, body, true, bucket); }
  }
  return r;
}
const photoUrls = {}, photoWant = new Set(), photoQueue = [];
let photoActive = 0;
async function keepPhoto(path, blob){
  try { const c = await caches.open('ws-photos'); await c.put('photo/' + path, new Response(blob, {headers: {'Content-Type': 'image/jpeg'}})); } catch (e) {}
  if (!photoUrls[path]) photoUrls[path] = URL.createObjectURL(blob);
}
function hydratePhotos(){
  $$('img[data-house]').forEach(img => {
    const p = img.dataset.house;
    if (photoUrls[p]){ if (img.getAttribute('src') !== photoUrls[p]) img.src = photoUrls[p]; }
    else if (!photoWant.has(p)){ photoWant.add(p); photoQueue.push({p, tries: 0}); pumpPhotos(); }
  });
}
function pumpPhotos(){
  while (photoActive < 4 && photoQueue.length){
    const job = photoQueue.shift();
    photoActive++;
    (async () => {
      try {
        let blob = null;
        try { const c = await caches.open('ws-photos'); const m = await c.match('photo/' + job.p); if (m) blob = await m.blob(); } catch (e) {}
        if (!blob){
          const r = await storage('GET', job.p);
          if (!r.ok) throw new Error('http ' + r.status);
          blob = await r.blob();
        }
        await keepPhoto(job.p, blob);
        hydratePhotos();
      } catch (e) {
        if (++job.tries < 4) setTimeout(() => { photoQueue.push(job); pumpPhotos(); }, 1000 * 2 ** job.tries);
        else photoWant.delete(job.p);   // asked for again the next time a screen shows it
      } finally { photoActive--; pumpPhotos(); }
    })();
  }
}
function deletePhotoFile(path){ if (path) storage('DELETE', path).catch(() => {}); }
document.addEventListener('change', async e => {
  const inp = e.target;
  if (!inp.matches || !inp.matches('input[data-photo-for]')) return;
  const cid = inp.dataset.photoFor, file = inp.files && inp.files[0];
  inp.value = '';
  if (!file || !session) return;
  const cust = db.customers[cid] || (Object.values(db.jobs).find(j => j.customer_id === cid) || {}).customer || {};
  const old = cust.photo_path || null;
  photoBusy.add(cid); render();
  try {
    const blob = await fitPhoto(file, 1000);
    const path = 'house/' + cid + '/' + await hashOf(blob) + '.jpg';
    const r = await storage('POST', path, blob);
    if (!r.ok && r.status !== 409 && r.status !== 400){
      const b = await r.json().catch(() => ({}));
      throw new Error(b.message || b.error || 'HTTP ' + r.status);
    }
    if (r.status === 400){ const b = await r.json().catch(() => ({})); if (!/exist/i.test(b.message || b.error || '')) throw new Error(b.message || b.error || 'HTTP 400'); }
    await keepPhoto(path, blob);
    // taken from a job's screen: that job's history gets the line (18)
    const from = topPanel(), jobId = from && from.kind === 'job' && db.jobs[from.id] && db.jobs[from.id].customer_id === cid ? from.id : null;
    const op = write('set_customer_photo', {p_customer: cid, p_path: path, p_job: jobId}, 'Gate photo — ' + (cust.full_name || ''), [cid, jobId].filter(Boolean), db => {
      if (db.customers[cid]) db.customers[cid].photo_path = path;
      Object.values(db.jobs).forEach(j => { if (j.customer_id === cid && j.customer) j.customer.photo_path = path; });
    });
    if (old && old !== path){ op.cleanup_photo = old; saveLocal(); }
  } catch (err) {
    notice(err instanceof TypeError ? 'The photo needs signal to send. Nothing was saved — try again when there is signal.'
                                    : 'The photo was not saved: ' + err.message, true);
  } finally { photoBusy.delete(cid); render(); }
});

/* ---------------------------------------------------------------- numbers */
function drawNumbers(){
  // The three numbers (docs/scope.md), worked out from this phone's copy. The page's
  // bookings only: Book a job's are the office's own (26).
  const bookings = Object.values(db.bookings).filter(b => b.source !== 'office'), jobs = Object.values(db.jobs);
  const weekStart = ymd => addDays(ymd, -((new Date(ymd + 'T00:00:00Z').getUTCDay() + 6) % 7));
  const thisWeek = weekStart(manilaDate(0));
  const weeks = [];
  for (let i = 7; i >= 0; i--) weeks.push(addDays(thisWeek, -7 * i));
  const perWeek = weeks.map(w => [w, bookings.filter(b => weekStart(manilaDay(b.created_at)) === w).length]);
  const since = Date.now() - 30 * 864e5;
  const mins = bookings.filter(b => b.handled_at && new Date(b.created_at) > since)
    .map(b => (new Date(b.handled_at) - new Date(b.created_at)) / 60000).sort((a, b) => a - b);
  const median = mins.length ? mins[Math.floor((mins.length - 1) / 2)] : null;
  const waiting = bookings.filter(b => b.status === 'new').length;
  const done = jobs.filter(j => j.status === 'done' && j.done_at && new Date(j.done_at) > since && j.scheduled_on);
  const onDay = done.filter(j => manilaDay(j.done_at) === j.scheduled_on).length;
  const fmtMins = m => m == null ? '—' : m < 60 ? Math.round(m) + ' min' : m < 1440 ? (m / 60).toFixed(1) + ' h' : (m / 1440).toFixed(1) + ' days';
  const max = Math.max(1, ...perWeek.map(p => p[1]));
  return `<div class="card"><div class="sec" style="margin-top:0">1 · Bookings through the page, per week</div>
      ${perWeek.map(([w, n]) => `<div class="bar-row">
        <span class="bar-when">${esc(shortDate(w))}</span>
        <span class="bar" style="width:${Math.round(n / max * 100)}%;min-width:${n ? 4 : 0}px"></span>
        <b>${n}</b></div>`).join('')}
      <p class="hint">Compare with the calls and Facebook messages the page is replacing.</p></div>
    <div class="card"><div class="sec" style="margin-top:0">2 · How fast the office rings back</div>
      <div class="num">${fmtMins(median)}</div>
      <p class="meta">Middle time from booking to first action, last 30 days (${mins.length} booking${mins.length === 1 ? '' : 's'}). ${waiting} waiting now.</p></div>
    <div class="card"><div class="sec" style="margin-top:0">3 · Jobs done on the day promised</div>
      <div class="num">${done.length ? Math.round(onDay / done.length * 100) + '%' : '—'}</div>
      <p class="meta">${onDay} of ${done.length} done jobs in the last 30 days.</p></div>
    ${takingsHtml(jobs, weekStart, thisWeek)}
    <div class="card"><div class="sec" style="margin-top:0">A month's jobs, for the books</div>
      <p class="meta">Every finished job of the month — day, customer, aircons, price, paid — as a spreadsheet (CSV, opens in Excel or Google Sheets).</p>
      <div class="actions"><button type="button" class="b" data-act="exportmonth" data-v="0">⬇ This month</button>
        <button type="button" class="b" data-act="exportmonth" data-v="-1">⬇ Last month</button></div></div>`;
}

/* Idea 5: what came in — the jobs marked paid, by the day they were paid. */
function takingsHtml(jobs, weekStart, thisWeek){
  const paid = jobs.filter(j => j.paid_method && j.paid_at && j.price != null);
  const sum = list => list.reduce((a, j) => a + Number(j.price), 0);
  const week = paid.filter(j => weekStart(manilaDay(j.paid_at)) === thisWeek);
  const month = paid.filter(j => manilaDay(j.paid_at).slice(0, 7) === manilaDate(0).slice(0, 7));
  const owed = jobs.filter(j => j.status === 'done' && !j.paid_method && j.price != null);
  const by = m => sum(week.filter(j => j.paid_method === m));
  return `<div class="card"><div class="sec" style="margin-top:0">Paid this week</div>
      <div class="num">${esc(peso(sum(week)))}</div>
      <p class="meta">${week.length} job${week.length === 1 ? '' : 's'} · cash ${esc(peso0(by('cash')))} · GCash ${esc(peso0(by('gcash')))} · other ${esc(peso0(by('other')))}.
        This month ${esc(peso(sum(month)))}.</p>
      ${owed.length ? `<p class="meta">Done but not marked paid: ${owed.length} job${owed.length === 1 ? '' : 's'}, ${esc(peso(sum(owed)))}.</p>` : ''}</div>`;
}
/* Idea 10: a month of finished jobs as a spreadsheet — for the owner's books. */
function exportMonth(delta){
  const now = manilaDate(0), [y, m] = now.split('-').map(Number);
  const month = new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
  const rows = Object.values(db.jobs).filter(j => j.status === 'done' && j.done_at && manilaDay(j.done_at).slice(0, 7) === month)
    .sort((a, b) => a.done_at < b.done_at ? -1 : 1);
  // what the public page typed must never run as a formula (=, +, -, @ first): a ' before it
  const cell = (v, i) => { let t = String(v == null ? '' : v); if (i !== 3 && /^[=+\-@\t\r]/.test(t)) t = "'" + t;
    return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const lines = [['Done', 'Receipt no.', 'Customer', 'Number', 'Address', 'Aircons', 'Services', 'Price', 'Paid', 'Paid on', 'Done by']]
    .concat(rows.map(j => { const c = jobCust(j);
      // ="0917…": a number with its leading 0 kept — Excel and Sheets drop it otherwise
      return [manilaDay(j.done_at), receiptOf(j).no, c.full_name, c.contact ? '="' + digits(c.contact) + '"' : '', place(c),
        unitsLine(unitsOf(j)), svcList(j.services), j.price != null ? Number(j.price).toFixed(2) : '',
        j.paid_method ? PAY[j.paid_method] : 'not yet', j.paid_at ? manilaDay(j.paid_at) : '', j.status_by_name || personName(j.status_by) || '']; }));
  const csv = '\ufeff' + lines.map(r => r.map(cell).join(',')).join('\r\n');
  const name = 'winter-air-jobs-' + month + '.csv';
  if (window.AndroidBridge && window.AndroidBridge.shareText){ window.AndroidBridge.shareText(name, csv); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], {type: 'text/csv;charset=utf-8'})); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast(rows.length + ' job' + (rows.length === 1 ? '' : 's') + ' in ' + name);
}

/* ---------------------------------------------------------------- technician
   No assignment (2026-09-26): every technician sees every job on the schedule. */
function drawTech(){
  const unseen = unseenCounts().jobs;
  // no bottom bar here, so the red number sits by the heading: jobs THIS technician has not opened
  return pageHead('Jobs', 'tech', unseen ? `<span class="tech-new">${unseen} new</span>` : '') + jobTabsHtml();
}

/* ---------------------------------------------------------------- customer */
function drawMine(){
  const mine = Object.values(db.bookings).sort((a, b) => a.created_at < b.created_at ? 1 : -1);
  // the same status line and bars as the office's screens (ui.md, Reuse)
  // once there is a job, ITS aircons: the office may have added one (17)
  const unitsNow = b => b.job && Array.isArray(b.job.units) && b.job.units.length ? b.job.units : unitsOf(b);
  return mine.length ? `<div class="list">${mine.map(b => `<div class="lrow col" data-row="${esc(b.id)}">
      <div class="lrow-top"><div class="lrow-main">
        <div class="lrow-title">${esc(unitsLine(unitsNow(b)) || svcList(b.services))}${unsentPill(b.id)}</div>
        <div class="lrow-sub">${esc(svcList(unionServices(unitsNow(b))) || svcList(b.services))}</div></div>
        <div class="lrow-side">${pill(b.job ? b.job.status : b.status, b.ref)}</div></div>
      <div class="mine-steps">${stepsHtml({booking: b, job: b.job || null})}</div>
      <div class="actions">
        <button type="button" class="b" data-act="open" data-kind="bookingstatus" data-id="${esc(b.id)}">${ico('status')} Full status</button>
        ${['cancelled', 'rejected'].includes(b.status) && !b.job ? '' : `<button type="button" class="b" data-act="bookagain" data-id="${esc(b.id)}">↻ Book again</button>`}
        ${b.status === 'new' ? `<button type="button" class="b danger" data-act="mycancel" data-id="${esc(b.id)}">Cancel this booking</button>` : ''}
      </div>
    </div>`).join('')}</div>` : empty('No bookings on this account yet.');
}

/* Idea 7: the same aircons and the same house, a new day — the form filled in, the day and
   the privacy tick left to the customer. */
function bookAgain(id){
  const b = db.bookings[id]; if (!b) return;
  const units = (b.job && Array.isArray(b.job.units) && b.job.units.length ? b.job.units : unitsOf(b))
    .filter(u => u.type).map(unitCopy);
  pubBook = {...freshPubBook(), full_name: (db.profile && db.profile.display_name) || '', address: b.address || '', landmark: b.landmark || ''};
  pubUnits = units;
  $('#done').hidden = true; bookForm.hidden = false;
  drawPubCart(); saveDraft();
  const n = $('[data-bk="' + (pubBook.full_name ? 'contact' : 'full_name') + '"]', bookForm);
  bookForm.scrollIntoView({behavior: 'smooth', block: 'start'});
  if (n) setTimeout(() => n.focus({preventScroll: true}), 400);
  toast('Filled in from ' + b.ref + ' — add your number and choose a day.');
}

/* ---------------------------------------------------------------- settings (SukiRun's ⚙) */
function applyTheme(){
  const t = lsGet('ws_theme', 'system');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
function panelSettings(){
  const role = (db && db.role) || (session && session.role), prof = (db && db.profile) || {};
  const name = prof.display_name || (session.email || '').split('@')[0];
  const theme = lsGet('ws_theme', 'system'), m = checkupMonths();
  const unsent = queue.filter(o => o.state === 'pending').length, failed = queue.filter(o => o.state === 'failed').length;
  const staff = role === 'admin' || inField(role);
  return {title: 'Settings', sub: name, body: `
    <div class="card me-card"><div class="avatar big">${esc(initials(name))}</div>
      <div class="lrow-main"><div class="lrow-title">${esc(name)}</div><div class="lrow-sub">${esc(session.email || '')}</div></div>
      ${rolePill(role)}</div>

    <div class="sec">Appearance</div>
    <div class="segment">${[['system', 'Like the phone'], ['light', 'Light'], ['dark', 'Dark']].map(([k, t]) =>
      `<button type="button" class="${theme === k ? 'active' : ''}" data-act="theme" data-v="${k}">${t}</button>`).join('')}</div>

    ${role === 'admin' ? `<div class="sec">Bookings from the page</div>
    <div class="card row-between">
      <div class="lrow-main"><div class="menu-title">Most jobs a morning or afternoon ${infoBtn('slotcap')}</div>
        <div class="lrow-sub">${slotCap() ? 'A full one is refused on the booking page' : 'No limit'}</div></div>
      <div class="stepper"><button type="button" class="b" data-act="slotcap" data-v="-1" aria-label="One fewer" ${slotCap() <= 0 ? 'disabled' : ''}>−</button>
        <b>${slotCap() || '—'}</b><button type="button" class="b" data-act="slotcap" data-v="1" aria-label="One more" ${slotCap() >= 50 ? 'disabled' : ''}>+</button></div>
    </div>` : ''}

    ${role === 'admin' ? smsCardHtml() : ''}

    <div class="sec">This phone</div>
    <div class="card">
      ${kv('Sending', esc(failed ? failed + ' not sent — see the red cards' : unsent ? unsent + ' waiting' + (online ? '' : ', offline') : online ? 'All sent' : 'Offline'))}
      ${kv('Last refresh', esc(lastPullOk ? timeAgo(lastPullOk.toISOString()) : 'not yet'))}
      <div class="actions"><button type="button" class="b" data-act="refresh">↻ Refresh now</button></div>
    </div>
    ${staff ? `<div class="card row-between">
      <div class="menu-title">Something looks wrong? ${infoBtn('reset')}</div>
      <button type="button" class="b danger" data-act="reset">Take the office's copy</button>
    </div>` : ''}

    ${aboutHtml()}

    <div class="stack"><button type="button" class="b danger wide" data-act="logout">Log out</button></div>
    <p class="credit">Icons by <a href="https://www.flaticon.com/" target="_blank" rel="noopener">Flaticon</a></p>`};
}

/* Automatic texts, step 1 (the owner via Guile, 2026-10-02): may this phone send texts, and
   does one test text arrive? Only the owner's phone sends — so it is switched on per phone,
   and kept on this phone only. The APK only: a web page cannot send a text. */
const smsCapable = () => inApk && !!window.AndroidBridge.sendSms;
let smsBusy = false;
async function smsAllowed(){
  let state = smsState();
  if (state === 'ask'){ try { state = await wsNet.call('askSms', []); } catch (e) {} }
  if (state === 'granted') return true;
  toast(state === 'blocked' ? 'Android blocks texts from this app — Settings → Texts to customers shows how to allow it.'
    : state === 'none' ? 'This device cannot send texts.' : 'Not allowed — this phone will not send texts.', true);
  return false;
}
function smsState(){ try { return window.AndroidBridge.smsState(); } catch (e) { return 'none'; } }
/* What the phone must allow before it may send by itself (Guile, 2026-10-02): his mother's
   Redmi let the app send by hand, but at 1:55 HyperOS would not wake it for its alarm —
   Background autostart was off. So the switch stays off until every line is ✔, and a line
   that goes ❌ later (Don't allow, battery saver back on) turns the sending off with it. */
/* Which SIM (Guile, 2026-10-02: "the Default sim selection can it not be used on the app?"):
   the owner's two-SIM Xiaomi failed with the modem's code 16, and a phone set to "Ask every
   time" has no default for an app to use. The phone says which SIMs it has and its default;
   the office picks one here, kept on this phone. */
function smsSims(){ try { return JSON.parse(window.AndroidBridge.sims ? window.AndroidBridge.sims() : '{}'); } catch (e) { return {}; } }
function smsSim(){
  const s = smsSims(), list = s.list || [], pick = lsGet('ws_sms_sim', null);
  if (pick != null && list.some(x => x.slot === pick)) return pick;
  return list.length === 1 ? list[0].slot : s.default != null ? s.default : -1;
}
const simName = x => 'SIM ' + (x.slot + 1) + (x.name ? ' · ' + x.name : '');
function smsChecks(){
  const state = smsState();
  let free = true, auto = 'na';
  try { free = !!window.AndroidBridge.batteryFree(); } catch (e) {}
  try { auto = window.AndroidBridge.autostart ? window.AndroidBridge.autostart() : 'na'; } catch (e) {}
  const xiaomi = auto !== 'na';
  const list = [
    {k: 'sms', info: 'chksms', ok: state === 'granted', label: 'Texts allowed',
     fix: state === 'blocked' ? ['smssettings', 'Open settings'] : ['smsask', 'Allow'],
     help: state === 'blocked' ? 'Android stopped asking after "Don\'t allow". In the app\'s settings: Permissions → SMS → Allow. If it says "restricted setting", tap ⋮ at the top → Allow restricted settings first.'
       : state === 'ask' ? 'Tap Allow, then Allow again on Android\'s question.' : ''},
    {k: 'battery', info: xiaomi ? 'chkbatterymi' : 'chkbattery', ok: free, label: 'Battery: No restrictions',
     fix: xiaomi ? ['smssettings', 'Open settings'] : ['smsbattery', 'Allow'],
     help: xiaomi ? 'Battery saver → No restrictions.' : 'Without it, Android can hold the reminders back for hours.'},
  ];
  const sims = smsSims(), sl = sims.list || [];
  if (sl.length){
    const pick = lsGet('ws_sms_sim', null), use = smsSim(), now = sl.find(x => x.slot === use);
    list.push({k: 'sim', info: 'chksim', ok: !!now, label: now ? 'Sends from ' + simName(now) + (pick == null || !sl.some(x => x.slot === pick) ? ' — the phone\'s default' : '') : 'Sends from: no SIM chosen',
      help: 'This phone asks which SIM every time — choose one below.',
      choose: sl.length > 1 ? `<div class="segment mini sms-sims">${sl.map(x =>
        `<button type="button" class="${x.slot === use ? 'active' : ''}" data-act="smssim" data-v="${x.slot}">${esc(simName(x))}</button>`).join('')}</div>` : ''});
  }
  if (xiaomi) list.push({k: 'autostart', info: 'chkautostart', ok: auto === 'on', unknown: auto === 'unknown', label: 'Background autostart',
    fix: ['smsautostart', 'Open Autostart'],
    help: auto === 'unknown' ? 'This phone would not say — check that Winter Air is on in the list.' : 'Find Winter Air in the list and turn it on.'});
  return {state, list, ready: list.every(c => c.ok || c.unknown)};
}
function smsCardHtml(){
  if (!smsCapable() || !canTextHere()) return '';
  const {state, list, ready} = smsChecks(), on = isSenderHere() && ready, t = lsGet('ws_sms_test', {}), who = textSender();
  if (state === 'none') return `<div class="sec">Texts to customers</div>
    <div class="card"><div class="sms-note">This device has no SIM, so it cannot send texts by itself${who ? ' — ' + esc(who.name) + ' sends them' : ''}.
      To text a customer from here: open the job → 💬 Text → Open in Messages. A tablet paired with a phone in Google Messages sends it through the phone; press Send there.</div></div>`;
  const checks = `<div class="card">${list.map(c => `<div class="row-between sms-check">
      <div class="lrow-main"><div class="menu-title">${c.ok ? '✔️' : c.unknown ? '⚠️' : '❌'} ${esc(c.label)} ${c.info ? infoBtn(c.info) : ''}</div>
        ${c.ok ? '' : `<div class="sms-note${c.unknown ? '' : ' bad'}">${esc(c.help)}</div>`}${c.choose || ''}</div>
      ${c.ok || !c.fix ? '' : `<button type="button" class="b" data-act="${c.fix[0]}">${esc(c.fix[1])}</button>`}</div>`).join('')}</div>`;
  const sw = `<div class="card row-between">
      <div class="lrow-main"><div class="menu-title">This phone sends the texts ${infoBtn('smssender')}</div>
        <div class="sms-note">${esc(on ? 'This phone sends them — the only one.' : who ? 'Sending phone: ' + who.name + (isSenderHere() ? ' (this phone)' : '') + '. On here takes over; that phone stops.' : 'No phone sends texts yet.')}</div>
        ${ready ? '' : `<div class="sms-note">Every line above must be ✔️ first.</div>`}</div>
      <div class="segment mini">${[[false, 'Off'], [true, 'On']].map(([v, l]) =>
        `<button type="button" class="${on === v ? 'active' : ''}" data-act="smssender" data-v="${v}" ${v && !ready ? 'disabled' : ''}>${l}</button>`).join('')}</div>
    </div>`;
  const test = on ? `<div class="card">
      <label>Send a test text to<input data-k="smsTestNo" id="smsTestNo" type="tel" inputmode="tel" maxlength="20" value="${esc(t.no || '')}" placeholder="Your own number, 09…" autocomplete="off"></label>
      ${t.at ? `<div class="sms-note${t.ok ? '' : ' bad'}">${esc(t.ok ? 'Sent ' + timeAgo(t.at) + (t.parts > 1 ? ' as ' + t.parts + ' parts' : '') + ' — check that it arrived.' : 'Not sent ' + timeAgo(t.at) + ': ' + t.why)}</div>` : ''}
      <div class="actions"><button type="button" class="b" data-act="smstest" ${smsBusy ? 'disabled' : ''}>${smsBusy ? 'Sending…' : 'Send a test text'}</button></div>
    </div>` : '';
  return `<div class="sec">Texts to customers</div>${checks}${sw}${test}`;
}
function smsTestText(){
  const now = new Date().toLocaleTimeString('en-PH', {hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila'});
  return 'Winter Air test text, sent by the app on its own at ' + now + '. No reply needed.';
}

/* ---------------------------------------------------------------- texts to customers (34)
   Step 2 (the owner via Guile, 2026-10-02). The owner's phone texts scheduled customers by
   itself: a reminder the day before and/or on the day at his times, and a text when a job is
   scheduled or moved. Admin → Texts holds his switches and wording; the job's Text button and
   "Text all of Tomorrow" send by hand. ONE writer of the message — textCompose — for all of
   them, and one record of what went — textsOf — so nothing goes twice:
     · the server's jobs.texts (record_text, queued like every write),
     · this phone's copy until that lands (ws_texts),
     · what the closed app sent and has not handed over yet (TextAlarms' log).
   The reminders are sent by the phone's alarm (TextAlarms.java) from a PLAN this page writes;
   a "booked" text goes from here, the moment this phone sees the job scheduled. */
const TEXT_WORDS = {
  reminder: 'Hi {name}, this is {owner} of {company}. A reminder: your service is {when}.\n{appliances}\n{price}\nTo change it, call or text {phone}. Thank you!',
  booked: 'Hi {name}, this is {owner} of {company}. Your service is booked for {when}.\n{appliances}\n{price}\nTo change it, call or text {phone}. Thank you!',
};
const TEXT_FILLINS = ['name', 'when', 'appliances', 'price', 'owner', 'company', 'phone'];
const TEXT_KIND = {before: 'Reminder, the day before', today: 'Reminder, on the day', booked: 'Booked / moved', hand: 'By hand'};
function textSet(){
  const s = {auto: false, before_on: true, before_at: '18:00', today_on: false, today_at: '08:00', booked: true, price: false,
             ...((db && db.settings || {}).texts || {})};
  if (!String(s.words_reminder || '').trim()) s.words_reminder = TEXT_WORDS.reminder;
  if (!String(s.words_booked || '').trim()) s.words_booked = TEXT_WORDS.booked;
  return s;
}
/* A text is 160 letters, or 70 once ONE letter is outside the plain SMS alphabet — ₱, an
   emoji, a curly quote — and the whole message then costs two to four times as many texts
   (218 letters: 2 texts, 4 with ₱; measured 2026-10-02). So the shop's own words are made
   plain here, and the counter says when the owner's are not. */
const GSM7 = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà^{}\\[~]|€';
const smsPlain = t => String(t).replace(/₱\s?/g, 'PHP ').replace(/[–—]/g, '-').replace(/[•·]/g, '-').replace(/[‘’]/g, "'")
  .replace(/[“”]/g, '"').replace(/…/g, '...').replace(/ /g, ' ');
function smsCount(t){
  const plain = [...t].every(ch => GSM7.includes(ch));
  const n = plain ? [...t].reduce((a, ch) => a + ('^{}\\[~]|€'.includes(ch) ? 2 : 1), 0) : [...t].length;
  const parts = plain ? (n <= 160 ? 1 : Math.ceil(n / 153)) : (n <= 70 ? 1 : Math.ceil(n / 67));
  return {n, parts, plain};
}
const smsCountLine = t => { const c = smsCount(t);
  return `${c.n} letters · ${c.parts} text${c.parts === 1 ? '' : 's'}${c.plain ? '' : ' — an emoji or a special letter makes each text hold only 70'}`; };
// a job's day and time, in Manila, as a moment
const manilaMs = (ymd, hhmm) => Date.parse(ymd + 'T' + hhmm + ':00+08:00');
const jobUntil = j => manilaMs(j.scheduled_on, isClock(j.slot) ? j.slot : j.slot === 'am' ? '12:00' : j.slot === 'pm' ? '18:00' : '23:59');
function textWhen(j, sendDay){
  const t = isClock(j.slot) ? ' at ' + clock12(j.slot) : j.slot === 'am' ? ' in the morning' : j.slot === 'pm' ? ' in the afternoon' : '';
  const d = j.scheduled_on;
  return (d === sendDay ? 'TODAY' : d === addDays(sendDay, 1) ? 'TOMORROW' : 'on ' + niceDate(d)) + t;
}
/* The message, from the owner's wording: {when} is said from the day it is SENT on. */
function textCompose(j, kind, sendDay, words){
  const set = textSet(), c = jobCust(j), shop = quoteShop(), r = receiptOf(j);
  let w = words != null ? words : kind === 'booked' ? set.words_booked : set.words_reminder;
  if (!shop.signer) w = w.replace(/\{owner\} of \{company\}/g, '{company}');
  const price = set.price && r.total != null ? 'Total: PHP ' + Number(r.total).toLocaleString('en-PH', {maximumFractionDigits: 2}) : '';
  const fill = {name: c.full_name || 'there', when: textWhen(j, sendDay || manilaDate(0)), price,
    appliances: r.lines.map(l => '- ' + (l.unit || l.type) + ' - ' + l.label).join('\n'),
    owner: shop.signer || '', company: shop.name || SHOP_NAME, phone: SHOP_PHONE};
  // a line that was only fill-ins, all empty ({price} with the price off), goes; his own blank lines stay
  const out = w.split('\n').map(l => [l, l.replace(/\{(\w+)\}/g, (m, k) => k in fill ? fill[k] : m)])
    .filter(([l, f]) => f.trim() !== '' || !/\{\w+\}/.test(l)).map(([, f]) => f.trimEnd()).join('\n');
  return smsPlain(out).trim();
}
function textSample(kind){
  const r = receiptSample();
  const j = {...r.job, id: 'zz', price: r.lines.reduce((a, l) => a + l.amount, 0), customer: r.customer,
             scheduled_on: addDays(manilaDate(0), 1), slot: '09:00'};
  return textCompose(j, kind, manilaDate(0));
}

/* What a job has had: the server's record, this phone's copy, the closed app's log. */
function textsOf(j){
  const out = {...(j.texts || {})};
  Object.entries(lsGet('ws_texts', {})[j.id] || {}).forEach(([k, v]) => { if (!out[k] || (v.ok && !out[k].ok)) out[k] = v; });
  return out;
}
function textKept(jobId, key, ok, why, atMs){
  const all = lsGet('ws_texts', {}), old = Date.now() - 30 * 864e5;
  Object.keys(all).forEach(id => { Object.keys(all[id]).forEach(k => { if (Date.parse(all[id][k].at) < old) delete all[id][k]; });
    if (!Object.keys(all[id]).length) delete all[id]; });
  const at = new Date(atMs || Date.now()).toISOString();
  all[jobId] = {...(all[jobId] || {}), [key]: {ok, why: why || null, at}};
  lsSet('ws_texts', all);
  const j = db.jobs[jobId];
  write('record_text', {p_job: jobId, p_key: key, p_ok: ok, p_why: why || null, p_at: at},
    (ok ? 'Text sent — ' : 'Text not sent — ') + ((j && jobCust(j).full_name) || ''), [jobId]);
}
const textDay = key => key.split(':')[1].slice(0, 10);
// any text that went for that day, and when — "booked" and "by hand" make a reminder soon after needless
const textWentFor = (j, day) => Object.entries(textsOf(j)).filter(([k, v]) => v.ok && textDay(k) === day).map(([, v]) => Date.parse(v.at));

/* ONE sending phone for the whole shop (Guile, 2026-10-02: "multiple admins will send to one
   customer"). The switch used to live on each phone, so two admins turning it on meant every
   automatic text went twice. Now texts.sender on the server names the phone (35): turning it on
   here claims it, and every other phone stops at its next refresh. */
function myPhoneId(){
  let id = lsGet('ws_phone_id', '');
  if (!id){ id = uuid(); lsSet('ws_phone_id', id); }
  return id;
}
const textSender = () => textSet().sender || null;
/* Who may send texts (Guile, 2026-10-02): Admin → Users → a person → "Sends texts to customers".
   Off: no Texts to customers in Settings, no 💬 Text, no Text all. The server refuses them too (36). */
const textTexters = () => Array.isArray(textSet().texters) ? textSet().texters : [];
const canTextHere = () => !!db && db.role === 'admin' && !!session && textTexters().includes(session.uid);
const isSenderHere = () => { const s = textSender(); return !!s && s.id === myPhoneId(); };
const smsSender = () => smsCapable() && canTextHere() && isSenderHere() && smsChecks().ready;
const textable = j => j.status === 'scheduled' && j.scheduled_on && j.scheduled_on >= manilaDate(0) && digits(jobCust(j).contact).length >= 10;
/* The reminders this phone's alarm should send, written now. */
function textPlan(){
  const set = textSet(), since = Date.parse(set.since || '') || Infinity, now = Date.now(), plan = [];
  if (!set.auto || !smsSender()) return plan;
  Object.values(db.jobs).filter(textable).forEach(j => {
    const d = j.scheduled_on, until = jobUntil(j), had = textsOf(j), sched = Date.parse(j.schedule_at || '') || 0;
    [['before', set.before_on, addDays(d, -1), set.before_at], ['today', set.today_on, d, set.today_at]].forEach(([kind, on, day, hhmm]) => {
      const key = kind + ':' + d, at = manilaMs(day, hhmm);
      if (!on || had[key] || at < since || at >= until || until <= now) return;
      if (sched > at - 12 * 3600e3 && (set.booked || sched > at)) return;   // the "booked" text has just said it
      if (textWentFor(j, d).some(t => t > at - 12 * 3600e3)) return;      // sent by hand that evening
      plan.push({id: j.id + '|' + key, job: j.id, key, to: digits(jobCust(j).contact), text: textCompose(j, 'reminder', day), at, until, sim: smsSim()});
    });
  });
  return plan.sort((a, b) => a.at - b.at);
}
let textBusy = false;
const smsSendNow = (no, text) => window.AndroidBridge.sendSmsSim ? wsNet.call('sendSmsSim', [no, text, smsSim()]) : wsNet.call('sendSms', [no, text]);
/* After every refresh: take in what the closed app sent, hand it the new plan, and send the
   "booked" texts this phone has not sent yet. */
async function textTick(){
  if (!smsCapable() || textBusy || !db || db.role !== 'admin') return;
  textBusy = true;
  try {
    let log = [];
    if (canTextHere()) try { log = JSON.parse(window.AndroidBridge.textLog() || '[]'); } catch (e) {}
    if (log.length){
      log.forEach(e => textKept(e.job, e.key, !!e.ok, e.why, e.at));
      window.AndroidBridge.forgetTextLog(JSON.stringify(log.map(e => e.id)));
    }
    const plan = JSON.stringify(textPlan());
    if (plan !== lsGet('ws_text_plan', '')){
      const r = window.AndroidBridge.setTextPlan(plan);
      if (r === 'ok') lsSet('ws_text_plan', plan); else console.error('text plan:', r);
    }
    const set = textSet(), since = Date.parse(set.since || '') || Infinity;
    if (!set.auto || !set.booked || !smsSender()) return;
    for (const j of Object.values(db.jobs).filter(textable)){
      const key = 'booked:' + j.scheduled_on + (j.slot ? ' ' + j.slot : '');
      if (textsOf(j)[key] || !(Date.parse(j.schedule_at || '') >= since) || jobUntil(j) <= Date.now()) continue;
      await textSend(j, key, textCompose(j, 'booked', manilaDate(0)));
    }
  } finally { textBusy = false; }
}
/* One text, now, from this phone; recorded either way. */
async function textSend(j, key, text){
  try { await smsSendNow(digits(jobCust(j).contact), text); textKept(j.id, key, true); return true; }
  catch (e) { textKept(j.id, key, false, e.message); return false; }
}
/* What a job has had, for the office: on the job screen and the Text screen. */
function textsDoneHtml(j){
  const rows = Object.entries(textsOf(j)).sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at));
  if (!rows.length) return '';
  const when = iso => new Date(iso).toLocaleString('en-PH', {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
  return `<div class="card">${rows.slice(0, 8).map(([k, v]) => `<div class="sms-note${v.ok ? '' : ' bad'}">💬 ${esc(TEXT_KIND[k.split(':')[0]] || 'Text')} for ${esc(shortDate(textDay(k)))} — ${esc(v.ok ? 'sent ' + when(v.at) : 'not sent ' + when(v.at) + (v.why ? ': ' + v.why : ''))}</div>`).join('')}</div>`;
}
const textBtn = j => !canTextHere() || ['cancelled', 'done'].includes(j.status) || digits(jobCust(j).contact).length < 10 ? ''
  : `<button type="button" class="b" data-act="textjob" data-id="${esc(j.id)}">💬 Text</button>`;

/* The job's Text button: the reminder, written, his to change; Send from this phone, or Share. */
function panelText(p){
  const j = db.jobs[p.id];
  if (!j) return {title: 'Text', body: empty('This job is no longer on this phone.')};
  const c = jobCust(j), body = p.text != null ? p.text : textCompose(j, 'reminder', manilaDate(0));
  const canSend = smsCapable() && smsState() !== 'none';
  // two admins, one customer: say so when someone texted them in the last 24 hours
  const recent = Object.entries(textsOf(j)).filter(([, v]) => v.ok && Date.now() - Date.parse(v.at) < 864e5)
    .sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at))[0];
  const already = recent ? `<div class="sms-note bad">⚠️ Already texted ${esc(new Date(recent[1].at).toLocaleString('en-PH', {weekday: 'short', hour: 'numeric', minute: '2-digit'}))} — ${esc((TEXT_KIND[recent[0].split(':')[0]] || 'a text').toLowerCase())}. Check below before sending again.</div>` : '';
  return {title: 'Text', sub: c.full_name || '', body: `
    <div class="card">
      ${kv('To', esc((c.full_name || '') + ' · ' + (c.contact || '')))}
      ${already}
      <label>The message <span class="opt">yours to change, this text only</span>
        <textarea id="txt_body" data-k="txt_body" data-txtcount="txt_count" rows="9" maxlength="700">${esc(body)}</textarea></label>
      <div class="sms-note" id="txt_count">${esc(smsCountLine(body))}</div>
      <div class="actions">
        ${canSend ? `<button type="button" class="b primary" data-act="textsend" data-id="${esc(j.id)}" ${p.busy ? 'disabled' : ''}>${p.busy ? 'Sending…' : '💬 Send from this phone'}</button>` : ''}
        ${!canSend && inApk && window.AndroidBridge.openSms ? `<button type="button" class="b primary" data-act="textopen" data-id="${esc(j.id)}">💬 Open in Messages</button>` : ''}
        <button type="button" class="b" data-act="textshare" data-id="${esc(j.id)}">📤 Share — Messenger…</button>
      </div>
      ${canSend ? '' : '<div class="sms-note">This device cannot send texts itself. Open in Messages fills in the number and the message — a tablet paired with a phone in Google Messages sends it through the phone; press Send there. Share goes to Messenger or Viber.</div>'}
    </div>
    ${textsDoneHtml(j)}`};
}
/* Tomorrow's customers, all at once — the ones not yet texted for that day. */
function textAllBar(day){
  if (day !== 'tomorrow' || !canTextHere() || !smsCapable() || smsState() === 'none') return '';
  const n = textAllJobs().length;
  return `<div class="route-bar"><span>${n ? n + ' not texted yet' : 'Everyone has had a text'}</span>
    <button type="button" class="b" data-act="textall" ${n ? '' : 'disabled'}>💬 Text all of Tomorrow</button></div>`;
}
const textAllJobs = () => jobList('tomorrow').filter(textable).filter(j => !textWentFor(j, j.scheduled_on).length);
function panelTextAll(p){
  const rows = jobList('tomorrow').filter(textable), todo = textAllJobs();
  const line = j => { const went = textWentFor(j, j.scheduled_on), r = p.done && p.done[j.id];
    return `<div class="lrow"><div class="lrow-main"><div class="lrow-title">${esc(jobCust(j).full_name || '')}</div>
      <div class="sms-note${r === false ? ' bad' : ''}">${esc(slotShort(j.slot))} · ${esc(r === true ? 'sent just now' : r === false ? 'not sent — see the job' : went.length ? 'already texted' : 'will be texted')}</div></div></div>`; };
  return {title: 'Text all of Tomorrow', sub: rows.length + ' job' + (rows.length === 1 ? '' : 's'), body: `
    <div class="card"><div class="sms-note">Each customer not yet texted for tomorrow gets the reminder, from this phone. Those already texted are left alone.</div>
      <div class="actions"><button type="button" class="b primary" data-act="textallsend" ${todo.length && !p.busy ? '' : 'disabled'}>${p.busy ? 'Sending ' + p.busy + '…' : '💬 Send to ' + todo.length}</button></div></div>
    <div class="list">${rows.map(line).join('')}</div>`};
}

/* Admin → Texts: his switches and his wording. */
const TEXT_TIMES = Array.from({length: 33}, (_, i) => String(5 + Math.floor(i / 2)).padStart(2, '0') + ':' + (i % 2 ? '30' : '00'));
function drawTexts(){
  const s = textSet();
  const sw = (k, title, info) => `<div class="card row-between">
      <div class="menu-title">${title}${info ? ' ' + infoBtn(info) : ''}</div>
      <div class="segment mini">${[[false, 'Off'], [true, 'On']].map(([v, l]) =>
        `<button type="button" class="${!!s[k] === v ? 'active' : ''}" data-act="textset" data-f="${k}" data-v="${v}">${l}</button>`).join('')}</div></div>`;
  const at = (k, on, title) => `<div class="card row-between">
      <div class="menu-title">${title}</div>
      <div class="row-gap"><select data-textat="${k}" aria-label="Time">${TEXT_TIMES.map(t => `<option value="${t}"${s[k] === t ? ' selected' : ''}>${clock12(t)}</option>`).join('')}</select>
      <div class="segment mini">${[[false, 'Off'], [true, 'On']].map(([v, l]) =>
        `<button type="button" class="${!!s[on] === v ? 'active' : ''}" data-act="textset" data-f="${on}" data-v="${v}">${l}</button>`).join('')}</div></div></div>`;
  const words = (k, kind, title) => `<div class="card">
      <div class="menu-title">${title}</div>
      <label><span class="opt">Fill-ins: ${TEXT_FILLINS.map(f => '{' + f + '}').join(' ')}</span>
        <textarea id="tw_${kind}" data-k="tw_${kind}" data-txtcount="tc_${kind}" rows="7" maxlength="700">${esc(s[k])}</textarea></label>
      <div class="sms-note" id="tc_${kind}">${esc(smsCountLine(s[k]))}</div>
      <div class="actions"><button type="button" class="b primary" data-act="textwords" data-f="${k}" data-v="${kind}">Save</button>
        <button type="button" class="b" data-act="textwordsreset" data-f="${k}" data-v="${kind}">The shop's wording</button></div>
      <div class="sms-note">Looks like this — a sample, ZZ data:</div><pre class="sms-sample">${esc(textSample(kind))}</pre>
      <div class="sms-note">${esc(smsCountLine(textSample(kind)))}</div></div>`;
  const who = textSender();
  const here = smsSender() ? '✓ This phone sends them — the only one.'
    : who ? 'Sending phone: ' + who.name + '. Only that phone sends.'
    : 'No phone sends them yet. On the owner\'s phone: Settings → This phone sends the texts.';
  return `${sw('auto', 'Send texts by themselves', 'textauto')}
    <div class="card"><div class="sms-note">${esc(here)}</div></div>
    ${at('before_at', 'before_on', 'Reminder the day before')}
    ${at('today_at', 'today_on', 'Reminder on the day')}
    ${sw('booked', 'Text when a job is scheduled or moved')}
    ${sw('price', 'Put the price in texts')}
    ${words('words_reminder', 'reminder', 'The reminder')}
    ${words('words_booked', 'booked', 'Booked or moved')}`;
}
function saveTexts(patch, label){
  const v = {...textSet(), ...patch};
  delete v.since;
  if (!('sender' in patch)) delete v.sender;   // the sending phone changes only by its own switch (35)
  if (!('texters' in patch)) delete v.texters;   // who may text changes only on Users (36)
  write('set_text_settings', {p_value: v}, 'Texts — ' + label, ['texts'], db => {
    const old = (db.settings || {}).texts || {};
    const since = v.auto ? (old.auto && old.since ? old.since : new Date().toISOString()) : undefined;
    let sender = 'sender' in patch ? (patch.sender ? {...patch.sender, uid: session.uid, at: new Date().toISOString()} : null) : old.sender || null;
    const texters = 'texters' in patch ? patch.texters : old.texters;
    if (sender && sender.uid && Array.isArray(texters) && !texters.includes(sender.uid)) sender = null;   // taken off the list (36)
    const next = {...v, ...(since ? {since} : {})};
    delete next.sender; delete next.texters;
    if (sender) next.sender = sender;
    if (texters) next.texters = texters;
    db.settings = {...(db.settings || {}), texts: next};
  });
  textTick();
}
document.addEventListener('change', e => {
  const k = e.target.dataset && e.target.dataset.textat;
  if (k) saveTexts({[k]: e.target.value}, 'time');
});
document.addEventListener('input', e => {
  const id = e.target.dataset && e.target.dataset.txtcount, out = id && document.getElementById(id);
  if (out) out.textContent = smsCountLine(smsPlain(e.target.value));
});

/* ---------------------------------------------------------------- panels
   A panel is a screen on top of the list, with Back. The stack lives in memory only, and
   every panel is redrawn by render() — the same one function as every other view
   (docs/rules/ui.md). Android's own back button closes the top one (history). */
let stack = [];
const PANELS = {booking: panelBooking, reject: panelReject, job: panelJob, schedule: panelSchedule, price: panelPrice,
  editbooking: panelEditBooking, service: panelService, receipt: panelReceipt, quote: panelQuote, jobquote: panelQuote, utype: panelUtype, ppcrop: panelPpcrop,
  bookingstatus: panelStatus, jobstatus: panelStatus,
  cancel: panelCancel, customer: panelCustomer, forget: panelForget, tidy: panelTidy, member: panelMember,
  book: panelBook, editjob: panelEditJob, settings: panelSettings, addcust: panelAddCust,
  deljob: panelDelete, delbooking: panelDelete, text: panelText, textall: panelTextAll};
const SMALL = new Set(['reject', 'schedule', 'price', 'cancel', 'forget', 'tidy', 'deljob', 'delbooking']);
// the customer's page's width, for the screens that ARE the customer's page (ui.md, Reuse)
const WIDE = new Set(['book', 'editjob', 'editbooking']);
const topPanel = () => stack[stack.length - 1];
function openPanel(p){
  stack.push(p);
  try { history.pushState({ws: stack.length}, ''); } catch (e) {}
  render();
}
/* Back closes the top screen AT ONCE; the history step follows and is ignored. Leaning on
   popstate to do the closing needed two taps whenever a history entry was left over from
   a log-out (measured 2026-09-26). Android's own back button still closes one screen. */
let ignorePop = 0;
function closePanel(){
  if (!stack.length) return;
  stack.pop();
  render();
  if (history.state && history.state.ws){ ignorePop++; history.back(); }
}
function replacePanel(p){ stack[stack.length - 1] = p; render(); }
/* Several screens at once — after a delete, the warning AND the job under it. One history
   step back, so one popstate to ignore. */
function closePanels(n){
  const k = Math.min(n, stack.length); if (!k) return;
  stack.splice(stack.length - k, k);
  render();
  const depth = history.state && history.state.ws || 0;
  if (depth){ ignorePop++; history.go(-Math.min(k, depth)); }
}
window.addEventListener('popstate', () => {
  if (ignorePop){ ignorePop--; return; }
  if (stack.length){ stack.pop(); render(); }
});
function drawPanels(){
  const host = $('#panels');
  if (!session || !db) stack = [];
  while (host.children.length > stack.length) host.lastElementChild.remove();
  stack.forEach((p, i) => {
    const key = p.kind + ':' + (p.id || '');
    let el = host.children[i];
    if (!el || el.dataset.key !== key){
      const fresh = document.createElement('div');
      fresh.innerHTML = `<div class="sheet-inner" role="dialog" aria-modal="true">
        <header class="topbar sheet-top"><div class="topbar-left">
          <button type="button" class="btn-back" data-act="back">&larr; Back</button>
          <div style="min-width:0"><div class="topbar-title sheet-title"></div><div class="topbar-sub sheet-sub"></div></div>
          <span class="sheet-info"></span>
        </div></header><div class="sheet-body"></div></div>`;
      if (el) host.replaceChild(fresh, el); else host.appendChild(fresh);
      el = fresh;
      el.dataset.key = key;
    }
    el.className = 'sheet' + (SMALL.has(p.kind) ? ' small' : '') + (WIDE.has(p.kind) ? ' wide' : '');
    el.style.zIndex = String(40 + i * 2);   // on top of the one below it, by depth (ui.md)
    let out = null;
    keepTyping($('.sheet-body', el), () => {
      out = (PANELS[p.kind] || (() => ({title: '', body: ''})))(p);
      return out.body;
    });
    if (out){
      $('.sheet-title', el).textContent = out.title || '';
      $('.sheet-sub', el).textContent = out.sub || '';
      $('.sheet-info', el).innerHTML = out.info ? infoBtn(out.info) : '';
    }
  });
  lockBody();
}

/* ================================================================ what the taps do */
function val(k){ const el = $(`[data-k="${CSS.escape(k)}"]`); return el ? (el.type === 'checkbox' ? el.checked : el.value) : null; }

/* Money: REFUSE what cannot be read, never strip it into a number (docs/rules/schema.md). */
function parsePrice(s){
  const t = String(s || '').trim().replace(/^₱\s*/, '');
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t.replace(/,/g, ''));
  // the database refuses more than this, and a refused price sat as "Not sent" for ever
  return n <= 99999999 ? n : null;
}
function goTab(tab){ ui.tab = tab; saveUi(); stack = []; render(); window.scrollTo({top: 0}); }

/* Clipboard, with the old textarea way for a browser that refuses the new one. The button
   says what happened, then goes back — a copy that fails silently looks like it worked. */
async function copyText(text, el){
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; }
  catch (_){
    const t = document.createElement('textarea');
    t.value = text; t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(t); t.select();
    try { ok = document.execCommand('copy'); } catch (_){}
    t.remove();
  }
  const was = el.textContent;
  el.textContent = ok ? '✓ Copied' : 'Could not copy — hold and select the text instead';
  setTimeout(() => { if (el.isConnected) el.textContent = was; }, 1800);
}

const ACTIONS = {
  copystatus: (id, el) => { const p = topPanel(); if (p && p.copy) copyText(p.copy, el); },
  dismiss: id => { notices = notices.filter(n => n.id !== id); saveLocal(); render(); },
  retry: id => { const o = queue.find(o => o.op_id === id); if (o){ o.state = 'pending'; delete o.error; saveLocal(); flush(); } },
  discard: id => { queue = queue.filter(o => o.op_id !== id); db.cursor = null; saveLocal(); flush(); },
  reset: (id, el) => {
    const n = queue.length;
    if (n && !confirmTwice(el, 'Throw away ' + n + ' unsent?')) return;
    queue = []; notices = []; db = emptyDb(); db.role = session.role; saveLocal(); flush();
  },
  refresh: () => refreshNow(),
  updget: () => { if (upd.phase === 'downloaded') installUpdate(); else downloadUpdate(); },
  updlater: () => { laterThisRun = upd.found && upd.found.versionCode; render(); toast('It will ask again next time you open the app.'); },
  updcheck: async () => {
    const had = upd.found;
    await checkForUpdate();
    if (!upd.found && !upd.error && !had) toast('You already have the newest version.');
  },
  newsseen: () => { lsSet('ws_seen_build', BUILD.versionCode); render(); },
  news: () => { newsOpen = !newsOpen; render(); },   // opens in place — the change log, right there
  info: (id, el) => showInfo(el.dataset.v),
  infook: () => hideInfo(),
  logout: (id, el) => logOut(el),
  theme: (id, el) => { lsSet('ws_theme', el.dataset.v); applyTheme(); render(); },
  smssender: async (id, el) => {
    if (el.dataset.v !== 'true'){   // off: only the sending phone can let go; its alarm goes too
      if (isSenderHere()) saveTexts({sender: null}, 'no sending phone');
      return;
    }
    if (!smsChecks().ready) return toast('Every line above must be ✔️ first.', true);
    if (isSenderHere()) return;
    const was = textSender();
    let phone = ''; try { phone = window.AndroidBridge.deviceName ? window.AndroidBridge.deviceName() : ''; } catch (e) {}
    const me = ((db.profile || {}).display_name || (session.email || '').split('@')[0] || 'Office');
    saveTexts({sender: {id: myPhoneId(), name: (me + (phone ? ' · ' + phone : '')).slice(0, 80)}}, 'sending phone');
    toast(was ? 'This phone sends the texts now. ' + was.name + ' stops at its next refresh — open the app on it once.' : 'This phone sends the texts now.');
  },
  smssettings: () => window.AndroidBridge.openAppSettings(),
  smsbattery: () => window.AndroidBridge.askBatteryFree(),
  smsautostart: () => window.AndroidBridge.openAutostart(),
  texter: (id, el) => {
    const on = el.dataset.v === 'true', list = textTexters();
    if (list.includes(id) === on) return;
    const t = db.team[id] || {}, who = t.display_name || (t.email || '').split('@')[0];
    saveTexts({texters: on ? [...list, id] : list.filter(x => x !== id)}, (on ? 'texts allowed — ' : 'texts not allowed — ') + who);
  },
  smssim: (id, el) => { lsSet('ws_sms_sim', Number(el.dataset.v)); render(); textTick(); },
  smsask: async () => {
    try { await wsNet.call('askSms', []); } catch (e) { toast(e.message, true); }
    render();
  },
  textjob: id => openPanel({kind: 'text', id}),
  textsend: async id => {
    const j = db.jobs[id], p = topPanel(); if (!j || !p || p.kind !== 'text' || p.busy) return;
    const text = smsPlain(($('#txt_body') || {}).value || '').trim();
    if (!text) return toast('The message is empty.', true);
    if (!(await smsAllowed())) return;
    p.text = text; p.busy = true; render();
    const ok = await textSend(j, 'hand:' + (j.scheduled_on || manilaDate(0)), text);
    p.busy = false; render();
    toast(ok ? 'Sent.' : 'Not sent — the reason is under the message.', !ok);
  },
  textshare: async id => {
    const text = smsPlain(($('#txt_body') || {}).value || '').trim(), j = db.jobs[id];
    const title = 'Text to ' + ((j && jobCust(j).full_name) || 'the customer');
    try {
      if (window.AndroidBridge && window.AndroidBridge.shareText){ window.AndroidBridge.shareText(title, text); return; }
      if (navigator.share){ await navigator.share({title, text}); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    copyText(text, $('[data-act="textshare"]'));
  },
  textopen: id => {   // a device with no SIM: its Messages app, filled in; not recorded — the app cannot see Send pressed
    const j = db.jobs[id], text = smsPlain(($('#txt_body') || {}).value || '').trim();
    if (!j || !text) return toast('The message is empty.', true);
    if (!window.AndroidBridge.openSms(digits(jobCust(j).contact), text)) toast('No Messages app on this device — use Share.', true);
  },
  textall: () => openPanel({kind: 'textall', done: {}}),
  textallsend: async () => {
    const p = topPanel(); if (!p || p.kind !== 'textall' || p.busy) return;
    const todo = textAllJobs(); if (!todo.length) return;
    if (!(await smsAllowed())) return;
    const today = manilaDate(0);
    for (let i = 0; i < todo.length; i++){
      p.busy = (i + 1) + ' of ' + todo.length; render();
      p.done[todo[i].id] = await textSend(todo[i], 'hand:' + todo[i].scheduled_on, textCompose(todo[i], 'reminder', today));
    }
    p.busy = false; render();
    const bad = Object.values(p.done).filter(v => !v).length;
    toast(bad ? bad + ' not sent — open the job to see why.' : 'All sent.', !!bad);
  },
  textset: (id, el) => {
    const f = el.dataset.f, on = el.dataset.v === 'true';
    if (!!textSet()[f] === on) return;
    saveTexts({[f]: on}, {auto: 'by themselves', before_on: 'the day before', today_on: 'on the day', booked: 'when scheduled', price: 'the price'}[f] + (on ? ' on' : ' off'));
    if (f === 'auto' && on && !smsSender()) toast('Turned on. Now, on the owner\'s phone: Settings → This phone sends the texts.');
  },
  textwords: (id, el) => {
    const v = (($('#tw_' + el.dataset.v) || {}).value || '').trim();
    if (!v) return toast('The message is empty.', true);
    saveTexts({[el.dataset.f]: v}, 'wording'); toast('Saved.');
  },
  textwordsreset: (id, el) => {
    const box = $('#tw_' + el.dataset.v); if (box) box.value = TEXT_WORDS[el.dataset.v];
    saveTexts({[el.dataset.f]: TEXT_WORDS[el.dataset.v]}, 'wording'); toast('Back to the shop\'s wording.');
  },
  smstest: async () => {
    const no = digits(val('smsTestNo') || '');
    if (no.length < 10){ toast('Type the number to send it to, e.g. 0917 123 4567.', true); return; }
    smsBusy = true; render();
    const t = {no, at: new Date().toISOString()};
    try { t.parts = Number(await smsSendNow(no, smsTestText())); t.ok = true; }
    catch (e) { t.ok = false; t.why = e.message; }
    smsBusy = false; lsSet('ws_sms_test', t); render();
  },
  months: (id, el) => {
    const n = Math.min(24, Math.max(1, checkupMonths() + Number(el.dataset.v)));
    write('set_shop_setting', {p_key: 'checkup_months', p_value: n}, 'Check-up gap ' + n + ' month' + (n === 1 ? '' : 's'), ['checkup_months'],
      db => { db.settings = {...(db.settings || {}), checkup_months: n}; });
  },

  tab: (id, el) => goTab(el.dataset.v),
  adminsec: (id, el) => { ui.adminSec = el.dataset.v; saveUi(); render(); },
  showprices: (id, el) => {
    const on = el.dataset.v === 'true';
    if (!!((db.settings || {}).show_prices) === on) return;
    write('set_shop_setting', {p_key: 'show_prices', p_value: on}, on ? 'Show prices on the booking page' : 'Hide prices from the booking page',
      ['show_prices'], db => { db.settings = {...(db.settings || {}), show_prices: on}; });
  },
  print: id => {
    const j = id && db.jobs[id];
    printHtml(receiptHtml(j ? receiptOf(j) : receiptSample()), 'Receipt');
  },
  // ---- the appliance list (27)
  savetype: id => {
    const p = topPanel(); if (!p || p.kind !== 'utype') return;
    const label = String(p.label || '').trim();
    if (!label || label.length > 40 || /[<>"&]/.test(label)){ notice('Give it a name, up to 40 letters, without < > " or &. Nothing was saved.', true); return; }
    if (typeRows().some(x => x.label.toLowerCase() === label.toLowerCase() && x.key !== id)
        || (!id && typeRows().some(x => x.key.toLowerCase() === label.toLowerCase()))){
      notice('There is already one called ' + label + '. Nothing was saved.', true); return;
    }
    if (!p.services.some(k => (svcRows().find(x => x.key === k) || {}).active)){
      notice('Tick at least one service it offers. Nothing was saved.', true); return;
    }
    const t = id ? typeOf(id) : null;
    if (t){ saveType(t, {label, icon: p.icon, services: [...p.services]}, 'Appliance — ' + label); closePanel(); return; }
    // a new one: its first name is its key, for good (27)
    const sort = Math.max(0, ...typeRows().map(x => x.sort || 0)) + 10;
    write('save_unit_type', {p_key: null, p_label: label, p_icon: p.icon, p_active: true, p_sort: sort, p_services: [...p.services]},
      'Appliance — ' + label, ['type:' + label], db => {
        if (!db.types || !db.types.length) db.types = BUILTIN_TYPES.map((x, n) => ({...x, active: true, sort: (n + 1) * 10}));
        db.types.push({key: label, label, icon: p.icon, active: true, sort, services: [...p.services]});
      });
    closePanel();
    toast(label + ' is on the booking page. Give it its prices in Services & prices.');
  },
  typesvc: (id, el) => {
    const p = topPanel(); if (!p || p.kind !== 'utype') return;
    const k = el.dataset.v, i = p.services.indexOf(k);
    if (i >= 0) p.services.splice(i, 1); else p.services.push(k);
    render();
  },
  typeshow: (id, el) => {
    const t = typeOf(id); if (!t) return;
    const on = el.dataset.v === '1';
    if (!on && activeTypes().length <= 1){ notice('Keep at least one on the booking page.', true); return; }
    saveType(t, {active: on}, (on ? 'Bring back — ' : 'Remove — ') + t.label);
    closePanel();
    toast(on ? t.label + ' is back on the booking page.' : t.label + ' is off the booking page. Removed — tap it to bring it back.');
  },
  ppuse: () => usePagePhoto(),
  ppremove: id => setPagePhotos(pagePhotos().filter(p => p !== id), 'Page photos — one removed'),
  typemove: (id, el) => {
    const shown = activeTypes().slice(), i = shown.findIndex(x => x.key === id), j = i + Number(el.dataset.v);
    if (i < 0 || j < 0 || j >= shown.length) return;
    [shown[i], shown[j]] = [shown[j], shown[i]];
    // number the shown ones 10, 20, 30… and write only the ones that moved
    shown.forEach((t, n) => { const want = (n + 1) * 10; if (t.sort !== want) saveType(t, {sort: want}, 'Order — ' + t.label); });
    render();
  },
  // ---- the quotation (25)
  qtzoom: () => { qtFull = !qtFull; render(); },
  qtline: (id, el) => {
    const p = topPanel(); if (!p || !p.q) return;
    if (el.dataset.v === 'add'){
      if (p.q.lines.length >= 30) return toast('A quotation has at most 30 lines.', true);
      p.q.lines.push({text: '', qty: '1', price: ''});
    } else p.q.lines.splice(Number(el.dataset.i), 1);
    p.dirty = true;
    render();
  },
  qtfill: () => {
    const p = topPanel(), src = p && p.q && quoteSrc(p); if (!src) return;
    p.q.lines = quoteLinesFrom(src.units);
    p.dirty = true;
    render(); toast('The lines are the booking’s aircons again, at the price list’s prices.');
  },
  savequote: () => {
    const p = topPanel(), src = p && p.q && quoteSrc(p); if (!src) return false;
    if (!src.open){ toast('This ' + (src.job ? 'job' : 'booking') + ' is ' + src.state + ': the quotation stays as it was.', true); return false; }
    const {q, bad} = quoteCheck(p.q);
    if (bad){ toast(bad + ' Nothing was saved.', true); return false; }
    const row = src.row, v = (row.quote && row.quote.v) || 0, total = qtTotal(q.lines);
    write(src.fn, {[src.arg]: row.id, p_quote: q, p_based_on: v}, 'Quotation for ' + src.name, [row.id], () => {
      row.quote = {...q, v: v + 1, total, saved_at: new Date().toISOString(), saved_by_name: (db.profile || {}).display_name || ''};
      if (src.job) row.price = total;   // a job's quotation is its price (26)
    });
    p.dirty = false;
    toast(src.job ? 'Quotation saved — the job’s price is now ' + peso(total) + '.' : 'Quotation saved.');
    return true;
  },
  printquote: () => quotePaper(false),
  sharequote: () => quotePaper(true),
  savequoteshop: () => {
    const cur = (db.settings || {}).quote_shop || {}, v = {};
    ['name', 'tagline', 'address', 'contact', 'tin', 'signer', 'title'].forEach(k => { v[k] = (($('#qs_' + k) || {}).value || '').trim(); });
    if (['name', 'tagline', 'address', 'contact', 'tin', 'signer', 'title'].every(k => (cur[k] || '') === v[k])) return toast('Nothing changed.');
    write('set_shop_setting', {p_key: 'quote_shop', p_value: v}, 'Quotation — letterhead', ['quote_shop'],
      db => { db.settings = {...(db.settings || {}), quote_shop: v}; });
    toast('Saved.');
  },
  savequotenote: () => {
    const v = ($('#qs_note') || {}).value || '';
    write('set_shop_setting', {p_key: 'quote_note', p_value: v}, 'Quotation — the usual note', ['quote_note'],
      db => { db.settings = {...(db.settings || {}), quote_note: v}; });
    toast('Saved. New quotations start with this note.');
  },
  sigremove: () => {
    const at = 'local-' + Date.now();
    write('set_shop_setting', {p_key: 'quote_signature', p_value: ''}, 'Quotation — signature removed', ['quote_signature'],
      db => { db.settings = {...(db.settings || {}), quote_signature_at: at}; });
    sigCache = {key: sigKey(), at, png: ''}; lsSet(sigKey(), {at, png: ''});
    render();
  },
  // Edit the booking / Edit the job: THE booking form's checks, then one write each (16)
  editbooking: id => {
    const b = db.bookings[id], p = topPanel(); if (!b || !p) return;
    const bad = bookProblems('panel', p);
    if (bad.length) return bkShow('panel', p, bad);
    const units = p.units.map(u => ({...u, services: [...u.services]}));
    const details = {full_name: p.full_name.trim(), contact: p.contact.trim(), address: p.address.trim(),
      landmark: (p.landmark || '').trim(), lat: p.lat || '', lng: p.lng || '', preferred_on: p.date, slot: p.slot || 'am',
      notes: (p.notes || '').trim()};
    write('edit_booking', {p_booking: id, p_units: units, p_details: details}, 'Edit ' + b.ref, [id], () => {
      b.units = units; b.services = unionServices(units); b.unit_count = units.length;
      b.unit_type = [...new Set(units.map(u => u.type))].length === 1 ? units[0].type : 'Mixed';
      Object.assign(b, {full_name: details.full_name, contact: details.contact, address: details.address,
        landmark: details.landmark || null, lat: p.lat ? +p.lat : null, lng: p.lng ? +p.lng : null,
        preferred_on: details.preferred_on, slot: details.slot, notes: details.notes || null});
    });
    closePanel();
    toast('Saved — ' + b.ref);
  },
  savejob: id => {
    const j = db.jobs[id], p = topPanel(); if (!j || !p || p.kind !== 'editjob') return;
    const bad = bookProblems('panel', p);
    if (bad.length) return bkShow('panel', p, bad);
    const c = jobCust(j), units = p.units.map(u => ({...u, services: [...u.services]}));
    const details = {units, notes: (p.notes || '').trim()};
    if (!p._removed) details.customer = {full_name: p.full_name.trim(), contact: p.contact.trim(), address: p.address.trim(),
      landmark: (p.landmark || '').trim(), lat: p.lat || '', lng: p.lng || ''};
    const name = (details.customer && details.customer.full_name) || c.full_name || 'job';
    write('edit_job', {p_job: id, p_details: details}, 'Edit — ' + name, [id, j.customer_id].filter(Boolean), db => {
      j.units = units; j.services = unionServices(units); j.unit_count = units.length;
      j.unit_type = [...new Set(units.map(u => u.type))].length === 1 ? units[0].type : 'Mixed';
      j.unit_brand = units[0].brand || null; j.unit_model = units[0].model || null; j.notes = details.notes || null;
      const cu = details.customer, row = db.customers[j.customer_id];
      const put = r => Object.assign(r, {full_name: cu.full_name, contact: cu.contact, address: cu.address,
        landmark: cu.landmark || null, lat: cu.lat ? +cu.lat : null, lng: cu.lng ? +cu.lng : null});
      if (cu && row) put(row);
      if (cu && j.customer) put(j.customer);   // a technician's phone keeps the customer on the job
    });
    // the day goes through schedule_job, which keeps its own clock (11)
    if (!p._noWhen && p.date && (p.date !== p._origDate || (p.slot || 'am') !== p._origSlot))
      write('schedule_job', {p_job: id, p_date: p.date, p_slot: p.slot || 'am', p_decided_at: null},
        'Schedule — ' + name, [id], () => { j.scheduled_on = p.date; j.slot = p.slot || 'am'; if (j.status === 'booked') j.status = 'scheduled'; });
    closePanel();
    toast('Saved — ' + name);
  },
  saveservice: () => {
    const p = topPanel(); if (!p || p.kind !== 'service') return;
    const label = (p.label || '').trim();
    if (label.length < 2){ notice('Give the service a name. Nothing was saved.', true); return; }
    const prices = {};
    // the shown ones only: a removed one is not sent, so its prices stay (27)
    for (const t of priceTypes(p.id ? svcRows().find(x => x.key === p.id) : null).map(x => x.key)){
      const raw = (p['price_' + t] || '').trim();
      if (!raw){ prices[t] = null; continue; }
      const v = parsePrice(raw);
      if (v == null){ notice('The ' + typeLabel(t) + ' price “' + raw + '” is not a number I can read. Nothing was saved.', true); return; }
      prices[t] = v;
    }
    const key = p.id || (label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'svc')
      + '_' + Math.random().toString(16).slice(2, 6);
    const active = p.active !== '0';
    const op = write('save_service', {p_key: key, p_label: label, p_active: active, p_prices: prices}, 'Service — ' + label, ['svc:' + key], db => {
      const list = db.services || (db.services = []);
      let r = list.find(x => x.key === key);
      if (!r){ r = {key, sort: 9999}; list.push(r);
        // a new service starts on every appliance (28)
        (db.types || []).forEach(t => { if (Array.isArray(t.services) && !t.services.includes(key)) t.services.push(key); }); }
      const kept = {...(r.prices || {})};
      Object.entries(prices).forEach(([t, v]) => { if (v == null) delete kept[t]; else kept[t] = v; });
      Object.assign(r, {label, active, prices: kept});
    });
    // what to bring (37): its own write, after the service exists, only when it changed
    if (JSON.stringify(p.check || []) !== (p.check0 || '[]'))
      write('save_checklist', {p_key: key, p_items: p.check}, 'What to bring — ' + label, ['svc:' + key], db => {
        const l = db.checklists || (db.checklists = []);
        const r = l.find(x => x.key === key);
        if (r) Object.assign(r, {label, items: [...p.check]}); else l.push({key, label, items: [...p.check]});
      }, p.id ? undefined : op.op_id);
    closePanel();
  },
  // ---- what to bring (37)
  prep: (id, el) => prepWrite(id, el.dataset.do, el.dataset.v),
  prepadd: id => {
    const p = topPanel(), t = ((p && p.prepNew) || '').trim();
    if (!t){ notice('Write what to bring first.', true); return; }
    p.prepNew = ''; againTyping('prepNew', () => prepWrite(id, 'add', t));
  },
  chkadd: () => {
    const p = topPanel(); if (!p || p.kind !== 'service') return;
    const t = (p.chkNew || '').trim(); if (!t) return;
    if (!p.check.some(x => prepKey(x) === prepKey(t))) p.check.push(t.slice(0, 60));
    p.chkNew = ''; againTyping('chkNew', render);
  },
  chkx: (id, el) => { const p = topPanel(); if (p && p.check){ p.check.splice(+el.dataset.i, 1); render(); } },
  chkstarter: () => { const p = topPanel(); if (p && STARTER_LISTS[p.id]){ p.check = [...STARTER_LISTS[p.id]]; render(); } },
  viewas: (id, el) => { ui.viewAs = el.dataset.v; ui.viewMenu = false; saveUi(); render(); },
  viewmenu: () => { ui.viewMenu = !ui.viewMenu; render(); },
  inbox: (id, el) => { ui.inbox = el.dataset.v; saveUi(); render(); },
  day: (id, el) => { ui.day = el.dataset.v; saveUi(); render(); },
  techday: (id, el) => { ui.techDay = el.dataset.v; saveUi(); render(); },
  gostat: (id, el) => {
    if (el.dataset.tab === 'inbox') ui.inbox = el.dataset.v || 'new';
    if (el.dataset.tab === 'jobs') ui.day = el.dataset.v || 'today';
    goTab(el.dataset.tab);
  },

  open: (id, el) => {
    // The first time the office opens a new booking, Full status says who saw it (15).
    const b = el.dataset.kind === 'booking' && db && db.role === 'admin' && db.bookings[id];
    if (b && b.status === 'new' && !b.seen_at){
      b.seen_at = new Date().toISOString();
      write('mark_seen', {p_booking: id}, 'Seen ' + b.ref, [id]);
    }
    // this account has now seen it: its red number goes down, on this phone only
    const k = el.dataset.kind;
    // opening it asks for its history afresh: a line another phone added without changing the
    // row ("Seen · ZZ Tech") never reached a history this phone had already loaded (20)
    if (['job', 'booking', 'jobstatus', 'bookingstatus'].includes(k)) forgetStatus([id]);
    if (k === 'job'){
      // the first time THIS person opens it, the job's history says so: "👀 Seen · ZZ Tech" (20)
      const j = db && db.jobs[id];
      if (j && jobUnseen(j) && (db.role === 'admin' || inField(db.role)))   // 38: no day too
        write('mark_job_seen', {p_job: id}, 'Seen — ' + (jobCust(j).full_name || 'job'), [id]);
      markSeen('jobs', id);
    }
    if (k === 'member') markSeen('users', id);
    if (k === 'customer') seenCheckup(id);
    openPanel({kind: k, id});
  },
  // ---- the aircon cart (15)
  unitnew: (id, el) => {
    const cart = el.dataset.cart;
    if (cartUnits(cart).length >= 20){ notice('That is more than 20 aircons — please ring the shop for a bigger job.', true); return; }
    unitEd = {cart, index: -1, unit: {type: el.dataset.v, services: [], brand: '', model: '', serial: '', problem: ''}};
    drawUnitSheet();
  },
  unitedit: (id, el) => {
    const u = cartUnits(el.dataset.cart)[+el.dataset.i]; if (!u) return;
    unitEd = {cart: el.dataset.cart, index: +el.dataset.i, unit: {...u, services: [...u.services]}};
    drawUnitSheet();
  },
  unitsvc: (id, el) => {
    if (!unitEd) return;
    const k = el.dataset.v, sv = unitEd.unit.services;
    unitEd.unit.services = sv.includes(k) ? sv.filter(x => x !== k) : [...sv, k];
    drawUnitSheet();
  },
  unitdone: () => {
    if (!unitEd) return;
    const u = unitEd.unit;
    if (!u.services.length){ $('#unitMsg').textContent = 'Choose at least one service for this aircon.'; return; }
    const tr = x => (x || '').trim() || null;
    const clean = {...unitCopy(u), brand: tr(u.brand), model: tr(u.model), serial: tr(u.serial), problem: tr(u.problem)};
    const units = cartUnits(unitEd.cart), cart = unitEd.cart;
    if (unitEd.index >= 0) units[unitEd.index] = clean; else units.push(clean);
    unitEd = null; drawUnitSheet(); afterCart(cart);
  },
  unitclose: () => { unitEd = null; drawUnitSheet(); },
  unitdel: (id, el) => { cartUnits(el.dataset.cart).splice(+el.dataset.i, 1); afterCart(el.dataset.cart); },
  unitsvcx: (id, el) => {
    const units = cartUnits(el.dataset.cart), i = +el.dataset.i, u = units[i]; if (!u) return;
    u.services = u.services.filter(k => k !== el.dataset.v);
    if (!u.services.length) units.splice(i, 1);   // an aircon with nothing to do is not on the booking
    afterCart(el.dataset.cart);
  },
  cartopen: () => drawCartSheet(),
  cartclose: () => { $('#cartSheet').hidden = true; lockBody(); },
  pubreset: () => {   // R9: throw the kept booking away
    pubBook = freshPubBook(); pubUnits = []; lsDel(DRAFT_KEY);
    drawPubCart();
    const n = $('[data-bk="full_name"]', bookForm); if (n) n.focus();
  },
  pubsend: () => { $('#cartSheet').hidden = true; lockBody(); bookForm.requestSubmit(); },
  back: () => closePanel(),
  settings: () => openPanel({kind: 'settings'}),
  newbook: () => openBook(null, []),
  addcust: () => openPanel({kind: 'addcust', mode: 'new', full_name: '', contact: '', address: '', landmark: '', lat: '', lng: '', ck_every: 0, ck_next: '', ck_day: null}),
  saveaddcust: () => {
    const p = topPanel(); if (!p || p.kind !== 'addcust') return;
    const bad = [];
    if ((p.full_name || '').trim().length < 2) bad.push(['full_name', 'Type the customer’s name.']);
    if (digits(p.contact).length < 7) bad.push(['contact', 'Type a contact number — at least 7 digits.']);
    if ((p.address || '').trim().length < 4) bad.push(['address', 'Type the address.']);
    if (bad.length) return bkShow('panel', p, bad);
    const same = Object.values(db.customers).find(c => digits(c.contact) === digits(p.contact));
    if (same && p._dup !== same.full_name){ p._dup = same.full_name; render(); return; }
    const id = uuid(), on = !!(p.ck_every && p.ck_next);
    const d = {full_name: p.full_name.trim(), contact: p.contact.trim(), address: p.address.trim(),
      landmark: (p.landmark || '').trim(), lat: p.lat || null, lng: p.lng || null,
      check_every: on ? p.ck_every : null, check_next: on ? p.ck_next : null, check_day: on ? (p.ck_day || Number(p.ck_next.slice(8, 10))) : null};
    write('add_customer', {p_id: id, p_details: d}, 'Add customer — ' + d.full_name, [id], db => {
      db.customers[id] = {id, ...d, landmark: d.landmark || null, created_at: new Date().toISOString()};
    });
    closePanel();
    toast(d.full_name + ' added' + (on ? ' — checked ' + everyWord(d.check_every) + ', first ' + niceDate(d.check_next) + '.' : '.'));
  },
  // 📅 Regular check: how often (0 = off). A customer's is saved at once; the new form's on Save.
  ckevery: (id, el) => {
    const n = Number(el.dataset.v) || 0, t = manilaDate(0);
    if (id === 'new'){ const p = topPanel(); if (!p) return;
      p.ck_every = n; if (n && !p.ck_next){ p.ck_day = Number(t.slice(8, 10)); p.ck_next = addEvery(t, n, p.ck_day); }
      render(); return; }
    const c = db.customers[id]; if (!c || (c.check_every || 0) === n) return;
    // turning it on: the first check one period from today, on today's day — the date is one tap to change
    const day = n ? (c.check_next ? c.check_day : Number(t.slice(8, 10))) : null;
    const next = n ? (c.check_next && c.check_next >= t ? c.check_next : addEvery(t, n, day)) : null;
    saveCheck(c, n || null, next, day);
  },
  later: id => {   // ✓ Done in Check-ups: on to the following check date
    const c = db.customers[id], k = c && checkupOf(c); if (!k) return;
    seenCheckup(id);
    saveCheck(c, k.every, checkAfterToday(k), k.day, true);
  },
  book: (id, el) => { if (id) seenCheckup(id); openBook(id, el.dataset.svc && serviceLabels[el.dataset.svc] ? [el.dataset.svc] : []); },
  /* A choice inside a panel: kept on the panel itself, so it survives every redraw. */
  pset: (id, el) => {
    const p = topPanel(); if (!p) return;
    p[el.dataset.f] = el.dataset.v;
    if (p.kind === 'book' && el.dataset.f === 'mode'){ p.customer_id = ''; p._bad = null; p._msg = ''; }
    if (p._bad && el.dataset.f === 'customer_id' && el.dataset.v) bkClear('panel', 'customer');
    render();
  },
  // THE booking form's own taps (bookFormHtml), for the page and the office alike
  bkset: (id, el) => {
    const ctx = el.dataset.cart, s = bkState(ctx); if (!s) return;
    s[el.dataset.f] = el.dataset.v;
    bkClear(ctx, el.dataset.f);
    bkRedraw(ctx);
  },
  bktime: (id, el) => bkTime(el.dataset.cart, el.dataset.f, el.dataset.v),
  bkpin: (id, el) => bkPin(el.dataset.cart),
  bkcontact: (id, el) => bkContact(el.dataset.cart),
  bkmap: (id, el) => bkMap(el.dataset.cart),
  psvc: (id, el) => {
    const p = topPanel(); if (!p) return;
    const k = el.dataset.v;
    p.services = p.services.includes(k) ? p.services.filter(s => s !== k) : [...p.services, k];
    render();
  },
  pcount: (id, el) => {
    const p = topPanel(); if (!p) return;
    p.count = Math.min(20, Math.max(1, (p.count || 1) + Number(el.dataset.v)));
    render();
  },
  pickcust: (id, el) => { const p = topPanel(); if (!p) return; p.mode = 'existing'; p.customer_id = el.dataset.v; p._bad = null; p._msg = ''; render(); },

  setactive: (id, el) => {
    const t = db.team[id]; if (!t) return;
    const on = el.dataset.to === 'on';
    // Switching somebody off loses them their work screens, so it asks twice; on does not.
    if (!on && !confirmTwice(el, 'Tap again to switch off')) return;
    write('set_active', {p_user: id, p_active: on}, (on ? 'Switch on ' : 'Switch off ') + (t.display_name || t.email || ''), [id],
      () => { t.active = on; });
  },
  setrole: id => {
    const t = db.team[id], p = topPanel(); if (!t || !p) return;
    const role = p.role || t.role, name = (p.name != null ? p.name : (t.display_name || '')).trim();
    write('set_role', {p_user: id, p_role: role, p_display_name: name || null}, 'Role for ' + (t.email || ''), [id], () => {
      t.role = role; if (name) t.display_name = name;
    });
    closePanel();
  },

  // Accept = the customer AND the job, in one tap (Guile, 2026-09-27: no "Needs a job"),
  // with the price the owner typed first, if he typed one. Back to the Inbox afterwards: the
  // new job is a red number on Jobs until he opens it.
  accept: (id, el) => {
    const b = db.bookings[id], p = topPanel(); if (!b || b.status !== 'new') return;
    // left blank, a saved quotation's total is the price agreed (25)
    const typed = String((p && p.price) || '').trim();
    const price = typed ? parsePrice(typed) : b.quote && b.quote.total != null ? Number(b.quote.total) : null;
    if (typed && price == null){ notice('Type the price in numbers, like 1500 or 1,500.50. Nothing was accepted.', true); return; }
    const link = el.dataset.link || null, cid = link || uuid();
    const acc = write('accept_booking', {p_booking: id, p_link_to: link, p_customer_id: link ? null : cid},
      'Accept ' + b.ref, [id, cid], db => {
        b.status = 'accepted'; b.customer_id = cid; b.handled_at = b.handled_at || new Date().toISOString();
        if (!link) db.customers[cid] = {id: cid, full_name: b.full_name, contact: b.contact, address: b.address,
          landmark: b.landmark, lat: b.lat, lng: b.lng, from_booking: b.id, created_at: new Date().toISOString()};
      });
    // the job only if the Accept lands; the price only if the job does (dropAfter)
    const {jid, op} = makeJobFor(b, cid, acc.op_id);
    if (price != null) write('set_job_price', {p_job: jid, p_price: price, p_decided_at: null}, 'Price ' + peso(price), [jid],
      db => { if (db.jobs[jid]) db.jobs[jid].price = price; }, op.op_id);
    /* Guile, 2026-09-27: "I press Accept and the job always says Not scheduled." Accept now
       puts the job on the day the customer asked for; ✏️ Edit moves it. A day already
       passed stays empty, and the job says so (wantNote). */
    const on = b.preferred_on, slot = b.slot || 'am', ok = on && on >= manilaDate(0);
    // no p_decided_at: the server stamps it after "Job made", so the history reads in order
    if (ok) write('schedule_job', {p_job: jid, p_date: on, p_slot: slot},
      'Schedule ' + b.full_name, [jid], db => {
        const j = db.jobs[jid]; if (j){ j.scheduled_on = on; j.slot = slot; if (j.status === 'booked') j.status = 'scheduled'; }
      }, op.op_id);
    closePanel();
    toast(ok ? 'Accepted — scheduled for ' + niceDate(on) + ', ' + slotWord(slot) + '. ✏️ Edit changes the day.'
             : on ? 'Accepted — the day they asked for has passed. Choose one in Jobs → No date.'
             : 'Accepted — no day yet. Choose one in Jobs → No date.');
  },
  reject: id => {
    const b = db.bookings[id], p = topPanel(); if (!b) return;
    write('reject_booking', {p_booking: id, p_reason: ((p && p.why) || '').trim() || 'No reason'}, 'Reject ' + b.ref, [id], () => {
      b.status = 'rejected'; b.handled_at = b.handled_at || new Date().toISOString();
    });
    closePanel();
  },
  makejob: id => {   // a booking accepted before Accept made its job (older ones)
    const b = db.bookings[id]; if (!b) return;
    const {jid} = makeJobFor(b, b.customer_id);
    markSeen('jobs', jid);
    replacePanel({kind: 'job', id: jid});
  },
  savebook: () => {
    const p = topPanel(); if (!p || p.kind !== 'book') return;
    const bad = bookProblems('panel', p);
    if (bad.length) return bkShow('panel', p, bad);
    /* Guile, 2026-09-28: a call the owner takes goes to the Inbox first, like a booking from
       the page — reviewed, quoted, then accepted (26). Marked "By phone"; the three numbers
       count the page's bookings only. */
    const fresh = p.mode !== 'existing';
    const c = fresh ? null : db.customers[p.customer_id];
    const name = fresh ? p.full_name.trim() : c.full_name;
    const bid = uuid();
    const units = p.units.map(u => ({...u, services: [...u.services]}));
    const details = {new_customer: fresh, units, notes: (p.notes || '').trim(), date: p.date || null, slot: p.date || isClock(p.slot) ? p.slot : null};
    if (fresh) Object.assign(details, {full_name: name, contact: p.contact.trim(), address: p.address.trim(),
      landmark: (p.landmark || '').trim(), lat: p.lat || null, lng: p.lng || null});
    else details.customer_id = c.id;
    write('office_booking', {p_id: bid, p_details: details}, 'Booked by phone — ' + name, [bid], db => {
      const now = new Date().toISOString(), who = fresh ? details : c;
      db.bookings[bid] = {id: bid, ref: '…', source: 'office', status: 'new', for_customer: fresh ? null : c.id,
        full_name: name, contact: who.contact, address: who.address, landmark: who.landmark || null,
        lat: fresh ? (p.lat ? +p.lat : null) : c.lat, lng: fresh ? (p.lng ? +p.lng : null) : c.lng,
        services: unionServices(units), units, unit_count: units.length, notes: details.notes || null,
        preferred_on: details.date, slot: details.slot || 'am', seen_at: now, created_at: now, updated_at: now};
    });
    ui.tab = 'inbox'; ui.inbox = 'new'; saveUi();
    replacePanel({kind: 'booking', id: bid});
    toast('In the Inbox as a booking — make the quotation, then Accept.');
  },
  schedule: id => {
    const j = db.jobs[id], p = topPanel(); if (!j || !p) return;
    const d = p.date != null ? p.date : j.scheduled_on, s = p.slot || j.slot || 'am';
    if (!d){ notice('Choose a day first. Nothing was changed.', true); return; }
    if (!isClock(s) && s !== j.slot){ bkShow('panel', p, [['slot', 'Choose the hour.']]); return; }
    write('schedule_job', {p_job: id, p_date: d, p_slot: s, p_decided_at: null},
      'Schedule ' + (jobCust(j).full_name || 'job'), [id], () => {
        j.scheduled_on = d; j.slot = s;
        if (j.status === 'booked') j.status = 'scheduled';
      });
    closePanel();
  },
  uselist: id => {
    const j = db.jobs[id]; if (!j) return;
    const v = listNow(j); if (v == null) return;
    write('set_job_price', {p_job: id, p_price: v, p_decided_at: null}, 'Price ' + peso(v), [id], () => { j.price = v; });
    toast('Price set to ' + peso(v) + ', the price list’s.');
  },
  nopin: (id, el) => showNoPin(el.dataset.href, el.dataset.landmark),
  onway: id => {   // idea 1 (19)
    const j = db.jobs[id]; if (!j || j.on_way_at) return;
    write('set_on_way', {p_job: id}, 'On the way — ' + (jobCust(j).full_name || 'job'), [id], () => { j.on_way_at = new Date().toISOString(); });
    toast('The customer sees you are on the way.');
  },
  showpricestech: (id, el) => {   // L5
    const on = el.dataset.v === 'true';
    if (!!((db.settings || {}).show_prices_tech) === on) return;
    write('set_shop_setting', {p_key: 'show_prices_tech', p_value: on}, on ? 'Show prices to technicians & helpers' : 'Hide prices from technicians & helpers',
      ['show_prices_tech'], db => { db.settings = {...(db.settings || {}), show_prices_tech: on}; });
  },
  slotcap: (id, el) => {   // idea 3: most jobs a morning / afternoon, 0 = no limit
    const n = Math.min(50, Math.max(0, slotCap() + Number(el.dataset.v)));
    write('set_shop_setting', {p_key: 'slot_capacity', p_value: n}, n ? 'At most ' + n + ' job' + (n === 1 ? '' : 's') + ' a morning or afternoon' : 'No limit on jobs a morning',
      ['slot_capacity'], db => { db.settings = {...(db.settings || {}), slot_capacity: n}; });
  },
  sharereceipt: id => shareReceipt(id),
  closedwd: (id, el) => {   // idea 4: a weekday closed every week, on or off
    const i = Number(el.dataset.v), cur = (db.settings || {}).closed_days || [];
    const next = cur.includes(i) ? cur.filter(x => x !== i) : [...cur, i].sort();
    if (next.length > 6){ notice('At least one day must stay open.', true); return; }
    write('set_shop_setting', {p_key: 'closed_days', p_value: next}, (cur.includes(i) ? 'Open on ' : 'Closed on ') + WEEKDAYS[i] + 's',
      ['closed_days'], db => { db.settings = {...(db.settings || {}), closed_days: next}; });
  },
  closeddate: (id, el) => {   // idea 4: one date closed or opened again
    const ymd = el.dataset.v, cur = (db.settings || {}).closed_dates || [], had = cur.some(x => x.on === ymd);
    const whyBox = $('#closedWhy'), why = had ? '' : ((whyBox && whyBox.value) || '').trim().slice(0, 60);
    const next = had ? cur.filter(x => x.on !== ymd) : [...cur, {on: ymd, why: why || null}].sort((a, b) => a.on.localeCompare(b.on));
    if (whyBox && !had) whyBox.value = '';   // before the redraw, which keeps what a data-k box holds
    write('set_shop_setting', {p_key: 'closed_dates', p_value: next}, (had ? 'Open ' : 'Closed ') + niceDate(ymd) + (why ? ' — ' + why : ''),
      ['closed_dates'], db => { db.settings = {...(db.settings || {}), closed_dates: next}; });
  },
  calmonth: (id, el) => {
    const base = ui.calMonth || manilaDate(0).slice(0, 7), [y, m] = base.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + Number(el.dataset.v), 1));
    ui.calMonth = d.toISOString().slice(0, 7); saveUi(); render();
  },
  saveshop: (id, el) => {   // ideas 6 and 8
    const keys = el.dataset.v === 'gcash' ? ['gcash_number', 'gcash_name'] : [el.dataset.v];
    for (const k of keys){
      const v = (($('#shop_' + k) || {}).value || '').trim();
      if ((db.settings || {})[k] === v || (!(db.settings || {})[k] && !v)) continue;
      write('set_shop_setting', {p_key: k, p_value: v}, 'Shop — ' + k.replace('_', ' '), ['shop_' + k],
        db => { db.settings = {...(db.settings || {}), [k]: v}; });
    }
    toast('Saved.');
  },
  paid: (id, el) => {   // idea 5
    const j = db.jobs[id]; if (!j) return;
    const m = el.dataset.v || null;
    write('set_job_paid', {p_job: id, p_method: m}, m ? 'Paid by ' + PAY[m] + ' — ' + (jobCust(j).full_name || '') : 'Not paid — ' + (jobCust(j).full_name || ''),
      [id], () => { j.paid_method = m; j.paid_at = m ? new Date().toISOString() : null; });
  },
  followup: (id, el) => {   // idea 11
    const j = db.jobs[id]; if (!j) return;
    const note = el.dataset.v || null;
    write('set_job_followup', {p_job: id, p_note: note}, 'After-job call — ' + (jobCust(j).full_name || ''), [id],
      () => { j.followup_at = new Date().toISOString(); j.followup_note = note; });
    if (el.dataset.book) openBook(j.customer_id, []);
  },
  bookagain: id => bookAgain(id),   // idea 7
  exportmonth: (id, el) => exportMonth(Number(el.dataset.v)),   // idea 10
  custmap: () => customersMap(),
  routemap: (id, el) => routeMap(el.dataset.v),
  mapgo: (id, el) => mapGo(el.dataset.kind, id),
  usewant: id => {   // R1: the job gets the day the customer asked for, one tap
    const j = db.jobs[id], w = j && wantOf(j); if (!w || w.past) return;
    write('schedule_job', {p_job: id, p_date: w.on, p_slot: w.slot, p_decided_at: null},
      'Schedule ' + (jobCust(j).full_name || 'job'), [id], () => {
        j.scheduled_on = w.on; j.slot = w.slot; if (j.status === 'booked') j.status = 'scheduled';
      });
    toast('Scheduled for ' + niceDate(w.on) + ', ' + slotWord(w.slot) + ' — the technicians see it now.');
  },
  usewantform: () => {
    const p = topPanel(); if (!p || !p._want) return;
    p.date = p._want.on; p.slot = p._want.slot; bkClear('panel', 'date'); render();
  },
  price: id => {
    const j = db.jobs[id], p = topPanel(); if (!j || !p) return;
    const v = parsePrice(p.price != null ? p.price : j.price);
    if (v == null){ notice('Type the price in numbers, like 1500 or 1,500.50. Nothing was changed.', true); return; }
    write('set_job_price', {p_job: id, p_price: v, p_decided_at: null}, 'Price ' + peso(v), [id], () => { j.price = v; });
    closePanel();
  },
  status: (id, el) => {
    const j = db.jobs[id]; if (!j) return;
    const to = el.dataset.to;
    write('set_job_status', {p_job: id, p_status: to, p_decided_at: null},
      STATUS_LABEL[to] + ' — ' + (jobCust(j).full_name || 'job'), [id], () => {
        (j._prev = j._prev || []).push(j.status);
        j.status = to; j.status_by = session.uid; if (to === 'done') j.done_at = new Date().toISOString();
      });
  },
  cancel: id => {
    const j = db.jobs[id], p = topPanel(); if (!j) return;
    // Guile, 2026-09-27: an empty box is not a question — it goes as "No reason"
    const why = ((p && p.why) || '').trim() || 'No reason';
    write('set_job_status', {p_job: id, p_status: 'cancelled', p_reason: why, p_decided_at: null},
      'Cancel job — ' + (jobCust(j).full_name || ''), [id], () => {
        (j._prev = j._prev || []).push(j.status); j.status = 'cancelled'; j.cancel_reason = why; j.status_by = session.uid;
      });
    closePanel();
  },
  undo: id => {
    const j = db.jobs[id]; if (!j) return;
    write('undo_job_status', {p_job: id, p_decided_at: null}, 'Undo — ' + (jobCust(j).full_name || 'job'), [id], () => {
      if (j._prev && j._prev.length){ j.status = j._prev.pop(); j.status_by = session.uid; if (j.status !== 'done') j.done_at = null; }
    });
  },
  forget: id => {
    const c = db.customers[id], p = topPanel(); if (!c) return;
    if (!(p && p.ok)){ notice('Tick the box first — deleting cannot be undone.', true); return; }
    const today = manilaDate(0);
    if (jobsOf(id).some(j => j.status === 'in_progress' || (['booked', 'scheduled'].includes(j.status) && j.scheduled_on === today))){
      notice('They have a job on today or in progress. Finish or cancel it first. Nothing was deleted.', true); return;
    }
    const old = c.photo_path, jids = jobsOf(id).map(j => j.id);
    const bids = Object.values(db.bookings).filter(b => b.customer_id === id).map(b => b.id);
    const op = write('delete_customer', {p_customer: id}, 'Delete ' + c.full_name, [id, ...jids, ...bids], db => {
      jids.forEach(k => delete db.jobs[k]); bids.forEach(k => delete db.bookings[k]); delete db.customers[id];
    });
    if (old){ op.cleanup_photo = old; saveLocal(); }
    closePanel();
  },
  // a job or a booking, and the other half of its pair (31)
  delwork: () => {
    const p = topPanel(); if (!p || !['deljob', 'delbooking'].includes(p.kind)) return;
    if (!p.ok){ notice('Tick the box first — deleting cannot be undone.', true); return; }
    const {j, b} = workPair(p);
    const jids = Object.values(db.jobs).filter(x => (j && x.id === j.id) || (b && x.booking_id === b.id)).map(x => x.id);
    const name = (j && jobCust(j).full_name) || (b && b.full_name) || '';
    write('delete_job', p.kind === 'deljob' ? {p_job: p.id} : {p_booking: p.id},
      'Delete ' + (j ? 'job' : 'booking ' + b.ref) + (name ? ' — ' + name : ''), [...jids, ...(b ? [b.id] : [])], db => {
        jids.forEach(k => delete db.jobs[k]); if (b) delete db.bookings[b.id];
      });
    closePanels(2);   // the warning, and the job or booking it was about
  },
  tidy: () => {
    const p = topPanel() || {};
    const days = parseInt(p.days != null && p.days !== '' ? p.days : '0', 10);
    if (!(days >= 0)){ notice('Type a number of days — 0 for all of them.', true); return; }
    if (!p.ok){ notice('Tick the box first — deleted bookings cannot be brought back.', true); return; }
    write('clear_old_bookings', {p_days: days}, days ? 'Delete rejected and cancelled bookings older than ' + days + ' days'
      : 'Delete every rejected and cancelled booking', [], db => {
      const cut = Date.now() - days * 864e5;
      for (const b of Object.values(db.bookings))
        if (['rejected', 'cancelled'].includes(b.status) && new Date(b.created_at) <= cut) delete db.bookings[b.id];
    });
    closePanel();
  },
  mycancel: (id, el) => {
    const b = db.bookings[id]; if (!b) return;
    if (!confirmTwice(el, 'Tap again to cancel it')) return;   // one stray tap cancelled it
    write('cancel_my_booking', {p_ref: b.ref}, 'Cancel ' + b.ref, [id], () => { b.status = 'cancelled'; });
  },
};

document.addEventListener('click', e => {
  if (e.target.id === 'infoBox'){ hideInfo(); return; }
  if (e.target.id === 'unitSheet'){ unitEd = null; drawUnitSheet(); return; }
  if (e.target.id === 'cartSheet'){ $('#cartSheet').hidden = true; lockBody(); return; }
  // The grey behind a small panel closes it, like every Android sheet.
  if (e.target.classList && e.target.classList.contains('sheet') && e.target.classList.contains('small')){ closePanel(); return; }
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  e.preventDefault();
  const f = ACTIONS[el.dataset.act];
  if (f) f(el.dataset.id, el);
});
/* A row is a button to a keyboard too. */
document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[role=button][data-act]')){
    e.preventDefault(); e.target.click();
  }
  // an item typed in What to bring, or in the owner's list (37): Enter is its ＋ Add
  if (e.key === 'Enter' && e.target.matches && e.target.matches('[data-pf=prepNew], [data-pf=chkNew]')){
    e.preventDefault();
    const b = e.target.parentElement && e.target.parentElement.querySelector('button[data-act]'); if (b) b.click();
  }
});
document.addEventListener('input', e => {
  const t = e.target, f = t.dataset && t.dataset.pf;
  if (t.dataset && t.dataset.ued && unitEd){ unitEd.unit[t.dataset.ued] = t.value; return; }
  if (t.dataset && t.dataset.ckdate){   // 📅 the check date (24)
    const v = t.value, id = t.dataset.ckdate; if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || v < manilaDate(0)) return;
    if (id === 'new'){ const p = topPanel(); if (p){ p.ck_next = v; p.ck_day = Number(v.slice(8, 10)); t.blur(); render(); } return; }
    const c = db.customers[id]; if (c && c.check_every && c.check_next !== v){ t.blur(); saveCheck(c, c.check_every, v, Number(v.slice(8, 10))); }
    return;
  }
  if (t.dataset && t.dataset.bktime){ t.blur(); bkTime(t.dataset.cart, t.dataset.bktime, t.value); return; }   // the time (33)
  // THE booking form: every box writes to its form's state, and typing clears its red
  if (t.dataset && t.dataset.bk){
    const ctx = t.dataset.cart, s = bkState(ctx); if (!s) return;
    const f = t.dataset.bk;
    s[f] = t.type === 'checkbox' ? t.checked : t.value;
    bkClear(ctx, f);
    if (f === 'contact' && ctx !== 'pub'){ const m = $('#bookSame'); if (m) m.innerHTML = bookSame(s); }
    if (ctx === 'pub' && f !== 'website' && f !== 'consent') saveDraft();   // R9: typing is kept too
    if (f === 'date'){ t.blur(); bkRedraw(ctx); }   // the day chips follow the calendar
    return;
  }
  // the quotation (25): its boxes write to the screen's copy and redraw the page beside them
  if (t.dataset && (t.dataset.qf || t.dataset.ql)){
    const p = topPanel(); if (!p || !p.q) return;
    if (t.dataset.qf) p.q[t.dataset.qf] = t.value;
    else { const [i, k] = t.dataset.ql.split(':'); if (p.q.lines[i]) p.q.lines[i][k] = t.value; }
    p.dirty = true;
    drawQuotePreview(p);
    return;
  }
  if (f){
    const p = topPanel(); if (!p) return;
    p[f] = t.type === 'checkbox' ? t.checked : t.value;
    // Redraw only the part that answers the typing, never the box being typed in.
    if (f === 'q'){ const m = $('#bookMatches'); if (m) m.innerHTML = bookMatches(p); }
    if (f === 'contact'){ const m = $('#bookSame'); if (m) m.innerHTML = bookSame(p); }
    if (f === 'date' || t.type === 'checkbox'){ t.blur(); render(); }
    return;
  }
  if (t.id === 'custSearch'){ ui.search = t.value; saveUi(); $('#custList').innerHTML = custListHtml(); }
  if (t.id === 'teamSearch'){ ui.teamSearch = t.value; saveUi(); $('#teamList').innerHTML = teamListHtml(); }
});

/* ================================================================ sign in, register, sign out */
/* The login door (SukiRun's authForm): Log in, or make an account. Making one asks for a
   name, and whether you work here. That tick is a claim about yourself, never a role —
   the database always makes a new account a customer, and only an admin moves it up. */
function openAuth(mode){
  authOpen = true; authMode = mode;
  const f = $('#authCard'), up = mode === 'register';
  $('#authTitle').textContent = up ? 'Make an account' : 'Log in';
  $('#authHint').textContent = up
    ? 'Customers: see all your bookings in one place, even on a new phone. Staff: tick "I work here".'
    : 'For the shop\'s staff, and for customers who made an account.';
  $('#staffTick').hidden = !up;
  $('#nameRow').hidden = !up;
  $('#authSubmit').textContent = up ? 'Make my account' : 'Log in';
  $('#authSwitch').textContent = up ? 'I already have an account' : 'I don’t have an account yet';
  $('#authFoot').textContent = up
    ? 'At least 8 characters for the password. An admin gives staff their role after this.'
    : 'The first login needs internet — after that this phone works with no signal.';
  f.password.autocomplete = up ? 'new-password' : 'current-password';
  $('#authMsg').className = 'msg';
  render();
  (up ? f.name : f.email).focus();
}
function signedOut(why){
  session = null; db = null; queue = []; notices = []; stack = [];
  lsDel('ws_session');
  if (why){ authOpen = true; authMode = 'signin'; say($('#authMsg'), false, why); }
  render();
}
async function afterSignIn(){
  loadLocal();
  authOpen = false;
  render();
  await flush();
  if (!db.role) await pull();
}

$('#refreshBtn').addEventListener('click', () => refreshNow());
$('#accountBtn').addEventListener('click', () => {
  if (!session){ openAuth('signin'); return; }
  if (!db) loadLocal();
  openPanel({kind: 'settings'});
});
async function logOut(btn){
  const unsent = queue.filter(o => o.state === 'pending').length;
  if (unsent && !confirmTwice(btn, 'Log out and lose ' + unsent + ' unsent?')) return;
  const t = session.access_token;
  // This phone's copy goes with the account: the next person to use the phone must not see it.
  lsDel(dbKey()); lsDel(qKey()); lsDel(nKey());
  lsDel(DRAFT_KEY); pubBook = freshPubBook(); pubUnits = [];   // an unsent booking goes too (R9)
  signedOut(null);
  drawPubCart();
  try { await authFetch('/logout', {}, t); } catch (e) {}
}
/* A destructive button asks twice by changing its own words, not with a pop-up. */
function confirmTwice(btn, question){
  if (btn.dataset.armed){ delete btn.dataset.armed; return true; }
  btn.dataset.armed = '1'; const old = btn.textContent; btn.textContent = question;
  setTimeout(() => { if (btn.dataset.armed){ delete btn.dataset.armed; btn.textContent = old; } }, 4000);
  return false;
}
$('#authSwitch').addEventListener('click', () => openAuth(authMode === 'signin' ? 'register' : 'signin'));
$('#registerLink').addEventListener('click', e => { e.preventDefault(); openAuth('register'); });

/* The top bar's Back is only for the login door; panels carry their own. */
$('#backBtn').addEventListener('click', () => { authOpen = false; render(); });

/* Waiting for the office: check now, or say you were a customer after all. */
$('#waitAgain').addEventListener('click', async e => {
  const b = e.target; b.disabled = true; b.textContent = 'Checking…';
  db.cursor = null; await pull();
  b.disabled = false; b.textContent = 'Check again';
  if (db.profile && db.profile.signup_kind === 'employee' && db.role === 'customer')
    notice('Not yet — the office hasn’t given you a role.', false);
});
$('#waitCustomer').addEventListener('click', async e => {
  e.target.disabled = true;
  try { await rpc('i_am_a_customer', {}); db.cursor = null; await pull(); }
  catch (err) { notice(err instanceof Unreachable ? 'That needs signal — try again in a minute.' : err.message, true); }
  finally { e.target.disabled = false; }
});
$('#offLogout').addEventListener('click', e => logOut(e.target));

$('#authCard').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, msg = $('#authMsg'), btn = $('#authSubmit'), up = authMode === 'register';
  const email = f.email.value.trim(), password = f.password.value, name = f.name.value.trim();
  if (up && name.length < 2){ say(msg, false, 'Please type your name.'); f.name.focus(); return; }
  if (!/^\S+@\S+\.\S+$/.test(email)){ say(msg, false, 'Please give your email address.'); f.email.focus(); return; }
  if (password.length < 8){ say(msg, false, 'The password needs at least 8 characters.'); f.password.focus(); return; }
  btn.disabled = true;
  btn.textContent = up ? 'Making your account…' : 'Logging in…';
  try {
    if (!up){
      keepSession(await authFetch('/token?grant_type=password', {email, password}));
    } else {
      // No email confirmation (decided 2026-09-26, TODO L): making an account logs you
      // straight in. The name and the tick travel as sign-up data — claims the database
      // reads for display only (05, handle_new_user).
      const b = await authFetch('/signup', {email, password,
        data: {name, signupKind: f.staff.checked ? 'employee' : 'customer'}});
      keepSession(b.access_token ? b : await authFetch('/token?grant_type=password', {email, password}));
    }
    f.reset();
    await afterSignIn();
  } catch (err) {
    say(msg, false, err instanceof Unreachable ? 'No internet. The first login needs a signal — after that this phone works offline.'
      : /invalid login/i.test(err.message) ? 'That email and password do not match.'
      : /already registered/i.test(err.message) ? 'That email already has an account. Log in instead.'
      : err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = up ? 'Make my account' : 'Log in';
  }
});

/* ================================================================ the public page */
function say(el, ok, text){
  el.className = 'msg show ' + (ok ? 'ok' : 'err');
  el.textContent = text;
}

const bookForm = $('#bookForm');


/* The service list comes from the database, not from an array in here. Prices come with
   it only while the owner shows them (13). */
const serviceLabels = lsGet('ws_services', {});
const pubPrices = {};
loadDraft();
drawPubCart();   // THE booking form, drawn now by bookFormHtml('pub'); again when the services arrive
(async function loadServices(){
  try {
    const rows = await rpc('list_services', {}, false);
    // The fresh list REPLACES the kept one: a service the owner hid or deleted stayed on
    // offer from the phone's copy (measured 2026-09-27, "ZZ Count Test").
    Object.keys(serviceLabels).forEach(k => { delete serviceLabels[k]; });
    Object.keys(pubPrices).forEach(k => { delete pubPrices[k]; });
    rows.forEach(s => { serviceLabels[s.key] = s.label; pubPrices[s.key] = s.prices || null; });
    if (rows[0] && rows[0].shop){ pubShop = rows[0].shop; lsSet('ws_shop', pubShop); drawHeroPhotos(); }   // 21, 30
    if (rows[0] && rows[0].shop && Array.isArray(rows[0].shop.types) && rows[0].shop.types.length){
      pubTypes = rows[0].shop.types; lsSet('ws_types', pubTypes);   // 27
    }
    lsSet('ws_services', serviceLabels);
  } catch (e) {
    pubBook._msg = 'We could not load the list of services. Please ' + ringUs() + ' instead.';
    pubBook._msgOk = false;
  }
  drawPubCart();
  render();
})();

/* Booking is the one write that does NOT queue: a stranger must know, there and then,
   whether the shop has it. A failed booking must never look like a successful one. */
bookForm.addEventListener('submit', async e => {
  e.preventDefault();
  const s = pubBook;
  if (s._sending) return;
  const bad = bookProblems('pub', s);
  if (bad.length){ bkShow('pub', s, bad); return; }
  const payload = {full_name: s.full_name, contact: s.contact, address: s.address, landmark: s.landmark,
    lat: s.lat, lng: s.lng, preferred_on: s.date, slot: s.slot, notes: s.notes, website: s.website,
    units: pubUnits.map(unitCopy)};

  s._sending = true; s._msg = ''; drawPubCart();
  try {
    // Signed in as a customer, the token goes with it so the booking lands on the account.
    const res = await rpc('book_job', {payload}, !!session);
    if (!res || !res.ok || !res.ref) throw new Unreachable('no ref');
    try { localStorage.setItem(REF_KEY, res.ref); } catch (err) {}
    trackForm.code.value = res.ref;
    $('#doneRef').textContent = res.ref;
    pubBook = freshPubBook();
    pubUnits = [];
    drawPubCart();
    bookForm.hidden = true;
    $('#done').hidden = false;
    showPubBar();
    window.scrollTo({top: 0});
    if (session) pull();
  } catch (err) {
    s._msgOk = false;
    s._msg = err instanceof Refused && err.human ? err.message
      : 'Your booking was NOT sent — we could not reach the booking system. Please try again in a minute, or ' + ringUs() + '.';
    // idea 3: a full morning or afternoon — the day box goes red with the answer under it
    if (err instanceof Refused && err.human && /is full|are closed/.test(err.message)){ s._sending = false; bkShow('pub', s, [['date', err.message]]); return; }
  } finally {
    s._sending = false;
    if (s === pubBook) drawPubCart();   // a failure keeps everything typed, and says why
  }
});

$('#again').addEventListener('click', () => {
  $('#done').hidden = true;
  bookForm.hidden = false;
  showPubBar();
  const n = $('[data-bk="full_name"]', bookForm); if (n) n.focus();
});

const trackForm = $('#trackForm');
try {
  const last = localStorage.getItem(REF_KEY);
  if (last) trackForm.code.value = last;
} catch (e) {}

const STATUS_WORDS = {
  new:       'Received. We have not rung you yet — we will, to agree a time.',
  accepted:  'Accepted. For the day and where the job is now, ' + ringUs() + ' — or make an account: it shows every step.',
  rejected:  'We could not take this booking. Please ' + ringUs() + '.',
  cancelled: 'Cancelled.',
};

trackForm.addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('#trackMsg'), btn = trackForm.querySelector('button');
  $('#trackSteps').innerHTML = '';   // never the last lookup's bars under this one's error
  if (!trackForm.code.value.trim() || trackForm.contact.value.replace(/\D/g, '').length < 7){
    say(msg, false, 'Enter your reference code and the number you booked with.');
    return;
  }
  btn.disabled = true;
  try {
    $('#trackSteps').innerHTML = '';
    const res = await rpc('check_booking', {code: trackForm.code.value, contact: trackForm.contact.value}, false);
    if (!res.ok){ say(msg, false, res.message); return; }
    // the same line and bars as everywhere else — from what a stranger may be told (the
    // booking's own status: trust-boundary.md), so it goes as far as Accepted
    $('#trackSteps').innerHTML = `<div class="track-steps">${stepsHtml({booking: {status: res.status}, job: null, track: true})}</div>`;
    say(msg, res.status !== 'rejected' && res.status !== 'cancelled',
      res.ref + ' — ' + (STATUS_WORDS[res.status] || res.status) +
      ' You asked for ' + niceDate(res.preferred_on) + ', ' + slotWord(res.slot) + '.');
  } catch (err) {
    say(msg, false, err instanceof Refused && err.human ? err.message
      : 'We could not reach the booking system just now. Please try again in a minute, or ' + ringUs() + '.');
  } finally {
    btn.disabled = false;
  }
});

$('#claimForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, msg = $('#claimMsg');
  if (!f.code.value.trim() || digits(f.contact.value).length < 7){
    say(msg, false, 'Enter a reference code and the number you booked with.'); return;
  }
  try {
    const res = await rpc('claim_bookings', {p_code: f.code.value, p_contact: f.contact.value});
    if (!res.ok){ say(msg, false, res.message); return; }
    say(msg, true, res.claimed ? res.claimed + ' booking' + (res.claimed === 1 ? '' : 's') + ' added to your account.'
                               : 'Those bookings are already on an account.');
    f.reset();
    db.cursor = null; pull();
  } catch (err) {
    say(msg, false, err instanceof Unreachable ? 'Could not reach the server. This one needs signal — try again later.' : err.message);
  }
});

/* Pick on map (SukiRun's pick mode): the map moves under a pin that stays in the middle.
   MapLibre (BSD, web/vendor/) is 1 MB, so it loads only when somebody taps the button.
   Tiles: OpenFreeMap, free, no key. The page never needs it to take a booking. */
const BACOLOD = {lat: 10.6765, lng: 122.9509};
let mapObj = null, mapPickCb = null, mapLib = null;
function loadMapLib(){
  if (window.maplibregl) return Promise.resolve();
  if (mapLib) return mapLib;
  mapLib = new Promise((res, rej) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = 'vendor/maplibre-gl.css';
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = 'vendor/maplibre-gl.js'; js.onload = res;
    js.onerror = () => { mapLib = null; rej(new Error('map')); };
    document.head.appendChild(js);
  });
  return mapLib;
}
/* The markers a map to LOOK at puts down; gone when it closes or turns back into a picker. */
let mapMarks = [];
const clearMarks = () => { mapMarks.forEach(m => m.remove()); mapMarks = []; };
async function mapReady(start, zoom){
  const msg = $('#mapMsg');
  msg.hidden = false; msg.textContent = 'Loading the map…';
  try { await loadMapLib(); }
  catch (e) { msg.textContent = 'The map needs internet. Close this and use the list instead.'; return false; }
  const at = start || BACOLOD;
  if (!mapObj){
    mapObj = new maplibregl.Map({container: 'mapCanvas', style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [at.lng, at.lat], zoom, attributionControl: {compact: true}});
    mapObj.on('load', () => { msg.hidden = true; });
    mapObj.on('error', () => { msg.hidden = false; msg.textContent = 'Part of the map did not load. Check the signal.'; });
  } else {
    mapObj.resize(); mapObj.jumpTo({center: [at.lng, at.lat], zoom}); msg.hidden = true;
  }
  return true;
}
/* A map to look at: [{lat, lng, label, cls, title, onTap}], and HTML for under it. */
async function openMapView(title, sub, points, below){
  const sheet = $('#mapSheet');
  sheet.classList.add('view');
  $('#mapTitle').textContent = title; $('#mapSub').textContent = sub;
  $('#mapList').innerHTML = below || '';
  sheet.hidden = false; document.body.classList.add('locked');
  clearMarks();
  if (!await mapReady(points[0] || null, 13)) return;
  points.forEach(pt => {
    const el = document.createElement('button');
    el.type = 'button'; el.className = 'map-mark ' + (pt.cls || ''); el.title = pt.title || '';
    el.innerHTML = `<b>${esc(pt.label)}</b><span aria-hidden="true">${pt.icon || '🏠'}</span>`;
    el.addEventListener('click', ev => { ev.stopPropagation(); if (pt.onTap) pt.onTap(); });
    mapMarks.push(new maplibregl.Marker({element: el, anchor: 'bottom'}).setLngLat([pt.lng, pt.lat]).addTo(mapObj));
  });
  if (points.length > 1){
    const b = new maplibregl.LngLatBounds();
    points.forEach(pt => b.extend([pt.lng, pt.lat]));
    mapObj.fitBounds(b, {padding: 70, maxZoom: 16, duration: 0});
  } else if (points.length === 1) mapObj.jumpTo({center: [points[0].lng, points[0].lat], zoom: 16});
}
/* From the map to a screen: the map closes first, or it would cover the screen. */
function mapGo(kind, id){
  closeMapPick(); openPanel({kind, id});
  if (kind === 'customer') seenCheckup(id);
  if (kind === 'job') markSeen('jobs', id);
}
const daysSince = ymd => Math.max(0, Math.round((new Date(manilaDate(0) + 'T00:00:00Z') - new Date(ymd + 'T00:00:00Z')) / 864e5));
const mapRow = (kind, id, title, sub, lead) => `<div class="lrow" role="button" tabindex="0" data-act="mapgo" data-kind="${kind}" data-id="${esc(id)}">
    <div class="avatar">${esc(lead)}</div><div class="lrow-main"><div class="lrow-title">${esc(title)}</div>
    <div class="lrow-sub">${esc(sub)}</div></div></div>`;
/* L1 (Guile, 2026-09-27): every pinned customer, a 🏠 with the days since their last finished
   job ("17" = 17 days ago). Red once their check-up is due — the map is the call list too.
   Nobody unpinned goes missing quietly: they are listed under the map. */
function customersMap(){
  const today = manilaDate(0), pts = [], none = [];
  for (const c of Object.values(db.customers)){
    if (c.full_name === '(removed)') continue;
    if (c.lat == null || c.lng == null){ none.push(c); continue; }
    const k = checkupOf(c), days = k && k.last ? daysSince(manilaDay(k.last.done_at)) : null;
    const due = k && !k.busy && k.due <= today;
    pts.push({lat: +c.lat, lng: +c.lng, label: days == null ? '–' : String(days), cls: due ? 'due' : days == null ? 'never' : '',
      title: c.full_name + (days == null ? ' — no finished job yet' : ' — last visit ' + days + ' day' + (days === 1 ? '' : 's') + ' ago'),
      onTap: () => mapGo('customer', c.id)});
  }
  const legend = `<div class="map-legend"><span><i style="background:#5b6b7b"></i>days since the last visit</span>
    <span><i style="background:#d64545"></i>check-up due</span><span><i style="background:#3b82f6"></i>no finished job yet</span></div>`;
  const list = none.length
    ? `<div class="fieldlabel">${none.length} not on the map — no pin yet. Pin them with ✏️ Edit on their job.</div>` +
      none.sort((a, b) => a.full_name.localeCompare(b.full_name)).map(c => mapRow('customer', c.id, c.full_name, c.address || '', initials(c.full_name))).join('')
    : pts.length ? '' : '<p class="hint">No customers yet.</p>';
  openMapView('Customers on the map', pts.length + ' pinned · the number is days since the last visit', pts, legend + list);
}
/* Idea 2: the day's route — numbered stops on the map, the same order as the list. */
function routeMap(day){
  const stops = routeStops(day), pts = [];
  stops.forEach((j, i) => {
    const c = jobCust(j);
    if (c.lat != null && c.lng != null) pts.push({lat: +c.lat, lng: +c.lng, label: String(i + 1), cls: 'stop', icon: '📍',
      title: (i + 1) + '. ' + (c.full_name || '') + ' — ' + slotShort(j.slot), onTap: () => mapGo('job', j.id)});
  });
  const list = stops.map((j, i) => { const c = jobCust(j);
    return mapRow('job', j.id, (c.full_name || 'Job'), slotShort(j.slot) + ' · ' + place(c) + (c.lat == null ? ' · no pin — Google Maps finds the address' : ''), String(i + 1)); }).join('')
    + `<a class="b primary wide" target="_blank" rel="noopener" href="${esc(routeUrl(stops))}">Open in Google Maps</a>`;
  openMapView((day === 'today' ? 'Today' : 'Tomorrow') + '’s route', stops.length + ' stop' + (stops.length === 1 ? '' : 's') + ', morning first', pts, list);
}
async function openMapPick(start, onPick){
  const sheet = $('#mapSheet'), msg = $('#mapMsg');
  sheet.classList.remove('view'); clearMarks();
  $('#mapTitle').textContent = 'Pick the house'; $('#mapSub').textContent = 'Move the map until the pin is on the roof';
  mapPickCb = onPick;
  sheet.hidden = false; document.body.classList.add('locked');
  msg.hidden = false; msg.textContent = 'Loading the map…';
  try { await loadMapLib(); }
  catch (e) { msg.textContent = 'The map needs internet. Close this and use the landmark instead.'; return; }
  const at = start || BACOLOD, zoom = start ? 18 : 13;
  if (!mapObj){
    mapObj = new maplibregl.Map({container: 'mapCanvas', style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [at.lng, at.lat], zoom, attributionControl: {compact: true}});
    mapObj.on('load', () => { msg.hidden = true; });
    mapObj.on('error', () => { msg.hidden = false; msg.textContent = 'Part of the map did not load. Check the signal.'; });
  } else {
    mapObj.resize(); mapObj.jumpTo({center: [at.lng, at.lat], zoom}); msg.hidden = true;
  }
}
function closeMapPick(){ $('#mapSheet').hidden = true; clearMarks(); lockBody(); }
$('#mapBack').addEventListener('click', closeMapPick);
$('#mapUse').addEventListener('click', () => {
  if (!mapObj) return;
  const c = mapObj.getCenter();
  closeMapPick();
  if (mapPickCb) mapPickCb({lat: c.lat, lng: c.lng});
});
$('#mapLocate').addEventListener('click', () => {
  if (!navigator.geolocation || !mapObj) return;
  navigator.geolocation.getCurrentPosition(p => mapObj.flyTo({center: [p.coords.longitude, p.coords.latitude], zoom: 18}),
    () => { const m = $('#mapMsg'); m.hidden = false; m.textContent = 'Could not find you — move the map by hand.'; },
    {enableHighAccuracy: true, timeout: 12000, maximumAge: 60000});
});

/* ================================================================ more than one tab
   Two tabs of the app share one saved copy but each keeps its own in memory. Without this,
   each tab saved its own queue over the other's — measured 2026-09-26: a refused write
   fixed in one tab kept coming back from the owner's other tab. Now a tab that sees the
   saved copy change takes it, and redraws. */
window.addEventListener('storage', e => {
  if (!e.key || !e.key.startsWith('ws_')) return;
  if (e.key === 'ws_session'){
    const s = lsGet('ws_session', null);
    if (!s){ if (session){ session = null; db = null; queue = []; notices = []; render(); } return; }
    if (!session || s.uid !== session.uid){ session = s; loadLocal(); render(); flush(); return; }
    session = s;   // a refreshed token from the other tab
    return;
  }
  if (session && (e.key === dbKey() || e.key === qKey() || e.key === nKey())){
    loadLocal();
    render();
  }
});

/* ================================================================ start */
window.addEventListener('online',  () => { online = true; flush(); });
window.addEventListener('offline', () => { online = false; render(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && session){ flush(); render(); textTick(); } });   // back from Android's settings: the ✔ / ❌ again
setInterval(() => { if (session && !document.hidden) flush(); }, 30000);

applyTheme();
if (session){ loadLocal(); render(); flush(); } else render();
updateOnLaunch();

/* Android's Back, inside the APK: close what is on top, then the login door. False means
   there is nowhere left to go, and the app may close. */
// the APK could not make or send the quotation PDF (MainActivity.sharePdf)
window.wsShareFailed = why => toast('The PDF did not go: ' + why + '. Print or save as PDF still works.', true);
window.wsBack = () => {
  if (!$('#unitSheet').hidden){ unitEd = null; drawUnitSheet(); return true; }
  if (!$('#cartSheet').hidden){ $('#cartSheet').hidden = true; lockBody(); return true; }
  if (!$('#mapSheet').hidden){ closeMapPick(); return true; }
  if (!$('#infoBox').hidden){ hideInfo(); return true; }
  if (stack.length){ closePanel(); return true; }
  if (authOpen){ authOpen = false; render(); return true; }
  return false;
};

/* The page opens without signal too, once it has been opened once (Phase 6). */
// Not inside the APK: there the page and its files are already on the phone.
if ('serviceWorker' in navigator && location.protocol !== 'file:' && !window.AndroidBridge){
  // updateViaCache 'none': the worker file itself is never taken from the HTTP cache either.
  navigator.serviceWorker.register('sw.js', {updateViaCache: 'none'}).catch(() => {});
}
