## Implementation plan (assuming the shared `yoyo_events` table)

This assumes #12's table lands first, or in the same release. [Its plan](https://github.com/stammig/yoyo-collection/issues/12#issuecomment-5896362756) covers the schema, `events.js`, the sync routes, and the restore fix. **If this PR lands first**, it carries those pieces unchanged except for the throw toggle, and #12 shrinks to the throw type and its UI.

One correction carried over from #12: the proposal said backup/restore needed nothing. It does, because restore copies tables row by row and events have no foreign key to cascade through. The fix lives in #12's step 3.

### 1. Server: `server.js` and `events.js`

This PR adds no schema change and no new sync code. The types are just values in `yoyo_events.type`.

- **`POST /api/yoyos/:id/events`** with a non-throw type inserts a row with `crypto.randomUUID()`, the validated `occurred_on`, a `note` capped at 1,000 characters, and `data` run through `sanitizeEventData`. It stamps `updated_at` and `rev` in a transaction, returns the row, and doesn't call `touchYoyo()`, for the same reason as #12.
- **`PUT /api/events/:uuid`** edits `occurred_on`, `note`, `data`, and `type`. Changing a row to or from `throw` is rejected, because throw ids are derived from the date, so a throw can't be retyped or redated in place.
- **`DELETE /api/events/:uuid`** tombstones the row (`deleted_at`, `updated_at`, `rev`) rather than removing it, so the delete syncs.
- **Validation stays generic:** the server checks the type pattern and the shape of `data`, not a per-type field list. Types the Apple app adds later are stored as-is and shown generically on the web.
- **`GET /api/events`** already takes a comma list of types from #12. The "due for a clean" card uses `type=throw,clean`.
- **The reminder threshold setting:** add `clean_after_throw_days` to `PUBLIC_SETTINGS`, since `PUT /api/settings/:key` only accepts keys on that list. It uses the existing key/value table, with an empty value meaning off and 30 as the suggested default. `GET /api/settings` would expose the number publicly, which is harmless.

### 2. `public/app.js`

- **`EVENT_TYPES` metadata:** one client-side map per type holding its label, an existing `SVG` icon, and its optional fields. For example, `bearing` has fields `bearing` and `size`, and `string` has field `string`. Unknown types fall back to "Other · <type>".
- **The timeline:** add a `timelineHTML(y, events)` section to `detailHTML`, after the videos section. It loads lazily from `openDetail()` via `GET /api/yoyos/:id/events`, and only for owners. It merges three sources, newest first:
  - maintenance and history events, each with an icon, label, date, the `data` values, and the note
  - "Bought from <seller>" and "Sold to <buyer>" entries rendered from `purchase_date`/`seller` and `sold_date`/`buyer`, never stored as events
  - throws collapsed to one line per month ("Thrown 9 days in March"), so a heavily used yoyo's timeline stays readable
- **Log maintenance:** a `hero-act` button (only when `canEditState`) opens a small form with a type picker, a date defaulting to `localDay()`, fields that change with the chosen type, and a note. Each timeline row gets an edit/delete menu that reuses the same form.
- **Specs stay untouched:** saving a `bearing` or `pads` event doesn't write `bearing_size` or `response_type`. If you want the optional "also update the spec" checkbox (question 3), it sends a separate, ordinary `patchYoyo()`, so it's an explicit edit the user made.
- **Since last clean, which needs both features:** the detail hero shows "14 throw-days since last clean", counted as throw days after the latest `clean`. It only appears when both exist.
- **Due for a clean:** an Insights `insightCard` listing in-hand yoyos past the threshold, fed by the same `GET /api/events?type=throw,clean` read. It's hidden when the setting is empty or there are no cleans.
- **Settings:** a number input for the threshold, next to the existing settings.

### 3. `public/styles.css`

Timeline rows (icon rail, date, body), the log form, and the collapsed throw summary line, all reusing existing tokens.

### 4. Docs and demo

- `README.md`: add `PUT/DELETE /api/events/:uuid` and the non-throw use of `POST /api/yoyos/:id/events` under **REST API**.
- `CHANGELOG.md`: an entry.
- `seed-demo.mjs`: add a few cleans, a pad swap, and a `history` note on the seeded yoyos, so the demo shows a real timeline.

### 5. Not in this PR

- **Public service history on For Sale listings** (question 2). Everything stays owner-only until you weigh in. If it's wanted, a follow-up could add a per-yoyo opt-in and render the timeline on the public listing, minus the notes.
- **CSV export of events.** The yoyo CSV stays one row per yoyo.

### 6. Testing (manual checklist for the PR description)

- Log, edit, and delete each type. A delete leaves a tombstone that shows up in `/api/sync/events`.
- Log two maintenance events on the same day and get two rows. Retyping a row to `throw` is rejected.
- Pull a `type` the web doesn't know through sync, and check it renders as "Other".
- The timeline shows the seller/buyer entries from the yoyo fields, and editing `seller` changes them without touching any events.
- With some throws and a clean logged, the "throw-days since last clean" count is correct. With the threshold set, the Insights card lists the right yoyos, and clearing the setting hides it.
- Read-only mode, demo mode, and public viewers get the same results as the throw log.
- A backup round-trip keeps every event.
