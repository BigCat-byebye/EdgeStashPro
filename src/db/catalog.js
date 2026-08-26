import {
  formatFileSize,
  getMimeType,
  getPreviewType,
  isoDateString,
  nameFromItemPath,
  normalizeDirectoryPath,
  normalizeItemPath,
  parentPathFromItemPath,
  r2KeyToPath
} from '../common.js';

export function storageIdFromEnv(env) {
  return env.STORAGE_ID || 'legacy-default';
}

export function itemPathToObjectKey(path) {
  const normalized = normalizeItemPath(path);
  return normalized === '/' ? '' : normalized.slice(1);
}

export function catalogRowToClient(row) {
  let tags = [];
  try {
    const parsed = JSON.parse(row.tags || '[]');
    if (Array.isArray(parsed)) tags = parsed.filter(tag => typeof tag === 'string');
  } catch {
    tags = [];
  }
  return {
    storageId: row.storage_id,
    path: row.path,
    name: row.name,
    itemType: row.item_type,
    isFolder: row.item_type === 'folder',
    size: Number(row.size || 0),
    sizeFormatted: row.size_formatted || '',
    previewType: row.preview_type || '',
    parentPath: row.parent_path || parentPathFromItemPath(row.path),
    lastModified: row.last_modified || null,
    indexedAt: row.indexed_at || null,
    updatedAt: row.updated_at || null,
    tags
  };
}

export async function getCatalogResource(env, storageId, rawPath) {
  const path = normalizeItemPath(rawPath || '');
  if (!path) return null;
  if (path === '/') return {
    storageId,
    path: '/',
    itemType: 'folder',
    key: '',
    resourceKey: '/',
    resourceVersion: 'root',
    resourceEtag: '"root"'
  };
  const row = await env.D1_DB.prepare(`
    SELECT * FROM search_items
    WHERE storage_id = ? AND path = ? AND COALESCE(sync_status, 'ready') != 'stale'
  `).bind(storageId, path).first();
  if (!row) return null;
  return {
    storageId,
    path: row.path,
    itemType: row.item_type,
    key: row.resource_key || itemPathToObjectKey(row.path),
    object: row.item_type === 'file' ? {
      key: row.resource_key || itemPathToObjectKey(row.path),
      size: Number(row.size || 0),
      version: row.resource_version || null,
      etag: String(row.resource_etag || '').replace(/^"|"$/g, ''),
      httpEtag: row.resource_etag || '',
      uploaded: row.last_modified ? new Date(row.last_modified) : null,
      httpMetadata: { contentType: getMimeType(row.name) }
    } : null,
    size: Number(row.size || 0),
    resourceKey: row.resource_key || null,
    resourceVersion: row.resource_version || null,
    resourceEtag: row.resource_etag || null,
    syncStatus: row.sync_status || 'ready'
  };
}

export async function listCatalogDirectory(env, storageId, rawPath) {
  const currentPath = normalizeDirectoryPath(rawPath);
  const result = await env.D1_DB.prepare(`
    SELECT * FROM search_items
    WHERE storage_id = ? AND parent_path = ? AND COALESCE(sync_status, 'ready') != 'stale'
    ORDER BY item_type DESC, name COLLATE NOCASE ASC, path COLLATE NOCASE ASC
  `).bind(storageId, currentPath).all();
  const files = [];
  const folders = [];
  for (const row of result.results || []) {
    const item = catalogRowToClient(row);
    if (item.isFolder) folders.push(item);
    else files.push(item);
  }
  return { success: true, storageId, currentPath, files, folders, fromIndex: true };
}

function etagOf(object) {
  const value = object?.etag || object?.httpEtag || '';
  return value ? `"${String(value).replace(/^"|"$/g, '')}"` : null;
}

function addFolderRow(map, storageId, path, scanId, indexedAt, marker = null) {
  const normalized = normalizeItemPath(path);
  if (!normalized || normalized === '/') return;
  const current = map.get(normalized);
  if (current && !marker) return;
  map.set(normalized, {
    storage_id: storageId,
    path: normalized,
    name: nameFromItemPath(normalized),
    item_type: 'folder',
    parent_path: parentPathFromItemPath(normalized),
    size: 0,
    size_formatted: '',
    preview_type: '',
    last_modified: marker?.lastModified ? isoDateString(marker.lastModified) : null,
    tags: current?.tags || '[]',
    indexed_at: indexedAt,
    resource_key: marker?.key || itemPathToObjectKey(normalized) + '/',
    resource_version: marker?.version || null,
    resource_etag: etagOf(marker),
    sync_status: 'ready',
    updated_at: indexedAt,
    last_seen_scan_id: scanId || null
  });
}

export function buildCatalogRowsFromObjects(storageId, objects, scanId, indexedAt = Date.now()) {
  const rows = new Map();
  for (const object of objects || []) {
    const rawKey = String(object.key || '').replace(/^\/+/, '');
    if (!rawKey) continue;
    const parts = rawKey.split('/').filter(Boolean);
    const isFolderMarker = rawKey.endsWith('/.folder');
    const isDirectoryObject = rawKey.endsWith('/');
    const isFolderObject = isFolderMarker || isDirectoryObject;
    const folderParts = isFolderMarker
      ? parts.slice(0, -1)
      : isDirectoryObject
        ? parts
        : parts.slice(0, -1);
    for (let depth = 1; depth <= folderParts.length; depth += 1) {
      const folderPath = '/' + folderParts.slice(0, depth).join('/');
      const marker = isFolderObject && depth === folderParts.length
        ? { ...object, key: rawKey }
        : null;
      addFolderRow(rows, storageId, folderPath, scanId, indexedAt, marker);
    }
    if (isFolderObject) continue;
    const path = r2KeyToPath(rawKey);
    const name = nameFromItemPath(path);
    const size = Number(object.size || 0);
    rows.set(path, {
      storage_id: storageId,
      path,
      name,
      item_type: 'file',
      parent_path: parentPathFromItemPath(path),
      size,
      size_formatted: formatFileSize(size),
      preview_type: getPreviewType(name) || '',
      last_modified: object.lastModified ? isoDateString(object.lastModified) : null,
      tags: '[]',
      indexed_at: indexedAt,
      resource_key: rawKey,
      resource_version: object.version || null,
      resource_etag: etagOf(object),
      sync_status: 'ready',
      updated_at: indexedAt,
      last_seen_scan_id: scanId || null
    });
  }
  return [...rows.values()];
}

export async function upsertCatalogRows(env, rows) {
  if (!rows?.length) return;
  const statement = env.D1_DB.prepare(`
    INSERT INTO search_items (
      storage_id, path, name, item_type, parent_path, size, size_formatted,
      preview_type, last_modified, tags, indexed_at, resource_key,
      resource_version, resource_etag, sync_status, updated_at, last_seen_scan_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
    ON CONFLICT(storage_id, path) DO UPDATE SET
      name = excluded.name,
      item_type = excluded.item_type,
      parent_path = excluded.parent_path,
      size = excluded.size,
      size_formatted = excluded.size_formatted,
      preview_type = excluded.preview_type,
      last_modified = excluded.last_modified,
      indexed_at = excluded.indexed_at,
      resource_key = excluded.resource_key,
      resource_version = excluded.resource_version,
      resource_etag = excluded.resource_etag,
      sync_status = 'ready',
      updated_at = excluded.updated_at,
      last_seen_scan_id = excluded.last_seen_scan_id
  `);
  for (let index = 0; index < rows.length; index += 50) {
    await env.D1_DB.batch(rows.slice(index, index + 50).map(row => statement.bind(
      row.storage_id, row.path, row.name, row.item_type, row.parent_path,
      row.size || 0, row.size_formatted || '', row.preview_type || '',
      row.last_modified || null, row.tags || '[]', row.indexed_at || Date.now(),
      row.resource_key || null, row.resource_version || null, row.resource_etag || null,
      row.updated_at || Date.now(), row.last_seen_scan_id || null
    )));
  }
}

export async function invalidateStoragePathReferences(env, storageId, rawPath) {
  const path = normalizeItemPath(rawPath);
  if (!path || path === '/') return;
  const scoped = [
    ['favorites', 'path'],
    ['recent_items', 'path'],
    ['reader_bookmarks', 'path'],
    ['reader_progress', 'path'],
    ['txt_index_chunks', 'path'],
    ['txt_index_files', 'path'],
    ['user_permissions', 'path']
  ];
  const statements = scoped.map(([table, column]) => env.D1_DB.prepare(
    `DELETE FROM ${table} WHERE storage_id = ? AND (${column} = ? OR substr(${column}, 1, length(?) + 1) = ? || '/')`
  ).bind(storageId, path, path, path));
  statements.push(env.D1_DB.prepare(`
    UPDATE share_links SET revoked_at = COALESCE(revoked_at, ?)
    WHERE storage_id = ? AND share_id IN (
      SELECT share_id FROM share_items
      WHERE storage_id = ?
        AND (item_path = ? OR substr(item_path, 1, length(?) + 1) = ? || '/')
    )
  `).bind(Date.now(), storageId, storageId, path, path, path));
  await env.D1_DB.batch(statements);
}
