## The problem

A collection answers "what do I own?" but not "what do I actually throw?" Past a couple dozen yoyos, the ones in real rotation and the ones that haven't left the shelf in months blur together. The `favorite` star captures intent, not use. I'd like a one-tap **"used today"** on each yoyo, plus Insights charts of which throws get used most by week, month, and year, and a derived "most thrown", "everyday carry (edc)", "collecting dust", and "shelf queen" insights rankings.

This is one of two related proposals. The other is a maintenance and provenance log (#13). Both are dated events on a yoyo, so I'm proposing a single `yoyo_events` table with a `type` column that both use. This issue defines that table. Whichever PR lands first creates it, and the other only adds types and UI.

I'm raising this before writing code because it adds a table and a sync surface, and the Apple app is a first-class sync client. I'd rather agree on the shape with you first.

## What it deliberately doesn't touch

- **Media.** No change to photos or videos, so nothing inside the media redesign you described on #7.
- **The `yoyos` table.** No new columns, and no change to the existing `/api/sync/changes` or `/api/sync/push` payloads.
- **`favorite`.** It stays a manual flag. "Most thrown" is computed from the log and never written back, so there are no automatic writes fighting a user's choice or bumping `rev`.

## Why not a counter column, or a child list like videos

I considered `use_count` on `yoyos` and ruled it out. Push is last-writer-wins per record on `updated_at`, so two devices each logging a throw would lose one increment. Each tap would also count as a full-record edit that could win over a real edit made on the other device.

A child list synced the way videos are doesn't work either. `applyVideoList` deletes rows missing from the pushed list, so a device that hasn't pulled would erase events logged elsewhere. Events need to merge as a union of rows, each with its own conflict resolution.

## Proposed shape: `yoyo_events`

```sql
CREATE TABLE IF NOT EXISTS yoyo_events (
  uuid        TEXT PRIMARY KEY,           -- random v4, or derived v5 for once-per-day types (below)
  yoyo_uuid   TEXT NOT NULL,              -- yoyos.uuid, not id: ids are server-local
  type        TEXT NOT NULL,              -- 'throw' here; maintenance types in #13
  occurred_on TEXT NOT NULL,              -- 'YYYY-MM-DD' in the user's local time
  note        TEXT NOT NULL DEFAULT '',
  data        TEXT NOT NULL DEFAULT '{}', -- small type-specific JSON, e.g. {"string": "..."}; '{}' for throws
  deleted_at  TEXT,                       -- tombstone, so an undo or delete propagates
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  rev         INTEGER NOT NULL DEFAULT 0  -- stamped from the shared settings.sync_rev
);
CREATE INDEX IF NOT EXISTS idx_events_yoyo ON yoyo_events(yoyo_uuid, type, occurred_on);
CREATE INDEX IF NOT EXISTS idx_events_rev  ON yoyo_events(rev);
CREATE INDEX IF NOT EXISTS idx_events_day  ON yoyo_events(type, occurred_on); -- collection-wide date ranges for multi-year analytics
```

- **Merge rule:** each row is last-writer-wins on `updated_at`. That reuses the timestamp validation and future-clock clamping push already has. Rows are never deleted by omission, only tombstoned.
- **Once per day for throws:** a throw's `uuid` is a v5 UUID derived from `(yoyo_uuid, 'throw', occurred_on)`. Two devices logging the same yoyo on the same day produce the same id and converge on one row, and toggling off and on again just flips `deleted_at`. The server derives it for the web UI, because `crypto.subtle` only exists in secure contexts and plenty of instances run on plain `http://` on a LAN. The Apple app can derive it natively. Maintenance events use random v4 ids, since several can happen on the same day.
- **Unknown types survive:** sync accepts any `type` matching `^[a-z][a-z0-9_]{0,31}$`, stores it, and the web shows unrecognized types generically. This is the same stance `sanitizeSyncCustom` takes (the app may carry things the web doesn't know yet), so neither client has to ship first.
- **Local date from the client:** the server clock would file a 10pm throw under tomorrow for anyone west of UTC.
- **Deleted yoyos:** events stay (they're history) but are excluded from stats, the same way `WHERE deleted_at IS NULL` works today.
- **Access:** owner-only, reads included. POSTs already fall under the write gate, so read-only mode and demo mode block logging with no exemption needed. That's correct for mirrors, since the next publish replaces their database.
- **Backup/restore:** backups need no change, because the zip carries the whole database file. Restore does need a change: `restoreFromZip` copies tables row by row, and events have no foreign key to cascade through. *(Corrected; see the implementation plan in the comments.)*

**Endpoints (all new, type-agnostic):**

- `GET /api/yoyos/:id/events?type=` lists a yoyo's events.
- `POST /api/yoyos/:id/events` creates an event. For `type: "throw"` it toggles today instead.
- `PUT /api/events/:uuid` edits an event and `DELETE /api/events/:uuid` tombstones it (used by the maintenance log).
- `GET /api/sync/events?since=&limit=` is a change feed with the same cursor semantics as `/api/sync/changes`.
- `POST /api/sync/events` pushes rows, batch-capped like `/api/sync/push`.
- `GET /api/events?type=&from=` is an owner-only compact read across the collection. Insights aggregates it client-side, the way `renderInsights()` already works. *(Corrected: this originally proposed adding aggregates to `/api/stats`, which the web UI doesn't use.)*
- `GET /api/events/summary` and `GET /api/events/histogram` are owner-only server-side aggregates for spans longer than a year, where shipping raw rows would grow without bound.

A client that never calls the new sync endpoints is unaffected. It just doesn't see or send events.

## This PR's scope

The table, the endpoints above, and the `throw` type.

**Logging:**
- A "used today" toggle on the detail view and card menu.
- **Past days:** people forget, so tapping a day in the detail view's sparkline or calendar toggles *that* day. It's the same endpoint with a chosen `occurred_on`, and the derived id makes it safe to repeat.
- **Several at once:** after a session with four throws, the Collection view's existing select mode gets a "Used today" bulk action. That's one toggle per selected yoyo.

**Rankings,** all derived from the log and never stored. They're owner-only and cover in-hand yoyos only:

| ranking | rule |
|---|---|
| **Most thrown** | most throw-days in the chosen period: week, month, or year, plus the long-term spans below |
| **Everyday carry (EDC)** | thrown on at least half of the last 30 days, so it's the consistent pick rather than one binge weekend |
| **Collecting dust** | a real thrower that's gone quiet: thrown on 3+ days in the last year, but none in the last 90 |
| **Shelf queen** | thrown on at most 2 days in the last year (never counts), and owned for 90+ days (by `purchase_date`, falling back to `created_at`), so new arrivals aren't labeled. Taking it off the shelf once or twice doesn't cost the title. For collectors this is a badge of honor, not a nag. |

Collecting dust and Shelf queen split on that 2-day line, so a yoyo is never both. The thresholds are constants in `app.js`, easy to tune or turn into settings later.

**Snapshots for the rankings, long spans for the analytics.** The rankings deliberately use short, current windows (30 days, 90 days, 1 year) so they describe how the collection is used *now*. The long-term analytics go further back: **2, 3, 5, and 10 years, and all time**. A throw log becomes more valuable the longer it runs, and "my most thrown over five years" is a different, more interesting answer than "this month." Spans longer than the log's history are hidden, so someone who started logging eight months ago isn't offered a 5-year view.

**Insights and detail view:**
- A "Most thrown" card with a Week / Month / Year / 2y / 3y / 5y / 10y / All switch, reusing the existing `barChart` helper.
- A **Long-term trends** card: throw-days per year (or per month within a chosen span) across the collection, so you can see a year where the hobby took off or went quiet. On the detail view, a per-yoyo "year by year" line.
- EDC, Collecting dust, and Shelf queen lists.
- "Most thrown" and the current **streak** ("5 days in a row") join the standouts row next to Most valuable and Heaviest.
- A **throw calendar** that reuses the Arrivals calendar's month grid, with throw days marked.
- A small per-yoyo sparkline on the detail view.
- For the owner, **Yoyo of the day** favors Collecting dust and Shelf queen picks, turning the analytics into a reason to throw something neglected. Public viewers keep today's rotation.

No new dependencies. Everything after the toggle is derived, so any of it can be split into a follow-up PR if you'd rather review a smaller first step.

## Questions for you

1. **Does one generic table sit right with you,** or would you rather have narrow per-feature tables (`throws`, `maintenance`) with duplicated sync code?
2. **Separate feed or folded into the existing one?** A separate `/api/sync/events` keeps the existing payloads untouched, but it means a second cursor for the Apple app to track. Would you rather have `events` as an extra array on `/api/sync/changes`?
3. **Daily toggle or a count?** I've proposed "used today" as on/off per day, which is what makes the derived id work. Is a per-day session count worth the extra complexity?
4. Is there anything about how the Apple app syncs, or will sync, that should change this shape?

Happy to build it on whatever shape you land on, or to hold off if it's better timed after the media work.

---

**Edit 3:** long-term analytics reach back 2, 3, 5, and 10 years and all time (Most thrown periods, a Long-term trends card, and the calendar navigating past a year), backed by server-side aggregates. The rankings keep their 30-day, 90-day, and 1-year snapshots.

**Edit 2:** Shelf queen now allows up to 2 throw-days a year, and Collecting dust starts at 3+, so the two never overlap.

**Edit:** added past-day logging, the multi-select "Used today," definitions for the EDC, Collecting dust, and Shelf queen rankings, streaks, the throw calendar, and a Yoyo of the day that favors neglected yoyos.

**Related:** #14 proposes the date convention this relies on (`occurred_on` as a local calendar day, via a shared `localDay()` helper) and fixes existing date bugs. Its table shows how #14, this issue, and #13 fit together as three PRs.

