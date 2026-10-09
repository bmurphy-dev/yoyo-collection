# Feature backlog

Personal notes, kept only on `combined/all-prs` and never sent upstream.

## What upstream will accept

- **Media-shape changes go through the native app's model.** stammig first
  held #7 for a media redesign
  ([comment](https://github.com/stammig/yoyo-collection/pull/7#issuecomment-5554244147)).
  He has since asked for a rebase and is willing to take the 360 spins, provided
  they stay compatible with the native app's spin format. That rebase was done on
  2026-10-09, and his follow-up on the format is pending. Anything else that
  touches media still waits.
- **Additive tables are fine.** PR #8 landed a brand-new `videos` table.
- **The Apple app is a first-class sync client** (`/api/sync/*`). Anything new
  has to be safe for a client that doesn't know about it yet.
- Open an issue first for anything touching the schema or sync.
- **There's a test suite now** (`npm test`, run in CI). New server behavior
  ships with tests in `test/`, using `startServer()` from `test/helpers.js`.
- **Follow `CONTRIBUTING.md`'s "Dates" section.** Use `localDay()`/`parseDay()`
  in the browser and `dates.js` on the server, and never take a day from
  `toISOString()`.

## Sync facts that shape designs

- `/api/sync/push` is **last-writer-wins per whole yoyo record**, decided by
  `updated_at`. A counter column on `yoyos` loses increments when two devices
  write, and each write can clobber unrelated edits to the same record.
- Child lists such as photos and videos are **replaced wholesale** on push. Rows
  missing from the pushed list are deleted (`applyVideoList`,
  `applyPhotoManifest`), so a device that hasn't pulled can erase rows added
  elsewhere. Event logs can't use this pattern.
- **Restore keeps web-only tables when a backup lacks them** (#19). The native
  app's "Publish to website" restores from a database with no `videos` table,
  so the site's videos are carried over. Any new web-only table (such as
  `yoyo_events`) needs the same rule, or every publish from the app wipes it.
- `favorite` is a manual, synced flag. Don't write to it automatically.

## Ideas

| # | Idea | Schema | Status |
|---|---|---|---|
| 1 | In-app 360 creation from a dropped video | media | **Done here only.** Waits on #7, which is rebased and pending stammig's native spin-format follow-up |
| 2 | Wishlist restock/price watcher | product URL can live in `custom`; price history needs a table | idea |
| 3 | Photo import alongside CSV | media | blocked (media) |
| 4 | Maintenance, contest & provenance log | shared `yoyo_events` table (types only) | posted as [#13](https://github.com/stammig/yoyo-collection/issues/13); draft: [proposals/maintenance-log.md](proposals/maintenance-log.md), plan: [proposals/maintenance-log-plan.md](proposals/maintenance-log-plan.md) |
| 5 | Collection value over time | additive snapshots table | idea |
| 6 | Throw log ("used today") | defines shared `yoyo_events` table + sync endpoints | **next**, once stammig answers #12's questions: branch `feat/throw-log` (recut from origin/main 94347ba on 2026-10-09; recut again if main moves before work starts); posted as [#12](https://github.com/stammig/yoyo-collection/issues/12); draft: [proposals/throw-log.md](proposals/throw-log.md), plan: [proposals/throw-log-plan.md](proposals/throw-log-plan.md) |
| 7 | More Insights charts from existing columns | none | idea; easiest PR to get accepted |
| 8 | Side-by-side spec compare (2–3 yoyos) | none | idea |
| 9 | One date convention (local days, UTC instants) + date bug fixes | none | **Done upstream:** [#14](https://github.com/stammig/yoyo-collection/issues/14) was implemented by stammig in [#15](https://github.com/stammig/yoyo-collection/pull/15) (2026-10-04). `relativeDay()` moved to #12, and `formatDay()` + `precision` moved to #13. Record: [proposals/dates.md](proposals/dates.md) |

### 1. In-app 360 creation
Extract spin frames in the browser from a dropped video (canvas seeking plus an
SSIM period detector ported to JS). Replaces the record → `spin-frames.sh` →
zip → upload flow.

### 2. Wishlist restock/price watcher
Poll a product URL for each `in_hand=0` yoyo, reusing the outbound HTTP pattern
from carrier tracking. Flag price drops and restocks on Arrivals.

### 3. Photo import alongside CSV
The README says "Photos aren't imported." Add a companion zip whose files map to
rows by a filename column or brand+model.

### 4. Maintenance & provenance log
Dated per-yoyo events (clean, lube, bearing, pads, string, mod, damage, repair, contest, milestone, autograph, lent/returned, history, note)
shown as a timeline on the detail view. It only adds types to #6's
`yoyo_events` table. Acquisition and sale entries come from the existing yoyo
fields, and events never rewrite specs. Sharing the table is what makes
"throw-days since last clean" and a "Due for a clean" list possible. `contest`
(`data`: contest, division, round, placement) is its own type because a throw row
is a per-day on/off; logging one on the web also ensures that day's throw, while
sync push stays literal. Approximate dates (`data.precision`, `formatDay()`) live
here, because `history` events are their first user. Full
proposal: [proposals/maintenance-log.md](proposals/maintenance-log.md).

### 5. Collection value over time
Snapshot total `market_value` monthly and show a sparkline in Insights.

### 6. Throw log ("used today")
A one-tap "used today" toggle on each yoyo. Weekly, monthly and yearly charts
show which throws get used most, and a derived "most thrown" ranking replaces
guessing at favorites. This proposal defines the shared `yoyo_events` table
(`uuid`, `yoyo_uuid`, `type`, `occurred_on`, `note`, `data`, tombstone,
`updated_at`, `rev`), with per-row last-writer-wins and a separate
`/api/sync/events` feed.

- A throw's id is a v5 UUID derived from (yoyo, 'throw', day), so two devices
  converge on one row. The server derives it for the web, because
  `crypto.subtle` doesn't exist on plain-http LAN installs.
- Sync stores unknown types as-is, so the Apple app and the web can each add
  types first.
- The client sends its local date. Owner-only, and blocked by the existing
  write gate in read-only mode.
- Derive the rankings and never auto-set `favorite`: Most thrown, EDC (thrown on half or more of the last 30 days), Collecting dust (3+ throw-days in the last year, none in the last 90), Shelf queen (at most 2 throw-days in the last year, owned 90+ days; never overlaps Collecting dust).
- Rankings use 30/90/365-day snapshots. Long-term analytics (Most thrown and a Long-term trends card) reach back 2, 3, 5, and 10 years and all time, via server aggregates (`/api/events/summary?from=`, `/api/events/histogram`).
- Past-day logging, bulk "Used today", streaks, a throw calendar (reusing Arrivals' `cal-grid`), and a Yoyo of the day that favors neglected yoyos.
- Builds on #15's `localDay()`/`parseDay()`/`daysFromToday()` and adds `relativeDay()`. Restore keeps events when a backup has no events table (#19's rule).

Full proposal: [proposals/throw-log.md](proposals/throw-log.md).

### 7. More Insights charts from existing columns
Spend by month and year (`purchase_date`, `paid`), profit or loss on sold yoyos
(`sale_price`/`trade_value` vs `paid`), average days listed (`sale_listed_at` →
`sold_date`), and brand/composition breakdowns.

### 8. Side-by-side spec compare
Pick 2–3 yoyos and compare weight, diameter, width, gap, shape, bearing and
response in columns.
