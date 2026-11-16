import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import archiver from 'archiver';
import { normalizeDay, isDay } from '../dates.js';
import { throwUuid, eventDayError, sanitizeEventData, precisionError } from '../events.js';
import { listEntries, extractEntry } from '../unzip.js';

test('normalizeDay', () => {
  const cases = {
    '6/15/2026': '2026-06-15', '15/6/2026': '2026-06-15', '1/2/2026': '2026-01-02', '6/15/26': '2026-06-15',
    '2026-6-5': '2026-06-05', '2026-09-01': '2026-09-01',
    '2026-02-30': '2026-02-30', '13/13/2026': '13/13/2026', 'Spring 2024': 'Spring 2024', '': '',
  };
  for (const [input, want] of Object.entries(cases)) assert.equal(normalizeDay(input), want, input);
});

test('unzip.js round-trips stored and deflated entries', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoyo-zip-'));
  const zipPath = path.join(dir, 't.zip');
  const big = Buffer.alloc(300_000, 7);
  await new Promise((resolve, reject) => {
    const out = createWriteStream(zipPath); out.on('close', resolve);
    const a = archiver('zip'); a.on('error', reject); a.pipe(out);
    a.append('hello', { name: 'yoyos.db', store: true });
    a.append(big, { name: 'uploads/a.jpg' });
    a.finalize();
  });
  const entries = listEntries(zipPath);
  assert.deepEqual(entries.map((e) => e.name).sort(), ['uploads/a.jpg', 'yoyos.db']);
  for (const e of entries) {
    const dest = path.join(dir, path.basename(e.name));
    await extractEntry(zipPath, e, dest);
    assert.deepEqual(fs.readFileSync(dest), e.name === 'yoyos.db' ? Buffer.from('hello') : big);
  }
  assert.throws(() => { fs.writeFileSync(path.join(dir, 'bad.zip'), 'nope'); listEntries(path.join(dir, 'bad.zip')); });
});

test('isDay accepts only strict, real ISO days', () => {
  for (const ok of ['2026-06-15', '2024-02-29', '1999-12-31']) assert.equal(isDay(ok), true, ok);
  for (const bad of ['2026-02-30', '2025-02-29', '2026-6-5', '6/15/2026', '2026-06-15T00:00', ' 2026-06-15', '', null, undefined, 20260615]) {
    assert.equal(isDay(bad), false, String(bad));
  }
});

// This value is the contract with the native apps: a throw's id is
// UUIDv5(THROW_NAMESPACE, "<yoyo uuid lowercased>:throw:<day>"). If this test
// has to change, every client's throw ids stop matching the server's.
test('throwUuid is a fixed, case-insensitive v5 derivation', () => {
  const want = '29bd84ab-771b-56e5-b520-36a9a5367e02';
  assert.equal(throwUuid('3f2504e0-4f89-41d3-9a0c-0305e82c3301', '2026-11-15'), want);
  assert.equal(throwUuid('3F2504E0-4F89-41D3-9A0C-0305E82C3301', '2026-11-15'), want);
  assert.notEqual(throwUuid('3f2504e0-4f89-41d3-9a0c-0305e82c3301', '2026-11-16'), want);
});

test('event validators', () => {
  const noon = new Date('2026-06-15T12:00:00Z');
  assert.equal(eventDayError('2026-06-15', noon), null);
  assert.equal(eventDayError('2026-06-16', noon), null, 'one day of slack for clients ahead of UTC');
  assert.ok(eventDayError('2026-06-17', noon));
  assert.ok(eventDayError('2026-02-30', noon));

  assert.deepEqual(sanitizeEventData({ a: ' x ', n: 3, b: false, o: {}, arr: [1], nul: null, nan: NaN, blank: '' }), { a: 'x', n: 3, b: false });
  assert.deepEqual(sanitizeEventData('nope'), {});
  assert.deepEqual(sanitizeEventData([1, 2]), {});
  assert.equal(sanitizeEventData({ long: 'x'.repeat(500) }).long.length, 200);
  assert.equal(Object.keys(sanitizeEventData(Object.fromEntries(Array.from({ length: 40 }, (_, i) => ['k' + i, i])))).length, 20);

  assert.equal(precisionError({}, '2019-03-05'), null);
  assert.equal(precisionError({ precision: 'year' }, '2019-01-01'), null);
  assert.equal(precisionError({ precision: 'month' }, '2019-03-01'), null);
  assert.ok(precisionError({ precision: 'year' }, '2019-03-01'));
  assert.ok(precisionError({ precision: 'month' }, '2019-03-02'));
  assert.ok(precisionError({ precision: 'week' }, '2019-01-01'));
});
