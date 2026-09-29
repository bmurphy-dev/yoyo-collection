# Feature backlog

Personal notes, kept only on `combined/all-prs` and never sent upstream.

## What upstream will accept

- **No media-shape schema changes for now.** stammig is redesigning how photos
  and media are modeled so it works across the web app and the native Apple app
  ([PR #7 comment](https://github.com/stammig/yoyo-collection/pull/7#issuecomment-5554244147)).
- **Additive tables are fine.** PR #8 landed a brand-new `videos` table.
- **The Apple app is a first-class sync client** (`/api/sync/*`). Anything new
  has to be safe for a client that doesn't know about it yet.
- Open an issue first for anything touching the schema or sync.

## Sync facts that shape designs

- `/api/sync/push` is **last-writer-wins per whole yoyo record**, decided by
  `updated_at`. A counter column on `yoyos` loses increments when two devices
  write, and each write can clobber unrelated edits to the same record.
- Child lists such as photos and videos are **replaced wholesale** on push. Rows
  missing from the pushed list are deleted (`applyVideoList`,
  `applyPhotoManifest`), so a device that hasn't pulled can erase rows added
  elsewhere. Event logs can't use this pattern.
- `favorite` is a manual, synced flag. Don't write to it automatically.

## Ideas

| # | Idea | Schema | Status |
|---|---|---|---|
| 1 | In-app 360 creation from a dropped video | media | **Done here only.** Blocked upstream by the media redesign (PR #7) |
| 2 | Wishlist restock/price watcher | product URL can live in `custom`; price history needs a table | idea |
| 3 | Photo import alongside CSV | media | blocked (media) |
| 4 | Maintenance & provenance log | shared `yoyo_events` table (types only) | posted as [#13](https://github.com/stammig/yoyo-collection/issues/13); draft: [proposals/maintenance-log.md](proposals/maintenance-log.md), plan: [proposals/maintenance-log-plan.md](proposals/maintenance-log-plan.md) |
| 5 | Collection value over time | additive snapshots table | idea |
| 6 | Throw log ("used today") | defines shared `yoyo_events` table + sync endpoints | **next**: branch `feat/throw-log`; posted as [#12](https://github.com/stammig/yoyo-collection/issues/12); draft: [proposals/throw-log.md](proposals/throw-log.md), plan: [proposals/throw-log-plan.md](proposals/throw-log-plan.md) |
| 7 | More Insights charts from existing columns | none | idea; easiest PR to get accepted |
| 8 | Side-by-side spec compare (2–3 yoyos) | none | idea |
| 9 | One date convention (local days, UTC instants) + date bug fixes | none | posted as [#14](https://github.com/stammig/yoyo-collection/issues/14); draft: [proposals/dates.md](proposals/dates.md). Suggested first of the three |

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
Dated per-yoyo events (clean, bearing, pads, string, mod, repair, history, note)
shown as a timeline on the detail view. It only adds types to #6's
`yoyo_events` table. Acquisition and sale entries come from the existing yoyo
fields, and events never rewrite specs. Sharing the table is what makes
"throw-days since last clean" and a "Due for a clean" list possible. Full
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
- Derive "most thrown" and never auto-set `favorite`.

Full proposal: [proposals/throw-log.md](proposals/throw-log.md).

### 7. More Insights charts from existing columns
Spend by month and year (`purchase_date`, `paid`), profit or loss on sold yoyos
(`sale_price`/`trade_value` vs `paid`), average days listed (`sale_listed_at` →
`sold_date`), and brand/composition breakdowns.

### 8. Side-by-side spec compare
Pick 2–3 yoyos and compare weight, diameter, width, gap, shape, bearing and
response in columns.
