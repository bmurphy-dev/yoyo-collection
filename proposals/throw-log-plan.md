## Implementation plan (assuming the shared `yoyo_events` table)

This spells out the code changes so you can see the whole footprint before deciding. It assumes you choose the generic events table (question 1). If you'd rather have narrow tables, the shape of the work is the same with different names.

### Two corrections to the proposal above

Writing the plan against the code surfaced two things I got wrong, and I've edited the issue body to match:

- **Restore isn't free.** `restoreFromZip` copies `yoyos`, `photos`, and `videos` row by row rather than swapping the file. `yoyo_events` is keyed by `yoyo_uuid` with no foreign key, so `DELETE FROM yoyos` wouldn't cascade to it. A restore, which is also how a mirror gets published, would keep the old events and drop the backup's. Step 3 below handles it.
- **Insights doesn't read `/api/stats`.** `renderInsights()` computes everything client-side from the in-memory `yoyos` list. Usage data should follow that pattern: a compact owner-only events read that the client aggregates, rather than new aggregates on `/api/stats`.

### 1. `schema.sql`: the table

Append the `yoyo_events` table and its two indexes from the proposal. It's a new table, so `CREATE TABLE IF NOT EXISTS` covers fresh installs and upgrades alike, and **`db.js` needs no migration**. Nothing is `ALTER`ed, so the index-ordering constraints that `uuid` and `rev` needed don't apply.

### 2. `events.js` (new, pure functions, no DB access)

This keeps the validation reviewable in one place, the way `carriers.js` stands apart.

- `EVENT_TYPE_RE = /^[a-z][a-z0-9_]{0,31}$/`, the forward-compatible type check.
- `DAY_RE` plus a real-date check for `occurred_on`. Reject days more than one day past the server's UTC date. The one day of slack covers clients up to UTC+14.
- `sanitizeEventData(obj)` mirrors `sanitizeSyncCustom`: plain object, at most 20 keys, primitive values, strings capped at 200 characters.
- `throwUuid(yoyoUuid, day)` returns a v5 UUID over `${yoyoUuid.toLowerCase()}:throw:${day}` in a fixed namespace constant. `node:crypto` has no v5, so it's about 10 lines over `createHash('sha1')`: set the version and variant bits, then format. The namespace and name format get documented in a comment as the contract the Apple app implements.

### 3. `server.js`

The routes go after the videos section. The sync routes sit next to `/api/sync/changes`.

- **`GET /api/events?type=throw&from=YYYY-MM-DD`** is owner-only. It needs an explicit `isOwner` check, because GETs bypass the write gate. It returns compact rows `{ uuid, yoyo_uuid, type, occurred_on }` across the collection, excluding tombstones and events on deleted yoyos. `type` accepts a comma list, which #13's "due for a clean" uses. This single read powers the Insights card and the "used today" state.
- **`GET /api/yoyos/:id/events`** is owner-only and returns the full rows for one yoyo, newest first.
- **`POST /api/yoyos/:id/events`** with `{ type: "throw", occurred_on }` toggles in a transaction. If the derived-uuid row is missing it's inserted; if it's live it gets tombstoned; if it's tombstoned it's revived. Each branch stamps `updated_at = nowSql()` and `rev = nextRev()`. It deliberately does **not** call `touchYoyo()`, unlike photos and videos, because events ride their own feed and must not bump the parent's `updated_at`. It returns `{ uuid, live }`. (Non-throw types arrive with #13.)
- **`GET /api/sync/events?since=&limit=`** follows the auth, cursor, limit clamp and `{ serverTime, latestRev, hasMore, events }` shape of `/api/sync/changes`, with tombstones included.
- **`POST /api/sync/events`** takes `{ events: [...] }`, capped at 500 because rows are tiny. Each row is checked with the existing `UUID_RE` and `acceptTimestamp()` and the `events.js` validators, then resolved last-writer-wins exactly like `/api/sync/push`: `updatedAt <= existing.updated_at` returns `server-newer`. Two throw-specific checks: a throw's `uuid` must equal `throwUuid(yoyo_uuid, occurred_on)`, otherwise `bad-id`, which keeps convergence enforced rather than hoped for. An unknown `yoyo_uuid` returns `unknown-yoyo`, so a client pushes yoyos before their events. Results are `[{ uuid, applied, rev | reason }]`, the same format push uses.
- **Gates need no changes:** the write gate already returns a 401 for `/api/sync/*`. `isPublish()` matches `/api/sync/` by prefix, so a read-only mirror still receives events from its master device, while the web toggle on a mirror stays blocked.
- **`restoreFromZip`:** read `yoyo_events` from the backup, treating a missing table as an empty list the way `videos` does. Inside the existing transaction, run `DELETE FROM yoyo_events`, insert the backup's rows through `insertFrom`, and re-stamp their revs after the yoyos, so sync clients re-pull. Add `events` to the response counts.

### 4. `public/app.js`

- **`localDay()`** returns `YYYY-MM-DD` built from `getFullYear/getMonth/getDate`, never `toISOString()`, which is UTC. (The existing `sold_date` default uses `toISOString()` and so has the same off-by-one after about 7pm in US time zones. I'd leave that alone here and mention it separately.)
- **`loadAll()`:** when `isOwnerState` is true, fetch `/api/events?type=throw&from=<one year ago>` alongside `/api/yoyos`, keeping the same `loadGen` staleness guard, and build a `throwDays` map from `yoyo_uuid` to a set of days. Public viewers skip the request entirely.
- **"Used today":** a new `hero-act` button next to Favorite / In hand / Retired (only when `canEditState`), plus an entry in the card's "more" menu. It flips the local map optimistically, POSTs, and rolls back with a toast on error. It needs no `loadAll()` round trip.
- **Detail view:** a line under the hero reading "Last thrown 3 days ago · 41 days this year", and a 12-week sparkline drawn as inline SVG.
- **Insights:** a "Most thrown" `insightCard` with a Week / Month / Year switch feeding `barChart(rows, 'var(--accent)')`. Add a "Most thrown" standout next to Most valuable and Heaviest, and optionally a "Gathering dust" card for in-hand yoyos with no throws in 90 days. All of it is owner-only and hidden until at least one throw exists.

### 5. `public/styles.css`

The on-state for the new hero button and the sparkline sizing. Both reuse existing tokens, so dark mode comes for free.

### 6. Docs and demo

- `README.md`: add the new routes under **REST API**.
- `CHANGELOG.md`: an entry.
- `seed-demo.mjs`: seed about 60 days of throws, skewed toward two or three yoyos, so a demo's Insights card isn't empty. The demo already refuses writes, so this is display-only.

### 7. Testing

The repo has no test suite, so this is a manual checklist that goes in the PR description:

- Two browsers toggle the same yoyo on the same day, and one row results.
- Toggling off and on again flips `deleted_at` on that same row.
- `curl` a sync push with a stale `updated_at` and get `server-newer`.
- Push a throw with a random uuid and get `bad-id`.
- Push for an unknown yoyo and get `unknown-yoyo`.
- Read-only mode blocks the web toggle, but a logged-in `/api/sync/events` push still lands.
- Demo mode blocks both.
- A public viewer gets a 403 on `GET /api/events`.
- Round-trip a backup containing events, and restore a backup from before events existed. The second leaves an empty table and doesn't fail.
- Set the browser time zone to UTC−7 and log at 10pm local time. It lands on today.

### For the Apple app side

The contract is four things: the `yoyo_events` row shape, the two sync routes, the v5 namespace plus the `"<yoyo_uuid>:throw:<YYYY-MM-DD>"` name format for throw ids, and "push yoyos before their events." Everything else in the app is optional. An app that never calls `/api/sync/events` keeps working unchanged.
