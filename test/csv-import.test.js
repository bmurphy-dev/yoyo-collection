// CSV import must update the row it matches rather than add a duplicate:
// by id/uuid first, then brand + model + color, one claim per record.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, csvForm } from './helpers.js';

let s;
before(async () => { s = await startServer(); });
after(() => s.stop());
const list = async () => (await s.api('/api/yoyos')).json();

test('a new row is created, with quoting and embedded commas/newlines intact', async () => {
  const csv = '﻿Brand,Model,Color,Description,Paid\nAcme,"Quote ""Q""","Red, Blue","line1\nline2",$12.50\n';
  const r = await (await s.api('/api/import', csvForm(csv))).json();
  assert.deepEqual([r.created, r.updated], [1, 0]);
  const y = (await list()).find((x) => x.brand === 'Acme');
  assert.equal(y.model, 'Quote "Q"');
  assert.equal(y.color, 'Red, Blue');
  assert.equal(y.description, 'line1\nline2');
  assert.equal(y.paid, 12.5);
});

test('re-importing the same brand+model+color updates instead of duplicating', async () => {
  const r = await (await s.api('/api/import', csvForm('Brand,Model,Color,Paid\nAcme,"Quote ""Q""","Red, Blue",20\n'))).json();
  assert.deepEqual([r.created, r.updated], [0, 1]);
  const rows = (await list()).filter((x) => x.brand === 'Acme');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].paid, 20);
});

test('two identical rows in one file claim two records, not one twice', async () => {
  await s.api('/api/import', csvForm('Brand,Model,Color\nTwin,Same,Blue\nTwin,Same,Blue\n'));
  const r = await (await s.api('/api/import', csvForm('Brand,Model,Color,Paid\nTwin,Same,Blue,1\nTwin,Same,Blue,2\n'))).json();
  assert.deepEqual([r.created, r.updated], [0, 2]);
  const paid = (await list()).filter((x) => x.brand === 'Twin').map((x) => x.paid).sort();
  assert.deepEqual(paid, [1, 2]);
});

test('a full export re-imports as updates only', async () => {
  const exp = await (await s.api('/api/export.csv')).text();
  const before = (await list()).length;
  const r = await (await s.api('/api/import', csvForm(exp))).json();
  assert.equal(r.created, 0);
  assert.equal((await list()).length, before);
});

test('imported dates are normalized to YYYY-MM-DD; free text is kept', async () => {
  await s.api('/api/import', csvForm('Brand,Model,Color,Purchase Date,Sold Date\nDates,A,,6/15/2026,15/6/2026\nDates,B,,Spring 2024,\n'));
  const rows = Object.fromEntries((await list()).filter((x) => x.brand === 'Dates').map((x) => [x.model, x]));
  assert.equal(rows.A.purchase_date, '2026-06-15');
  assert.equal(rows.A.sold_date, '2026-06-15');
  assert.equal(rows.B.purchase_date, 'Spring 2024');
});
