// Validation and id derivation for yoyo_events — pure functions, no database
// access, so the rules the web UI and the sync API share are in one place.
// (See the yoyo_events table in schema.sql for how events are stored and why
// they sync separately from their yoyo.)
import crypto from 'node:crypto';
import { isDay } from './dates.js';

// Any lowercase slug is a valid type. The server doesn't keep a list: a type
// the web UI doesn't know yet (added by a native app, or a later release) is
// stored as-is and shown generically, so neither client has to ship first.
export const EVENT_TYPE_RE = /^[a-z][a-z0-9_]{0,31}$/;

// Logging one of these through the web API also marks the yoyo as thrown that
// day: you can't compete with a yoyo, or land a trick on it, without throwing
// it. Sync pushes stay literal — a client pushes the throw row itself.
export const THROW_IMPLYING = new Set(['contest', 'milestone']);

export const NOTE_MAX = 1000;

// ---- Throw ids: the contract native apps must match ----
// A yoyo is either thrown on a given day or it isn't, so a throw's uuid is
// DERIVED from (yoyo, day) instead of being random: two devices that log the
// same yoyo on the same day produce the same id and converge on one row, and
// un-ticking then re-ticking a day flips that row's deleted_at rather than
// piling up duplicates.
//
//   uuid = UUIDv5(namespace = THROW_NAMESPACE,
//                 name      = "<yoyo uuid, lowercased>:throw:<YYYY-MM-DD>")
//
// i.e. RFC 4122 version 5 (SHA-1), written lowercase. (Java/Kotlin's
// UUID.nameUUIDFromBytes is version 3 / MD5 — not this.) test/units.test.js pins a known value; changing either the
// namespace or the name format splits every client's ids from the server's.
export const THROW_NAMESPACE = '5e0a98be-08a4-4b8a-8595-11424bef33d9';

export function throwUuid(yoyoUuid, day) {
  const ns = Buffer.from(THROW_NAMESPACE.replace(/-/g, ''), 'hex');
  const h = crypto.createHash('sha1').update(ns)
    .update(`${String(yoyoUuid).toLowerCase()}:throw:${day}`).digest();
  h[6] = (h[6] & 0x0f) | 0x50; // version 5
  h[8] = (h[8] & 0x3f) | 0x80; // RFC 4122 variant
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

// occurred_on must be a real "YYYY-MM-DD" and not in the future. The day comes
// from the client's local calendar and the server only knows UTC, so "future"
// allows one day of slack: a client at UTC+14 is legitimately a day ahead.
// Returns an error message, or null when the day is fine.
export function eventDayError(day, now = new Date()) {
  if (!isDay(day)) return 'Date must be a real day in YYYY-MM-DD form.';
  const latest = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  if (day > latest) return 'Date can’t be in the future.';
  return null;
}

// `data` is small type-specific detail ({"bearing": "KonKave", "size": "C"}).
// Shape-checked only, the way sanitizeSyncCustom treats custom fields: a flat
// object of primitives, bounded in size. Which keys a type uses is the
// client's business, so unknown keys survive.
export function sanitizeEventData(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (!k || k.length > 60) continue;
    if (typeof v === 'string') { if (v.trim()) out[k] = v.trim().slice(0, 200); }
    else if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
    else continue;
    if (Object.keys(out).length >= 20) break;
  }
  return out;
}

// Approximate dates. Provenance is often known only to the month or year
// ("ran at 2019 Worlds"). Such an event sets data.precision to "month" or
// "year" and stores occurred_on as the FIRST day of that period, so it still
// sorts where it belongs. No precision means an exact day. Returns an error
// message, or null.
export function precisionError(data, day) {
  const p = data?.precision;
  if (p === undefined) return null;
  if (p !== 'year' && p !== 'month') return 'precision must be "year" or "month".';
  if (!day.endsWith(p === 'year' ? '-01-01' : '-01')) return `A ${p}-precision date must be the first day of the ${p}.`;
  return null;
}
