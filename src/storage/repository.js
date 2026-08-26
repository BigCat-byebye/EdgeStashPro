import { LEGACY_DEFAULT_STORAGE_ID } from '../common.js';
import { storageCredentialsForDb } from './credentials.js';

export const STORAGE_SYNC_INTERVALS = new Set([0, 15, 60, 360, 1440]);

export class StorageError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.status = status;
  }
}

function isPrivateIpv4(hostname) {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some(value => value > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || a >= 224;
}

function isForbiddenHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || host === '::' || host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')
    || host === '169.254.169.254' || host === 'metadata.google.internal' || isPrivateIpv4(host);
}

export function normalizeStorageInput(input, env, existing = null) {
  const name = String(input?.name ?? existing?.name ?? '').trim();
  const endpointValue = String(input?.endpoint ?? existing?.endpoint ?? '').trim();
  const region = String(input?.region ?? existing?.region ?? 'auto').trim() || 'auto';
  const bucket = String(input?.bucket ?? existing?.bucket ?? '').trim();
  const addressingStyle = String(input?.addressingStyle ?? input?.addressing_style ?? existing?.addressing_style ?? 'path').trim();
  const syncIntervalMinutes = Number(input?.syncIntervalMinutes ?? input?.sync_interval_minutes ?? existing?.sync_interval_minutes ?? 1440);
  if (!name || name.length > 80) throw new StorageError('STORAGE_NAME_INVALID', '存储名称不能为空且最多 80 个字符');
  if (!bucket || bucket.length > 255) throw new StorageError('STORAGE_BUCKET_INVALID', 'Bucket 名称无效');
  if (!['path', 'virtual'].includes(addressingStyle)) throw new StorageError('STORAGE_ADDRESSING_INVALID', 'addressingStyle 必须是 path 或 virtual');
  if (!STORAGE_SYNC_INTERVALS.has(syncIntervalMinutes)) throw new StorageError('STORAGE_SYNC_INTERVAL_INVALID', '同步间隔不受支持');

  let endpoint;
  try {
    endpoint = new URL(endpointValue);
  } catch {
    throw new StorageError('STORAGE_ENDPOINT_INVALID', 'S3 endpoint 无效');
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new StorageError('STORAGE_ENDPOINT_INVALID', 'S3 endpoint 必须是无凭证、query 和 fragment 的 HTTPS 地址');
  }
  if (isForbiddenHost(endpoint.hostname)) throw new StorageError('STORAGE_ENDPOINT_FORBIDDEN', 'S3 endpoint 不允许指向本地或私有地址');
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '');

  return {
    name,
    provider: 's3',
    endpoint: endpoint.toString().replace(/\/$/, ''),
    region,
    bucket,
    addressingStyle,
    syncIntervalMinutes,
    isDefault: input?.isDefault === undefined ? !!existing?.is_default : !!input.isDefault,
    enabled: input?.enabled === undefined ? (existing ? !!existing.enabled : true) : !!input.enabled
  };
}

export function storageRowToClient(row, { admin = false } = {}) {
  if (!row) return null;
  const result = {
    id: row.id,
    name: row.name,
    provider: row.provider,
    isDefault: !!row.is_default,
    enabled: !!row.enabled,
    syncIntervalMinutes: Number(row.sync_interval_minutes || 0),
    lastSyncAt: row.last_sync_at || null,
    lastSyncStatus: row.last_sync_status || null,
    lastSyncError: row.last_sync_error || null,
    credentialsConfigured: !!(row.credentials_ciphertext && row.credentials_iv)
  };
  if (admin) {
    result.endpoint = row.endpoint;
    result.region = row.region;
    result.bucket = row.bucket;
    result.addressingStyle = row.addressing_style;
    result.createdAt = row.created_at;
    result.updatedAt = row.updated_at;
    result.deletedAt = row.deleted_at || null;
  }
  return result;
}

export async function getStorageConnection(env, storageId, { includeDeleted = false } = {}) {
  if (!storageId) return null;
  const where = includeDeleted ? 'id = ?' : 'id = ? AND deleted_at IS NULL';
  return env.D1_DB.prepare(`SELECT * FROM storage_connections WHERE ${where}`).bind(storageId).first();
}

export async function getDefaultStorageConnection(env) {
  return env.D1_DB.prepare(`
    SELECT * FROM storage_connections
    WHERE is_default = 1 AND enabled = 1 AND deleted_at IS NULL
    LIMIT 1
  `).first();
}

export async function listStorageConnections(env, { includeDeleted = false } = {}) {
  const where = includeDeleted ? '' : 'WHERE deleted_at IS NULL';
  const result = await env.D1_DB.prepare(`
    SELECT * FROM storage_connections
    ${where}
    ORDER BY is_default DESC, lower(name) ASC
  `).all();
  return result.results || [];
}

export async function listVisibleStorageConnections(env, auth) {
  if (auth?.role === 'admin') {
    const rows = await listStorageConnections(env);
    return rows.filter(row => row.enabled);
  }
  if (!auth?.email) return [];
  const result = await env.D1_DB.prepare(`
    SELECT DISTINCT storage_connections.*
    FROM storage_connections
    INNER JOIN user_permissions ON user_permissions.storage_id = storage_connections.id
    WHERE user_permissions.email = ? AND user_permissions.can_view = 1
      AND storage_connections.enabled = 1 AND storage_connections.deleted_at IS NULL
    ORDER BY storage_connections.is_default DESC, lower(storage_connections.name) ASC
  `).bind(auth.email).all();
  return result.results || [];
}

export async function createStorageConnection(env, normalized, encrypted, storageId = crypto.randomUUID()) {
  const now = Date.now();
  const dbEncrypted = storageCredentialsForDb(encrypted);
  const statements = [];
  if (normalized.isDefault) statements.push(env.D1_DB.prepare('UPDATE storage_connections SET is_default = 0 WHERE deleted_at IS NULL'));
  statements.push(env.D1_DB.prepare(`
    INSERT INTO storage_connections (
      id, name, provider, endpoint, region, bucket, addressing_style,
      credentials_ciphertext, credentials_iv, credential_version,
      enabled, is_default, sync_interval_minutes, last_sync_status,
      created_at, updated_at
    ) VALUES (?, ?, 's3', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'never', ?, ?)
  `).bind(
    storageId, normalized.name, normalized.endpoint, normalized.region, normalized.bucket,
    normalized.addressingStyle, dbEncrypted.ciphertext, dbEncrypted.iv, dbEncrypted.version,
    normalized.enabled ? 1 : 0, normalized.isDefault ? 1 : 0, normalized.syncIntervalMinutes,
    now, now
  ));
  await env.D1_DB.batch(statements);
  if (!normalized.isDefault) {
    const currentDefault = await getDefaultStorageConnection(env);
    if (!currentDefault) await env.D1_DB.prepare('UPDATE storage_connections SET is_default = 1 WHERE id = ?').bind(storageId).run();
  }
  return getStorageConnection(env, storageId);
}

export async function updateStorageConnection(env, existing, normalized, encrypted = null) {
  if (!existing) throw new StorageError('STORAGE_NOT_FOUND', '存储不存在', 404);
  const identityChanged = existing.endpoint !== normalized.endpoint || existing.region !== normalized.region
    || existing.bucket !== normalized.bucket || existing.addressing_style !== normalized.addressingStyle;
  if (identityChanged && existing.last_sync_at) {
    throw new StorageError('STORAGE_IDENTITY_IMMUTABLE', '完成首次同步后不能修改 endpoint、region、bucket 或 addressingStyle', 409);
  }
  const now = Date.now();
  const dbEncrypted = encrypted ? storageCredentialsForDb(encrypted) : null;
  const statements = [];
  if (normalized.isDefault) statements.push(env.D1_DB.prepare('UPDATE storage_connections SET is_default = 0 WHERE deleted_at IS NULL'));
  statements.push(env.D1_DB.prepare(`
    UPDATE storage_connections SET
      name = ?, endpoint = ?, region = ?, bucket = ?, addressing_style = ?,
      credentials_ciphertext = COALESCE(?, credentials_ciphertext),
      credentials_iv = COALESCE(?, credentials_iv),
      credential_version = COALESCE(?, credential_version),
      enabled = ?, is_default = ?, sync_interval_minutes = ?, updated_at = ?
    WHERE id = ? AND deleted_at IS NULL
  `).bind(
    normalized.name, normalized.endpoint, normalized.region, normalized.bucket, normalized.addressingStyle,
    dbEncrypted?.ciphertext ?? null, dbEncrypted?.iv ?? null, dbEncrypted?.version ?? null,
    normalized.enabled ? 1 : 0, normalized.isDefault ? 1 : 0,
    normalized.syncIntervalMinutes, now, existing.id
  ));
  await env.D1_DB.batch(statements);
  return getStorageConnection(env, existing.id);
}

export async function markStorageSyncState(env, storageId, status, fields = {}) {
  await env.D1_DB.prepare(`
    UPDATE storage_connections SET
      last_sync_status = ?,
      last_sync_at = COALESCE(?, last_sync_at),
      last_sync_error = ?,
      updated_at = ?
    WHERE id = ?
  `).bind(status, fields.lastSyncAt || null, fields.error || null, Date.now(), storageId).run();
}

export async function resolveStorageConnection(request, env, auth, { allowDisabled = false } = {}) {
  const url = new URL(request.url);
  const requestedId = url.searchParams.get('storageId') || request.headers.get('X-Storage-Id');
  let connection = requestedId ? await getStorageConnection(env, requestedId) : await getDefaultStorageConnection(env);
  if (!connection && requestedId === LEGACY_DEFAULT_STORAGE_ID) connection = await getStorageConnection(env, requestedId);
  if (!connection) throw new StorageError('STORAGE_NOT_CONFIGURED', '尚未配置可用存储', 503);
  if (!allowDisabled && !connection.enabled) {
    const code = connection.last_sync_status === 'setup_required' ? 'STORAGE_SETUP_REQUIRED' : 'STORAGE_DISABLED';
    throw new StorageError(code, code === 'STORAGE_SETUP_REQUIRED' ? '默认存储尚待配置' : '存储已停用', 503);
  }
  if (auth?.role !== 'admin') {
    const visible = await env.D1_DB.prepare(`
      SELECT 1 AS allowed FROM user_permissions
      WHERE email = ? AND storage_id = ? AND can_view = 1 LIMIT 1
    `).bind(auth?.email || '', connection.id).first();
    if (!visible) throw new StorageError('STORAGE_FORBIDDEN', '没有此存储的访问权限', 403);
  }
  return connection;
}
