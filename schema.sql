-- Yoyo collection schema (mirrors the user's spreadsheet columns).
-- Applied on every boot via db.js (CREATE TABLE IF NOT EXISTS — safe to re-run).
-- Columns added after the initial release are migrated in with ALTER TABLE in
-- db.js instead of edited in here, so this file always matches a fresh install
-- while db.js documents the upgrade path for existing databases.

CREATE TABLE IF NOT EXISTS yoyos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid            TEXT,                       -- stable cross-device id for sync (unique index created in db.js)

  -- Identity
  brand           TEXT NOT NULL DEFAULT '',
  model           TEXT NOT NULL DEFAULT '',
  color           TEXT NOT NULL DEFAULT '',
  body_material   TEXT NOT NULL DEFAULT '',   -- e.g. "6061 AL, SS"
  composition     TEXT NOT NULL DEFAULT '',   -- BI / MN / TRI

  -- Status
  in_hand         INTEGER NOT NULL DEFAULT 0, -- 1 = in hand, 0 = on order / wishlist
  condition       TEXT NOT NULL DEFAULT '',   -- MiB / NMTBS / Used / Beat

  -- Pricing  (percent_off is computed from these, not stored)
  retail          REAL,
  paid            REAL,
  market_value    REAL,                       -- estimated current value (owner-only)
  purchase_date   TEXT NOT NULL DEFAULT '',   -- when you bought it (ISO date, owner-only)
  seller          TEXT NOT NULL DEFAULT '',   -- who you bought it from (owner-only)

  -- For sale / trade (shown on the public For Sale page)
  sale_status     TEXT NOT NULL DEFAULT '',   -- '' | For Sale | For Trade | For Sale or Trade | Sold
  sale_price      REAL,                       -- asking price
  trade_value     REAL,                       -- value received if sold via trade (owner-only); NULL = cash sale
  sold_date       TEXT NOT NULL DEFAULT '',   -- when it sold (ISO date, owner-only)
  buyer           TEXT NOT NULL DEFAULT '',   -- who you sold it to (owner-only)
  sale_listed_at  TEXT,                       -- server-stamped when sale_status first goes live (for "days listed"); owner-only

  -- Specs
  weight_g        REAL,
  diameter_mm     REAL,
  width_mm        REAL,
  gap_mm          REAL,
  bearing_size    TEXT NOT NULL DEFAULT '',   -- Size C / Size D
  response_type   TEXT NOT NULL DEFAULT '',

  -- Edition & appearance (collector details)
  finish          TEXT NOT NULL DEFAULT '',   -- e.g. Blasted, Polished, Pyramatte, Raw
  shape           TEXT NOT NULL DEFAULT '',   -- e.g. Organic, H-Shape, V-Shape, W-Shape
  edition         TEXT NOT NULL DEFAULT '',   -- limited run, e.g. "1 of 50"
  serial_number   TEXT NOT NULL DEFAULT '',   -- engraved serial, if any
  signature       TEXT NOT NULL DEFAULT '',   -- signature player or maker/shop collab

  -- Details / acquisition
  description     TEXT NOT NULL DEFAULT '',
  release_date    TEXT NOT NULL DEFAULT '',   -- free text: "2025", "6/15/2026", etc.
  tracking        TEXT NOT NULL DEFAULT '',
  eta             TEXT NOT NULL DEFAULT '',

  -- User-defined custom fields, stored as a JSON object { fieldKey: value }
  custom          TEXT NOT NULL DEFAULT '{}',

  -- Bookkeeping
  favorite        INTEGER NOT NULL DEFAULT 0,
  retired         INTEGER NOT NULL DEFAULT 0, -- discontinued / limited run (paid may exceed retail)
  deleted_at      TEXT,                       -- soft-delete tombstone; NULL = live. Deletes are kept as
                                              -- tombstones so sync propagates them instead of a stale
                                              -- copy resurrecting the row.
  rev             INTEGER NOT NULL DEFAULT 0, -- sync change-feed position (global counter in settings.sync_rev;
                                              -- stamped on every write, index created in db.js)
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Definitions for user-added custom fields (columns).
CREATE TABLE IF NOT EXISTS field_defs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL UNIQUE,        -- stable slug used in yoyos.custom
  label       TEXT NOT NULL,               -- human label shown in the UI
  type        TEXT NOT NULL DEFAULT 'text',-- text | number | select | boolean
  options     TEXT NOT NULL DEFAULT '[]',  -- JSON array of choices (select only)
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per media FILE, not per gallery item: a 360 spin is N rows (one per
-- frame) sharing a group_uuid, which the API collapses back into a single
-- gallery entry. Keeping it one-row-per-file means backup/restore and the sync
-- manifest -- both of which move individual files -- need no special cases.
CREATE TABLE IF NOT EXISTS photos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  yoyo_id     INTEGER NOT NULL,
  uuid        TEXT,                        -- stable cross-device id for sync (unique index created in db.js)
  filename    TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'photo', -- photo | video | spin
  group_uuid  TEXT,                        -- spin only: frames of one sequence share this
  sort_order  INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (yoyo_id) REFERENCES yoyos(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_photos_yoyo ON photos(yoyo_id);
-- The index on group_uuid lives in db.js, not here: this file runs before the
-- ALTER TABLE migrations, so on an existing database the column doesn't exist
-- yet and indexing it here would fail the boot.

-- External video embeds (YouTube / Instagram) attached to a yoyo: reviews,
-- trick videos, unboxings. These are references rather than product imagery, so
-- they live outside `photos` — they have no file, can't be a gallery cover, and
-- are shown in their own section of the detail view.
--
-- Nothing here is ever interpolated into markup raw: `provider` is a validated
-- enum and `embed_ref` a strictly-matched id, and the embed URL is rebuilt from
-- the pair against a fixed template (see buildEmbedUrl in server.js).
CREATE TABLE IF NOT EXISTS videos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  yoyo_id     INTEGER NOT NULL,
  uuid        TEXT,                        -- stable cross-device id for sync
  provider    TEXT NOT NULL,               -- youtube | instagram
  embed_ref   TEXT NOT NULL,               -- provider's own ref: a YouTube id, or Instagram's "p/<shortcode>"
  url         TEXT NOT NULL,               -- the link as pasted, for the "open on <platform>" fallback
  title       TEXT NOT NULL DEFAULT '',
  vertical    INTEGER NOT NULL DEFAULT 0,  -- 9:16 content (Shorts, Reels) — frames taller
  start_s     INTEGER NOT NULL DEFAULT 0,  -- resume point carried over from the pasted URL's t= param
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (yoyo_id) REFERENCES yoyos(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_videos_yoyo ON videos(yoyo_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_uuid ON videos(uuid);

-- Site-wide key/value settings (e.g. the For Sale shipping notes).
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- Dated events on a yoyo: the throw log ("used today") and the maintenance,
-- contest and provenance log share this one table, told apart by `type`.
--
-- Unlike photos and videos, events do NOT ride the parent yoyo through sync.
-- They have their own change feed (/api/sync/events) and merge row by row,
-- last-writer-wins on updated_at, so two devices logging on the same day keep
-- both events instead of one push replacing the other's list. Rows are never
-- removed, only tombstoned (deleted_at), so an undo propagates.
--
-- Keyed by yoyos.uuid rather than yoyos.id (ids are server-local), with no
-- foreign key: an event may arrive for a yoyo that is later deleted, and it
-- stays as history. Every read joins on a live yoyo.
CREATE TABLE IF NOT EXISTS yoyo_events (
  uuid        TEXT PRIMARY KEY,           -- random v4, or derived v5 for throws (see events.js throwUuid)
  yoyo_uuid   TEXT NOT NULL,              -- yoyos.uuid, always lowercased (yoyos.uuid itself may be either case)
  type        TEXT NOT NULL,              -- 'throw', 'clean', 'contest', ... (any ^[a-z][a-z0-9_]{0,31}$)
  occurred_on TEXT NOT NULL,              -- 'YYYY-MM-DD' in the user's local calendar
  note        TEXT NOT NULL DEFAULT '',
  data        TEXT NOT NULL DEFAULT '{}', -- small type-specific JSON, e.g. {"string": "..."}; '{}' for throws
  deleted_at  TEXT,                       -- tombstone; NULL = live
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  rev         INTEGER NOT NULL DEFAULT 0  -- change-feed position, from the shared settings.sync_rev
);
CREATE INDEX IF NOT EXISTS idx_events_yoyo ON yoyo_events(yoyo_uuid, type, occurred_on);
CREATE INDEX IF NOT EXISTS idx_events_rev  ON yoyo_events(rev);
CREATE INDEX IF NOT EXISTS idx_events_day  ON yoyo_events(type, occurred_on);
