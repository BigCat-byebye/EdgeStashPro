import { normalizeDirectoryPath } from '../common.js';
import {
  buildCatalogRowsFromObjects,
  invalidateStoragePathReferences,
  itemPathToObjectKey,
  upsertCatalogRows
} from '../db/catalog.js';
import { decryptStorageCredentials } from './credentials.js';
import { createS3Adapter } from './s3.js';
import {
  getStorageConnection,
  listStorageConnections,
  markStorageSyncState,
  StorageError
} from './repository.js';

const SYNC_PAGE_SIZE = 500;
const LEASE_MS = 120_000;

export function syncJobToClient(row) {
  if (!row) return null;
  return {
    id: row.id,
    storageId: row.storage_id,
    scopePrefix: row.scope_prefix || '',
    status: row.status,
    objectsScanned: Number(row.objects_scanned || 0),
    errorMessage: row.error_message || null,
    startedAt: row.started_at || null,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null
  };
}

export async function getStorageSyncJob(env, storageId) {
  return env.D1_DB.prepare(`
    SELECT * FROM storage_sync_jobs
    WHERE storage_id = ?
    ORDER BY updated_at DESC LIMIT 1
  `).bind(storageId).first();
}

export async function enqueueStorageSync(env, storageId, { path = '/', requestedBy = 'system' } = {}) {
  const connection = await getStorageConnection(env, storageId);
  if (!connection) throw new StorageError('STORAGE_NOT_FOUND', '存储不存在', 404);
  if (!connection.enabled) throw new StorageError('STORAGE_DISABLED', '存储已停用', 503);
  const scopePrefix = path === '/' ? '' : itemPathToObjectKey(normalizeDirectoryPath(path)).replace(/\/+$/, '') + '/';
  const existing = await env.D1_DB.prepare(`
    SELECT * FROM storage_sync_jobs
    WHERE storage_id = ? AND status IN ('queued', 'running')
    LIMIT 1
  `).bind(storageId).first();
  if (existing) return existing;

  const failed = await env.D1_DB.prepare(`
    SELECT * FROM storage_sync_jobs
    WHERE storage_id = ? AND scope_prefix = ? AND status = 'failed'
    ORDER BY updated_at DESC LIMIT 1
  `).bind(storageId, scopePrefix).first();
  if (failed && requestedBy !== 'schedule') {
    await env.D1_DB.prepare(`
      UPDATE storage_sync_jobs
      SET status = 'queued', error_message = NULL, lease_token = NULL,
          lease_expires_at = NULL, completed_at = NULL, updated_at = ?
      WHERE id = ?
    `).bind(Date.now(), failed.id).run();
    return env.D1_DB.prepare('SELECT * FROM storage_sync_jobs WHERE id = ?').bind(failed.id).first();
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  await env.D1_DB.prepare(`
    INSERT INTO storage_sync_jobs (
      id, storage_id, scope_prefix, status, continuation_token, scan_id,
      objects_scanned, requested_by, updated_at
    ) VALUES (?, ?, ?, 'queued', NULL, ?, 0, ?, ?)
  `).bind(id, storageId, scopePrefix, crypto.randomUUID(), requestedBy, now).run();
  await markStorageSyncState(env, storageId, 'queued');
  return env.D1_DB.prepare('SELECT * FROM storage_sync_jobs WHERE id = ?').bind(id).first();
}

async function claimNextJob(env) {
  const now = Date.now();
  const candidate = await env.D1_DB.prepare(`
    SELECT * FROM storage_sync_jobs
    WHERE status = 'queued'
       OR (status = 'running' AND COALESCE(lease_expires_at, 0) < ?)
    ORDER BY updated_at ASC LIMIT 1
  `).bind(now).first();
  if (!candidate) return null;
  const lease = crypto.randomUUID();
  const result = await env.D1_DB.prepare(`
    UPDATE storage_sync_jobs
    SET status = 'running', lease_token = ?, lease_expires_at = ?,
        started_at = COALESCE(started_at, ?), updated_at = ?
    WHERE id = ? AND (
      status = 'queued' OR (status = 'running' AND COALESCE(lease_expires_at, 0) < ?)
    )
  `).bind(lease, now + LEASE_MS, now, now, candidate.id, now).run();
  if (Number(result?.meta?.changes ?? result?.changes ?? 0) < 1) return null;
  return { ...candidate, status: 'running', lease_token: lease, lease_expires_at: now + LEASE_MS, started_at: candidate.started_at || now };
}

async function loadExistingRows(env, storageId, paths) {
  const result = new Map();
  for (let index = 0; index < paths.length; index += 50) {
    const chunk = paths.slice(index, index + 50);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await env.D1_DB.prepare(`
      SELECT * FROM search_items
      WHERE storage_id = ? AND path IN (${placeholders})
    `).bind(storageId, ...chunk).all();
    for (const row of rows.results || []) result.set(row.path, row);
  }
  return result;
}

function identityChanged(previous, next) {
  if (!previous) return false;
  return (previous.resource_key || '') !== (next.resource_key || '')
    || (previous.resource_version || '') !== (next.resource_version || '')
    || (previous.resource_etag || '') !== (next.resource_etag || '');
}

async function sweepMissingRows(env, job) {
  const prefixPath = job.scope_prefix ? '/' + job.scope_prefix.replace(/\/$/, '') : '/';
  const result = await env.D1_DB.prepare(`
    SELECT path FROM search_items
    WHERE storage_id = ?
      AND COALESCE(last_seen_scan_id, '') != ?
      AND COALESCE(updated_at, 0) < ?
      AND (
        ? = '/'
        OR path = ?
        OR substr(path, 1, length(?) + 1) = ? || '/'
      )
    ORDER BY length(path) DESC
  `).bind(
    job.storage_id,
    job.scan_id,
    job.started_at,
    prefixPath,
    prefixPath,
    prefixPath,
    prefixPath
  ).all();
  for (const row of result.results || []) {
    await invalidateStoragePathReferences(env, job.storage_id, row.path);
    await env.D1_DB.prepare('DELETE FROM search_items WHERE storage_id = ? AND path = ?').bind(job.storage_id, row.path).run();
  }
}

export async function processNextStorageSyncPage(env) {
  const job = await claimNextJob(env);
  if (!job) return null;
  const now = Date.now();
  try {
    const connection = await getStorageConnection(env, job.storage_id);
    if (!connection?.enabled) throw new StorageError('STORAGE_DISABLED', '存储已停用', 503);
    const credentials = await decryptStorageCredentials(env.STORAGE_CONFIG_KEY, connection.id, connection);
    const adapter = typeof env.SYNC_ADAPTER_FACTORY === 'function'
      ? env.SYNC_ADAPTER_FACTORY(connection, credentials)
      : createS3Adapter(connection, credentials);
    const page = await adapter.list({
      prefix: job.scope_prefix || '',
      cursor: job.continuation_token || null,
      limit: SYNC_PAGE_SIZE
    });
    const rows = buildCatalogRowsFromObjects(job.storage_id, page.objects, job.scan_id, now);
    const existing = await loadExistingRows(env, job.storage_id, rows.map(row => row.path));
    // Only write rows whose identity or content actually changed: the
    // previous unconditional upsert rewrote the whole catalog on every scan
    // and D1 bills each ON CONFLICT DO UPDATE as a row write.
    const changedRows = [];
    for (const row of rows) {
      const previous = existing.get(row.path);
      if (!previous) {
        changedRows.push(row);
        continue;
      }
      if (identityChanged(previous, row)) {
        await invalidateStoragePathReferences(env, job.storage_id, row.path);
        changedRows.push(row);
        continue;
      }
      // Unchanged identity: refresh only the cheap bookkeeping columns so
      // sweep pruning still sees a fresh last_seen_scan_id.
      await env.D1_DB.prepare(
        'UPDATE search_items SET last_seen_scan_id = ?, updated_at = ? WHERE storage_id = ? AND path = ?'
      ).bind(row.last_seen_scan_id || null, now, job.storage_id, row.path).run();
    }
    if (changedRows.length > 0) await upsertCatalogRows(env, changedRows);

    const done = !page.truncated || !page.cursor;
    if (done) await sweepMissingRows(env, job);
    await env.D1_DB.prepare(`
      UPDATE storage_sync_jobs SET
        status = ?, continuation_token = ?, objects_scanned = objects_scanned + ?,
        lease_token = NULL, lease_expires_at = NULL, error_message = NULL,
        completed_at = ?, updated_at = ?
      WHERE id = ? AND lease_token = ?
    `).bind(
      done ? 'succeeded' : 'queued',
      done ? null : page.cursor,
      page.objects.length,
      done ? now : null,
      now,
      job.id,
      job.lease_token
    ).run();
    await markStorageSyncState(env, job.storage_id, done ? 'succeeded' : 'running', {
      lastSyncAt: done ? now : null,
      error: null
    });
    return { jobId: job.id, storageId: job.storage_id, done, count: page.objects.length };
  } catch (error) {
    const message = String(error?.message || '同步失败').slice(0, 300);
    await env.D1_DB.prepare(`
      UPDATE storage_sync_jobs SET
        status = 'failed', lease_token = NULL, lease_expires_at = NULL,
        error_message = ?, completed_at = ?, updated_at = ?
      WHERE id = ?
    `).bind(message, now, now, job.id).run();
    await markStorageSyncState(env, job.storage_id, 'failed', { error: message });
    return { jobId: job.id, storageId: job.storage_id, done: false, error: message };
  }
}

async function enqueueDueSync(env, scheduledTime) {
  const rows = await listStorageConnections(env);
  const now = Number(scheduledTime || Date.now());
  for (const row of rows) {
    const interval = Number(row.sync_interval_minutes || 0);
    if (!row.enabled || interval <= 0) continue;
    const dueAt = Number(row.last_sync_at || 0) + interval * 60_000;
    if (dueAt > now) continue;
    const active = await env.D1_DB.prepare(`
      SELECT id FROM storage_sync_jobs
      WHERE storage_id = ? AND status IN ('queued', 'running') LIMIT 1
    `).bind(row.id).first();
    if (!active) {
      await enqueueStorageSync(env, row.id, { requestedBy: 'schedule' });
      return;
    }
  }
}

export async function runScheduledMaintenance(env, scheduledTime = Date.now(), processTxtIndexes = null) {
  await enqueueDueSync(env, scheduledTime);
  const sync = await processNextStorageSyncPage(env);
  const txt = processTxtIndexes ? await processTxtIndexes(env, 10) : null;
  return { sync, txt };
}
