// Yoyo Collection — the event log's front end: the throw log ("used today")
// and the maintenance / contest / provenance timeline. Loaded by index.html
// BEFORE app.js; everything here is a function or a piece of state that app.js
// calls into, and nothing at the top level touches app.js until the page is
// running (so the load order only has to guarantee these names exist).
//
// Everything is owner-only. Public visitors never fetch any of it.
//
// How it hangs together:
//   - loadAll() (app.js) calls loadEventData() alongside /api/yoyos and hands
//     the result to applyEventData(), which fills the maps below.
//   - `throwDays` holds raw throw days for the last year — enough for every
//     ranking, the streak, the sparkline and the calendar's recent months.
//     Anything older is asked of the server as an aggregate (summary /
//     histogram) or fetched a month at a time, so the page never downloads a
//     decade of rows.
//   - Rankings (EDC, Collecting dust, Shelf queen, Most thrown) are computed
//     here on every render and stored nowhere.

// ---- State ----
const THROW_WINDOW_DAYS = 366;         // raw throw days kept in memory
let throwDays = new Map();             // yoyo uuid -> Set of 'YYYY-MM-DD'
let throwSummary = new Map();          // yoyo uuid -> { first_on, last_on, days } across all time
let sideEvents = [];                   // full rows of the rare types the collection views need (SIDE_TYPES)
let cleanAfterDays = 0;                // "Due for a clean" threshold from settings; 0 = off
let spanCache = new Map();             // from-day -> summary rows, for Most thrown's long spans
let histCache = new Map();             // query string -> histogram rows
let monthsFetched = new Set();         // 'YYYY-MM' months older than the window, fetched for the calendar
let dayCountCache = null;              // day -> how many yoyos were thrown (built lazily)
let detailEvents = null;               // the open yoyo's full log, or null while loading
let detailEventsFor = null;            // which yoyo id detailEvents belongs to

// Insights UI state (kept across re-renders).
let mostThrownSpan = 'year';
let trendMode = 'year';                // 'year' | 'month'
let trendYears = 1;                    // span shown when trendMode is 'month'
let throwCalMonth = null;              // first-of-month Date; null = this month
let throwCalSelected = null;           // 'YYYY-MM-DD' or null
let detailCalMonth = null;             // the detail view's own calendar month (null = closed)

// The rare types fetched collection-wide: loans badge the cards, cleans and
// bearing swaps feed "Due for a clean", contests fill the Competition record,
// and the rest only supply autocomplete values for the log form.
const SIDE_TYPES = ['lent', 'returned', 'clean', 'bearing', 'contest', 'milestone', 'autograph'];

// ---- Ranking thresholds (easy to tune; all judged on in-hand yoyos) ----
const EDC_MIN_DAYS = 15;            // thrown on at least this many of the last 30 days
const SHELF_QUEEN_MAX_DAYS = 2;     // at most this many throw-days in the last year…
const SHELF_QUEEN_OWNED_DAYS = 90;  // …and owned at least this long, so new arrivals aren't labelled
const DUST_DAYS = 90;               // Collecting dust: a real thrower (above the shelf-queen line) idle this long

const EV_SVG = (() => {
  const s = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  return {
    yoyo: s('<circle cx="12" cy="13.5" r="7.5"/><circle cx="12" cy="13.5" r="2.2"/><path d="M12 6V2.6"/>'),
    trophy: s('<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>'),
    wrench: s('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'),
    drop: s('<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/>'),
    alert: s('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
    user: s('<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
    clock: s('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
    calendar: s('<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>'),
    plus: s('<path d="M5 12h14"/><path d="M12 5v14"/>'),
    flame: s('<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>'),
    cart: s('<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>'),
  };
})();

// ---- Calendar-day helpers (built on app.js's localDay / parseDay / daysFromToday) ----
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return localDay(d); }
function yearsAgo(n) { const d = new Date(); d.setFullYear(d.getFullYear() - n); return localDay(d); }
// "today" / "yesterday" / "3 days ago" / "5 months ago" / "2 years ago" / "in 2 days".
function relativeDay(day) {
  const d = typeof day === 'string' ? parseDay(day) : day;
  if (!d) return '';
  const n = daysFromToday(d);
  if (n === 0) return 'today';
  if (n === -1) return 'yesterday';
  if (n === 1) return 'tomorrow';
  if (n > 1) return `in ${n} days`;
  const ago = -n;
  if (ago < 60) return `${ago} days ago`;
  if (ago < 730) return `${Math.round(ago / 30.44)} months ago`;
  return `${Math.floor(ago / 365.25)} years ago`;
}
// A stored day for display. `precision` ("month" / "year") marks an
// approximate date, stored as the first day of its period: show only what's known.
function formatDay(day, precision) {
  const d = parseDay(day);
  if (!d) return day || '';
  if (precision === 'year') return String(d.getFullYear());
  if (precision === 'month') return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function ordinal(n) {
  const v = Math.abs(Number(n)) % 100, s = ['th', 'st', 'nd', 'rd'];
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const yoyoName = (y) => `${y.brand || ''} ${y.model || ''}`.trim() || 'Untitled';
const jsonPost = (body, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// The event log's key for a yoyo. Events store the yoyo's uuid lowercased,
// while a yoyo's own uuid may be upper case (the Apple apps write it so).
const uid = (y) => String(y.uuid || '').toLowerCase();

// ---- Loading ----
// Fetched by loadAll() next to /api/yoyos. Returns null for visitors, and on
// any failure — the collection must still load if the log can't.
async function loadEventData() {
  if (!isOwnerState) return null;
  try {
    const [throws, summary, side] = await Promise.all([
      api(`/api/events?type=throw&from=${daysAgo(THROW_WINDOW_DAYS)}`),
      api('/api/events/summary?type=throw'),
      api(`/api/events?full=1&type=${SIDE_TYPES.join(',')}`),
    ]);
    return { throws, summary, side };
  } catch (err) {
    console.warn('event log unavailable:', err.message);
    return null;
  }
}
function applyEventData(ev) {
  throwDays = new Map();
  throwSummary = new Map();
  sideEvents = [];
  spanCache = new Map(); histCache = new Map(); monthsFetched = new Set(); dayCountCache = null;
  if (!ev) return;
  for (const t of ev.throws) addThrowDay(t.yoyo_uuid, t.occurred_on);
  for (const s of ev.summary) throwSummary.set(s.yoyo_uuid, s);
  sideEvents = ev.side;
}
function addThrowDay(uuid, day) {
  let set = throwDays.get(uuid);
  if (!set) throwDays.set(uuid, (set = new Set()));
  set.add(day);
}

// ---- Throws: reading ----
const NO_DAYS = new Set();
function throwsOf(y) { return throwDays.get(uid(y)) || NO_DAYS; }
function isThrown(y, day = localDay()) { return throwsOf(y).has(day); }
// Throw-days within the last `n` days, today included.
function throwCount(y, n) {
  const from = daysAgo(n - 1);
  let c = 0;
  for (const d of throwsOf(y)) if (d >= from) c++;
  return c;
}
// Is there any log at all? Until the first throw is recorded, every ranking,
// badge and card stays hidden — otherwise a fresh install would label the
// whole collection "Shelf queen".
function hasThrowLog() { return isOwnerState && throwSummary.size > 0; }
// How far back the log goes, in days.
function throwHistoryDays() {
  let first = '';
  for (const s of throwSummary.values()) if (!first || s.first_on < first) first = s.first_on;
  const d = parseDay(first);
  return d ? Math.max(0, -daysFromToday(d)) : 0;
}
// Consecutive days, ending today or yesterday, on which `has(day)` is true.
function streakOf(has) {
  let day = new Date();
  if (!has(localDay(day))) day.setDate(day.getDate() - 1); // today not logged yet doesn't break a streak
  let n = 0;
  while (has(localDay(day))) { n++; day.setDate(day.getDate() - 1); }
  return n;
}
// day -> number of yoyos thrown that day (live yoyos only).
function dayCounts() {
  if (dayCountCache) return dayCountCache;
  const live = new Set(yoyos.map(uid));
  dayCountCache = new Map();
  for (const [uuid, set] of throwDays) {
    if (!live.has(uuid)) continue;
    for (const d of set) dayCountCache.set(d, (dayCountCache.get(d) || 0) + 1);
  }
  return dayCountCache;
}
function collectionStreak() { const c = dayCounts(); return streakOf((d) => c.has(d)); }

// ---- Rankings ----
function ownedDays(y) {
  const d = parseDay(y.purchase_date)
    || (y.created_at ? new Date(String(y.created_at).replace(' ', 'T') + 'Z') : null);
  return d && !isNaN(d) ? -daysFromToday(d) : 0;
}
const rankable = (y) => !!y.in_hand && !isSold(y);
function isEdc(y) { return rankable(y) && throwCount(y, 30) >= EDC_MIN_DAYS; }
function isShelfQueen(y) {
  return rankable(y) && throwCount(y, 365) <= SHELF_QUEEN_MAX_DAYS && ownedDays(y) >= SHELF_QUEEN_OWNED_DAYS;
}
// The same 2-day line as Shelf queen, from the other side — so no yoyo is both.
function isCollectingDust(y) {
  return rankable(y) && throwCount(y, 365) > SHELF_QUEEN_MAX_DAYS && throwCount(y, DUST_DAYS) === 0;
}
function rankOf(y) {
  if (!hasThrowLog()) return '';
  return isEdc(y) ? 'edc' : isCollectingDust(y) ? 'dust' : isShelfQueen(y) ? 'queen' : '';
}
const RANK_LABEL = { edc: 'EDC', dust: 'Collecting dust', queen: 'Shelf queen' };
const RANK_TITLE = {
  edc: `Everyday carry — thrown on ${EDC_MIN_DAYS}+ of the last 30 days`,
  dust: `Thrown this past year, but not in the last ${DUST_DAYS} days`,
  queen: `Thrown on ${SHELF_QUEEN_MAX_DAYS} days or fewer in the last year`,
};

// For the owner, Yoyo of the day favours what's been neglected — a reason to
// take something off the shelf. Falls back to the full list.
function yotdPool(list) {
  if (!hasThrowLog()) return list;
  const pool = list.filter((y) => isCollectingDust(y) || isShelfQueen(y));
  return pool.length ? pool : list;
}

// ---- Loans and cleaning (worked out from events, never stored as a status) ----
// { to, since, due } while a loan is open: the newest of this yoyo's
// lent/returned events is a `lent`. Same-day pairs resolve by when they were
// logged. `due` is the optional "due back" day from that entry ('' if none).
function lentTo(y) {
  if (!isOwnerState) return null;
  let last = null;
  for (const e of sideEvents) {
    if (e.yoyo_uuid !== uid(y) || (e.type !== 'lent' && e.type !== 'returned')) continue;
    if (!last || e.occurred_on > last.occurred_on || (e.occurred_on === last.occurred_on && e.created_at >= last.created_at)) last = e;
  }
  if (!last || last.type !== 'lent') return null;
  const due = parseDay(last.data?.due) ? String(last.data.due) : '';
  return { to: last.data?.to || '', since: last.occurred_on, due };
}
function lentLabel(l) { return l.to ? `Lent to ${l.to}` : 'Lent out'; }
// Where an open loan stands against its due date: { text, level } with level
// 'overdue' | 'soon' (due within a week) | '' — or null when no date was set.
const LOAN_SOON_DAYS = 7;
function loanDue(l) {
  if (!l || !l.due) return null;
  const n = daysFromToday(parseDay(l.due));
  if (n < 0) return { n, level: 'overdue', text: `overdue by ${plural(-n, 'day')}` };
  if (n === 0) return { n, level: 'soon', text: 'due back today' };
  if (n <= LOAN_SOON_DAYS) return { n, level: 'soon', text: n === 1 ? 'due back tomorrow' : `due back in ${n} days` };
  return { n, level: '', text: `due back ${formatDay(l.due)}` };
}
// Every open loan, most pressing first: overdue, then by due date, then undated.
function openLoans() {
  return yoyos.map((y) => ({ y, loan: lentTo(y) })).filter((r) => r.loan)
    .map((r) => ({ ...r, due: loanDue(r.loan) }))
    .sort((a, b) => (a.due ? a.due.n : Infinity) - (b.due ? b.due.n : Infinity) || (a.loan.since < b.loan.since ? -1 : 1));
}
// A nudge when loans are overdue or due today — at most once a day per
// browser, so it reminds without nagging on every page load.
function loanReminder() {
  if (!isOwnerState) return;
  const late = openLoans().filter((r) => r.due && r.due.n <= 0);
  if (!late.length) return;
  const today = localDay();
  try {
    if (localStorage.getItem('yoyoLoanReminder') === today) return;
    localStorage.setItem('yoyoLoanReminder', today);
  } catch { /* no storage: remind anyway */ }
  const one = late[0];
  const who = one.loan.to ? ` (${one.loan.to})` : '';
  toast(late.length === 1
    ? `${yoyoName(one.y)}${who} is ${one.due.text}.`
    : `${late.length} loaned yoyos are due back or overdue — see Insights.`, 'error');
}
// The day the bearing was last known clean: a full clean, or a new bearing.
// A lube-only day doesn't count, or frequent re-lubing would keep resetting it.
function lastCleanDay(y) {
  let last = '';
  for (const e of sideEvents) {
    if (e.yoyo_uuid === uid(y) && (e.type === 'clean' || e.type === 'bearing') && e.occurred_on > last) last = e.occurred_on;
  }
  return last;
}
// Throw-days since the last clean, or null if it has never been cleaned.
// `more` is true when the clean predates the loaded year of throws, so the
// real number is higher.
function throwsSinceClean(y) {
  const clean = lastCleanDay(y);
  if (!clean) return null;
  let n = 0;
  for (const d of throwsOf(y)) if (d > clean) n++;
  const fullLog = detailEventsFor === y.id && !!detailEvents;
  return { n, clean, more: clean < daysAgo(THROW_WINDOW_DAYS) && !fullLog };
}

// ---- Throws: writing ----
function markThrow(uuid, day, on) {
  if (on) addThrowDay(uuid, day); else throwDays.get(uuid)?.delete(day);
  const s = throwSummary.get(uuid);
  if (on) {
    if (!s) throwSummary.set(uuid, { yoyo_uuid: uuid, first_on: day, last_on: day, days: 1 });
    else { s.days++; if (day < s.first_on) s.first_on = day; if (day > s.last_on) s.last_on = day; }
  } else if (s) {
    s.days--;
    if (s.days <= 0) throwSummary.delete(uuid);
    else if (day === s.last_on) s.last_on = [...(throwDays.get(uuid) || [])].sort().pop() || s.last_on;
  }
  spanCache = new Map(); histCache = new Map(); dayCountCache = null;
}
// Sets (or, with `on` undefined, flips) whether a yoyo was thrown on a day.
// Optimistic: the UI updates at once and rolls back if the server refuses.
async function setThrown(id, day = localDay(), on) {
  if (demoGuard()) return;
  const y = yoyos.find((x) => x.id === id);
  if (!y) return;
  const was = isThrown(y, day);
  const want = on === undefined ? !was : on;
  if (want === was) return;
  const rankBefore = rankOf(y);
  const apply = (live) => {
    markThrow(uid(y), day, live);
    // Keep the open sheet's copy of the log in step, for its timeline.
    if (detailEventsFor === y.id && detailEvents) {
      detailEvents = detailEvents.filter((e) => !(e.type === 'throw' && e.occurred_on === day));
      if (live) detailEvents.push({ type: 'throw', occurred_on: day });
    }
    refreshThrowUI(y, rankBefore);
  };
  apply(want);
  try {
    // Turning a day on is sent as "ensure", so a stale page can't un-tick a
    // day another device already logged.
    const r = await api(`/api/yoyos/${id}/events`, jsonPost({ type: 'throw', occurred_on: day, ensure: want || undefined }));
    if (r.live !== want) apply(r.live);
  } catch (err) {
    apply(was);
    toast(err.message, 'error');
  }
}
// Repaints whatever shows this yoyo's throws, without a round trip.
function refreshThrowUI(y, rankBefore) {
  if (detailId === y.id) {
    const panel = document.getElementById('throwPanel');
    if (panel) { panel.outerHTML = throwPanelHTML(y); wireThrowPanel(y); }
    const btn = document.querySelector('#detailBody [data-throw-today]');
    if (btn) { btn.classList.toggle('on', isThrown(y)); btn.querySelector('span').textContent = isThrown(y) ? 'Used today' : 'Mark used today'; }
    renderTimeline(y);
  }
  if (currentView === 'insights') renderInsights();
  else if (currentView === 'collection' && rankOf(y) !== rankBefore) render();
}
// Select mode's "Used today": marks every selected yoyo as thrown today.
// Uses "ensure", so running it twice changes nothing.
async function bulkUsedToday() {
  const ids = [...selectedIds];
  if (!ids.length || demoGuard()) return;
  const day = localDay();
  let ok = 0, fail = 0;
  for (const id of ids) {
    const y = yoyos.find((x) => x.id === id);
    if (!y) { fail++; continue; }
    try {
      await api(`/api/yoyos/${id}/events`, jsonPost({ type: 'throw', occurred_on: day, ensure: true }));
      if (!isThrown(y, day)) markThrow(uid(y), day, true);
      ok++;
    } catch { fail++; }
  }
  setSelectMode(false);
  toast(`Updated ${plural(ok, 'yoyo')}${fail ? `, ${fail} failed` : ''}.`, fail ? 'error' : 'ok');
}

// ---- Collection: tags + the "Lent out" filter ----
// Small owner-only tags for a card.
function eventTagsHTML(y) {
  if (!isOwnerState) return '';
  const out = [];
  const l = lentTo(y);
  if (l) {
    const due = loanDue(l);
    out.push(`<span class="tag tag-lent ${due ? due.level : ''}" title="Since ${esc(formatDay(l.since))}${due ? ` · ${esc(due.text)}` : ''}">${esc(lentLabel(l))}${due && due.level ? ` · ${esc(due.text)}` : ''}</span>`);
  }
  const r = rankOf(y);
  if (r === 'edc' || r === 'queen') out.push(`<span class="tag tag-rank-${r}" title="${esc(RANK_TITLE[r])}">${RANK_LABEL[r]}</span>`);
  return out.join('');
}
// The shelf tile's one-line caption: a loan or a ranking, when there is one.
function shelfEventText(y) {
  if (!isOwnerState) return '';
  const l = lentTo(y);
  if (l) {
    const due = loanDue(l);
    return `${l.to ? `lent to ${l.to}` : 'lent out'}${due && due.level ? ` · ${due.text}` : ''}`;
  }
  const r = rankOf(y);
  return r === 'edc' || r === 'queen' ? RANK_LABEL[r] : '';
}

// ---- Detail view: hero pieces ----
function detailEventBadgesHTML(y) {
  if (!isOwnerState) return '';
  const out = [];
  const l = lentTo(y);
  if (l) {
    const due = loanDue(l);
    out.push(`<span class="status-badge lent ${due ? due.level : ''}">${esc(lentLabel(l))} · since ${esc(formatDay(l.since))}${due ? ` · ${esc(due.text)}` : ''}</span>`);
  }
  const r = rankOf(y);
  if (r) out.push(`<span class="status-badge rank-${r}" title="${esc(RANK_TITLE[r])}">${RANK_LABEL[r]}</span>`);
  return out.join('');
}
function detailEventActionsHTML(y) {
  const on = isThrown(y);
  return `<button class="hero-act ${on ? 'on' : ''}" data-throw-today>${EV_SVG.yoyo}<span>${on ? 'Used today' : 'Mark used today'}</span></button>` +
    `<button class="hero-act" data-log-event>${EV_SVG.plus}<span>Log event</span></button>`;
}

// The throw summary under the hero: a sentence of facts, twelve weeks of
// day cells (tap one to log a day you forgot), and an optional month calendar
// for anything older.
function throwPanelHTML(y) {
  if (!isOwnerState) return '';
  const set = throwsOf(y);
  const s = throwSummary.get(uid(y));
  const facts = [];
  if (s) {
    facts.push(`Last thrown <strong>${esc(relativeDay(s.last_on))}</strong>`);
    const year = throwCount(y, 365);
    facts.push(`${plural(year, 'day')} in the last year`);
    if (s.days > year) facts.push(`${plural(s.days, 'day')} in total`);
    const first = parseDay(s.first_on);
    if (first && -daysFromToday(first) > 365) facts.push(`first thrown ${esc(formatDay(s.first_on, 'month'))}`);
    const streak = streakOf((d) => set.has(d));
    if (streak >= 2) facts.push(`${streak} days in a row`);
  } else {
    facts.push('Not thrown yet');
  }
  const sc = throwsSinceClean(y);
  if (sc) facts.push(`${sc.n}${sc.more ? '+' : ''} throw-${sc.n === 1 && !sc.more ? 'day' : 'days'} since last clean`);

  // Twelve week-columns, Sunday to Saturday, ending with the current week.
  const today = localDay();
  const start = new Date(); start.setDate(start.getDate() - start.getDay() - 7 * 11);
  let cells = '';
  for (let i = 0; i < 84; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const day = localDay(d);
    if (day > today) { cells += '<span class="tw-day future"></span>'; continue; }
    const on = set.has(day);
    const label = `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}${on ? ' — thrown' : ''}`;
    cells += canEditState
      ? `<button type="button" class="tw-day ${on ? 'on' : ''} ${day === today ? 'today' : ''}" data-throw-day="${day}" title="${esc(label)}" aria-label="${esc(label)}" aria-pressed="${on}"></button>`
      : `<span class="tw-day ${on ? 'on' : ''} ${day === today ? 'today' : ''}" title="${esc(label)}"></span>`;
  }

  // Year by year, once the log spans more than one calendar year.
  const perYear = new Map();
  for (const d of set) perYear.set(d.slice(0, 4), (perYear.get(d.slice(0, 4)) || 0) + 1);
  const years = perYear.size > 1
    ? `<span class="throw-years">${[...perYear.entries()].sort().map(([yr, n]) => `${yr}: <strong>${n}</strong>`).join(' · ')}</span>` : '';

  return `<section class="throw-panel" id="throwPanel">
      <div class="throw-facts">${facts.join(' · ')}</div>
      <div class="throw-weeks-wrap">
        <div class="throw-weeks" role="group" aria-label="Throws, last 12 weeks">${cells}</div>
        <div class="throw-weeks-foot">
          <span class="hint">${canEditState ? 'Last 12 weeks — tap a day to log or clear it.' : 'Last 12 weeks'}</span>
          <button type="button" class="btn btn-ghost btn-sm" data-throw-cal aria-expanded="${!!detailCalMonth}">${EV_SVG.calendar}<span>${detailCalMonth ? 'Hide calendar' : 'Calendar'}</span></button>
        </div>
      </div>
      ${detailCalMonth ? `<div class="cal-card throw-cal">${monthGridHTML(detailCalMonth, (day) => (set.has(day) ? 3 : 0), null)}</div>` : ''}
      ${years}
    </section>`;
}
function wireThrowPanel(y) {
  const panel = document.getElementById('throwPanel');
  if (!panel) return;
  const repaint = () => { panel.outerHTML = throwPanelHTML(y); wireThrowPanel(y); };
  panel.querySelectorAll('[data-throw-day]').forEach((b) => b.addEventListener('click', () => setThrown(y.id, b.dataset.throwDay)));
  panel.querySelector('[data-throw-cal]')?.addEventListener('click', () => {
    detailCalMonth = detailCalMonth ? null : firstOfMonth(new Date());
    repaint();
  });
  panel.querySelectorAll('[data-cal]').forEach((b) => b.addEventListener('click', () => {
    detailCalMonth = new Date(detailCalMonth.getFullYear(), detailCalMonth.getMonth() + Number(b.dataset.cal), 1);
    repaint();
  }));
  panel.querySelectorAll('.throw-cal [data-day]').forEach((b) => b.addEventListener('click', () => {
    if (canEditState) setThrown(y.id, b.dataset.day);
  }));
}

// A month grid in the Arrivals calendar's markup. `level(day)` returns 0–3 for
// how strongly to shade a day; future days are disabled.
function monthGridHTML(month, level, selected) {
  const lead = month.getDay();
  const dim = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const today = localDay();
  let cells = '';
  for (let i = 0; i < lead; i++) cells += '<div class="cal-day cal-empty"></div>';
  for (let d = 1; d <= dim; d++) {
    const day = localDay(new Date(month.getFullYear(), month.getMonth(), d));
    const lvl = level(day);
    const cls = [day === today ? 'today' : '', day === selected ? 'selected' : '', lvl ? `thrown lvl${lvl}` : ''].join(' ').trim();
    cells += `<button type="button" class="cal-day ${cls}" data-day="${day}" ${day > today ? 'disabled' : ''}><span>${d}</span></button>`;
  }
  const weekdays = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w) => `<div class="cal-weekday">${w}</div>`).join('');
  const atNow = month.getFullYear() === new Date().getFullYear() && month.getMonth() === new Date().getMonth();
  return `<div class="cal-head"><button type="button" class="cal-nav" data-cal="-1" aria-label="Previous month">‹</button>` +
    `<span class="cal-title">${esc(month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}</span>` +
    `<button type="button" class="cal-nav" data-cal="1" aria-label="Next month" ${atNow ? 'disabled' : ''}>›</button></div>` +
    `<div class="cal-weekdays">${weekdays}</div><div class="cal-grid">${cells}</div>`;
}

// Called by openDetail() once the sheet is in the DOM: wires the hero buttons
// and the throw panel, then loads this yoyo's full log for the timeline.
function wireDetailEvents(y) {
  if (!isOwnerState) return;
  const body = document.getElementById('detailBody');
  body.querySelector('[data-throw-today]')?.addEventListener('click', () => setThrown(y.id));
  body.querySelector('[data-log-event]')?.addEventListener('click', () => openEventForm(y));
  wireThrowPanel(y);
  // Re-opening the same yoyo (after an edit, say) shows the log it already
  // has while a fresh copy loads.
  if (detailEventsFor === y.id && detailEvents) renderTimeline(y);
  else { detailEvents = null; detailEventsFor = y.id; }
  api(`/api/yoyos/${y.id}/events`).then((rows) => {
    if (detailEventsFor !== y.id) return; // the sheet moved on to another yoyo
    detailEvents = rows;
    // The full log reaches back past the loaded year, so this yoyo's own
    // calendar and year-by-year line can cover its whole history.
    for (const e of rows) if (e.type === 'throw') addThrowDay(uid(y), e.occurred_on);
    if (detailId === y.id) {
      const panel = document.getElementById('throwPanel');
      if (panel) { panel.outerHTML = throwPanelHTML(y); wireThrowPanel(y); }
      renderTimeline(y);
    }
  }).catch(() => { /* the timeline just stays empty */ });
}
// Forget the open yoyo's log when the sheet closes.
function resetDetailEvents() { detailEvents = null; detailEventsFor = null; detailCalMonth = null; }

// ---- Event types (the maintenance / contest / provenance log) ----
// label, icon, and the optional structured fields each type offers. The server
// stores any type; this map only decides how the web shows and edits them.
// A field is [key, label, kind?] — kind: 'number', 'date', 'suggest'
// (autocomplete from earlier entries), or an array of choices.
const EVENT_TYPES = {
  clean: { label: 'Bearing cleaned', icon: 'drop', group: 'Upkeep', fields: [['lube', 'Lube used']] },
  lube: { label: 'Lubed (no clean)', icon: 'drop', group: 'Upkeep', fields: [['lube', 'Lube used']] },
  bearing: { label: 'Bearing replaced', icon: 'wrench', group: 'Upkeep', fields: [['bearing', 'Bearing'], ['size', 'Size']] },
  pads: { label: 'Pads replaced', icon: 'wrench', group: 'Upkeep', fields: [['response', 'Response pads']] },
  string: { label: 'String changed', icon: 'wrench', group: 'Upkeep', fields: [['string', 'String']] },
  mod: { label: 'Modification', icon: 'wrench', group: 'Upkeep', fields: [] },
  damage: { label: 'Damage', icon: 'alert', group: 'Upkeep', fields: [['severity', 'Severity', ['cosmetic', 'functional']]] },
  repair: { label: 'Repair', icon: 'wrench', group: 'Upkeep', fields: [] },
  contest: { label: 'Contest', icon: 'trophy', group: 'Play', fields: [['contest', 'Contest', 'suggest'], ['division', 'Division'], ['round', 'Round'], ['placement', 'Placement', 'number']] },
  milestone: { label: 'Milestone', icon: 'star', group: 'Play', fields: [['trick', 'Trick', 'suggest']] },
  lent: { label: 'Lent out', icon: 'user', group: 'Whereabouts', fields: [['to', 'Lent to', 'suggest'], ['due', 'Due back (optional)', 'date']] },
  returned: { label: 'Returned from loan', icon: 'user', group: 'Whereabouts', fields: [] },
  autograph: { label: 'Autographed', icon: 'edit', group: 'Provenance', fields: [['by', 'Signed by', 'suggest'], ['where', 'Where']] },
  history: { label: 'History (before you owned it)', icon: 'clock', group: 'Provenance', fields: [['from', 'Source']] },
  note: { label: 'Note', icon: 'edit', group: 'Provenance', fields: [] },
};
function eventIcon(type) {
  const name = EVENT_TYPES[type]?.icon || 'clock';
  return name === 'star' ? SVG.star : name === 'edit' ? SVG.edit : EV_SVG[name];
}
// { title, detail } for a timeline row.
function eventText(e) {
  const d = e.data || {};
  const meta = EVENT_TYPES[e.type];
  const others = (skip) => Object.entries(d).filter(([k]) => k !== 'precision' && !skip.includes(k)).map(([, v]) => String(v));
  switch (e.type) {
    case 'contest': {
      const parts = [d.placement != null && d.placement !== '' ? ordinal(d.placement) : '', [d.division, d.round].filter(Boolean).join(' '), d.contest].filter(Boolean);
      return { title: parts.join(' · ') || 'Contest', detail: others(['placement', 'division', 'round', 'contest']).join(' · ') };
    }
    case 'milestone': return { title: d.trick ? `First landed ${d.trick}` : 'Milestone', detail: others(['trick']).join(' · ') };
    case 'lent': return {
      title: d.to ? `Lent to ${d.to}` : 'Lent out',
      detail: [parseDay(d.due) ? `Due back ${formatDay(d.due)}` : '', ...others(['to', 'due'])].filter(Boolean).join(' · '),
    };
    case 'autograph': return { title: d.by ? `Autographed by ${d.by}` : 'Autographed', detail: others(['by']).join(' · ') };
    case 'history': return { title: 'History', detail: others([]).join(' · ') };
    case 'bearing': return { title: 'Bearing replaced', detail: [d.bearing, d.size ? `Size ${String(d.size).replace(/^size\s*/i, '')}` : '', ...others(['bearing', 'size'])].filter(Boolean).join(' · ') };
    default:
      return { title: meta ? meta.label : `Other · ${e.type}`, detail: others([]).join(' · ') };
  }
}

// ---- Timeline ----
// Three sources, newest first: logged events; "Bought from" / "Sold to",
// rendered from the yoyo's own fields (never stored twice); and throws
// collapsed to one line per month so a daily thrower's timeline stays readable.
function timelineEntries(y) {
  const out = [];
  const months = new Map();
  for (const e of detailEvents || []) {
    if (e.type === 'throw') {
      const m = e.occurred_on.slice(0, 7);
      const cur = months.get(m) || { n: 0, last: '' };
      cur.n++; if (e.occurred_on > cur.last) cur.last = e.occurred_on;
      months.set(m, cur);
      continue;
    }
    const t = eventText(e);
    out.push({
      day: e.occurred_on, at: e.created_at, icon: eventIcon(e.type), title: t.title, detail: t.detail, note: e.note,
      date: formatDay(e.occurred_on, e.data?.precision), cls: e.type === 'contest' || e.type === 'milestone' ? 'tl-feature' : '', ev: e,
    });
  }
  for (const [m, { n, last }] of months) {
    const label = parseDay(`${m}-01`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    out.push({ day: last, at: '', icon: EV_SVG.yoyo, title: `Thrown ${plural(n, 'day')} in ${label}`, cls: 'tl-throws', date: '' });
  }
  const bought = parseDay(y.purchase_date), sold = parseDay(y.sold_date);
  if (bought) out.push({ day: localDay(bought), at: '', icon: EV_SVG.cart, title: y.seller ? `Bought from ${y.seller}` : 'Bought', date: formatDay(localDay(bought)) });
  if (sold) out.push({ day: localDay(sold), at: '~', icon: SVG.tag, title: y.buyer ? `Sold to ${y.buyer}` : 'Sold', date: formatDay(localDay(sold)) });
  return out.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)));
}
function timelineSectionHTML() {
  return isOwnerState ? '<section class="detail-group full timeline hidden" id="timelineSection"></section>' : '';
}
function renderTimeline(y) {
  const sec = document.getElementById('timelineSection');
  if (!sec || detailEventsFor !== y.id || !detailEvents) return;
  const rows = timelineEntries(y);
  sec.classList.toggle('hidden', !rows.length && !canEditState);
  sec.innerHTML = '<h3>Timeline</h3>' + (rows.length
    ? `<ol class="tl">${rows.map((r) => `<li class="tl-row ${r.cls || ''}">
        <span class="tl-icon">${r.icon}</span>
        <div class="tl-body"><div class="tl-title">${esc(r.title)}</div>
          ${r.detail ? `<div class="tl-detail">${esc(r.detail)}</div>` : ''}
          ${r.note ? `<div class="tl-note">${esc(r.note)}</div>` : ''}</div>
        <span class="tl-date">${esc(r.date)}</span>
        ${r.ev && canEditState ? `<span class="tl-acts">
          <button type="button" class="icon-btn" data-ev-edit="${esc(r.ev.uuid)}" title="Edit" aria-label="Edit">${SVG.edit}</button>
          <button type="button" class="icon-btn" data-ev-del="${esc(r.ev.uuid)}" title="Delete" aria-label="Delete">${SVG.trash}</button></span>` : ''}
      </li>`).join('')}</ol>`
    : '<p class="hint">Nothing logged yet. Use “Log event” to record a clean, a contest, a loan, or a bit of this yoyo’s history.</p>');
  const find = (uuid) => detailEvents.find((e) => e.uuid === uuid);
  sec.querySelectorAll('[data-ev-edit]').forEach((b) => b.addEventListener('click', () => openEventForm(y, find(b.dataset.evEdit))));
  sec.querySelectorAll('[data-ev-del]').forEach((b) => b.addEventListener('click', () => deleteEvent(y, find(b.dataset.evDel))));
}
async function deleteEvent(y, e) {
  if (!e || demoGuard()) return;
  if (!await confirmDialog({ title: 'Delete this entry?', message: `${eventText(e).title} · ${formatDay(e.occurred_on, e.data?.precision)}`, confirmText: 'Delete', danger: true })) return;
  try {
    await api(`/api/events/${e.uuid}`, { method: 'DELETE' });
    await reloadAfterEventChange(y.id);
  } catch (err) { toast(err.message, 'error'); }
}
// Event edits are rare and touch several views (badges, Insights, timeline),
// so reload everything, the way a yoyo edit does.
async function reloadAfterEventChange(id) {
  await loadAll();
  if (detailId === id) openDetail(id);
}

// ---- Log event form ----
function suggestionsFor(type, key) {
  return [...new Set(sideEvents.filter((e) => e.type === type).map((e) => e.data?.[key]).filter(Boolean).map(String))]
    .sort((a, b) => a.localeCompare(b));
}
// Opens the form to add an event to `y`, or edit `existing`.
function openEventForm(y, existing) {
  if (demoGuard()) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  const groups = {};
  for (const [type, m] of Object.entries(EVENT_TYPES)) (groups[m.group] ||= []).push([type, m.label]);
  let type = existing?.type || 'clean';
  const known = !!EVENT_TYPES[type];
  const typeOptions = Object.entries(groups).map(([g, list]) =>
    `<optgroup label="${esc(g)}">${list.map(([t, l]) => `<option value="${t}" ${t === type ? 'selected' : ''}>${esc(l)}</option>`).join('')}</optgroup>`).join('')
    + (known ? '' : `<option value="${esc(type)}" selected>Other · ${esc(type)}</option>`);
  const precision = existing?.data?.precision || 'day';
  const day = existing?.occurred_on || localDay();

  overlay.innerHTML = `<div class="modal-backdrop"></div>
    <div class="modal-card modal-sm" role="dialog" aria-modal="true" aria-label="${existing ? 'Edit entry' : 'Log event'}">
      <div class="modal-head"><h2>${existing ? 'Edit entry' : 'Log event'}</h2></div>
      <div class="form"><div class="form-section event-form">
        <p class="hint">${esc(yoyoName(y))}</p>
        <div class="field"><label for="evType">What happened</label><select id="evType">${typeOptions}</select></div>
        <div class="form-grid">
          <div class="field"><label for="evPrecision">Date known to the</label>
            <select id="evPrecision">
              <option value="day" ${precision === 'day' ? 'selected' : ''}>Exact day</option>
              <option value="month" ${precision === 'month' ? 'selected' : ''}>Month</option>
              <option value="year" ${precision === 'year' ? 'selected' : ''}>Year</option>
            </select></div>
          <div class="field" id="evWhen"></div>
        </div>
        <div class="form-grid" id="evFields"></div>
        <div class="field"><label for="evNote">Note</label><textarea id="evNote" rows="3" maxlength="1000" placeholder="Anything worth remembering">${esc(existing?.note || '')}</textarea></div>
        <p class="hint" id="evHint"></p>
        <p class="login-error hidden" id="evError"></p>
      </div></div>
      <div class="modal-foot"><span class="spacer"></span>
        <button type="button" class="btn btn-ghost" data-act="cancel">Cancel</button>
        <button type="button" class="btn btn-primary" data-act="save">Save</button></div>
    </div>`;
  document.body.appendChild(overlay);
  const q = (sel) => overlay.querySelector(sel);

  // The date control follows the precision: a day, a month, or just a year.
  const drawWhen = (p, value) => {
    const today = localDay();
    q('#evWhen').innerHTML = p === 'year'
      ? `<label for="evDay">Year</label><input id="evDay" type="number" min="1900" max="${today.slice(0, 4)}" step="1" value="${esc(value.slice(0, 4))}">`
      : p === 'month'
        ? `<label for="evDay">Month</label><input id="evDay" type="month" max="${today.slice(0, 7)}" value="${esc(value.slice(0, 7))}">`
        : `<label for="evDay">Date</label><input id="evDay" type="date" max="${today}" value="${esc(value)}">`;
  };
  const readDay = () => {
    const p = q('#evPrecision').value, v = q('#evDay').value.trim();
    if (p === 'year') return /^\d{4}$/.test(v) ? `${v}-01-01` : '';
    if (p === 'month') return /^\d{4}-\d{2}$/.test(v) ? `${v}-01` : '';
    return v;
  };
  const drawFields = (values = {}) => {
    const fields = EVENT_TYPES[type]?.fields || [];
    q('#evFields').innerHTML = fields.map(([key, label, kind]) => {
      const val = values[key] ?? '';
      let input;
      if (Array.isArray(kind)) {
        input = `<select data-ev-field="${key}"><option value=""></option>${kind.map((o) => `<option ${o === val ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
      } else if (kind === 'date') {
        input = `<input type="date" data-ev-field="${key}" value="${esc(val)}">`;
      } else if (kind === 'number') {
        input = `<input type="number" min="1" step="1" data-ev-field="${key}" data-num value="${esc(val)}">`;
      } else {
        const list = kind === 'suggest' ? suggestionsFor(type, key) : [];
        input = `<input type="text" maxlength="200" data-ev-field="${key}" value="${esc(val)}" ${list.length ? `list="evList-${key}"` : ''}>` +
          (list.length ? `<datalist id="evList-${key}">${list.map((v) => `<option value="${esc(v)}"></option>`).join('')}</datalist>` : '');
      }
      return `<div class="field ${fields.length % 2 && key === fields[fields.length - 1][0] ? 'span2' : ''}"><label>${esc(label)}</label>${input}</div>`;
    }).join('');
    q('#evHint').textContent = type === 'contest' || type === 'milestone' ? 'Also marks the yoyo as thrown that day.'
      : type === 'clean' || type === 'bearing' ? 'Resets the “throw-days since last clean” count.'
        : type === 'history' ? 'For what happened before you owned it. Pick Month or Year if that’s all you know.'
          : type === 'lent' ? 'Shows “Lent to …” on the yoyo until you log “Returned from loan”. With a due date, you’re warned when it’s nearly due and when it’s overdue.' : '';
  };
  drawWhen(precision, day);
  drawFields(existing?.data || {});
  q('#evType').addEventListener('change', (e) => { type = e.target.value; drawFields(); });
  q('#evPrecision').addEventListener('change', (e) => drawWhen(e.target.value, readDay() || day));

  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
  const save = async () => {
    const err = q('#evError');
    const occurred = readDay();
    if (!occurred) { err.textContent = 'Pick a date.'; err.classList.remove('hidden'); return; }
    // Keys this form doesn't know (set by a native app, say) are carried over.
    const mine = new Set((EVENT_TYPES[type]?.fields || []).map(([k]) => k));
    const data = {};
    for (const [k, v] of Object.entries(existing?.data || {})) if (!mine.has(k) && k !== 'precision' && existing.type === type) data[k] = v;
    overlay.querySelectorAll('[data-ev-field]').forEach((el) => {
      const v = el.value.trim();
      if (v) data[el.dataset.evField] = el.hasAttribute('data-num') && !isNaN(Number(v)) ? Number(v) : v;
    });
    const p = q('#evPrecision').value;
    if (p !== 'day') data.precision = p;
    const body = { type, occurred_on: occurred, note: q('#evNote').value, data };
    const btn = q('[data-act="save"]');
    btn.disabled = true;
    try {
      if (existing) await api(`/api/events/${existing.uuid}`, jsonPost(body, 'PUT'));
      else await api(`/api/yoyos/${y.id}/events`, jsonPost(body));
      close();
      await reloadAfterEventChange(y.id);
      toast(existing ? 'Entry updated.' : 'Logged.', 'ok');
    } catch (e) {
      btn.disabled = false;
      err.textContent = e.message; err.classList.remove('hidden');
    }
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') { e.preventDefault(); save(); }
  };
  document.addEventListener('keydown', onKey, true);
  q('.modal-backdrop').addEventListener('click', close);
  q('[data-act="cancel"]').addEventListener('click', close);
  q('[data-act="save"]').addEventListener('click', save);
  q('#evType').focus();
}

// ---- Insights ----
const SPANS = [
  { key: 'week', label: 'Week', days: 7 }, { key: 'month', label: 'Month', days: 30 }, { key: 'year', label: 'Year', days: 365 },
  { key: '2y', label: '2y', years: 2 }, { key: '3y', label: '3y', years: 3 }, { key: '5y', label: '5y', years: 5 }, { key: '10y', label: '10y', years: 10 },
  { key: 'all', label: 'All' },
];
// Spans longer than the log's own history are hidden: someone eight months in
// isn't offered a 5-year view.
function availableSpans() {
  const history = throwHistoryDays();
  return SPANS.filter((s) => s.days || (s.years ? history >= s.years * 365 : history > 365));
}
// Fetches and caches a server aggregate, re-rendering Insights when it lands.
// Returns the rows if already cached, else null (a fetch is under way).
function cachedFetch(cache, key, url) {
  if (cache.has(key)) return cache.get(key);
  cache.set(key, null);
  api(url).then((rows) => {
    if (!cache.has(key)) return; // the caches were reset by a reload meanwhile
    cache.set(key, rows);
    if (currentView === 'insights') renderInsights();
  }).catch(() => cache.delete(key));
  return null;
}
// [{ y, n }] most-thrown first, or null while a long span is loading.
function mostThrown(spanKey, list) {
  const span = SPANS.find((s) => s.key === spanKey) || SPANS[2];
  let count;
  if (span.days) count = (y) => throwCount(y, span.days);
  else if (span.key === 'all') count = (y) => throwSummary.get(uid(y))?.days || 0;
  else {
    const from = yearsAgo(span.years);
    const rows = cachedFetch(spanCache, from, `/api/events/summary?type=throw&from=${from}`);
    if (!rows) return null;
    const byUuid = new Map(rows.map((r) => [r.yoyo_uuid, r.days]));
    count = (y) => byUuid.get(uid(y)) || 0;
  }
  return list.map((y) => ({ y, n: count(y) })).filter((r) => r.n > 0).sort((a, b) => b.n - a.n || yoyoName(a.y).localeCompare(yoyoName(b.y)));
}
function segHTML(attr, options, active) {
  return `<div class="seg seg-wrap" role="group">${options.map((o) =>
    `<button type="button" class="seg-btn ${o.key === active ? 'active' : ''}" ${attr}="${o.key}">${esc(o.label)}</button>`).join('')}</div>`;
}
function yoyoRowsHTML(rows, more = 0) {
  return `<div class="standouts">${rows.map((r) =>
    `<div class="standout-row" data-arr="${r.y.id}">${thumbHTML(r.y, 'standout-thumb')}` +
    `<div class="standout-main">${r.label ? `<div class="standout-label">${esc(r.label)}</div>` : ''}<div class="standout-name">${esc(r.name || yoyoName(r.y))}</div></div>` +
    `<span class="standout-value ${r.cls || ''}">${esc(r.value)}</span></div>`).join('')}</div>` +
    (more > 0 ? `<p class="hint rank-more">and ${more} more</p>` : '');
}
function rankCard(title, blurb, list, value) {
  if (!list.length) return '';
  const MAX = 8;
  return `<div class="insight-card"><h3>${esc(title)} <span class="rank-n">${list.length}</span></h3><p class="hint rank-blurb">${esc(blurb)}</p>` +
    yoyoRowsHTML(list.slice(0, MAX).map((y) => ({ y, value: value(y) })), list.length - MAX) + `</div>`;
}

// Extra rows for the Standouts card.
function throwStandouts(owned) {
  if (!hasThrowLog()) return [];
  const out = [];
  const top = (mostThrown('year', owned.filter(rankable)) || [])[0];
  if (top) out.push({ icon: EV_SVG.yoyo, label: 'Most thrown', y: top.y, value: `${plural(top.n, 'day')} this year` });
  const streak = collectionStreak();
  if (streak >= 2) out.push({ icon: EV_SVG.flame, label: 'Current streak', name: 'Thrown every day', value: `${streak} days` });
  return out;
}

// The owner's usage cards, appended to the Insights view.
function throwInsightsHTML(owned) {
  if (!isOwnerState) return '';
  const cards = [];
  if (hasThrowLog()) {
    const inHand = owned.filter(rankable);

    // Most thrown
    const spans = availableSpans();
    if (!spans.some((s) => s.key === mostThrownSpan)) mostThrownSpan = 'year';
    const ranked = mostThrown(mostThrownSpan, inHand);
    const chart = ranked === null ? '<p class="hint">Loading…</p>'
      : ranked.length ? barChart(ranked.slice(0, 8).map((r) => ({ name: yoyoName(r.y), value: r.n, display: plural(r.n, 'day') })), 'var(--accent)')
        : '<p class="hint">Nothing thrown in this period.</p>';
    cards.push(`<div class="insight-card"><div class="card-head"><h3>Most thrown</h3>${segHTML('data-span', spans, mostThrownSpan)}</div>${chart}</div>`);

    // Long-term trends: yoyo-days per year, or per month within a span.
    const history = throwHistoryDays();
    const monthSpans = [1, 2, 3, 5, 10].filter((n) => n === 1 || history >= n * 365);
    if (!monthSpans.includes(trendYears)) trendYears = 1;
    const url = trendMode === 'year' ? '/api/events/histogram?type=throw&bucket=year'
      : `/api/events/histogram?type=throw&bucket=month&from=${yearsAgo(trendYears).slice(0, 8)}01`;
    const hist = cachedFetch(histCache, url, url);
    const bucketName = (b) => (b.length === 4 ? b : parseDay(`${b}-01`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }));
    const trend = hist === null ? '<p class="hint">Loading…</p>'
      : hist.length ? barChart(hist.map((h) => ({ name: bucketName(h.bucket), value: h.days, display: `${h.days} · ${plural(h.yoyos, 'yoyo')}` })), 'var(--gold)')
        : '<p class="hint">Nothing thrown in this period.</p>';
    const spanPick = trendMode === 'month' && monthSpans.length > 1
      ? `<select class="select select-sm" id="trendYears" aria-label="How far back">${monthSpans.map((n) => `<option value="${n}" ${n === trendYears ? 'selected' : ''}>Last ${n === 1 ? 'year' : `${n} years`}</option>`).join('')}</select>` : '';
    cards.push(`<div class="insight-card"><div class="card-head"><h3>Long-term trends</h3>${spanPick}` +
      `${segHTML('data-trend', [{ key: 'year', label: 'By year' }, { key: 'month', label: 'By month' }], trendMode)}</div>` +
      `<p class="hint rank-blurb">Throw-days across the collection — two yoyos on one day count as two.</p>${trend}</div>`);

    // Rankings
    const last = (y) => throwSummary.get(uid(y))?.last_on;
    const ranks = [
      rankCard('Everyday carry', `Thrown on ${EDC_MIN_DAYS} or more of the last 30 days.`,
        inHand.filter(isEdc).sort((a, b) => throwCount(b, 30) - throwCount(a, 30)), (y) => `${throwCount(y, 30)} of 30`),
      rankCard('Collecting dust', `Thrown this past year, but not in the last ${DUST_DAYS} days.`,
        inHand.filter(isCollectingDust).sort((a, b) => String(last(a)).localeCompare(String(last(b)))), (y) => relativeDay(last(y))),
      rankCard('Shelf queens', `Thrown on ${SHELF_QUEEN_MAX_DAYS} days or fewer in the last year. A badge of honor, not a nag.`,
        inHand.filter(isShelfQueen).sort((a, b) => throwCount(a, 365) - throwCount(b, 365) || yoyoName(a).localeCompare(yoyoName(b))),
        (y) => (throwCount(y, 365) ? plural(throwCount(y, 365), 'day') : (last(y) ? `last ${relativeDay(last(y))}` : 'never'))),
    ].join('');
    if (ranks) cards.push(`<div class="rank-grid">${ranks}</div>`);

    cards.push(throwCalendarCardHTML());
  }

  // Due for a clean: needs a threshold, and at least one logged clean.
  if (cleanAfterDays > 0) {
    const due = owned.filter(rankable).map((y) => ({ y, sc: throwsSinceClean(y) }))
      .filter((r) => r.sc && r.sc.n >= cleanAfterDays).sort((a, b) => b.sc.n - a.sc.n);
    if (due.length) {
      cards.push(`<div class="insight-card"><h3>Due for a clean <span class="rank-n">${due.length}</span></h3>` +
        `<p class="hint rank-blurb">Thrown on ${cleanAfterDays} or more days since the last logged clean or bearing swap.</p>` +
        yoyoRowsHTML(due.slice(0, 12).map((r) => ({ y: r.y, label: `Cleaned ${relativeDay(r.sc.clean)}`, value: `${r.sc.n}${r.sc.more ? '+' : ''} throw-days` })), due.length - 12) + `</div>`);
    }
  }

  // Lent out: every open loan, with where it stands against its due date.
  const loans = openLoans();
  if (loans.length) {
    const late = loans.filter((r) => r.due && r.due.level === 'overdue').length;
    cards.push(`<div class="insight-card ${late ? 'has-overdue' : ''}"><h3>Lent out <span class="rank-n">${loans.length}</span>${late ? ` <span class="overdue-n">${late} overdue</span>` : ''}</h3>` +
      yoyoRowsHTML(loans.map((r) => ({
        y: r.y, cls: r.due ? r.due.level : '',
        label: `${lentLabel(r.loan)} · since ${formatDay(r.loan.since)}`,
        value: r.due ? r.due.text : 'no due date',
      }))) + `</div>`);
  }

  // Competition record
  const byUuid = new Map(yoyos.map((y) => [uid(y), y]));
  const contests = sideEvents.filter((e) => e.type === 'contest' && byUuid.has(e.yoyo_uuid))
    .sort((a, b) => (a.occurred_on < b.occurred_on ? 1 : -1));
  if (contests.length) {
    cards.push(`<div class="insight-card"><h3>Competition record</h3>` + yoyoRowsHTML(contests.map((e) => {
      const d = e.data || {};
      return {
        y: byUuid.get(e.yoyo_uuid),
        label: [formatDay(e.occurred_on, d.precision), d.contest].filter(Boolean).join(' · '),
        value: [d.placement != null && d.placement !== '' ? ordinal(d.placement) : '', [d.division, d.round].filter(Boolean).join(' ')].filter(Boolean).join(' · '),
      };
    })) + `</div>`);
  }
  return cards.join('');
}

// A month grid shaded by how many yoyos were thrown each day; picking a day
// lists them. Months older than the loaded year are fetched one at a time.
function throwCalendarCardHTML() {
  const month = throwCalMonth || firstOfMonth(new Date());
  const key = localDay(month).slice(0, 7);
  const loading = ensureThrowMonth(month);
  const counts = dayCounts();
  const max = Math.max(1, ...[...counts.entries()].filter(([d]) => d.startsWith(key)).map(([, n]) => n));
  const level = (day) => { const n = counts.get(day) || 0; return n ? Math.max(1, Math.ceil(n / max * 3)) : 0; };
  let list = '<p class="hint">Pick a day to see what you threw.</p>';
  if (throwCalSelected) {
    const thrown = yoyos.filter((y) => throwsOf(y).has(throwCalSelected));
    const head = parseDay(throwCalSelected).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    list = `<h4 class="throw-cal-day">${esc(head)}</h4>` +
      (thrown.length ? yoyoRowsHTML(thrown.map((y) => ({ y, value: '' }))) : '<p class="hint">Nothing logged this day.</p>');
  }
  return `<div class="insight-card"><h3>Throw calendar</h3><div class="throw-cal-layout">
      <div class="throw-cal" id="throwCal">${monthGridHTML(month, level, throwCalSelected)}${loading ? '<p class="hint">Loading…</p>' : ''}</div>
      <div class="throw-cal-list">${list}</div></div></div>`;
}
// Makes sure the throws for `month` are in memory. Returns true while fetching.
function ensureThrowMonth(month) {
  const first = localDay(month);
  const key = first.slice(0, 7);
  if (first >= daysAgo(THROW_WINDOW_DAYS) || monthsFetched.has(key)) return false;
  const last = localDay(new Date(month.getFullYear(), month.getMonth() + 1, 0));
  if (!ensureThrowMonth.pending) ensureThrowMonth.pending = new Set();
  if (ensureThrowMonth.pending.has(key)) return true;
  ensureThrowMonth.pending.add(key);
  api(`/api/events?type=throw&from=${first}&to=${last}`).then((rows) => {
    for (const r of rows) addThrowDay(r.yoyo_uuid, r.occurred_on);
    monthsFetched.add(key); dayCountCache = null;
    if (currentView === 'insights') renderInsights();
  }).catch(() => {}).finally(() => ensureThrowMonth.pending.delete(key));
  return true;
}
// Called by renderInsights() after it writes the view.
function wireThrowInsights(wrap) {
  const again = (fn) => (e) => { fn(e); renderInsights(); };
  wrap.querySelectorAll('[data-span]').forEach((b) => b.addEventListener('click', again(() => { mostThrownSpan = b.dataset.span; })));
  wrap.querySelectorAll('[data-trend]').forEach((b) => b.addEventListener('click', again(() => { trendMode = b.dataset.trend; })));
  wrap.querySelector('#trendYears')?.addEventListener('change', again((e) => { trendYears = Number(e.target.value) || 1; }));
  const cal = wrap.querySelector('#throwCal');
  if (!cal) return;
  cal.querySelectorAll('[data-cal]').forEach((b) => b.addEventListener('click', again(() => {
    const m = throwCalMonth || firstOfMonth(new Date());
    throwCalMonth = new Date(m.getFullYear(), m.getMonth() + Number(b.dataset.cal), 1);
  })));
  cal.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', again(() => {
    throwCalSelected = throwCalSelected === b.dataset.day ? null : b.dataset.day;
  })));
}

// ---- Settings: the cleaning reminder ----
// Wired at load: these elements are static markup in index.html, and nothing
// here runs until the owner opens Settings or presses Save.
document.getElementById('settingsBtn')?.addEventListener('click', () => {
  const input = document.getElementById('cleanAfterInput');
  if (input) input.value = cleanAfterDays || '';
  const status = document.getElementById('cleanAfterStatus');
  if (status) status.textContent = '';
});
document.getElementById('cleanAfterSave')?.addEventListener('click', async () => {
  const n = Math.max(0, Math.min(999, Math.floor(Number(document.getElementById('cleanAfterInput').value) || 0)));
  const status = document.getElementById('cleanAfterStatus');
  try {
    await api('/api/settings/clean_after_throw_days', jsonPost({ value: n ? String(n) : '' }, 'PUT'));
    cleanAfterDays = n;
    status.textContent = n ? `Reminder on at ${plural(n, 'throw-day')}.` : 'Reminder off.';
    if (currentView === 'insights') renderInsights();
  } catch (err) { status.textContent = ''; toast(err.message, 'error'); }
});
