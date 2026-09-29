## The problem

Yoyos need upkeep: bearings get cleaned and lubed or swapped, response pads wear out, strings get changed, and some get modded or repaired. Today the only place to record any of that is the free-text `description`, which has no dates and no structure, and gets overwritten as it's edited.

It matters beyond upkeep, too. Collectors buy and trade on condition, and "bearing swapped to a KonKave in 2025, pads replaced last spring" is exactly what a buyer asks about. `purchase_date`/`seller` and `sold_date`/`buyer` capture the two ends of your ownership, but nothing records what happened in between.

Competition is the other thing that happens in between. "I competed with this at Worlds and placed 3rd in 1A" is the most meaningful day in a yoyo's life for the player, and a big part of its story for the next owner, but it has nowhere to go today either.

I'd like a dated **maintenance, contest, and provenance log** per yoyo, shown as a timeline on the detail view.

## Built on the shared events table

This is the companion to #12, which proposes a `yoyo_events` table with a `type` column, its own sync feed, and per-row last-writer-wins. The full schema and sync reasoning are there. This proposal adds maintenance **types** and a timeline UI, with no further schema change. If this PR landed first, it would create the table itself.

Like the throw log, it leaves media, the `yoyos` table, and the existing sync payloads untouched.

## Proposed types

Stored as `yoyo_events.type`, with optional structured details in `data` and free text in `note`:

| type | meaning | `data` (all optional) |
|---|---|---|
| `clean` | bearing cleaned (and relubed) | `{ "lube": "..." }` |
| `bearing` | bearing replaced | `{ "bearing": "KonKave", "size": "C" }` |
| `pads` | response pads replaced | `{ "response": "..." }` |
| `string` | string changed | `{ "string": "..." }` |
| `mod` | modification (silicone recess, re-anodize, axle swap) | none; described in `note` |
| `repair` | fixed damage | none |
| `contest` | you competed with it | `{ "contest": "2026 World Yo-Yo Contest", "division": "1A", "round": "Finals", "placement": 3 }` |
| `history` | provenance from before you owned it ("ran by X at 2019 Worlds") | `{ "from": "..." }` |
| `note` | anything else worth dating | none |

These use random v4 ids, since several can happen on the same day. Because sync stores unknown types as-is, the Apple app or a later PR can add a type without a server change first.

**A contest is more than "thrown today," and it also counts as a throw.** It gets its own type rather than a flag in the day's throw row. Throw rows are a per-day on/off with a derived id, so a mistaken un-tick of "used today" would destroy the contest details with it, and a derived id allows only one row per day, which rules out entering 1A and 3A at the same event. Logging a contest also creates that day's throw. That's idempotent, because the throw's id is derived, so Most thrown, Gathering dust, and "throw-days since last clean" count competition days without special cases. Deleting the contest later leaves the throw, which is still true. `contest` is distinct from `history`: `contest` is *you* competing, and `history` is what happened before you owned it.

**One source of truth for acquisition and sale.** The timeline shows `purchase_date`/`seller` and `sold_date`/`buyer` as entries rendered from the existing yoyo fields, not as duplicate events. There's no second copy to drift out of sync.

**Events don't rewrite specs.** Logging a `bearing` swap doesn't silently change `bearing_size`. Automatic writes to the yoyo record would bump `updated_at` and could beat a real edit from another device in last-writer-wins. If it's wanted, an explicit "also update the spec" checkbox would make a normal yoyo edit the user chose.

## Why share one table with the throw log

- **The combination is the most useful part.** "14 throw-days since last clean" on the detail view, and a **Due for a clean** list in Insights, are a single query when throws and cleanings live in the same table. The threshold can live in the existing `settings` key/value table, with no schema change. Separate tables would make that a cross-table join and two sync feeds.
- **Contests belong to both halves.** A contest is a usage event (#12's counts) and a provenance event (this timeline) at once. In one table it's one `contest` row plus the day's derived throw, and every view counts it correctly. Split tables would force a choice of which table owns contests, or a duplicate in each.
- **One timeline.** The detail view can show maintenance, contests, and usage together, with throws collapsed to a monthly summary ("thrown 9 days in March") so they don't drown out the rest.
- **One sync mechanism for the Apple app.** One feed, one push, one merge rule, instead of a new pair of endpoints per feature.
- **Smaller PRs.** After the first one lands, each later feature adds types and UI only.

## This PR's scope

The types above, and on the detail view:

- a **timeline** of events and the acquisition/sale entries
- a **Log event** quick-add (type picker, date defaulting to today, note, and the type's optional fields), with contest names autocompleting from earlier entries so several yoyos group under the same contest without a separate contests table
- a highlighted contest entry in the timeline ("3rd · 1A Finals · 2026 World Yo-Yo Contest")
- edit and delete through `PUT`/`DELETE /api/events/:uuid`

In Insights, a **Competition record** card listing contests, placements, and the yoyo used each time. If the throw log has landed, add "throw-days since last clean" and the Insights "Due for a clean" list. Owner-only, like the rest of the events table. No new dependencies.

## Questions for you

1. **Is the starting type list right?** Anything to add, merge, or rename?
2. **Public service and contest history?** Everything is owner-only as proposed. Would you want an opt-in "show history" on a yoyo's public For Sale listing, covering service and contests? Of everything here, that's the part most useful to a buyer.
3. **The "also update the spec" checkbox:** worth having, or should events and specs stay fully separate?
4. **Order:** does it matter to you which of the two PRs lands first?

---

**Edit:** added the `contest` type, and the reasoning for why a contest is its own type that also counts as a throw.

**Related:** #14 proposes the date convention both event proposals rely on. It also normalizes `purchase_date`/`sold_date`, which this timeline's "Bought from…" and "Sold to…" entries need in order to sort correctly. Its table shows how #14, #12, and this issue fit together as three PRs.
