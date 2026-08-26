import { jsonResponse } from './common.js';
import { requireAdmin, requireAuth } from './auth.js';
import { ensureD1Schema } from './db/schema.js';
import { decryptStorageCredentials, encryptStorageCredentials, StorageConfigKeyError } from './storage/credentials.js';
import {
  createStorageConnection,
  getStorageConnection,
  listStorageConnections,
  listVisibleStorageConnections,
  normalizeStorageInput,
  storageRowToClient,
  StorageError,
  updateStorageConnection
} from './storage/repository.js';
import { createS3Adapter, S3StorageError } from './storage/s3.js';
import { enqueueStorageSync, getStorageSyncJob, syncJobToClient } from './storage/sync.js';

function storageErrorResponse(error) {
  const status = Number(error?.status || 500);
  const known = error instanceof StorageError || error instanceof StorageConfigKeyError || error instanceof S3StorageError;
  const message = known
    ? error.message
    : String(error?.message || '存储操作失败').slice(0, 300);
  return jsonResponse({
    success: false,
    code: known ? (error.code || 'STORAGE_ERROR') : 'STORAGE_ERROR',
    message
  }, status);
}

async function readBody(request) {
  return request.json().catch(() => ({}));
}

async function testNormalizedConnection(normalized, credentials, id = 'connection-test') {
  const adapter = createS3Adapter({
    id,
    endpoint: normalized.endpoint,
    region: normalized.region,
    bucket: normalized.bucket,
    addressing_style: normalized.addressingStyle
  }, credentials);
  await adapter.list({ limit: 1 });
}

export async function handleListVisibleStorages(request, env) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  try {
    await ensureD1Schema(env);
    const rows = await listVisibleStorageConnections(env, auth);
    return jsonResponse({ success: true, storages: rows.map(row => storageRowToClient(row)) });
  } catch (error) {
    return storageErrorResponse(error);
  }
}

export async function handleAdminListStorages(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;
  try {
    await ensureD1Schema(env);
    const rows = await listStorageConnections(env, { includeDeleted: true });
    return jsonResponse({ success: true, storages: rows.map(row => storageRowToClient(row, { admin: true })) });
  } catch (error) {
    return storageErrorResponse(error);
  }
}

export async function handleAdminTestStorage(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;
  try {
    await ensureD1Schema(env);
    const body = await readBody(request);
    const existing = body.id ? await getStorageConnection(env, body.id) : null;
    const normalized = normalizeStorageInput(body, env, existing);
    const credentials = body.accessKeyId || body.secretAccessKey
      ? { accessKeyId: body.accessKeyId, secretAccessKey: body.secretAccessKey, sessionToken: body.sessionToken }
      : await decryptStorageCredentials(env.STORAGE_CONFIG_KEY, existing?.id, existing);
    await testNormalizedConnection(normalized, credentials, existing?.id || 'connection-test');
    return jsonResponse({ success: true, message: 'S3 连接测试成功' });
  } catch (error) {
    return storageErrorResponse(error);
  }
}

export async function handleAdminCreateStorage(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;
  try {
    await ensureD1Schema(env);
    const body = await readBody(request);
    const normalized = normalizeStorageInput(body, env);
    const storageId = crypto.randomUUID();
    const credentials = { accessKeyId: body.accessKeyId, secretAccessKey: body.secretAccessKey, sessionToken: body.sessionToken };
    await testNormalizedConnection(normalized, credentials, storageId);
    const encrypted = await encryptStorageCredentials(env.STORAGE_CONFIG_KEY, storageId, credentials);
    const row = await createStorageConnection(env, normalized, encrypted, storageId);
    const job = row.enabled ? await enqueueStorageSync(env, row.id, { requestedBy: auth.role }) : null;
    return jsonResponse({
      success: true,
      storage: storageRowToClient(row, { admin: true }),
      sync: syncJobToClient(job)
    }, 201);
  } catch (error) {
    return storageErrorResponse(error);
  }
}

export async function handleAdminUpdateStorage(request, env, storageId) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;
  try {
    await ensureD1Schema(env);
    const existing = await getStorageConnection(env, storageId);
    if (!existing) throw new StorageError('STORAGE_NOT_FOUND', '存储不存在', 404);
    const body = await readBody(request);
    const normalized = normalizeStorageInput(body, env, existing);
    const hasNewCredentials = !!(body.accessKeyId || body.secretAccessKey || body.sessionToken);
    let encrypted = null;
    if (hasNewCredentials) {
      const credentials = { accessKeyId: body.accessKeyId, secretAccessKey: body.secretAccessKey, sessionToken: body.sessionToken };
      await testNormalizedConnection(normalized, credentials, storageId);
      encrypted = await encryptStorageCredentials(env.STORAGE_CONFIG_KEY, storageId, credentials);
    } else if (normalized.enabled && !existing.enabled) {
      const credentials = await decryptStorageCredentials(env.STORAGE_CONFIG_KEY, storageId, existing);
      await testNormalizedConnection(normalized, credentials, storageId);
    }
    const row = await updateStorageConnection(env, existing, normalized, encrypted);
    if (!row.enabled) {
      const now = Date.now();
      await env.D1_DB.batch([
        env.D1_DB.prepare("UPDATE storage_sync_jobs SET status = 'canceled', completed_at = ?, updated_at = ? WHERE storage_id = ? AND status IN ('queued', 'running')").bind(now, now, storageId),
        env.D1_DB.prepare("UPDATE file_tasks SET status = 'failed', error_message = '存储已停用', completed_at = ?, updated_at = ? WHERE storage_id = ? AND status IN ('queued', 'running')").bind(now, now, storageId)
      ]);
    }
    return jsonResponse({ success: true, storage: storageRowToClient(row, { admin: true }) });
  } catch (error) {
    return storageErrorResponse(error);
  }
}

export async function handleAdminDeleteStorage(request, env, storageId) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;
  try {
    await ensureD1Schema(env);
    const existing = await getStorageConnection(env, storageId);
    if (!existing) throw new StorageError('STORAGE_NOT_FOUND', '存储不存在', 404);
    const body = await readBody(request);
    if (String(body.confirmationName || '') !== existing.name) {
      throw new StorageError('STORAGE_DELETE_CONFIRMATION_REQUIRED', '请输入存储名称确认删除', 400);
    }
    let replacement = null;
    if (existing.is_default) {
      const otherActive = await env.D1_DB.prepare(`
        SELECT id FROM storage_connections
        WHERE id != ? AND deleted_at IS NULL
        ORDER BY created_at ASC LIMIT 1
      `).bind(storageId).first();
      // Only require a replacement default when other storages still exist.
      // Deleting the very last storage is allowed; the app then returns to the
      // "no storage configured" state and the next added storage becomes default.
      if (otherActive) {
        replacement = await env.D1_DB.prepare(`
          SELECT id FROM storage_connections
          WHERE id != ? AND enabled = 1 AND deleted_at IS NULL
          ORDER BY created_at ASC LIMIT 1
        `).bind(storageId).first();
        if (!replacement) throw new StorageError('STORAGE_DEFAULT_REQUIRED', '请先创建并启用另一个默认存储', 409);
      }
    }
    const now = Date.now();
    const scopedTables = [
      'search_items', 'favorites', 'recent_items', 'reader_bookmarks',
      'reader_progress', 'txt_index_chunks', 'txt_index_files',
      'user_permissions', 'app_stats'
    ];
    const statements = scopedTables.map(table => env.D1_DB.prepare(`DELETE FROM ${table} WHERE storage_id = ?`).bind(storageId));
    statements.push(
      env.D1_DB.prepare("UPDATE storage_sync_jobs SET status = 'canceled', completed_at = ?, updated_at = ? WHERE storage_id = ? AND status IN ('queued', 'running')").bind(now, now, storageId),
      env.D1_DB.prepare("UPDATE file_tasks SET status = 'failed', error_message = '存储已删除', completed_at = ?, updated_at = ? WHERE storage_id = ? AND status IN ('queued', 'running')").bind(now, now, storageId),
      env.D1_DB.prepare('UPDATE share_links SET revoked_at = COALESCE(revoked_at, ?) WHERE storage_id = ?').bind(now, storageId),
      env.D1_DB.prepare(`
        UPDATE storage_connections SET enabled = 0, is_default = 0,
          credentials_ciphertext = NULL, credentials_iv = NULL,
          last_sync_status = 'deleted', deleted_at = ?, updated_at = ?
        WHERE id = ?
      `).bind(now, now, storageId)
    );
    if (replacement) statements.push(env.D1_DB.prepare('UPDATE storage_connections SET is_default = 1, updated_at = ? WHERE id = ?').bind(now, replacement.id));
    await env.D1_DB.batch(statements);
    return jsonResponse({ success: true });
  } catch (error) {
    return storageErrorResponse(error);
  }
}

export async function handleAdminTriggerStorageSync(request, env, storageId) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;
  try {
    await ensureD1Schema(env);
    const body = await readBody(request);
    const job = await enqueueStorageSync(env, storageId, { path: body.path || '/', requestedBy: 'admin' });
    return jsonResponse({ success: true, sync: syncJobToClient(job) }, 202);
  } catch (error) {
    return storageErrorResponse(error);
  }
}

export async function handleAdminGetStorageSync(request, env, storageId) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;
  try {
    await ensureD1Schema(env);
    const job = await getStorageSyncJob(env, storageId);
    return jsonResponse({ success: true, sync: syncJobToClient(job) });
  } catch (error) {
    return storageErrorResponse(error);
  }
}
