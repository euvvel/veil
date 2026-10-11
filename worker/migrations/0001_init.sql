-- veil schema v1. Text only. No Telegram ids at rest except jobs.chat_id while a job is in flight.

CREATE TABLE members (
  member_key  TEXT PRIMARY KEY,               -- HMAC(MEMBER_HMAC_KEY, telegram id), hex
  role        TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  alias       TEXT,
  prefs       TEXT NOT NULL DEFAULT '{"format":"flac","max_mb":150,"fallback":true}',
  created_at  INTEGER NOT NULL
);

CREATE TABLE invites (
  code_hash   TEXT PRIMARY KEY,               -- SHA-256 of the invite code, hex
  created_by  TEXT NOT NULL REFERENCES members(member_key),
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  used_by     TEXT
);

CREATE TABLE searches (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES members(member_key),
  query         TEXT NOT NULL,
  format_filter TEXT NOT NULL,
  result_count  INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX searches_user ON searches(user_id, created_at DESC);

CREATE TABLE tracks (
  id           TEXT PRIMARY KEY,
  artist       TEXT,
  title        TEXT,
  album        TEXT,
  year         INTEGER,
  format       TEXT,
  mb_recording TEXT,
  mb_release   TEXT
);

CREATE TABLE jobs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES members(member_key),
  search_id   TEXT REFERENCES searches(id),
  chat_id     INTEGER,                        -- cleared on delivery
  peer        TEXT,                           -- cleared on delivery
  path        TEXT,                           -- cleared on delivery
  size        INTEGER,
  format      TEXT,
  bitrate     INTEGER,
  state       TEXT NOT NULL DEFAULT 'pending',
  attempts    INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  track_id    TEXT REFERENCES tracks(id),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX jobs_state ON jobs(state);
CREATE INDEX jobs_user ON jobs(user_id, created_at DESC);

CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES members(member_key),
  type       TEXT NOT NULL,                  -- search | tap | download | skip | deliver
  ref        TEXT,
  feed       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX events_user ON events(user_id, created_at DESC);

CREATE TABLE peer_stats (
  peer_hash TEXT PRIMARY KEY,                 -- HMAC(PEER_HMAC_KEY, soulseek username), hex
  ok        INTEGER NOT NULL DEFAULT 0,
  fail      INTEGER NOT NULL DEFAULT 0,
  refused   INTEGER NOT NULL DEFAULT 0,
  avg_kbps  INTEGER,
  last_seen INTEGER
);
