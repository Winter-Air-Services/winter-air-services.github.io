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
const DB_SHAPE = 56;   // the last migration that added a column the phone keeps (45: jobs.billing, 46: jobs.crew, 53: customers.photos, bookings.photo_count, 56: checkins)
function emptyDb(){ return {cursor: null, role: null, repair: REPAIR_ID, bookings: {}, customers: {}, jobs: {}, team: {}, settings: {}, checkins: {}}; }
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
  if (!db.checkins) db.checkins = {};   // 56: a copy made before the times
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
        // a person's old picture, replaced or taken off: its file goes too (51)
        if (op.fn === 'set_staff_photo' && res && res.old){ storage('DELETE', res.old, null, false, 'staff-photos').catch(() => {}); dropKept(res.old); }
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
    sweepWorkPhotos();   // 39
    reportHaves(); fetchMissingPhotos();   // 46
    moveBookingPics();   // 53
    carryOver();         // 41
    sendPlace();         // 58
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
  // A new column never arrives by "what changed since" either: a row untouched since the
  // server got it keeps the old shape on this phone (measured 2026-10-10 on the owner's tablet:
  // 15 of 30 jobs had no work_photos, so no Work photo button). One full copy whenever this
  // app knows a newer server than the copy was made from. Raise DB_SHAPE with each new column.
  if ((db.shape || 0) < DB_SHAPE){ db.cursor = null; db.shape = DB_SHAPE; }
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
  // 49: the reward switch and this technician's share change every job's reward the same way
  const priceKey = s => [!!s.show_prices_tech, s.tech_reward, s.my_pct].join('|');
  if (inField(db.role) && res.settings && 'show_prices_tech' in res.settings && db.cursor !== null
      && priceKey(db.settings || {}) !== priceKey(res.settings)){
    // L5: the office switched prices on or off — the jobs themselves did not change, so an
    // ordinary pull would keep them with (or without) their price
    db.settings = res.settings; db.cursor = null; saveLocal();
    return pull();
  }
  if (db.role === 'admin' && db.cursor !== null && res.settings && 'tech_edit_others' in res.settings
      && Object.values(db.team).some(t => !('share_pct' in t))){
    // 49: the people were copied before they had a share — once, a full copy brings it
    db.cursor = null; saveLocal();
    return pull();
  }
  const busy = new Set(queue.flatMap(o => o.touches));
  const before = {bookings: {...db.bookings}, customers: {...db.customers}, jobs: {...db.jobs}};
  if (db.cursor === null){           // a full copy: anything not in it is gone
    for (const k of ['bookings', 'customers', 'jobs', 'team', 'checkins'])
      for (const id of Object.keys(db[k])) if (!busy.has(id)) delete db[k][id];
  }
  // 46: a work photo taken off a job, or a deleted job's photos, leave this phone too
  for (const row of res.jobs || []) if (!busy.has(row.id) && before.jobs[row.id] && Array.isArray(row.work_photos)){
    const now = new Set(row.work_photos.map(w => w.path));
    workList(before.jobs[row.id]).forEach(w => { if (!now.has(w.path)) dropKept(w.path); });
  }
  for (const id of res.removed_jobs || []) if (!busy.has(id) && db.jobs[id]) workList(db.jobs[id]).forEach(w => dropKept(w.path));
  // 53: a customer's picture taken off, or a deleted customer's, leave this phone too
  const picsGone = (was, row) => { if (!was || !row || !Array.isArray(row.photos)) return;
    const now = new Set(row.photos.map(w => w.path)); custPicList(was).forEach(w => { if (!now.has(w.path)) dropKept(w.path); }); };
  for (const row of res.customers || []) if (!busy.has(row.id)) picsGone(before.customers[row.id], row);
  for (const row of res.jobs || []) if (!busy.has(row.id) && before.jobs[row.id]) picsGone(before.jobs[row.id].customer, row.customer);
  for (const id of res.removed_customers || []) if (!busy.has(id) && db.customers[id]) custPicList(db.customers[id]).forEach(w => dropKept(w.path));
  for (const k of ['bookings', 'customers', 'jobs'])
    for (const row of res[k] || []) if (!busy.has(row.id)) db[k][row.id] = row;
  for (const row of res.team || []) db.team[row.id] = row;
  for (const id of res.removed_jobs || []) if (!busy.has(id)) delete db.jobs[id];
  for (const id of res.removed_bookings || []) if (!busy.has(id)) delete db.bookings[id];
  for (const id of res.removed_customers || []) if (!busy.has(id)) delete db.customers[id];   // 22
  // 56: the times — a tombstone takes one off (the office keeps it, to show who and to bring it
  // back); older than the server's window leaves this phone
  for (const row of res.checkins || []) if (!busy.has(row.id)){
    if (row.removed_at && db.role !== 'admin') delete db.checkins[row.id]; else db.checkins[row.id] = row;
  }
  const ckFrom = manilaDate(db.role === 'admin' ? -100 : -35);
  for (const k of Object.values(db.checkins)) if (k.day < ckFrom && !busy.has(k.id)) delete db.checkins[k.id];
  if (res.checkin_rules && !queue.some(o => o.fn === 'set_checkin_rule')) db.checkinRules = res.checkin_rules;
  if (res.seen) db.seen = res.seen;   // 56: everybody's last heartbeat (admin only)
  if (res.places) db.places = res.places;   // 58: the users map, and who was asked (admin only)
  if (res.asked && !queue.some(o => o.fn === 'ask_location')) db.asked = res.asked;
  if ('ask_location' in res) db.askLocation = res.ask_location;   // 58: the office asked this person
  db.cursor = res.cursor || db.cursor;
  if (res.profile) db.profile = res.profile;   // name and the "I work here" claim
  if (res.settings){   // the shop's own settings (admin only)
    // the page photos: not while a change to them is still on its way (the appliance race, 27)
    const keep = queue.some(o => o.fn === 'set_page_photos') && db.settings ? db.settings.page_photos : undefined;
    db.settings = res.settings;
    if (keep !== undefined) db.settings.page_photos = keep;
  }
  // the price list, sent whole (admin only) — not while a change or a new order is on its way (54)
  if (res.services && !queue.some(o => o.fn === 'save_service' || (o.fn === 'set_order' && o.args.p_what === 'services'))) db.services = res.services;
  if (res.staff) db.staff = res.staff;          // the shop's people by name, for Assigned to (39)
  if (res.unit_fields && !queue.some(o => o.fn === 'set_unit_fields')) db.unitFields = res.unit_fields;   // the owner's boxes (44)
  // what to bring, per service, the shop's three roles (37) — not while a change is on its way
  if (res.checklists && !queue.some(o => o.fn === 'save_checklist')) db.checklists = res.checklists;
  // the appliance list, every role (27) — not while a change to it is still on its way: two
  // quick "↑ Earlier" taps moved it one place, the second read from a copy pulled in between
  if (res.types && !queue.some(o => o.fn === 'save_unit_type' || o.fn === 'save_variant' || o.fn === 'save_service'   // 54
                                    || (o.fn === 'set_order' && o.args.p_what !== 'services'))){
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

// 54: a row held mid-drag would be redrawn out from under the finger; the drop draws once
let drag = null, dragAgain = false;
function render(){
  if (drag){ dragAgain = true; return; }
  const role = session ? (db && db.role) || session.role : null;
  const staff = role === 'admin' || inField(role);
  const profile = (db && db.profile) || {};
  // Said "I work here" and not given a role yet: a person waiting on a person, not a form.
  const waiting = role === 'customer' && profile.signup_kind === 'employee';
  const off = role === 'disabled';

  $('#who').hidden = !session;
  $('#who').innerHTML = session ? nameFx(profile.display_name || session.email || '', session.uid, 'mine') : '';   // 50
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
  // the last row scrolls clear of the two buttons: they hid its badge (measured 2026-10-12)
  document.body.classList.toggle('has-fab', !$('#fab').hidden);

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
  drawSigPads();   // the signature pad is a fresh canvas after every redraw (47)
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
    h = `<div class="update-title">✨ ${fxHeading('Winter Air ' + f.versionName + ' is available')}</div>
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
        <span class="news-chev" aria-hidden="true">▶</span> ✨ ${fxHeading('What’s new in Winter Air ' + BUILD.versionName)}</button>
      <button type="button" class="news-x" data-act="newsseen" aria-label="Close">×</button>
    </div>
    ${newsOpen ? `<div class="news-body">
      ${BUILD.releasedAt ? `<div class="news-date">${esc(BUILD.releasedAt)}</div>` : ''}
      <ul class="notes-list">${BUILD.notes.map(n => `<li>${mdLite(n)}</li>`).join('')}</ul>
      <div class="actions"><button type="button" class="b" data-act="newsseen">Got it</button></div>
    </div>` : ''}
  </div>`;
}
/* The APK of THIS version, on the release (tools/release.py names it WinterAir-<version>.apk
   beside update.json). An older link still installs: the app then offers the newest itself. */
const apkLink = () => BUILD.versionName === 'dev' || !/\/releases\/latest\/download\/update\.json$/.test(BUILD.updateUrl || '') ? ''
  : BUILD.updateUrl.replace(/latest\/download\/update\.json$/, 'download/v' + BUILD.versionName + '/WinterAir-' + BUILD.versionName + '.apk');
function aboutHtml(){
  return `<div class="sec" id="aboutSec">About</div>
    <div class="card">
      <div class="st-loc"><b>Winter Air Services</b> · version ${esc(BUILD.versionName)}${BUILD.releasedAt ? ' · ' + esc(BUILD.releasedAt) : ''}</div>
      <p class="hint">Works with no signal. Bookings and jobs are saved on this phone first and go to the office by themselves as soon as there is signal.</p>
      ${BUILD.notes.length ? `<div class="st-label">${fxHeading('What’s new in ' + BUILD.versionName)}</div>
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
  'exhaust-fan', 'water-dispenser', 'cold-room', 'ice-machine',       // drawn ahead, before he adds them
  // Guile's set, 2026-10-11 (his "HVAC and Safety Icon Grid", cut into 128 px): fire safety,
  // refrigeration, airflow, water and power
  'sprinkler', 'smoke-detector', 'fire-alarm-bell', 'fire-extinguisher', 'fire-alarm-panel', 'refrigerator',
  'display-chiller', 'range-hood', 'air-curtain', 'ceiling-fan', 'stand-fan', 'water-heater', 'water-pump',
  'generator', 'solar-inverter', 'electrical-panel'];
let pubTypes = lsGet('ws_types', null);
const typeRows = () => db && db.types && db.types.length ? db.types : pubTypes && pubTypes.length ? pubTypes : BUILTIN_TYPES;
const activeTypes = () => typeRows().filter(t => t.active !== false);
const typeOf = k => typeRows().find(t => t.key === k) || null;
const typeLabel = k => { const t = typeOf(k); return t ? t.label : (k || 'Aircon'); };
const typeOffers = (type, k) => { const t = typeOf(type); return !t || !Array.isArray(t.services) || t.services.includes(k); };
const typePic = k => { const i = (typeOf(k) || {}).icon || 'ac-split'; return i.startsWith('data:') ? i : 'icons/' + i + '.png'; };
/* 54: an appliance's own types (½ hp, 1 hp…), each with the services it offers and — where the
   price list may show — its own prices. An old job's shared service maps to the appliance's own. */
const variantsOf = t => (typeOf(t) || {}).variants || [];
const activeVariants = t => variantsOf(t).filter(v => v.active !== false);
const variantOf = (t, id) => id ? variantsOf(t).find(v => v.id === id) || null : null;
const ownKey = (t, k) => ((typeOf(t) || {}).legacy || {})[k] || k;
// the price on a type: picked → its own; types exist, none picked → none (the office rings)
const variantPrice = (vs, k, v) => { const x = v ? vs.find(y => y.id === v) : null;
  return x && x.prices && x.prices[k] != null ? Number(x.prices[k]) : null; };
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
  // Waze too, asked every time (Guile, 2026-10-10): a pin goes as a point, an address as a search
  const waze = 'https://waze.com/ul?' + (pinned ? 'll=' + q : 'q=' + encodeURIComponent(q)) + '&navigate=yes';
  return `<button type="button" class="b" data-act="mapopen" data-href="${esc(href)}" data-waze="${esc(waze)}" data-pinned="${pinned ? 1 : ''}" data-landmark="${esc(c.landmark || '')}">🗺️ Map</button>`;
}
// No pin: say so first (Guile, 2026-09-27) — a search for the address stops at the street
function showMapChoice(href, waze, pinned, landmark){
  $('#infoTitle').textContent = pinned ? 'Open the map' : 'No pin on the map';
  $('#infoText').textContent = pinned ? 'The customer pinned the house. Open it in:'
    : 'The customer did not pin a map. Map can only search the address, so it may stop at the street, not the house.'
      + (landmark ? '\n\nLandmark: ' + landmark : '\n\nThere is no landmark either — ring them to ask.') + '\n\nSearch the address in:';
  const a = $('#infoLink'); a.href = href; a.textContent = '🗺️ Google Maps'; a.hidden = false;
  const w = $('#infoLink2'); w.href = waze; w.textContent = '🚗 Waze'; w.hidden = false;
  [a, w].forEach(x => x.classList.add('primary'));
  $('#infoOk').textContent = 'Cancel'; $('#infoOk').classList.remove('primary');
  $('#infoBox').hidden = false;
  a.focus();
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
  admin: ['Admin', 'Only admins see this tab. The price list and the services the booking page offers, the billing statement, and the three numbers the app was built to answer.'],
  showprices: ['Show prices', 'Off: customers never see a price; you tell them on the call.\n\nOn: once a customer picks the aircon type and the services, the booking page shows the total from this list. If a service has no price for their aircon type, it says you will tell them on the call.'],
  service: ['A service', 'Each appliance has its own services: rename one here and only this appliance changes. Its price is for this appliance — or, when it has types (½ hp, 1 hp…), each type carries its own. Empty: a booking shows no price until you set one. Customers see prices only with Show prices on the booking page on.\n\nHidden takes it off the booking page; old jobs keep it. Hold ⠿ and drag to change the order.'],
  variant: ['Types', 'Optional, per appliance: ½ hp, ¾ hp, 1 hp… A customer who picks one sees only the services ticked on it, at its prices. One who is not sure picks none: then there is no price, and you tell them on the call.\n\nAn appliance with no types uses its services’ own prices. Remove hides a type; jobs that have it keep it.'],
  editbooking: ['After the call', 'Change what they need and which aircon they have. The price shows as soon as every service has a price for that aircon type. It is frozen onto the job when you make it.'],
  types: ['Aircon & Other Appliances', 'What a customer taps on the booking page — Window, Split, a chiller, a freezer… — in this order. Hold ⠿ and drag to change the order. Add one with its name and a picture — one of ours, or ＋ Your own PNG — then open it: its own services and prices, its types (½ hp, 1 hp…) and its specs, each in your order. It shows on the booking page once it has a service.\n\nRemove takes it off the booking page only. Jobs that already have it keep it, and so do its services and prices; Bring it back puts it all back. Renaming changes the name everywhere, old jobs too.'],
  pagephotos: ['Page photos', 'The photos at the top of the booking page — the first thing a customer sees. Add up to six; with two or more the page fades from one to the next every 6 seconds, on its own. With none, the page shows its own photo.\n\nAnyone who opens the page can see these photos: never a customer’s house, a face or a plate number without their say-so. The phone makes each photo smaller before sending, so the page stays quick on mobile data. Remove deletes the photo for good.'],
  quote: ['Quotation', 'The shop’s own quotation, made from this booking: the lines start as the customer’s aircons at the price list’s prices, and every word, Qty and price is yours to change. The page on top is exactly the paper.\n\nSave keeps it on the booking. Send as PDF: in the app, the quotation goes as a PDF file straight to Messenger, Viber, email, Bluetooth or Drive — pick one. Print or save as PDF: the print screen, for paper.\n\nSigned by the customer on the Conforme line, it is your agreement. Accept, left blank, takes its TOTAL as the job’s price.'],
  quoteshop: ['Letterhead and signer', 'The lines at the top of every quotation, and the name under the signature. Blank lines are left out. Kept on the server for admins only, not in the public page.'],
  quotenote: ['The usual note', 'Every new quotation starts with this Note; change it on one quotation without changing it here. Each line is one ➢ point. A line that starts with a space is indented under the one above, like a price that belongs to it.'],
  quotesig: ['Signature', 'A photo of the signature on white paper: the white is taken out and the ink kept. It prints on every quotation.\n\nIt is kept on the server for admins only — never on the public page, never on a technician’s phone. Remove it and the quotation leaves the space to sign by hand.'],
  bill: ['Billing statement', 'What the customer is billed — for a service, not a receipt. It starts from the job’s quotation; add the extra work found on the day (piping, wires, parts and materials), then Save: the job’s price becomes its TOTAL.\n\nThe letterhead and the signature are the quotation’s (Admin → Quotation). Technicians see it, without changing it, while “Show prices to technicians” is on.'],
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
  namefx: ['Name effect', 'A decoration on this person’s name — colours, a glow, an outline, an emoji and the way it moves. The shop sees it on every phone, on the screens ticked in “Where it shows”. Customers never do.\n\nIt is only a colour: it changes nothing about what this person can do.\n\nAnyone who finds it busy: Settings → This phone → Name effects → Plain names. That is for their own phone only.'],
  fxmine: ['Name effect', 'Your own name’s look — colours, a glow, an outline, an emoji and the way it moves. The whole shop sees it on every phone; customers never do.\n\nThe office can change it too, from Users.\n\nOnly a colour: it changes nothing about what you can do.'],
  fxshow: ['Show name effects (lag issue)', 'Show: names with an effect move and shine on this phone.\n\nPlain names: none at all — the quickest the app can be on an old phone. Only this phone; nobody else’s name changes.'],
  techothers: ['Other jobs', 'No: a technician (or helper) opens and works only the jobs they are assigned to — the head or a helper on the crew. Every other job still shows in their list, to see: tapping it only asks the office for it. A job with nobody on it is locked too, until you assign it.\n\nYes: every technician works every job, as before.'],
  techask: ['Asking for a job', 'Yes: a technician taps a job that is not theirs and asks for it. On your Jobs, that job’s badge turns yellow — “🙋 Assign to Ana” — until you answer: Assign puts Ana on it (the head if nobody is on it, else a helper); Say no takes it away.\n\nNo: only the office assigns.'],
  techreward: ['What they receive', 'Yes: each technician sees, under the job’s status, what they get from it — the job’s price × their own share (Users → the technician, 10% to start). No price yet says so.\n\nThe price itself still shows only with “Show prices to technicians & helpers” on. Helpers never see a share.'],
  share: ['Share of each job', 'What this technician receives from a job: the job’s price × this percent. They see the amount on every job while Admin → Job → “Can technicians see what they receive?” is Yes.\n\nThe job’s price is the quotation’s or the billing statement’s total.'],
  showpricestech: ['Show prices to technicians & helpers', 'On: a technician sees each job’s price, big, so they know what to collect — and can print or send the billing statement. A helper sees the price on the job, nothing more.\n\nOff: technicians and helpers never see a price; the server does not even send it.'],
  closedwd: ['Closed every week', 'Tap the weekdays the shop never works. The booking page greys them out and will not take a booking for one. Book a job (a call you take) only warns you.'],
  closeddates: ['Days off', 'A holiday, a fiesta, a day off: tap the day in the calendar. Type a reason first if you want the customer to see it ("Christmas"). Past days drop off by themselves.'],
  shopfb: ['Facebook page', 'With a link here, the booking page shows “Message us on Facebook” beside the call button. Leave it empty to hide it.'],
  shopgcash: ['GCash', 'The billing statement shows the number and the name, so the customer can pay on the spot. With a picture named gcash-qr.png in web/img, it shows the QR code too.'],
  gap: ['Check-up gap', 'Counted from a customer’s last finished job. Every admin phone uses the same number.'],
  checkin: ['Check-ins', 'Their Time in and Time out for the day, and each job’s arrived and left — Start the job and Mark done count for the whole crew, at the time they were tapped (even with no signal).\n\nOnly the office changes a time: Edit, Remove, or add a forgotten time out. Each change shows under the time, with who changed it. The last 100 days are on this phone.'],
  ckloc: ['Require location', 'Off: Time in and Time out are one tap.\n\nOn: the phone sends where it is with each time; with location off, the time is not kept and the phone says why. You see it on the person’s times.'],
  report: ['Service report', 'One for each appliance on the job, like the paper one: tick the work done, write the findings, Save. The number is given by the office’s server when it is first saved, counting up from the number set in Admin → Service report.\n\nThe office and technicians fill it in and change it; the customer signs it on the phone. Print it, or send it as a PDF.'],
  reportadmin: ['Service report', 'The ticks, the line over the client’s signature, and the number the next report takes. Each job’s reports are on the job: one for each appliance.\n\nThe letterhead and the QR are the quotation’s (Admin → Quotation).'],
  reset: ['Take the office’s copy', 'Throws away everything on this phone that has not been sent, and takes the office’s copy again. Nothing else ever overwrites what you did here.'],
};
const infoBtn = k => `<button type="button" class="info-btn" data-act="info" data-v="${k}" aria-label="What is this?">i</button>`;
function showInfo(k){
  const it = INFO[k]; if (!it) return;
  $('#infoTitle').textContent = it[0];
  $('#infoText').textContent = typeof it[1] === 'function' ? it[1]() : it[1];
  $('#infoLink').hidden = true; $('#infoLink2').hidden = true; $('#infoOk').textContent = 'OK'; $('#infoOk').classList.add('primary');
  $('#infoBox').hidden = false;
  $('#infoOk').focus();
}
const hideInfo = () => { $('#infoBox').hidden = true; };
// a map app chosen: the box has done its job
document.addEventListener('click', e => { if (e.target.closest && e.target.closest('#infoLink, #infoLink2')) setTimeout(hideInfo, 0); });

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
   (Guile, 2026-10-03) its serial number and its problem too; since 40 its Additionals (the
   owner via Guile, 2026-10-10: indoor or outdoor…). Every place that copies one uses this, so
   a new field is added once. */
const unitCopy = u => ({type: u.type, services: u.services.map(String), brand: u.brand || null, model: u.model || null,
                        serial: u.serial || null, extra: u.extra || null, problem: u.problem || null,
                        ...(u.cu ? {cu: u.cu} : {}),     // 43: which saved appliance it is
                        ...(u.variant ? {variant: u.variant} : {}),   // 54: its type, ½ hp, 1 hp…
                        ...(u.specs && Object.keys(u.specs).length ? {specs: {...u.specs}} : {})});   // 44: the owner's boxes
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
const officePrice = (k, t, v) => {
  const r = svcRows().find(x => x.key === k);
  // 55: an old job's shared key ("clean", not the appliance's own) keeps its list price
  if (v || (r && r.unit_type === t && activeVariants(t).length)) return variantPrice(variantsOf(t), k, v);
  return r && r.prices && r.prices[t] != null ? Number(r.prices[t]) : null; };
// the page's: list_services' types (pubTypes), even for a signed-in customer whose db.types has no prices
const pagePrice = () => Object.values(pubPrices).some(Boolean)
  ? (k, t, v) => { const tp = (pubTypes || []).find(x => x.key === t) || {}, vs = tp.variants || [];
      if (v || (vs.length && (tp.services || []).includes(k))) return variantPrice(vs, k, v);   // 55: as officePrice
      return pubPrices[k] && pubPrices[k][t] != null ? Number(pubPrices[k][t]) : null; } : null;
function unitPrice(u, pf){
  if (!pf || !u.type) return null;
  let sum = 0;
  for (const k of u.services){ const p = pf(k, u.type, u.variant); if (p == null) return null; sum += p; }
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
      const up = unitPrice(u, pf), meta = [(variantOf(u.type, u.variant) || {}).label,   // 54
        u.brand, u.model, u.serial ? 'SN ' + u.serial : ''].filter(Boolean).join(' · ');
      return `<div class="cart-unit">
        <div class="cart-unit-head">
          ${editable ? `<button type="button" class="cart-unit-name" data-act="unitedit" data-cart="${cart}" data-i="${i}">${esc(names[i])} <span aria-hidden="true">›</span></button>`
                     : `<span class="cart-unit-name">${esc(names[i])}</span>`}
          <span class="cart-unit-meta">${esc(meta)}</span>
          ${pf ? `<span class="cart-unit-price">${up != null ? esc(peso0(up)) : '₱ ?'}</span>` : ''}
          ${editable ? `<button type="button" class="cart-x" data-act="unitdel" data-cart="${cart}" data-i="${i}" aria-label="Remove ${esc(names[i])}">🗑</button>` : ''}
        </div>
        <div class="cart-svcs">${u.services.map(k => {
          const p = pf && u.type ? pf(k, u.type, u.variant) : null;
          return `<span class="svc-chip">${esc(svcLabel(k))}${p != null ? ` <i>${esc(peso0(p))}</i>` : ''}${editable
            ? `<button type="button" data-act="unitsvcx" data-cart="${cart}" data-i="${i}" data-v="${esc(k)}" aria-label="Take off ${esc(svcLabel(k))}">×</button>` : ''}</span>`; }).join('')}</div>
        ${u.extra ? `<div class="cart-problem"><b>Additionals:</b> ${esc(u.extra)}</div>` : ''}
        ${specsHtml(u)}
        ${u.problem ? `<div class="cart-problem"><b>Problem:</b> ${esc(u.problem)}</div>` : ''}
        ${opts.saved && u.cu ? notesHtml(opts.saved(u.cu), 'cart:' + u.cu) : ''}
      </div>`; }).join('')}
    ${pf ? `<div class="cart-total"><span>Total</span><b>${total != null ? esc(peso(total)) : esc(opts.missing || 'We will tell you on the call')}</b></div>` : ''}
  </div>`;
}
/* ---------------------------------------------------------------- the owner's own boxes (44)
   Admin → Specs (the owner via Guile, 2026-10-10): boxes he makes himself — Horsepower,
   Refrigerant… — each on the appliances he ticks, one line or a bigger box, and shown on the
   booking page only if he says so. The page gets those from list_services; the shop, all. */
const staffDb = () => !!db && ['admin', 'technician', 'helper'].includes(db.role);
const allFields = () => staffDb() ? (db.unitFields || []) : (pubShop.unit_fields || []);
// the boxes a cart shows for this type: the page only its own, the shop every one not removed
const fieldsFor = (cart, type) => (cart === 'pub' ? (pubShop.unit_fields || []) : (db && db.unitFields || []))
  .filter(f => !f.removed && (f.types || []).includes(type));
const fieldLabel = k => (allFields().find(f => f.key === k) || (pubShop.unit_fields || []).find(f => f.key === k) || {}).label || '';
const specsHtml = u => Object.entries(u.specs || {}).filter(([k, v]) => v && fieldLabel(k))
  .map(([k, v]) => `<div class="cart-problem"><b>${esc(fieldLabel(k))}:</b> ${esc(v)}</div>`).join('');
function specBoxes(fields, vals, attr){
  return fields.map(f => `<label>${esc(f.label)} <span class="opt">— optional</span>${f.long
    ? `<textarea ${attr}="${esc(f.key)}" maxlength="1000" rows="3">${esc(vals[f.key] || '')}</textarea>`
    : `<input ${attr}="${esc(f.key)}" maxlength="100" value="${esc(vals[f.key] || '')}" autocomplete="off">`}</label>`).join('');
}

/* ---------------------------------------------------------------- saved appliances (43)
   The owner via Guile, 2026-10-10: a customer's aircons are kept on their file — brand,
   model, serial, additionals, problem, and his own notes ("changed the capacitor"). A job's
   aircons are saved there by the server; the office edits them in the customer's file; a
   booking for that customer offers them when a type is tapped. Notes are staff only. */
const custOfId = cid => db.customers[cid] || (Object.values(db.jobs).find(j => j.customer_id === cid) || {}).customer || null;
const savedUnits = cid => ((custOfId(cid) || {}).units || []).filter(x => !x.removed);
const savedOf = (cid, id) => id ? savedUnits(cid).find(x => x.id === id) || null : null;
const savedLine = x => [x.brand, x.model].filter(Boolean).join(' · ') + (x.serial ? (x.brand || x.model ? ' · ' : '') + 'SN ' + x.serial : '') || 'No brand or serial yet';
// whose cart this is, when the office (or a technician's Edit) books for a known customer
function cartCustomer(cart){
  if (cart === 'pub' || !db || !['admin', 'technician'].includes(db.role)) return null;
  const p = topPanel(); if (!p) return null;
  if (p.kind === 'book') return p.mode === 'existing' ? p.customer_id || null : null;
  if (p.kind === 'editjob') return (db.jobs[p.id] || {}).customer_id || null;
  if (p.kind === 'editbooking') return (db.bookings[p.id] || {}).customer_id || null;
  return null;
}
// a saved appliance's notes, three lines until "Show all" (staff screens)
const notesHtml = (x, key) => x && x.notes ? `<div class="cart-notes${openNotes.has(key) ? ' open' : ''}"><b>📝 Notes:</b> ${esc(x.notes)}</div>
  <button type="button" class="linkish" data-act="notesmore" data-v="${esc(key)}">${openNotes.has(key) ? 'Show less' : 'Show all notes'}</button>` : '';
const openNotes = new Set();

/* The small window: "Window #2" — what it needs, brand and model if they know them. */
function drawUnitSheet(){
  const box = $('#unitSheet');
  if (!unitEd){ box.hidden = true; lockBody(); return; }
  const u = unitEd.unit, units = cartUnits(unitEd.cart), pf = cartPrice(unitEd.cart);
  const name = unitEd.index >= 0 ? unitNames(units)[unitEd.index] : typeLabel(u.type) + ' #' + (units.filter(x => x.type === u.type).length + 1);
  // 54: its type (½ hp, 1 hp…), optional; picked, the services follow it
  const vs = activeVariants(u.type), cur = variantOf(u.type, u.variant);
  const keys = cartKeys(unitEd.cart).filter(k => (cur ? (cur.services || []).includes(k) : typeOffers(u.type, k)) || u.services.includes(k));   // A2 (28)
  box.hidden = false;
  const cid = cartCustomer(unitEd.cart), saved = cid ? savedOf(cid, u.cu) : null;
  if (unitEd.pick){   // 43: which of their saved ones is it?
    const taken = new Set(units.map(x => x.cu).filter(Boolean));
    const list = savedUnits(cid).filter(x => x.type === u.type && !taken.has(x.id));
    $('.unit-card', box).innerHTML = `
      <div class="unit-head"><div class="unit-title">Which ${esc(typeLabel(u.type))}?</div>
        <button type="button" class="cart-x" data-act="unitclose" aria-label="Close">✕</button></div>
      <p class="hint">Saved on ${esc(((custOfId(cid) || {}).full_name || 'their') + '’s')} file — tap one and its details fill in.</p>
      <div class="menu">${list.map(x => `<button type="button" class="menu-row" data-act="unitpick" data-v="${esc(x.id)}">
          <span class="menu-main"><span class="menu-title">${esc(savedLine(x))}</span>${x.extra || x.problem ? `<span class="menu-sub">${esc([x.extra, x.problem].filter(Boolean).join(' · '))}</span>` : ''}</span><span class="menu-chev">›</span></button>`).join('')}
        <button type="button" class="menu-row" data-act="unitpick" data-v=""><span class="menu-main"><span class="menu-title">＋ A new ${esc(typeLabel(u.type))}</span></span></button></div>`;
    lockBody(); return;
  }
  $('.unit-card', box).innerHTML = `
    <div class="unit-head"><div class="unit-title">${esc(name)}</div>
      <button type="button" class="cart-x" data-act="unitclose" aria-label="Close">✕</button></div>
    ${vs.length || cur ? `<div class="fieldlabel">Which type? <span class="opt">— optional</span></div>
    <div class="tabbar tight">${[...vs, ...(cur && !vs.includes(cur) ? [cur] : [])].map(v =>
      `<button type="button" class="tab-btn${cur === v ? ' active' : ''}" data-act="unitvar" data-v="${esc(v.id)}">${esc(v.label)}</button>`).join('')}
      <button type="button" class="tab-btn${cur ? '' : ' active'}" data-act="unitvar" data-v="">Not sure</button></div>
    ${pf && !cur ? `<p class="hint">${unitEd.cart === 'pub' ? 'Its price depends on the type. Not sure? We tell you on the call.'
                                                             : 'No type, no price — set it after the call.'}</p>` : ''}` : ''}
    <div class="fieldlabel">What services?</div>
    <div class="tabbar tight">${keys.map(k => {
      const p = pf ? pf(k, u.type, u.variant) : null;
      return `<button type="button" class="tab-btn${u.services.includes(k) ? ' active' : ''}" data-act="unitsvc" data-v="${esc(k)}">${esc(svcLabel(k))}${p != null ? ' · ' + esc(peso0(p)) : ''}</button>`; }).join('')
      || '<p class="hint">The service list has not loaded — this needs signal.</p>'}</div>
    <div class="row">
      <label>Brand <span class="opt">— optional</span><input data-ued="brand" maxlength="60" value="${esc(u.brand || '')}" placeholder="Carrier, Koppel…" autocomplete="off"></label>
      <label>Model <span class="opt">— optional</span><input data-ued="model" maxlength="60" value="${esc(u.model || '')}" autocomplete="off"></label>
    </div>
    <label>Serial number <span class="opt">— optional</span><input data-ued="serial" maxlength="60" value="${esc(u.serial || '')}" autocomplete="off"></label>
    <label>Additionals <span class="opt">— optional</span><textarea data-ued="extra" maxlength="200" rows="2" placeholder="Indoor or outdoor, which room…">${esc(u.extra || '')}</textarea></label>
    ${specBoxes(fieldsFor(unitEd.cart, u.type), u.specs || {}, 'data-uspec')}
    <label>Problem or complaint <span class="opt">— optional</span>
      <textarea data-ued="problem" maxlength="300" rows="2" placeholder="What is wrong with this ${esc(name)}? Not cold, leaking…">${esc(u.problem || '')}</textarea></label>
    ${saved ? `<div class="card saved-card"><div class="sms-note">🗂️ Saved on ${esc(((custOfId(cid) || {}).full_name || 'their') + '’s')} file</div>${notesHtml(saved, 'ued:' + saved.id)}</div>` : ''}
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
  // opts.waiting: Reschedule's last chip, "Waiting" — back to No date (48, Guile 2026-10-11)
  const chips = [...(opts.notYet ? [['', 'Not yet']] : []), [today, 'Today'], [addDays(today, 1), 'Tomorrow'],
    [addDays(today, 2), niceDate(addDays(today, 2))], ...(opts.waiting ? [['', 'Waiting']] : [])];   // no ⏳: with it the chip wrapped at 375 (82 px, 80 left)
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
      ? `<div class="lrow flat">${custAvatar(c)}
          <div class="lrow-main"><div class="lrow-title">${esc(c.full_name)}</div><div class="lrow-sub cs">${custSub(c)}</div></div>
          <button type="button" class="b" data-act="pset" data-f="customer_id" data-v="">Change</button></div>`
      : `<input type="search" class="find" data-pf="q" placeholder="🔎 Name, number, address, brand…" value="${esc(s.q || '')}" autocomplete="off">
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
    ${edit ? '' : bkPicsHtml(ctx, s)}
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
// (2026-10-12) the photos as they were at the release, inside the website and the APK
// (tools/page_photos.py): drawn from the first paint, before list_services answers
const LOCAL_PHOTOS = new Set(Array.isArray(window.PAGE_PHOTOS_LOCAL) ? window.PAGE_PHOTOS_LOCAL : []);
const pagePhotoUrl = p => LOCAL_PHOTOS.has(p) ? 'img/page-photos/' + p.slice(5) : PAGE_PHOTO_BASE + p;
function pagePhotos(){
  const l = db && db.role === 'admin' && db.settings && Array.isArray(db.settings.page_photos) ? db.settings.page_photos
    : Array.isArray(pubShop.page_photos) ? pubShop.page_photos : [...LOCAL_PHOTOS];
  return Array.isArray(l) ? l.filter(p => /^page\/[0-9a-f]{16,64}\.jpg$/.test(p)) : [];
}
let heroIdx = 0;
function heroPhotosHtml(){
  const l = pagePhotos();
  if (!l.length) return '';
  const on = heroIdx % l.length, next = (on + 1) % l.length;
  return `<div class="hero-photos" aria-hidden="true" data-photos="${esc(l.join(','))}">${l.map((p, i) =>
    `<i data-src="${esc(pagePhotoUrl(p))}"${i === on ? ' class="on"' : ''}${i === on || i === next ? ` style="background-image:url('${esc(pagePhotoUrl(p))}')"` : ''}></i>`).join('')}</div>`;
}
// the customer's page: its photo top is in the HTML, so the photos go in (or change) here
function drawHeroPhotos(){
  const sec = $('#publicView > .hero');
  if (!sec) return;
  const old = sec.querySelector(':scope > .hero-photos'), l = pagePhotos();
  document.documentElement.classList.toggle('pp', l.length > 0);   // none left: the built-in photo again
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
/* A name INSIDE a history line ("Crew: Ana (head) — by Guile") is a token here, so the line can
   still be escaped whole; timelineHtml puts each name back wearing its effect, and "you" as the
   person's own name (Guile, 2026-10-12: no "You" anywhere — the name, with its effect). */
let evNames = [];
const N = (name, uid) => { evNames.push([name, uid || null]); return '\u0001' + (evNames.length - 1) + '\u0002'; };
function eventRow(e){
  const by = e.by || '', ch = e.changes || {}, before = ch.before || {}, after = ch.after || {};
  const lab = s => STATUS_LABEL[s] || s || '—';
  switch (e.kind){
    case 'booked':    return ['📝', by ? 'Booked' : 'Booked on the page', null, by];
    case 'seen':      return ['👀', 'Seen', null, by];   // one per person who opened it in the Inbox (52)
    case 'accepted':  return ['✅', 'Accepted', null, by];
    case 'rejected':  return ['⛔', 'Rejected', null, by];
    case 'cancelled': return ['🚫', 'Cancelled', null, by];
    case 'claimed':   return ['🔗', 'Added to the customer’s account'];
    case 'edited':    return ['✏️', 'Edited', editChanges(ch), by];
    case 'job_edit':  return ['✏️', 'Edited', editChanges(ch), by];
    case 'job_created': return ['🛠️', 'Job made', null, by];
    case 'job_schedule': return [after.scheduled_on ? '📅' : '⏳', after.scheduled_on ? 'Scheduled' : 'Waiting — no day yet', [['Day',
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
    case 'job_carry': return ['⏭️', 'Moved to the next day — not finished', [['Day',   // 41
      before.scheduled_on ? niceDate(before.scheduled_on) : '', after.scheduled_on ? niceDate(after.scheduled_on) : '']], ''];
    case 'job_workphoto': return after.photo ? ['📷', 'Work photo added', null, by] : ['🗑️', 'Work photo taken off', null, by];   // 39
    case 'job_report': return after.removed ? ['🗑️', 'Service report № ' + after.no + ' taken off', null, by]   // 57
      : ['📋', 'Service report № ' + after.no + (before && before.no ? ' changed' : ' made'), null, by];
    case 'job_sign': {   // 47: the customer's signature — taken by whom
      const paper = after.paper === 'quote' ? 'quotation' : after.paper === 'bill' ? 'billing statement' : 'service report';   // 57
      return after.removed ? ['🗑️', 'Signature taken off the ' + paper, null, by]
        : ['✍️', (before && before.at ? 'Signed the ' + paper + ' again' : 'Signed the ' + paper) + (after.name ? ' — ' + after.name : ''), null, by];
    }
    case 'job_assign': {   // 39: the names as they were at the time
      if (Array.isArray(after.crew)){   // 46: the crew, head first
        const nm = x => x.name ? N(x.name, x.uid) : 'someone', c = after.crew, whoName = (c.find(x => x.uid === after.who) || {}).name
          || ((before.crew || []).find(x => x.uid === after.who) || {}).name, who = whoName ? N(whoName, after.who) : 'someone';
        if (after.do === 'join') return ['🙋', who + ' joined as a helper', null, ''];
        if (after.do === 'leave') return ['🚪', who + ' left the crew', null, ''];
        if (after.do === 'head') return ['👑', who + ' is the head' + (by && !after.self ? ' — by ' + N(by) : ''), null, ''];
        if (after.do === 'request') return ['🙋', who + ' asked and was assigned' + (c[0] && c[0].uid === after.who ? ' as the head' : ' as a helper') + (by ? ' — by ' + N(by) : ''), null, ''];   // 49
        if (!c.length) return ['👤', 'No assign' + (by ? ' — by ' + N(by) : ''), null, ''];
        return ['👤', 'Crew: ' + nm(c[0]) + ' (head)' + (c.length > 1 ? ', ' + c.slice(1).map(nm).join(', ') : '') + (by ? ' — by ' + N(by) : ''), null, ''];
      }
      const to = after.name ? N(after.name, after.uid) : ROLE_NAME[after.role] || 'someone';
      if (!after.uid) return ['👤', 'No assign — taken off ' + (before.name ? N(before.name, before.uid) : 'everyone') + (by ? ' by ' + N(by) : ''), null, ''];
      if (after.self) return ['🙋', 'Assigned to ' + to + ' (self assigned)', null, ''];
      return ['👤', (before.uid ? 'Transferred to ' : 'Assigned to ') + to + (by ? ' by ' + N(by) : ''), null, ''];
    }
    case 'job_request': {   // 49: a technician asked for the job, took it back, or the office said no
      const who = N(staffName(after.who), after.who);
      if (after.do === 'withdraw') return ['🙋', who + ' took back the request', null, ''];
      if (after.do === 'no') return ['✕', 'Said no to ' + who + (by ? ' — by ' + N(by) : ''), null, ''];
      return ['🙋', who + ' asked for this job', null, ''];
    }
    case 'job_price': return ['₱', 'Price', [['Price', before.price != null ? peso(before.price) : 'not set', after.price != null ? peso(after.price) : 'not set']], by];
  }
  return ['•', e.kind, null, by];
}
/* Who did it, on a history line. The server says "you" for your own steps; on a shop phone
   it is your name instead, wearing its effect (Guile, 2026-10-12: "Seen by Guile, not You").
   A customer's own history keeps "you". */
const whoHtml = (who, uid) => who === 'you' && db && (db.role === 'admin' || inField(db.role)) && session
  ? nameFx((db.profile && db.profile.display_name) || 'you', session.uid, 'history') : nameFx(who, uid || null, 'history');
function timelineHtml(events){
  if (!events.length) return '<div class="cart-empty">Nothing has happened to it yet.</div>';
  const stamp = iso => new Date(iso).toLocaleString('en-PH', {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
  return `<div class="tl">${events.map(e => { evNames = []; const [icon, w, changes, who] = eventRow(e);
    const what = esc(w).replace(/\u0001(\d+)\u0002/g, (_, i) => whoHtml(...evNames[i]));
    return `<div class="tl-row"><span class="tl-icon">${icon}</span><span class="tl-body">
      <span class="tl-what">${what}${who ? ` · <b>${whoHtml(who)}</b>` : ''}</span><span class="tl-when">${esc(stamp(e.at))}</span>
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
  s[kind] = s[kind] || {};   // 'assign' came later (39)
  if (s[kind][id] === (value || 1)) return;
  s[kind][id] = value || 1;
  lsSet(seenKey(), s);
}
const isOpenJob = j => !['done', 'cancelled'].includes(j.status);
const jobUnseen = j => { const s = seenStore(); return !!s && isOpenJob(j) && !s.jobs[j.id]; };
// ⚠️ a job someone else gave THIS person, not opened since (39) — on this phone, like the rest
// the crew (46): the head first, then the helpers; a job from before 46 has its one person
const crewOf = j => !j ? [] : Array.isArray(j.crew) && j.crew.length ? j.crew : j.assigned_uid ? [j.assigned_uid] : [];
const assignUnseen = j => { const s = seenStore(); return !!s && !!session && isOpenJob(j) && !!j.assigned_at
  && crewOf(j).includes(session.uid) && j.assigned_by !== session.uid && (s.assign || {})[j.id] !== j.assigned_at; };
const userUnseen = t => { const s = seenStore(); return !!s && t.id !== session.uid && !s.users[t.id]; };
const checkupUnseen = k => { const s = seenStore(); return !!s && s.checkups[k.c.id] !== k.due; };
function unseenCounts(){
  return {
    inbox: newBookings().filter(b => !b.seen_at).length,   // shared by the office (15)
    jobs: Object.values(db.jobs).filter(j => jobUnseen(j) || assignUnseen(j)).length,
    assigned: Object.values(db.jobs).filter(assignUnseen).length,   // 39
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
  const stats = [
    [newBookings().length, 'New', 'inbox', 'new'],
    [jobList('today').length, 'Today', 'jobs', 'today'],   // the tab's own count (ui.md, Reuse)
    [jobList('unplanned').length, 'No date', 'jobs', 'unplanned'],
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
  return `<div class="lrow has-steps" role="button" tabindex="0" data-act="open" data-kind="booking" data-id="${esc(b.id)}" data-stamp="${esc(b.updated_at || '')}">
    ${typeAvatar((unitsOf(b)[0] || {}).type, 0, b.full_name)}
    <div class="lrow-main">
      <div class="lrow-title">${newDot(b.status === 'new' && !b.seen_at)}${esc(b.full_name)}${b.source === 'office' ? ' ' + pill('kind', 'By phone') : ''}${unsentPill(b.id)}</div>
      <div class="lrow-sub">${esc(unitsLine(unitsOf(b)))} — ${esc(svcList(b.services))}</div>
      <div class="lrow-sub">${esc(b.preferred_on ? 'Wants ' + shortDate(b.preferred_on) + ' ' + slotShort(b.slot) : 'No day yet')} · ${esc(b.address)}</div>
    </div>
    <div class="lrow-side">${pill(b.status, b.ref)}<span class="lrow-price">${esc(bookingPrice(b) != null ? peso0(bookingPrice(b)) : '₱ ?')}</span>
      <span class="lrow-time">${esc(timeAgo(b.created_at))}</span></div>
    ${miniSteps({booking: b, job: Object.values(db.jobs).find(j => j.booking_id === b.id) || null})}
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
    ${bookingPicsHtml(b)}
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
/* A done job leaves Today (Guile, 2026-10-11): done and not paid goes to Unpaid, done and
   paid to Done — paid or not, an open job stays on its day. Upcoming is only the days after
   tomorrow (Guile, 2026-10-11, replacing R3's "every job from today on"): each open job is in
   ONE tab — Today, Tomorrow, No date or Upcoming. */
function jobDayFilter(j, day){
  const today = manilaDate(0), open = isOpenJob(j);
  if (day === 'today') return j.scheduled_on === today && open;
  if (day === 'tomorrow') return j.scheduled_on === manilaDate(1) && open;
  if (day === 'unplanned') return !j.scheduled_on && open;
  if (day === 'mine') return open && crewOf(j).includes(session && session.uid);   // TODO2 #4: on its crew
  if (day === 'unpaid') return j.status === 'done' && !j.paid_method;
  if (day === 'done') return j.status === 'done' && !!j.paid_method;
  if (day === 'cancelled') return j.status === 'cancelled';
  return j.scheduled_on > manilaDate(1) && open;   // upcoming
}
function jobList(day){
  const rows = Object.values(db.jobs).filter(j => jobDayFilter(j, day));
  // Unpaid is money owed: all of it, never cut at 60
  return day === 'unpaid' ? rows.sort(byDoneDesc)
    : ['done', 'cancelled'].includes(day) ? rows.sort(byDoneDesc).slice(0, 60) : rows.sort(byTime);
}
/* L4 (Guile, 2026-09-27, ui.md Reuse): the office's Jobs and the technician's Jobs were two
   copies of one tab strip — the technician's had no Cancelled. One function draws both. Since
   38 (Guile, 2026-10-03) technicians and helpers get the jobs with no day too, so every tab
   is everyone's. */
const JOB_TABS = [['today', 'Today'], ['mine', 'Assigned'], ['tomorrow', 'Tomorrow'], ['unplanned', 'No date'], ['all', 'Upcoming'],
                  ['unpaid', 'Unpaid'], ['done', 'Done'], ['cancelled', 'Cancelled']];
function jobTabsHtml(){
  // the admin's View as (37) draws the field's tabs on the admin's own day
  const tech = inField(viewRole()), key = db.role === 'admin' ? 'day' : 'techDay';
  const days = tech ? JOB_TABS : JOB_TABS.filter(d => d[0] !== 'mine');   // Assigned: technicians and helpers (TODO2 #4)
  if (!days.some(d => d[0] === ui[key])) ui[key] = 'today';
  const n = k => ['done', 'cancelled'].includes(k) ? 0 : Object.values(db.jobs).filter(j => jobDayFilter(j, k)).length;   // Unpaid counted: money owed
  const rows = jobList(ui[key]);
  // a helper has no map (37)
  return locCardHtml() + timeCardHtml() + chips(key === 'day' ? 'day' : 'techday', days.map(([k, t]) => [k, t, n(k)]), ui[key]) + (viewRole() === 'helper' ? '' : routeBar(ui[key])) + (tech ? '' : textAllBar(ui[key])) +
    (rows.length ? `<div class="list">${rows.map(jobRow).join('')}</div>` : empty(ui[key] === 'mine' ? 'Nothing assigned to you yet.' : 'No jobs here.'));
}
function drawJobs(){ return jobTabsHtml(); }

/* ---------------------------------------------------------------- check-in (56)
   Guile, 2026-10-28 (TODO2 #2): technicians and helpers tap Time in / Time out for the day;
   Start the job and Mark done are the job's arrived / left, for the whole crew — the server
   writes those. A tap is kept here with its own time and sent later, like any write. Only the
   office changes a time, and each change keeps a line with both names. */
const byAt = (a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0;
const ckRows = (uid, day) => Object.values(db.checkins || {}).filter(k => k.uid === uid && (!day || k.day === day)).sort(byAt);
const clockOf = iso => new Date(iso).toLocaleTimeString('en-PH', {hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila'});
// the day's time in not closed yet — within 20 hours, as the server counts it
function ckOpen(uid){
  const day = ckRows(uid).filter(k => !k.job_id && Date.now() - new Date(k.at) < 20 * 36e5);
  const last = day[day.length - 1];
  return last && last.kind === 'in' ? last : null;
}
function timeCardHtml(){
  if (!inField(db.role)) return '';   // not the admin's View as: the office does not time in
  const open = ckOpen(session.uid), today = manilaDate(0);
  const rows = ckRows(session.uid).filter(k => !k.job_id && (k.day === today || (open && k.day === open.day)));
  const line = rows.map(k => (k.kind === 'in' ? 'In ' : 'Out ') + esc(clockOf(k.at)) + unsentPill(k.id)).join(' · ');
  return `<div class="card row-between time-card">
    <div class="lrow-main"><div class="menu-title">${open ? 'Timed in since ' + esc(clockOf(open.at)) : 'Not timed in'}</div>
      ${line ? `<div class="sms-note">${line}</div>` : ''}</div>
    <button type="button" class="b${open ? '' : ' primary'}" data-act="timeclock" data-v="${open ? 'out' : 'in'}">${open ? '■ Time out' : '▶ Time in'}</button></div>`;
}
let ckLastTap = 0;
function timeClock(kind){
  // a double tap would be Time in, then Time out: the button changes under the finger
  if (Date.now() - ckLastTap < 2500) return;
  ckLastTap = Date.now();
  const open = ckOpen(session.uid), id = uuid();
  const send = (lat, lng) => write('check_in', {p_id: id, p_kind: kind, p_lat: lat, p_lng: lng, p_decided_at: null},
    kind === 'in' ? 'Time in' : 'Time out', [id], (db, op) => {
      db.checkins[id] = {id, uid: session.uid, kind, job_id: null, at: op.at, lat, lng, history: [],
                         day: kind === 'out' && open ? open.day : manilaDate(0)};
    });
  if (!(db.checkinRules || {}).require_location){ send(null, null); return; }
  if (!navigator.geolocation){ toast('The office asks for your location, and this phone cannot share it. Ring the office.', true); return; }
  toast('Finding you…');
  navigator.geolocation.getCurrentPosition(
    p => send(Math.round(p.coords.latitude * 1e6) / 1e6, Math.round(p.coords.longitude * 1e6) / 1e6),
    () => toast('The office asks for your location with each time. Turn on location and tap again.', true),
    {enableHighAccuracy: true, timeout: 15000, maximumAge: 60000});
}

/* Last online (56, TODO2 #8): the phone's pull every 30 s while the app is open is the
   heartbeat. One word for Users — and for the map's circles later (TODO2 #6). */
function seenWord(uid){
  const t = db.seen && db.seen[uid]; if (!t) return '';
  if (Date.now() - new Date(t) < 3 * 60000) return 'Online';   // a heartbeat is at most a minute old, and this phone's copy 30 s more
  return 'Last online ' + agoWord(t);
}
function agoWord(t){
  const m = Math.max(0, (Date.now() - new Date(t)) / 60000), n = m < 60 ? Math.round(m) : Math.round(m / 60);
  return m < 1 ? 'just now' : m < 60 ? n + (n === 1 ? ' min' : ' mins') + ' ago' : m < 1440 ? n + (n === 1 ? ' hr' : ' hrs') + ' ago'
    : m < 2880 ? 'yesterday' : new Date(t).toLocaleDateString('en-PH', {day: 'numeric', month: 'short'});
}

/* The users map (58, Guile 2026-10-30, TODO2 #6). While the app is open, this phone's place
   every 2 minutes, or why it has none: on · off (location switched off) · ask (not allowed yet)
   · blocked (Android, or the browser, no longer asks) · web (a browser with no location).
   It never asks by itself — only Allow on the card does. Not queued: an old place is no use. */
let placeAt = 0;
async function locState(){
  if (inApk) return window.AndroidBridge.locationState ? window.AndroidBridge.locationState() : '';   // an APK before 58: nothing
  if (!navigator.geolocation || !navigator.permissions) return 'web';
  try { const s = (await navigator.permissions.query({name: 'geolocation'})).state;
        return s === 'granted' ? 'on' : s === 'denied' ? 'blocked' : 'ask'; } catch (e) { return 'web'; }
}
async function sendPlace(){
  if (!session || !db || !['admin', 'technician', 'helper'].includes(db.role) || !online) return;
  const st = await locState(), was = ui.locSt;
  ui.locSt = st;
  if (st !== was) render();   // the card
  if (!st || (st === was && Date.now() - placeAt < 120000)) return;
  placeAt = Date.now();
  const send = (lat, lng, loc) => rpc('set_my_place', {p_lat: lat, p_lng: lng, p_loc: loc})
    .then(() => { if (lat != null) db.askLocation = false; }).catch(() => {});   // a server before 58, or no signal: next refresh
  if (st !== 'on') return send(null, null, st);
  navigator.geolocation.getCurrentPosition(
    p => send(Math.round(p.coords.latitude * 1e6) / 1e6, Math.round(p.coords.longitude * 1e6) / 1e6, 'on'),
    e => { if (e.code === 2) send(null, null, 'off'); },   // a timeout indoors says nothing: the last place stays
    {enableHighAccuracy: true, timeout: 20000, maximumAge: 60000});
}
// the card on the Jobs screen: when the office asked, or once while location was never allowed
function locCardHtml(){
  const st = ui.locSt;
  if (!['admin', 'technician', 'helper'].includes(db.role) || !st || st === 'on' || st === 'web' || ui.locLater) return '';
  if (!db.askLocation && (st !== 'ask' || lsGet('ws_loc_once', false))) return '';
  const how = st === 'blocked' ? (inApk ? 'Allow opens the app’s settings: tap Permissions, then Location.' : 'Allow it for this site with the lock by the address.')
    : st === 'off' ? 'Location is switched off on this ' + (inApk ? 'phone' : 'device') + '. Allow opens the switch.' : '';
  return `<div class="card loc-card"><div class="menu-title">📍 The office asks to see where you are</div>
    <div class="sms-note">On the shop’s map, only while this app is open. Never when it is closed.${how ? ' ' + how : ''}</div>
    <div class="row-gap"><button type="button" class="b primary" data-act="locallow">Allow</button>
      <button type="button" class="b" data-act="loclater">Not now</button></div></div>`;
}
async function allowLocation(){
  const st = await locState(), b = window.AndroidBridge;
  lsSet('ws_loc_once', true);
  if (st === 'ask'){
    if (inApk) { try { await wsNet.call('askLocation', []); } catch (e) {} }
    else await new Promise(r => navigator.geolocation.getCurrentPosition(r, r, {timeout: 20000}));
  } else if (st === 'blocked'){
    if (inApk) b.openAppSettings(); else toast('Allow location for this site with the lock by the address, then come back.', true);
  } else if (st === 'off'){
    if (inApk && b.openLocationSettings) b.openLocationSettings(); else toast('Turn on location on this device, then come back.', true);
  }
  placeAt = 0; await sendPlace(); render();
}
// why someone is not on the office's map, in words
const LOC_WHY = {off: 'Location is off on their phone', ask: 'Has not allowed location', blocked: 'Said no to location — now it is allowed only in settings',
                 web: 'On a browser that gives no place'};
function locWhy(uid){
  const pl = (db.places || {})[uid];
  if (!pl) return 'Not seen since this update';
  const last = pl.lat != null ? ' · last place ' + agoWord(pl.at) : '';
  return pl.loc === 'on' ? (pl.lat != null ? '' : 'Location on, no place yet') : (LOC_WHY[pl.loc] || pl.loc) + last;
}
function usersMap(){
  const pts = [], why = [];
  const staff = Object.values(db.team).filter(t => ['admin', 'technician', 'helper'].includes(t.role) && t.active !== false)
    .sort((a, b) => (a.display_name || '').localeCompare(b.display_name || ''));
  for (const t of staff){
    const pl = (db.places || {})[t.id], name = t.display_name || (t.email || '').split('@')[0], on = seenWord(t.id) === 'Online';
    if (pl && pl.lat != null) pts.push({lat: +pl.lat, lng: +pl.lng, html: avatarHtml(t.id, name), cls: 'who' + (on ? ' on' : ''), anchor: 'center',
      title: name + (on ? ' — Online' : ' — here ' + agoWord(pl.at)), onTap: () => mapGo('member', t.id)});
    const w = locWhy(t.id);
    if (w) why.push(`<div class="lrow">${avatarHtml(t.id, name)}<div class="lrow-main"><div class="lrow-title">${esc(name)}</div>
      <div class="lrow-sub">${esc(w)}${(db.asked || {})[t.id] ? ' · asked ' + esc(agoWord(db.asked[t.id])) : ''}</div></div>
      ${t.id === session.uid ? '' : `<button type="button" class="b" data-act="askloc" data-id="${esc(t.id)}">Ask again</button>`}</div>`);
  }
  const legend = `<div class="map-legend"><span><i style="background:#3b82f6"></i>online now</span><span><i style="background:#9aa5b1"></i>the last place seen</span></div>`;
  openMapView('Who is where', pts.length + ' of ' + staff.length + ' on the map · only while their app is open', pts,
    legend + (why.length ? `<div class="fieldlabel">${why.length} not on the map, or not sending now</div>` + why.join('') : ''));
}
function askLocation(uid){
  const name = (db.team[uid] || {}).display_name || 'They';
  write('ask_location', {p_uid: uid}, 'Ask ' + name + ' for location', [], db => { db.asked = {...db.asked, [uid]: new Date().toISOString()}; });
  toast('Asked — ' + name + ' sees a card next time the app is open.');
  if (!$('#mapSheet').hidden) usersMap();
}
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
/* ---------------------------------------------------------------- Assigned to (39)
   Guile, 2026-10-10, replacing "No assignment": a job may say who it is on. Everyone still
   sees every job. The badge IS the button — the office gives it to anyone of the shop, a
   technician takes it or hands it on; a helper only reads it. ⚠️ until the person it was
   given to opens it. Every change is a line in its history, with both names. */
const staffOf = uid => uid ? (db.staff || []).find(s => s.id === uid) : null;
function staffName(uid){
  const s = staffOf(uid);
  if (s) return s.name || ROLE_NAME[s.role] || 'Someone';
  return uid === (session && session.uid) ? (db.profile && db.profile.display_name) || 'you' : 'someone no longer here';
}
// on the field's screen and the office's; a helper's (or the admin's View as Helper) only reads
// a done job too (Guile, 2026-10-11, 47): who really worked on it can be seen and put right
const canAssign = j => !!j && j.status !== 'cancelled' && ['admin', 'technician'].includes(viewRole()) && mayWork(j);
/* Only your own jobs (Guile, 2026-10-12, 49). Admin → Job's three switches; none saved = the
   value here. The server holds the lock (two triggers); this only draws it. */
const jobRules = () => { const s = (db && db.settings) || {};
  return {others: s.tech_edit_others === true, ask: s.tech_request !== false, reward: s.tech_reward !== false}; };
// on the crew (head or helper), or the switch lets every technician work every job
const mayWork = j => !inField(viewRole()) || jobRules().others || crewOf(j).includes(session && session.uid);
const askedBy = j => Array.isArray(j && j.requests) ? j.requests.map(r => r.uid).filter(u => staffOf(u)) : [];
const iAsked = j => askedBy(j).includes(session && session.uid);
/* What a technician receives: the server works it out (price × their share) and never sends
   the price itself unless prices are shown. The admin's View as uses his own share. */
function rewardPill(j){
  if (viewRole() !== 'technician' || !jobRules().reward || j.status === 'cancelled') return '';
  let v;
  if (db.role === 'admin'){
    const pct = Number(((db.team || {})[session.uid] || {}).share_pct ?? 10);
    v = j.price == null ? null : Math.round(j.price * pct) / 100;
  } else if ('reward' in j) v = j.reward;
  else return '';
  return v == null ? '<span class="reward none">No price yet</span>'
    : `<span class="reward" title="What you receive">You get ${esc(Number(v) % 1 ? peso(v) : peso0(v))}</span>`;
}
function assignBadge(j, big){
  if (!db || !j || !(db.role === 'admin' || inField(db.role)) || !db.staff) return '';   // a server from before 39
  // (49) a technician asked for it: the office's badge turns yellow and breathes until answered
  const asked = viewRole() === 'admin' && isOpenJob(j) ? askedBy(j) : [];
  if (asked.length){
    const more = asked.length > 1 ? ' +' + (asked.length - 1) : '', t = '🙋 Assign to ' + staffName(asked[0]) + more;
    // 50: moving on the rows too (Guile, 2026-10-12) — only the rows on screen move (namefx.js)
    return `<button type="button" class="pill assign asked${big ? ' big' : ''}" data-act="askopen" data-id="${esc(j.id)}" aria-label="${esc(t + ' — asked for this job')}">🙋 Assign to ${nameFx(staffName(asked[0]), asked[0], 'jobs')}${more}</button>`;
  }
  const who = j.assigned_uid, can = canAssign(j);
  if (!who && !can) return '';
  if (!who && !big && !isOpenJob(j)) return '';   // a done row with nobody: no "＋ Assign" on every old job — it is on the job
  const warn = assignUnseen(j), n = crewOf(j).length;
  // the head by name, the helpers counted: "Assigned to Ana +2" (Guile, 2026-10-11)
  const text = who ? (warn ? '⚠️ ' : '') + 'Assigned to ' + staffName(who) + (n > 1 ? ' +' + (n - 1) : '') : '＋ Assign';
  const html = who ? (warn ? '⚠️ ' : '') + 'Assigned to ' + nameFx(staffName(who), who, 'jobs') + (n > 1 ? ' +' + (n - 1) : '') : '＋ Assign';   // 50
  const cls = 'pill assign' + (who ? '' : ' none') + (warn ? ' warn' : '') + (big ? ' big' : '');
  return can ? `<button type="button" class="${cls}" data-act="assignopen" data-id="${esc(j.id)}" aria-label="${esc(text + (who ? ' — tap to change the crew' : ''))}">${html}</button>`
             : `<span class="${cls}">${html}</span>`;
}
/* The crew (Guile, 2026-10-11, 46): the first picked is the HEAD — the name on the badge — the
   rest are helpers, as many as wanted. The office picks in order and saves; a technician joins
   or leaves himself and hands the head to anyone of the shop, each at once. */
function crewWrite(j, how, who, list, what){
  const cur = crewOf(j);
  const next = how === 'set' ? list : how === 'join' ? cur.filter(x => x !== who).concat([who])
    : how === 'leave' ? cur.filter(x => x !== who) : [who, ...cur.filter(x => x !== who)];
  write('crew_job', {p_job: j.id, p_do: how, p_who: who, p_list: list}, what + ' — ' + (jobCust(j).full_name || 'job'), [j.id], () => {
    j.crew = next; j.assigned_uid = next[0] || null; j.assigned_by = session.uid; j.assigned_at = new Date().toISOString();
  });
  toast(what + '.');
}
function panelAssign(p){
  const j = db.jobs[p.id];
  if (!j) return {title: 'Assign', body: empty('This job is no longer on this phone.')};
  const me = session.uid, office = db.role === 'admin', crew = crewOf(j);
  if (office && !p.sel) p.sel = crew.slice();
  const sel = office ? p.sel : crew;
  const order = {technician: 0, helper: 1, admin: 2};
  const people = (db.staff || []).slice().sort((a, b) => (order[a.role] - order[b.role]) || String(a.name || '').localeCompare(String(b.name || '')));
  const tag = i => i === 0 ? '<span class="crew-no head">👑 Head</span>' : `<span class="crew-no">${i + 1} · Helper</span>`;
  const row = s => {
    const i = sel.indexOf(s.id), on = i >= 0, name = nameFx(s.name || ROLE_NAME[s.role], s.id, 'jobs') + (s.id === me ? ' (you)' : '');
    const head = on && i > 0 || (!office && !on)
      ? `<button type="button" class="b crew-head" data-act="crewhead" data-id="${esc(j.id)}" data-v="${esc(s.id)}">👑 Make head</button>` : '';
    return office
      ? `<div class="crew-row${on ? ' on' : ''}"><button type="button" class="menu-row pick" data-act="crewtoggle" data-id="${esc(j.id)}" data-v="${esc(s.id)}">
          <span class="crew-box">${on ? '✓' : ''}</span><span class="menu-main"><span class="menu-title">${name}</span>
          <span class="menu-sub">${esc(ROLE_NAME[s.role] || s.role)}</span></span>${on ? tag(i) : ''}</button>${head}</div>`
      : `<div class="crew-row${on ? ' on' : ''}"><div class="menu-row pick"><span class="menu-main"><span class="menu-title">${name}</span>
          <span class="menu-sub">${esc(ROLE_NAME[s.role] || s.role)}</span></span>${on ? tag(i) : ''}</div>${i === 0 ? '' : head}</div>`;
  };
  const changed = office && JSON.stringify(sel) !== JSON.stringify(crew);
  const mine = crew.includes(me);
  return {title: crew.length ? 'The crew' : 'Assign the job', sub: jobCust(j).full_name || '', body: `
    <p class="hint">${office ? 'Tap in order: the <b>first is the head</b> — the name on the badge — the rest are helpers. As many as you like.'
      : 'The head is the name on the badge; the rest are helpers.'}</p>
    ${office ? '' : `<button type="button" class="b ${mine ? '' : 'primary '}wide" data-act="${mine ? 'crewleave' : 'crewjoin'}" data-id="${esc(j.id)}">${mine ? '🚪 Leave the crew' : '🙋 Join as a helper'}</button>`}
    <div class="menu crew">${people.map(row).join('') || '<p class="hint">Nobody of the shop is on this phone yet.</p>'}</div>
    ${office ? `<div class="stack"><button type="button" class="b primary wide" data-act="crewsave" data-id="${esc(j.id)}"${changed ? '' : ' disabled'}>${sel.length ? 'Save the crew (' + sel.length + ')' : 'Save — no assign'}</button>
      ${sel.length ? `<button type="button" class="b wide" data-act="crewclear" data-id="${esc(j.id)}">Clear — no assign</button>` : ''}</div>` : ''}
    <p class="hint">Everyone still sees every job. Its history says who was put on it, and by whom.</p>`};
}
/* (49) A job that is not theirs: what it is, who is on it, and the one thing they can do —
   ask the office for it. A helper only reads; asking is a technician's. */
function panelAskJob(p){
  const j = db.jobs[p.id];
  if (!j) return {title: 'Job', body: empty('This job is no longer on this phone.')};
  const c = jobCust(j), r = jobRules(), crew = crewOf(j), asked = iAsked(j), tech = viewRole() === 'technician';
  const ask = !tech || !isOpenJob(j) ? '' : !r.ask
    ? '<p class="hint">Ring the office if you want this job — they assign it.</p>'
    : asked ? `<div class="ask-wait">🙋 You asked the office for this job.<br>Waiting for their answer.</div>
        <button type="button" class="b wide" data-act="jobunask" data-id="${esc(j.id)}">Take back my request</button>`
    : `<button type="button" class="b primary wide" data-act="jobask" data-id="${esc(j.id)}">🙋 Ask the office for this job</button>
       <p class="hint">The office sees “Assign to ${esc(staffName(session.uid))}” on the job and answers.</p>`;
  return {title: c.full_name || 'Job', sub: 'Not your job', body: `
    <div class="lock-card">🔒 <b>View only.</b> Only the people assigned to this job can open it and work on it.</div>
    <div class="card">
      ${kv('Status', statusPill(j.status))}
      ${kv('When', esc(j.scheduled_on ? niceDate(j.scheduled_on) + ', ' + slotWord(j.slot) : 'No date yet'))}
      ${kv('Work', esc([unitsLine(unitsOf(j)), svcList(j.services)].filter(Boolean).join(' — ')))}
      ${kv('Area', esc(place(c)))}
      ${kv('Assigned', crew.length ? nameFx(staffName(crew[0]), crew[0], 'jobs') + (crew.length > 1 ? ' +' + (crew.length - 1) : '') : 'Nobody yet')}
      ${rewardPill(j) ? kv('You would receive', rewardPill(j)) : ''}
    </div>
    <div class="stack">${ask}</div>`};
}
/* (49) The office's answer: each person who asked, Assign or Say no. Yes puts them on the
   crew — the head when nobody is on it, else a helper (Guile, 2026-10-12). */
function panelAskAnswer(p){
  const j = db.jobs[p.id];
  if (!j) return {title: 'Asked', body: empty('This job is no longer on this phone.')};
  const asked = (j.requests || []).filter(r => staffOf(r.uid)), crew = crewOf(j);
  const rows = asked.map(r => `<div class="card ask-row">
      <div class="menu-title">🙋 ${nameFx(staffName(r.uid), r.uid, 'jobs')}</div>
      <div class="sms-note">${esc(ROLE_NAME[(staffOf(r.uid) || {}).role] || '')} · asked ${esc(timeAgo(r.at))} · would go on as ${crew.length ? 'a helper' : 'the head'}</div>
      <div class="row-gap"><button type="button" class="b primary" data-act="askyes" data-id="${esc(j.id)}" data-v="${esc(r.uid)}">✓ Assign ${esc(staffName(r.uid))}</button>
        <button type="button" class="b" data-act="askno" data-id="${esc(j.id)}" data-v="${esc(r.uid)}">✕ Say no</button></div>
    </div>`).join('');
  return {title: 'Asked for this job', sub: jobCust(j).full_name || '', body: `
    ${rows || empty('Nobody is asking any more.')}
    <p class="hint">${crew.length ? 'On it now: ' + esc(crew.map(staffName).join(', ')) + '.' : 'Nobody is on it yet.'} The crew screen still changes anything.</p>
    <div class="stack"><button type="button" class="b wide" data-act="assignopen" data-id="${esc(j.id)}">👤 The crew…</button></div>`};
}
/* The job's appliances as small pictures, each type once with its count; four at most. */
function unitIcons(units){
  const n = {}, order = [];
  units.forEach(u => { const t = u.type || ''; if (!(t in n)){ n[t] = 0; order.push(t); } n[t]++; });
  return order.slice(0, 4).map(t => `<span class="unit-ico" title="${esc(typeLabel(t) + (n[t] > 1 ? ' ×' + n[t] : ''))}"><img src="${esc(typePic(t))}" alt="${esc(typeLabel(t))}">${n[t] > 1 ? `<i>${n[t]}</i>` : ''}</span>`).join('')
    + (order.length > 4 ? `<span class="unit-more">+${order.length - 4}</span>` : '');
}
function jobRow(j){
  const c = jobCust(j), ab = assignBadge(j), icons = unitIcons(unitsOf(j));
  // "5:00PM" on one line, the date under it (Guile, 2026-10-11)
  const when = j.scheduled_on ? `<b>${esc(slotShort(j.slot).replace(/\s/g, ''))}</b><span>${esc(shortDate(j.scheduled_on))}</span>` : '<b>—</b><span>no date</span>';
  // the time IS the Reschedule button, for the office, on an open job (Guile, 2026-10-11)
  const resched = db.role === 'admin' && viewRole() === 'admin' && isOpenJob(j);
  // (49) not theirs: the box to see, its tap asks for it
  // under the time: beside the badge it cut "Assigned to Gringo" to "Assigne…" at 375 px
  const mine = mayWork(j), lock = mine ? '' : `<span class="lock-tag">${iAsked(j) ? '🙋 Asked' : '🔒 View only'}</span>`;
  const reward = rewardPill(j);
  return `<div class="lrow job-row has-steps${ab || icons ? ' has-assign' : ''}${mine ? '' : ' locked'}" role="button" tabindex="0" data-act="${mine ? 'open' : 'askjob'}" data-kind="job" data-id="${esc(j.id)}" data-stamp="${esc(j.updated_at || '')}">
    ${resched ? `<button type="button" class="lrow-when resched" data-act="resched" data-id="${esc(j.id)}" aria-label="${esc(j.scheduled_on ? 'Reschedule' : 'Schedule it')}">${when}</button>`
      : `<div class="lrow-when">${when}${lock}</div>`}
    <div class="lrow-main">
      <div class="lrow-title">${assignUnseen(j) ? '<span class="warn-mark" title="Assigned to you">⚠️</span>' : newDot(jobUnseen(j))}${esc(c.full_name || '…')}${unsentPill(j.id)}</div>
      <div class="lrow-sub">${esc([unitsLine(unitsOf(j)), svcList(j.services)].filter(Boolean).join(' — '))}</div>
      <div class="lrow-sub">${esc(place(c))}</div>
    </div>
    ${ab || icons ? `<div class="lrow-assign">${icons ? `<span class="lrow-icons">${icons}</span>` : ''}${ab}</div>` : ''}
    <div class="lrow-side">${paidPill(j)}${statusPill(j.status)}${j.price != null && seesPrice() ? `<span class="lrow-price">${esc(peso0(j.price))}</span>` : ''}${reward}</div>
    ${miniSteps({booking: bookingOfJob(j), job: j})}
  </div>`;
}
function panelJob(p){
  const j = db.jobs[p.id];
  if (!j) return {title: 'Job', body: empty('This job is no longer on this phone.')};
  if (!mayWork(j)) return panelAskJob(p);   // (49) not theirs: only the asking screen
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
  // then and only then — and gives the billing statement from it (45, was the receipt)
  const techPrice = tech && j.price != null && seesPrice();
  const billRow = menuRow('jobbill', j.id, '🧾', 'Billing statement', j.billing
    ? 'Saved ' + niceDate(manilaDay(j.billing.saved_at)) + ' · ' + peso(j.billing.total)
    : tech ? 'Print or send it to the customer' : j.status === 'cancelled' ? 'Nothing to bill' : 'From the quotation — add extra work, print or send');
  // the quotation and the billing statement side by side, the customer's signature under them
  // (Guile, 2026-10-11); a technician reads both while prices are shown and takes the signature
  const quoteRow = open || j.quote ? menuRow('jobquote', j.id, '📄', 'Quotation', j.quote
    ? 'Saved ' + niceDate(manilaDay(j.quote.saved_at)) + ' · ' + peso(j.quote.total)
    : 'Make one to send — its total becomes the price') : '';
  const signRow = canSign(j) ? menuRow('jobsign', j.id, '✍️', 'Customer’s signature', signWords(j)) : '';
  const reportRow = reportRows(j);   // 57: one service report per appliance, prices or not
  const techMenu = (techPrice && j.quote ? quoteRow : '') + (techPrice ? billRow : '') + reportRow + signRow;
  const menu = helper ? '' : tech ? (techMenu ? `<div class="menu">${techMenu}</div>` : '') : `<div class="menu">
      ${menuRow('price', j.id, '₱', j.price != null ? 'Change the price' : 'Set the price', j.price != null ? peso(j.price) : 'Not set yet')}
      ${quoteRow}
      ${billRow}
      ${reportRow}
      ${signRow}
      ${custOf(j.customer_id) ? menuRow('customer', j.customer_id, '👤', 'History & Checkup', c.full_name) : ''}
      ${open ? menuRow('cancel', j.id, '✕', 'Cancel the job', 'You will be asked why', 'is-danger') : ''}
      ${menuRow('deljob', j.id, '🗑️', 'Delete this job', (bookingOfJob(j) ? 'With its booking. ' : '') + 'You will be warned first.', 'is-danger')}
    </div>`;
  // L3: the gate photo first on a technician's screen — the first thing needed at the street
  return {title: c.full_name || 'Job', sub: svcList(j.services), body: `
    ${tech && !helper ? custPicsHtml(j.customer_id, c, false, true) : ''}
    ${stepsHtml({booking: bookingOfJob(j), job: j})}
    ${techPrice && !helper ? `<div class="big-price"><span>To collect when the job is done</span><b>${esc(peso(j.price))}</b></div>` : ''}
    <div class="card" data-row="${esc(j.id)}" data-stamp="${esc(j.updated_at || '')}">
      ${!tech ? custPicsHtml(j.customer_id, c, false, true) : ''}
      ${kv('Status', paidPill(j) + ' ' + statusPill(j.status) + unsentPill(j.id) + (by && ['in_progress', 'done', 'cancelled'].includes(j.status) ? ` <span class="muted">by ${whoHtml(by, j.status_by)}</span>` : ''))}
      ${assignBadge(j, true) ? kv('Assigned', assignBadge(j, true) + (crewOf(j).length > 1
        ? `<div class="crew-line">👑 ${nameFx(staffName(crewOf(j)[0]), crewOf(j)[0], 'jobs')} · Helpers: ${crewOf(j).slice(1).map(u => nameFx(staffName(u), u, 'jobs')).join(', ')}</div>` : '')) : ''}
      ${j.on_way_at && ['booked', 'scheduled'].includes(j.status) ? kv('On the way', esc('since ' + new Date(j.on_way_at).toLocaleTimeString('en-PH', {hour: 'numeric', minute: '2-digit'}))) : ''}
      ${kv('When', esc(j.scheduled_on ? niceDate(j.scheduled_on) + ', ' + slotWord(j.slot) : 'No date yet'))}
      ${kv('Number', esc(c.contact || ''))}
      ${kv('Address', esc(c.address || ''))}
      ${kv('Landmark', esc(c.landmark || ''))}
      ${kv('Notes', j.notes ? esc(j.notes) : '')}
      ${tech ? (helper && techPrice ? kv('Price', esc(peso(j.price))) : '') : kv('Price', esc(j.price != null ? peso(j.price) : 'Not set yet'))}
      ${rewardPill(j) ? kv('You receive', rewardPill(j)) : ''}
      ${tech || j.status === 'cancelled' ? '' : `<div class="paid-row">${j.paid_method
        ? `<span class="pill done">Paid · ${esc(PAY[j.paid_method])}${j.paid_at ? ' · ' + esc(shortDate(manilaDay(j.paid_at))) : ''}</span>
           <button type="button" class="b" data-act="paid" data-id="${esc(j.id)}" data-v="">Not paid</button>`
        : `<span class="muted">Not paid yet</span>${['cash', 'gcash', 'other'].map(m =>
            `<button type="button" class="b" data-act="paid" data-id="${esc(j.id)}" data-v="${m}">${m === 'cash' ? '💵 Cash' : m === 'gcash' ? '📱 GCash' : 'Other'}</button>`).join('')}`}</div>`}
      ${j.status === 'done' && j.done_at ? kv('Done', esc(new Date(j.done_at).toLocaleString('en-PH', {dateStyle: 'medium', timeStyle: 'short'}))) : ''}
      ${j.status === 'cancelled' && !helper ? kv('Why cancelled', esc(j.cancel_reason || '')) : ''}
      ${helper ? '' : `<div class="actions">${callBtn(c.contact)}${tech ? '' : textBtn(j)}${mapBtn(c)}${canAssign(j) && db.staff
        ? `<button type="button" class="b" data-act="assignopen" data-id="${esc(j.id)}">👤 ${j.assigned_uid ? 'Transfer' : 'Assign'}</button>` : ''}${canWorkPhoto(j) ? workPhotoBtn(j) : ''}${!tech || (j.scheduled_on && j.status !== 'cancelled') ? editBtn('editjob', j.id) : ''}</div>`}
    </div>
    ${helper ? '' : workPhotosHtml(j)}
    ${tech ? '' : wantNote(j)}
    ${tech ? '' : textsDoneHtml(j)}
    ${acts.length ? `<div class="actions fill">${acts.join('')}</div>` : ''}
    <div class="sec">🛒 Aircons &amp; appliances</div>
    ${cartHtml('view', unitsOf(j), {pf: helper || (tech && !techPrice) ? null : officePrice, missing: 'Not every service has a price yet',
      saved: helper ? null : id => savedOf(j.customer_id, id)})}
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
  // 55: an old job's shared key reads the appliance's own copy, the list the owner edits now
  const keys = new Set(unitsOf(j).flatMap(u => (u.services || []).map(k => ownKey(u.type, k))));
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
const prepWho = x => nameFx(x.name || 'Someone', x.by, 'history') + ' (' + esc(ROLE_NAME[x.role] || x.role || '') + ')';
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
        || `<p class="hint">Nothing listed for these services yet.${db.role === 'admin' ? ' The lists are in Admin → Appliances &amp; services.' : ''}</p>`}
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
/* No "the price list says …" note under the aircons (Guile, 2026-10-11): the price comes from
   the quotation or the billing statement now, so the list's sum beside it was only a warning. */
/* Reschedule (Guile, 2026-10-11): tap the time on a job row. The booking form's own day and
   time, and one tick for the customer's text. Ticked: the "booked / moved" text goes as it
   always does (automatic texts on), or the Text screen opens with it written (off, and this
   person sends texts). Not ticked: the move is written down as not texted, so the sending
   phone leaves it alone. */
function schedText(j){
  if (!['booked', 'scheduled'].includes(j.status) || digits(jobCust(j).contact).length < 10) return null;
  const set = textSet();
  if (set.auto && set.booked && textSender()) return 'auto';
  return canTextHere() ? 'hand' : null;
}
function panelSchedule(p){
  const j = db.jobs[p.id];
  if (!j) return {title: 'Schedule', body: empty('This job is no longer on this phone.')};
  if (p.date == null){ p.date = j.scheduled_on || ''; p.slot = j.slot || 'am'; }
  const waiting = p.date === '', how = waiting ? null : schedText(j);
  const title = j.scheduled_on ? 'Reschedule' : 'Schedule it';
  // the button says what the tap will do (ui.md): Waiting on a dated job takes its day away
  const word = waiting && j.scheduled_on ? 'Move to Waiting' : title;
  if (p.texton == null) p.texton = schedText(j) === 'auto';
  // the booking form's own day-and-time piece (ui.md, Reuse); a started job keeps its day
  return {title, sub: jobCust(j).full_name, body: `
    ${bkWhenHtml('panel', p, {notYet: false, waiting: j.status !== 'in_progress'})}
    ${waiting ? '<p class="hint">⏳ Waiting: the job goes back to <b>No date</b> until a day is chosen. No text is sent.</p>' : ''}
    ${how ? `<label class="tick"><input type="checkbox" data-pf="texton" ${p.texton ? 'checked' : ''}> Send the customer a text about the ${j.scheduled_on ? 'new ' : ''}schedule</label>
      <p class="hint">${how === 'auto' ? 'From the sending phone, the next time its app is open.' : 'Automatic texts are off: the Text screen opens with the message written.'}</p>` : ''}
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
/* One search for the customers and what they own (Guile, 2026-10-10): name, number, address,
   landmark, and every saved appliance — type, brand, model, serial, Additionals, notes, the
   owner's boxes. Forgiving: a word may be the start of one ("dai" finds Daikin), and a
   misspelt word finds the nearest ("daiken", "carier"), one slip in five letters, two in
   seven. Every word typed must be found somewhere, or the closest customers are shown under
   "No exact match". The Customers screen and Book a job's Customer files both use it. */
const fold = s => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
// "Victoria's" is one word, victorias
const words = s => fold(s).replace(/['’]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
// Damerau–Levenshtein (a swap counts as one slip), stopped early past `max`
function slips(a, b, max){
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null, prev = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++){
    const cur = [i]; let low = i;
    for (let j = 1; j <= b.length; j++){
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2] + 1);
      cur.push(d); if (d < low) low = d;
    }
    if (low > max) return max + 1;
    prev2 = prev; prev = cur;
  }
  return prev[b.length];
}
// one typed word against one word of a customer: 1 the same, .9 its start, .7 inside it,
// less for a near spelling, 0 not it
function wordScore(q, w){
  if (w === q) return 1;
  if (w.startsWith(q)) return 0.9;
  if (q.length >= 3 && w.includes(q)) return 0.7;
  const max = q.length <= 3 ? 0 : q.length <= 6 ? 1 : 2;
  if (!max || /^\d+$/.test(q)) return 0;
  const d = Math.min(slips(q, w, max), w.length > q.length ? slips(q, w.slice(0, q.length), max) : max + 1);
  return d <= max ? 0.6 - 0.1 * d : 0;
}
const liveUnits = c => (c.units || []).filter(x => !x.removed);
// what can be found on a customer: [where, its words, weight]; an appliance's own place says which
function custFields(c){
  const out = [['name', words(c.full_name), 3], ['address', words(c.address), 2], ['landmark', words(c.landmark), 1]];
  liveUnits(c).forEach((x, i) => {
    out.push(['u' + i, words([typeLabel(x.type), x.brand, x.model, x.serial].join(' ')), 3]);
    out.push(['u' + i, words([x.extra, x.problem, x.notes, ...Object.values(x.specs || {})].join(' ')), 1]);
  });
  return out;
}
function custSearch(q, keepRemoved){
  const qs = [...new Set(words(q))];
  const all = Object.values(db.customers).filter(c => keepRemoved || c.full_name !== '(removed)');
  if (!qs.length) return {rows: all.sort((a, b) => a.full_name.localeCompare(b.full_name)).map(c => ({c})), exact: true, near: []};
  const near = {};   // a typed word → the word it was taken for, when not spelt the same
  const scored = all.map(c => {
    const fields = custFields(c), num = digits(c.contact);
    let total = 0, found = 0;
    const hitUnits = new Set(), marks = new Set();
    qs.forEach(qw => {
      let best = 0, bestW = '', where = [];
      // a number: the contact number, wherever the digits sit in it
      if (/^\d{3,}$/.test(qw) && num.includes(qw)){ best = 1; where = ['contact']; }
      fields.forEach(([k, ws, wt]) => ws.forEach(w => {
        const s = wordScore(qw, w) * (0.75 + wt / 12);
        if (s > best + 1e-9){ best = s; bestW = w; where = [k]; }
        else if (s && Math.abs(s - best) < 1e-9 && !where.includes(k)) where.push(k);
      }));
      if (best){
        found++; total += best;
        where.forEach(k => { if (k[0] === 'u') hitUnits.add(+k.slice(1)); });
        if (bestW){ marks.add(bestW); if (bestW !== qw && !bestW.startsWith(qw) && !bestW.includes(qw)) near[qw] = bestW; }
      }
    });
    return {c, total, found, units: [...hitUnits], marks};
  }).filter(r => r.found);
  const exact = scored.filter(r => r.found === qs.length);
  const rows = (exact.length ? exact : scored).sort((a, b) => b.found - a.found || b.total - a.total || a.c.full_name.localeCompare(b.c.full_name));
  return {rows, exact: !!exact.length, near: Object.entries(near)};
}
// the words found, marked where they show
function markWords(text, marks){
  if (!marks || !marks.size) return esc(text);
  return String(text || '').split(/([^A-Za-z0-9\u00C0-\u024F'’]+)/).map(part => marks.has(fold(part).replace(/['’]/g, '')) ? `<mark>${esc(part)}</mark>` : esc(part)).join('');
}
/* A customer's picture is their appliance's (Guile, 2026-10-10: instead of "AF", "AC"); none
   saved yet, their initials. The count when they have more than one. */
function custAvatar(c){
  const us = liveUnits(c);
  const n = {}; us.forEach(x => { n[x.type] = (n[x.type] || 0) + 1; });
  return typeAvatar(Object.keys(n).sort((a, b) => n[b] - n[a])[0], us.length, c.full_name);
}
/* An appliance's picture in the round avatar, the count when more than one; no appliance, the
   initials. A customer's row and an Inbox row (its FIRST appliance — Guile, 2026-10-11). */
function typeAvatar(type, count, name){
  if (!type) return `<div class="avatar cu">${esc(initials(name))}</div>`;
  return `<div class="avatar pic"><img src="${esc(typePic(type))}" alt="${esc(typeLabel(type))}">${count > 1 ? `<span class="avatar-n">${count}</span>` : ''}</div>`;
}
// 433-5680 · Victorias Public Market · Split ×2 · Window — one line; a long address gives way
// first, so the appliances stay in sight (measured at 375 px: they were cut off)
const custSub = (c, marks) => [c.contact ? `<span class="cs-n">${markWords(c.contact, marks)}</span>` : '',
  c.address ? `<span class="cs-a">${markWords(c.address, marks)}</span>` : '',
  liveUnits(c).length ? `<span class="cs-u">${esc(unitsLine(liveUnits(c)))}</span>` : ''].filter(Boolean).join('<span class="cs-dot">·</span>');
// the appliances the search found on them, each with its picture — tap one to open it
function custHitUnits(c, r){
  if (!r || !r.units || !r.units.length) return '';
  const us = liveUnits(c);
  return `<div class="cu-hits">${r.units.map(i => us[i]).filter(Boolean).map(x => `<div class="cu-hit" role="button" tabindex="0" data-act="open" data-kind="custunit" data-id="${esc(c.id + '|' + x.id)}">
      <img class="type-ico sm" src="${esc(typePic(x.type))}" alt=""><span><b>${markWords(typeLabel(x.type), r.marks)}</b> ${markWords(savedLine(x), r.marks)}${
        x.extra ? ' <span class="muted">· ' + markWords(x.extra, r.marks) + '</span>' : ''}</span></div>`).join('')}</div>`;
}
function custListHtml(){
  const q = (ui.search || '').trim(), res = custSearch(q, true), n = res.rows.length;
  const said = !q ? `${n} customer${n === 1 ? '' : 's'}`
    : !n ? '' : res.exact ? `${n} found` : 'No exact match — the closest:';
  const near = res.near.length ? `<p class="hint near">Showing results for ${res.near.map(([a, b]) => `<b>${esc(b)}</b>`).join(', ')} — you typed ${res.near.map(([a]) => esc(a)).join(', ')}</p>` : '';
  return (said ? `<p class="count">${said}</p>` : '') + near +
    (n ? `<div class="list">${res.rows.map(r => custRow(r.c, r)).join('')}</div>`
       : empty(q ? 'Nobody matches “' + q + '”. Try fewer letters, or a brand, a model or a number.' : 'No customers yet.'));
}
// the owner's appliance types as chips with their pictures: one tap searches for it
function custTypeChips(){
  const have = {};
  Object.values(db.customers).forEach(c => new Set(liveUnits(c).map(x => x.type)).forEach(k => { have[k] = (have[k] || 0) + 1; }));
  const ts = typeRows().filter(x => have[x.key]);
  if (!ts.length) return '';
  const cur = fold((ui.search || '').trim());
  return `<div class="type-chips">${ts.map(x => `<button type="button" class="type-chip${cur === fold(x.label) ? ' active' : ''}" data-act="custtype" data-v="${esc(x.label)}">
      <img src="${esc(typePic(x.key))}" alt="">${esc(x.label)} <span class="muted">${have[x.key]}</span></button>`).join('')}</div>`;
}
function custSearchDraw(){
  $('#custList').innerHTML = custListHtml();
  const ch = $('#custChips'); if (ch) ch.innerHTML = custTypeChips();
  const x = $('.find-x'); if (x) x.hidden = !(ui.search || '');
}
function drawPeople(){
  const pinned = Object.values(db.customers).filter(c => c.lat != null && c.full_name !== '(removed)').length;
  return `<div class="menu"><button type="button" class="menu-row" data-act="custmap">
      <span class="menu-ico">🗺️</span><span class="menu-main"><span class="menu-title">Customers on the map</span>
      <span class="menu-sub">${pinned} pinned · days since each one's last visit</span></span><span class="menu-chev">›</span></button></div>
    <div class="find-wrap"><input type="search" class="find" id="custSearch" placeholder="🔎 Name, number, brand, model…" value="${esc(ui.search || '')}" autocomplete="off" enterkeyhint="search">
      <button type="button" class="find-x" data-act="custclear" aria-label="Clear the search"${(ui.search || '') ? '' : ' hidden'}>×</button></div>
    <div id="custChips">${custTypeChips()}</div>
    <div id="custList">${custListHtml()}</div>
    <div class="menu">${menuRow('tidy', '', '🧹', 'Tidy up old bookings', 'Delete rejected and cancelled ones')}</div>`;
}
function custRow(c, r){
  const n = jobsOf(c.id).length, marks = r && r.marks;
  return `<div class="lrow" role="button" tabindex="0" data-act="open" data-kind="customer" data-id="${esc(c.id)}" data-stamp="${esc(c.updated_at || '')}">
    ${custAvatar(c)}
    <div class="lrow-main"><div class="lrow-title">${markWords(c.full_name, marks)}${unsentPill(c.id)}</div>
      <div class="lrow-sub cs">${custSub(c, marks)}</div>${custHitUnits(c, r)}</div>
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
      ${kv('Number', esc(c.contact))}
      ${kv('Address', esc(c.address))}
      ${kv('Landmark', esc(c.landmark || ''))}
      ${kv('Customer since', esc(c.created_at ? new Date(c.created_at).toLocaleDateString('en-PH', {day: 'numeric', month: 'short', year: 'numeric'}) : ''))}
      <div class="actions">${callBtn(c.contact)}${mapBtn(c)}</div>
    </div>
    ${removed ? '' : custPicsHtml(c.id, c, db.role === 'admin')}
    ${removed ? '' : `<div class="stack"><button type="button" class="b wide" data-act="open" data-kind="editcust" data-id="${esc(c.id)}">✏️ Edit</button>
      <button type="button" class="b primary wide" data-act="book" data-id="${esc(c.id)}">Book a Job for ${esc(c.full_name.split(' ')[0])}</button></div>
    <div class="sec">📅 Regular check${cu ? ` <span class="plan-now${k && k.due <= today ? ' due' : ''}">${esc(cu)}</span>` : ''}</div>
    <div class="card">${checkPlanHtml(c.id, c.check_every, c.check_next, c.check_day)}</div>`}
    ${removed ? airconHistoryHtml(c.id) : appliancesHtml(c)}
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
      ${esc(n(js.length, 'job'))}, their history, their gate photo and their jobs’ work photos — from every phone. Numbers stop
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
/* The customer's saved appliances (43), each with its last services from the jobs linked to
   it; tap one to edit it. Before 43's jobs, the old "Their aircons" list still shows. */
function appliancesHtml(c){
  // removed ones last and greyed — still there to bring back (schema.md: a delete is tidying)
  const list = [...(c.units || [])].sort((a, b) => !!a.removed - !!b.removed);
  const last = id => { const out = {};
    jobsOf(c.id).filter(j => j.status === 'done' && j.done_at).forEach(j => unitsOf(j).forEach(u => {
      if (u.cu === id) u.services.forEach(k => { const d = manilaDay(j.done_at); if (!out[k] || out[k] < d) out[k] = d; }); }));
    return Object.entries(out).map(([k, d]) => svcLabel(k) + ' ' + shortDate(d)).join(' · '); };
  return `<div class="sec">🗂️ Appliances <span class="prep-count">${list.filter(x => !x.removed).length}</span></div>
    ${list.length ? `<div class="list">${list.map(x => `<div class="lrow${x.removed ? ' off' : ''}" role="button" tabindex="0" data-act="open" data-kind="custunit" data-id="${esc(c.id + '|' + x.id)}">
        <img class="type-ico unit-pic" src="${esc(typePic(x.type))}" alt="">
        <div class="lrow-main"><div class="lrow-title">${esc(typeLabel(x.type))} <span class="muted">${esc(savedLine(x))}</span></div>
          ${x.extra ? `<div class="lrow-sub">${esc(x.extra)}</div>` : ''}
          ${x.notes ? `<div class="lrow-sub">📝 ${esc(x.notes.split('\n')[0])}</div>` : ''}
          ${last(x.id) ? `<div class="lrow-sub">${esc(last(x.id))}</div>` : ''}</div>
        <span class="menu-chev">›</span></div>`).join('')}</div>` : airconHistoryHtml(c.id) || '<p class="hint">None saved yet. A job’s aircons are saved here by themselves.</p>'}
    <div class="stack"><button type="button" class="b wide" data-act="open" data-kind="custunit" data-id="${esc(c.id + '|')}">＋ Add appliance</button></div>`;
}
function panelCustUnit(p){
  const [cid, uid] = String(p.id || '').split('|'), c = custOfId(cid);
  if (!c) return {title: 'Appliance', body: empty('This customer is no longer on this phone.')};
  const x = uid ? ((c.units || []).find(y => y.id === uid) || null) : null;
  if (p.type == null){
    Object.assign(p, {uid: uid || uuid(), type: x ? x.type : '', brand: x && x.brand || '', model: x && x.model || '', serial: x && x.serial || '',
      extra: x && x.extra || '', problem: x && x.problem || '', notes: x && x.notes || '', removed: !!(x && x.removed)});
    Object.entries(x && x.specs || {}).forEach(([k, v]) => { p['spec_' + k] = v; });   // 44
  }
  const boxes = (db.unitFields || []).filter(f => !f.removed && (f.types || []).includes(p.type));
  const vals = {}; boxes.forEach(f => { vals[f.key] = p['spec_' + f.key] || ''; });
  const lines = Math.min(30, Math.max(6, String(p.notes || '').split('\n').length + 1));
  return {title: x ? typeLabel(x.type) : 'New appliance', sub: c.full_name, body: `
    ${x ? '' : `<div class="fieldlabel">What is it?</div>
    <div class="tabbar tight">${activeTypes().map(t => `<button type="button" class="tab-btn${p.type === t.key ? ' active' : ''}" data-act="pset" data-f="type" data-v="${esc(t.key)}">${p.type === t.key ? '✓ ' : ''}${esc(t.label)}</button>`).join('')}</div>`}
    <div class="row">
      <label>Brand <input data-pf="brand" maxlength="60" value="${esc(p.brand)}" autocomplete="off"></label>
      <label>Model <input data-pf="model" maxlength="60" value="${esc(p.model)}" autocomplete="off"></label>
    </div>
    <label>Serial number <input data-pf="serial" maxlength="60" value="${esc(p.serial)}" autocomplete="off"></label>
    <label>Additionals <textarea data-pf="extra" maxlength="200" rows="2" placeholder="Indoor or outdoor, which room…">${esc(p.extra)}</textarea></label>
    ${specBoxes(boxes, vals, 'data-pfspec')}
    <label>Problem or complaint <textarea data-pf="problem" maxlength="300" rows="2">${esc(p.problem)}</textarea></label>
    <label>📝 Notes <span class="opt">— the shop's only: what was done, parts changed. The customer never sees them.</span>
      <textarea data-pf="notes" maxlength="4000" rows="${p.big ? lines : 6}" class="notes-box" placeholder="Oct 10 — changed the capacitor. Cleaned the drain…">${esc(p.notes)}</textarea></label>
    <div class="actions"><button type="button" class="b" data-act="pset" data-f="big" data-v="${p.big ? '' : '1'}">${p.big ? '⤡ Smaller' : '⤢ Show all the notes'}</button></div>
    <div class="stack"><button type="button" class="b primary wide" data-act="savecustunit">Save</button>
      ${x ? `<button type="button" class="b wide${x.removed ? '' : ' danger'}" data-act="savecustunit" data-v="${x.removed ? 'back' : 'remove'}">${x.removed ? 'Bring it back' : 'Remove from their file'}</button>` : ''}</div>`};
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
/* Check-ups in three (Guile, 2026-10-11): Due — the calls to make now; Coming — every regular
   check still ahead, by date, under its month; No regular check — the customers without one
   (never set, or turned Off: both are saved as no plan), so the owner can give them one. */
function checkupGroups(){
  const today = manilaDate(0), coming = [], none = [];
  for (const c of Object.values(db.customers)){
    if (c.full_name === '(removed)') continue;
    const k = checkupOf(c);
    if (!k) none.push(c);
    else if (k.due > today || k.busy) coming.push({c, ...k});
  }
  // the newest last job first — the likeliest to want a regular check; no job yet last
  const last = new Map(none.map(c => { const j = jobsOf(c.id).filter(j => j.status === 'done' && j.done_at).sort(byDoneDesc)[0]; return [c.id, j ? j.done_at : '']; }));
  none.sort((a, b) => last.get(b.id).localeCompare(last.get(a.id)) || String(a.full_name).localeCompare(String(b.full_name)));
  return {due: checkups(), coming: coming.sort((a, b) => a.due.localeCompare(b.due)), none, last};
}
function drawCheckups(){
  const g = checkupGroups(), view = ['due', 'coming', 'none'].includes(ui.ck) ? ui.ck : 'due';
  const tabs = chips('ckview', [['due', 'Due', g.due.length + followups().length], ['coming', 'Coming', g.coming.length],
    ['none', 'No regular check', g.none.length]], view);
  if (view === 'coming'){
    const months = [];   // [['2026-12', [k, …]], …], already in date order
    g.coming.forEach(k => { const m = k.due.slice(0, 7); if (!months.length || months[months.length - 1][0] !== m) months.push([m, []]); months[months.length - 1][1].push(k); });
    const word = m => new Date(m + '-01T00:00:00Z').toLocaleDateString('en-PH', {month: 'long', year: 'numeric', timeZone: 'UTC'});
    return tabs + (months.length ? months.map(([m, ks]) => `<div class="sec">${esc(word(m))} · ${ks.length}</div><div class="list">${ks.map(k =>
      ckRow(k.c, '📅 Check ' + everyWord(k.every) + (k.busy ? ' · job booked' : ''), shortDate(k.due))).join('')}</div>`).join('')
      : empty('Nobody has a regular check yet.'));
  }
  if (view === 'none'){
    const lastWord = c => { const d = g.last.get(c.id); return d ? 'Last job ' + shortDate(manilaDay(d)) + ' · ' + daysAgo(manilaDay(d)) : 'No job yet'; };
    return tabs + '<p class="hint">Tap a customer, then 📅 Regular check, to start one.</p>' +
      (g.none.length ? `<div class="list">${g.none.map(c => ckRow(c, lastWord(c))).join('')}</div>` : empty('Every customer has a regular check.'));
  }
  const list = g.due;
  return tabs + followupHtml() + (followups().length ? '<div class="sec">📅 Check-ups due</div>' : '') +
    (list.length ? `<div class="list">${list.map(checkupRow).join('')}</div>` : empty('Nobody is due for a check-up call.'));
}
/* A customer on a Check-ups list: the customer row's picture and line (ui.md, Reuse), what
   their check says, and the date on the right. Tap opens the customer, where 📅 Regular check is. */
function ckRow(c, line, side){
  return `<div class="lrow" role="button" tabindex="0" data-act="open" data-kind="customer" data-id="${esc(c.id)}" data-stamp="${esc(c.updated_at || '')}">
    ${custAvatar(c)}
    <div class="lrow-main"><div class="lrow-title">${esc(c.full_name)}${unsentPill(c.id)}</div>
      <div class="lrow-sub">${esc(line)}</div>
      <div class="lrow-sub cs">${custSub(c)}</div></div>
    ${side ? `<div class="lrow-side"><span class="lrow-price">${esc(side)}</span></div>` : ''}
  </div>`;
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
/* A customer's details — Add customer and Edit (53) draw the same boxes and check them the same way. */
function custFieldsHtml(p, dupWord){
  const w = BK_WORDS.panel;
  return bkInput('panel', p, 'full_name', w.name, '', 'maxlength="120" autocomplete="off"')
    + bkInput('panel', p, 'contact', 'Contact number', '', 'inputmode="tel" maxlength="30" autocomplete="off" placeholder="09XX XXX XXXX"', bkBookBtn('panel', p))
    + (p._dup ? `<div class="inline-note">Same number as <b>${esc(p._dup)}</b>. Tap Save again to ${dupWord}.</div>` : '')
    + bkInput('panel', p, 'address', 'Address', '', 'maxlength="300" autocomplete="off" placeholder="Street, barangay, city"')
    + bkInput('panel', p, 'landmark', 'Landmark', '— optional', 'maxlength="200" autocomplete="off" placeholder="beside the chapel, blue gate…"')
    + bkLocHtml('panel', p);
}
function custProblems(p){
  const bad = [];
  if ((p.full_name || '').trim().length < 2) bad.push(['full_name', 'Type the customer’s name.']);
  if (digits(p.contact).length < 7) bad.push(['contact', 'Type a contact number — at least 7 digits.']);
  if ((p.address || '').trim().length < 4) bad.push(['address', 'Type the address.']);
  return bad;
}
const custDetails = p => ({full_name: p.full_name.trim(), contact: p.contact.trim(), address: p.address.trim(),
  landmark: (p.landmark || '').trim(), lat: p.lat || null, lng: p.lng || null});
/* ✏️ Edit (Guile, 2026-10-12, 53): the name, the number, the address, the landmark, the pin —
   and the pictures, the same piece as the customer's file. The office only. */
function panelEditCust(p){
  const c = db.customers[p.id];
  if (!c || db.role !== 'admin') return {title: 'Edit customer', body: empty('This customer is no longer on this phone.')};
  if (!p._filled){
    Object.assign(p, {full_name: c.full_name || '', contact: c.contact || '', address: c.address || '', landmark: c.landmark || '',
      lat: c.lat != null ? String(c.lat) : '', lng: c.lng != null ? String(c.lng) : '', _filled: true});
  }
  return {title: 'Edit customer', sub: c.full_name, body: `<div class="card">${custFieldsHtml(p, 'save it anyway')}
      <div class="stack"><button type="button" class="b primary wide" data-act="saveeditcust" data-id="${esc(c.id)}">Save changes</button></div></div>
    ${custPicsHtml(c.id, c, true)}`};
}
function panelAddCust(p){
  const who = custFieldsHtml(p, 'add them anyway');
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
  const q = (p.q || '').trim(), res = custSearch(q);
  return (q && !res.exact && res.rows.length ? '<p class="count">No exact match — the closest:</p>' : '')
    + res.rows.slice(0, 8).map(({c, marks}) => `<div class="lrow" role="button" tabindex="0" data-act="pset" data-f="customer_id" data-v="${esc(c.id)}">
      ${custAvatar(c)}
      <div class="lrow-main"><div class="lrow-title">${markWords(c.full_name, marks)}</div><div class="lrow-sub cs">${custSub(c, marks)}</div></div></div>`).join('')
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
  // adding an aircon never moves the job's price (no price-list warning, 2026-10-11)
  p._priceNote = j.price == null || db.role === 'technician' ? ''
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
    <div class="menu"><button type="button" class="menu-row" data-act="usersmap">
      <span class="menu-ico">🗺️</span><span class="menu-main"><span class="menu-title">Who is where</span>
      <span class="menu-sub">${Object.values(db.places || {}).filter(p => p.lat != null).length} on the map · everyone with an account, never customers</span></span><span class="menu-chev">›</span></button></div>
    ${all.length > 6 ? `<input type="search" class="find" id="teamSearch" placeholder="🔎 Search ${all.length} people" value="${esc(ui.teamSearch || '')}" autocomplete="off">` : ''}
    <div id="teamList">${teamListHtml()}</div>`;
}
function teamRow(t){
  const off = t.active === false, waits = t.signup_kind === 'employee' && t.role === 'customer';
  const seen = seenWord(t.id);   // 56
  return `<div class="lrow${off ? ' off' : ''}" role="button" tabindex="0" data-act="open" data-kind="member" data-id="${esc(t.id)}" data-stamp="${esc(t.updated_at || '')}">
    ${avatarHtml(t.id, t.display_name || t.email)}
    <div class="lrow-main"><div class="lrow-title">${newDot(userUnseen(t))}${nameFx(t.display_name || (t.email || '').split('@')[0], t.id, 'users')}${unsentPill(t.id)}</div>
      <div class="lrow-sub">${esc(t.email || '')}</div>
      ${seen ? `<div class="lrow-sub${seen === 'Online' ? ' seen-on' : ''}">${esc(seen)}</div>` : ''}</div>
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
  return {title: t.display_name || (t.email || '').split('@')[0], sub: t.email,
    titleHtml: nameFx(t.display_name || (t.email || '').split('@')[0], t.id, 'users'), body: `
    ${['admin', 'technician', 'helper'].includes(t.role) && db.staff ? `<div class="face-head">${avatarHtml(t.id, t.display_name || t.email, 'huge')}${staffPhotoBtns(t.id)}</div>` : ''}
    <div class="card" data-row="${esc(t.id)}" data-stamp="${esc(t.updated_at || '')}">
      ${kv('Role', rolePill(t.role) + unsentPill(t.id) + (off ? ' <span class="tag bad">switched off</span>' : ''))}
      ${kv('Signed up as', t.signup_kind === 'employee' ? 'Says they work here' : 'Customer')}
      ${kv('Joined', esc(t.created_at ? new Date(t.created_at).toLocaleDateString('en-PH', {day: 'numeric', month: 'short', year: 'numeric'}) : '—'))}
      ${kv('Last online', esc(seenWord(t.id).replace(/^Last online /, '') || 'Not seen since this update'))}
      ${['admin', 'technician', 'helper'].includes(t.role) && db.role === 'admin' ? kv('Location', esc(locWhy(t.id) || 'On the map · ' + agoWord(db.places[t.id].at))
        + ((db.asked || {})[t.id] ? ' · asked ' + esc(agoWord(db.asked[t.id])) : '')
        + (me || !locWhy(t.id) ? '' : ` <button type="button" class="b" data-act="askloc" data-id="${esc(t.id)}">Ask again</button>`)) : ''}
    </div>
    ${inField(t.role) ? ckCardHtml(t, p) : ''}
    ${t.role === 'admin' ? `<div class="card row-between">
      <div class="lrow-main"><div class="menu-title">Sends texts to customers ${infoBtn('texter')}</div>
        <div class="sms-note">${textTexters().includes(t.id) ? 'Sees Texts to customers in Settings, 💬 Text on jobs and Text all.' : 'Sees none of the texting.'}</div></div>
      <div class="segment mini">${[[false, 'Off'], [true, 'On']].map(([v, l]) =>
        `<button type="button" class="${textTexters().includes(t.id) === v ? 'active' : ''}" data-act="texter" data-id="${esc(t.id)}" data-v="${v}">${l}</button>`).join('')}</div>
    </div>` : ''}
    ${t.role !== 'customer' && db.staff ? fxMemberHtml(t) : ''}
    ${t.role === 'technician' ? `<div class="card">
      <div class="menu-title">Share of each job ${infoBtn('share')}</div>
      <div class="share-row"><input data-pf="pct" inputmode="decimal" maxlength="6" value="${esc(p.pct != null ? p.pct : String(Number(t.share_pct ?? 10)))}" aria-label="Percent">
        <span class="share-pct">%</span>
        <button type="button" class="b primary" data-act="setshare" data-id="${esc(t.id)}">Save</button></div>
      <div class="sms-note">${esc('A ₱2,000 job gives ' + (t.display_name || 'them') + ' ' + peso0(2000 * Number(t.share_pct ?? 10) / 100) + '.')}</div>
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

/* Users → a technician or helper: their times as a month (56). A day with times is filled in;
   tap it for its list — the day's time in and out, each job's arrived and left. The office
   changes, removes or adds a time; every change is a line under it with the office's name. */
function ckCardHtml(t, p){
  const today = manilaDate(0), first = manilaDate(-100).slice(0, 7);
  const month = p.ckMonth && p.ckMonth <= today.slice(0, 7) && p.ckMonth >= first ? p.ckMonth : today.slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1)), days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const worked = new Set(ckRows(t.id).filter(k => !k.removed_at).map(k => k.day));
  const pick = p.ckDay || (worked.has(today) ? today : null);
  const cells = [];
  for (let i = 0; i < start.getUTCDay(); i++) cells.push('<span class="cal-pad"></span>');
  for (let d = 1; d <= days; d++){
    const ymd = month + '-' + String(d).padStart(2, '0');
    cells.push(`<button type="button" class="cal-day${worked.has(ymd) ? ' worked' : ''}${ymd === today ? ' today' : ''}${ymd === pick ? ' picked' : ''}"
      data-act="ckday" data-v="${ymd}" ${ymd > today ? 'disabled' : ''}>${d}</button>`);
  }
  const label = start.toLocaleDateString('en-PH', {month: 'long', year: 'numeric', timeZone: 'UTC'});
  return `<div class="card">
    <div class="row-between"><div class="menu-title">Check-ins ${infoBtn('checkin')}</div>
      <div class="cal-nav"><button type="button" class="b" data-act="ckmonth" data-v="-1" ${month > first ? '' : 'disabled'} aria-label="Month before">‹</button>
        <b>${esc(label)}</b><button type="button" class="b" data-act="ckmonth" data-v="1" ${month < today.slice(0, 7) ? '' : 'disabled'} aria-label="Next month">›</button></div></div>
    <div class="cal">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(x => `<span class="cal-head">${x}</span>`).join('')}${cells.join('')}</div>
    ${pick ? ckDayHtml(t, p, pick) : '<p class="hint">Filled in: a day with times. Tap one to see it.</p>'}
  </div>`;
}
function ckDayHtml(t, p, day){
  const rows = ckRows(t.id, day), own = rows.filter(k => !k.job_id), alive = own.filter(k => !k.removed_at), last = alive[alive.length - 1];
  const hist = k => (k.history || []).map(h => `<div class="sms-note">${esc(staffName(h.by))} ${
    h.undo ? 'undid the step' : !h.from ? 'added it' : !h.to ? 'took it off' : 'changed it'} ${
    esc(niceDate(manilaDay(h.at)))}${h.from && h.to ? ': ' + esc(clockOf(h.from)) + ' → ' + esc(clockOf(h.to)) : ''}</div>`).join('');
  const editor = (id, kind, at) => `<div class="share-row"><input type="time" data-pf="ckTime" value="${esc(p.ckTime != null ? p.ckTime : at ? new Date(at).toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Manila'}) : '')}" aria-label="Time">
      <button type="button" class="b primary" data-act="cksave" data-id="${esc(id)}" data-v="${kind}" data-day="${day}">Save</button>
      <button type="button" class="b" data-act="ckedit" data-id="">Cancel</button></div>`;
  const line = (k, label) => k.removed_at ? `<div class="lrow flat off">
      <div class="lrow-main"><div class="lrow-title"><s>${esc(label)} ${esc(clockOf(k.at))}</s> — taken off${unsentPill(k.id)}</div>${hist(k)}</div>
      <button type="button" class="b" data-act="ckback" data-id="${esc(k.id)}">Bring back</button></div>` : `<div class="lrow flat">
      <div class="lrow-main"><div class="lrow-title">${esc(label)} ${esc(clockOf(k.at))}${unsentPill(k.id)}${k.lat != null && k.lng != null
          ? ` <a target="_blank" rel="noopener" href="${esc('https://www.google.com/maps/search/?api=1&query=' + k.lat + ',' + k.lng)}">📍 where</a>` : ''}</div>
        ${k.by_uid && k.by_uid !== t.id && !(k.history || []).length ? `<div class="lrow-sub">by ${esc(staffName(k.by_uid))}</div>` : ''}${hist(k)}
        ${p.ckEdit === k.id ? editor(k.id, k.kind, k.at) : ''}</div>
      ${p.ckEdit === k.id ? '' : `<button type="button" class="b" data-act="ckedit" data-id="${esc(k.id)}">Edit</button>
        <button type="button" class="b danger" data-act="ckremove" data-id="${esc(k.id)}">Remove</button>`}</div>`;
  const jobs = [...new Set(rows.filter(k => k.job_id).map(k => k.job_id))];
  const add = !last ? 'in' : last.kind === 'in' ? 'out' : null;
  return `<div class="sec">${esc(niceDate(day))}</div>
    <div class="list ck-list">
      ${own.map(k => line(k, k.kind === 'in' ? 'Time in' : 'Time out')).join('')}
      ${jobs.map(jid => { const j = db.jobs[jid], name = j ? jobCust(j).full_name || 'A job' : 'A job no longer here';
        return rows.filter(k => k.job_id === jid).map(k => line(k, name + ' — ' + (k.kind === 'in' ? 'arrived' : 'left'))).join(''); }).join('')}
      ${!rows.length ? empty('No times this day.') : ''}
    </div>
    ${add ? (p.ckEdit === 'new' ? editor('new', add, null)
      : `<div class="stack"><button type="button" class="b wide" data-act="ckedit" data-id="new">＋ Add a time ${add}</button></div>`) : ''}`;
}

/* ---------------------------------------------------------------- the Admin tab */
function drawAdminTab(){
  // 54: one tab where Services & prices, Appliances and Specs were
  const secs = [['appliances', 'Appliances & services'], ['closed', 'Closed days'], ['shop', 'Shop'],
    ['photos', 'Page photos'], ['quote', 'Quotation'], ['billing', 'Billing statement'], ['report', 'Service report'], ['texts', 'Texts'], ['job', 'Job'],
    ['checkin', 'Check-in'], ['numbers', 'Numbers']];   // job: 41, checkin: 56, report: 57
  const v = secs.some(x => x[0] === ui.adminSec) ? ui.adminSec : 'appliances';
  return chips('adminsec', secs.map(([k, t]) => [k, t]), v) +
    ({appliances: drawAppliances, closed: drawClosed, shop: drawShop, photos: drawPagePhotos, billing: drawBillSample, quote: drawQuoteAdmin,
      report: drawReportAdmin, texts: drawTexts, job: drawJobMover, checkin: drawCheckinAdmin, numbers: drawNumbers})[v]();
}
/* Admin → Check-in (56): the office's switch. Off: a tap is enough and the phone never asks
   where it is. (The picture's switch comes with the picture.) */
function drawCheckinAdmin(){
  const on = !!(db.checkinRules || {}).require_location;
  return `<div class="card row-between">
      <div class="lrow-main"><div class="menu-title">Require location ${infoBtn('ckloc')}</div>
        <div class="sms-note">${on ? 'Each time in and out sends where the phone is. No location, no time.' : 'A tap is enough. The phone never asks where it is.'}</div></div>
      <div class="segment mini">${[[false, 'Off'], [true, 'On']].map(([v, l]) =>
        `<button type="button" class="${on === v ? 'active' : ''}" data-act="ckrule" data-v="${v}">${l}</button>`).join('')}</div></div>
    <p class="hint">Each person’s times: Users → tap a technician or a helper.</p>`;
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
/* Ideas 6 and 8: the shop's GCash for the billing statement, and its Facebook page for the booking page. */
/* Admin → Page photos (30, TODO 16): he adds and removes the photos at the top of the booking
   page. The phone shrinks each to 1600 px before sending; six at most. Needs signal to add. */
let pagePhotoBusy = false;
function drawPagePhotos(){
  const l = pagePhotos();
  return `<div class="card">
    <div class="menu-title">The photos at the top of the booking page ${infoBtn('pagephotos')}</div>
    ${l.length ? `<div class="pp-grid">${l.map((p, i) => `<div class="pp-item">
        <img src="${esc(pagePhotoUrl(p))}" alt="Page photo ${i + 1}" loading="lazy">
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
/* A picture in a person's circle (Guile, 2026-10-12, supabase/51): picked, fitted into the
   circle on the crop screen, 256 × 256, then only its path goes on the person. The office sets
   anyone's of the shop; each of the shop sets their own in Settings. */
document.addEventListener('change', async e => {
  const inp = e.target;
  if (!inp.matches || !inp.matches('input[data-staff-photo]')) return;
  const uid = inp.dataset.staffPhoto, file = inp.files && inp.files[0];
  inp.value = '';
  if (!file || !session) return;
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImg(url);
    openPanel({kind: 'ppcrop', for: 'face', uid, ratio: 1, url, w: img.naturalWidth, h: img.naturalHeight, zoom: 1, cx: .5, cy: .5});
  } catch (err) { URL.revokeObjectURL(url); notice('That file is not a picture.', true); }
});
const staffPhotoOf = uid => { const s = staffOf(uid), t = db && db.team && db.team[uid];
  return (s && s.photo) || (t && t.photo_path) || null; };
function setStaffPhoto(uid, path){
  write('set_staff_photo', {p_user: uid, p_path: path}, (path ? 'Picture — ' : 'Picture off — ') + (personName(uid) || staffName(uid)), [uid], db => {
    const s = (db.staff || []).find(x => x.id === uid); if (s) s.photo = path;
    if (db.team[uid]) db.team[uid].photo_path = path;
  });
  toast(path ? 'Picture saved — the shop sees it.' : 'Picture taken off.');
}
// the circle: their picture when they have one, else their initials, as before
function avatarHtml(uid, name, cls){
  const path = uid ? staffPhotoOf(uid) : null;
  return path ? `<div class="avatar face${cls ? ' ' + cls : ''}"><img data-house="${esc(path)}" data-bucket="staff-photos" alt="" draggable="false"></div>`
    : `<div class="avatar${cls ? ' ' + cls : ''}">${esc(initials(name))}</div>`;
}
// the two buttons under a big circle: change it, take it off
const staffPhotoBtns = uid => `<div class="row-gap face-btns"><label class="b">📷 ${staffPhotoOf(uid) ? 'Change the picture' : 'Add a picture'}<input type="file" accept="image/*" data-staff-photo="${esc(uid)}" hidden></label>
  ${staffPhotoOf(uid) ? `<button type="button" class="b" data-act="staffphotooff" data-id="${esc(uid)}">Take it off</button>` : ''}</div>`;
const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('not a picture')); i.src = src; });
/* Crop a page photo before it goes (Guile, 2026-09-28). The frame is 2 : 1 — a computer shows
   the photo in a band of ~2.6 : 1 (1366 × 520) and a phone in ~1.25 : 1 (375 × 300), the middle
   of the frame: the dashed box. Drag to move, the slider to zoom; "Use this photo" sends exactly
   the frame, 1600 × 800 at most (~200–300 KB). Sizes are fractions of the frame, so a redraw or
   a turned phone keeps the same crop. */
function ppGeom(p){
  const k = p.ratio || 2;   // the frame's width : height — 2 : 1, or 1 : 1 for a person's circle (51)
  const W = p.zoom * Math.max(1, (p.w / p.h) / k), H = k * W / (p.w / p.h);   // image size, in frames
  const at = v => Number.isFinite(v) ? v : .5;
  const cx = Math.min(1 - 1 / (2 * W), Math.max(1 / (2 * W), at(p.cx))), cy = Math.min(1 - 1 / (2 * H), Math.max(1 / (2 * H), at(p.cy)));
  return {W, H, cx, cy};
}
function ppStyle(p){
  const g = ppGeom(p);
  p.cx = g.cx; p.cy = g.cy;
  return `width:${(g.W * 100).toFixed(3)}%;left:${((.5 - g.cx * g.W) * 100).toFixed(3)}%;top:${((.5 - g.cy * g.H) * 100).toFixed(3)}%`;
}
/* The same crop screen takes the customer's signature on paper (47): the frame, then the ink. */
function panelPpcrop(p){
  if (p.for === 'face') return {title: 'Fit the picture', sub: personName(p.uid) || '', body: `
    <div class="pp-crop face" data-ppcrop><img src="${esc(p.url)}" alt="" draggable="false" style="${ppStyle(p)}"><div class="pp-circle"></div></div>
    <label class="pp-zoom">Zoom <input type="range" min="1" max="4" step="0.01" value="${esc(p.zoom)}" data-ppzoom aria-label="Zoom"></label>
    <p class="hint">Drag to move it, pinch or slide to zoom. What is inside the circle is the picture.</p>
    <div class="stack">${pagePhotoBusy ? '<span class="b wide" aria-busy="true">Sending the picture…</span>'
      : '<button type="button" class="b primary wide" data-act="ppuse">Use this picture</button>'}</div>`};
  const sig = p.for === 'sig', title = sig ? 'Crop the signature' : 'Crop the photo';
  if (!p.url) return {title, body: empty(sig ? 'Take the picture again.' : 'Pick the photo again — Admin → Page photos.')};
  return {title, sub: sig ? sigPaper(String(p.sig).split('|')[1]) : 'Page photo', info: sig ? '' : 'pagephotos', body: `
    <div class="pp-crop" data-ppcrop><img src="${esc(p.url)}" alt="" draggable="false" style="${ppStyle(p)}">
      ${sig ? '' : '<div class="pp-phone"><span>Phones show this part</span></div>'}</div>
    <label class="pp-zoom">Zoom <input type="range" min="1" max="4" step="0.01" value="${esc(p.zoom)}" data-ppzoom aria-label="Zoom"></label>
    <p class="hint">${sig ? 'Drag and zoom until the signature fills the frame. The white paper turns see-through; only the ink is kept.'
      : 'Drag the photo to move it. Computers show the whole frame; phones show the dashed part — keep what matters inside it.'}</p>
    ${sig ? `<label>Printed name <input data-pf="name" maxlength="80" value="${esc(p.name || '')}" autocomplete="off"></label>` : ''}
    <div class="stack">${pagePhotoBusy ? `<span class="b wide" aria-busy="true">${sig ? 'Making the signature…' : 'Sending photo…'}</span>`
      : `<button type="button" class="b primary wide" data-act="ppuse">${sig ? 'Use this signature' : 'Use this photo'}</button>`}</div>`};
}
let ppDrag = null;
// two fingers on the frame: pinch to zoom (2026-10-12) — the slider still works
const ppFingers = new Map();
let ppPinch = null;
document.addEventListener('pointerdown', e => {
  const box = e.target.closest && e.target.closest('[data-ppcrop]'), p = topPanel();
  if (!box || !p || p.kind !== 'ppcrop') return;
  ppFingers.set(e.pointerId, {x: e.clientX, y: e.clientY});
  try { box.setPointerCapture(e.pointerId); } catch (err) {}
  e.preventDefault();
  if (ppFingers.size === 2){
    const [a, b] = [...ppFingers.values()];
    ppPinch = {d: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: p.zoom}; ppDrag = null;
    return;
  }
  ppDrag = {id: e.pointerId, x: e.clientX, y: e.clientY};
});
document.addEventListener('pointermove', e => {
  const p = topPanel();
  if (ppPinch && ppFingers.has(e.pointerId) && p && p.kind === 'ppcrop'){
    ppFingers.set(e.pointerId, {x: e.clientX, y: e.clientY});
    const [a, b] = [...ppFingers.values()];
    p.zoom = Math.max(1, Math.min(4, ppPinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / ppPinch.d));
    const img = $('[data-ppcrop] img'), slider = $('[data-ppzoom]');
    if (img) img.setAttribute('style', ppStyle(p));
    if (slider) slider.value = p.zoom;
    return;
  }
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
['pointerup', 'pointercancel'].forEach(t => document.addEventListener(t, e => {
  ppFingers.delete(e.pointerId);
  if (ppFingers.size < 2) ppPinch = null;
  if (ppDrag && e.pointerId === ppDrag.id) ppDrag = null;
}));
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
    if (p.for === 'face'){ cv.width = cv.height = 256; }   // a person's circle (51): ~15 KB
    else { cv.width = Math.max(2, Math.min(1600, Math.round(sw))); cv.height = Math.round(cv.width / 2); }
    cv.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
    if (p.for === 'face'){
      const blob = await new Promise((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error('could not make the picture')), 'image/jpeg', .82));
      const path = 'staff/' + p.uid + '/' + await hashOf(blob) + '.jpg';
      const r = await storage('POST', path, blob, false, 'staff-photos');
      if (!r.ok && r.status !== 409){
        const b = await r.json().catch(() => ({}));
        if (!(r.status === 400 && /exist/i.test(b.message || b.error || ''))) throw new Error(b.message || b.error || 'HTTP ' + r.status);
      }
      await keepPhoto(path, blob);   // it shows at once, no download
      URL.revokeObjectURL(p.url); p.url = null;
      setStaffPhoto(p.uid, path);
      pagePhotoBusy = false; closePanel();
      return;
    }
    if (p.for === 'sig'){   // the customer's signature (47): the frame → the ink alone → the job
      const blob = await new Promise((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error('could not make the picture')), 'image/png'));
      const png = await inkOnly(blob), [jid, paper] = String(p.sig).split('|');
      URL.revokeObjectURL(p.url); p.url = null;
      closePanel();
      saveCustSig(jid, paper, png, p.name);
      return;
    }
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
      <div class="menu-title">GCash, on the billing statement ${infoBtn('shopgcash')}</div>
      ${field('gcash_number', 'GCash number', '09XX XXX XXXX', 'inputmode="tel" maxlength="20"')}
      ${field('gcash_name', 'Name on the account', 'e.g. J. Dela Cruz', 'maxlength="60"')}
      <div class="actions"><button type="button" class="b primary" data-act="saveshop" data-v="gcash">Save</button></div>
    </div>`;
}
const typeShort = k => k === 'Floor-mounted' ? 'Floor' : typeLabel(k);
/* Admin → Appliances & services (54; TODO2 items 1 and 5, Guile 2026-10-28): ONE tab where
   "Services & prices", "Appliances" and "Specs" were. The appliances in the owner's order, and
   open one: its types (½ hp, 1 hp…), its own services and prices, its specs. Every list is put
   in order by holding ⠿ and dragging (drag, below). */
const dragHandle = () => '<button type="button" class="drag-h" data-drag data-act="drag" aria-label="Hold and drag to change the order">⠿</button>';
const ownServices = t => svcRows().filter(s => s.unit_type === t);
function drawAppliances(){
  const set = db.settings || {}, all = typeRows(), shown = all.filter(t => t.active !== false), gone = all.filter(t => t.active === false);
  const sw = (act, on, title, info) => `<div class="card row-between">
      <div class="menu-title">${title} ${infoBtn(info)}</div>
      <div class="segment mini">${[[false, 'Off'], [true, 'On']].map(([v, t]) =>
        `<button type="button" class="${on === v ? 'active' : ''}" data-act="${act}" data-v="${v}">${t}</button>`).join('')}</div></div>`;
  const row = (t, dr) => { const n = ownServices(t.key).filter(s => s.active).length, v = activeVariants(t.key).length;
    return `<div class="lrow${t.active === false ? ' off' : ''}"${dr ? ` data-drag-row data-key="${esc(t.key)}"` : ''} role="button" tabindex="0" data-act="open" data-kind="utype" data-id="${esc(t.key)}">
      ${dr ? dragHandle() : ''}<img class="type-ico" src="${esc(typePic(t.key))}" alt="">
      <div class="lrow-main"><div class="lrow-title">${esc(t.label)}${unsentPill('type:' + t.key)}</div>
        <div class="lrow-sub">${esc((n ? n + (n === 1 ? ' service' : ' services') : 'No services yet') + (v ? ' · ' + v + (v === 1 ? ' type' : ' types') : ''))}</div></div>
      <div class="lrow-side">${t.active === false ? pill('off', 'Removed') : n ? pill('scheduled', 'On the page') : pill('off', 'Not on the page')}</div></div>`; };
  return sw('showprices', !!set.show_prices, 'Show prices on the booking page', 'showprices')
    + sw('showpricestech', !!set.show_prices_tech, 'Show prices to technicians &amp; helpers', 'showpricestech')
    + `<div class="card"><div class="menu-title">Aircon &amp; Other Appliances ${infoBtn('types')}</div>
      <p class="hint">What a customer taps on the booking page, in this order — hold ⠿ and drag to change it. Open one for its types, services, prices and specs.</p></div>
    <div class="list" data-drag-list="types">${shown.map(t => row(t, shown.length > 1)).join('')}</div>
    <div class="stack"><button type="button" class="b primary wide" data-act="open" data-kind="utype" data-id="">+ Add an appliance</button></div>
    ${gone.length ? `<div class="sec">Removed — tap one to bring it back</div><div class="list">${gone.map(t => row(t, false)).join('')}</div>` : ''}`;
}
// a list whose rows are dragged into order: only with two or more to order
const dragList = (what, rows, fn) => rows.length ? `<div class="list" data-drag-list="${esc(what)}">${rows.map(x => fn(x, rows.length > 1)).join('')}</div>` : '';
function panelUtype(p){
  const t = p.id ? typeOf(p.id) : null, k = t ? t.key : '';
  if (p.label == null){ p.label = t ? t.label : ''; p.icon = t ? t.icon : 'car-aircon'; }
  const own = p.icon && p.icon.startsWith('data:') ? [p.icon] : [];
  const vAll = t ? variantsOf(k) : [], vOn = vAll.filter(v => v.active !== false), vOff = vAll.filter(v => v.active === false);
  const fAll = t ? (db.unitFields || []).filter(f => (f.types || []).includes(k)) : [];
  const vPrice = (v, s) => !(v.services || []).includes(s) ? null : v.prices && v.prices[s] != null ? peso0(v.prices[s]) : '—';
  const vRow = (v, dr) => `<div class="lrow${v.active === false ? ' off' : ''}"${dr ? ` data-drag-row data-key="${esc(v.id)}"` : ''} role="button" tabindex="0" data-act="open" data-kind="variant" data-id="${esc(k + '|' + v.id)}">
      ${dr ? dragHandle() : ''}<div class="lrow-main"><div class="lrow-title">${esc(v.label)}</div>
      <div class="lrow-sub">${esc((v.services || []).map(s => svcLabel(s) + ' ' + vPrice(v, s)).join(' · ') || 'No services ticked')}</div></div>
      <span class="menu-chev">›</span></div>`;
  const sRow = (s, dr) => `<div class="lrow${s.active ? '' : ' off'}"${dr ? ` data-drag-row data-key="${esc(s.key)}"` : ''} role="button" tabindex="0" data-act="open" data-kind="service" data-id="${esc(s.key)}">
      ${dr ? dragHandle() : ''}<div class="lrow-main"><div class="lrow-title">${esc(s.label)}${unsentPill('svc:' + s.key)}</div>
      <div class="lrow-sub">${esc(vOn.length ? 'Price on each type' : s.prices && s.prices[k] != null ? peso0(s.prices[k]) : 'No price yet')}</div></div>
      <div class="lrow-side">${s.active ? pill('scheduled', 'On the page') : pill('off', 'Hidden')}</div></div>`;
  const fRow = (f, dr) => `<div class="lrow${f.removed ? ' off' : ''}"${dr ? ` data-drag-row data-key="${esc(f.key)}"` : ''} role="button" tabindex="0" data-act="open" data-kind="unitfield" data-id="${esc(f.key)}">
      ${dr ? dragHandle() : ''}<div class="lrow-main"><div class="lrow-title">${esc(f.label)}</div>
      <div class="lrow-sub">${esc([f.long ? 'bigger box' : 'one line', f.public ? 'on the booking page' : 'shop only', f.removed ? 'removed' : ''].filter(Boolean).join(' · '))}</div></div>
      <span class="menu-chev">›</span></div>`;
  const addBtn = (kind, words) => `<div class="stack"><button type="button" class="b wide" data-act="opennew" data-kind="${kind}" data-for="${esc(k)}">${words}</button></div>`;
  return {title: t ? t.label : 'New appliance', sub: 'Appliances & services', info: 'types', body: `
    ${t ? `<div class="sec">Types <span class="opt">— ½ hp, 1 hp… optional ${infoBtn('variant')}</span></div>
    ${dragList('variants:' + k, vOn, vRow)}${addBtn('variant', '+ Add a type')}
    ${vOff.length ? `<div class="fieldlabel">Removed types — tap one to bring it back</div><div class="list">${vOff.map(v => vRow(v, false)).join('')}</div>` : ''}
    <div class="sec">Services ${infoBtn('service')}</div>
    ${dragList('services:' + k, ownServices(k), sRow) || '<p class="hint">No services yet. It shows on the booking page once it has one.</p>'}
    ${addBtn('service', '+ Add a service')}
    <div class="sec">Specs <span class="opt">— your own boxes, under Additionals</span></div>
    ${dragList('specs:' + k, fAll.filter(f => !f.removed), fRow) || '<p class="hint">No boxes on this one.</p>'}
    ${fAll.some(f => f.removed) ? `<div class="list">${fAll.filter(f => f.removed).map(f => fRow(f, false)).join('')}</div>` : ''}
    ${addBtn('unitfield', '+ Add a box')}
    <div class="sec">Name and picture</div>` : ''}
    <label>Name <input data-pf="label" maxlength="40" value="${esc(p.label)}" placeholder="e.g. Chiller" autocomplete="off"></label>
    <div class="fieldlabel">Picture</div>
    <div class="icon-pick">${[...TYPE_ICONS, ...own].map(ic => `<button type="button" class="icon-opt${p.icon === ic ? ' active' : ''}" data-act="pset" data-f="icon" data-v="${esc(ic)}" aria-label="Picture ${esc(ic.startsWith('data:') ? 'of his own' : ic)}"><img src="${esc(ic.startsWith('data:') ? ic : 'icons/' + ic + '.png')}" alt=""></button>`).join('')}
      <label class="icon-opt icon-up">＋ Your own<input type="file" accept="image/png,image/*" data-typeicon hidden></label></div>
    <p class="hint">Your own: a PNG with a see-through background looks best. The phone shrinks it to 128 px.</p>
    <div class="stack"><button type="button" class="b primary wide" data-act="savetype" data-id="${esc(k)}">${t ? 'Save the name and picture' : 'Add it'}</button>
      ${!t ? '' : t.active === false
        ? `<button type="button" class="b wide" data-act="typeshow" data-id="${esc(k)}" data-v="1">Bring it back</button>`
        : `<button type="button" class="b danger wide" data-act="typeshow" data-id="${esc(k)}" data-v="0">Remove</button>`}</div>
    ${t ? '<p class="hint">Remove takes it off the booking page. Jobs that already have it keep it, and so do its services, types and prices — Bring it back puts everything back.</p>'
        : '<p class="hint">Then open it to add its services. It shows on the booking page once it has one.</p>'}`};
}
/* One write per change; the phone's copy is changed at once (write → applyLocal). */
function saveType(t, change, label){
  const next = {...t, ...change};
  write('save_unit_type', {p_key: t.key, p_label: next.label, p_icon: next.icon, p_active: next.active !== false, p_sort: next.sort},
    label, ['type:' + t.key], db => {
      if (!db.types || !db.types.length) db.types = BUILTIN_TYPES.map((x, n) => ({...x, active: true, sort: (n + 1) * 10}));
      const r = db.types.find(x => x.key === t.key); if (r) Object.assign(r, change);
      db.types.sort((a, b) => (a.sort || 0) - (b.sort || 0));
    });
}
/* An appliance's type (54): its name, the services it offers ticked, each at its own price. */
function panelVariant(p){
  const [k0, vid] = String(p.id || '').split('|'), k = p.for || k0, v = vid ? variantOf(k, vid) : null;
  if (p.label == null){
    Object.assign(p, {label: v ? v.label : '', vid: v ? v.id : uuid(), type: k, ticks: v ? [...(v.services || [])] : []});
    ownServices(k).forEach(s => { p['vp_' + s.key] = v && v.prices && v.prices[s.key] != null ? String(v.prices[s.key]) : ''; });
  }
  const svcs = ownServices(k).filter(s => s.active || p.ticks.includes(s.key));
  return {title: v ? v.label : 'New type', sub: typeLabel(k), info: 'variant', body: `
    <label>Name <input data-pf="label" maxlength="40" value="${esc(p.label)}" placeholder="½ hp, 1 hp, 2 hp…" autocomplete="off"></label>
    <div class="fieldlabel">Services it offers, and its price <span class="opt">— no price: you tell them on the call</span></div>
    ${svcs.map(s => { const on = p.ticks.includes(s.key);
      return `<div class="var-row"><button type="button" class="tab-btn${on ? ' active' : ''}" data-act="vartick" data-v="${esc(s.key)}">${on ? '✓ ' : ''}${esc(s.label)}</button>
        ${on ? `<span class="peso-in"><i>₱</i><input data-pf="vp_${esc(s.key)}" inputmode="decimal" value="${esc(p['vp_' + s.key] || '')}" placeholder="—" aria-label="${esc(s.label)} price"></span>` : ''}</div>`; }).join('')
      || '<p class="hint">This appliance has no services yet. Add them first, under Services.</p>'}
    <div class="stack"><button type="button" class="b primary wide" data-act="savevariant">${v ? 'Save' : 'Add it'}</button>
      ${v ? `<button type="button" class="b wide${v.active === false ? '' : ' danger'}" data-act="savevariant" data-v="${v.active === false ? 'back' : 'remove'}">${v.active === false ? 'Bring it back' : 'Remove'}</button>` : ''}</div>
    ${v && v.active !== false ? '<p class="hint">Remove takes it off the booking page. Jobs that already have it keep it.</p>' : ''}`};
}
/* A service is one appliance's own (54): its name, its price there — or on each type, when the
   appliance has types — shown or hidden, and what to bring. */
function panelService(p){
  const r = p.id ? svcRows().find(x => x.key === p.id) : null, own = r ? r.unit_type : p.for;
  if (p.label == null){
    p.label = r ? r.label : ''; p.active = r && !r.active ? '0' : '1';
    p.check = r ? checklistOf(r.key) : []; p.check0 = JSON.stringify(p.check);   // 37
    p.price = r && own && r.prices && r.prices[own] != null ? String(r.prices[own]) : '';
  }
  const vs = own ? activeVariants(own) : [], start = starterOf(p);
  const onType = v => !r || !(v.services || []).includes(r.key) ? 'not offered' : v.prices && v.prices[r.key] != null ? peso0(v.prices[r.key]) : '—';
  return {title: r ? r.label : 'New service', sub: own ? typeLabel(own) : 'Service', info: 'service', body: `
    <label>Name <input data-pf="label" maxlength="60" value="${esc(p.label)}" placeholder="Freon recharge"></label>
    ${!own ? '<p class="hint">A service from before each appliance had its own. Old jobs keep it.</p>'
      : vs.length ? `<div class="fieldlabel">Price <span class="opt">— on each type</span></div>
        <p class="hint">${esc(vs.map(v => v.label + ' ' + onType(v)).join(' · '))}</p>
        <p class="hint">Open a type to tick this service on it and give its price.</p>`
      : `<div class="price-grid"><label class="price-cell"><span>Price — ${esc(typeLabel(own))}</span>
        <span class="peso-in"><i>₱</i><input data-pf="price" inputmode="decimal" value="${esc(p.price)}" placeholder="—"></span></label></div>`}
    <div class="fieldlabel">On the booking page</div>
    <div class="segment">${[['1', 'Shown'], ['0', 'Hidden']].map(([k, t]) =>
      `<button type="button" class="${p.active === k ? 'active' : ''}" data-act="pset" data-f="active" data-v="${k}">${t}</button>`).join('')}</div>
    <div class="fieldlabel">🧰 What to bring <span class="opt">— technicians and helpers tick it on every job with this service</span></div>
    <div class="card prep">
      ${p.check.map((t, i) => `<div class="prep-row"><span class="prep-main"><span class="prep-text">${esc(t)}</span></span>
        <button type="button" class="cart-x" data-act="chkx" data-i="${i}" aria-label="Take ${esc(t)} off the list">×</button></div>`).join('')
        || `<p class="hint">Nothing yet.${start ? '' : ' Add what the team must not forget.'}</p>`}
      ${!p.check.length && start ? `<button type="button" class="b" data-act="chkstarter">Start from our usual list (${start.length})</button>` : ''}
      <div class="prep-add"><input data-pf="chkNew" maxlength="60" value="${esc(p.chkNew || '')}" placeholder="Wire tester, electrical tape…" autocomplete="off">
        <button type="button" class="b" data-act="chkadd">＋ Add</button></div>
    </div>
    <div class="stack"><button type="button" class="b primary wide" data-act="saveservice">Save</button></div>`};
}
// the usual list a copied service started from (54: "split_clean_…" keeps "clean"'s)
const starterOf = p => { const r = p.id && svcRows().find(x => x.key === p.id); return STARTER_LISTS[(r && r.origin) || p.id] || null; };

/* ---------------------------------------------------------------- drag into order (54)
   A list data-drag-list="what", its rows data-drag-row data-key, each with a ⠿ handle
   (data-drag). Pointer events, so a finger works as a mouse does; the handle has
   touch-action: none, so holding it does not scroll the page. The others slide aside to show
   the gap; on the drop, dragDone writes the new order once.
   shortcut: no scrolling while a row is held — fine for lists of a screen or two; add an
   edge scroll if a list ever grows past that. */
document.addEventListener('pointerdown', e => {
  const h = e.target.closest && e.target.closest('[data-drag]'); if (!h || e.button > 0) return;
  const row = h.closest('[data-drag-row]'), list = row && row.parentElement;
  if (!list || !list.dataset.dragList) return;
  e.preventDefault();
  const rows = [...list.children].filter(r => r.hasAttribute('data-drag-row')), boxes = rows.map(r => r.getBoundingClientRect());
  const i0 = rows.indexOf(row), step = rows.length > 1 ? Math.abs(boxes[1].top - boxes[0].top) - boxes[0].height : 0;
  drag = {list, row, rows, boxes, i0, to: i0, y0: e.clientY, id: e.pointerId, shift: boxes[i0].height + step};
  try { h.setPointerCapture(e.pointerId); } catch (x) {}
  row.classList.add('dragging');
});
document.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.id) return;
  const {rows, boxes, i0} = drag, dy = e.clientY - drag.y0, mid = boxes[i0].top + boxes[i0].height / 2 + dy;
  let to = 0;
  boxes.forEach((b, i) => { if (i !== i0 && mid > b.top + b.height / 2) to++; });
  drag.to = to;
  drag.row.style.transform = `translateY(${dy}px)`;
  rows.forEach((r, i) => { if (i === i0) return;
    const s = i0 < to && i > i0 && i <= to ? -drag.shift : i0 > to && i >= to && i < i0 ? drag.shift : 0;
    r.style.transform = s ? `translateY(${s}px)` : ''; });
});
function dragEnd(e){
  if (!drag || e.pointerId !== drag.id) return;
  const {list, rows, i0, to} = drag;
  rows.forEach(r => { r.style.transform = ''; r.classList.remove('dragging'); });
  drag = null;
  if (to !== i0 && e.type === 'pointerup'){
    const keys = rows.map(r => r.dataset.key), [k] = keys.splice(i0, 1);
    keys.splice(to, 0, k);
    dragDone(list.dataset.dragList, keys);
  }
  if (dragAgain){ dragAgain = false; render(); }
}
document.addEventListener('pointerup', dragEnd);
document.addEventListener('pointercancel', dragEnd);
// the new order: 10, 20, 30… on the server (set_order), and on this phone at once
function dragDone(what, keys){
  const [kind, scope] = what.split(':'), n = new Map(keys.map((k, i) => [k, (i + 1) * 10]));
  const bySort = (a, b) => (a.sort || 0) - (b.sort || 0) || String(a.label).localeCompare(String(b.label));
  if (kind === 'specs'){   // his boxes are one list: these change places among themselves
    const all = [...(db.unitFields || [])], at = all.map((f, i) => n.has(f.key) ? i : -1).filter(i => i >= 0);
    const byKey = new Map(all.map(f => [f.key, f]));
    at.forEach((i, j) => { all[i] = byKey.get(keys[j]); });
    write('set_unit_fields', {p_fields: all}, 'Specs — order', ['unitfields'], db => { db.unitFields = all; });
    return;
  }
  const words = {types: 'appliances', services: 'services — ' + typeLabel(scope), variants: 'types — ' + typeLabel(scope)}[kind];
  write('set_order', {p_what: kind, p_keys: keys}, 'Order — ' + words, [kind === 'services' ? 'svc:order' : 'type:order'], db => {
    if (kind === 'types') (db.types || []).forEach(t => { if (n.has(t.key)) t.sort = n.get(t.key); });
    if (kind === 'services') (db.services || []).forEach(s => { if (n.has(s.key)) s.sort = n.get(s.key); });
    if (kind === 'variants') variantsOf(scope).forEach(v => { if (n.has(v.id)) v.sort = n.get(v.id); });
    (db.types || []).sort(bySort);
    (db.services || []).sort(bySort);
    const t = (db.types || []).find(x => x.key === scope); if (t && t.variants) t.variants.sort(bySort);
  });
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

/* ---------------------------------------------------------------- a job's lines (was the receipt)
   Each aircon's services at the price list's price; the total is the job's own frozen price, and
   any difference is an adjustment. The texts' {appliances} and {price}, and the CSV's number,
   come from here; the paper is the billing statement now (45). */
function receiptOf(j){
  const c = jobCust(j), b = j.booking_id && db.bookings[j.booking_id];
  const units = unitsOf(j), names = unitNames(units);
  const lines = units.flatMap((u, i) => u.services.map(k => ({unit: names[i], label: svcLabel(k), type: u.type || '—',
    amount: u.type ? officePrice(k, u.type, u.variant) : null})));
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
const qtLongDate = ymd => ymd ? new Date(ymd + 'T00:00:00').toLocaleDateString('en-US', {month: 'long', day: 'numeric', year: 'numeric'}) : '';
const qtNoteHtml = q => { const note = String(q.note || '').split('\n').filter(x => x.trim());
  return note.length ? `<div class="qt-note">Note:<ul>${note.map(x => `<li${/^\s/.test(x) ? ' class="qt-in"' : ''}>${esc(x.trim())}</li>`).join('')}</ul></div>` : ''; };
/* The letterhead: logo | the shop's words | his QR (2026-09-28) — the quotation's and the
   billing statement's (45). */
function qtHeadHtml(s){
  return `<div class="qt-head"><img class="qt-logo" src="img/winter-air-logo.png" alt="">
      <div class="qt-lh"><div class="qt-name">${esc(s.name)}</div>
        ${s.tagline ? `<div class="qt-tag">${esc(s.tagline)}</div>` : ''}
        ${s.address ? `<div>${esc(s.address)}</div>` : ''}
        ${s.contact ? `<div class="qt-s">${esc(s.contact)}</div>` : ''}
        ${s.tin ? `<div class="qt-s">${esc(s.tin)}</div>` : ''}</div>
      <img class="qt-qr" src="img/quote-qr.png" alt="QR code: the shop's Facebook page"></div>`;
}
function quoteHtml(q){
  if (q.bill) return billHtml(q);
  const s = quoteShop(), sig = quoteSig(), total = qtTotal(q.lines);
  const longDate = qtLongDate;
  const note = String(q.note || '').split('\n').filter(x => x.trim());
  return `<div class="quote">
    ${q.sample ? '<div class="rc-sample">SAMPLE</div>' : ''}
    ${qtHeadHtml(s)}
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
    <div class="qt-conf"><div>Conforme: <span class="ln${q.csig ? ' signed' : ''}" style="width:320px">${q.csig
        ? `<img class="csig" src="${esc(q.csig.png)}" alt="">${esc(q.csig.name || '')}` : ''}</span><small>Signature over Printed Name &amp; Title</small></div>
      <div>Date: ${q.csig ? `<span class="ln signed" style="width:170px">${esc(qtLongDate(manilaDay(q.csig.at)))}</span>` : '<span class="ln" style="width:170px"></span>'}</div></div>
  </div>`;
}
/* The Billing Statement (the owner via Guile, 2026-10-10, 45), replacing the receipt — a
   receipt is for shops and food; a service is billed. The quotation's paper: the same
   letterhead, table, note and signature; q.bill carries what the job says (billMeta). Not an
   official receipt until the BIR question is answered. */
function billHtml(q){
  const s = quoteShop(), sig = quoteSig(), total = qtTotal(q.lines), m = q.bill;
  return `<div class="quote bill">
    ${q.sample ? '<div class="rc-sample">SAMPLE</div>' : ''}
    ${qtHeadHtml(s)}
    <div class="bl-title">BILLING STATEMENT</div>
    <div class="bl-meta">
      <div><div class="bl-label">Bill to</div><b>${esc(m.name || '')}</b>
        ${q.to_address ? `<div class="qt-to" style="margin:0">${esc(q.to_address)}</div>` : ''}${m.contact ? `<div>${esc(m.contact)}</div>` : ''}</div>
      <table class="bl-facts"><tr><td>Statement No.</td><td><b>${esc(m.no || '')}</b></td></tr>
        <tr><td>Date</td><td>${esc(qtLongDate(q.date))}</td></tr>
        ${m.service ? `<tr><td>Service date</td><td>${esc(m.service)}</td></tr>` : ''}
        ${m.units && !(m.aircons || []).length ? `<tr><td>Units</td><td>${esc(m.units)}</td></tr>` : ''}</table>
    </div>
    ${(m.aircons || []).length ? `<div class="bl-units"><div class="bl-label">Appliances</div>${m.aircons.map(a =>
      `<div>${esc(a.name)}${a.meta ? ' — ' + esc(a.meta) : ''}${a.serial ? `<small>S/N ${esc(a.serial)}</small>` : ''}</div>`).join('')}</div>` : ''}
    <div class="qt-subj">SUBJECT: ${esc(q.subject || '')}</div>
    ${q.salutation ? `<div class="qt-dear">${esc(q.salutation)}</div>` : ''}
    <p class="qt-p">Please find below the statement of charges for the labor, materials and services rendered by ${esc(SHOP_SHORT)}:</p>
    <table class="qt-table">
      <thead><tr><th style="width:6%">#</th><th>Description of Labor, Materials and Services</th><th style="width:9%">Qty.</th><th style="width:14%">Unit Price</th><th style="width:19%">Amount</th></tr></thead>
      <tbody>${q.lines.map((l, i) => `<tr><td class="qt-c">${i + 1}</td><td>${esc(l.text || '')}</td><td class="qt-c">${l.qty != null ? esc(String(l.qty)) : '—'}</td>
        <td class="qt-c">${l.price != null ? esc(qtNum(l.price)) : '—'}</td><td class="qt-r">${qtAmount(l) != null ? esc(qtMoney(qtAmount(l))) : '—'}</td></tr>`).join('')}</tbody>
      <tfoot><tr class="qt-tot"><td colspan="4" class="qt-r">TOTAL AMOUNT DUE</td><td class="qt-r">${total != null ? 'PHP ' + esc(qtMoney(total)) : '—'}</td></tr></tfoot>
    </table>
    ${m.paid ? `<div class="bl-paid">PAID — ${esc(m.paid)}</div>`
      : m.gcash ? `<div class="rc-gcash bl-gcash"><img src="img/gcash-qr.png" alt="" data-gone-if-missing>
        <div>Pay by GCash: <b>${esc(m.gcash.number)}</b>${m.gcash.name ? '<br>' + esc(m.gcash.name) : ''}</div></div>` : ''}
    ${qtNoteHtml(q)}
    <div class="bl-sign">
      <div><div>Prepared by:</div>
        ${sig ? `<img class="qt-sig" src="${esc(sig)}" alt="">` : '<div class="qt-sigspace"></div>'}
        <div class="bl-ln"><b>${esc(s.signer || '')}</b></div>${s.title ? `<div>${esc(s.title)}</div>` : ''}<div>${esc(s.name)}</div></div>
      <div><div>Received by:</div>${q.csig ? `<img class="qt-sig" src="${esc(q.csig.png)}" alt="">` : '<div class="qt-sigspace"></div>'}
        <div class="bl-ln">${q.csig && q.csig.name ? `<b>${esc(q.csig.name)}</b><br>` : ''}Signature over Printed Name</div>
        <div>Date: ${q.csig ? esc(qtLongDate(manilaDay(q.csig.at))) : '<span class="ln" style="width:150px"></span>'}</div></div>
    </div>
    <div class="bl-foot">Thank you for choosing ${esc(SHOP_NAME)}. This is not an official receipt.</div>
  </div>`;
}
/* What the job says on its billing statement, at the moment it is drawn. */
function billMeta(j){
  const c = jobCust(j), b = bookingOfJob(j), set = (db && db.settings) || {}, us = unitsOf(j), names = unitNames(us);
  return {no: b ? b.ref : j.booking_ref || 'J-' + String(j.id).slice(0, 6).toUpperCase(),
    name: c.full_name || '', contact: c.contact || '', units: unitsLine(us) || '',
    // each appliance: brand · model, the serial small (Guile, 2026-10-11)
    aircons: us.map((u, i) => ({name: names[i], meta: [u.brand, u.model].map(x => String(x || '').trim()).filter(Boolean).join(' · '),
      serial: String(u.serial || '').trim()})),
    service: j.scheduled_on ? niceDate(j.scheduled_on) + ', ' + slotWord(j.slot) : '',
    paid: j.paid_method ? PAY[j.paid_method] + (j.paid_at ? ', ' + qtLongDate(manilaDay(j.paid_at)) : '') : '',
    gcash: set.gcash_number ? {number: set.gcash_number, name: set.gcash_name || ''} : null};
}

/* ---------------------------------------------------------------- the customer's signature (47)
   Guile, 2026-10-11: the customer signs the job's billing statement and its quotation — drawn
   on the phone, or a picture of it on white paper, cropped. The office or a technician takes
   it, a helper never. pull carries only the stamp (j.signed); the picture comes once from
   job_signatures and is kept on this phone, the last 30 (~20 KB each). */
const SIG_PAPERS = {quote: 'Quotation', bill: 'Billing statement'};
const sigPaper = k => SIG_PAPERS[k] || (/^r:/.test(k || '') ? 'Service report' : '');   // 57: 'r:' + the report's id
let csigs = null;
const csigAsking = {};
const csigStore = () => csigs || (csigs = lsGet('ws_csig', {}));
function csigKeep(key, v){
  const s = csigStore();
  s[key] = {...v, kept: Date.now()};
  Object.keys(s).sort((a, b) => s[b].kept - s[a].kept).slice(30).forEach(k => { delete s[k]; });
  lsSet('ws_csig', s);
}
const canSign = j => !!j && !!db && ['admin', 'technician'].includes(db.role) && viewRole() !== 'helper' && j.status !== 'cancelled';
// the quotation only when the job has one; a technician is told so by has_quote (47)
const signPapers = j => (j.quote || j.has_quote ? ['quote'] : []).concat(['bill']);
const signWords = j => signPapers(j).map(k => SIG_PAPERS[k] + (j.signed && j.signed[k] ? ' ✓ signed' : ' — not signed')).join(' · ');
function custSig(j, paper){
  const st = j && j.signed && j.signed[paper];
  if (!st || !db || !['admin', 'technician'].includes(db.role)) return null;
  const have = csigStore()[j.id + '|' + paper];
  if (have && have.at === st.at) return have;
  if (online && session && !csigAsking[j.id]){
    csigAsking[j.id] = true;
    rpc('job_signatures', {p_job: j.id}).then(r => {
      Object.keys(r || {}).forEach(k => {
        const now = j.signed && j.signed[k];
        if (r && r[k] && now) csigKeep(j.id + '|' + k, {at: now.at, png: r[k].png, name: r[k].name || ''});
      });
      render();
    }).catch(() => {}).finally(() => { setTimeout(() => { delete csigAsking[j.id]; }, 30000); });
  }
  return null;
}
function saveCustSig(jid, paper, png, name){
  const j = db.jobs[jid]; if (!j) return;
  const at = new Date().toISOString(), nm = String(name || '').trim().slice(0, 80);
  csigKeep(jid + '|' + paper, {at, png, name: nm});
  write('sign_job', {p_job: jid, p_paper: paper, p_png: png, p_name: nm || null},
    'Signature on the ' + sigPaper(paper).toLowerCase() + ' — ' + (jobCust(j).full_name || 'job'), [jid],
    () => { j.signed = {...(j.signed || {}), [paper]: {at, name: nm || null}}; });
  toast('Signature saved on the ' + sigPaper(paper).toLowerCase() + '.');
}
function panelJobSign(p){
  const j = db.jobs[p.id];
  if (!j) return {title: 'Customer’s signature', body: empty('This job is no longer on this phone.')};
  if (!canSign(j)) return {title: 'Customer’s signature', body: empty('This job is cancelled: there is nothing to sign.')};
  return {title: 'Customer’s signature', sub: jobCust(j).full_name || '', body: signPapers(j).map(k => {
    const st = j.signed && j.signed[k], s = st ? custSig(j, k) : null, id = esc(j.id + '|' + k);
    return `<div class="sec">${k === 'bill' ? '🧾' : '📄'} ${esc(SIG_PAPERS[k])}</div><div class="card">
      ${st ? `<div class="sig-show">${s ? `<img src="${esc(s.png)}" alt="The customer’s signature">`
          : `<span class="muted">${online ? 'Getting the signature…' : 'The signature shows when there is signal.'}</span>`}</div>
        <p class="hint">Signed ${esc(niceDate(manilaDay(st.at)))}${st.name ? ' · ' + esc(st.name) : ''}${unsentPill(j.id)}</p>`
        : '<p class="hint">Not signed yet.</p>'}
      <div class="actions"><button type="button" class="b${st ? '' : ' primary'}" data-act="open" data-kind="sigdraw" data-id="${id}">✍️ ${st ? 'Sign again' : 'Draw signature'}</button>
        <label class="b">📷 Picture on white paper<input type="file" accept="image/*" data-csig-photo="${id}" hidden></label>
        ${st && p.ask !== k ? `<button type="button" class="b danger" data-act="sigoff" data-id="${id}">Take it off</button>` : ''}</div>
      ${st && p.ask === k ? `<div class="inline-note"><span>Take the customer’s signature off the ${esc(SIG_PAPERS[k].toLowerCase())}?</span>
        <button type="button" class="b danger" data-act="sigoffyes" data-id="${id}">Take it off</button>
        <button type="button" class="b" data-act="sigoffno">Keep it</button></div>` : ''}</div>`;
  }).join('') + '<p class="hint">It goes on the paper: Print, Send as PDF and Send as Word.</p>'};
}

/* ---------------------------------------------------------------- the service report (57)
   Guile, 2026-10-30: his paper Service report (№ 2012, on a done job of 2026-10-10) in the app,
   one per appliance, filled in by a technician or the office and changed like the quotation.
   Kept on the job (jobs.reports, its own copy of the appliance); the № is the shop's own,
   given by the server on the first save. The customer signs it as the other papers (47). */
const REPORT_ITEMS = ['Cleaning of air dust filter.', 'Cleaning of cooling coil/ condenser coil/ evaporator coil.',
  'Cleaning of drain pan, flooring and blower fan.', 'Flushing of condensate pan, p-trap and floor drain.',
  'Cleaning of cover and exterior panel.', 'Checking of blower and motor pulley, align if necessary.',
  'Checking of bearing or bushing, lubricate if necessary.', 'Checking for sign of water leakage at cooling coil, valves and fittings.',
  'Straightening of cooling coil fins.', 'Checking and retightening of screws and mounting bolts.',
  'Checking noise level of the blower and motor.', 'Verifying of refrigerant charge.',
  'Safety checking of all operating controls.', 'Verifying amperage and electrical connections.'];
const REPORT_NOTE = 'I hereby certify that the work performed above has been done satisfactorily completed & agree to the recommendation.';
const reportItems = () => { const l = (db.settings || {}).report_items; return Array.isArray(l) && l.length ? l : REPORT_ITEMS; };
const reportNote = () => { const n = (db.settings || {}).report_note; return typeof n === 'string' ? n : REPORT_NOTE; };
const reportsOf = j => (j && Array.isArray(j.reports) ? j.reports : []);
const canReport = j => canSign(j);   // the office and technicians, never a helper; a job until it is cancelled
const reportNo = r => r && r.no ? '№ ' + r.no : '№ given when it is sent';
// the ticks on the paper: the owner's list, and any ticked on an older list
const reportTicks = r => { const l = reportItems(); return l.concat((r.ticks || []).filter(t => !l.includes(t))); };
/* A saved report names its own appliance too (its brand and model, from its own copy).
   shortcut: a report knows its appliance by its place in the job's list, so taking an
   appliance off shifts the ones after it; this name shows which one the paper is about.
   Upgrade: give each appliance on a job its own id. */
const reportName = (j, r, unit) => (unitNames(unitsOf(j))[unit] || 'an appliance no longer on the job')
  + (r && (r.brand || r.model) ? ' · ' + [r.brand, r.model].filter(Boolean).join(' ') : '');
/* The job's rows: each appliance's report, or one to make. */
function reportRows(j){
  const us = unitsOf(j), names = unitNames(us), rs = reportsOf(j), out = [];
  const row = r => menuRow('jobreport', j.id + '|' + r.id, '📋', 'Service report — ' + reportName(j, r, r.unit),
    reportNo(r) + ' · saved ' + niceDate(manilaDay(r.saved_at)));
  us.forEach((u, i) => {
    const mine = rs.filter(r => r.unit === i);
    mine.forEach(r => out.push(row(r)));
    if (!mine.length && canReport(j)) out.push(menuRow('jobreport', j.id + '|new:' + i, '📋', 'Service report — ' + names[i], 'Not made yet'));
  });
  rs.filter(r => r.unit >= us.length).forEach(r => out.push(row(r)));
  return out.join('');
}
/* The screen's job and report: p.id is "job|report id", or "job|new:2" for the third appliance's. */
function reportFind(p){
  const [jid, key] = String(p.id || '').split('|'), j = db.jobs[jid];
  if (!j) return {};
  if (!p.rid){ if (/^new:\d+$/.test(key || '')){ p.rid = uuid(); p.unit = Number(key.slice(4)); } else p.rid = key; }
  const saved = reportsOf(j).find(r => r.id === p.rid) || null;
  if (saved) p.unit = saved.unit;
  return {j, saved};
}
/* A new one starts from the job: its day, the customer, the appliance, the crew. */
function reportStart(j, unit, saved){
  if (saved) return {...saved, kind: saved.kind || '', call: saved.call || '', served_on: saved.served_on || '', ticks: [...(saved.ticks || [])]};
  const c = jobCust(j), u = unitsOf(j)[unit] || {}, day = j.scheduled_on || manilaDate(0);
  const crew = (j.crew && j.crew.length ? j.crew : j.assigned_uid ? [j.assigned_uid] : []).map(staffName);
  return {date: day, client: c.full_name || '', location: c.address || '', kind: '', brand: u.brand || '',
    capacity: [(variantOf(u.type, u.variant) || {}).label, u.type ? typeLabel(u.type) : ''].filter(Boolean).join(' '),
    model: u.model || '', serial: u.serial || '', ticks: [], others: '', call: '', findings: '',
    served_by: crew.join(', '), served_on: j.done_at ? manilaDay(j.done_at) : day};
}
const reportView = (j, p, saved) => ({...p.r, no: saved ? saved.no : null, csig: custSig(j, 'r:' + p.rid)});
function reportHtml(r){
  // the left column one longer, as his paper (8 and 6, Others under the right one)
  const s = quoteShop(), box = on => on ? '☑' : '☐', items = reportTicks(r), half = Math.ceil((items.length + 1) / 2);
  const tick = t => `<div class="rp-tick"><span>${box((r.ticks || []).includes(t))}</span><span>${esc(t)}</span></div>`;
  const ln = (label, v) => `<div class="rp-f"><span>${label}:</span><b>${esc(v || '')}</b></div>`;
  return `<div class="quote report">
    ${r.sample ? '<div class="rc-sample">SAMPLE</div>' : ''}
    ${qtHeadHtml(s)}
    <div class="rp-top"><div class="rp-title">SERVICE REPORT</div><div class="rp-no">№ ${esc(r.no ? String(r.no) : '')}</div></div>
    <div class="rp-facts">
      <div>${ln('Date', r.date ? qtLongDate(r.date) : '')}${ln('Client’s Name', r.client)}${ln('Location', r.location)}
        <div class="rp-kind">${box(r.kind === 'res')} Residential <span class="rp-gap"></span>${box(r.kind === 'com')} Commercial</div></div>
      <div>${ln('Brand', r.brand)}${ln('Capacity and Type', r.capacity)}${ln('Model', r.model)}${ln('Serial Number', r.serial)}</div>
    </div>
    <div class="rp-h">Detailed Scope of Service. <span>Tick all that apply:</span></div>
    <div class="rp-ticks"><div>${items.slice(0, half).map(tick).join('')}</div>
      <div>${items.slice(half).map(tick).join('')}<div class="rp-tick"><span>${box(!!r.others)}</span><span class="rp-other">Others, Specify: <u>${esc(r.others || '')}</u></span></div></div></div>
    <div class="rp-h">Technical Findings or General Remarks &amp; Recommendation:</div>
    <div class="rp-kind">${box(r.call === 'service')} Service Call <span class="rp-gap"></span>${box(r.call === 'maintenance')} Maintenance Call</div>
    <div class="rp-find">${esc(r.findings || '')}</div>
    <div class="rp-sign">
      <div><div class="rp-f"><span>Serviced by:</span><b>${esc(r.served_by || '')}</b></div>
        <div class="rp-f"><span>Date:</span><b>${esc(r.served_on ? qtLongDate(r.served_on) : '')}</b></div></div>
      <div><p class="rp-cert">${esc(reportNote())}</p>
        ${r.csig ? `<img class="qt-sig" src="${esc(r.csig.png)}" alt="">` : '<div class="qt-sigspace"></div>'}
        <div class="bl-ln">${r.csig && r.csig.name ? `<b>${esc(r.csig.name)}</b><br>` : ''}Client’s Name and Signature</div></div>
    </div>
  </div>`;
}
function reportSample(){
  const l = reportItems();
  return {sample: true, no: Number((db.settings || {}).report_next) || 1, date: manilaDate(0), client: 'ZZ Sample Customer',
    location: 'ZZ Street 1, ZZ Barangay, Bacolod City', kind: 'res', brand: 'ZZ Brand', capacity: '1 hp Split', model: 'ZZ-25',
    serial: 'ZZ0000001', ticks: l.slice(0, 3), others: '', call: 'maintenance', findings: 'ZZ Cleaned and tested. Running well.',
    served_by: 'ZZ Technician', served_on: manilaDate(0)};
}
function panelReport(p){
  const {j, saved} = reportFind(p);
  if (!j) return {title: 'Service report', body: empty('This job is no longer on this phone.')};
  if (!p.r) p.r = reportStart(j, p.unit, saved);
  const open = canReport(j), sub = (jobCust(j).full_name || '') + ' · ' + reportName(j, saved, p.unit);
  const said = saved ? esc(reportNo(saved) + ' · saved ' + timeAgo(saved.saved_at) + (saved.saved_by_name ? ' by ' + saved.saved_by_name : '')) + unsentPill(j.id)
    : 'Not saved yet';
  const btns = `<button type="button" class="b${open ? '' : ' primary'} wide" data-act="printreport">🖨️ Print or save as PDF</button>
    <button type="button" class="b wide" data-act="sharereport">📤 Send as PDF — Messenger, email…</button>`;
  if (!open) return {title: 'Service report', sub, info: 'report', body: `
    ${paperBox(reportHtml(reportView(j, p, saved)), 'reportPreview')}
    <p class="hint">${said}. ${j.status === 'cancelled' ? 'The job is cancelled, so it stays as it was.' : 'Only the office or a technician changes it.'}</p>
    <div class="stack">${btns}</div>`};
  const f = (k, label, max, ph) => `<label>${label} <input data-rf="${k}" maxlength="${max}" value="${esc(p.r[k] || '')}"${ph ? ` placeholder="${esc(ph)}"` : ''} autocomplete="off"></label>`;
  const seg = (k, opts) => `<div class="segment mini">${opts.map(([v, l]) =>
    `<button type="button" class="${p.r[k] === v ? 'active' : ''}" data-act="repseg" data-id="${k}" data-v="${v}">${l}</button>`).join('')}</div>`;
  // the customer's signature: on a saved report only — the server signs a report it has
  const paper = 'r:' + p.rid, st = j.signed && j.signed[paper], cs = st ? custSig(j, paper) : null, sid = esc(j.id + '|' + paper);
  const sign = saved ? `<div class="sec">✍️ Customer’s signature</div><div class="card">
      ${st ? `<div class="sig-show">${cs ? `<img src="${esc(cs.png)}" alt="The customer’s signature">`
          : `<span class="muted">${online ? 'Getting the signature…' : 'The signature shows when there is signal.'}</span>`}</div>
        <p class="hint">Signed ${esc(niceDate(manilaDay(st.at)))}${st.name ? ' · ' + esc(st.name) : ''}</p>` : '<p class="hint">Not signed yet.</p>'}
      <div class="actions"><button type="button" class="b${st ? '' : ' primary'}" data-act="open" data-kind="sigdraw" data-id="${sid}">✍️ ${st ? 'Sign again' : 'Draw signature'}</button>
        <label class="b">📷 Picture on white paper<input type="file" accept="image/*" data-csig-photo="${sid}" hidden></label>
        ${st && p.ask !== paper ? `<button type="button" class="b danger" data-act="sigoff" data-id="${sid}">Take it off</button>` : ''}</div>
      ${st && p.ask === paper ? `<div class="inline-note"><span>Take the customer’s signature off the service report?</span>
        <button type="button" class="b danger" data-act="sigoffyes" data-id="${sid}">Take it off</button>
        <button type="button" class="b" data-act="sigoffno">Keep it</button></div>` : ''}</div>`
    : '<p class="hint">Save it first; then the customer can sign it.</p>';
  return {title: 'Service report', sub, info: 'report', body: `
    ${paperBox(reportHtml(reportView(j, p, saved)), 'reportPreview')}
    <p class="hint">${said}. Tap the page to see it full size.</p>
    <label>Date <input type="date" data-rf="date" value="${esc(p.r.date || '')}"></label>
    ${f('client', 'Client’s name', 120)}
    <label>Location <textarea data-rf="location" rows="2" maxlength="300">${esc(p.r.location || '')}</textarea></label>
    <div class="row-between rp-seg"><span class="fieldlabel">The place</span>${seg('kind', [['res', 'Residential'], ['com', 'Commercial']])}</div>
    ${f('brand', 'Brand', 80)}${f('capacity', 'Capacity and type', 80, 'e.g. 2 hp Split')}${f('model', 'Model', 80)}${f('serial', 'Serial number', 80)}
    <div class="fieldlabel">Detailed scope of service — tick all that apply</div>
    <div class="rp-checks">${reportTicks(p.r).map(t => `<label class="tick"><input type="checkbox" data-rtick="${esc(t)}" ${p.r.ticks.includes(t) ? 'checked' : ''}> ${esc(t)}</label>`).join('')}</div>
    ${f('others', 'Others, specify', 200)}
    <div class="row-between rp-seg"><span class="fieldlabel">The call</span>${seg('call', [['service', 'Service call'], ['maintenance', 'Maintenance call']])}</div>
    <label>Findings, remarks and recommendation <textarea data-rf="findings" rows="4" maxlength="2000">${esc(p.r.findings || '')}</textarea></label>
    ${f('served_by', 'Serviced by', 160)}
    <label>Serviced on <input type="date" data-rf="served_on" value="${esc(p.r.served_on || '')}"></label>
    <div class="stack"><button type="button" class="b primary wide" data-act="savereport">Save the service report</button>
      ${btns}</div>
    ${sign}
    ${saved && db.role === 'admin' ? '<div class="stack"><button type="button" class="b danger wide" data-act="delreport">Take this service report off</button></div>' : ''}`};
}
/* Typing redraws the page beside the boxes, never the box being typed in (ui.md). */
function drawReportPreview(p){
  const w = $('#reportPreview'), {j, saved} = reportFind(p);
  if (w && j) w.firstElementChild.innerHTML = reportHtml(reportView(j, p, saved));
  fitQuotes();
}
function saveReport(){
  const p = topPanel(); if (!p || p.kind !== 'jobreport' || !p.r) return false;
  const {j, saved} = reportFind(p);
  if (!canReport(j)){ toast('Only the office or a technician changes a service report.', true); return false; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.r.date || '')){ toast('Choose the date. Nothing was saved.', true); return false; }
  const x = p.r, r = {id: p.rid, unit: p.unit, date: x.date, client: x.client || '', location: x.location || '', kind: x.kind || '',
    brand: x.brand || '', capacity: x.capacity || '', model: x.model || '', serial: x.serial || '', ticks: x.ticks.slice(),
    others: x.others || '', call: x.call || '', findings: x.findings || '', served_by: x.served_by || '', served_on: x.served_on || ''};
  const v = (saved && saved.v) || 0, jid = j.id;
  write('save_service_report', {p_job: jid, p_report: r, p_based_on: v}, 'Service report — ' + (jobCust(j).full_name || 'job'), [jid], db => {
    const jj = db.jobs[jid]; if (!jj) return;
    const row = {...r, kind: r.kind || null, call: r.call || null, served_on: r.served_on || null, no: saved ? saved.no : null, v: v + 1,
      saved_at: new Date().toISOString(), saved_by_name: (db.profile || {}).display_name || ''};
    jj.reports = reportsOf(jj).some(y => y.id === r.id) ? reportsOf(jj).map(y => y.id === r.id ? row : y) : reportsOf(jj).concat([row]);
  });
  p.dirty = false;
  toast(saved ? 'Service report saved.' : 'Service report saved. Its number comes from the office’s server when it is sent.');
  render();
  return true;
}
// what is on the paper is what is saved: a changed (or never saved) report saves first
function reportPaper(share){
  const p = topPanel();
  if (!p || p.kind !== 'jobreport') return printHtml(reportHtml(reportSample()), 'Service report sample', share);
  const {j, saved} = reportFind(p); if (!j) return;
  if (canReport(j) && (p.dirty || !saved) && !saveReport()) return;
  const now = reportFind(p).saved;
  printHtml(reportHtml(reportView(j, p, now)), 'Service report ' + (now && now.no ? now.no + ' ' : '') + (jobCust(j).full_name || ''), share);
}
/* Admin → Service report: the ticks, the certify line, where the numbers start, the sample. */
function drawReportAdmin(){
  const set = db.settings || {};
  return `<p class="hint">The letterhead and the QR are the quotation’s — change them in Admin → Quotation. ${infoBtn('reportadmin')}</p>
    <div class="card"><div class="menu-title">The next number</div>
      <div class="share-row"><input data-k="rp_next" inputmode="numeric" maxlength="7" value="${esc(set.report_next != null ? String(set.report_next) : '')}" placeholder="e.g. 2013" aria-label="The next number">
        <button type="button" class="b primary" data-act="savereportset" data-id="report_next">Save</button></div>
      <p class="hint">The next report made takes it; then it counts up by itself. A number is never given twice.</p></div>
    <div class="card"><div class="menu-title">The ticks</div>
      <label><span class="opt">One per line, in the paper’s order</span><textarea data-k="rp_items" rows="10" maxlength="6000">${esc(reportItems().join('\n'))}</textarea></label>
      <div class="actions"><button type="button" class="b primary" data-act="savereportset" data-id="report_items">Save</button></div></div>
    <div class="card"><div class="menu-title">The line over the client’s signature</div>
      <textarea data-k="rp_note" rows="3" maxlength="500" aria-label="The line over the client’s signature">${esc(reportNote())}</textarea>
      <div class="actions"><button type="button" class="b primary" data-act="savereportset" data-id="report_note">Save</button></div></div>
    ${paperBox(reportHtml(reportSample()))}
    <div class="stack"><button type="button" class="b primary wide" data-act="printreport">🖨️ Print the sample (A4)</button></div>`;
}

/* The pen, as on Guile's Mi Canvas (measured on his Pad 6: the fountain pen at Stroke width 15,
   Sensitivity 50%, Tip size 2, Opacity 100%): Fountain or Ballpoint, the four sliders, kept
   on this phone. A stylus gives its real pressure; a finger has none, so Sensitivity reads the
   speed instead — fast is thin, as ink runs. The fountain's nib is held at 45°: thin along it,
   full across it; Tip size is how thin its edge is (5 = round). */
const PEN0 = {pen: 'fountain', width: 6, sens: 50, tip: 2, opacity: 100};
const penSet = {...PEN0, ...lsGet('ws_pen', {})};
const PEN_RANGE = {width: [1, 30, 'Stroke width', v => v], sens: [0, 100, 'Sensitivity', v => v + '%'],
  tip: [1, 5, 'Tip size', v => v], opacity: [10, 100, 'Opacity', v => v + '%']};
const SIG_H = 0.4;   // the pad is 5 : 2; points are kept as fractions of its width
function panelSigDraw(p){
  const [jid, paper] = String(p.id || '').split('|'), j = db.jobs[jid];
  if (!j || !sigPaper(paper)) return {title: 'Signature', body: empty('This job is no longer on this phone.')};
  if (!p.strokes){ p.strokes = []; p.name = (j.signed && j.signed[paper] && j.signed[paper].name) || jobCust(j).full_name || ''; }
  const none = p.strokes.length ? '' : ' disabled';
  return {title: 'Draw the signature', sub: sigPaper(paper) + ' · ' + (jobCust(j).full_name || ''), body: `
    <div class="sig-pad"><canvas data-sigpad aria-label="Sign here"></canvas><div class="sig-line"><span>✕</span></div></div>
    <div class="actions sig-tools">
      ${['fountain', 'ballpoint'].map(k => `<button type="button" class="b${penSet.pen === k ? ' primary' : ''}" data-act="sigpen" data-v="${k}">${k === 'fountain' ? '🖋️ Fountain pen' : '🖊️ Ballpoint'}</button>`).join('')}
      <button type="button" class="b" data-act="sigundo"${none}>↶ Undo</button>
      <button type="button" class="b" data-act="sigclear"${none}>Clear</button></div>
    <div class="sig-sliders">${Object.entries(PEN_RANGE).filter(([k]) => k !== 'tip' || penSet.pen === 'fountain').map(([k, [lo, hi, label, show]]) => `<label class="sig-slider">
      <span>${label}</span><b data-penshow="${k}">${esc(show(penSet[k]))}</b>
      <input type="range" min="${lo}" max="${hi}" step="1" value="${penSet[k]}" data-pen="${k}" aria-label="${label}"></label>`).join('')}</div>
    <label>Printed name <input data-pf="name" maxlength="80" value="${esc(p.name)}" autocomplete="off"></label>
    <div class="stack"><button type="button" class="b primary wide" data-act="sigsave"${none}>Save the signature</button></div>`};
}
// one stroke at full ink on a layer of its own, then laid down at its opacity: the overlapping
// dabs of a see-through pen would otherwise show as dark beads
let sigLayer = null;
function sigStroke(cx, s, W){
  const H = cx.canvas.height;
  if (!sigLayer) sigLayer = document.createElement('canvas');
  if (sigLayer.width !== cx.canvas.width || sigLayer.height !== H){ sigLayer.width = cx.canvas.width; sigLayer.height = H; }
  const L = sigLayer.getContext('2d');
  L.clearRect(0, 0, sigLayer.width, H);
  L.fillStyle = L.strokeStyle = '#111'; L.lineCap = L.lineJoin = 'round';
  const pts = s.pts.map(q => ({x: q.x * W, y: q.y * W, w: Math.max(0.6, q.w * W)}));
  const mid = (a, b) => ({x: (a.x + b.x) / 2, y: (a.y + b.y) / 2});
  if (pts.length === 1){ L.beginPath(); L.arc(pts[0].x, pts[0].y, pts[0].w / 2, 0, Math.PI * 2); L.fill(); }
  for (let i = 1; i < pts.length; i++){
    const a = pts[i - 1], b = pts[i], m0 = i > 1 ? mid(pts[i - 2], a) : a, m1 = i === pts.length - 1 ? b : mid(a, b);
    L.lineWidth = (a.w + b.w) / 2;
    L.beginPath(); L.moveTo(m0.x, m0.y); L.quadraticCurveTo(a.x, a.y, m1.x, m1.y); L.stroke();
  }
  cx.globalAlpha = (s.opacity || 100) / 100; cx.drawImage(sigLayer, 0, 0); cx.globalAlpha = 1;
}
function sigPaint(cv, strokes){
  const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  if (!r.width) return;
  const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
  if (cv.width !== W || cv.height !== H){ cv.width = W; cv.height = H; }
  const cx = cv.getContext('2d');
  cx.clearRect(0, 0, W, H);
  strokes.forEach(s => sigStroke(cx, s, W));
}
function drawSigPads(){
  const p = topPanel(), cv = p && p.kind === 'sigdraw' && $('[data-sigpad]');
  if (cv) sigPaint(cv, p.strokes || []);
}
/* The strokes → a PNG of the ink alone, cropped to it: ~10–30 KB; the server takes 120 KB. */
function sigPng(strokes){
  for (const side of [900, 600, 420]){
    const cv = document.createElement('canvas'); cv.width = side; cv.height = Math.round(side * SIG_H);
    const cx = cv.getContext('2d');
    strokes.forEach(s => sigStroke(cx, s, side));
    const px = cx.getImageData(0, 0, cv.width, cv.height).data;
    let x0 = cv.width, y0 = cv.height, x1 = -1, y1 = -1;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 8){ const k = (i - 3) / 4, x = k % cv.width, y = (k - x) / cv.width;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return '';
    const pad = 6, k = Math.min(1, 600 / (x1 - x0 + 1 + pad * 2)), out = document.createElement('canvas');
    out.width = Math.round((x1 - x0 + 1 + pad * 2) * k); out.height = Math.round((y1 - y0 + 1 + pad * 2) * k);
    out.getContext('2d').drawImage(cv, x0 - pad, y0 - pad, x1 - x0 + 1 + pad * 2, y1 - y0 + 1 + pad * 2, 0, 0, out.width, out.height);
    const png = out.toDataURL('image/png');
    if (png.length <= 110000) return png;
  }
  return '';
}
let sigDrag = null;
function sigAdd(e, cv){
  const r = cv.getBoundingClientRect(), d = sigDrag;
  if (!r.width || !d) return;
  const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.width, t = e.timeStamp, prev = d.last;
  if (prev && Math.hypot(x - prev.x, y - prev.y) < 0.002) return;
  let pr;   // 0 light … 1 hard
  if (e.pointerType === 'pen' && e.pressure > 0) pr = e.pressure;
  else if (!prev) pr = 0.5;
  else pr = Math.max(0, Math.min(1, 1 - Math.hypot(x - prev.x, y - prev.y) / Math.max(1, t - prev.t) * 1000 / 3));   // 3 pad widths a second = lightest
  const sens = penSet.sens / 100, fountain = d.s.pen === 'fountain';
  let f = 1 + sens * (pr - 0.5) * (fountain ? 1.6 : 0.4);
  if (fountain && prev){ const edge = penSet.tip / 5;
    f *= edge + (1 - edge) * Math.abs(Math.sin(Math.atan2(y - prev.y, x - prev.x) - Math.PI / 4)); }
  if (fountain && d.s.pts.length < 4) f *= 0.55 + d.s.pts.length * 0.15;   // the ink starts thin
  let w = Math.max(0.0015, penSet.width / 400 * f);
  if (d.w != null) w = d.w * 0.6 + w * 0.4;   // no sudden steps
  d.w = w; d.last = {x, y, t};
  d.s.pts.push({x: Math.round(x * 1e4) / 1e4, y: Math.round(y * 1e4) / 1e4, w: Math.round(w * 1e5) / 1e5});
}
document.addEventListener('pointerdown', e => {
  const cv = e.target.closest && e.target.closest('[data-sigpad]'), p = topPanel();
  if (!cv || !p || p.kind !== 'sigdraw') return;
  e.preventDefault();
  // a slider or the name box keeping the focus would hold every redraw back (keepTyping)
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  try { cv.setPointerCapture(e.pointerId); } catch (err) {}
  const s = {pen: penSet.pen, opacity: penSet.opacity, pts: []};
  p.strokes.push(s);
  sigDrag = {id: e.pointerId, s, last: null, w: null};
  sigAdd(e, cv); sigPaint(cv, p.strokes);
});
let sigFrame = 0;
document.addEventListener('pointermove', e => {
  const p = topPanel();
  if (!sigDrag || e.pointerId !== sigDrag.id || !p || p.kind !== 'sigdraw') return;
  const cv = $('[data-sigpad]'); if (!cv) return;   // the pad on screen NOW: a sync redraw replaces it
  const all = e.getCoalescedEvents ? e.getCoalescedEvents() : [];   // the in-between points, when the phone gives them
  (all.length ? all : [e]).forEach(ev => sigAdd(ev, cv));
  if (!sigFrame) sigFrame = requestAnimationFrame(() => { sigFrame = 0; const c = $('[data-sigpad]'); if (c) sigPaint(c, p.strokes); });
});
['pointerup', 'pointercancel'].forEach(t => document.addEventListener(t, e => {
  if (!sigDrag || e.pointerId !== sigDrag.id) return;
  const pts = sigDrag.s.pts;
  if (sigDrag.s.pen === 'fountain') pts.slice(-3).forEach((q, i) => { q.w = Math.round(q.w * [0.85, 0.65, 0.45][i + 3 - Math.min(3, pts.length)] * 1e5) / 1e5; });   // and ends thin
  sigDrag = null;
  render();   // Undo, Clear and Save wake up
}));
document.addEventListener('input', e => {
  const t = e.target, k = t.dataset && t.dataset.pen;
  if (!k || !PEN_RANGE[k]) return;
  penSet[k] = Number(t.value);
  lsSet('ws_pen', penSet);
  const b = $(`[data-penshow="${k}"]`); if (b) b.textContent = PEN_RANGE[k][3](penSet[k]);
});
// a picture of the signature on white paper: first the crop screen, then the ink alone (inkOnly)
document.addEventListener('change', async e => {
  const inp = e.target;
  if (!inp.matches || !inp.matches('input[data-csig-photo]')) return;
  const file = inp.files && inp.files[0], id = inp.dataset.csigPhoto;
  inp.value = '';
  if (!file || !session) return;
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImg(url), [jid, paper] = id.split('|'), j = db.jobs[jid];
    openPanel({kind: 'ppcrop', for: 'sig', sig: id, url, w: img.naturalWidth, h: img.naturalHeight, zoom: 1, cx: .5, cy: .5,
      name: (j && j.signed && j.signed[paper] && j.signed[paper].name) || (j ? jobCust(j).full_name : '') || ''});
  } catch (err) { URL.revokeObjectURL(url); notice('That file is not a picture.', true); }
});

let qtFull = false;
const paperBox = (html, id) => `<div class="qt-wrap${qtFull ? ' full' : ''}"${id ? ` id="${id}"` : ''} data-act="qtzoom"
  title="${qtFull ? 'Tap to fit the screen' : 'Tap to see it full size'}"><div class="qt-scale">${html}</div></div>`;
const quoteBox = (q, id) => paperBox(quoteHtml(q), id);
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
    const key = k + '|' + (u.type || '') + '|' + (u.variant || ''), r = m.get(key);   // 54: and its type
    if (r) r.qty++; else m.set(key, {k, type: u.type, variant: u.variant, qty: 1});
  }));
  return [...m.values()].map(r => {
    const pr = r.type ? officePrice(r.k, r.type, r.variant) : null, vl = (variantOf(r.type, r.variant) || {}).label;
    // "Repair of Split Type Aircon"; an appliance that is not one of the four, by its own name
    const what = !r.type ? 'Aircon' : BUILTIN_TYPES.some(b => b.key === r.type) ? typeLabel(r.type) + ' Type Aircon' : typeLabel(r.type);
    return {text: svcLabel(r.k) + ' of ' + what + (vl ? ' (' + vl + ')' : ''), qty: String(r.qty), price: pr != null ? String(pr) : ''};
  });
}
/* Where a quotation lives: a New booking (the Inbox), or a job until it is Done (26). A
   job's starts from its booking's, when it had one. Saving a job's sets its price. */
function quoteSrc(p){
  // the billing statement (45): the job's, saved on it; it starts from the job's quotation
  if (p.kind === 'jobbill'){
    const j = db.jobs[p.id]; if (!j) return null;
    const b = bookingOfJob(j), c = jobCust(j), m = billMeta(j);
    return {row: j, job: true, bill: true, name: c.full_name || '', ref: m.no,
      open: db.role === 'admin' && j.status !== 'cancelled', state: (STATUS_LABEL[j.status] || j.status).toLowerCase(),
      saved: j.billing, start: j.billing || j.quote || (b && b.quote) || null, address: c.address || '', units: unitsOf(j),
      fn: 'save_job_bill', arg: 'p_job', field: 'billing', word: 'billing statement', title: 'Billing statement'};
  }
  if (p.kind === 'jobquote'){
    const j = db.jobs[p.id]; if (!j) return null;
    const b = bookingOfJob(j), c = jobCust(j);
    return {row: j, job: true, name: c.full_name || '', ref: b ? b.ref : 'J-' + String(j.id).slice(0, 6).toUpperCase(),
      // a technician reads it (47, with prices shown); only the office changes it
      open: db.role === 'admin' && ['booked', 'scheduled', 'in_progress'].includes(j.status), state: (STATUS_LABEL[j.status] || j.status).toLowerCase(),
      saved: j.quote, start: j.quote || (b && b.quote) || null, address: c.address || '', units: unitsOf(j),
      fn: 'save_job_quote', arg: 'p_job', field: 'quote', word: 'quotation', title: 'Quotation'};
  }
  const b = db.bookings[p.id]; if (!b) return null;
  return {row: b, job: false, name: b.full_name, ref: b.ref, open: b.status === 'new', state: b.status,
    saved: b.quote, start: b.quote, address: b.address || '', units: unitsOf(b), fn: 'save_quote', arg: 'p_booking',
    field: 'quote', word: 'quotation', title: 'Quotation'};
}
/* What the screen edits: strings, as typed. */
function quoteStart(src){
  const q = src.start;
  // a billing statement taken from the quotation is dated the day it is made (45)
  const date = q && !(src.bill && !src.saved) ? q.date : manilaDate(0);
  if (q) return {date, to_address: q.to_address || '', salutation: q.salutation || '', subject: q.subject || '',
    note: q.note || '', lines: (q.lines || []).map(l => ({text: l.text, qty: String(l.qty), price: String(l.price)}))};
  const set = db.settings || {}, lines = quoteLinesFrom(src.units);
  // no quotation to start from: the price list's lines, and the job's own price where it differs
  if (src.bill && src.row.price != null){
    const sum = qtTotal(quoteView({lines}).lines), diff = sum != null ? Math.round((Number(src.row.price) - sum) * 100) / 100 : null;
    // (a price under the list's shows in the hint under the page: a line cannot be below zero)
    if (diff > 0) lines.push({text: 'Other charges', qty: '1', price: String(diff)});
  }
  return {date, to_address: src.address, salutation: 'Dear ' + src.name + ',',
    subject: 'ACU ' + unionServices(src.units).map(svcLabel).join(' & ').toUpperCase(),
    note: set.quote_note != null ? set.quote_note : QUOTE_NOTE, lines};
}
/* The page as drawn: the typed copy, and for a billing statement what the job says. */
const docView = (p, src) => ({...quoteView(p.q), bill: src && src.bill ? billMeta(src.row) : null,
  csig: src && src.job ? custSig(src.row, src.bill ? 'bill' : 'quote') : null});   // the customer's signature (47)
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
  const src = quoteSrc(p), bill = p.kind === 'jobbill';
  if (!src) return {title: bill ? 'Billing statement' : 'Quotation', body: empty('This ' + (p.kind === 'quote' ? 'booking' : 'job') + ' is no longer on this phone.')};
  if (!p.q) p.q = quoteStart(src);
  const open = src.open, saved = src.saved, sub = src.name + ' · ' + src.ref;
  const said = saved ? esc('Saved ' + timeAgo(saved.saved_at) + (saved.saved_by_name ? ' by ' + saved.saved_by_name : '')) + unsentPill(src.row.id)
    : bill ? (src.start ? 'From the quotation — add any extra work, then save' : 'Not saved yet')
    : src.start ? 'From the booking’s quotation — not saved on the job yet' : 'Not saved yet';
  // Send as PDF (TODO 13): in the app, the paper as a file straight to the share sheet; on the
  // website there is no file maker, so it opens the print screen like the button above it
  const printBtn = `<button type="button" class="b${open ? '' : ' primary'} wide" data-act="printquote">🖨️ Print or save as PDF</button>
    <button type="button" class="b wide" data-act="sharequote">📤 Send as PDF — Messenger, email…</button>
    ${src.ref ? '<button type="button" class="b wide" data-act="wordquote">📝 Send as Word (.docx)</button>' : ''}`;   // 39
  if (!open) return {title: src.title, sub, info: bill ? 'bill' : 'quote', body: `
    ${quoteBox(docView(p, src), 'quotePreview')}
    <p class="hint">${said}. ${bill ? (db.role === 'admin' ? 'The job is cancelled: nothing to bill.' : 'Only the office changes it.')
      : db.role !== 'admin' ? 'Only the office changes it.' : `The ${src.job ? 'job' : 'booking'} is ${esc(src.state)}, so the quotation stays as it was.`}</p>
    <div class="stack">${printBtn}</div>`};
  const tot = qtTotal(quoteView(p.q).lines);
  const priceHint = src.job ? `<p class="hint">Saving it makes the job’s price its TOTAL${src.row.price != null ? ' (now ' + esc(peso(src.row.price)) + ')' : ''}.</p>` : '';
  return {title: src.title, sub, info: bill ? 'bill' : 'quote', body: `
    ${quoteBox(docView(p, src), 'quotePreview')}
    <p class="hint">${said}. Tap the page to see it full size.</p>
    <label>Date <input type="date" data-qf="date" value="${esc(p.q.date)}"></label>
    <label>Address <textarea data-qf="to_address" rows="2" maxlength="300">${esc(p.q.to_address)}</textarea></label>
    <label>Greeting <input data-qf="salutation" maxlength="160" value="${esc(p.q.salutation)}" autocomplete="off"></label>
    <label>Subject <input data-qf="subject" maxlength="150" value="${esc(p.q.subject)}" autocomplete="off"></label>
    <div class="fieldlabel">${bill ? 'Labor, materials and services — add the extra work: piping, wires, parts' : 'Supply of Labor, Materials and Services'}</div>
    ${p.q.lines.map((l, i) => `<div class="qt-line">
      <textarea data-ql="${i}:text" rows="2" maxlength="200" aria-label="Line ${i + 1}">${esc(l.text)}</textarea>
      <div class="qt-nums"><label class="qty">Qty <input data-ql="${i}:qty" inputmode="numeric" maxlength="3" value="${esc(l.qty)}"></label>
        <label>Unit price <span class="peso-in"><i>₱</i><input data-ql="${i}:price" inputmode="decimal" maxlength="14" value="${esc(l.price)}" placeholder="—"></span></label>
        <button type="button" class="b danger" data-act="qtline" data-v="del" data-i="${i}" aria-label="Remove line ${i + 1}">✕</button></div>
    </div>`).join('')}
    <div id="qtTotal" class="qt-total">${tot != null ? 'TOTAL ' + esc(peso(tot)) : 'TOTAL — a price is missing'}</div>
    <div class="actions"><button type="button" class="b" data-act="qtline" data-v="add">+ Add a line</button>
      <button type="button" class="b" data-act="qtfill">↺ Lines from the ${bill ? 'job' : 'booking'}</button></div>
    <label>Note <span class="opt">— one point per line; start a line with a space to indent it</span>
      <textarea data-qf="note" rows="6" maxlength="3000">${esc(p.q.note)}</textarea></label>
    ${priceHint}
    <div class="stack"><button type="button" class="b primary wide" data-act="savequote">Save the ${src.word}</button>
      ${printBtn}</div>`};
}
/* Typing redraws the page and the total only, never the box being typed in (ui.md). */
function drawQuotePreview(p){
  const w = $('#quotePreview');
  if (w) w.firstElementChild.innerHTML = quoteHtml(docView(p, quoteSrc(p)));
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
/* Admin → Billing statement: the sample, from the same letterhead and signature (45). */
function billSample(){
  const q = quoteSample();
  return {...q, subject: q.subject, lines: q.lines.concat([{text: 'ZZ Copper pipe, per foot (extra work)', qty: 10, price: 150}]),
    bill: {no: 'WA-0000', name: 'ZZ Sample Customer', contact: '0999 000 0000', units: '2 Split', service: niceDate(manilaDate(0)) + ', morning',
           aircons: [{name: 'Split #1', meta: 'ZZ Brand · ZZ-25', serial: 'ZZ0000001'}, {name: 'Window #1', meta: 'ZZ Brand', serial: ''}],
           paid: '', gcash: (db.settings || {}).gcash_number ? {number: db.settings.gcash_number, name: db.settings.gcash_name || ''} : null}};
}
function drawBillSample(){
  return `<p class="hint">The letterhead, the note and the signature are the quotation’s — change them in Admin → Quotation. ${infoBtn('bill')}</p>
    ${quoteBox(billSample())}
    <div class="stack"><button type="button" class="b primary wide" data-act="printquote" data-id="">🖨️ Print the sample (A4)</button></div>`;
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
  if (!src){ const bill = ui.adminSec === 'billing'; return printHtml(quoteHtml(bill ? billSample() : quoteSample()), (bill ? 'Billing statement' : 'Quotation') + ' sample', share); }
  // what is on the paper is what is saved: a changed (or never saved) quotation saves first
  if (src.open && (p.dirty || !src.saved) && !ACTIONS.savequote()) return;
  printHtml(quoteHtml(docView(p, src)), src.title + ' ' + src.ref + ' ' + src.name, share);
}
/* ---------------------------------------------------------------- the quotation as Word (39)
   Guile, 2026-10-10: "Send as DOCX". The same q as quoteHtml, written as a .docx — a zip of
   a few XML files and the three pictures (logo, QR, his signature). The zip is made here
   with no compression (Word reads it either way), so no library. DOC, Word's old binary
   format, cannot be made without one: DOCX only. */
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++){ let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b){ let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zipStore(files){   // [{name, data: Uint8Array}] → Blob
  const enc = new TextEncoder(), parts = [], dir = [];
  let off = 0;
  const d = new Date(), time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files){
    const name = enc.encode(f.name), crc = crc32(f.data), n = f.data.length;
    const h = new DataView(new ArrayBuffer(30));
    [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, time, 2], [12, date, 2], [14, crc, 4], [18, n, 4], [22, n, 4], [26, name.length, 2], [28, 0, 2]]
      .forEach(([o, v, w]) => w === 4 ? h.setUint32(o, v, true) : h.setUint16(o, v, true));
    const c = new DataView(new ArrayBuffer(46));
    [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, time, 2], [14, date, 2], [16, crc, 4], [20, n, 4], [24, n, 4],
     [28, name.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, off, 4]]
      .forEach(([o, v, w]) => w === 4 ? c.setUint32(o, v, true) : c.setUint16(o, v, true));
    parts.push(h, name, f.data); dir.push(c, name);
    off += 30 + name.length + n;
  }
  const size = dir.reduce((s, x) => s + x.byteLength, 0), e = new DataView(new ArrayBuffer(22));
  [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, files.length, 2], [10, files.length, 2], [12, size, 4], [16, off, 4], [20, 0, 2]]
    .forEach(([o, v, w]) => w === 4 ? e.setUint32(o, v, true) : e.setUint16(o, v, true));
  return new Blob([...parts, ...dir, e], {type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});
}
async function docxPic(src){   // {data, w, h} or null — a missing picture leaves its place empty
  try {
    // a data: picture (his signature) is decoded here: the page's CSP lets fetch reach 'self' only
    const data = src.startsWith('data:') ? Uint8Array.from(atob(src.split(',')[1]), ch => ch.charCodeAt(0))
                                         : new Uint8Array(await (await fetch(src)).arrayBuffer());
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    return {data, w: img.naturalWidth, h: img.naturalHeight};
  } catch (e) { return null; }
}
async function quoteDocx(q){
  const s = quoteShop(), sigSrc = quoteSig(), total = qtTotal(q.lines);
  const [logo, qr, sig, csig] = await Promise.all([docxPic('img/winter-air-logo.png'), docxPic('img/quote-qr.png'), sigSrc ? docxPic(sigSrc) : null,
    q.csig ? docxPic(q.csig.png) : null]);   // the customer's (47)
  const signedOn = q.csig ? qtLongDate(manilaDay(q.csig.at)) : '';
  const x = t => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const EMU = 914400, pics = [];
  const pic = (p, inchH, maxW) => {
    if (!p) return '';
    let h = inchH * EMU, w = h * p.w / p.h;
    if (maxW && w > maxW * EMU){ w = maxW * EMU; h = w * p.h / p.w; }
    pics.push(p); const n = pics.length, id = 'rIdP' + n;
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${Math.round(w)}" cy="${Math.round(h)}"/><wp:docPr id="${n}" name="Picture ${n}"/>
      <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
      <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${n}" name="p${n}.png"/><pic:cNvPicPr/></pic:nvPicPr>
      <pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
      <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.round(w)}" cy="${Math.round(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>
      </a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  };
  const run = (t, o = {}) => `<w:r><w:rPr>${o.b ? '<w:b/>' : ''}${o.i ? '<w:i/>' : ''}${o.sz ? `<w:sz w:val="${o.sz}"/><w:szCs w:val="${o.sz}"/>` : ''}</w:rPr><w:t xml:space="preserve">${x(t)}</w:t></w:r>`;
  const para = (inner, o = {}) => `<w:p><w:pPr><w:spacing w:before="0" w:after="${o.after != null ? o.after : 120}"/>${o.jc ? `<w:jc w:val="${o.jc}"/>` : ''}${o.ind ? `<w:ind w:left="${o.ind}"/>` : ''}</w:pPr>${inner}</w:p>`;
  const P = (t, o) => para(run(t, o), o);
  const cell = (inner, w, o = {}) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${o.span ? `<w:gridSpan w:val="${o.span}"/>` : ''}${o.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${o.fill}"/>` : ''}<w:vAlign w:val="center"/></w:tcPr>${inner}</w:tc>`;
  const longDate = ymd => ymd ? new Date(ymd + 'T00:00:00').toLocaleDateString('en-US', {month: 'long', day: 'numeric', year: 'numeric'}) : '';
  const note = String(q.note || '').split('\n').filter(t => t.trim());
  const none = '<w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders>';
  const lines = '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(k => `<w:${k} w:val="single" w:sz="6" w:space="0" w:color="000000"/>`).join('') + '</w:tblBorders>';
  // letterhead: logo | the shop's words | his QR, side by side (2026-09-28)
  const head = `<w:tbl><w:tblPr><w:tblW w:w="9900" w:type="dxa"/>${none}<w:tblLayout w:type="fixed"/></w:tblPr>
    <w:tblGrid><w:gridCol w:w="1800"/><w:gridCol w:w="6300"/><w:gridCol w:w="1800"/></w:tblGrid><w:tr>
    ${cell(para(pic(logo, 0.95, 1.2), {after: 0}), 1800)}
    ${cell([P(s.name, {b: true, sz: 30, jc: 'center', after: 40}), s.tagline ? P(s.tagline, {i: true, jc: 'center', after: 20}) : '',
            s.address ? P(s.address, {jc: 'center', after: 20}) : '', s.contact ? P(s.contact, {sz: 20, jc: 'center', after: 20}) : '',
            s.tin ? P(s.tin, {sz: 20, jc: 'center', after: 0}) : ''].join(''), 6300)}
    ${cell(para(pic(qr, 0.95, 1.2), {after: 0, jc: 'right'}), 1800)}</w:tr></w:tbl>`;
  const W = [5900, 900, 1300, 1800];
  const tr = cells => `<w:tr>${cells.join('')}</w:tr>`;
  const items = `<w:tbl><w:tblPr><w:tblW w:w="9900" w:type="dxa"/>${lines}<w:tblLayout w:type="fixed"/></w:tblPr>
    <w:tblGrid>${W.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>
    ${tr([cell(P('Supply of Labor, Materials and Services', {b: true, after: 0}), W[0], {fill: 'D9E2F3'}), cell(P('Qty.', {b: true, jc: 'center', after: 0}), W[1], {fill: 'D9E2F3'}),
          cell(P('Unit Price', {b: true, jc: 'center', after: 0}), W[2], {fill: 'D9E2F3'}), cell(P('Amount', {b: true, jc: 'center', after: 0}), W[3], {fill: 'D9E2F3'})])}
    ${q.lines.map(l => tr([cell(P(l.text || '', {after: 0}), W[0]), cell(P(l.qty != null ? String(l.qty) : '—', {jc: 'center', after: 0}), W[1]),
          cell(P(l.price != null ? qtNum(l.price) : '—', {jc: 'center', after: 0}), W[2]),
          cell(P(qtAmount(l) != null ? qtMoney(qtAmount(l)) : '—', {jc: 'right', after: 0}), W[3])])).join('')}
    ${tr([cell(P('TOTAL', {b: true, jc: 'center', after: 0}), W[0] + W[1] + W[2], {span: 3}), cell(P(total != null ? 'PHP ' + qtMoney(total) : '—', {b: true, jc: 'right', after: 0}), W[3])])}
    </w:tbl>`;
  // the billing statement (45): the same letterhead, table and signature; its own words
  const m = q.bill, half = (l, r) => `<w:tbl><w:tblPr><w:tblW w:w="9900" w:type="dxa"/>${none}<w:tblLayout w:type="fixed"/></w:tblPr>
    <w:tblGrid><w:gridCol w:w="4950"/><w:gridCol w:w="4950"/></w:tblGrid><w:tr>${cell(l, 4950)}${cell(r, 4950)}</w:tr></w:tbl>`;
  const billItems = m && `<w:tbl><w:tblPr><w:tblW w:w="9900" w:type="dxa"/>${lines}<w:tblLayout w:type="fixed"/></w:tblPr>
    <w:tblGrid>${[600, 5300, 900, 1300, 1800].map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>
    ${tr([cell(P('#', {b: true, jc: 'center', after: 0}), 600, {fill: 'D9E2F3'}), cell(P('Description of Labor, Materials and Services', {b: true, after: 0}), 5300, {fill: 'D9E2F3'}),
          cell(P('Qty.', {b: true, jc: 'center', after: 0}), 900, {fill: 'D9E2F3'}), cell(P('Unit Price', {b: true, jc: 'center', after: 0}), 1300, {fill: 'D9E2F3'}),
          cell(P('Amount', {b: true, jc: 'center', after: 0}), 1800, {fill: 'D9E2F3'})])}
    ${q.lines.map((l, i) => tr([cell(P(String(i + 1), {jc: 'center', after: 0}), 600), cell(P(l.text || '', {after: 0}), 5300),
          cell(P(l.qty != null ? String(l.qty) : '—', {jc: 'center', after: 0}), 900), cell(P(l.price != null ? qtNum(l.price) : '—', {jc: 'center', after: 0}), 1300),
          cell(P(qtAmount(l) != null ? qtMoney(qtAmount(l)) : '—', {jc: 'right', after: 0}), 1800)])).join('')}
    ${tr([cell(P('TOTAL AMOUNT DUE', {b: true, jc: 'right', after: 0}), 8100, {span: 4}), cell(P(total != null ? 'PHP ' + qtMoney(total) : '—', {b: true, jc: 'right', after: 0}), 1800)])}
    </w:tbl>`;
  const body = m ? [head, P(''), P('BILLING STATEMENT', {b: true, sz: 30, jc: 'center', after: 200}),
    half([P('BILL TO', {b: true, sz: 18, after: 20}), P(m.name, {b: true, after: 0}),
          ...String(q.to_address || '').split('\n').filter(t => t.trim()).map(t => P(t, {after: 0})), m.contact ? P(m.contact, {after: 0}) : ''].join(''),
         [P('Statement No.: ' + m.no, {b: true, jc: 'right', after: 0}), P('Date: ' + longDate(q.date), {jc: 'right', after: 0}),
          m.service ? P('Service date: ' + m.service, {jc: 'right', after: 0}) : '',
          m.units && !(m.aircons || []).length ? P('Units: ' + m.units, {jc: 'right', after: 0}) : ''].join('')),
    ...((m.aircons || []).length ? [P('APPLIANCES', {b: true, sz: 18, after: 20})].concat(m.aircons.map(a =>
      para(run(a.name + (a.meta ? ' — ' + a.meta : ''), {sz: 20}) + (a.serial ? run('    S/N ' + a.serial, {sz: 16}) : ''), {after: 0}))) : []),
    P(''), P('SUBJECT: ' + (q.subject || ''), {b: true}), q.salutation ? P(q.salutation) : '',
    P('Please find below the statement of charges for the labor, materials and services rendered by ' + SHOP_SHORT + ':', {jc: 'both'}),
    billItems, P(''),
    m.paid ? P('PAID — ' + m.paid, {b: true}) : m.gcash ? P('Pay by GCash: ' + m.gcash.number + (m.gcash.name ? ' (' + m.gcash.name + ')' : ''), {b: true}) : '',
    note.length ? P('Note:', {b: true, after: 40}) : '', ...note.map(t => P('•  ' + t.trim(), {ind: /^\s/.test(t) ? 720 : 360, after: 20})),
    P(''),
    half([P('Prepared by:', {after: 0}), sig ? para(pic(sig, 0.6, 2.2), {after: 0}) : P('') + P(''),
          P(s.signer || '', {b: true, after: 0}), s.title ? P(s.title, {after: 0}) : '', P(s.name, {after: 0})].join(''),
         [P('Received by:', {after: 0}), csig ? para(pic(csig, 0.6, 2.2), {after: 0}) : P('') + P(''),
          csig && q.csig.name ? P(q.csig.name, {b: true, after: 0}) : '', P('________________________________', {after: 0}),
          P('Signature over Printed Name', {sz: 18, after: 120}), P('Date: ' + (csig ? signedOn : '____________________'), {after: 0})].join('')),
    P(''), P('Thank you for choosing ' + s.name + '. This is not an official receipt.', {sz: 18, jc: 'center'})].join('')
  : [head, P(''), P(longDate(q.date)),
    ...String(q.to_address || '').split('\n').filter(t => t.trim()).map((t, i, a) => P(t, {after: i === a.length - 1 ? 120 : 0})),
    P('SUBJECT: ' + (q.subject || ''), {b: true}), q.salutation ? P(q.salutation) : '',
    P('Thank you for considering ' + SHOP_SHORT + ' as your service provider! We are pleased to present this proposal and will furnish the equipment, labor and materials necessary as well as our expertise to do the following in compliance with your service request:', {jc: 'both'}),
    items, P(''),
    note.length ? P('Note:', {b: true, after: 40}) : '', ...note.map(t => P('•  ' + t.trim(), {ind: /^\s/.test(t) ? 720 : 360, after: 20})),
    P(''), P('We strive to satisfy our clients to the best of our abilities and we hope you’ll find our proposal suitable to your business needs.', {jc: 'both'}),
    P('Should you find the above agreement acceptable, we have provided a space below for your valued signature. This will then serve as our contract.', {jc: 'both'}),
    P('Sincerely yours,'), sig ? para(pic(sig, 0.6, 2.2), {after: 0}) : P('') + P(''),
    P(s.signer || '', {b: true, after: 0}), s.title ? P(s.title, {after: 0}) : '', P(s.name, {after: 360}),
    ...(csig ? [para(pic(csig, 0.6, 2.4), {after: 0, ind: 1100}), q.csig.name ? P(q.csig.name, {b: true, ind: 1100, after: 0}) : ''] : []),
    P('Conforme: ________________________________________', {after: 0}), P('Signature over Printed Name & Title', {sz: 18, ind: 1100}),
    P('Date: ' + (csig ? signedOn : '________________________'))].join('');
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${body}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000" w:header="500" w:footer="500" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Cambria" w:hAnsi="Cambria" w:cs="Cambria"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-PH"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="252" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>`;
  const enc = new TextEncoder();
  return zipStore([
    {name: '[Content_Types].xml', data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`)},
    {name: '_rels/.rels', data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)},
    {name: 'word/document.xml', data: enc.encode(doc)},
    {name: 'word/styles.xml', data: enc.encode(styles)},
    {name: 'word/_rels/document.xml.rels', data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${pics.map((p, i) =>
      `<Relationship Id="rIdP${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/p${i + 1}.png"/>`).join('')}</Relationships>`)},
    ...pics.map((p, i) => ({name: 'word/media/p' + (i + 1) + '.png', data: p.data})),
  ]);
}
async function quoteWord(){
  const p = topPanel(), src = p && p.q && quoteSrc(p);
  if (!src) return;
  if (src.open && (p.dirty || !src.saved) && !ACTIONS.savequote()) return;   // the file is what is saved, as the paper
  const name = src.title + ' ' + src.ref + ' ' + src.name;
  try {
    const blob = await quoteDocx(docView(p, src));
    if (window.AndroidBridge && window.AndroidBridge.shareDocx){
      const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
      window.AndroidBridge.shareDocx(name, b64);
    } else if (window.AndroidBridge){
      toast('This app is older than Send as Word. Press Update first, then try again.', true);
    } else {   // the website: the file downloads
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name.replace(/[\\/:*?"<>|]/g, '').trim() + '.docx';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }
  } catch (e) { toast('The Word file was not made: ' + e.message, true); }
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
/* A picture comes back to a button that is no longer on the screen (Guile, 2026-10-10: "cannot
   add work photo"). Coming back from the camera, the app refreshes and redraws the screen —
   measured on the owner's tablet: the redraw 60 ms BEFORE the picture arrived — so the
   picture lands on the old <input>, out of the page, and its change never reaches the page's
   listeners. Every picture button, once: when that happens, the old input is put back (out of
   sight) just long enough to be heard, then taken out again. */
document.addEventListener('click', e => {
  const inp = e.target && e.target.closest && e.target.closest('input[type="file"]');
  if (!inp || inp.dataset.heard) return;
  inp.dataset.heard = '1';
  inp.addEventListener('change', () => {
    if (inp.isConnected || !(inp.files && inp.files.length)) return;
    let hold = $('#fileHold');
    if (!hold){ hold = document.createElement('div'); hold.id = 'fileHold'; hold.hidden = true; document.body.appendChild(hold); }
    hold.appendChild(inp);
    inp.dispatchEvent(new Event('change', {bubbles: true}));
    setTimeout(() => inp.remove(), 0);
  });
}, true);
// a tap opens it full screen, in the work photos' viewer (Guile, 2026-10-10: "cannot zoom")
function housePhoto(path, cls){ return `<img class="${cls || 'house-photo'}" data-house="${esc(path)}" alt="The gate" role="button" tabindex="0" data-act="houseview" data-v="${esc(path)}" draggable="false">`; }
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
/* Photos live on the phones (Guile, 2026-10-11, 46): the shop is on Supabase's free plan, so
   the server only relays a work photo until every shop phone has it (or 14 days). In the app
   each photo is a file of its own (AndroidBridge.keepPhoto), kept until the app is removed —
   the WebView's own cache can be cleared by Android when space runs low (persist() refused,
   measured on the owner's tablet). The page reads a kept one as kept/<path>. The website has
   no such files: it keeps its browser cache, as before. */
const KEEPS = !!(window.AndroidBridge && window.AndroidBridge.keepPhoto);
const RELAYED = /^(work|cust)\//;   // the photos the server only relays: work photos (46), a customer's pictures (53)
let keptSet = null;
function kept(){
  if (!keptSet){ keptSet = new Set(); try { JSON.parse(window.AndroidBridge.keptList() || '[]').forEach(x => keptSet.add(x)); } catch (e) {} }
  return keptSet;
}
const isKept = path => KEEPS && kept().has(path);
async function keepPhoto(path, blob){
  if (KEEPS){
    try {
      const b64 = await blobB64(blob);
      if (window.AndroidBridge.keepPhoto(path, b64)){ kept().add(path); photoUrls[path] = 'kept/' + path; if (RELAYED.test(path)) haveAdd(path); return; }
    } catch (e) {}
  }
  try { const c = await caches.open('ws-photos'); await c.put('photo/' + path, new Response(blob, {headers: {'Content-Type': 'image/jpeg'}})); } catch (e) {}
  if (!photoUrls[path]) photoUrls[path] = URL.createObjectURL(blob);
}
// a photo taken off the job (on any phone) leaves this one too
function dropKept(path){
  if (!path) return;
  if (KEEPS){ try { window.AndroidBridge.dropKept(path); } catch (e) {} kept().delete(path); }
  caches.open('ws-photos').then(c => c.delete('photo/' + path)).catch(() => {});
  delete photoUrls[path];
}
function hydratePhotos(){
  $$('img[data-house]').forEach(img => {
    const p = img.dataset.house;
    if (!photoUrls[p] && isKept(p)) photoUrls[p] = 'kept/' + p;
    if (photoUrls[p]){ if (img.getAttribute('src') !== photoUrls[p]) img.src = photoUrls[p]; }
    // off the server (46): only a copy on this phone can show it
    else if (img.dataset.off){ if (!photoWant.has(p)){ photoWant.add(p); photoQueue.push({p, b: null, tries: 3}); pumpPhotos(); } }
    else if (!photoWant.has(p)){ photoWant.add(p); photoQueue.push({p, b: img.dataset.bucket || 'house-photos', tries: 0}); pumpPhotos(); }
  });
}
/* Which work photos this phone keeps, told to the server so it can let go of them (46). The
   phone's id is made once; the list waits here until it is sent. */
const deviceId = () => { let d = lsGet('ws_device', ''); if (!d){ d = uuid(); lsSet('ws_device', d); } return d; };
function haveAdd(path){ const h = lsGet('ws_have', []); if (!h.includes(path)){ h.push(path); lsSet('ws_have', h); } }
async function reportHaves(){
  if (!KEEPS || !db || !['admin', 'technician'].includes(db.role) || !online || !session) return;
  if (!lsGet('ws_have_init', false)){   // the first time: everything this phone already keeps
    lsSet('ws_have_init', true); kept().forEach(x => { if (RELAYED.test(x)) haveAdd(x); });
  }
  const h = lsGet('ws_have', []), day = manilaDate(0);
  if (!h.length && lsGet('ws_have_day', '') === day) return;   // and once a day to say "still here"
  const send = h.slice(0, 500);
  try {
    await rpc('photos_have', {p_device: deviceId(), p_paths: send});
    lsSet('ws_have', lsGet('ws_have', []).filter(x => !send.includes(x))); lsSet('ws_have_day', day);
  } catch (e) {}   // a server before 46, or no signal: next refresh
}
// every work photo and customer's picture this phone does not keep yet, while the server still has it
function fetchMissingPhotos(){
  if (!KEEPS || !db || !['admin', 'technician'].includes(db.role) || !online) return;
  const want = w => {
    if (w.off || isKept(w.path) || photoWant.has(w.path)) return;
    photoWant.add(w.path); photoQueue.push({p: w.path, b: WORK_BUCKET, tries: 0});
  };
  Object.values(db.jobs).forEach(j => { workList(j).forEach(want); if (j.customer) custPicList(j.customer).forEach(want); });
  Object.values(db.customers).forEach(c => custPicList(c).forEach(want));   // 53
  pumpPhotos();
}
function pumpPhotos(){
  while (photoActive < 4 && photoQueue.length){
    const job = photoQueue.shift();
    photoActive++;
    (async () => {
      try {
        let blob = null;
        try { const c = await caches.open('ws-photos'); const m = await c.match('photo/' + job.p); if (m) blob = await m.blob(); } catch (e) {}
        if (!blob && !job.b) throw new Error('not on this phone');   // off the server (46)
        if (!blob){
          const r = await storage('GET', job.p, null, false, job.b);   // work photos have their own bucket (39)
          if (!r.ok) throw new Error('http ' + r.status);
          blob = await r.blob();
        }
        await keepPhoto(job.p, blob);
        hydratePhotos();
      } catch (e) {
        if (++job.tries < 4) setTimeout(() => { photoQueue.push(job); pumpPhotos(); }, 1000 * 2 ** job.tries);
        else if (job.b) photoWant.delete(job.p);   // asked for again the next time a screen shows it (one only kept elsewhere: not)
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

/* ---------------------------------------------------------------- work photos (39)
   Guile, 2026-10-10: the gate photo became Work photos — several per job (12 at most), from
   the office or a technician, seen full screen with swipe and pinch. pictures.md: the expiry
   before the upload — a photo goes 90 days after its job is done or cancelled; the office's
   phone runs work_photo_sweep once a day, deletes the files it is handed and crosses them
   off. 1280 px at the house photo's 0.72. Downloads ride the house photos' queue. */
const WORK_BUCKET = 'work-photos', WORK_MAX = 12;
// up into the relay bucket; the same file twice is already there: fine (as the house photo)
async function putPhoto(path, blob){
  const r = await storage('POST', path, blob, false, WORK_BUCKET);
  if (!r.ok && r.status !== 409 && r.status !== 400){
    const b = await r.json().catch(() => ({}));
    throw new Error(b.message || b.error || 'HTTP ' + r.status);
  }
  if (r.status === 400){ const b = await r.json().catch(() => ({})); if (!/exist/i.test(b.message || b.error || '')) throw new Error(b.message || b.error || 'HTTP 400'); }
}
const blobB64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
const b64Blob = b64 => { const s = atob(b64), a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return new Blob([a], {type: 'image/jpeg'}); };
const workBusy = {};   // job id → photos still on their way up
const workList = j => Array.isArray(j && j.work_photos) ? j.work_photos : [];
// the office any time; a technician on a job with a day, not cancelled — as the server says
const canWorkPhoto = j => !!j && 'work_photos' in j && (viewRole() === 'admin'
  || (viewRole() === 'technician' && !!j.scheduled_on && j.status !== 'cancelled'));
const canDropWork = x => db.role === 'admin' || (db.role === 'technician' && x.by === session.uid);
const workImg = (path, cls, off) => `<img class="${cls || 'work-thumb'}" data-house="${esc(path)}" data-bucket="${WORK_BUCKET}"${off ? ' data-off="1"' : ''} alt="Work photo" draggable="false">`;
function workPhotoBtn(j){
  const busy = workBusy[j.id];
  if (busy) return `<span class="b" aria-busy="true">Sending ${busy} photo${busy === 1 ? '' : 's'}…</span>`;
  if (workList(j).length >= WORK_MAX) return '';
  return `<label class="b">📷 Work photo<input type="file" accept="image/*" multiple data-work-for="${esc(j.id)}" hidden></label>`;
}
function workPhotosHtml(j){
  const list = workList(j);
  if (!list.length) return '';
  return `<div class="sec">📷 Work photos <span class="prep-count">${list.length}</span></div>
    <div class="work-grid">${list.map((x, i) => `<button type="button" class="work-cell" data-act="workview" data-id="${esc(j.id)}" data-v="${i}" aria-label="Work photo ${i + 1} — full screen">${
      x.off && KEEPS && !isKept(x.path) ? '<span class="work-gone">📷<small>On the other phones</small></span>' : workImg(x.path, null, x.off)}</button>`).join('')}</div>`;
}
/* Mark done asks, once: "Wanna add work photos?" — optional, Cancel any time (Guile). */
function panelDonePhoto(p){
  const j = db.jobs[p.id];
  if (!j) return {title: 'Done', body: empty('This job is no longer on this phone.')};
  return {title: '✓ Marked done', sub: jobCust(j).full_name || '', body: `
    <p class="done-ask">Wanna add work photos?</p>
    <p class="hint">Optional — the finished work, for the office and the next visit.</p>
    <div class="stack">
      <label class="b primary wide">📷 Take a picture<input type="file" accept="image/*" capture="environment" data-work-for="${esc(j.id)}" hidden></label>
      <button type="button" class="b wide grey" data-act="back">Cancel</button></div>`};
}
document.addEventListener('change', async e => {
  const inp = e.target;
  if (!inp.matches || !inp.matches('input[data-work-for]')) return;
  const jid = inp.dataset.workFor, files = [...(inp.files || [])];
  inp.value = '';
  const j = db.jobs[jid];
  if (!files.length || !session || !j) return;
  const top = topPanel(); if (top && top.kind === 'donephoto') closePanel();
  const room = Math.max(0, WORK_MAX - workList(j).length - (workBusy[jid] || 0));
  if (files.length > room) notice('A job keeps ' + WORK_MAX + ' work photos. ' + (room ? 'The first ' + room + ' are going; the rest were left out.' : 'Take one off first.'), true);
  const take = files.slice(0, room);
  if (!take.length) return;
  workBusy[jid] = (workBusy[jid] || 0) + take.length; render();
  let sent = 0;
  for (const file of take){
    try {
      const blob = await fitPhoto(file, 1280);
      const path = 'work/' + jid + '/' + await hashOf(blob) + '.jpg';
      await putPhoto(path, blob);
      await keepPhoto(path, blob);
      write('add_work_photo', {p_job: jid, p_path: path}, 'Work photo — ' + (jobCust(j).full_name || ''), [jid], db => {
        const x = db.jobs[jid]; if (!x) return;
        x.work_photos = workList(x).filter(w => w.path !== path).concat([{path, by: session.uid, at: new Date().toISOString()}]);
      });
      sent++;
    } catch (err) {
      notice(err instanceof TypeError ? 'A work photo needs signal to send. It was not saved — try again when there is signal.'
                                      : 'A work photo was not saved: ' + err.message, true);
    } finally {
      if (!--workBusy[jid]) delete workBusy[jid];
      render();
    }
  }
  if (sent) toast(sent === 1 ? 'Work photo added.' : sent + ' work photos added.');
});
/* The office's phone, once a day: what the server hands back is deleted from Storage, then
   crossed off. A file already gone counts as deleted. The rest waits for tomorrow. */
async function sweepWorkPhotos(){
  if (!db || db.role !== 'admin' || !db.staff || !online) return;   // db.staff: a server with 39
  const day = manilaDate(0), key = 'ws_sweep_' + session.uid;
  if (lsGet(key, '') === day) return;
  lsSet(key, day);
  try {
    const r = await rpc('work_photo_sweep', {});
    const gone = [];
    for (const p of (r && r.paths) || []){
      const x = await storage('DELETE', p, null, false, WORK_BUCKET);
      if (x.ok || x.status === 404 || x.status === 400) gone.push(p);
    }
    if (gone.length) await rpc('work_photo_swept', {p_paths: gone});
  } catch (e) { lsSet(key, ''); }   // tried again on the next refresh
}

/* ---------------------------------------------------------------- the customer's pictures (53)
   Guile, 2026-10-12: the gate photo became a list — the gate, the house or store, the aircon,
   the appliances, the road; 20 at most. The office adds and deletes them (the customer's file,
   and ✏️ Edit); a technician sees them on the job. They live on the phones like work photos
   (46): cust/<customer id>/<hash>.jpg in the work-photos bucket, the server relays it. The old
   gate photo (photo_path, house-photos) stays where it is and shows first. */
const CUST_PIC_MAX = 20;
const custBusy = {};   // customer id → pictures still on their way up
const custFor = cid => (db && db.customers[cid]) || (Object.values((db && db.jobs) || {}).find(j => j.customer_id === cid && j.customer) || {}).customer || null;
const custPicList = c => Array.isArray(c && c.photos) ? c.photos : [];
// the grid and the viewer show the same list: the old gate photo first
const custPicsAll = c => [...(c && c.photo_path ? [{path: c.photo_path, bucket: 'house-photos', house: true}] : []),
  ...custPicList(c).map(w => ({...w, bucket: WORK_BUCKET, gone: !!w.off && KEEPS && !isKept(w.path)}))];
// a grid of pictures: the customer's, a booking's — one piece (ui.md)
const picGridHtml = (list, act, id) => `<div class="work-grid">${list.map((x, i) => `<button type="button" class="work-cell" data-act="${act}" data-id="${esc(id)}" data-v="${i}" aria-label="Picture ${i + 1} — full screen">${
  x.gone ? '<span class="work-gone">📷<small>On the other phones</small></span>'
  : `<img class="work-thumb" data-house="${esc(x.path)}"${x.bucket ? ` data-bucket="${x.bucket}"` : ''}${x.off || !x.bucket ? ' data-off="1"' : ''} alt="" draggable="false">`}</button>`).join('')}</div>`;
/* edit: the office's Add Picture under it. bare: on a job — no heading, nothing when empty. */
function custPicsHtml(cid, c, edit, bare){
  const all = custPicsAll(c), busy = custBusy[cid];
  if (!all.length && !edit) return '';
  if (bare) return `<div class="cust-pics">${picGridHtml(all, 'custview', cid)}</div>`;
  const add = !edit ? '' : busy ? `<span class="b" aria-busy="true">Sending ${busy} picture${busy === 1 ? '' : 's'}…</span>`
    : custPicList(c).length >= CUST_PIC_MAX ? `<p class="hint">${CUST_PIC_MAX} pictures — take one off to add another.</p>`
    : `<label class="b">📷 Add Picture<input type="file" accept="image/*" multiple data-custpic-for="${esc(cid)}" hidden></label>`;
  return `<div class="sec">📷 Pictures${all.length ? ` <span class="prep-count">${all.length}</span>` : ''}</div>
    ${all.length ? picGridHtml(all, 'custview', cid) : '<p class="hint">The gate, the house or store, the aircon, the appliances, the road — whatever helps find it and do the job.</p>'}
    ${add ? `<div class="actions">${add}</div>` : ''}`;
}
document.addEventListener('change', async e => {
  const inp = e.target;
  if (!inp.matches || !inp.matches('input[data-custpic-for]')) return;
  const cid = inp.dataset.custpicFor, files = [...(inp.files || [])];
  inp.value = '';
  const c = db.customers[cid];
  if (!files.length || !session || !c || db.role !== 'admin') return;
  const room = Math.max(0, CUST_PIC_MAX - custPicList(c).length - (custBusy[cid] || 0));
  if (files.length > room) notice('A customer keeps ' + CUST_PIC_MAX + ' pictures. ' + (room ? 'The first ' + room + ' are going; the rest were left out.' : 'Take one off first.'), true);
  const take = files.slice(0, room);
  if (!take.length) return;
  custBusy[cid] = (custBusy[cid] || 0) + take.length; render();
  let sent = 0;
  for (const file of take){
    try {
      const blob = await fitPhoto(file, 1280);
      const path = 'cust/' + cid + '/' + await hashOf(blob) + '.jpg';
      await putPhoto(path, blob);
      await keepPhoto(path, blob);
      addCustPic(cid, path, null);
      sent++;
    } catch (err) {
      notice(err instanceof TypeError ? 'A picture needs signal to send. It was not saved — try again when there is signal.'
                                      : 'A picture was not saved: ' + err.message, true);
    } finally {
      if (!--custBusy[cid]) delete custBusy[cid];
      render();
    }
  }
  if (sent) toast(sent === 1 ? 'Picture added.' : sent + ' pictures added.');
});
function addCustPic(cid, path, from){
  write('add_customer_photo', {p_customer: cid, p_path: path, p_from: from}, (from ? 'Picture from ' + from : 'Picture') + ' — ' + ((db.customers[cid] || {}).full_name || ''), [cid], db => {
    const x = db.customers[cid]; if (!x) return;
    x.photos = custPicList(x).filter(w => w.path !== path).concat([{path, by: session.uid, at: new Date().toISOString(), ...(from ? {from} : {})}]);
  });
}

/* Pictures from the booking (53): the customer's, sent with the booking page — kept on the
   server apart from the booking, read here only while the office looks at it. */
const bkPicCache = {}, bkPicAsked = {};   // booking id → [{path, b64}] · when last asked
function bookingPics(b){
  const have = bkPicCache[b.id];
  if (have && have.length >= b.photo_count) return have;
  if (online && session && db.role === 'admin' && !(Date.now() - (bkPicAsked[b.id] || 0) < 15000)){
    bkPicAsked[b.id] = Date.now();
    rpc('booking_photos', {p_booking: b.id}).then(r => {
      bkPicCache[b.id] = (r || []).map(x => {
        const path = 'bk/' + b.id + '/' + x.n;
        if (!photoUrls[path]) photoUrls[path] = URL.createObjectURL(b64Blob(x.b64));
        return {path, b64: x.b64};
      });
      render();
    }).catch(() => {});
  }
  return have || null;
}
function bookingPicsHtml(b){
  if (!(b.photo_count > 0)) return '';
  const list = bookingPics(b);
  return `<div class="sec">📷 Pictures from the customer <span class="prep-count">${b.photo_count}</span></div>
    ${list && list.length ? picGridHtml(list, 'bkview', b.id) : `<p class="hint">${online ? 'Loading…' : 'They show with signal.'}</p>`}
    <p class="hint">${b.status === 'new' ? 'Accept puts them on the customer’s pictures. Reject deletes them.' : 'Moving onto the customer’s pictures.'}</p>`;
}
/* Accepted: the office's phone moves them onto the customer's pictures (up into the relay
   bucket, onto the customer), then the booking lets go of them. Once per refresh, signal only. */
let bkPicsMoving = false;
async function moveBookingPics(){
  if (!db || db.role !== 'admin' || !online || bkPicsMoving) return;
  const todo = Object.values(db.bookings).filter(b => b.photo_count > 0 && b.status === 'accepted' && b.customer_id
    && db.customers[b.customer_id] && !unsentFor(b.id) && !unsentFor(b.customer_id));
  if (!todo.length) return;
  bkPicsMoving = true;
  try {
    for (const b of todo){
      const cid = b.customer_id, list = await rpc('booking_photos', {p_booking: b.id});
      if ((list || []).length && custPicList(db.customers[cid]).length + list.length > CUST_PIC_MAX) continue;   // no room: they wait (14 days)
      for (const x of list || []){
        const blob = b64Blob(x.b64), path = 'cust/' + cid + '/' + await hashOf(blob) + '.jpg';
        await putPhoto(path, blob);
        await keepPhoto(path, blob);
        addCustPic(cid, path, b.ref);
      }
      write('drop_booking_photos', {p_booking: b.id}, 'Pictures moved — ' + b.ref, [b.id], db => { const y = db.bookings[b.id]; if (y) y.photo_count = 0; });
    }
  } catch (e) {}   // no signal, or a server before 53: the next refresh
  finally { bkPicsMoving = false; }
}

/* The booking form's pictures (53): optional, up to 3, shrunk on the phone to 1280 px JPEG
   (~115 KB) and sent INSIDE the booking — the page can write nothing else (trust-boundary.md).
   The page and the office's Book a job draw the same piece (ui.md). Not kept in the draft. */
const BK_PIC_MAX = 3;
function bkPicsHtml(ctx, s){
  const pics = s.pics || [], pub = ctx === 'pub';
  return `<div class="bk-sec" data-bkf="pics">
      <div class="fieldlabel">📷 Pictures <span class="opt">— optional, up to ${BK_PIC_MAX}</span></div>
      ${pics.length ? `<div class="bk-pics">${pics.map((x, i) => `<span class="bk-pic"><img src="${esc(x.url)}" alt="Picture ${i + 1}">
        <button type="button" class="bk-pic-x" data-act="bkpicx" data-cart="${ctx}" data-v="${i}" aria-label="Take picture ${i + 1} out">×</button></span>`).join('')}</div>` : ''}
      ${s._picBusy ? '<span class="b" aria-busy="true">Getting it ready…</span>'
        : pics.length < BK_PIC_MAX ? `<label class="b">📷 Add a picture<input type="file" accept="image/*" multiple data-bkpics="${ctx}" hidden></label>` : ''}
      <div class="hint">${pub ? 'Your gate, house or store, the aircon, the appliances, the road — anything that helps us find you and do the job.'
        : 'The gate, the house or store, the aircon, the road. Accept puts them on the customer’s pictures.'}</div>
    </div>`;
}
document.addEventListener('change', async e => {
  const inp = e.target;
  if (!inp.matches || !inp.matches('input[data-bkpics]')) return;
  const ctx = inp.dataset.bkpics, s = bkState(ctx), files = [...(inp.files || [])];
  inp.value = '';
  if (!s || !files.length) return;
  s.pics = s.pics || [];
  const take = files.slice(0, Math.max(0, BK_PIC_MAX - s.pics.length));
  if (files.length > take.length) toast('Up to ' + BK_PIC_MAX + ' pictures' + (take.length ? ' — the first ' + take.length + ' were added.' : '.'), true);
  if (!take.length) return;
  s._picBusy = true; bkRedraw(ctx);
  for (const f of take){
    try { const blob = await fitPhoto(f, 1280); s.pics.push({b64: await blobB64(blob), url: URL.createObjectURL(blob)}); }
    catch (err) { toast('That file is not a picture.', true); }
  }
  s._picBusy = false;
  if (bkState(ctx) === s) bkRedraw(ctx);
});

/* An unfinished job moves to the next day by itself (Guile, 2026-10-10, 41): the first of the
   shop's phones to refresh on a new day moves every job still open from before today to
   today. The server keeps the day first promised (promised_on) for the third number. Once a
   day per phone; the server moves each job once however many phones ask. */
async function carryOver(){
  if (!db || !['admin', 'technician'].includes(db.role) || !online || !session) return;
  const day = manilaDate(0), key = 'ws_carry_' + session.uid;
  if (lsGet(key, '') === day) return;
  if (!Object.values(db.jobs).some(j => j.scheduled_on && j.scheduled_on < day && ['booked', 'scheduled', 'in_progress'].includes(j.status))){ lsSet(key, day); return; }
  lsSet(key, day);
  try { const r = await rpc('carry_over_jobs', {}); if (r && r.moved) await pull(); }
  catch (e) { lsSet(key, ''); }   // a server before 41, or no signal: asked again next refresh
}

/* The viewer: full screen, swipe left and right, pinch or double-tap to zoom, drag to look
   around a zoomed photo. Android's back closes it. Written here, no library. */
let viewer = null;
// what it shows: a job's work photos, or one gate photo (house) — the same swipe, pinch and zoom
// (53) also a customer's pictures (cid), and the pictures sent with a booking (bk) — read only
const vwList = () => !viewer ? [] : viewer.house ? [{path: viewer.house, bucket: 'house-photos', house: true}]
  : viewer.cid ? custPicsAll(custFor(viewer.cid))
  : viewer.bk ? (bkPicCache[viewer.bk] || []).map(x => ({path: x.path, bk: true, off: true}))
  : workList(db.jobs[viewer.jid]).map(w => ({...w, bucket: WORK_BUCKET, gone: !!w.off && KEEPS && !isKept(w.path)}));
const vwCanDrop = x => !!x && !x.bk && (viewer.cid ? db.role === 'admin' : !x.house && canDropWork(x));
function openViewer(jid, i, house, more){
  viewer = {jid, house: house || null, ...(more || {}), i: +i || 0, s: 1, x: 0, y: 0};
  try { history.pushState({wsv: 1}, ''); } catch (e) {}
  drawViewer();
}
function closeViewer(fromPop){
  if (!viewer) return;
  viewer = null; drawViewer();
  if (!fromPop && history.state && history.state.wsv){ ignorePop++; history.back(); }
}
function drawViewer(){
  let el = $('#viewer');
  const list = vwList();
  if (!viewer || !list.length){
    viewer = null;
    if (el) el.remove();
    document.body.classList.toggle('vw-open', false);
    return;
  }
  if (!el){
    el = document.createElement('div'); el.id = 'viewer';
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Photos');
    document.body.appendChild(el); wireViewer(el);
  }
  document.body.classList.toggle('vw-open', true);
  viewer.i = Math.min(Math.max(0, viewer.i), list.length - 1);
  el.innerHTML = `<div class="vw-track">${list.map(w => `<div class="vw-slide">${w.gone
      ? '<div class="vw-gone">📷<br>This photo is on the other shop phones only.<br><small>It left the server once they all had it.</small></div>'
      : `<img class="vw-img" data-house="${esc(w.path)}" data-bucket="${w.bucket}"${w.off ? ' data-off="1"' : ''} alt="" draggable="false">`}</div>`).join('')}</div>
    <div class="vw-ask" hidden><p><b>Delete this photo?</b><br>It is taken off this ${viewer.cid ? 'customer' : 'job'} on every phone — the office’s and the technicians’ — and cannot be brought back.</p>
      <div class="vw-ask-btns"><button type="button" class="b" data-vw="delno">Cancel</button><button type="button" class="b danger" data-vw="delyes">🗑️ Delete</button></div></div>
    <div class="vw-top"><button type="button" class="vw-btn" data-vw="close" aria-label="Close">✕</button>
      <span class="vw-count"></span><button type="button" class="vw-btn vw-del" data-vw="del" aria-label="Take this photo off">🗑️</button></div>
    <div class="vw-cap"></div>
    <button type="button" class="vw-nav prev" data-vw="prev" aria-label="Previous photo">‹</button>
    <button type="button" class="vw-nav next" data-vw="next" aria-label="Next photo">›</button>`;
  hydratePhotos();
  vwGo(viewer.i, false);
}
function vwGo(i, animate){
  const el = $('#viewer'), list = vwList();
  viewer.i = Math.min(Math.max(0, i), list.length - 1);
  viewer.s = 1; viewer.x = 0; viewer.y = 0;
  const track = $('.vw-track', el), x = list[viewer.i];
  track.style.transition = animate === false ? 'none' : '';
  track.style.transform = `translateX(${-viewer.i * 100}%)`;
  $$('.vw-img', el).forEach(img => { img.style.transform = ''; });
  $('.vw-count', el).textContent = (viewer.i + 1) + ' / ' + list.length;
  const when = x.at ? new Date(x.at).toLocaleString('en-PH', {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}) : '';
  $('.vw-cap', el).textContent = x.house ? 'The gate — to find the house' : x.bk ? 'Sent with the booking'
    : x.from ? 'Sent with booking ' + x.from + ' · ' + when : staffName(x.by) + ' · ' + when;
  $('.vw-del', el).style.visibility = vwCanDrop(x) ? '' : 'hidden';
  $('.vw-nav.prev', el).hidden = viewer.i === 0;
  $('.vw-nav.next', el).hidden = viewer.i === list.length - 1;
}
function vwZoom(){
  const s = $$('#viewer .vw-slide')[viewer.i], img = s && $('.vw-img', s); if (!img) return;
  const w = img.clientWidth, h = img.clientHeight, mx = (viewer.s - 1) * w / 2, my = (viewer.s - 1) * h / 2;
  viewer.x = Math.max(-mx, Math.min(mx, viewer.x)); viewer.y = Math.max(-my, Math.min(my, viewer.y));
  img.style.transform = viewer.s > 1 ? `translate(${viewer.x}px, ${viewer.y}px) scale(${viewer.s})` : '';
}
function wireViewer(el){
  const pts = new Map();
  let start = null, lastTap = 0, moved = false;
  const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-vw]'); if (!b || !viewer) return;
    const what = b.dataset.vw, j = db.jobs[viewer.jid], x = vwList()[viewer.i];
    if (what === 'close') closeViewer();
    else if (what === 'prev') vwGo(viewer.i - 1);
    else if (what === 'next') vwGo(viewer.i + 1);
    else if (what === 'del' && vwCanDrop(x)){ $('.vw-ask', el).hidden = false; }
    else if (what === 'delno') $('.vw-ask', el).hidden = true;
    else if (what === 'delyes' && viewer.cid && vwCanDrop(x)){   // (53) a customer's picture, the old gate photo too
      const cid = viewer.cid, name = (custFor(cid) || {}).full_name || '';
      if (x.house){
        const op = write('set_customer_photo', {p_customer: cid, p_path: null, p_job: null}, 'Gate photo off — ' + name, [cid], db => {
          if (db.customers[cid]) db.customers[cid].photo_path = null;
          Object.values(db.jobs).forEach(y => { if (y.customer_id === cid && y.customer) y.customer.photo_path = null; });
        });
        op.cleanup_photo = x.path; saveLocal();
      } else {
        dropKept(x.path);
        write('remove_customer_photo', {p_customer: cid, p_path: x.path}, 'Picture off — ' + name, [cid], db => {
          const y = db.customers[cid]; if (y) y.photos = custPicList(y).filter(w => w.path !== x.path);
        });
      }
      drawViewer();
    }
    else if (what === 'delyes' && x && !x.house && j && canDropWork(x)){
      dropKept(x.path);
      write('remove_work_photo', {p_job: j.id, p_path: x.path}, 'Work photo off — ' + (jobCust(j).full_name || ''), [j.id], db => {
        const y = db.jobs[j.id]; if (y) y.work_photos = workList(y).filter(w => w.path !== x.path);
      });
      drawViewer();
    }
  });
  el.addEventListener('pointerdown', e => {
    if (e.target.closest('[data-vw]') || !viewer) return;
    el.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, {x: e.clientX, y: e.clientY});
    moved = false;
    start = {x: e.clientX, y: e.clientY, s: viewer.s, vx: viewer.x, vy: viewer.y, d: pts.size === 2 ? dist() : 0};
    $('.vw-track', el).style.transition = 'none';
  });
  el.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId) || !viewer || !start) return;
    pts.set(e.pointerId, {x: e.clientX, y: e.clientY});
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true;
    if (pts.size === 2 && start.d){ viewer.s = Math.max(1, Math.min(4, start.s * dist() / start.d)); vwZoom(); }
    else if (pts.size === 1 && viewer.s > 1){ viewer.x = start.vx + dx; viewer.y = start.vy + dy; vwZoom(); }
    else if (pts.size === 1){ $('.vw-track', el).style.transform = `translateX(calc(${-viewer.i * 100}% + ${dx}px))`; }
  });
  const up = e => {
    if (!pts.has(e.pointerId) || !viewer) return;
    pts.delete(e.pointerId);
    const dx = e.clientX - start.x;
    if (pts.size === 1){   // one finger left after a pinch: carry on from here
      const [p] = [...pts.values()]; start = {x: p.x, y: p.y, s: viewer.s, vx: viewer.x, vy: viewer.y, d: 0}; return;
    }
    $('.vw-track', el).style.transition = '';
    if (start.d){ if (viewer.s < 1.05){ viewer.s = 1; viewer.x = viewer.y = 0; vwZoom(); } return; }
    if (viewer.s === 1 && moved){ vwGo(dx < -50 ? viewer.i + 1 : dx > 50 ? viewer.i - 1 : viewer.i); return; }
    if (!moved){   // a double tap zooms in, or back out
      if (Date.now() - lastTap < 300){ viewer.s = viewer.s > 1 ? 1 : 2.5; viewer.x = viewer.y = 0; vwZoom(); lastTap = 0; }
      else lastTap = Date.now();
    }
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}
document.addEventListener('keydown', e => {
  if (!viewer) return;
  if (e.key === 'Escape') closeViewer();
  else if (e.key === 'ArrowLeft') vwGo(viewer.i - 1);
  else if (e.key === 'ArrowRight') vwGo(viewer.i + 1);
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
  // the day first promised: a job moved on by itself keeps it in promised_on (41)
  const onDay = done.filter(j => manilaDay(j.done_at) === (j.promised_on || j.scheduled_on)).length;
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
  const lines = [['Done', 'Statement no.', 'Customer', 'Number', 'Address', 'Aircons', 'Services', 'Price', 'Paid', 'Paid on', 'Done by']]
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
  const n = unseenCounts(), unseen = n.jobs - n.assigned;
  // no bottom bar here, so the red number sits by the heading: jobs THIS technician has not opened
  // — and ⚠️ the ones given to them, apart (39)
  return pageHead('Jobs', 'tech', (n.assigned ? `<span class="tech-new warn">⚠️ ${n.assigned} assigned to you</span>` : '')
    + (unseen > 0 ? `<span class="tech-new">${unseen} new</span>` : '')) + jobTabsHtml();
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
    <div class="card me-card">${avatarHtml(staff ? session.uid : null, name, 'big')}
      <div class="lrow-main"><div class="lrow-title">${staff ? nameFx(name, session.uid, 'mine') : esc(name)}</div><div class="lrow-sub">${esc(session.email || '')}</div></div>
      ${rolePill(role)}</div>
    ${staff && db.staff ? staffPhotoBtns(session.uid) : ''}

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
    ${staff && db.staff && db.staff.some(x => x.id === session.uid) ? `<div class="card row-between">
      <div class="menu-title">Name effect ${infoBtn('fxmine')}</div>
      <button type="button" class="b" data-act="namefx" data-id="${esc(session.uid)}">✨ ${fxFor(session.uid) ? 'Change mine' : 'Give my name one'}</button>
    </div>` : ''}
    ${staff ? `<div class="card row-between">
      <div class="menu-title">Show name effects (lag issue) ${infoBtn('fxshow')}</div>
      <div class="segment mini">${[['on', 'Show'], ['off', 'Plain names']].map(([v, l]) =>
        `<button type="button" class="${(fxShown() ? 'on' : 'off') === v ? 'active' : ''}" data-act="fxshow" data-v="${v}">${l}</button>`).join('')}</div>
    </div>` : ''}
    ${staff ? `<div class="card row-between">
      <div class="menu-title">Something looks wrong? ${infoBtn('reset')}</div>
      <button type="button" class="b danger" data-act="reset">Take the office's copy</button>
    </div>` : ''}

    ${staff && apkLink() ? `<div class="sec">Send the app</div>
    <div class="card">
      <div class="menu-title">📤 Send Winter Air to another phone</div>
      <div class="sms-note">${inApk && window.AndroidBridge.shareApk ? '<b>Send APK</b>: the app itself, by Bluetooth, Messenger, Gmail, Drive, Quick Share. ' : ''}<b>Send as link</b>: a download link, by Messenger, Discord, email, any chat. Android phones only — the other phone taps it to install.</div>
      <div class="actions">${inApk && window.AndroidBridge.shareApk ? '<button type="button" class="b primary" data-act="shareapk">Send APK</button>' : ''}
        <button type="button" class="b" data-act="sharelink">🔗 Send as link</button></div>
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
  // 41: a job not finished on its day, moved on by itself (the owner via Guile, 2026-10-10)
  carried: 'Hi {name}, this is {owner} of {company}. Sorry, we could not finish your service as planned. We moved it to {when}. Sorry for the inconvenience. To change it, call or text {phone}. Thank you!',
};
const TEXT_FILLINS = ['name', 'when', 'appliances', 'price', 'owner', 'company', 'phone'];
const TEXT_KIND = {before: 'Reminder, the day before', today: 'Reminder, on the day', booked: 'Booked / moved', carried: 'Moved to the next day', hand: 'By hand'};
function textSet(){
  const s = {auto: false, before_on: true, before_at: '18:00', today_on: false, today_at: '08:00', booked: true, price: false,
             carried: true, ...((db && db.settings || {}).texts || {})};   // carried: 41
  if (!String(s.words_reminder || '').trim()) s.words_reminder = TEXT_WORDS.reminder;
  if (!String(s.words_booked || '').trim()) s.words_booked = TEXT_WORDS.booked;
  if (!String(s.words_carried || '').trim()) s.words_carried = TEXT_WORDS.carried;
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
function textWhen(j, sendDay, full){
  const t = isClock(j.slot) ? ' at ' + clock12(j.slot) : j.slot === 'am' ? ' in the morning' : j.slot === 'pm' ? ' in the afternoon' : '';
  const d = j.scheduled_on;
  if (full) return (d === sendDay ? 'TODAY, ' : d === addDays(sendDay, 1) ? 'TOMORROW, ' : '') + niceDate(d) + t;   // 41
  return (d === sendDay ? 'TODAY' : d === addDays(sendDay, 1) ? 'TOMORROW' : 'on ' + niceDate(d)) + t;
}
/* The message, from the owner's wording: {when} is said from the day it is SENT on. */
function textCompose(j, kind, sendDay, words){
  const set = textSet(), c = jobCust(j), shop = quoteShop(), r = receiptOf(j);
  let w = words != null ? words : kind === 'booked' ? set.words_booked : kind === 'carried' ? set.words_carried : set.words_reminder;
  if (!shop.signer) w = w.replace(/\{owner\} of \{company\}/g, '{company}');
  const price = set.price && r.total != null ? 'Total: PHP ' + Number(r.total).toLocaleString('en-PH', {maximumFractionDigits: 2}) : '';
  const fill = {name: c.full_name || 'there', when: textWhen(j, sendDay || manilaDate(0), kind === 'carried'), price,
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
  Object.values(db.jobs).filter(textable).filter(j => !j.promised_on).forEach(j => {   // 41: not a moved-on job
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
    if (!set.auto || !smsSender()) return;
    if (set.booked) for (const j of Object.values(db.jobs).filter(textable).filter(j => !j.promised_on)){   // 41
      const key = 'booked:' + j.scheduled_on + (j.slot ? ' ' + j.slot : '');
      if (textsOf(j)[key] || !(Date.parse(j.schedule_at || '') >= since) || jobUntil(j) <= Date.now()) continue;
      await textSend(j, key, textCompose(j, 'booked', manilaDate(0)));
    }
    // 41: moved on by itself — "sorry, we moved it to …", the first refresh after the move
    if (set.carried) for (const j of Object.values(db.jobs).filter(textable).filter(j => j.promised_on && j.carried_at)){
      const key = 'carried:' + j.scheduled_on + (j.slot ? ' ' + j.slot : '');
      if (textsOf(j)[key] || !(Date.parse(j.carried_at) >= since) || jobUntil(j) <= Date.now()) continue;
      await textSend(j, key, textCompose(j, 'carried', manilaDate(0)));
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
function textWordsCard(k, kind, title){
  const s = textSet();
  return `<div class="card">
      <div class="menu-title">${title}</div>
      <label><span class="opt">Fill-ins: ${TEXT_FILLINS.map(f => '{' + f + '}').join(' ')}</span>
        <textarea id="tw_${kind}" data-k="tw_${kind}" data-txtcount="tc_${kind}" rows="7" maxlength="700">${esc(s[k])}</textarea></label>
      <div class="sms-note" id="tc_${kind}">${esc(smsCountLine(s[k]))}</div>
      <div class="actions"><button type="button" class="b primary" data-act="textwords" data-f="${k}" data-v="${kind}">Save</button>
        <button type="button" class="b" data-act="textwordsreset" data-f="${k}" data-v="${kind}">The shop's wording</button></div>
      <div class="sms-note">Looks like this — a sample, ZZ data:</div><pre class="sms-sample">${esc(textSample(kind))}</pre>
      <div class="sms-note">${esc(smsCountLine(textSample(kind)))}</div></div>`;
}
/* Admin → Job (the owner via Guile, 2026-10-10, 41): the job mover — on/off and the time an
   unfinished job of today moves to tomorrow — and the apology text it sends, with his wording. */
const moverSet = () => ({on: true, at: '23:59', ...((db && db.settings || {}).job_mover || {})});
/* The mover's time, typed like a job's (Guile, 2026-10-10): [HH] : [MM] [AM | PM], any minute. */
function moverTimeHtml(at){
  const h = +at.slice(0, 2), hh = String((h % 12) || 12), mm = at.slice(3), ap = h < 12 ? 'am' : 'pm';
  const pick = (part, now, list) => `<select data-movert="${part}" aria-label="${part === 'h' ? 'Hour' : 'Minutes'}">${list.map(v =>
    `<option${v === now ? ' selected' : ''}>${v}</option>`).join('')}</select>`;
  return `<div class="bk-time">${pick('h', hh, Array.from({length: 12}, (_, i) => String(i + 1)))}<b>:</b>${
    pick('m', mm, Array.from({length: 60}, (_, i) => String(i).padStart(2, '0')))}
    <div class="segment">${[['am', 'AM'], ['pm', 'PM']].map(([k, t]) =>
      `<button type="button" class="${ap === k ? 'active' : ''}" data-act="moverap" data-v="${k}">${t}</button>`).join('')}</div></div>`;
}
function moverAt(part, v){
  const at = moverSet().at, h = +at.slice(0, 2);
  const p = {h: String((h % 12) || 12), m: at.slice(3), ap: h < 12 ? 'am' : 'pm', [part]: v};
  const next = String((+p.h % 12) + (p.ap === 'pm' ? 12 : 0)).padStart(2, '0') + ':' + p.m;
  if (next !== at) saveMover(moverSet().on, next);
}
// what the time means, said plainly: 12:00 AM is the start of a day, 12:00 PM is noon (42)
function moverMeans(at){
  if (at === '00:00') return 'At 12:00 AM (midnight), every job from the day before that is not Done or Cancelled moves to the new day, same time.';
  return 'At ' + clock12(at) + (at === '12:00' ? ' (noon)' : '') + ' each day, every job of that day — and any older one — that is not Done or Cancelled moves to the next day, same time. A job whose own time is later than ' + clock12(at) + ' stays.'
    + (at < '17:00' ? ' This is during the working day: a job still being worked on at ' + clock12(at) + ' moves too.' : '');
}
function panelUnitField(p){
  const f = p.id ? (db.unitFields || []).find(x => x.key === p.id) : null;
  if (p.label == null) Object.assign(p, {label: f ? f.label : '', types: f ? [...(f.types || [])] : p.for ? [p.for] : [], long: f ? (f.long ? '1' : '') : '',   // 54: + Add a box on an appliance
    pub: f ? (f.public ? '1' : '') : '', key: f ? f.key : 'f_' + Math.random().toString(36).slice(2, 10).replace(/[^a-z0-9]/g, 'x')});
  const seg = (k, opts) => `<div class="segment">${opts.map(([v, t]) => `<button type="button" class="${(p[k] || '') === v ? 'active' : ''}" data-act="pset" data-f="${k}" data-v="${v}">${t}</button>`).join('')}</div>`;
  return {title: f ? f.label : 'New box', sub: 'Specs', body: `
    <label>Name of the box <input data-pf="label" maxlength="40" value="${esc(p.label)}" placeholder="Horsepower, Refrigerant…" autocomplete="off"></label>
    <div class="fieldlabel">On these appliances</div>
    <div class="tabbar tight">${activeTypes().map(t => `<button type="button" class="tab-btn${p.types.includes(t.key) ? ' active' : ''}" data-act="ufieldtype" data-v="${esc(t.key)}">${p.types.includes(t.key) ? '✓ ' : ''}${esc(t.label)}</button>`).join('')}</div>
    <div class="fieldlabel">Size</div>${seg('long', [['', 'One line'], ['1', 'Bigger box']])}
    <div class="fieldlabel">On the booking page</div>${seg('pub', [['', 'Shop only'], ['1', 'Customers fill it too']])}
    <p class="hint">${p.pub ? 'Customers see it and can fill it in when they book. The office and technicians always can.' : 'Only the office and technicians see and fill it. Customers never see it.'}</p>
    <div class="stack"><button type="button" class="b primary wide" data-act="saveufield">Save</button>
      ${f ? `<button type="button" class="b wide${f.removed ? '' : ' danger'}" data-act="saveufield" data-v="${f.removed ? 'back' : 'remove'}">${f.removed ? 'Bring it back' : 'Remove the box'}</button>` : ''}</div>
    ${f && !f.removed ? '<p class="hint">Removing hides it from every form. Aircons filled in before keep what they say.</p>' : ''}`};
}
function drawJobMover(){
  const m = moverSet(), s = textSet();
  const seg = (act, on) => `<div class="segment mini">${[[false, 'Off'], [true, 'On']].map(([v, l]) =>
    `<button type="button" class="${!!on === v ? 'active' : ''}" ${act} data-v="${v}">${l}</button>`).join('')}</div>`;
  // (49) the technicians and the jobs not theirs
  const r = jobRules();
  const rule = (k, on, title, info, now) => `<div class="card row-between">
      <div class="lrow-main"><div class="menu-title">${title} ${infoBtn(info)}</div><div class="sms-note">${now}</div></div>
      <div class="segment mini">${[[false, 'No'], [true, 'Yes']].map(([v, l]) =>
        `<button type="button" class="${!!on === v ? 'active' : ''}" data-act="techrule" data-f="${k}" data-v="${v}">${l}</button>`).join('')}</div></div>`;
  const rules = `<div class="sec">Technicians</div>
    ${rule('tech_edit_others', r.others, 'Can technicians open and edit the other jobs?', 'techothers',
      r.others ? 'Every technician works every job.' : 'Only the jobs they are assigned to. The rest show, to see only.')}
    ${rule('tech_request', r.ask, 'Can technicians ask to be assigned?', 'techask',
      r.ask ? 'A technician taps a job that is not theirs → “Ask the office”.' : 'Only the office assigns.')}
    ${rule('tech_reward', r.reward, 'Can technicians see what they receive?', 'techreward',
      r.reward ? 'The job’s price × their share, set in Users.' : 'They never see an amount for themselves.')}
    <div class="sec">Unfinished jobs</div>`;
  const last = m.last_at ? 'Last moved ' + new Date(m.last_at).toLocaleString('en-PH', {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'})
    + ' — ' + (m.last_n || 0) + ((m.last_n || 0) === 1 ? ' job' : ' jobs') : 'Has not moved any job yet.';
  return `${rules}<div class="card row-between">
      <div class="menu-title">Move unfinished jobs to the next day</div>${seg('data-act="moverset" data-f="on"', m.on)}</div>
    <div class="card"><div class="menu-title">At</div>${moverTimeHtml(m.at)}
      <p class="hint">${esc(moverMeans(m.at))}</p>
      <p class="hint">Its history says it moved; the day first promised still counts in Numbers.</p>
      <div class="sms-note">${esc(m.clock === false ? 'The server has no clock here: jobs move when a shop phone opens the app on a new day.' : last)}</div></div>
    <div class="card row-between">
      <div class="menu-title">Text the customer when it moves</div>${seg('data-act="textset" data-f="carried"', s.carried)}</div>
    <div class="card"><div class="sms-note">${esc(s.auto ? (smsSender() ? '✓ This phone sends it, the next time the app opens after the move.' : 'The sending phone sends it, the next time its app opens after the move.')
      : 'Texts are off: Admin → Texts → Send texts by themselves.')}</div></div>
    ${textWordsCard('words_carried', 'carried', 'The apology')}`;
}
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
  const words = textWordsCard;
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
  if (e.target.dataset && e.target.dataset.movert) moverAt(e.target.dataset.movert, e.target.value);   // 41, 42
});
function saveMover(on, at){
  write('set_job_mover', {p_on: on, p_at: at}, 'Job mover — ' + (on ? clock12(at) : 'off'), ['mover'], db => {
    db.settings = {...(db.settings || {}), job_mover: {...moverSet(), on, at}};
  });
}
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
  editbooking: panelEditBooking, service: panelService, quote: panelQuote, jobquote: panelQuote, jobbill: panelQuote, utype: panelUtype, ppcrop: panelPpcrop,
  bookingstatus: panelStatus, jobstatus: panelStatus,
  cancel: panelCancel, customer: panelCustomer, forget: panelForget, tidy: panelTidy, member: panelMember,
  book: panelBook, editjob: panelEditJob, settings: panelSettings, addcust: panelAddCust, editcust: panelEditCust,
  deljob: panelDelete, delbooking: panelDelete, text: panelText, textall: panelTextAll,
  assign: panelAssign, donephoto: panelDonePhoto, custunit: panelCustUnit, unitfield: panelUnitField,   // 39, 43, 44
  variant: panelVariant,   // 54
  jobsign: panelJobSign, sigdraw: panelSigDraw,   // 47
  jobreport: panelReport,   // 57
  askjob: panelAskJob, askanswer: panelAskAnswer,   // 49
  ...(window.FX_PANELS || {})};   // 50: name effects, web/namefx.js
const SMALL = new Set(['reject', 'schedule', 'price', 'cancel', 'forget', 'tidy', 'deljob', 'delbooking', 'assign', 'donephoto']);
// the customer's page's width, for the screens that ARE the customer's page (ui.md, Reuse)
const WIDE = new Set(['book', 'editjob', 'editbooking']);
// in the middle of the screen, like a message, at every width (Reschedule, Guile 2026-10-11)
const MID = new Set(['schedule']);
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
  if (viewer){ closeViewer(true); return; }   // the work photo viewer (39)
  if (stack.length){ stack.pop(); render(); }
});
const FX_KEEP = new Set(['namefx', 'fxwheel']);
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
    el.className = 'sheet' + (SMALL.has(p.kind) ? ' small' : '') + (MID.has(p.kind) ? ' mid' : '') + (WIDE.has(p.kind) ? ' wide' : '');
    el.style.zIndex = String(40 + i * 2);   // on top of the one below it, by depth (ui.md)
    let out = null;
    const body = $('.sheet-body', el);
    if (FX_KEEP.has(p.kind)){
      // 50: the effect screens are redrawn by their own taps; a redraw from here (a pull every
      // 30 s) rebuilds fifty animated looks only when something on them really changed
      out = PANELS[p.kind](p);
      if (body._fxBody !== out.body){ body._fxBody = out.body; keepTyping(body, () => out.body); }
    } else keepTyping(body, () => {
      out = (PANELS[p.kind] || (() => ({title: '', body: ''})))(p);
      return out.body;
    });
    if (out){
      if (out.titleHtml) $('.sheet-title', el).innerHTML = out.titleHtml;   // a name wearing its effect (50)
      else $('.sheet-title', el).textContent = out.title || '';
      $('.sheet-sub', el).textContent = out.sub || '';
      $('.sheet-info', el).innerHTML = out.info ? infoBtn(out.info) : '';
    }
  });
  lockBody();
  if (typeof fxIdleUnder === 'function') fxIdleUnder();   // names under the top screen stop (50)
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
  resched: id => openPanel({kind: 'schedule', id}),
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
    saveTexts({[f]: on}, {auto: 'by themselves', before_on: 'the day before', today_on: 'on the day', booked: 'when scheduled', price: 'the price', carried: 'when moved'}[f] + (on ? ' on' : ' off'));
    if (f === 'auto' && on && !smsSender()) toast('Turned on. Now, on the owner\'s phone: Settings → This phone sends the texts.');
  },
  moverap: (id, el) => moverAt('ap', el.dataset.v),   // 42
  staffphotooff: (id, el) => { if (confirmTwice(el, 'Tap again to take it off')) setStaffPhoto(id, null); },   // 51
  shareapk: () => { if (inApk && window.AndroidBridge.shareApk) window.AndroidBridge.shareApk(); },   // 49
  sharelink: async (id, el) => {   // 0.4.1: the release's own download link, as text into any chat
    const url = apkLink(); if (!url) return;
    const text = 'Winter Air — the shop’s app for Android. Tap to download, then open the file to install:\n' + url;
    if (inApk && window.AndroidBridge.shareText) return window.AndroidBridge.shareText('Winter Air — download link', text);
    if (navigator.share){ try { await navigator.share({title: 'Winter Air', text}); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
    copyText(url, el);
  },
  // ---- check-in (56)
  timeclock: (id, el) => timeClock(el.dataset.v),
  ckday: (id, el) => { const p = topPanel(); if (p){ p.ckDay = el.dataset.v; p.ckEdit = null; p.ckTime = null; render(); } },
  ckmonth: (id, el) => {
    const p = topPanel(); if (!p) return;
    const [y, m] = (p.ckMonth || manilaDate(0).slice(0, 7)).split('-').map(Number), d = new Date(Date.UTC(y, m - 1 + Number(el.dataset.v), 1));
    p.ckMonth = d.toISOString().slice(0, 7); render();
  },
  ckedit: id => { const p = topPanel(); if (p){ p.ckEdit = id || null; p.ckTime = null; render(); } },
  cksave: (id, el) => {
    const p = topPanel(), t = p && db.team[p.id], day = el.dataset.day; if (!t || !day) return;
    if (id !== 'new' && !db.checkins[id]){ toast('That time is no longer on this phone.', true); return; }
    const box = $('#panels [data-pf="ckTime"]'), v = (box && box.value) || p.ckTime || '';
    if (!/^\d{2}:\d{2}$/.test(v)){ toast('Pick a time first.', true); return; }
    const kind = el.dataset.v;
    let at = new Date(day + 'T' + v + ':00+08:00');
    // a time out before the day's time in is after midnight: the next morning
    const din = ckRows(t.id, day).find(k => !k.job_id && !k.removed_at && k.kind === 'in');
    if (kind === 'out' && din && at < new Date(din.at)) at = new Date(at.getTime() + 864e5);
    if (at > new Date()){ toast('Pick a time that has already happened.', true); return; }
    const iso = at.toISOString(), kid = id === 'new' ? uuid() : id;
    write('edit_checkin', {p_id: kid, p_uid: t.id, p_kind: kind, p_day: day, p_at: iso, p_remove: false, p_decided_at: null},
      (kind === 'in' ? 'Time in ' : 'Time out ') + clockOf(iso) + ' — ' + (t.display_name || 'them'), [kid], (db, op) => {
        const was = db.checkins[kid];
        db.checkins[kid] = {...(was || {id: kid, uid: t.id, day: day, kind, job_id: null, by_uid: session.uid}), at: iso,
          history: [...((was && was.history) || []), {at: op.at, by: session.uid, from: was ? was.at : null, to: iso}]};
      });
    p.ckEdit = null; p.ckTime = null; render();
  },
  ckremove: (id, el) => {
    const k = db.checkins[id], t = k && db.team[k.uid]; if (!k) return;
    if (!confirmTwice(el, 'Remove it?')) return;
    write('edit_checkin', {p_id: id, p_remove: true, p_decided_at: null},
      'Removed ' + (k.kind === 'in' ? 'a time in' : 'a time out') + ' — ' + ((t && t.display_name) || 'them'), [id], (db, op) => {
        db.checkins[id] = {...k, removed_at: op.at, history: [...(k.history || []), {at: op.at, by: session.uid, from: k.at, to: null}]};
      });
  },
  ckback: id => {   // a time taken off by mistake: the same time, back
    const k = db.checkins[id], t = k && db.team[k.uid]; if (!k || !k.removed_at) return;
    write('edit_checkin', {p_id: id, p_at: k.at, p_remove: false, p_decided_at: null},
      'Brought back ' + (k.kind === 'in' ? 'a time in' : 'a time out') + ' — ' + ((t && t.display_name) || 'them'), [id], (db, op) => {
        db.checkins[id] = {...k, removed_at: null, history: [...(k.history || []), {at: op.at, by: session.uid, from: null, to: k.at}]};
      });
  },
  ckrule: (id, el) => {
    const on = el.dataset.v === 'true'; if (!!(db.checkinRules || {}).require_location === on) return;
    write('set_checkin_rule', {p_key: 'checkin_require_location', p_on: on}, 'Require location — ' + (on ? 'on' : 'off'), ['ckrule'], db => {
      db.checkinRules = {...(db.checkinRules || {}), require_location: on};
    });
  },
  techrule: (id, el) => {   // 49
    const k = el.dataset.f, on = el.dataset.v === 'true', now = jobRules();
    if ({tech_edit_others: now.others, tech_request: now.ask, tech_reward: now.reward}[k] === on) return;
    const what = {tech_edit_others: 'Technicians edit other jobs', tech_request: 'Technicians ask for jobs', tech_reward: 'Technicians see what they receive'}[k];
    write('set_tech_rule', {p_key: k, p_on: on}, what + ' — ' + (on ? 'yes' : 'no'), ['techrule:' + k], db => {
      db.settings = {...(db.settings || {}), [k]: on};
    });
  },
  moverset: (id, el) => {   // 41
    const on = el.dataset.v === 'true', m = moverSet();
    if (!!m.on === on) return;
    saveMover(on, m.at);
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
  // ---- the appliance list (27)
  savetype: id => {
    const p = topPanel(); if (!p || p.kind !== 'utype') return;
    const label = String(p.label || '').trim();
    if (!label || label.length > 40 || /[<>"&]/.test(label)){ notice('Give it a name, up to 40 letters, without < > " or &. Nothing was saved.', true); return; }
    if (typeRows().some(x => x.label.toLowerCase() === label.toLowerCase() && x.key !== id)
        || (!id && typeRows().some(x => x.key.toLowerCase() === label.toLowerCase()))){
      notice('There is already one called ' + label + '. Nothing was saved.', true); return;
    }
    const t = id ? typeOf(id) : null;
    if (t){ saveType(t, {label, icon: p.icon}, 'Appliance — ' + label); closePanel(); return; }
    // a new one: its first name is its key, for good (27); its services are its own, added next (54)
    const sort = Math.max(0, ...typeRows().map(x => x.sort || 0)) + 10;
    write('save_unit_type', {p_key: null, p_label: label, p_icon: p.icon, p_active: true, p_sort: sort},
      'Appliance — ' + label, ['type:' + label], db => {
        if (!db.types || !db.types.length) db.types = BUILTIN_TYPES.map((x, n) => ({...x, active: true, sort: (n + 1) * 10}));
        db.types.push({key: label, label, icon: p.icon, active: true, sort, services: [], variants: [], legacy: {}});
      });
    closePanel();
    toast(label + ' is added. Open it and add its services — it shows on the booking page once it has one.');
  },
  // ---- Appliances & services (54)
  opennew: (id, el) => openPanel({kind: el.dataset.kind, id: '', for: el.dataset.for}),
  drag: () => {},   // the ⠿ handle: holding it drags; a tap does nothing
  vartick: (id, el) => {
    const p = topPanel(); if (!p || p.kind !== 'variant') return;
    const k = el.dataset.v; p.ticks = p.ticks.includes(k) ? p.ticks.filter(x => x !== k) : [...p.ticks, k];
    render();
  },
  savevariant: (id, el) => {
    const p = topPanel(); if (!p || p.kind !== 'variant') return;
    const label = String(p.label || '').trim(), k = p.type, v = variantOf(k, p.vid);
    if (!label || label.length > 40 || /[<>"&]/.test(label)){ notice('Give the type a name, up to 40 letters, without < > " or &. Nothing was saved.', true); return; }
    if (variantsOf(k).some(x => x.id !== p.vid && x.label.toLowerCase() === label.toLowerCase())){
      notice('There is already a type called ' + label + '. Nothing was saved.', true); return;
    }
    const active = el.dataset.v === 'remove' ? false : el.dataset.v === 'back' ? true : !(v && v.active === false);
    if (active && !p.ticks.length){ notice('Tick at least one service this type offers. Nothing was saved.', true); return; }
    const services = {};
    for (const s of p.ticks){
      const raw = String(p['vp_' + s] || '').trim();
      if (!raw){ services[s] = null; continue; }
      const n = parsePrice(raw);
      if (n == null){ notice('The ' + svcLabel(s) + ' price “' + raw + '” is not a number I can read. Nothing was saved.', true); return; }
      services[s] = n;
    }
    write('save_variant', {p_id: p.vid, p_unit_type: k, p_label: label, p_active: active, p_services: services}, 'Type — ' + label, ['type:' + k], db => {
      const t = (db.types || []).find(x => x.key === k); if (!t) return;
      const list = t.variants || (t.variants = []);
      let x = list.find(y => y.id === p.vid);
      if (!x){ x = {id: p.vid, sort: Math.max(0, ...list.map(y => y.sort || 0)) + 10}; list.push(x); }
      Object.assign(x, {label, active, services: [...p.ticks],
        prices: Object.fromEntries(Object.entries(services).filter(([, n]) => n != null))});
    });
    closePanel();
    toast(!active ? label + ' is off the booking page. Bring it back any time.' : 'Saved — ' + label);
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
    render(); toast('The lines are the ' + (src.bill ? 'job' : 'booking') + '’s aircons again, at the price list’s prices.');
  },
  savequote: () => {
    const p = topPanel(), src = p && p.q && quoteSrc(p); if (!src) return false;
    const Word = src.word[0].toUpperCase() + src.word.slice(1);
    if (!src.open){ toast(src.bill ? 'Only the office changes the billing statement.' : 'This ' + (src.job ? 'job' : 'booking') + ' is ' + src.state + ': the quotation stays as it was.', true); return false; }
    const {q, bad} = quoteCheck(p.q);
    if (bad){ toast(bad + ' Nothing was saved.', true); return false; }
    const row = src.row, v = (row[src.field] && row[src.field].v) || 0, total = qtTotal(q.lines);
    // the billing statement goes through the quotation's own cleaner on the server (45)
    write(src.fn, {[src.arg]: row.id, [src.bill ? 'p_bill' : 'p_quote']: q, p_based_on: v}, Word + ' for ' + src.name, [row.id], () => {
      row[src.field] = {...q, v: v + 1, total, saved_at: new Date().toISOString(), saved_by_name: (db.profile || {}).display_name || ''};
      if (src.job) row.price = total;   // a job's quotation — or billing statement — is its price (26, 45)
    });
    p.dirty = false;
    toast(src.job ? Word + ' saved — the job’s price is now ' + peso(total) + '.' : 'Quotation saved.');
    return true;
  },
  printquote: () => quotePaper(false),
  sharequote: () => quotePaper(true),
  wordquote: () => quoteWord(),   // 39
  // ---- the service report (57)
  repseg: (k, el) => {   // Residential / Commercial, Service / Maintenance call: tap again to clear
    const p = topPanel(); if (!p || !p.r || !['kind', 'call'].includes(k)) return;
    p.r[k] = p.r[k] === el.dataset.v ? '' : el.dataset.v; p.dirty = true; render();
  },
  savereport: () => saveReport(),
  printreport: () => reportPaper(false),
  sharereport: () => reportPaper(true),
  delreport: (id, el) => {
    const p = topPanel(); if (!p || p.kind !== 'jobreport') return;
    const {j, saved} = reportFind(p); if (!j || !saved || db.role !== 'admin') return;
    if (!confirmTwice(el, 'Take it off? Tap again')) return;
    const jid = j.id, rid = saved.id;
    write('save_service_report', {p_job: jid, p_report: {id: rid}, p_based_on: saved.v || 0, p_remove: true},
      'Service report taken off — ' + (jobCust(j).full_name || 'job'), [jid], db => {
        const jj = db.jobs[jid]; if (!jj) return;
        jj.reports = reportsOf(jj).filter(y => y.id !== rid);
        const s = {...(jj.signed || {})}; delete s['r:' + rid]; jj.signed = s;
      });
    closePanel();
    toast('Service report ' + reportNo(saved) + ' taken off.');
  },
  savereportset: key => {
    const set = db.settings || {};
    let v;
    if (key === 'report_next'){
      const t = String(val('rp_next') || '').trim();
      if (!/^\d{1,7}$/.test(t) || Number(t) < 1) return toast('The next number is a whole number, like 2013.', true);
      v = Number(t);
    } else if (key === 'report_items'){
      v = String(val('rp_items') || '').split('\n').map(x => x.trim()).filter(Boolean);
      if (!v.length || v.length > 40) return toast('Keep 1 to 40 ticks, one per line.', true);
    } else if (key === 'report_note') v = String(val('rp_note') || '').trim();
    else return;
    if (JSON.stringify(set[key]) === JSON.stringify(v)) return toast('Nothing changed.');
    write('set_report_setting', {p_key: key, p_value: v}, 'Service report — ' + {report_next: 'the next number', report_items: 'the ticks', report_note: 'the certify line'}[key],
      [key], db => { db.settings = {...(db.settings || {}), [key]: v}; });
    toast('Saved.');
  },
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
    const old = p.id ? svcRows().find(x => x.key === p.id) : null, own = old ? old.unit_type : p.for;
    const prices = {};
    // 54: its own appliance's price, while that has no types — a type carries its own
    if (own && !activeVariants(own).length){
      const raw = String(p.price || '').trim(), v = raw ? parsePrice(raw) : null;
      if (raw && v == null){ notice('The price “' + raw + '” is not a number I can read. Nothing was saved.', true); return; }
      prices[own] = v;
    }
    const key = p.id || (label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'svc')
      + '_' + Math.random().toString(16).slice(2, 6);
    const active = p.active !== '0';
    const op = write('save_service', {p_key: key, p_label: label, p_active: active, p_prices: prices, ...(old ? {} : {p_unit_type: own})}, 'Service — ' + label, ['svc:' + key], db => {
      const list = db.services || (db.services = []);
      let r = list.find(x => x.key === key);
      if (!r){ r = {key, unit_type: own, origin: null, sort: Math.max(0, ...list.filter(x => x.unit_type === own).map(x => x.sort || 0)) + 10};
        list.push(r);
        // a new service is its appliance's own, and offered there (54)
        const t = (db.types || []).find(x => x.key === own); if (t && Array.isArray(t.services) && !t.services.includes(key)) t.services.push(key); }
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
  chkstarter: () => { const p = topPanel(), l = p && starterOf(p); if (l){ p.check = [...l]; render(); } },
  viewas: (id, el) => { ui.viewAs = el.dataset.v; ui.viewMenu = false; saveUi(); render(); },
  viewmenu: () => { ui.viewMenu = !ui.viewMenu; render(); },
  inbox: (id, el) => { ui.inbox = el.dataset.v; saveUi(); render(); },
  day: (id, el) => { ui.day = el.dataset.v; saveUi(); render(); },
  techday: (id, el) => { ui.techDay = el.dataset.v; saveUi(); render(); },
  ckview: (id, el) => { ui.ck = el.dataset.v; saveUi(); render(); },
  gostat: (id, el) => {
    if (el.dataset.tab === 'inbox') ui.inbox = el.dataset.v || 'new';
    if (el.dataset.tab === 'jobs') ui.day = el.dataset.v || 'today';
    goTab(el.dataset.tab);
  },

  open: (id, el) => {
    // The first time the office opens a new booking, Full status says who saw it (15).
    const b = el.dataset.kind === 'booking' && db && db.role === 'admin' && db.bookings[id];
    // 52: each person of the office who opens a new booking — not only the first (Guile,
    // 2026-10-12: "who seen the inbox?"). Once per person, remembered on this phone; the
    // server keeps it to one line each anyway.
    const mine = lsGet('ws_bseen', []);
    if (b && b.status === 'new' && !mine.includes(id)){
      if (!b.seen_at) b.seen_at = new Date().toISOString();
      lsSet('ws_bseen', mine.concat([id]).slice(-300));
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
      if (j && assignUnseen(j)) markSeen('assign', id, j.assigned_at);   // the ⚠️ goes (39)
    }
    if (k === 'member') markSeen('users', id);
    if (k === 'customer') seenCheckup(id);
    openPanel({kind: k, id});
  },
  // ---- the aircon cart (15)
  unitnew: (id, el) => {
    const cart = el.dataset.cart;
    if (cartUnits(cart).length >= 20){ notice('That is more than 20 aircons — please ring the shop for a bigger job.', true); return; }
    unitEd = {cart, index: -1, unit: {type: el.dataset.v, services: [], brand: '', model: '', serial: '', extra: '', problem: ''}};
    // 43: a known customer with that type saved — ask which one first
    const cid = cartCustomer(cart), taken = new Set(cartUnits(cart).map(x => x.cu).filter(Boolean));
    if (cid && savedUnits(cid).some(x => x.type === el.dataset.v && !taken.has(x.id))) unitEd.pick = true;
    drawUnitSheet();
  },
  unitpick: (id, el) => {   // 43
    if (!unitEd) return;
    const x = el.dataset.v && savedOf(cartCustomer(unitEd.cart), el.dataset.v);
    if (x) Object.assign(unitEd.unit, {brand: x.brand || '', model: x.model || '', serial: x.serial || '', extra: x.extra || '', problem: x.problem || '', cu: x.id,
                                       specs: {...(x.specs || {})}});   // 44
    unitEd.pick = false; drawUnitSheet();
  },
  notesmore: (id, el) => { const k = el.dataset.v; if (openNotes.has(k)) openNotes.delete(k); else openNotes.add(k); if (unitEd) drawUnitSheet(); render(); },
  unitedit: (id, el) => {
    const u = cartUnits(el.dataset.cart)[+el.dataset.i]; if (!u) return;
    // 54: an old job's shared service is this appliance's own now, so it shows once, ticked
    unitEd = {cart: el.dataset.cart, index: +el.dataset.i, unit: {...u, services: [...new Set(u.services.map(k => ownKey(u.type, k)))]}};
    drawUnitSheet();
  },
  unitvar: (id, el) => {   // 54: its type; the services it does not offer come off
    if (!unitEd) return;
    const u = unitEd.unit, v = variantOf(u.type, el.dataset.v);
    if (v){ u.variant = v.id; u.services = u.services.filter(k => (v.services || []).includes(k)); } else delete u.variant;
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
    const clean = {...unitCopy(u), brand: tr(u.brand), model: tr(u.model), serial: tr(u.serial), extra: tr(u.extra), problem: tr(u.problem)};
    // 44: his boxes, trimmed; empty ones and ones not on this type go
    const ok = new Set(fieldsFor(unitEd.cart, u.type).map(f => f.key)), sp = {};
    Object.entries(u.specs || {}).forEach(([k, v]) => { if (ok.has(k) && String(v || '').trim()) sp[k] = String(v).trim(); });
    if (Object.keys(sp).length) clean.specs = sp; else delete clean.specs;
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
    const bad = custProblems(p);
    if (bad.length) return bkShow('panel', p, bad);
    const same = Object.values(db.customers).find(c => digits(c.contact) === digits(p.contact));
    if (same && p._dup !== same.full_name){ p._dup = same.full_name; render(); return; }
    const id = uuid(), on = !!(p.ck_every && p.ck_next);
    const d = {...custDetails(p),
      check_every: on ? p.ck_every : null, check_next: on ? p.ck_next : null, check_day: on ? (p.ck_day || Number(p.ck_next.slice(8, 10))) : null};
    write('add_customer', {p_id: id, p_details: d}, 'Add customer — ' + d.full_name, [id], db => {
      db.customers[id] = {id, ...d, landmark: d.landmark || null, created_at: new Date().toISOString()};
    });
    closePanel();
    toast(d.full_name + ' added' + (on ? ' — checked ' + everyWord(d.check_every) + ', first ' + niceDate(d.check_next) + '.' : '.'));
  },
  saveeditcust: id => {   // 53
    const p = topPanel(), c = db.customers[id]; if (!p || p.kind !== 'editcust' || !c) return;
    const bad = custProblems(p);
    if (bad.length) return bkShow('panel', p, bad);
    const same = Object.values(db.customers).find(x => x.id !== id && digits(x.contact) === digits(p.contact));
    if (same && digits(p.contact) !== digits(c.contact) && p._dup !== same.full_name){ p._dup = same.full_name; render(); return; }
    const d = custDetails(p);
    const now = {...d, landmark: d.landmark || null, lat: d.lat != null ? Number(d.lat) : null, lng: d.lng != null ? Number(d.lng) : null};
    write('edit_customer', {p_customer: id, p_details: d}, 'Edit customer — ' + d.full_name, [id], db => {
      if (db.customers[id]) Object.assign(db.customers[id], now);
      Object.values(db.jobs).forEach(j => { if (j.customer_id === id && j.customer) Object.assign(j.customer, now); });
    });
    closePanel();
    toast(d.full_name + ' saved.');
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
  setshare: id => {   // 49
    const t = db.team[id], p = topPanel(); if (!t || !p) return;
    const raw = String(p.pct != null ? p.pct : '').trim().replace(/%$/, '');
    if (!raw) return toast('Type the percent first.', true);
    // refuse what cannot be read — never strip it into a number (docs/rules/schema.md)
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(raw) || Number(raw) > 100) return toast('A share is a number from 0 to 100, like 10 or 12.5.', true);
    const pct = Number(raw);
    write('set_share_pct', {p_user: id, p_pct: pct}, 'Share ' + pct + '% — ' + (t.display_name || t.email || ''), [id], () => { t.share_pct = pct; });
    p.pct = null;
    toast((t.display_name || 'Their') + ' share: ' + pct + '%.');
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
    const pics = (p.pics || []).slice(0, BK_PIC_MAX);   // 53: the same pictures piece as the page
    if (pics.length){
      details.photos = pics.map(x => x.b64);
      bkPicCache[bid] = pics.map((x, i) => { const path = 'bk/' + bid + '/' + (i + 1); photoUrls[path] = x.url; return {path, b64: x.b64}; });
    }
    write('office_booking', {p_id: bid, p_details: details}, 'Booked by phone — ' + name, [bid], db => {
      const now = new Date().toISOString(), who = fresh ? details : c;
      db.bookings[bid] = {id: bid, ref: '…', source: 'office', status: 'new', for_customer: fresh ? null : c.id,
        full_name: name, contact: who.contact, address: who.address, landmark: who.landmark || null,
        lat: fresh ? (p.lat ? +p.lat : null) : c.lat, lng: fresh ? (p.lng ? +p.lng : null) : c.lng,
        services: unionServices(units), units, unit_count: units.length, notes: details.notes || null,
        preferred_on: details.date, slot: details.slot || 'am', seen_at: now, created_at: now, updated_at: now, photo_count: pics.length};
    });
    ui.tab = 'inbox'; ui.inbox = 'new'; saveUi();
    replacePanel({kind: 'booking', id: bid});
    toast('In the Inbox as a booking — make the quotation, then Accept.');
  },
  schedule: id => {
    const j = db.jobs[id], p = topPanel(); if (!j || !p) return;
    const d = p.date != null ? p.date : j.scheduled_on, s = p.slot || j.slot || 'am';
    if (!d && !j.scheduled_on){ notice('Choose a day first. Nothing was changed.', true); return; }
    if (!d){   // ⏳ Waiting (48): the day goes, the time stays, back to No date — no text
      if (j.status === 'in_progress'){ notice('This job has started — it keeps its day.', true); return; }
      write('schedule_job', {p_job: id, p_date: null, p_slot: j.slot, p_decided_at: null},
        'Waiting — ' + (jobCust(j).full_name || 'job'), [id], () => {
          j.scheduled_on = null; j.promised_on = null; j.status = 'booked';
        });
      closePanel();
      toast('Waiting — back in No date until a day is chosen.');
      return;
    }
    if (!isClock(s) && s !== j.slot){ bkShow('panel', p, [['slot', 'Choose the hour.']]); return; }
    if (d === j.scheduled_on && s === j.slot){ closePanel(); toast('Same day and time — nothing was changed.'); return; }
    const how = schedText(j), key = 'booked:' + d + ' ' + s, moved = !!j.scheduled_on;
    // before the move, so the sending phone never sees the move without the "no"
    if (how === 'auto' && !p.texton) textKept(id, key, false, 'Not texted — the office chose no text');
    write('schedule_job', {p_job: id, p_date: d, p_slot: s, p_decided_at: null},
      'Schedule ' + (jobCust(j).full_name || 'job'), [id], () => {
        j.scheduled_on = d; j.slot = s; j.promised_on = null;   // a day changed by hand (41)
        if (j.status === 'booked') j.status = 'scheduled';
      });
    if (how === 'hand' && p.texton){ replacePanel({kind: 'text', id, text: textCompose(j, 'booked', manilaDate(0))}); return; }
    closePanel();
    toast((moved ? 'Moved to ' : 'Scheduled for ') + niceDate(d) + ', ' + slotWord(s)
      + (how === 'auto' && p.texton ? ' — the customer gets a text.' : '.'));
  },
  // ---- the customer's signature (47)
  sigpen: (id, el) => { penSet.pen = el.dataset.v === 'ballpoint' ? 'ballpoint' : 'fountain'; lsSet('ws_pen', penSet); render(); },
  sigundo: () => { const p = topPanel(); if (p && p.kind === 'sigdraw' && p.strokes){ p.strokes.pop(); render(); } },
  sigclear: () => { const p = topPanel(); if (p && p.kind === 'sigdraw'){ p.strokes = []; render(); } },
  sigsave: () => {
    const p = topPanel(); if (!p || p.kind !== 'sigdraw' || !(p.strokes || []).length) return;
    const png = sigPng(p.strokes);
    if (!png){ toast('Nothing to save — sign in the white box first.', true); return; }
    const [jid, paper] = String(p.id).split('|');
    closePanel();
    saveCustSig(jid, paper, png, p.name);
  },
  sigoff: id => { const p = topPanel(); if (p && (p.kind === 'jobsign' || p.kind === 'jobreport')){ p.ask = String(id).split('|')[1]; render(); } },   // asks first
  sigoffno: () => { const p = topPanel(); if (p){ p.ask = null; render(); } },
  sigoffyes: id => {
    const [jid, paper] = String(id).split('|'), j = db.jobs[jid], p = topPanel();
    if (p) p.ask = null;
    if (!j || !sigPaper(paper)) return;
    write('sign_job', {p_job: jid, p_paper: paper, p_png: null, p_name: null},
      'Signature taken off the ' + sigPaper(paper).toLowerCase() + ' — ' + (jobCust(j).full_name || 'job'), [jid],
      () => { const s = {...(j.signed || {})}; delete s[paper]; j.signed = s; });
  },
  mapopen: (id, el) => showMapChoice(el.dataset.href, el.dataset.waze, !!el.dataset.pinned, el.dataset.landmark),
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
  usersmap: () => usersMap(),   // 58
  askloc: id => askLocation(id),
  locallow: () => allowLocation(),
  loclater: () => { lsSet('ws_loc_once', true); ui.locLater = true; render(); },
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
    // "Wanna add work photos?" — optional, Cancel any time (39)
    if (to === 'done' && canWorkPhoto(j) && workList(j).length < WORK_MAX) openPanel({kind: 'donephoto', id});
  },
  // ---- Assigned to (39)
  assignopen: id => { if (db.jobs[id]) openPanel({kind: 'assign', id}); },
  // ---- the crew (46)
  crewtoggle: (id, el) => {
    const p = topPanel(); if (!p || p.kind !== 'assign' || !p.sel) return;
    const v = el.dataset.v, i = p.sel.indexOf(v);
    if (i >= 0) p.sel.splice(i, 1); else p.sel.push(v);
    render();
  },
  crewclear: () => { const p = topPanel(); if (p && p.sel){ p.sel = []; render(); } },
  crewhead: (id, el) => {
    const p = topPanel(), j = db.jobs[id], v = el.dataset.v; if (!j || !canAssign(j)) return;
    if (db.role === 'admin' && p && p.sel){ p.sel = [v, ...p.sel.filter(x => x !== v)]; render(); return; }
    crewWrite(j, 'head', v, null, staffName(v) + ' is the head');
  },
  // (49) asking for a job, and the office's answer
  askjob: id => { if (db.jobs[id]) openPanel({kind: 'askjob', id}); },
  askopen: id => { if (db.jobs[id]) openPanel({kind: 'askanswer', id}); },
  jobask: id => {
    const j = db.jobs[id]; if (!j || iAsked(j)) return;
    write('request_job', {p_job: id, p_ask: true}, 'Asked for — ' + (jobCust(j).full_name || 'job'), [id], () => {
      j.requests = (j.requests || []).concat([{uid: session.uid, at: new Date().toISOString()}]);
    });
    toast('Asked. The office sees it on the job.');
  },
  jobunask: id => {
    const j = db.jobs[id]; if (!j) return;
    write('request_job', {p_job: id, p_ask: false}, 'Request taken back — ' + (jobCust(j).full_name || 'job'), [id], () => {
      j.requests = (j.requests || []).filter(r => r.uid !== session.uid);
    });
  },
  askyes: (id, el) => {
    const j = db.jobs[id], who = el.dataset.v; if (!j || !who) return;
    write('answer_request', {p_job: id, p_who: who, p_yes: true}, 'Assigned ' + staffName(who) + ' — ' + (jobCust(j).full_name || 'job'), [id], () => {
      const next = crewOf(j).filter(x => x !== who).concat([who]);
      j.crew = next; j.assigned_uid = next[0]; j.assigned_by = session.uid; j.assigned_at = new Date().toISOString();
      j.requests = (j.requests || []).filter(r => r.uid !== who);
    });
    toast(staffName(who) + ' is on the job.');
    if (!askedBy(j).length) closePanel();
  },
  askno: (id, el) => {
    const j = db.jobs[id], who = el.dataset.v; if (!j || !who) return;
    write('answer_request', {p_job: id, p_who: who, p_yes: false}, 'Said no to ' + staffName(who) + ' — ' + (jobCust(j).full_name || 'job'), [id], () => {
      j.requests = (j.requests || []).filter(r => r.uid !== who);
    });
    if (!askedBy(j).length) closePanel();
  },
  crewjoin: id => { const j = db.jobs[id]; if (j && canAssign(j)) crewWrite(j, 'join', session.uid, null, 'You joined as a helper'); },
  crewleave: id => { const j = db.jobs[id]; if (j && canAssign(j)) crewWrite(j, 'leave', session.uid, null, 'You left the crew'); },
  crewsave: id => {
    const p = topPanel(), j = db.jobs[id]; if (!p || !p.sel || !j) return;
    crewWrite(j, 'set', null, p.sel.slice(), p.sel.length ? 'Crew: ' + p.sel.map(staffName).join(', ') : 'No assign');
    closePanel();
  },
  workview: (id, el) => openViewer(id, el.dataset.v),
  // the search's chips and its × (2026-10-10)
  custtype: (id, el) => { const s = $('#custSearch'); ui.search = fold(ui.search || '').trim() === fold(el.dataset.v) ? '' : el.dataset.v; saveUi();
    if (s) s.value = ui.search; custSearchDraw(); },
  custclear: () => { ui.search = ''; saveUi(); const s = $('#custSearch'); if (s){ s.value = ''; s.focus(); } custSearchDraw(); },
  houseview: (id, el) => openViewer(null, 0, el.dataset.v),
  custview: (id, el) => openViewer(null, el.dataset.v, null, {cid: id}),   // 53
  bkview: (id, el) => openViewer(null, el.dataset.v, null, {bk: id}),      // 53
  bkpicx: (id, el) => {   // a picture taken out of the booking form before it is sent
    const ctx = el.dataset.cart, s = bkState(ctx); if (!s || !s.pics) return;
    const [x] = s.pics.splice(Number(el.dataset.v), 1);
    if (x) URL.revokeObjectURL(x.url);
    bkRedraw(ctx);
  },
  ufieldtype: (id, el) => {   // 44
    const p = topPanel(); if (!p || p.kind !== 'unitfield') return;
    const k = el.dataset.v; p.types = p.types.includes(k) ? p.types.filter(x => x !== k) : [...p.types, k]; render();
  },
  saveufield: (id, el) => {   // 44
    const p = topPanel(); if (!p || p.kind !== 'unitfield') return;
    const label = String(p.label || '').trim();
    if (!label){ notice('Give the box a name. Nothing was saved.', true); return; }
    if (!p.types.length){ notice('Tick at least one appliance it is on. Nothing was saved.', true); return; }
    const old = (db.unitFields || []).find(x => x.key === p.key);
    const removed = el.dataset.v === 'remove' ? true : el.dataset.v === 'back' ? false : !!(old && old.removed);
    const f = {key: p.key, label, types: [...p.types], long: !!p.long, public: !!p.pub, removed};
    // in its place: an edited box used to go to the end of the list (54, the order is his now)
    const list = (db.unitFields || []).some(x => x.key === f.key) ? db.unitFields.map(x => x.key === f.key ? f : x) : [...(db.unitFields || []), f];
    write('set_unit_fields', {p_fields: list}, 'Specs — ' + label, ['unitfields'], db => { db.unitFields = list; });
    closePanel();
    toast(removed ? 'Removed. Bring it back any time.' : 'Saved. It shows on the aircons you ticked.');
  },
  savecustunit: (id, el) => {   // 43
    const p = topPanel(); if (!p || p.kind !== 'custunit') return;
    const [cid] = String(p.id).split('|'), c = custOfId(cid);
    if (!p.type){ notice('Tap what it is first. Nothing was saved.', true); return; }
    const removed = el.dataset.v === 'remove' ? true : el.dataset.v === 'back' ? false : !!p.removed;
    const tr = v => String(v || '').trim();
    const unit = {id: p.uid, type: p.type, brand: tr(p.brand), model: tr(p.model), serial: tr(p.serial), extra: tr(p.extra),
                  problem: tr(p.problem), notes: tr(p.notes), removed,
                  specs: Object.fromEntries(Object.keys(p).filter(k => k.startsWith('spec_') && tr(p[k])).map(k => [k.slice(5), tr(p[k])]))};   // 44
    write('save_customer_unit', {p_customer: cid, p_unit: unit}, (removed ? 'Appliance removed — ' : 'Appliance — ') + ((c || {}).full_name || ''), [cid], db => {
      const row = db.customers[cid]; if (!row) return;
      const list = (row.units || []).filter(y => y.id !== unit.id);
      const clean = {...unit, updated_at: new Date().toISOString()};
      Object.keys(clean).forEach(k => { if (clean[k] === '') delete clean[k]; });
      if (!Object.keys(clean.specs || {}).length) delete clean.specs;
      row.units = [...list, clean];
    });
    closePanel();
    toast(removed ? 'Removed from their file. Bring it back any time.' : 'Saved on their file.');
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
Object.assign(ACTIONS, window.FX_ACTIONS || {});   // name effects (web/namefx.js, 50)

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
  if (t.dataset && t.dataset.pfspec){ const p = topPanel(); if (p) p['spec_' + t.dataset.pfspec] = t.value; return; }   // 44
  if (t.dataset && t.dataset.uspec && unitEd){ unitEd.unit.specs = {...(unitEd.unit.specs || {}), [t.dataset.uspec]: t.value}; return; }   // 44
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
  // the service report (57): the same, for its boxes and its ticks
  if (t.dataset && (t.dataset.rf || t.dataset.rtick != null)){
    const p = topPanel(); if (!p || !p.r) return;
    if (t.dataset.rf) p.r[t.dataset.rf] = t.value;
    else { const k = t.dataset.rtick; p.r.ticks = p.r.ticks.filter(x => x !== k).concat(t.checked ? [k] : []); }
    p.dirty = true;
    drawReportPreview(p);
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
  if (t.id === 'custSearch'){ ui.search = t.value; saveUi(); custSearchDraw(); }
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
  if (s.pics && s.pics.length) payload.photos = s.pics.map(x => x.b64);   // 53, optional

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
    el.innerHTML = pt.html || `<b>${esc(pt.label)}</b><span aria-hidden="true">${pt.icon || '🏠'}</span>`;
    el.addEventListener('click', ev => { ev.stopPropagation(); if (pt.onTap) pt.onTap(); });
    mapMarks.push(new maplibregl.Marker({element: el, anchor: pt.anchor || 'bottom'}).setLngLat([pt.lng, pt.lat]).addTo(mapObj));
  });
  hydratePhotos();   // 58: the people's pictures in their circles
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
window.wsShareFailed = why => toast('It did not go: ' + why + (/app|send a file/.test(why) ? '.' : '. Print or save as PDF still works.'), true);
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
