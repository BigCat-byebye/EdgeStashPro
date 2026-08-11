-- One authoritative reading position per account and TXT book.
-- Device-local caches never create independent progress records.
CREATE TABLE IF NOT EXISTS reader_progress (
  owner_key TEXT NOT NULL,
  path TEXT NOT NULL,
  source_etag TEXT,
  char_offset INTEGER NOT NULL DEFAULT 0,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  anchor_char_offset INTEGER NOT NULL DEFAULT 0,
  anchor_byte_offset INTEGER NOT NULL DEFAULT 0,
  anchor_ratio REAL NOT NULL DEFAULT 0,
  progress REAL NOT NULL DEFAULT 0,
  scroll_top REAL NOT NULL DEFAULT 0,
  scroll_height REAL NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_key, path)
);

CREATE INDEX IF NOT EXISTS idx_reader_progress_owner_updated
  ON reader_progress(owner_key, updated_at DESC);
