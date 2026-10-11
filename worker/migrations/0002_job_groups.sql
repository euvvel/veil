-- A tap creates one group: one job for a track, one job per file for an album.
ALTER TABLE jobs ADD COLUMN group_id TEXT;
ALTER TABLE jobs ADD COLUMN name TEXT;   -- display file name (text metadata)
CREATE INDEX jobs_group ON jobs(group_id);
