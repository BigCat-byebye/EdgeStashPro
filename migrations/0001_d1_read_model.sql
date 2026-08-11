-- D1 becomes the authoritative metadata/read model; R2 remains the byte store.
-- The base CREATE keeps this migration usable for both existing and fresh D1
-- databases. Runtime bootstrap still creates the rest of EdgeStashPro's tables.
CREATE TABLE IF NOT EXISTS search_items (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  item_type TEXT NOT NULL,
  parent_path TEXT NOT NULL,
  size INTEGER DEFAULT 0,
  size_formatted TEXT,
  preview_type TEXT,
  last_modified TEXT,
  indexed_at INTEGER NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]'
);

ALTER TABLE search_items ADD COLUMN resource_key TEXT;
ALTER TABLE search_items ADD COLUMN resource_version TEXT;
ALTER TABLE search_items ADD COLUMN resource_etag TEXT;
ALTER TABLE search_items ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE search_items ADD COLUMN updated_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_search_items_parent_sort
  ON search_items(parent_path, item_type DESC, name COLLATE NOCASE, path COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS app_stats (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

UPDATE search_items
SET resource_key = CASE
  WHEN item_type = 'folder' THEN LTRIM(path, '/') || '/'
  ELSE LTRIM(path, '/')
END,
sync_status = 'ready',
updated_at = COALESCE(updated_at, indexed_at);
