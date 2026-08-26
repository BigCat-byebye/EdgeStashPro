import { LEGACY_DEFAULT_STORAGE_ID } from '../common.js';

const MULTI_STORAGE_MIGRATION = '007_multi_storage';
const FOLDER_OBJECT_REPAIR_MIGRATION = '008_folder_object_rows';
const TABLES = {
  search_items: `CREATE TABLE search_items (
    storage_id TEXT NOT NULL,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    item_type TEXT NOT NULL,
    parent_path TEXT NOT NULL,
    size INTEGER DEFAULT 0,
    size_formatted TEXT,
    preview_type TEXT,
    last_modified TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    indexed_at INTEGER NOT NULL,
    resource_key TEXT,
    resource_version TEXT,
    resource_etag TEXT,
    sync_status TEXT NOT NULL DEFAULT 'ready',
    updated_at INTEGER,
    last_seen_scan_id TEXT,
    PRIMARY KEY (storage_id, path)
  )`,
  favorites: `CREATE TABLE favorites (
    owner_key TEXT NOT NULL,
    storage_id TEXT NOT NULL,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    item_type TEXT NOT NULL,
    size_formatted TEXT,
    preview_type TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner_key, storage_id, path)
  )`,
  recent_items: `CREATE TABLE recent_items (
    owner_key TEXT NOT NULL,
    storage_id TEXT NOT NULL,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    item_type TEXT NOT NULL,
    size_formatted TEXT,
    preview_type TEXT,
    visited_at INTEGER NOT NULL,
    PRIMARY KEY (owner_key, storage_id, path)
  )`,
  share_links: `CREATE TABLE share_links (
    share_id TEXT PRIMARY KEY,
    storage_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    password_hash TEXT,
    expires_at INTEGER,
    view_count INTEGER NOT NULL DEFAULT 0,
    download_count INTEGER NOT NULL DEFAULT 0,
    items_initialized INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  )`,
  share_items: `CREATE TABLE share_items (
    share_id TEXT NOT NULL,
    storage_id TEXT NOT NULL,
    item_path TEXT NOT NULL,
    item_name TEXT NOT NULL,
    item_type TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    resource_key TEXT,
    resource_version TEXT,
    resource_etag TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (share_id, storage_id, item_path)
  )`,
  app_stats: `CREATE TABLE app_stats (
    storage_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (storage_id, key)
  )`,
  reader_bookmarks: `CREATE TABLE reader_bookmarks (
    id TEXT PRIMARY KEY,
    storage_id TEXT NOT NULL,
    owner_key TEXT NOT NULL,
    path TEXT NOT NULL,
    char_offset INTEGER NOT NULL DEFAULT 0,
    byte_offset INTEGER NOT NULL DEFAULT 0,
    anchor_ratio REAL,
    source_etag TEXT,
    progress REAL NOT NULL DEFAULT 0,
    snippet TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  reader_progress: `CREATE TABLE reader_progress (
    owner_key TEXT NOT NULL,
    storage_id TEXT NOT NULL,
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
    PRIMARY KEY (owner_key, storage_id, path)
  )`,
  txt_index_files: `CREATE TABLE txt_index_files (
    storage_id TEXT NOT NULL,
    path TEXT NOT NULL,
    source_etag TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    encoding TEXT NOT NULL DEFAULT 'utf-8',
    total_chars INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'building',
    scanned_bytes INTEGER NOT NULL DEFAULT 0,
    next_offset INTEGER NOT NULL DEFAULT 0,
    next_chunk_no INTEGER NOT NULL DEFAULT 0,
    next_char_offset INTEGER NOT NULL DEFAULT 0,
    tail_text TEXT NOT NULL DEFAULT '',
    error_message TEXT,
    indexed_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (storage_id, path)
  )`,
  txt_index_chunks: `CREATE TABLE txt_index_chunks (
    storage_id TEXT NOT NULL,
    path TEXT NOT NULL,
    source_etag TEXT NOT NULL,
    chunk_no INTEGER NOT NULL,
    byte_start INTEGER NOT NULL,
    byte_end INTEGER NOT NULL,
    char_start INTEGER NOT NULL,
    char_end INTEGER NOT NULL,
    content_start INTEGER NOT NULL,
    content TEXT NOT NULL,
    PRIMARY KEY (storage_id, path, chunk_no)
  )`,
  user_permissions: `CREATE TABLE user_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    storage_id TEXT NOT NULL,
    path TEXT NOT NULL,
    item_type TEXT NOT NULL,
    can_view INTEGER NOT NULL DEFAULT 0,
    can_preview INTEGER NOT NULL DEFAULT 0,
    can_download INTEGER NOT NULL DEFAULT 0,
    can_upload INTEGER NOT NULL DEFAULT 0,
    can_modify INTEGER NOT NULL DEFAULT 0,
    can_delete INTEGER NOT NULL DEFAULT 0,
    can_share INTEGER NOT NULL DEFAULT 0,
    resource_key TEXT,
    resource_version TEXT,
    resource_etag TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(email, storage_id, path, item_type)
  )`,
  file_tasks: `CREATE TABLE file_tasks (
    id TEXT PRIMARY KEY,
    storage_id TEXT NOT NULL,
    owner_key TEXT NOT NULL,
    task_type TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT NOT NULL,
    source_path TEXT,
    destination_path TEXT,
    total_bytes INTEGER NOT NULL DEFAULT 0,
    processed_bytes INTEGER NOT NULL DEFAULT 0,
    total_items INTEGER NOT NULL DEFAULT 0,
    processed_items INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    result_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
  )`,
  file_task_items: `CREATE TABLE file_task_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    storage_id TEXT NOT NULL,
    source_path TEXT NOT NULL,
    source_key TEXT NOT NULL,
    target_path TEXT NOT NULL,
    target_key TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    source_version TEXT,
    source_etag TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`
};

const STORAGE_TABLES = [
  `CREATE TABLE IF NOT EXISTS storage_connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL CHECK(provider = 's3'),
    endpoint TEXT NOT NULL,
    region TEXT NOT NULL DEFAULT 'auto',
    bucket TEXT NOT NULL,
    addressing_style TEXT NOT NULL DEFAULT 'path' CHECK(addressing_style IN ('path', 'virtual')),
    credentials_ciphertext BLOB,
    credentials_iv BLOB,
    credential_version INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    sync_interval_minutes INTEGER NOT NULL DEFAULT 1440,
    last_sync_at INTEGER,
    last_sync_status TEXT,
    last_sync_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS storage_sync_jobs (
    id TEXT PRIMARY KEY,
    storage_id TEXT NOT NULL,
    scope_prefix TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
    continuation_token TEXT,
    scan_id TEXT NOT NULL,
    objects_scanned INTEGER NOT NULL DEFAULT 0,
    requested_by TEXT NOT NULL,
    lease_token TEXT,
    lease_expires_at INTEGER,
    error_message TEXT,
    started_at INTEGER,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
  )`
];

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_search_items_storage_type ON search_items(storage_id, item_type)',
  'CREATE INDEX IF NOT EXISTS idx_search_items_storage_parent ON search_items(storage_id, parent_path)',
  'CREATE INDEX IF NOT EXISTS idx_search_items_storage_name ON search_items(storage_id, name)',
  'CREATE INDEX IF NOT EXISTS idx_search_items_storage_parent_sort ON search_items(storage_id, parent_path, item_type DESC, name COLLATE NOCASE, path COLLATE NOCASE)',
  'CREATE INDEX IF NOT EXISTS idx_favorites_owner_storage_updated ON favorites(owner_key, storage_id, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_recent_owner_storage_visited ON recent_items(owner_key, storage_id, visited_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_share_links_storage_created ON share_links(storage_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_share_links_expires ON share_links(expires_at)',
  'CREATE INDEX IF NOT EXISTS idx_share_items_share_order ON share_items(share_id, sort_order)',
  'CREATE INDEX IF NOT EXISTS idx_reader_bookmarks_owner_storage_path ON reader_bookmarks(owner_key, storage_id, path, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_reader_progress_owner_storage_updated ON reader_progress(owner_key, storage_id, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_txt_index_files_storage_status ON txt_index_files(storage_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_txt_index_chunks_storage_path ON txt_index_chunks(storage_id, path, source_etag, chunk_no)',
  'CREATE INDEX IF NOT EXISTS idx_user_permissions_email_storage_path ON user_permissions(email, storage_id, path)',
  'CREATE INDEX IF NOT EXISTS idx_user_permissions_email_updated ON user_permissions(email, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_file_tasks_owner_status ON file_tasks(owner_key, status, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_file_tasks_storage_updated ON file_tasks(storage_id, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_file_task_items_task_status ON file_task_items(task_id, status, id)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_connections_name_active ON storage_connections(lower(name)) WHERE deleted_at IS NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_connections_default_active ON storage_connections(is_default) WHERE is_default = 1 AND deleted_at IS NULL',
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_sync_jobs_active ON storage_sync_jobs(storage_id) WHERE status IN ('queued', 'running')",
  'CREATE INDEX IF NOT EXISTS idx_storage_sync_jobs_status_updated ON storage_sync_jobs(status, updated_at)'
];

const LEGACY_COPY = {
  search_items: `INSERT INTO search_items SELECT '${LEGACY_DEFAULT_STORAGE_ID}', path, name, item_type, parent_path, size, size_formatted, preview_type, last_modified, tags, indexed_at, resource_key, resource_version, resource_etag, sync_status, updated_at, NULL FROM search_items_legacy_v6`,
  favorites: `INSERT INTO favorites SELECT owner_key, '${LEGACY_DEFAULT_STORAGE_ID}', path, name, item_type, size_formatted, preview_type, created_at, updated_at FROM favorites_legacy_v6`,
  recent_items: `INSERT INTO recent_items SELECT owner_key, '${LEGACY_DEFAULT_STORAGE_ID}', path, name, item_type, size_formatted, preview_type, visited_at FROM recent_items_legacy_v6`,
  share_links: `INSERT INTO share_links SELECT share_id, '${LEGACY_DEFAULT_STORAGE_ID}', file_path, file_name, file_size, password_hash, expires_at, view_count, download_count, items_initialized, created_at, NULL FROM share_links_legacy_v6`,
  share_items: `INSERT INTO share_items SELECT share_id, '${LEGACY_DEFAULT_STORAGE_ID}', item_path, item_name, item_type, sort_order, resource_key, resource_version, resource_etag, created_at FROM share_items_legacy_v6`,
  app_stats: `INSERT INTO app_stats SELECT '${LEGACY_DEFAULT_STORAGE_ID}', key, value, updated_at FROM app_stats_legacy_v6`,
  reader_bookmarks: `INSERT INTO reader_bookmarks SELECT id, '${LEGACY_DEFAULT_STORAGE_ID}', owner_key, path, char_offset, byte_offset, anchor_ratio, source_etag, progress, snippet, created_at FROM reader_bookmarks_legacy_v6`,
  reader_progress: `INSERT INTO reader_progress SELECT owner_key, '${LEGACY_DEFAULT_STORAGE_ID}', path, source_etag, char_offset, byte_offset, anchor_char_offset, anchor_byte_offset, anchor_ratio, progress, scroll_top, scroll_height, revision, updated_at FROM reader_progress_legacy_v6`,
  txt_index_files: `INSERT INTO txt_index_files SELECT '${LEGACY_DEFAULT_STORAGE_ID}', path, source_etag, size, encoding, total_chars, status, scanned_bytes, next_offset, next_chunk_no, next_char_offset, tail_text, error_message, indexed_at, updated_at FROM txt_index_files_legacy_v6`,
  txt_index_chunks: `INSERT INTO txt_index_chunks SELECT '${LEGACY_DEFAULT_STORAGE_ID}', path, source_etag, chunk_no, byte_start, byte_end, char_start, char_end, content_start, content FROM txt_index_chunks_legacy_v6`,
  user_permissions: `INSERT INTO user_permissions SELECT id, email, '${LEGACY_DEFAULT_STORAGE_ID}', path, item_type, can_view, can_preview, can_download, can_upload, can_modify, can_delete, can_share, resource_key, resource_version, resource_etag, created_at, updated_at FROM user_permissions_legacy_v6`,
  file_tasks: `INSERT INTO file_tasks SELECT id, '${LEGACY_DEFAULT_STORAGE_ID}', owner_key, task_type, status, title, source_path, destination_path, total_bytes, processed_bytes, total_items, processed_items, error_message, result_json, created_at, updated_at, completed_at FROM file_tasks_legacy_v6`,
  file_task_items: `INSERT INTO file_task_items SELECT id, task_id, '${LEGACY_DEFAULT_STORAGE_ID}', source_path, source_key, target_path, target_key, size, source_version, source_etag, status, error_message, created_at, updated_at FROM file_task_items_legacy_v6`
};

async function tableColumns(db, table) {
  try {
    const result = await db.prepare(`PRAGMA table_info(${table})`).all();
    return result.results || [];
  } catch {
    return [];
  }
}

export async function ensureD1Schema(env) {
  if (!env.D1_DB) throw new Error('D1_DB binding 未配置');
  const db = env.D1_DB;
  await db.prepare('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)').run();
  const applied = await db.prepare('SELECT id FROM schema_migrations WHERE id = ?').bind(MULTI_STORAGE_MIGRATION).first();
  if (applied) {
    const repaired = await db.prepare('SELECT id FROM schema_migrations WHERE id = ?').bind(FOLDER_OBJECT_REPAIR_MIGRATION).first();
    if (repaired) return false;
    await db.batch([
      db.prepare(`
        UPDATE search_items
        SET item_type = 'folder', size = 0, size_formatted = '', preview_type = '',
            sync_status = 'ready', updated_at = ?
        WHERE item_type = 'file'
          AND path != '/'
          AND substr(COALESCE(resource_key, ''), -1, 1) = '/'
      `).bind(Date.now()),
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').bind(FOLDER_OBJECT_REPAIR_MIGRATION, Date.now())
    ]);
    return true;
  }
  const searchColumns = await tableColumns(db, 'search_items');
  const hasLegacySchema = searchColumns.length > 0 && !searchColumns.some(column => column.name === 'storage_id');
  const statements = [];

  if (hasLegacySchema) {
    for (const [table, createSql] of Object.entries(TABLES)) {
      statements.push(db.prepare(`ALTER TABLE ${table} RENAME TO ${table}_legacy_v6`));
      statements.push(db.prepare(createSql));
      statements.push(db.prepare(LEGACY_COPY[table]));
      statements.push(db.prepare(`DROP TABLE ${table}_legacy_v6`));
    }
  } else {
    for (const [table, createSql] of Object.entries(TABLES)) {
      statements.push(db.prepare(createSql.replace(`CREATE TABLE ${table}`, `CREATE TABLE IF NOT EXISTS ${table}`)));
    }
  }
  statements.push(db.prepare(`
    UPDATE search_items
    SET item_type = 'folder', size = 0, size_formatted = '', preview_type = '',
        sync_status = 'ready', updated_at = ?
    WHERE item_type = 'file'
      AND path != '/'
      AND substr(COALESCE(resource_key, ''), -1, 1) = '/'
  `).bind(Date.now()));

  if (hasLegacySchema) {
    const now = Date.now();
    statements.push(db.prepare(`
      INSERT OR IGNORE INTO storage_connections (
        id, name, provider, endpoint, region, bucket, addressing_style,
        credentials_ciphertext, credentials_iv, credential_version,
        enabled, is_default, sync_interval_minutes, last_sync_status,
        created_at, updated_at
      ) VALUES (?, ?, 's3', '', 'auto', '', 'path', NULL, NULL, 1, 0, 1, 1440, 'setup_required', ?, ?)
    `).bind(LEGACY_DEFAULT_STORAGE_ID, '原 R2（待配置）', now, now));
  }

  statements.push(db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').bind(MULTI_STORAGE_MIGRATION, Date.now()));
  statements.push(db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').bind(FOLDER_OBJECT_REPAIR_MIGRATION, Date.now()));
  await db.batch(statements);

  if (env.KV_STORE) {
    await Promise.allSettled([
      env.KV_STORE.delete('d1:schema:v6-bookmark-anchor'),
      env.KV_STORE.delete('d1:schema:v2-tags')
    ]);
  }
  return true;
}

export { TABLES as MULTI_STORAGE_TABLES };
