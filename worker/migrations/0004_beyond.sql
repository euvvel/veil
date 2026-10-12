-- Phase 5 (Beyond). Text only; every suggestion is a MusicBrainz release group checked by a lookup.

CREATE TABLE suggestions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES members(member_key),
  feed        TEXT NOT NULL,                  -- weekly | like | same | deep | hole
  mbid        TEXT NOT NULL,                  -- release-group MBID (verified)
  artist      TEXT NOT NULL,
  artist_mbid TEXT,
  title       TEXT NOT NULL,
  year        INTEGER,
  kind        TEXT,                           -- Album | EP | Single
  cover       TEXT,                           -- release MBID for Cover Art Archive, if known
  reason      TEXT NOT NULL,
  score       REAL NOT NULL DEFAULT 0,
  rank        INTEGER NOT NULL DEFAULT 0,
  outcome     TEXT,                           -- tapped | skipped | crossed
  created_at  INTEGER NOT NULL
);
CREATE INDEX suggestions_feed ON suggestions(user_id, feed, rank);
CREATE INDEX suggestions_mbid ON suggestions(user_id, mbid);

-- Artist name → MBID, resolved once (MusicBrainz search), shared by all members.
CREATE TABLE artists (
  name_norm  TEXT PRIMARY KEY,
  mbid       TEXT,                            -- NULL when no confident match
  name       TEXT,
  checked_at INTEGER NOT NULL
);

-- Release groups confirmed by a MusicBrainz lookup.
CREATE TABLE verified (
  mbid       TEXT PRIMARY KEY,
  ok         INTEGER NOT NULL,
  title      TEXT,
  types      TEXT,                            -- MusicBrainz secondary types, e.g. "Live,Compilation"
  checked_at INTEGER NOT NULL
);

-- A search started from a suggestion, so a crossing can count in its favour.
ALTER TABLE searches ADD COLUMN suggestion_id TEXT;
