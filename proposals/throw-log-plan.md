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
- **`GET /api/events/summary?type=throw&from=YYYY-MM-DD`** is owner-only and returns one small row per yoyo, `{ yoyo_uuid, first_on, last_on, days }`, from a single `GROUP BY` over live rows on or after `from`. Leaving out `from` means all time. The rankings only look back a year, so the one-year window of raw rows covers them. This endpoint serves the long-term analytics: Most thrown over 2, 3, 5, and 10 years or all time (`from` = today minus N years), plus the detail view's all-time facts ("Last thrown 2 years ago", "63 days in total", "first thrown Mar 2024"). It never ships raw rows, so its size is bounded by the collection rather than by how long the log has run.
- **`GET /api/events/histogram?type=throw&from=&bucket=year|month[&yoyo_uuid=]`** is owner-only. It returns `[{ bucket: "2024" | "2024-03", days, yoyos }]` via `strftime('%Y')` or `strftime('%Y-%m')` grouping, where `days` counts throw-days and `yoyos` counts distinct yoyos. It's collection-wide unless `yoyo_uuid` is given. Ten years by month is at most 120 rows. The new `idx_events_day (type, occurred_on)` index keeps these range scans off the per-yoyo index.
- **`GET /api/events`** also accepts `to=YYYY-MM-DD`, so the calendar can fetch a single older month on demand.
- **`POST /api/yoyos/:id/events`** with `{ type: "throw", occurred_on }` toggles in a transaction. `occurred_on` can be any valid past day, not just today, which covers past-day logging with no extra route. An optional `{ ensure: true }` turns the toggle into "make sure it's on", which the bulk action and #13's contest/milestone logging use so a repeat never un-ticks a day. If the derived-uuid row is missing it's inserted; if it's live it gets tombstoned; if it's tombstoned it's revived. Each branch stamps `updated_at = nowSql()` and `rev = nextRev()`. It deliberately does **not** call `touchYoyo()`, unlike photos and videos, because events ride their own feed and must not bump the parent's `updated_at`. It returns `{ uuid, live }`. (Non-throw types arrive with #13.)
- **`GET /api/sync/events?since=&limit=`** follows the auth, cursor, limit clamp and `{ serverTime, latestRev, hasMore, events }` shape of `/api/sync/changes`, with tombstones included.
- **`POST /api/sync/events`** takes `{ events: [...] }`, capped at 500 because rows are tiny. Each row is checked with the existing `UUID_RE` and `acceptTimestamp()` and the `events.js` validators, then resolved last-writer-wins exactly like `/api/sync/push`: `updatedAt <= existing.updated_at` returns `server-newer`. Two throw-specific checks: a throw's `uuid` must equal `throwUuid(yoyo_uuid, occurred_on)`, otherwise `bad-id`, which keeps convergence enforced rather than hoped for. An unknown `yoyo_uuid` returns `unknown-yoyo`, so a client pushes yoyos before their events. Results are `[{ uuid, applied, rev | reason }]`, the same format push uses.
- **Gates need no changes:** the write gate already returns a 401 for `/api/sync/*`. `isPublish()` matches `/api/sync/` by prefix, so a read-only mirror still receives events from its master device, while the web toggle on a mirror stays blocked.
- **`restoreFromZip`:** read `yoyo_events` from the backup, treating a missing table as an empty list the way `videos` does. Inside the existing transaction, run `DELETE FROM yoyo_events`, insert the backup's rows through `insertFrom`, and re-stamp their revs after the yoyos, so sync clients re-pull. Add `events` to the response counts.

### 4. `public/app.js`

- **`localDay()`** returns `YYYY-MM-DD` built from `getFullYear/getMonth/getDate`, never `toISOString()`, which is UTC. (The existing `sold_date` default uses `toISOString()` and so has the same off-by-one after about 7pm in US time zones. I'd leave that alone here and mention it separately.)
- **`loadAll()`:** when `isOwnerState` is true, fetch `/api/events?type=throw&from=<one year ago>` and `/api/events/summary?type=throw` alongside `/api/yoyos`, keeping the same `loadGen` staleness guard. Build a `throwDays` map from `yoyo_uuid` to a set of days (for charts, the calendar, and streaks) and a `throwSummary` map (for all-time rankings). Public viewers skip both requests entirely.
- **"Used today":** a new `hero-act` button next to Favorite / In hand / Retired (only when `canEditState`), plus an entry in the card's "more" menu. It flips the local map optimistically, POSTs, and rolls back with a toast on error. It needs no `loadAll()` round trip.
- **Past days:** the sparkline's day cells and the throw calendar's days are buttons for the owner. Tapping one toggles that `occurred_on` through the same optimistic path. Future days are disabled.
- **Bulk "Used today":** a new action in the Collection view's existing select mode. It POSTs `{ ensure: true }` for each selected yoyo in sequence, the way the For Sale bulk status change loops over `patchYoyo()`, then shows the same "Updated N yoyos" toast and leaves select mode.
- **Detail view:** a line under the hero reading "Last thrown 3 days ago · 41 days this year", and a 12-week sparkline drawn as inline SVG.
- **Rankings:** `mostThrown(period)`, `isEdc(y)` (throw-days in the last 30 at or above `EDC_MIN_DAYS = 15`), `isShelfQueen(y)` (throw-days in the last 365 at or below `SHELF_QUEEN_MAX_DAYS = 2`, never thrown included, and owned at least `SHELF_QUEEN_OWNED_DAYS = 90`, measured from `parseDay(purchase_date)` or else `created_at`), and `isCollectingDust(y)` (above that 2-day line in the last 365, but none in the last `DUST_DAYS = 90`). Splitting on the same line keeps the two exclusive. All four are in-hand only, and the thresholds are named constants at the top of the section.
- **Insights:** a "Most thrown" `insightCard` with a Week / Month / Year / 2y / 3y / 5y / 10y / All switch feeding `barChart(rows, 'var(--accent)')`. Week, month, and year are computed from the loaded `throwDays` map. The longer spans call `/api/events/summary?from=` the first time each is picked and cache the result until the next `loadAll()`. Spans longer than the log's history (from the earliest `first_on` in the all-time summary) are hidden. Next to it goes a **Long-term trends** card: `/api/events/histogram?bucket=year` as a bar per year, switching to `bucket=month` within a chosen span. EDC, Collecting dust, and Shelf queen cards (still judged on their 30/90/365-day snapshots) list their yoyos as clickable rows into the detail view. "Most thrown" and the **current streak** join the standouts. The streak is the longest run of consecutive days ending today or yesterday with at least one throw across the collection, and a per-yoyo streak shows on the detail view. All of it is owner-only and hidden until at least one throw exists.
- **Throw calendar:** an Insights card that reuses the Arrivals calendar's `cal-grid` markup and month navigation (`calMonth`-style state, kept separately so the two calendars don't share a month). Days are shaded by how many yoyos were thrown, and selecting a day lists them. On the detail view, the same grid is filtered to one yoyo, with owner-tappable days. Navigating to a month older than the loaded one-year window fetches that month with `from`/`to` and caches it, so the calendar can browse the whole history without loading it up front. The detail view also gets a per-yoyo "year by year" line from `/api/events/histogram?bucket=year&yoyo_uuid=`.
- **Yoyo of the day:** for the owner, `yoyoOfTheDay()` draws from Collecting dust plus Shelf queen when that pool isn't empty, keeping the same stable day-number rotation so the pick doesn't change on every render. Public viewers and empty pools keep today's behavior.
- **Badges:** small EDC and Shelf queen tags on cards and the detail hero (owner-only), reusing the existing `.tag` style.

### 5. `public/styles.css`

The on-state for the new hero button and the sparkline sizing. Both reuse existing tokens, so dark mode comes for free.

### 6. Docs and demo

- `README.md`: add the new routes under **REST API**.
- `CHANGELOG.md`: an entry.
- `seed-demo.mjs`: seed about 60 days of throws, skewed toward two or three yoyos, so the demo's Insights cards and every ranking have something to show (include one never-thrown shelf queen and one long-idle yoyo). The demo already refuses writes, so this is display-only.

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
- Tap yesterday on the sparkline, and a row for yesterday appears. Future days can't be tapped.
- Bulk "Used today" on four yoyos creates four rows. Running it again changes nothing, because `ensure` never un-ticks.
- Rankings with seeded data: a yoyo thrown on 16 of the last 30 days is EDC. One thrown on 10 days last spring and not in the last 100 days is Collecting dust. An in-hand yoyo bought 6 months ago with no throws is Shelf queen, and so is one thrown on 2 days this year, but not one thrown on 3 (that's Collecting dust if none were recent). One bought last week isn't a Shelf queen. No yoyo ever shows as both.
- With throws seeded across six years: Most thrown offers 2y, 3y, and 5y but hides 10y. Each span's ranking matches a hand count. Long-term trends shows six yearly bars, and switching to months within a span shows the right monthly totals. The calendar browses back to the first month with throws.
- The streak counts correctly across a month boundary, and resets after a day with no throws.
- Yoyo of the day picks from Collecting dust/Shelf queen for the owner, stays stable across reloads that day, and is unchanged for public viewers.

### For the Apple app side

The contract is four things: the `yoyo_events` row shape, the two sync routes, the v5 namespace plus the `"<yoyo_uuid>:throw:<YYYY-MM-DD>"` name format for throw ids, and "push yoyos before their events." Everything else in the app is optional. An app that never calls `/api/sync/events` keeps working unchanged.

---

**Edit 3:** long-term analytics: `summary` gains `from`, a new `histogram` endpoint, the `idx_events_day` index, `to` on `GET /api/events`, 2y/3y/5y/10y/All in Most thrown, a Long-term trends card, per-yoyo year by year, and the calendar browsing past a year. The rankings keep their 30/90/365-day snapshots.

**Edit 2:** Shelf queen now means at most 2 throw-days in the last year, and Collecting dust means 3+ in the year with none in 90 days. The summary endpoint's purpose moves to the detail view's all-time facts.

**Edit:** added past-day logging (`occurred_on` can be any past day), `ensure` mode, bulk "Used today," `/api/events/summary` for the all-time rankings, the EDC / Collecting dust / Shelf queen / streak definitions, the throw calendar, the Yoyo of the day bias, and matching test cases.
