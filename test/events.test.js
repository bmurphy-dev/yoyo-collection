// The event log: throws ("used today") and the maintenance / contest /
// provenance types that share yoyo_events. Server rules only — who may read
// and write, how a throw's derived id keeps one row per yoyo per day, how
// sync merges, and what restore does to the log.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as archiverPkg from 'archiver';
import { startServer, json } from './helpers.js';
import { throwUuid } from '../events.js';
import { listEntries, extractEntry } from '../unzip.js';

const DAY = '2026-03-10';
const utcDay = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const ts = (offsetSec = 0) => new Date(Date.now() + offsetSec * 1000).toISOString().slice(0, 19).replace('T', ' ');

let s, auth, yoyo;
const get = async (p, headers = auth) => (await s.api(p, { headers })).json();
const post = (p, body, headers = auth) => s.api(p, json(body, headers));
const send = (method, p, body) => s.api(p, { ...json(body, auth), method });
const login = async (srv) => ({ Authorization: 'Bearer ' + (await (await srv.api('/api/login', json({ password: 'test-pw' }))).json()).token });
const addYoyo = async (model, srv = s, headers = auth) => (await srv.api('/api/yoyos', json({ brand: 'Testco', model, in_hand: true }, headers))).json();
const log = async (id, body) => (await post(`/api/yoyos/${id}/events`, body)).json();
const rowsFor = (id, type) => get(`/api/yoyos/${id}/events${type ? `?type=${type}` : ''}`);

before(async () => {
  s = await startServer({ ADMIN_PASSWORD: 'test-pw' });
  auth = await login(s);
  yoyo = await addYoyo('Thrower');
});
after(() => s.stop());

test('a throw toggles one row per yoyo per day, whoever taps', async () => {
  const other = await login(s); // a second signed-in session
  const a = await log(yoyo.id, { type: 'throw', occurred_on: DAY });
  assert.deepEqual(a, { uuid: throwUuid(yoyo.uuid, DAY), live: true });
  const b = await (await post(`/api/yoyos/${yoyo.id}/events`, { type: 'throw', occurred_on: DAY }, other)).json();
  assert.deepEqual(b, { uuid: a.uuid, live: false }, 'the second tap un-ticks the same row');
  assert.equal((await rowsFor(yoyo.id, 'throw')).length, 0);

  const c = await log(yoyo.id, { type: 'throw', occurred_on: DAY });
  assert.equal(c.live, true);
  const feed = (await get('/api/sync/events?since=0')).events.filter((e) => e.uuid === a.uuid);
  assert.equal(feed.length, 1, 'off and on again reuses the row');
  assert.equal(feed[0].deleted_at, null);
});

test('logging never touches the yoyo itself', async () => {
  const before = await get(`/api/yoyos/${yoyo.id}`);
  await log(yoyo.id, { type: 'throw', occurred_on: '2026-03-11' });
  await log(yoyo.id, { type: 'clean', occurred_on: '2026-03-11' });
  const now = await get(`/api/yoyos/${yoyo.id}`);
  assert.equal(now.updated_at, before.updated_at);
  assert.equal(now.rev, before.rev);
});

// "New colorway" adds an ordinary new yoyo, so it gets its own uuid — and with
// it an empty log of its own, however alike the two yoyos are.
test('another colorway of the same model has its own log', async () => {
  const twin = await (await post('/api/yoyos', { brand: 'Testco', model: 'Thrower', color: 'Other colorway', in_hand: true })).json();
  assert.notEqual(twin.uuid, yoyo.uuid);
  assert.deepEqual(await rowsFor(twin.id), []);
  await log(twin.id, { type: 'lent', occurred_on: DAY, data: { to: 'Sam', due: '2099-01-01' } });
  assert.equal((await rowsFor(twin.id))[0].data.due, '2099-01-01', 'a due-back date may be in the future');
  assert.ok(!(await rowsFor(yoyo.id)).some((e) => e.type === 'lent'));
});

test('ensure only ever turns a day on', async () => {
  const ids = [];
  for (const m of ['A', 'B', 'C', 'D']) ids.push((await addYoyo(`Bulk ${m}`)).id);
  for (let round = 0; round < 2; round++) {
    for (const id of ids) assert.equal((await log(id, { type: 'throw', occurred_on: DAY, ensure: true })).live, true);
  }
  for (const id of ids) assert.equal((await rowsFor(id, 'throw')).length, 1);
});

test('occurred_on must be a real, non-future ISO day', async () => {
  for (const bad of ['2026-02-30', '6/15/2026', '2026-3-1', utcDay(2), '', undefined]) {
    const res = await post(`/api/yoyos/${yoyo.id}/events`, { type: 'throw', occurred_on: bad });
    assert.equal(res.status, 400, `accepted ${bad}`);
  }
  assert.equal((await post(`/api/yoyos/${yoyo.id}/events`, { type: 'throw', occurred_on: utcDay(1), ensure: true })).status, 200,
    'tomorrow (UTC) is today for a client ahead of the server');
  assert.equal((await post(`/api/yoyos/${yoyo.id}/events`, { type: 'Bad Type', occurred_on: DAY })).status, 400);
  assert.equal((await post('/api/yoyos/999999/events', { type: 'throw', occurred_on: DAY })).status, 404);
});

test('visitors cannot read or write the log', async () => {
  for (const p of ['/api/events', '/api/events/summary', '/api/events/histogram', `/api/yoyos/${yoyo.id}/events`]) {
    assert.equal((await s.api(p)).status, 403, p);
  }
  assert.equal((await s.api('/api/sync/events')).status, 401);
  assert.equal((await s.api(`/api/yoyos/${yoyo.id}/events`, json({ type: 'throw', occurred_on: DAY }))).status, 403);
  assert.equal((await s.api('/api/sync/events', json({ events: [] }))).status, 401);
  const pub = await (await s.api(`/api/yoyos/${yoyo.id}`)).json();
  assert.ok(!('events' in pub));
});

test('maintenance events: several a day, edit, delete leaves a tombstone', async () => {
  const y = await addYoyo('Serviced');
  const clean = await log(y.id, { type: 'clean', occurred_on: DAY, note: ' flushed ', data: { lube: 'thin', nested: { no: 1 }, blank: ' ' } });
  assert.equal(clean.note, 'flushed');
  assert.deepEqual(clean.data, { lube: 'thin' }, 'data keeps flat primitives only');
  const pads = await log(y.id, { type: 'pads', occurred_on: DAY, data: { response: '19mm slim' } });
  assert.notEqual(clean.uuid, pads.uuid);
  assert.equal((await rowsFor(y.id)).length, 2);

  const edited = await (await send('PUT', `/api/events/${pads.uuid}`, { note: 'blue pads', occurred_on: '2026-03-09' })).json();
  assert.equal(edited.note, 'blue pads');
  assert.equal(edited.occurred_on, '2026-03-09');
  assert.deepEqual(edited.data, { response: '19mm slim' }, 'fields left out are kept');
  assert.equal(edited.type, 'pads');

  assert.equal((await s.api(`/api/events/${clean.uuid}`, { method: 'DELETE', headers: auth })).status, 200);
  assert.equal((await rowsFor(y.id)).length, 1);
  const tomb = (await get('/api/sync/events?since=0&limit=500')).events.find((e) => e.uuid === clean.uuid);
  assert.ok(tomb.deleted_at, 'the delete syncs as a tombstone');
  assert.equal((await send('PUT', `/api/events/${clean.uuid}`, { note: 'x' })).status, 404);
});

test('a throw cannot be edited, and nothing can become one', async () => {
  const y = await addYoyo('Retype');
  const t = await log(y.id, { type: 'throw', occurred_on: DAY });
  const n = await log(y.id, { type: 'note', occurred_on: DAY });
  assert.equal((await send('PUT', `/api/events/${t.uuid}`, { occurred_on: '2026-03-01' })).status, 400);
  assert.equal((await send('PUT', `/api/events/${t.uuid}`, { type: 'note' })).status, 400);
  assert.equal((await send('PUT', `/api/events/${n.uuid}`, { type: 'throw' })).status, 400);
});

test('a contest or milestone also counts as a throw that day', async () => {
  const y = await addYoyo('Competitor');
  const throws = async () => (await rowsFor(y.id, 'throw')).map((e) => e.occurred_on).sort();
  const a = await log(y.id, { type: 'contest', occurred_on: DAY, data: { contest: 'Worlds', division: '1A', placement: 3 } });
  await log(y.id, { type: 'contest', occurred_on: DAY, data: { contest: 'Worlds', division: '3A' } });
  assert.equal((await rowsFor(y.id, 'contest')).length, 2, 'two divisions, two rows');
  assert.deepEqual(await throws(), [DAY], 'still one throw');

  await s.api(`/api/events/${a.uuid}`, { method: 'DELETE', headers: auth });
  assert.deepEqual(await throws(), [DAY], 'deleting the contest keeps the throw');

  await log(y.id, { type: 'throw', occurred_on: '2026-03-12' });
  await log(y.id, { type: 'throw', occurred_on: '2026-03-12' }); // un-ticked
  await log(y.id, { type: 'milestone', occurred_on: '2026-03-12', data: { trick: 'Kwijibo' } });
  assert.deepEqual(await throws(), [DAY, '2026-03-12'], 'a milestone revives an un-ticked day');

  const m = (await rowsFor(y.id, 'milestone'))[0];
  await send('PUT', `/api/events/${m.uuid}`, { occurred_on: '2026-03-13' });
  assert.deepEqual(await throws(), [DAY, '2026-03-12', '2026-03-13'], 're-dating ensures the new day and leaves the old');
});

test('approximate dates must sit on the first day of their period', async () => {
  const y = await addYoyo('Vintage');
  const ok = await post(`/api/yoyos/${y.id}/events`, { type: 'history', occurred_on: '2019-01-01', data: { precision: 'year', from: 'X' } });
  assert.equal(ok.status, 201);
  assert.equal((await post(`/api/yoyos/${y.id}/events`, { type: 'history', occurred_on: '2019-03-01', data: { precision: 'month' } })).status, 201);
  assert.equal((await post(`/api/yoyos/${y.id}/events`, { type: 'history', occurred_on: '2019-03-01', data: { precision: 'year' } })).status, 400);
  assert.equal((await post(`/api/yoyos/${y.id}/events`, { type: 'history', occurred_on: '2019-03-02', data: { precision: 'month' } })).status, 400);
  assert.equal((await post(`/api/yoyos/${y.id}/events`, { type: 'history', occurred_on: '2019-01-01', data: { precision: 'decade' } })).status, 400);
  const { uuid } = await ok.json();
  assert.equal((await send('PUT', `/api/events/${uuid}`, { occurred_on: '2019-06-01' })).status, 400, 'an edit is checked against the kept precision');
});

test('collection reads: compact rows, ranges, summary, histogram, deleted yoyos', async () => {
  const y = await addYoyo('Counted');
  const gone = await addYoyo('Deleted later');
  for (const d of ['2024-05-01', '2024-05-02', '2025-01-15']) await log(y.id, { type: 'throw', occurred_on: d });
  await log(gone.id, { type: 'throw', occurred_on: '2024-05-01' });
  await log(y.id, { type: 'lent', occurred_on: '2025-01-15', data: { to: 'Sam' } });

  const mine = (rows) => rows.filter((r) => r.yoyo_uuid === y.uuid);
  const compact = mine(await get('/api/events?type=throw&from=2024-05-02&to=2025-01-15'));
  assert.deepEqual(compact.map((r) => r.occurred_on), ['2024-05-02', '2025-01-15']);
  assert.deepEqual(Object.keys(compact[0]).sort(), ['occurred_on', 'type', 'uuid', 'yoyo_uuid']);
  const full = mine(await get('/api/events?type=lent,returned&full=1'));
  assert.deepEqual(full[0].data, { to: 'Sam' });
  assert.equal((await s.api('/api/events?from=nope', { headers: auth })).status, 400);
  assert.equal((await s.api('/api/events?type=Nope', { headers: auth })).status, 400);

  assert.deepEqual(mine(await get('/api/events/summary')), [{ yoyo_uuid: y.uuid, first_on: '2024-05-01', last_on: '2025-01-15', days: 3 }]);
  assert.equal(mine(await get('/api/events/summary?from=2025-01-01'))[0].days, 1);
  assert.deepEqual(await get(`/api/events/histogram?bucket=year&yoyo_uuid=${y.uuid}`),
    [{ bucket: '2024', days: 2, yoyos: 1 }, { bucket: '2025', days: 1, yoyos: 1 }]);
  assert.deepEqual(await get(`/api/events/histogram?bucket=month&from=2024-01-01&to=2024-12-31&yoyo_uuid=${y.uuid}`),
    [{ bucket: '2024-05', days: 2, yoyos: 1 }]);

  const may = async () => (await get('/api/events/histogram?bucket=month&from=2024-05-01&to=2024-05-31'))[0];
  assert.deepEqual(await may(), { bucket: '2024-05', days: 3, yoyos: 2 });
  await s.api(`/api/yoyos/${gone.id}`, { method: 'DELETE', headers: auth });
  assert.deepEqual(await may(), { bucket: '2024-05', days: 2, yoyos: 1 }, 'a deleted yoyo drops out of stats');
  assert.ok((await get('/api/sync/events?since=0&limit=500')).events.some((e) => e.yoyo_uuid === gone.uuid), 'but its events stay as history');
});

test('sync push: validation, derived throw ids, last-writer-wins', async () => {
  const y = await addYoyo('Synced');
  const push = async (...events) => (await (await post('/api/sync/events', { events })).json()).results;
  const base = { yoyo_uuid: y.uuid, type: 'throw', occurred_on: DAY, updated_at: ts(-60), created_at: ts(-60) };
  const id = throwUuid(y.uuid, DAY);
  const rnd = () => crypto.randomUUID();

  const reasons = (await push(
    { ...base, uuid: 'nope' },
    { ...base, uuid: rnd() },
    { ...base, uuid: id, yoyo_uuid: rnd() },
    { ...base, uuid: id, occurred_on: '2026-02-30' },
    { ...base, uuid: id, updated_at: 'yesterday' },
    { ...base, uuid: id, deleted_at: 'yesterday' },
    { ...base, uuid: rnd(), type: 'Bad' },
    { ...base, uuid: rnd(), type: 'history', occurred_on: '2019-03-01', data: { precision: 'year' } },
  )).map((r) => r.reason);
  assert.deepEqual(reasons, ['bad-uuid', 'bad-id', 'unknown-yoyo', 'bad-day', 'bad-timestamp', 'bad-timestamp', 'bad-type', 'bad-precision']);

  // Devices may spell uuids in upper case; ids still converge.
  const [applied] = await push({ ...base, uuid: id.toUpperCase(), yoyo_uuid: y.uuid.toUpperCase() });
  assert.equal(applied.applied, true);
  assert.equal(applied.uuid, id.toUpperCase(), 'results echo the id as sent');
  assert.deepEqual((await rowsFor(y.id, 'throw')).map((e) => [e.uuid, e.yoyo_uuid]), [[id, y.uuid]]);

  assert.equal((await push({ ...base, uuid: id, updated_at: ts(-120), deleted_at: ts(-120) }))[0].reason, 'server-newer');
  assert.equal((await push({ ...base, uuid: id }))[0].reason, 'server-newer', 'a tie goes to the server');
  const [del] = await push({ ...base, uuid: id, updated_at: ts(-30), deleted_at: ts(-30) });
  assert.equal(del.applied, true);
  assert.equal((await rowsFor(y.id, 'throw')).length, 0);
  // The web toggle revives the very row a device tombstoned.
  assert.deepEqual(await log(y.id, { type: 'throw', occurred_on: DAY }), { uuid: id, live: true });

  // Pushed rows are stored literally: an unknown type survives, and a contest
  // pushed alone creates no throw.
  const [c, u] = await push(
    { ...base, uuid: rnd(), type: 'contest', occurred_on: '2026-03-20', data: { contest: 'Nationals' } },
    { ...base, uuid: rnd(), type: 'restring_v2', occurred_on: '2026-03-21', note: 'from a newer app' },
  );
  assert.ok(c.applied && u.applied);
  const all = await rowsFor(y.id);
  assert.ok(all.some((e) => e.type === 'restring_v2' && e.note === 'from a newer app'));
  assert.ok(!all.some((e) => e.type === 'throw' && e.occurred_on === '2026-03-20'));

  // An event can't move to another yoyo or turn into a throw.
  const other = await addYoyo('Other');
  assert.equal((await push({ ...base, uuid: c.uuid, type: 'contest', yoyo_uuid: other.uuid, updated_at: ts() }))[0].reason, 'bad-id');

  assert.equal((await post('/api/sync/events', { events: Array.from({ length: 501 }, () => ({})) })).status, 400);
  assert.equal((await post('/api/sync/events', {})).status, 400);
});

// The Apple apps write uuids in UPPER case; the web and Android in lower. The
// log keys a yoyo by its lowercased uuid, so it works for either.
test('a yoyo with an upper-case uuid logs and reads like any other', async () => {
  const UP = crypto.randomUUID().toUpperCase();
  const pushed = await (await post('/api/sync/push', { yoyos: [{ uuid: UP, brand: 'Appleco', model: 'Upper', in_hand: true, updated_at: ts(-60), created_at: ts(-60) }] })).json();
  assert.equal(pushed.results[0].applied, true);
  const y = (await get('/api/yoyos')).find((r) => r.model === 'Upper');
  assert.equal(y.uuid, UP);

  const t = await log(y.id, { type: 'throw', occurred_on: DAY });
  assert.equal(t.uuid, throwUuid(UP.toLowerCase(), DAY), 'the derived id ignores case');
  await log(y.id, { type: 'clean', occurred_on: DAY });
  const key = UP.toLowerCase();
  assert.deepEqual((await rowsFor(y.id)).map((e) => e.yoyo_uuid), [key, key]);
  assert.equal((await get('/api/events?type=throw')).filter((e) => e.yoyo_uuid === key).length, 1);
  assert.equal((await get('/api/events/summary')).find((r) => r.yoyo_uuid === key).days, 1);
  assert.equal((await get(`/api/events/histogram?yoyo_uuid=${UP}`))[0].days, 1);

  const res = (await (await post('/api/sync/events', { events: [
    { uuid: throwUuid(UP, '2026-03-11').toUpperCase(), yoyo_uuid: UP, type: 'throw', occurred_on: '2026-03-11', updated_at: ts(-5) },
  ] })).json()).results[0];
  assert.equal(res.applied, true);
  assert.equal((await rowsFor(y.id, 'throw')).length, 2);
});

test('the sync feed pages by rev', async () => {
  const first = await get('/api/sync/events?since=0&limit=2');
  assert.equal(first.events.length, 2);
  assert.equal(first.hasMore, true);
  const next = await get(`/api/sync/events?since=${first.events[1].rev}&limit=500`);
  assert.ok(next.events.every((e) => e.rev > first.events[1].rev));
  assert.equal(next.hasMore, false);
  assert.equal(next.latestRev >= next.events.at(-1).rev, true);
});

test('read-only mode blocks the web toggle but still accepts a sync push', async () => {
  const y = await addYoyo('Mirror');
  await send('PUT', '/api/settings/read_only', { value: '1' });
  try {
    assert.equal((await post(`/api/yoyos/${y.id}/events`, { type: 'throw', occurred_on: DAY })).status, 403);
    const res = await (await post('/api/sync/events', { events: [
      { uuid: throwUuid(y.uuid, DAY), yoyo_uuid: y.uuid, type: 'throw', occurred_on: DAY, updated_at: ts(-5) },
    ] })).json();
    assert.equal(res.results[0].applied, true);
    assert.equal((await rowsFor(y.id, 'throw')).length, 1, 'and the owner can still read the log');
  } finally {
    await send('PUT', '/api/settings/read_only', { value: '' });
  }
});

test('demo mode blocks both', async () => {
  const d = await startServer({ ADMIN_PASSWORD: 'test-pw', DEMO_MODE: '1' });
  try {
    const h = await login(d);
    assert.equal((await d.api('/api/yoyos/1/events', json({ type: 'throw', occurred_on: DAY }, h))).status, 403);
    assert.equal((await d.api('/api/sync/events', json({ events: [] }, h))).status, 403);
    assert.equal((await d.api('/api/events', { headers: h })).status, 200, 'the signed-in demo visitor can still look');
  } finally { await d.stop(); }
});

// ---- Backup / restore ----
async function downloadBackup(srv, headers, dest) {
  fs.writeFileSync(dest, Buffer.from(await (await srv.api('/api/backup.zip', { headers })).arrayBuffer()));
}
async function restore(srv, headers, zipPath) {
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(zipPath)], { type: 'application/zip' }), 'backup.zip');
  const res = await srv.api('/api/restore', { method: 'POST', headers, body: fd });
  assert.equal(res.status, 200);
  return res.json();
}
// A database-only zip, as the native apps' "Publish to website" sends.
function zipDb(dbPath, dest) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest); out.on('close', resolve);
    // archiver 7 exports a factory, archiver 8 a class; work with either.
    const a = archiverPkg.ZipArchive ? new archiverPkg.ZipArchive({ store: true }) : archiverPkg.default('zip', { store: true });
    a.on('error', reject); a.pipe(out);
    a.file(dbPath, { name: 'yoyos.db' });
    a.finalize();
  });
}

test('a backup round-trips the log; one without the table leaves it alone', async () => {
  const r = await startServer({ ADMIN_PASSWORD: 'test-pw' });
  try {
    const h = await login(r);
    const y = await addYoyo('Kept', r, h);
    const lg = (body) => r.api(`/api/yoyos/${y.id}/events`, json(body, h));
    const days = async () => (await (await r.api('/api/events?type=throw', { headers: h })).json()).map((e) => e.occurred_on);
    await lg({ type: 'throw', occurred_on: '2026-01-01' });
    await lg({ type: 'clean', occurred_on: '2026-01-02', data: { lube: 'thin' } });
    const zip = path.join(r.dir, 'with-events.zip');
    await downloadBackup(r, h, zip);

    // Logged after the backup, so a faithful restore must drop it again.
    await lg({ type: 'throw', occurred_on: '2026-01-03' });
    const cursor = (await (await r.api('/api/sync/events?since=0', { headers: h })).json()).latestRev;
    const out = await restore(r, h, zip);
    assert.equal(out.events, 2);
    assert.equal(out.eventsKept, 0);
    assert.deepEqual(await days(), ['2026-01-01']);
    const restored = (await (await r.api('/api/yoyos', { headers: h })).json())[0];
    const evs = await (await r.api(`/api/yoyos/${restored.id}/events`, { headers: h })).json();
    assert.deepEqual(evs.map((e) => e.type).sort(), ['clean', 'throw'], 'events reattach to the restored yoyo by uuid');
    assert.deepEqual(evs.find((e) => e.type === 'clean').data, { lube: 'thin' });
    const feed = await (await r.api(`/api/sync/events?since=${cursor}`, { headers: h })).json();
    assert.equal(feed.events.length, 2, 'restored events get fresh revs so devices re-pull them');

    // A backup with no yoyo_events table: taken before the log existed, or
    // published from a native app.
    // Built from a real backup's database with the table dropped.
    await r.api(`/api/yoyos/${restored.id}/events`, json({ type: 'throw', occurred_on: '2026-01-04' }, h));
    const fresh = path.join(r.dir, 'fresh.zip');
    await downloadBackup(r, h, fresh);
    const bare = path.join(r.dir, 'bare.db');
    await extractEntry(fresh, listEntries(fresh).find((e) => e.name === 'yoyos.db'), bare);
    const db = new DatabaseSync(bare);
    // The app also spells uuids in upper case; the kept log must still attach.
    db.exec('UPDATE yoyos SET uuid = upper(uuid)');
    db.exec('DROP TABLE yoyo_events');
    db.close();
    const bareZip = path.join(r.dir, 'no-events.zip');
    await zipDb(bare, bareZip);
    const out2 = await restore(r, h, bareZip);
    assert.equal(out2.eventsKept, 3);
    assert.deepEqual(await days(), ['2026-01-01', '2026-01-04'], 'the site keeps its own log');
    const after = (await (await r.api('/api/yoyos', { headers: h })).json())[0];
    assert.equal(after.uuid, y.uuid.toUpperCase());
    assert.equal((await (await r.api(`/api/yoyos/${after.id}/events`, { headers: h })).json()).length, 3);
  } finally { await r.stop(); }
});
