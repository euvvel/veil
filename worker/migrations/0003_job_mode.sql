-- How a finished file reaches the member: 'chat' (courier upload, ≤ upload limit) or 'direct' (D8: streamed untouched to the mini app).
ALTER TABLE jobs ADD COLUMN mode TEXT NOT NULL DEFAULT 'chat';
