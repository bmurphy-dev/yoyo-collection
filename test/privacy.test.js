// Owner-only fields must never reach a logged-out visitor. A regression here
// is silent: the page still renders, it just leaks prices and sellers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, json } from './helpers.js';

const SENSITIVE = ['retail', 'paid', 'percent_off', 'tracking', 'eta', 'in_hand', 'purchase_date', 'sold_date', 'seller', 'buyer', 'market_value', 'trade_value', 'sale_listed_at'];
let s, token, id;

before(async () => {
  s = await startServer({ ADMIN_PASSWORD: 'test-pw' });
  token = (await (await s.api('/api/login', json({ password: 'test-pw' }))).json()).token;
  const auth = { Authorization: 'Bearer ' + token };
  const res = await s.api('/api/yoyos', json({
    brand: 'Testco', model: 'Secret', color: 'Red', retail: 100, paid: 55, market_value: 70, trade_value: 60,
    seller: 'someone', buyer: 'else', tracking: '9400', eta: '2026-01-01', purchase_date: '2026-01-02', sold_date: '2026-01-03',
    in_hand: true, sale_status: 'For Sale', sale_price: 80,
  }, auth));
  assert.equal(res.status, 201);
  id = (await res.json()).id;
});
after(() => s.stop());

test('logged-out list hides every owner-only field', async () => {
  const list = await (await s.api('/api/yoyos')).json();
  const y = list.find((r) => r.id === id);
  assert.ok(y, 'yoyo is publicly listed');
  for (const k of SENSITIVE) assert.ok(!(k in y), `public list leaked ${k}`);
  assert.equal(y.sale_price, 80, 'the public asking price is still shown');
});

test('logged-out single yoyo hides every owner-only field', async () => {
  const y = await (await s.api('/api/yoyos/' + id)).json();
  for (const k of SENSITIVE) assert.ok(!(k in y), `public detail leaked ${k}`);
});

test('the owner still sees them', async () => {
  const y = await (await s.api('/api/yoyos/' + id, { headers: { Authorization: 'Bearer ' + token } })).json();
  assert.equal(y.paid, 55);
  assert.equal(y.seller, 'someone');
});

test('logged-out visitors cannot export CSV, back up, or write', async () => {
  assert.equal((await s.api('/api/export.csv')).status === 200, false);
  assert.equal((await s.api('/api/backup.zip')).status, 401);
  assert.equal((await s.api('/api/yoyos', json({ brand: 'x', model: 'y' }))).status, 403);
});
