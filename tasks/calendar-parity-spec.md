# TMG calendar / Google parity spec (2026-06-30)

Source: live screenshots of Google's event editor + a mapping of the Google
Calendar API (Events resource, recurrence guide, sync guide, reminders) laid
against TMG's current code. This is the build bible for "TMG as your one calendar".

## The one reframe
Google is the reminder/notification engine. A PWA cannot fire reliable cross-device
push at a precise minute, so TMG does not try to. TMG writes the `reminders` block
onto the synced Google event and Google fires it everywhere. Two-way sync IS the
notification mechanism, not a nice-to-have.

## Google's event model (baseline to match)
- Identity: `id` (per-calendar handle), `iCalUID` (cross-calendar dedup), and for
  recurrence `recurringEventId` + `originalStartTime` (instance -> master pointer).
- Time: `start`/`end` are each EITHER `{date}` (all-day) OR `{dateTime[,timeZone]}`
  (timed), never mixed. `end` is EXCLUSIVE (a 1-day all-day event ends next day).
- Recurrence lives only on the master as `recurrence[]` of RFC5545 lines
  (RRULE/RDATE/EXDATE). Instances carry no recurrence.
- Free/busy = `transparency` (opaque=busy / transparent=free), separate from
  `status` (confirmed/tentative/cancelled; cancelled = tombstone).
- Reminders = `reminders.useDefault` (inherit calendar default) OR up to 5
  `overrides[{method: popup|email, minutes}]`.
- Concurrency = `etag` + `If-Match`. App foreign keys go in `extendedProperties.private`.
- Only `start` + `end` required to create; everything else defaulted.

Editor field set (from the live screenshots): title; start/end date+time + timezone;
all-day toggle; recurrence (Does not repeat / Daily / Weekly on <day> / Monthly /
Annually / Every weekday / Custom); location; notifications (method + minutes,
multiple); calendar; colour; Busy/Free; visibility; rich-text description; guests.
Out of scope for a solo musician diary: guests/permissions, Google Meet, attachments.

## Recommended `personal_events` table
```
id                  uuid     PK (TMG local id)
user_id             fk       tenant scope
google_event_id     text     Google id; null until first push; unique per (user, calendar)
ical_uid            text     cross-calendar dedup key
calendar_id         text     default 'primary'
etag                text     last-seen Google etag (sent via If-Match)
summary             text     title ('(No title)' fallback)
description         text
location            text
all_day             boolean  default false; drives date vs dateTime on both ends
start_at            timestamptz  timed start (UTC)
end_at              timestamptz  timed end, EXCLUSIVE (UTC)
start_date          date     all-day start
end_date            date     all-day end, stored as LAST day; +1 only at push
timezone            text     IANA (Europe/London); REQUIRED for recurring
rrule               text     real RFC5545 RRULE; null if single
recurring_event_id  text     Google master id for an instance row
original_start      timestamptz  instance's immutable pattern slot
is_recurring_master boolean  true if this row carries the rrule
status              text     confirmed | tentative | cancelled (cancelled = soft-deleted)
transparency        text     opaque (busy) | transparent (free); default opaque
visibility          text     default | public | private; default 'default'
color_id            text     Google palette id; null = calendar default
reminders           jsonb    {useDefault: bool, overrides: [{method, minutes}]} (max 5)
source              text     'tmg' | 'google' (loop-prevention provenance)
last_pushed_etag    text     etag TMG itself last wrote (de-dupe own echo on pull)
created_at          timestamptz
updated_at          timestamptz
deleted_at          timestamptz
```

## Two-way sync plan (extend, don't replace)
### Pull (extend `pullFromGoogle`)
1. Call `events.list` with FIXED `singleEvents=true`, `showDeleted=true`, fixed
   `calendarId`, saved `syncToken`. These params MUST stay identical across every
   incremental call or you get a 400. `singleEvents=true` makes Google expand
   recurring series into instance rows (simpler local model). No timeMin/timeMax/
   orderBy/q alongside a syncToken (mutually exclusive).
2. Upsert ALL events, not just gig-linked: match by google_event_id -> gig (existing
   path), personal_event (update), or nothing (INSERT new personal_event,
   source='google'). `status=cancelled` -> soft-delete the local row. Key instance
   rows off `recurring_event_id` + `original_start` (immutable), not start.
3. Loop prevention: if returned etag == row.last_pushed_etag, skip (own echo).
4. Page with `pageToken` until `nextSyncToken` appears; persist token only then.
5. 410 GONE: discard token, wipe Google-sourced rows for that calendar, full resync.

### Push (add `pushPersonalEventToGoogle`, mirror `pushGigToGoogle`)
- Create: `events.insert`. timed -> start.dateTime+timeZone; all-day -> start.date /
  end.date with end = stored last day +1. recurrence:[rrule]+start.timeZone for
  recurring. Set reminders/transparency/colorId/visibility. Stash tmg id in
  extendedProperties.private. Store returned google_event_id, etag, ical_uid, set
  last_pushed_etag.
- Update: `events.patch` (changed fields only) with If-Match: etag. On 412 re-fetch,
  Google wins (last-writer-wins v1), log conflict, retry. Refresh etag.
- Delete: `events.delete`; single occurrence -> patch instance status=cancelled.
- Recurrence edit scope: "this" = patch the instance (exception); "all" = patch the
  master; "this and following" = patch master RRULE UNTIL (in UTC) then insert a new
  series. Never edit instances one by one to change the whole series.
- Trigger: keep current polling for v1. Follow-up: `events.watch` push channel.

## Easy-add UX (match Google's two tiers)
- Quick-create popup: Title (createable with TITLE ALONE, everything else defaulted),
  date + start/end (default 1h), all-day toggle, Save + "More options".
- Full editor field order: type tabs (Gig | Personal) -> Title -> date/time + all-day
  + timezone + Repeat (presets) -> Location -> Notification -> Busy/Free -> Visibility
  -> Description -> Colour.
- Defer: NL time parsing, guests, Meet, attachments, custom recurrence editor,
  multi-override reminders, per-calendar picker UI (store the column now).

## Biggest risks
1. Recurrence: the fake `recurring:Mon,Tue;until=` string is not RRULE. Store real
   RRULE, always send timeZone, use singleEvents=true so Google owns expansion, limit
   v1 to the preset set.
2. Sync drift/loops: de-dupe by google_event_id + last_pushed_etag; never change the
   structural param set between full and incremental; page to nextSyncToken.
3. Timezone: store IANA, carry on every timed/recurring push, never bake a numeric
   offset; all-day ignores timezone.
4. Deletions arrive as status=cancelled tombstones, not missing rows; handle them.
   All-day end.date is exclusive: convert at the push seam, store last-day internally.
5. Reminders cannot be PWA-native: write reminders onto the Google event; default
   useDefault=true (useDefault=false with no overrides = zero reminders).
6. 410 GONE is not retryable: catch, wipe Google-sourced rows, full resync.

## Build order
schema + push/pull extension (v1 core) -> quick-add popup + proper calendar display
-> preset recurrence -> reminders pass-through -> follow-ups (watch channel, custom
recurrence, colour, per-calendar UI, NL parse).
