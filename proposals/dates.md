## The problem

The app stores two kinds of time, but nothing in the code says which is which, and a few places mix them up:

- **Calendar days** have no time zone: `purchase_date`, `sold_date`, `eta`, and the proposed `yoyo_events.occurred_on`. "I sold it on the 12th" means the 12th wherever you were standing.
- **Instants** are points in time, stored in UTC: `created_at`, `updated_at`, `deleted_at`, and `sale_listed_at`. Sync relies on these (last-writer-wins compares `updated_at` strings), so they're fine as they are.

Concrete bugs that come from mixing the two:

1. **Marking a yoyo Sold can record the wrong day.** The For Sale bulk "Sold" action sets `sold_date = new Date().toISOString().slice(0, 10)`, which is the UTC date, not the user's. Anyone in the Americas who marks a sale after 5–8pm local time gets tomorrow's date. Anyone in Asia or Australia who does it before mid-morning gets yesterday's.
2. **Sold view sorts dates as text.** `soldFilteredSorted()` compares `sold_date` with `localeCompare`. That works for `YYYY-MM-DD` but not for what CSV import stores, which is whatever the spreadsheet had. `6/15/2026` sorts after `2026-09-01`, and `10/1/2026` sorts before `6/15/2026`.
3. **Imported day fields are never normalized.** `/api/import` stores `purchase_date`/`sold_date` as typed. The edit form copes, because `toDateInputValue()` converts on load and the date input saves ISO. But the value only gets fixed if someone happens to open and save that yoyo, and everything else that reads the field has to cope with every format.
4. **Backup and CSV filenames use the UTC date.** `yoyo-backup-${date}.zip` and `yoyo-collection-${date}.csv` take their date from `toISOString()` on the server. The Docker image runs in UTC and no `TZ` setting is documented anywhere, so an evening backup in the US is named for tomorrow. It's minor, but it's confusing when you keep a folder of dated backups.
5. **Opening and saving the edit form can rewrite a date to the wrong year.** `parseETA()` (which `toDateInputValue()` uses to fill the form's date inputs) reads `a/b/yyyy` as month/day with no range check. An imported day/month date like `15/6/2026` becomes `new Date(2026, 14, 6)`, which JavaScript quietly rolls over to **2027-03-06**. Opening that yoyo and pressing Save writes the wrong date back.

## Proposed convention

Written down once as a comment block in `app.js`, and repeated where `server.js` handles dates:

- **Calendar days are `YYYY-MM-DD` in the user's local time.** They're produced in the browser, never derived from a UTC instant, and never converted on the server.
- **Instants stay UTC.** The two existing formats stay as they are: SQLite's `YYYY-MM-DD HH:MM:SS` for `created_at`/`updated_at`/`deleted_at`, and ISO-with-`Z` for `sale_listed_at`. Changing either would disturb sync's string comparisons for no real gain, so the convention only documents them.
- **Approximate days are still days.** Some events have only a year or a month, such as a `history` event for "ran at 2019 Worlds". Those store `occurred_on` as the first day of the period (`2019-01-01`), with `data.precision` set to `"year"` or `"month"`, and display as "2019" or "Mar 2019". They stay sortable and validated, rather than falling back to free text. `precision` only appears on events (#12/#13), and a missing value means an exact day.
- **Free-text dates stay free text.** `release_date` ("2025", "Spring 2024") is intentionally loose and is left alone.

## Implementation plan (small, no schema change)

- **`public/app.js`**
  - Add `localDay(d = new Date())`, which builds `YYYY-MM-DD` from `getFullYear/getMonth/getDate`. Add `parseDay(s)` as a clearer name for the existing `parseETA`, kept as an alias so nothing else changes. Give it a range check: when the first number is over 12, read it as day/month, and when a value doesn't fit either reading, return `null` rather than letting `Date` roll it over (bug 5).
  - Add `relativeDay(day)`, which returns "today", "yesterday", "3 days ago", or "in 2 days" using calendar-day differences between local midnights, not elapsed milliseconds. `relativeETA()` is rewritten on top of it with its wording unchanged, and #12/#13's "Last thrown…", timeline, and lent badge use it rather than each doing its own arithmetic.
  - Add `formatDay(day, precision)`, which shows "2019", "Mar 2019", or the locale's short date. The timeline uses it for approximate events.
  - Bulk Sold: `changes.sold_date = localDay()`.
  - Sold view: when sorting by `sold_date` (and the tie-break), compare `parseDay()` values rather than strings, with blanks last.
- **`server.js`**
  - `normalizeDay(s)` returns `YYYY-MM-DD` for ISO or `a/b/yyyy` input and leaves anything else as typed. `a/b/yyyy` is read as month/day, the same rule `parseETA` applies (and therefore what the edit form already saves), unless `a` is over 12, in which case it's day/month. Nothing is ever lost, it just stays unnormalized. It runs on `purchase_date` and `sold_date` in `/api/import`, `POST`/`PUT /api/yoyos`, and `/api/sync/push`. `eta` is left alone, because carriers and people write it loosely and `parseETA` already copes.
  - Backup and CSV filenames: format the date from local time components, so a `TZ` set in the environment is respected.
- **One-time cleanup:** a startup pass in `db.js` that rewrites existing `purchase_date`/`sold_date` values through the same `normalizeDay`. It's idempotent, and unparseable values stay as they are. Alternatively, a `normalize-dates.mjs` script in the style of `normalize-fields.mjs`, if you'd rather not touch data on boot. (Rewriting a row should bump `rev` and `updated_at` so synced devices pick up the clean value. That's the reason I'd lean toward the script, run deliberately.)
- **Docs:** add an optional commented `TZ: America/New_York` to `docker-compose.yml` and `.env.example`, with a sentence in the README saying it only affects backup and export filenames. Plus a `CHANGELOG.md` entry.
- **Testing:** set the browser time zone to UTC−7, mark a yoyo Sold at 10pm local, and it gets today. Import a CSV with `6/15/2026` and it's stored as `2026-06-15`. Import `Spring 2024` into `purchase_date` and it's kept as typed. A stored `15/6/2026` opens in the edit form as June 15, 2026, not March 2027. `relativeDay()` says "yesterday" for something logged at 11pm and viewed at 1am. An event with `precision: "year"` displays as "2019" and sorts before one from March 2019. Sold view sorts a mixed collection chronologically. With `TZ` set, the backup filename matches the local date.

## How this fits with #12 and #13

These are three proposals meant to be read together. Each could be a separate, reviewable PR:

| Order | Proposal | Schema | What it adds |
|---|---|---|---|
| 1 | **This issue:** date convention | none | `localDay()`/`parseDay()`, normalized day fields, and the fixes above |
| 2 | #12: throw log | adds the `yoyo_events` table + `/api/sync/events` | "used today," Most thrown, Gathering dust |
| 3 | #13: maintenance, contest & provenance log | none (types on the same table) | timeline, quick-log, contest record, "throw-days since last clean" |

The dependencies run one way. #12 and #13 both store `occurred_on` as a local calendar day, which is exactly the convention this issue writes down, and they'd use `localDay()`, `relativeDay()`, and `formatDay()` rather than each introducing its own. #13's `history` events are the first users of the approximate-date rule. #13's timeline also shows "Bought from…" and "Sold to…" entries from `purchase_date`/`sold_date`, which only sort correctly once those fields are normalized. Landing this first gives both of those PRs a settled foundation. It's also useful on its own, since bug 1 affects anyone who marks sales in the evening today.

## Questions for you

1. **Is the convention right,** and should it live anywhere besides code comments, such as `CONTRIBUTING.md`?
2. **Cleanup on boot or a script?** I lean toward the script, since rewriting rows bumps `rev` and every synced device would re-pull.
3. **Day/month collections:** reading `a/b/yyyy` as month/day matches what the edit form already does today, but it's wrong for a collection kept in `D/M/YYYY`. Is that worth a setting, or is "matches existing behavior" enough for now?

---

**Edit:** added the approximate-date rule (`data.precision` on events) and the shared `relativeDay()`/`formatDay()` helpers, which #12 and #13 both rely on.
