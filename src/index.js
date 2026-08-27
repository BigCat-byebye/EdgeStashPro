/**
 * EdgeStashPro - Cloudflare-based Cloud Drive
 *
 * A cloud drive Worker backed by dynamically configured S3-compatible storage.
 *
 * Required secrets:
 * - ADMIN_PASSWORD: Administrator password and JWT signing secret
 * - STORAGE_CONFIG_KEY: AES-256-GCM key for encrypted storage credentials
 *
 * Bindings:
 * - KV_STORE: user accounts, OTP, and legacy reader state
 * - D1_DB: catalog, permissions, shares, reader state, tasks, and storage configuration
 */
import { FIXED_LOGIN_PAGE } from './pages/login.js';
import { FIXED_INDEX_PAGE } from './pages/index.js';
import { FIXED_ADMIN_PAGE } from './pages/admin.js';
import { FIXED_SHARE_PAGE } from './pages/share.js';
import {
  generateId,
  hashPassword,
  generateOtpSecret,
  verifyTotp,
  createOtpUri,
  sha256Hex,
  createJWT,
  verifyJWT,
  getExpirationTime,
  formatFileSize,
  getMimeType,
  safeDecodePath,
  createAttachmentDisposition,
  createInlineDisposition,
  normalizeDirectoryPath,
  normalizeItemPath,
  directoryPathToR2Prefix,
  r2KeyToPath,
  parentPathFromItemPath,
  nameFromItemPath,
  isSafePathSegment,
  isoDateString,
  getPreviewType,
  parseCookies,
  jsonResponse,
  requireRequiredConfig,
  htmlResponse
} from './common.js';
import { handleLogin, handleLogout, verifyAuth, requireAuth, requireAdmin } from './auth.js';
import { ensureD1Schema } from './db/schema.js';
import {
  handleAdminCreateStorage,
  handleAdminDeleteStorage,
  handleAdminGetStorageSync,
  handleAdminListStorages,
  handleAdminTestStorage,
  handleAdminTriggerStorageSync,
  handleAdminUpdateStorage,
  handleListVisibleStorages
} from './admin.js';
import { enqueueStorageSync, getStorageSyncJob, runScheduledMaintenance, syncJobToClient } from './storage/sync.js';
import { createStorageRuntime, isStorageRuntimeError } from './storage/service.js';









// ============================================================================
// FILE MANAGEMENT HANDLERS
// ============================================================================

async function getDirectoryListingForAuth(env, auth, path, options = {}) {
  const currentPath = normalizeDirectoryPath(path);


  const permissionError = await requirePathPermission(env, auth, 'view', currentPath);
  if (permissionError) {
    const virtualListing = await listVirtualPermissionDirectory(env, auth, currentPath);
    return virtualListing || permissionError;
  }

  if (options.forceRefresh) await enqueueStorageSync(env, env.STORAGE_ID, { path: currentPath, requestedBy: auth.role });

  const listing = await listDirectoryFromD1(env, currentPath);
  if (listing.folders.length === 0 && listing.files.length === 0 && currentPath !== '/') {
    const knownFolder = await env.D1_DB.prepare(`
      SELECT path FROM search_items
      WHERE storage_id = ? AND path = ? AND item_type = 'folder'
        AND COALESCE(sync_status, 'ready') != 'stale'
    `).bind(env.STORAGE_ID, currentPath).first();
    if (!knownFolder) return jsonResponse({ success: false, message: '文件夹不存在或索引待刷新' }, 404);
  }

  const filtered = await filterItemsByPermissionD1(env, auth, [...listing.folders, ...listing.files], 'view');
  return {
    ...listing,
    folders: filtered.filter(item => item.itemType === 'folder'),
    files: filtered.filter(item => item.itemType !== 'folder')
  };
}

async function handleListFiles(request, env, path, ctx) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    requireRequiredConfig(env, ['KV_STORE', 'STORAGE', 'D1_DB']);
    const url = new URL(request.url);
    const currentPath = normalizeDirectoryPath(path);
    const listing = await getDirectoryListingForAuth(env, auth, currentPath, {
      forceRefresh: url.searchParams.get('refresh') === '1'
    });
    if (listing instanceof Response) return listing;

    if (currentPath !== '/') {
      await deferBackground(ctx, recordRecentVisit(env, auth, {
        path: currentPath,
        name: nameFromItemPath(currentPath),
        itemType: 'folder',
        sizeFormatted: '',
        previewType: ''
      }));
    }
    const sync = syncJobToClient(await getStorageSyncJob(env, env.STORAGE_ID));
    return jsonResponse({ ...listing, sync });
  } catch (e) {
    return jsonResponse({ success: false, message: '获取文件列表失败: ' + e.message }, 500);
  }
}

async function handleRefreshDirectoryCache(request, env) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    requireRequiredConfig(env, ['KV_STORE', 'STORAGE', 'D1_DB']);
    const body = await request.json().catch(() => ({}));
    const currentPath = normalizeDirectoryPath(body.path || '/');
    const permissionError = await requirePathPermission(env, auth, 'view', currentPath);
    if (permissionError) {
      const virtualListing = await listVirtualPermissionDirectory(env, auth, currentPath);
      if (virtualListing) return jsonResponse(virtualListing);
      return permissionError;
    }

    const job = await enqueueStorageSync(env, env.STORAGE_ID, {
      path: currentPath,
      requestedBy: auth.role === 'admin' ? 'admin' : `user:${auth.email || ''}`
    });
    return jsonResponse({ success: true, sync: syncJobToClient(job) }, 202);
  } catch (e) {
    return jsonResponse({ success: false, message: '刷新缓存失败: ' + e.message }, 500);
  }
}

async function handleUploadFile(request, env, path, ctx) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const destinationPath = normalizeDirectoryPath(path || '/');
    const permissionError = await requirePathPermission(env, auth, 'upload', destinationPath);
    if (permissionError) return permissionError;
    const destination = await getCurrentResourceInfo(env, destinationPath);
    if (!destination || destination.itemType !== 'folder') {
      return jsonResponse({ success: false, message: '目标文件夹不存在' }, 404);
    }

    const formData = await request.formData();
    const file = formData.get('file');

    if (!file) {
      return jsonResponse({ success: false, message: '没有上传文件' }, 400);
    }

    // Normalize path
    let filePath = path || '';
    if (filePath.startsWith('/')) filePath = filePath.slice(1);
    if (filePath && !filePath.endsWith('/')) filePath += '/';

    // Some browsers (notably Chrome's webkitdirectory uploads) put the relative
    // path into the multipart filename, so file.name can be e.g. "util/index.js".
    // Always reduce it to a basename to avoid duplicating the parent prefix.
    const rawName = (file.name || '').replace(/\\/g, '/');
    const baseName = rawName.split('/').filter(Boolean).pop() || '';
    if (!isSafePathSegment(baseName)) {
      return jsonResponse({ success: false, message: '文件名无效' }, 400);
    }

    const key = filePath + baseName;
    const itemPath = r2KeyToPath(key);
    const previous = await getCurrentResourceInfo(env, itemPath);
    if (previous?.itemType === 'folder' || (!previous && await pathHasAnyR2Object(env, itemPath))) {
      return jsonResponse({ success: false, message: '目标名称已存在' }, 409);
    }

    const storedObject = await env.STORAGE.put(key, file.stream(), {
      httpMetadata: { contentType: file.type || getMimeType(baseName) }
    });

    if (previous) await invalidatePathReferences(env, itemPath);

    await upsertSearchFileFromR2Object(env, key, storedObject || { size: file.size, uploaded: new Date() });

    if (ctx && typeof ctx.waitUntil === 'function' && isTxtReaderPath(itemPath) && env.D1_DB) {
      ctx.waitUntil(autoIndexTxtAfterUpload(env, key));
    }

    return jsonResponse({ success: true, message: '文件上传成功', path: '/' + key });
  } catch (e) {
    return jsonResponse({ success: false, message: '文件上传失败: ' + e.message }, 500);
  }
}

async function handleDeleteFile(request, env, path) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const permissionError = await requirePathPermission(env, auth, 'delete', path);
    if (permissionError) return permissionError;

    await deleteItemAtPath(env, path);
    return jsonResponse({ success: true, message: '删除成功' });
  } catch (e) {
    return jsonResponse({ success: false, message: '删除失败: ' + e.message }, 500);
  }
}

async function handleRenameFile(request, env, path) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const sourcePath = normalizeItemPath(path || '');
    if (!sourcePath || sourcePath === '/') {
      return jsonResponse({ success: false, message: '不能重命名根目录' }, 400);
    }
    const permissionError = await requirePathPermission(env, auth, 'modify', sourcePath);
    if (permissionError) return permissionError;

    const body = await request.json();
    const { newName } = body;

    if (!isSafePathSegment(newName)) {
      return jsonResponse({ success: false, message: '请提供新名称' }, 400);
    }

    const parentPath = parentPathFromItemPath(sourcePath);
    const targetPermissionError = await requirePathPermission(env, auth, 'upload', parentPath);
    if (targetPermissionError) return targetPermissionError;
    const parent = await getCurrentResourceInfo(env, parentPath);
    if (!parent || parent.itemType !== 'folder') {
      return jsonResponse({ success: false, message: '目标文件夹不存在' }, 404);
    }

    const targetPath = joinItemPath(parentPath, newName);
    if (targetPath === sourcePath) {
      return jsonResponse({ success: true, message: '重命名成功', newPath: sourcePath });
    }

    const source = await getCurrentResourceInfo(env, sourcePath);
    if (!source) {
      return jsonResponse({ success: false, message: '文件不存在' }, 404);
    }
    if (await pathHasAnyR2Object(env, targetPath)) {
      return jsonResponse({ success: false, message: '目标名称已存在' }, 409);
    }

    const newKey = itemPathToR2Key(targetPath);
    if (source.itemType === 'file') {
      const storedObject = await copyR2Object(env, source.key, newKey);
      if (!storedObject) return jsonResponse({ success: false, message: '文件不存在' }, 404);
      await env.STORAGE.delete(source.key);
      await invalidatePathReferences(env, sourcePath);
      await upsertSearchFileFromR2Object(env, newKey, storedObject);
      return jsonResponse({ success: true, message: '重命名成功', newPath: targetPath });
    }

    const oldPrefix = source.key.replace(/^\/+/, '') + '/';
    const newPrefix = newKey + '/';
    const descendants = await env.D1_DB.prepare(`
      SELECT * FROM search_items
      WHERE storage_id = ? AND item_type = 'file'
        AND substr(path, 1, length(?) + 1) = ? || '/'
      ORDER BY path ASC
    `).bind(env.STORAGE_ID, sourcePath, sourcePath).all();
    const rows = descendants.results || [];

    if (rows.length === 0) {
      const marker = await headR2Object(env, oldPrefix + '.folder');
      if (marker) {
        await copyR2Object(env, marker.key, newPrefix + '.folder');
        await env.STORAGE.delete(marker.key);
      } else {
        await env.STORAGE.put(newPrefix + '.folder', new Uint8Array(0));
      }
      await invalidatePathReferences(env, sourcePath);
      await upsertSearchFolderRow(env, targetPath);
      return jsonResponse({ success: true, message: '重命名成功', newPath: targetPath });
    }

    const taskItems = rows.map(row => {
      const relativePath = row.path.slice(sourcePath.length + 1);
      return {
        sourcePath: row.path,
        sourceKey: row.resource_key,
        targetPath: targetPath + '/' + relativePath,
        targetKey: newPrefix + relativePath,
        size: Number(row.size || 0),
        sourceVersion: row.resource_version || null,
        sourceEtag: row.resource_etag || null
      };
    });
    const taskId = await insertFileTask(env, auth, {
      type: 'rename',
      title: '重命名 ' + nameFromItemPath(sourcePath),
      sourcePath,
      destinationPath: targetPath,
      totalItems: taskItems.length
    });
    await insertTaskItems(env, taskId, taskItems);
    const task = await getTaskForAuth(env, auth, taskId);
    return jsonResponse({ success: true, message: '重命名任务已创建', newPath: targetPath, task: taskRowToClient(task) }, 202);
  } catch (e) {
    return jsonResponse({ success: false, message: '重命名失败: ' + e.message }, 500);
  }
}

function itemPathToR2Key(path) {
  const normalized = normalizeItemPath(path);
  return normalized === '/' ? '' : normalized.slice(1);
}

function r2KeyCandidates(key) {
  const normalized = String(key || '').replace(/^\/+/, '');
  if (!normalized) return [''];
  return [normalized, '/' + normalized];
}

async function headR2Object(env, key) {
  for (const candidate of r2KeyCandidates(key)) {
    const object = await env.STORAGE.head(candidate);
    if (object) return { key: candidate, object };
  }
  return null;
}

async function getR2Object(env, key, options) {
  for (const candidate of r2KeyCandidates(key)) {
    const object = await env.STORAGE.get(candidate, options);
    if (object) return { key: candidate, object };
  }
  return null;
}

const TXT_CHUNK_DEFAULT_BYTES = 128 * 1024;
const TXT_CHUNK_MAX_BYTES = 256 * 1024;
const TXT_SEARCH_CHUNK_BYTES = 64 * 1024;
const TXT_SEARCH_MAX_SCAN_BYTES = 1024 * 1024;
const TXT_SEARCH_MAX_RESULTS = 50;
const TXT_SEARCH_MAX_QUERY_LENGTH = 256;
const TXT_CURSOR_TTL_MS = 15 * 60 * 1000;
const TXT_INDEX_PAGE_BYTES = 64 * 1024;
const TXT_INDEX_OVERLAP_CHARS = TXT_SEARCH_MAX_QUERY_LENGTH;
const TXT_INDEX_CHUNK_PAGE_LIMIT = 100;

function base64UrlEncodeBytes(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index++) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecodeBytes(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}

async function signTxtCursor(payload, secret) {
  const encodedPayload = base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret || ''),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encodedPayload));
  return encodedPayload + '.' + base64UrlEncodeBytes(new Uint8Array(signature));
}

async function verifyTxtCursor(token, secret) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret || ''),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlDecodeBytes(parts[1]),
      new TextEncoder().encode(parts[0])
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecodeBytes(parts[0])));
    if (!payload || payload.v !== 1 || !Number.isFinite(payload.issuedAt)) return null;
    if (Date.now() - payload.issuedAt > TXT_CURSOR_TTL_MS || payload.issuedAt - Date.now() > 60 * 1000) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function normalizeTxtInteger(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) return fallback;
  return number;
}

function parseTxtRange(request, url, size) {
  let offsetValue = url.searchParams.get('offset');
  let lengthValue = url.searchParams.get('length');
  const rangeHeader = request.headers.get('Range');

  if (rangeHeader) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
    if (!match) return { error: 'invalid' };
    offsetValue = match[1];
    if (match[2]) {
      const end = Number(match[2]);
      const start = Number(match[1]);
      if (!Number.isSafeInteger(end) || end < start) return { error: 'invalid' };
      lengthValue = String(end - start + 1);
    } else {
      lengthValue = null;
    }
  }

  const offset = offsetValue === null || offsetValue === ''
    ? 0
    : normalizeTxtInteger(offsetValue, -1);
  const requestedLength = lengthValue === null || lengthValue === '' || lengthValue === undefined
    ? TXT_CHUNK_DEFAULT_BYTES
    : normalizeTxtInteger(lengthValue, -1);
  if (offset < 0 || requestedLength <= 0 || offset >= size || size <= 0) {
    return { error: 'unsatisfiable' };
  }

  return {
    offset,
    length: Math.min(requestedLength, TXT_CHUNK_MAX_BYTES, size - offset)
  };
}

function txtRangeError(size, etag, status = 416) {
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Content-Range': `bytes */${size}`,
    'Content-Length': '0'
  });
  if (etag) headers.set('ETag', etag);
  return new Response(null, { status, headers });
}

async function readR2Bytes(object, maxBytes) {
  if (!object?.body) return new Uint8Array();
  const reader = object.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel('bounded TXT read exceeded limit');
        throw new Error('TXT 读取超过单次限制');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function getBoundedR2Bytes(env, key, offset, length) {
  const object = await env.STORAGE.get(key, { range: { offset, length } });
  if (!object) return null;
  const bytes = await readR2Bytes(object, Math.min(TXT_CHUNK_MAX_BYTES, length));
  return { object, bytes };
}

function detectTxtEncoding(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf-8', byteOffset: 3 };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: 'utf-16le', byteOffset: 2 };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: 'utf-16be', byteOffset: 2 };
  }
  // Legacy Chinese TXT files normally have no BOM. Keep the decoder open at the
  // end of the bounded prefix so a valid UTF-8 character split by the prefix
  // boundary is not mistaken for GB18030.
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
    return { encoding: 'utf-8', byteOffset: 0 };
  } catch {
    try {
      new TextDecoder('gb18030', { fatal: true }).decode(bytes, { stream: true });
      return { encoding: 'gb18030', byteOffset: 0 };
    } catch {
      return { encoding: 'utf-8', byteOffset: 0 };
    }
  }
}

function decodeUtf16BeBytes(bytes) {
  let value = '';
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    value += String.fromCharCode((bytes[index] << 8) | bytes[index + 1]);
  }
  return value;
}

function decodeTxtBytes(bytes, encoding) {
  if (encoding === 'utf-16be') return decodeUtf16BeBytes(bytes);
  try {
    return new TextDecoder(encoding || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function decodeTxtBytesStrict(bytes, encoding) {
  if (encoding === 'utf-16be') {
    if (bytes.length % 2 !== 0) throw new Error('UTF-16BE 字节不完整');
    return decodeUtf16BeBytes(bytes);
  }
  return new TextDecoder(encoding || 'utf-8', { fatal: true }).decode(bytes);
}

function decodeTxtPage(bytes, encoding) {
  const maxTrim = encoding && encoding.startsWith('utf-16') ? 1 : 4;
  for (let trim = 0; trim <= maxTrim && trim < bytes.length; trim++) {
    const usableLength = bytes.length - trim;
    try {
      return {
        text: decodeTxtBytesStrict(bytes.slice(0, usableLength), encoding),
        bytesUsed: usableLength
      };
    } catch {
      // A bounded R2 range can end in the middle of a multibyte character.
    }
  }

  return {
    text: decodeTxtBytes(bytes, encoding),
    bytesUsed: bytes.length
  };
}

function encodeTxtLiteral(value, encoding) {
  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    const bytes = new Uint8Array(value.length * 2);
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (encoding === 'utf-16le') {
        bytes[index * 2] = code & 0xff;
        bytes[index * 2 + 1] = code >>> 8;
      } else {
        bytes[index * 2] = code >>> 8;
        bytes[index * 2 + 1] = code & 0xff;
      }
    }
    return bytes;
  }
  return new TextEncoder().encode(value);
}

function concatTxtBytes(first, second) {
  const result = new Uint8Array(first.length + second.length);
  result.set(first, 0);
  result.set(second, first.length);
  return result;
}

function bytesToBinaryString(bytes) {
  let value = '';
  const partSize = 8192;
  for (let index = 0; index < bytes.length; index += partSize) {
    value += String.fromCharCode(...bytes.subarray(index, Math.min(bytes.length, index + partSize)));
  }
  return value;
}

function currentTxtEtag(object) {
  return object?.httpEtag || (object?.etag ? `"${object.etag.replace(/^"|"$/g, '')}"` : '');
}

async function resolveTxtObject(request, env) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return { error: auth };
  const url = new URL(request.url);
  const filePath = normalizeItemPath(url.searchParams.get('path') || '');
  if (!filePath || filePath === '/' || !isTxtReaderPath(filePath)) {
    return { error: jsonResponse({ success: false, message: '只支持 txt 文件' }, 400) };
  }

  const permissionError = await requirePathPermission(env, auth, 'preview', filePath);
  if (permissionError) return { error: permissionError };

  const current = env.D1_DB
    ? await getIndexedResourceInfoWithInitialSync(env, filePath)
    : await getCurrentResourceInfo(env, filePath);
  if (!current || current.itemType !== 'file' || !current.object || current.object.size === undefined) {
    return { error: jsonResponse({ success: false, message: '文件不存在' }, 404) };
  }
  const resolved = { key: current.key, object: current.object };
  return { auth, filePath, resolved, etag: currentTxtEtag(resolved.object) };
}

async function detectTxtObjectEncoding(env, resolved, size) {
  const prefixLength = Math.min(4096, size);
  const prefix = prefixLength > 0
    ? await getBoundedR2Bytes(env, resolved.key, 0, prefixLength)
    : null;
  return { ...detectTxtEncoding(prefix?.bytes || new Uint8Array()), object: prefix?.object || null };
}

async function reconcileResolvedTxtObject(env, resolved, object) {
  if (!resolved || !object) return resolved;
  const actualEtag = currentTxtEtag(object) || '';
  if (actualEtag && actualEtag !== (resolved.etag || '')) {
    await upsertSearchFileFromR2Object(env, resolved.resolved.key, object);
    resolved.etag = actualEtag;
    resolved.resolved.object = object;
  }
  return resolved;
}

function txtIndexRecordToClient(row, resolved, size, encoding) {
  const sourceEtag = resolved.etag || '';
  const sameSource = !!row
    && row.source_etag === sourceEtag
    && Number(row.size || 0) === Number(size || 0)
    && (!encoding || row.encoding === encoding);
  const status = sameSource ? (row.status || 'building') : 'stale';
  const scannedBytes = sameSource ? Number(row.scanned_bytes || 0) : 0;
  const totalSize = Number(size || 0);
  return {
    status,
    sourceEtag,
    size: totalSize,
    encoding: encoding || row?.encoding || 'utf-8',
    totalChars: sameSource ? Number(row.total_chars || 0) : 0,
    scannedBytes,
    progress: totalSize > 0 ? Math.max(0, Math.min(1, Number(row?.next_offset || 0) / totalSize)) : 1,
    indexedAt: sameSource ? (row.indexed_at || null) : null,
    updatedAt: sameSource ? (row.updated_at || null) : null,
    errorMessage: sameSource ? (row.error_message || '') : ''
  };
}

async function getTxtIndexRecord(env, path) {
  if (!env.D1_DB) return null;
  return env.D1_DB.prepare('SELECT * FROM txt_index_files WHERE storage_id = ? AND path = ?').bind(env.STORAGE_ID, path).first();
}

async function prepareTxtIndexRecord(env, resolved, size, encoding, initialOffset = 0, force = false) {
  const existing = await getTxtIndexRecord(env, resolved.filePath);
  const sourceEtag = resolved.etag || '';
  const sameSource = existing
    && existing.source_etag === sourceEtag
    && Number(existing.size || 0) === size
    && existing.encoding === encoding;
  if (!force && sameSource && existing.status !== 'error') return existing;

  const safeInitialOffset = Math.max(0, Math.min(size, Number(initialOffset || 0)));
  const now = Date.now();
  const initialStatus = size === 0 ? 'ready' : 'building';
  await env.D1_DB.batch([
    env.D1_DB.prepare('DELETE FROM txt_index_chunks WHERE storage_id = ? AND path = ?').bind(env.STORAGE_ID, resolved.filePath),
    env.D1_DB.prepare(`
      INSERT INTO txt_index_files (
        storage_id, path, source_etag, size, encoding, total_chars, status, scanned_bytes,
        next_offset, next_chunk_no, next_char_offset, tail_text, error_message,
        indexed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(storage_id, path) DO UPDATE SET
        source_etag = excluded.source_etag,
        size = excluded.size,
        encoding = excluded.encoding,
        total_chars = excluded.total_chars,
        status = excluded.status,
        scanned_bytes = excluded.scanned_bytes,
        next_offset = excluded.next_offset,
        next_chunk_no = excluded.next_chunk_no,
        next_char_offset = excluded.next_char_offset,
        tail_text = excluded.tail_text,
        error_message = excluded.error_message,
        indexed_at = excluded.indexed_at,
        updated_at = excluded.updated_at
    `).bind(
      env.STORAGE_ID,
      resolved.filePath,
      sourceEtag,
      size,
      encoding,
      0,
      initialStatus,
      0,
      safeInitialOffset,
      0,
      0,
      '',
      null,
      size === 0 ? now : null,
      now
    )
  ]);
  return getTxtIndexRecord(env, resolved.filePath);
}

async function handleTxtIndexStatus(request, env) {
  const resolved = await resolveTxtObject(request, env);
  if (resolved.error) return resolved.error;
  if (!env.D1_DB) {
    return jsonResponse({
      success: true,
      index: { status: 'unavailable', sourceEtag: resolved.etag }
    });
  }

  try {
    let size = Number(resolved.resolved.object.size || 0);
    const detected = await detectTxtObjectEncoding(env, resolved.resolved, size);
    await reconcileResolvedTxtObject(env, resolved, detected.object);
    size = Number(resolved.resolved.object.size || size);
    const row = await getTxtIndexRecord(env, resolved.filePath);
    return jsonResponse({
      success: true,
      path: resolved.filePath,
      index: txtIndexRecordToClient(row, resolved, size, detected.encoding)
    }, 200, { 'Cache-Control': 'private, no-store', 'ETag': resolved.etag });
  } catch (error) {
    return jsonResponse({ success: false, message: '读取 TXT 索引状态失败: ' + error.message }, 500);
  }
}

async function stepTxtIndexBuild(env, resolved, size, encoding, record, initialOffset = 0) {
  const offset = Math.max(0, Math.min(size, Number(record.next_offset || 0)));
  if (offset >= size) {
    const now = Date.now();
    await env.D1_DB.prepare(`
      UPDATE txt_index_files
      SET status = 'ready', indexed_at = ?, updated_at = ?, error_message = NULL
      WHERE storage_id = ? AND path = ? AND source_etag = ?
    `).bind(now, now, env.STORAGE_ID, resolved.filePath, resolved.etag || '').run();
    return { done: true };
  }

  const requestLength = Math.min(TXT_INDEX_PAGE_BYTES, size - offset);
  const bounded = await getBoundedR2Bytes(env, resolved.resolved.key, offset, requestLength);
  if (!bounded || bounded.bytes.length === 0) throw new Error('TXT 索引读取为空');
  const decoded = decodeTxtPage(bounded.bytes, encoding);
  const consumedBytes = Math.max(1, Math.min(bounded.bytes.length, decoded.bytesUsed || bounded.bytes.length));
  const pageText = decoded.text || '';
  const pageCharStart = Number(record.next_char_offset || 0);
  const previousTail = String(record.tail_text || '');
  const contentStart = Math.max(0, pageCharStart - previousTail.length);
  const content = previousTail + pageText;
  const pageCharEnd = pageCharStart + pageText.length;
  const nextOffset = Math.min(size, offset + consumedBytes);
  const nextCharOffset = pageCharEnd;
  const nextChunkNo = Number(record.next_chunk_no || 0) + 1;
  const nextTail = pageText.slice(Math.max(0, pageText.length - TXT_INDEX_OVERLAP_CHARS));
  const done = nextOffset >= size;
  const now = Date.now();

  await env.D1_DB.batch([
    env.D1_DB.prepare(`
      INSERT INTO txt_index_chunks (
        storage_id, path, source_etag, chunk_no, byte_start, byte_end, char_start,
        char_end, content_start, content
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(storage_id, path, chunk_no) DO UPDATE SET
        source_etag = excluded.source_etag,
        byte_start = excluded.byte_start,
        byte_end = excluded.byte_end,
        char_start = excluded.char_start,
        char_end = excluded.char_end,
        content_start = excluded.content_start,
        content = excluded.content
    `).bind(
      env.STORAGE_ID,
      resolved.filePath,
      resolved.etag || '',
      Number(record.next_chunk_no || 0),
      offset,
      nextOffset,
      pageCharStart,
      pageCharEnd,
      contentStart,
      content
    ),
    env.D1_DB.prepare(`
      UPDATE txt_index_files
      SET status = ?, scanned_bytes = ?, next_offset = ?, next_chunk_no = ?,
          next_char_offset = ?, total_chars = ?, tail_text = ?,
          error_message = NULL, indexed_at = ?, updated_at = ?
      WHERE storage_id = ? AND path = ? AND source_etag = ?
    `).bind(
      done ? 'ready' : 'building',
      Math.max(0, nextOffset - Math.min(Number(initialOffset || 0), size)),
      nextOffset,
      nextChunkNo,
      nextCharOffset,
      done ? nextCharOffset : 0,
      nextTail,
      done ? now : null,
      now,
      env.STORAGE_ID,
      resolved.filePath,
      resolved.etag || ''
    )
  ]);

  return { done };
}

async function markTxtIndexError(env, filePath, etag, error) {
  if (!env.D1_DB) return;
  await env.D1_DB.prepare(`
    UPDATE txt_index_files
    SET status = 'error', error_message = ?, updated_at = ?
    WHERE storage_id = ? AND path = ? AND source_etag = ?
  `).bind(
    String(error?.message || 'TXT 索引构建失败').slice(0, 500),
    Date.now(),
    env.STORAGE_ID,
    filePath,
    etag || ''
  ).run().catch(() => {});
}

/**
 * Upload hook: initialize a resumable TXT index record without reading the
 * whole object in one invocation. Scheduled maintenance advances it later.
 */
async function autoIndexTxtAfterUpload(env, key) {
  try {
    if (!env.D1_DB || !env.STORAGE) return;
    const filePath = r2KeyToPath(key);
    if (!isTxtReaderPath(filePath)) return;
    const head = await headR2Object(env, key);
    if (!head?.object) return;
    const resolved = {
      filePath,
      resolved: { key: head.key, object: head.object },
      etag: currentTxtEtag(head.object)
    };
    const size = Number(head.object.size || 0);
    const detected = await detectTxtObjectEncoding(env, resolved.resolved, size);
    await prepareTxtIndexRecord(env, resolved, size, detected.encoding, detected.byteOffset);
  } catch (error) {
    console.warn('TXT auto index initialization failed:', error.message);
  }
}
async function processPendingTxtIndexes(rootEnv, budget = 10) {
  const pending = await rootEnv.D1_DB.prepare(`
    SELECT storage_id, path, source_etag, size, encoding
    FROM txt_index_files
    WHERE status = 'building'
    ORDER BY updated_at ASC
    LIMIT ?
  `).bind(Math.min(10, Math.max(1, Number(budget) || 10))).all();
  let processed = 0;
  for (const row of pending.results || []) {
    let env = rootEnv;
    try {
      const url = new URL('https://scheduled.invalid/');
      url.searchParams.set('storageId', row.storage_id);
      env = (await createStorageRuntime(new Request(url), rootEnv, { role: 'admin' })).env;
      const current = await getIndexedResourceInfo(env, row.path);
      if (!current || current.itemType !== 'file') throw new Error('TXT 文件已不存在');
      const record = await getTxtIndexRecord(env, row.path);
      if (!record || record.status !== 'building') continue;
      const resolved = {
        filePath: row.path,
        resolved: { key: current.key, object: current.object },
        etag: row.source_etag
      };
      await stepTxtIndexBuild(env, resolved, Number(row.size || 0), row.encoding || 'utf-8', record, 0);
      processed++;
    } catch (error) {
      await markTxtIndexError(env, row.path, row.source_etag, error);
    }
  }
  return { processed };
}


async function handleTxtIndexBuild(request, env) {
  const resolved = await resolveTxtObject(request, env);
  if (resolved.error) return resolved.error;
  if (!env.D1_DB) {
    return jsonResponse({ success: false, code: 'TXT_INDEX_UNAVAILABLE', message: 'D1 未配置，无法建立 TXT 索引' }, 503);
  }

  let record = null;
  try {
    const url = new URL(request.url);
    let size = Number(resolved.resolved.object.size || 0);
    const detected = await detectTxtObjectEncoding(env, resolved.resolved, size);
    await reconcileResolvedTxtObject(env, resolved, detected.object);
    size = Number(resolved.resolved.object.size || size);
    const force = ['1', 'true', 'yes'].includes((url.searchParams.get('force') || '').toLowerCase());
    record = await prepareTxtIndexRecord(
      env,
      resolved,
      size,
      detected.encoding,
      detected.byteOffset,
      force
    );
    if (!record) throw new Error('TXT 索引记录创建失败');

    if (record.status !== 'ready') {
      await stepTxtIndexBuild(env, resolved, size, detected.encoding, record, detected.byteOffset);
      record = await getTxtIndexRecord(env, resolved.filePath);
    }
    return jsonResponse({
      success: true,
      path: resolved.filePath,
      done: record.status === 'ready',
      index: txtIndexRecordToClient(record, resolved, size, detected.encoding)
    }, 200, { 'Cache-Control': 'private, no-store', 'ETag': resolved.etag });
  } catch (error) {
    if (record) await markTxtIndexError(env, resolved.filePath, resolved.etag, error);
    return jsonResponse({ success: false, message: '建立 TXT 索引失败: ' + error.message }, 500);
  }
}

async function handleTxtMeta(request, env) {
  const resolved = await resolveTxtObject(request, env);
  if (resolved.error) return resolved.error;

  try {
    let size = Number(resolved.resolved.object.size || 0);
    const detected = await detectTxtObjectEncoding(env, resolved.resolved, size);
    await reconcileResolvedTxtObject(env, resolved, detected.object);
    size = Number(resolved.resolved.object.size || size);
    const index = env.D1_DB
      ? txtIndexRecordToClient(await getTxtIndexRecord(env, resolved.filePath), resolved, size, detected.encoding)
      : { status: 'unavailable', sourceEtag: resolved.etag };
    return jsonResponse({
      success: true,
      path: resolved.filePath,
      size,
      etag: resolved.etag,
      sourceEtag: resolved.etag,
      byteOffset: Math.min(detected.byteOffset, size),
      encoding: detected.encoding,
      chunkSize: TXT_CHUNK_DEFAULT_BYTES,
      index
    }, 200, {
      'Cache-Control': 'private, no-store',
      'ETag': resolved.etag
    });
  } catch (error) {
    return jsonResponse({ success: false, message: '读取 TXT 元数据失败: ' + error.message }, 500);
  }
}

function txtIndexedChunkToClient(row, cached) {
  const content = String(row.content || '');
  const contentStart = Number(row.content_start || 0);
  const charStart = Number(row.char_start || 0);
  const localStart = Math.max(0, charStart - contentStart);
  return {
    chunkNo: Number(row.chunk_no || 0),
    byteStart: Number(row.byte_start || 0),
    byteEnd: Number(row.byte_end || 0),
    charStart,
    charEnd: Number(row.char_end || charStart),
    cached: !!cached,
    text: cached ? undefined : content.slice(localStart)
  };
}

async function handleTxtOpen(request, env, ctx) {
  const resolved = await resolveTxtObject(request, env);
  if (resolved.error) return resolved.error;

  try {
    const url = new URL(request.url);
    const size = Number(resolved.resolved.object.size || 0);
    const indexRecord = await getTxtIndexRecord(env, resolved.filePath);
    const indexMatches = !!indexRecord
      && indexRecord.source_etag === resolved.etag
      && Number(indexRecord.size || 0) === size;
    const cachedEtag = url.searchParams.get('cachedEtag') || '';
    const cachedEncodingValue = url.searchParams.get('cachedEncoding') || '';
    const cachedEncoding = cachedEtag === resolved.etag
      && ['utf-8', 'utf-16le', 'utf-16be', 'gb18030'].includes(cachedEncodingValue)
      ? cachedEncodingValue
      : '';
    let encoding = indexMatches ? indexRecord.encoding : cachedEncoding;
    let initialByteOffset = 0;
    if (!encoding) {
      const detected = await detectTxtObjectEncoding(env, resolved.resolved, size);
      await reconcileResolvedTxtObject(env, resolved, detected.object);
      encoding = detected.encoding;
      initialByteOffset = detected.byteOffset;
    } else if (encoding === 'utf-8' && size >= 3) {
      initialByteOffset = 0;
    } else if (encoding.startsWith('utf-16') && size >= 2) {
      initialByteOffset = 0;
    }

    const progress = await loadReaderProgressForAuth(
      env,
      resolved.auth,
      resolved.filePath,
      resolved.etag,
      ctx
    );
    const requestedByteValue = url.searchParams.get('byteOffset');
    const requestedCharValue = url.searchParams.get('charOffset');
    const requestedByteOffset = requestedByteValue === null ? NaN : Number(requestedByteValue);
    const requestedCharOffset = requestedCharValue === null ? NaN : Number(requestedCharValue);
    const hasRequestedPosition = requestedByteValue !== null
      && Number.isFinite(requestedByteOffset)
      && requestedByteOffset >= 0
      && requestedByteOffset < size;
    const safeProgressByte = Number(progress?.byteOffset);
    const targetByteOffset = hasRequestedPosition
      ? Math.floor(requestedByteOffset)
      : Number.isFinite(safeProgressByte) && safeProgressByte >= 0 && safeProgressByte < size
        ? Math.floor(safeProgressByte)
        : Math.min(initialByteOffset, size);
    const targetAnchorByteOffset = hasRequestedPosition
      ? targetByteOffset
      : Number.isFinite(Number(progress?.anchorByteOffset))
        ? Number(progress.anchorByteOffset)
        : targetByteOffset;
    const targetCharOffset = requestedCharValue !== null && Number.isFinite(requestedCharOffset)
      ? Math.max(0, Math.floor(requestedCharOffset))
      : Number(progress?.anchorCharOffset || progress?.charOffset || 0);

    const cachedStarts = cachedEtag === resolved.etag
      ? new Set((url.searchParams.get('cached') || '').split(',')
        .map(value => Number(value))
        .filter(value => Number.isSafeInteger(value) && value >= 0)
        .slice(0, 16))
      : new Set();
    let chunks = [];
    let windowSource = 'r2';

    if (indexMatches && indexRecord.status === 'ready' && size > 0) {
      const center = await env.D1_DB.prepare(`
        SELECT chunk_no FROM txt_index_chunks
        WHERE storage_id = ? AND path = ? AND source_etag = ?
          AND byte_start <= ? AND byte_end > ?
        ORDER BY chunk_no DESC
        LIMIT 1
      `).bind(
        env.STORAGE_ID,
        resolved.filePath,
        resolved.etag,
        targetAnchorByteOffset,
        targetAnchorByteOffset
      ).first();
      let resolvedCenter = center;
      if (!resolvedCenter) {
        const firstChunk = await env.D1_DB.prepare(`
          SELECT chunk_no, byte_start FROM txt_index_chunks
          WHERE storage_id = ? AND path = ? AND source_etag = ?
          ORDER BY chunk_no ASC
          LIMIT 1
        `).bind(env.STORAGE_ID, resolved.filePath, resolved.etag).first();
        if (firstChunk && targetAnchorByteOffset <= Number(firstChunk.byte_start || 0)) {
          resolvedCenter = firstChunk;
        }
      }
      if (resolvedCenter) {
        const centerChunk = Number(resolvedCenter.chunk_no || 0);
        const rows = await env.D1_DB.prepare(`
          SELECT * FROM txt_index_chunks
          WHERE storage_id = ? AND path = ? AND source_etag = ?
            AND chunk_no BETWEEN ? AND ?
          ORDER BY chunk_no ASC
          LIMIT 4
        `).bind(
          env.STORAGE_ID,
          resolved.filePath,
          resolved.etag,
          Math.max(0, centerChunk - 1),
          centerChunk + 2
        ).all();
        chunks = (rows.results || []).map(row => txtIndexedChunkToClient(
          row,
          cachedStarts.has(Number(row.byte_start || 0))
        ));
        if (chunks.length > 0) windowSource = 'd1';
      }
    }

    if (chunks.length === 0 && size > 0) {
      const start = Math.max(0, Math.min(size - 1, targetByteOffset));
      const cached = cachedStarts.has(start);
      let text;
      let byteEnd = Math.min(size, start + TXT_CHUNK_DEFAULT_BYTES);
      if (!cached) {
        const bounded = await getBoundedR2Bytes(
          env,
          resolved.resolved.key,
          start,
          Math.min(TXT_CHUNK_DEFAULT_BYTES, size - start)
        );
        if (!bounded || bounded.bytes.length === 0) throw new Error('TXT 打开分片为空');
        const decoded = decodeTxtPage(bounded.bytes, encoding);
        text = decoded.text || '';
        byteEnd = start + Math.max(1, Math.min(bounded.bytes.length, decoded.bytesUsed || bounded.bytes.length));
      }
      chunks = [{
        chunkNo: null,
        byteStart: start,
        byteEnd,
        charStart: hasRequestedPosition
          ? Math.max(0, Math.floor(requestedCharOffset || 0))
          : Number(progress?.charOffset || 0),
        charEnd: null,
        cached,
        text
      }];
    }

    return jsonResponse({
      success: true,
      path: resolved.filePath,
      meta: {
        path: resolved.filePath,
        size,
        etag: resolved.etag,
        sourceEtag: resolved.etag,
        byteOffset: Math.min(initialByteOffset, size),
        encoding,
        chunkSize: TXT_CHUNK_DEFAULT_BYTES,
        index: txtIndexRecordToClient(indexRecord, resolved, size, encoding)
      },
      progress: progress || null,
      target: {
        byteOffset: targetByteOffset,
        anchorByteOffset: targetAnchorByteOffset,
        charOffset: targetCharOffset
      },
      windowSource,
      chunks
    }, 200, { 'Cache-Control': 'private, no-store', 'ETag': resolved.etag });
  } catch (error) {
    return jsonResponse({ success: false, message: '打开 TXT 失败: ' + error.message }, 500);
  }
}

async function handleTxtChunk(request, env) {
  const resolved = await resolveTxtObject(request, env);
  if (resolved.error) return resolved.error;

  try {
    const size = Number(resolved.resolved.object.size || 0);
    const requestedEtag = request.headers.get('If-Match') || new URL(request.url).searchParams.get('etag');
    if (requestedEtag && requestedEtag !== resolved.etag) {
      return jsonResponse({ success: false, message: '文件已变化，请重新加载' }, 412, { ETag: resolved.etag });
    }
    const range = parseTxtRange(request, new URL(request.url), size);
    if (range.error) return txtRangeError(size, resolved.etag);

    const bounded = await getBoundedR2Bytes(env, resolved.resolved.key, range.offset, range.length);
    if (!bounded) {
      return jsonResponse({ success: false, message: '文件不存在' }, 404);
    }
    const actualEtag = currentTxtEtag(bounded.object) || '';
    if (resolved.etag && actualEtag && actualEtag !== resolved.etag) {
      await upsertSearchFileFromR2Object(env, resolved.resolved.key, bounded.object);
      return jsonResponse({ success: false, message: '文件已变化，请重新加载' }, 412, { ETag: actualEtag });
    }
    const actualLength = bounded.bytes.length;
    if (actualLength === 0) return txtRangeError(size, resolved.etag);
    const end = range.offset + actualLength - 1;
    const headers = new Headers({
      'Content-Type': resolved.resolved.object.httpMetadata?.contentType || 'text/plain; charset=utf-8',
      'Content-Disposition': createInlineDisposition(nameFromItemPath(resolved.filePath)),
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${range.offset}-${end}/${size}`,
      'Content-Length': String(actualLength),
      'Cache-Control': 'private, no-store'
    });
    if (resolved.etag) headers.set('ETag', resolved.etag);
    return new Response(bounded.bytes, { status: 206, headers });
  } catch (error) {
    return jsonResponse({ success: false, message: '读取 TXT 分片失败: ' + error.message }, 500);
  }
}

async function handleTxtSearchRaw(request, env, resolved) {
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get('q') || '';
    if (!query || query.length > TXT_SEARCH_MAX_QUERY_LENGTH) {
      return jsonResponse({ success: false, message: '搜索词不能为空且不能超过 256 个字符' }, 400);
    }

    const size = Number(resolved.resolved.object.size || 0);
    const detected = await detectTxtObjectEncoding(env, resolved.resolved, size);
    const patternBytes = encodeTxtLiteral(query, detected.encoding);
    if (patternBytes.length === 0 || patternBytes.length > TXT_SEARCH_MAX_SCAN_BYTES) {
      return jsonResponse({ success: false, message: '搜索词无效' }, 400);
    }

    const requestedOffset = url.searchParams.get('offset') ?? url.searchParams.get('byteOffset');
    let offset = requestedOffset === null || requestedOffset === ''
      ? 0
      : normalizeTxtInteger(requestedOffset, -1);
    if (offset < 0) {
      return jsonResponse({ success: false, message: '搜索偏移无效' }, 416, { 'Content-Range': `bytes */${size}` });
    }
    const cursorToken = url.searchParams.get('cursor');
    if (cursorToken) {
      const cursor = await verifyTxtCursor(cursorToken, env.ADMIN_PASSWORD);
      if (!cursor || cursor.path !== resolved.filePath || cursor.query !== query || cursor.etag !== resolved.etag) {
        return jsonResponse({ success: false, message: '搜索游标已失效，请重新搜索' }, 400);
      }
      if (requestedOffset !== null && requestedOffset !== '' && offset !== cursor.offset) {
        return jsonResponse({ success: false, message: '搜索游标与偏移不匹配' }, 400);
      }
      offset = normalizeTxtInteger(cursor.offset, -1);
      if (offset < 0) return jsonResponse({ success: false, message: '搜索游标无效' }, 400);
    }
    if (offset > size) return jsonResponse({ success: false, message: '搜索偏移无效' }, 416, { 'Content-Range': `bytes */${size}` });

    const requestedLimit = Number(url.searchParams.get('limit') || TXT_SEARCH_MAX_RESULTS);
    const limit = Number.isSafeInteger(requestedLimit)
      ? Math.min(TXT_SEARCH_MAX_RESULTS, Math.max(1, requestedLimit))
      : TXT_SEARCH_MAX_RESULTS;
    const pattern = bytesToBinaryString(patternBytes);
    const overlapLength = Math.max(0, patternBytes.length - 1);
    const results = [];
    const emittedOffsets = new Set();
    let carry = new Uint8Array();
    let position = offset;
    let scannedBytes = 0;
    let reachedResultLimit = false;

    while (position < size && scannedBytes < TXT_SEARCH_MAX_SCAN_BYTES) {
      const requestLength = Math.min(TXT_SEARCH_CHUNK_BYTES, size - position, TXT_SEARCH_MAX_SCAN_BYTES - scannedBytes);
      const bounded = await getBoundedR2Bytes(env, resolved.resolved.key, position, requestLength);
      if (!bounded || bounded.bytes.length === 0) break;

      const combined = concatTxtBytes(carry, bounded.bytes);
      const baseOffset = position - carry.length;
      const binary = bytesToBinaryString(combined);
      let searchFrom = 0;
      while (true) {
        const matchIndex = binary.indexOf(pattern, searchFrom);
        if (matchIndex < 0) break;
        const byteOffset = baseOffset + matchIndex;
        const startsOnTextBoundary = byteOffset >= detected.byteOffset
          && (!detected.encoding.startsWith('utf-16')
            || (byteOffset - detected.byteOffset) % 2 === 0);
        if (startsOnTextBoundary && byteOffset >= offset && byteOffset < size && !emittedOffsets.has(byteOffset)) {
          emittedOffsets.add(byteOffset);
          const beforeStart = Math.max(0, matchIndex - 96);
          const afterEnd = Math.min(combined.length, matchIndex + patternBytes.length + 160);
          results.push({
            byteOffset,
            etag: resolved.etag,
            snippetBefore: decodeTxtBytes(combined.slice(beforeStart, matchIndex), detected.encoding),
            match: decodeTxtBytes(combined.slice(matchIndex, matchIndex + patternBytes.length), detected.encoding),
            snippetAfter: decodeTxtBytes(combined.slice(matchIndex + patternBytes.length, afterEnd), detected.encoding)
          });
          if (results.length >= limit) {
            reachedResultLimit = true;
            break;
          }
        }
        searchFrom = matchIndex + 1;
      }
      scannedBytes += bounded.bytes.length;
      position += bounded.bytes.length;
      if (reachedResultLimit) break;
      carry = overlapLength > 0
        ? combined.slice(Math.max(0, combined.length - overlapLength))
        : new Uint8Array();
      if (bounded.bytes.length < requestLength) break;
    }

    let nextOffset = null;
    if (reachedResultLimit && results.length > 0) {
      nextOffset = results[results.length - 1].byteOffset + 1;
    } else if (position < size) {
      nextOffset = Math.max(offset + 1, position - overlapLength);
    }

    const response = {
      success: true,
      path: resolved.filePath,
      query,
      etag: resolved.etag,
      results,
      limit,
      offset,
      scannedBytes,
      hasMore: Number.isSafeInteger(nextOffset) && nextOffset < size
    };
    if (response.hasMore) {
      response.nextCursor = await signTxtCursor({
        v: 1,
        path: resolved.filePath,
        query,
        etag: resolved.etag,
        offset: nextOffset,
        issuedAt: Date.now()
      }, env.ADMIN_PASSWORD);
    } else {
      response.nextCursor = null;
    }
    return jsonResponse(response, 200, { 'Cache-Control': 'private, no-store', 'ETag': resolved.etag });
  } catch (error) {
    return jsonResponse({ success: false, message: 'TXT 搜索失败: ' + error.message }, 500);
  }
}

/**
 * Search the content index of a single txt file. Scans at most one page of
 * TXT_INDEX_CHUNK_PAGE_LIMIT chunk rows; when the page is full a
 * nextCursorPayload is returned so callers can continue from the next chunk.
 */
async function searchTxtIndexForPath(env, filePath, sourceEtag, query, limit, startChunk = 0, minimumCharOffset = 0, totalChars = 0) {
  const likePattern = '%' + escapeLike(query) + '%';
  const rows = await env.D1_DB.prepare(`
    SELECT * FROM txt_index_chunks
    WHERE storage_id = ? AND path = ? AND source_etag = ? AND chunk_no >= ?
      AND content LIKE ? ESCAPE '\\'
    ORDER BY chunk_no ASC
    LIMIT ?
  `).bind(
    env.STORAGE_ID,
    filePath,
    sourceEtag,
    startChunk,
    likePattern,
    TXT_INDEX_CHUNK_PAGE_LIMIT
  ).all();

  const results = [];
  const emittedOffsets = new Set();
  let lastChunkNo = null;
  let nextCursorPayload = null;

  for (const row of rows.results || []) {
    lastChunkNo = Number(row.chunk_no || 0);
    const content = String(row.content || '');
    const contentStart = Number(row.content_start || 0);
    const pageStart = Number(row.char_start || 0);
    const pageEnd = Number(row.char_end || pageStart);
    let matchIndex = 0;
    while (matchIndex <= content.length - query.length) {
      const foundAt = content.indexOf(query, matchIndex);
      if (foundAt < 0) break;
      const charOffset = contentStart + foundAt;
      const crossesPageStart = charOffset < pageStart && charOffset + query.length > pageStart;
      const isOwnedByPage = charOffset >= pageStart;
      const isWithinPage = charOffset < pageEnd;
      if ((isOwnedByPage || crossesPageStart)
        && isWithinPage
        && charOffset >= minimumCharOffset
        && !emittedOffsets.has(charOffset)) {
        emittedOffsets.add(charOffset);
        let directByteOffset = Number(row.byte_start || 0);
        let directCharOffset = pageStart;
        if (crossesPageStart && Number(row.chunk_no || 0) > 0) {
          const previous = await env.D1_DB.prepare(`
            SELECT byte_start, char_start
            FROM txt_index_chunks
            WHERE storage_id = ? AND path = ? AND source_etag = ? AND chunk_no = ?
            LIMIT 1
          `).bind(env.STORAGE_ID, filePath, sourceEtag, Number(row.chunk_no) - 1).first();
          if (previous) {
            directByteOffset = Number(previous.byte_start || 0);
            directCharOffset = Number(previous.char_start || 0);
          }
        }
        const beforeStart = Math.max(0, foundAt - 96);
        const afterEnd = Math.min(content.length, foundAt + query.length + 160);
        const progress = totalChars > 0 ? Math.max(0, Math.min(1, charOffset / totalChars)) : 0;
        results.push({
          charOffset,
          matchLength: query.length,
          byteOffset: Number(row.byte_start || 0),
          byteOffsetApproximate: true,
          chunkByteOffset: directByteOffset,
          chunkCharOffset: directCharOffset,
          progress,
          progressPercent: Number((progress * 100).toFixed(2)),
          etag: sourceEtag,
          snippetBefore: content.slice(beforeStart, foundAt),
          match: content.slice(foundAt, foundAt + query.length),
          snippetAfter: content.slice(foundAt + query.length, afterEnd)
        });
        if (results.length >= limit) {
          nextCursorPayload = {
            chunkNo: lastChunkNo,
            charOffset: charOffset + 1
          };
          break;
        }
      }
      matchIndex = foundAt + 1;
    }
    if (nextCursorPayload) break;
  }

  if (!nextCursorPayload && rows.results && rows.results.length >= TXT_INDEX_CHUNK_PAGE_LIMIT && lastChunkNo !== null) {
    nextCursorPayload = {
      chunkNo: lastChunkNo + 1,
      charOffset: minimumCharOffset
    };
  }

  return { results, nextCursorPayload, scannedChunks: (rows.results || []).length };
}

async function handleTxtIndexedSearch(request, env, resolved, record) {
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get('q') || '';
    if (!query || query.length > TXT_SEARCH_MAX_QUERY_LENGTH) {
      return jsonResponse({ success: false, message: '搜索词不能为空且不能超过 256 个字符' }, 400);
    }

    const sourceEtag = resolved.etag || '';
    const totalChars = Number(record.total_chars || 0);
    const requestedLimit = Number(url.searchParams.get('limit') || TXT_SEARCH_MAX_RESULTS);
    const limit = Number.isSafeInteger(requestedLimit)
      ? Math.min(TXT_SEARCH_MAX_RESULTS, Math.max(1, requestedLimit))
      : TXT_SEARCH_MAX_RESULTS;
    let startChunk = 0;
    let minimumCharOffset = 0;
    const cursorToken = url.searchParams.get('cursor');
    if (cursorToken) {
      const cursor = await verifyTxtCursor(cursorToken, env.ADMIN_PASSWORD);
      if (!cursor
        || cursor.kind !== 'txt-index-search'
        || cursor.path !== resolved.filePath
        || cursor.query !== query
        || cursor.etag !== resolved.etag) {
        return jsonResponse({ success: false, message: '搜索游标已失效，请重新搜索' }, 400);
      }
      startChunk = normalizeTxtInteger(cursor.chunkNo, -1);
      minimumCharOffset = normalizeTxtInteger(cursor.charOffset, -1);
      if (startChunk < 0 || minimumCharOffset < 0) {
        return jsonResponse({ success: false, message: '搜索游标无效' }, 400);
      }
    }

    const { results, nextCursorPayload } = await searchTxtIndexForPath(
      env,
      resolved.filePath,
      sourceEtag,
      query,
      limit,
      startChunk,
      minimumCharOffset,
      totalChars
    );

    const response = {
      success: true,
      indexed: true,
      path: resolved.filePath,
      query,
      etag: resolved.etag,
      totalChars,
      results,
      limit,
      hasMore: !!nextCursorPayload,
      nextCursor: null
    };
    if (nextCursorPayload) {
      response.nextCursor = await signTxtCursor({
        v: 1,
        kind: 'txt-index-search',
        path: resolved.filePath,
        query,
        etag: resolved.etag,
        chunkNo: nextCursorPayload.chunkNo,
        charOffset: nextCursorPayload.charOffset,
        issuedAt: Date.now()
      }, env.ADMIN_PASSWORD);
    }
    return jsonResponse(response, 200, { 'Cache-Control': 'private, no-store', 'ETag': resolved.etag });
  } catch (error) {
    return jsonResponse({ success: false, message: 'TXT 索引搜索失败: ' + error.message }, 500);
  }
}

async function handleTxtSearch(request, env) {
  const resolved = await resolveTxtObject(request, env);
  if (resolved.error) return resolved.error;

  if (!env.D1_DB) return handleTxtSearchRaw(request, env, resolved);

  try {
    const size = Number(resolved.resolved.object.size || 0);
    const record = await getTxtIndexRecord(env, resolved.filePath);
    const sameStoredSource = record
      && record.source_etag === (resolved.etag || '')
      && Number(record.size || 0) === size;
    const detected = sameStoredSource
      ? { encoding: record.encoding, byteOffset: 0 }
      : await detectTxtObjectEncoding(env, resolved.resolved, size);
    const sameSource = record
      && record.source_etag === (resolved.etag || '')
      && Number(record.size || 0) === size
      && record.encoding === detected.encoding;
    if (sameSource && record.status === 'ready') {
      return handleTxtIndexedSearch(request, env, resolved, record);
    }
    return jsonResponse({
      success: false,
      code: 'TXT_INDEX_NOT_READY',
      message: '请先建立 TXT 正文索引',
      index: txtIndexRecordToClient(record, resolved, size, detected.encoding)
    }, 409, { 'Cache-Control': 'private, no-store', 'ETag': resolved.etag });
  } catch (error) {
    return jsonResponse({ success: false, message: 'TXT 搜索失败: ' + error.message }, 500);
  }
}

const TXT_GLOBAL_SEARCH_MAX_RESULTS = 50;
const TXT_GLOBAL_SEARCH_MAX_BOOKS_PER_REQUEST = 60;
const TXT_GLOBAL_SEARCH_MAX_CHUNKS_PER_REQUEST = 4000;
const TXT_GLOBAL_SEARCH_MAX_CANDIDATE_BOOKS = 500;

/**
 * Global full-text search across every indexed .txt book. Books are searched
 * one at a time (in path order) with early termination, bounded by a scan
 * budget so a query that matches nothing cannot run away. The HMAC cursor
 * resumes at the exact book/chunk where the previous page stopped.
 */
async function handleTxtGlobalSearch(request, env) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  if (!env.D1_DB) {
    return jsonResponse({ success: false, code: 'TXT_INDEX_UNAVAILABLE', message: 'D1 未配置，无法搜索 TXT 正文' }, 503);
  }

  try {
    const url = new URL(request.url);
    const query = url.searchParams.get('q') || '';
    if (!query || query.length > TXT_SEARCH_MAX_QUERY_LENGTH) {
      return jsonResponse({ success: false, message: '搜索词不能为空且不能超过 256 个字符' }, 400);
    }
    const requestedLimit = Number(url.searchParams.get('limit') || 20);
    const limit = Number.isSafeInteger(requestedLimit)
      ? Math.min(TXT_GLOBAL_SEARCH_MAX_RESULTS, Math.max(1, requestedLimit))
      : 20;

    let startPath = '';
    let startChunk = 0;
    let startCharOffset = 0;
    const cursorToken = url.searchParams.get('cursor');
    if (cursorToken) {
      const cursor = await verifyTxtCursor(cursorToken, env.ADMIN_PASSWORD);
      if (!cursor || cursor.kind !== 'txt-global-search' || cursor.query !== query || cursor.storageId !== env.STORAGE_ID) {
        return jsonResponse({ success: false, message: '搜索游标已失效，请重新搜索' }, 400);
      }
      startPath = typeof cursor.lastPath === 'string' ? cursor.lastPath : '';
      // chunkNo === -1 marks the resume book as already fully scanned.
      startChunk = Number.isSafeInteger(Number(cursor.chunkNo)) ? Number(cursor.chunkNo) : 0;
      startCharOffset = normalizeTxtInteger(cursor.charOffset, 0);
    }

    const booksResult = await env.D1_DB.prepare(`
      SELECT path, source_etag, total_chars
      FROM txt_index_files
      WHERE storage_id = ? AND status = 'ready' AND path >= ?
      ORDER BY path ASC
      LIMIT ?
    `).bind(env.STORAGE_ID, startPath, TXT_GLOBAL_SEARCH_MAX_CANDIDATE_BOOKS).all();

    const bookRows = booksResult.results || [];
    const allowedBooks = await filterItemsByPermissionD1(
      env,
      auth,
      bookRows.map(row => ({ path: row.path, itemType: 'file' })),
      'preview'
    );
    const allowedPaths = new Set(allowedBooks.map(item => item.path));
    const candidates = bookRows.filter(row => allowedPaths.has(row.path));

    const results = [];
    let scannedBooks = 0;
    let scannedChunks = 0;
    let nextCursorPayload = null;

    for (const book of candidates) {
      if (scannedBooks >= TXT_GLOBAL_SEARCH_MAX_BOOKS_PER_REQUEST
        || scannedChunks >= TXT_GLOBAL_SEARCH_MAX_CHUNKS_PER_REQUEST) {
        nextCursorPayload = { lastPath: book.path, chunkNo: 0, charOffset: 0 };
        break;
      }

      const isResumeBook = !!cursorToken && book.path === startPath;
      if (isResumeBook && startChunk < 0) continue; // book fully scanned on the previous page

      scannedBooks++;
      let chunkCursor = isResumeBook ? startChunk : 0;
      let minCharOffset = isResumeBook ? startCharOffset : 0;

      for (;;) {
        const page = await searchTxtIndexForPath(
          env,
          book.path,
          book.source_etag,
          query,
          limit - results.length,
          chunkCursor,
          minCharOffset,
          Number(book.total_chars || 0)
        );
        scannedChunks += page.scannedChunks;
        for (const match of page.results) {
          results.push({
            ...match,
            path: book.path,
            name: nameFromItemPath(book.path)
          });
        }

        if (results.length >= limit && page.nextCursorPayload) {
          nextCursorPayload = { lastPath: book.path, ...page.nextCursorPayload };
          break;
        }
        if (!page.nextCursorPayload) break;

        chunkCursor = page.nextCursorPayload.chunkNo;
        minCharOffset = page.nextCursorPayload.charOffset;
        if (scannedChunks >= TXT_GLOBAL_SEARCH_MAX_CHUNKS_PER_REQUEST) {
          nextCursorPayload = { lastPath: book.path, chunkNo: chunkCursor, charOffset: minCharOffset };
          break;
        }
      }

      if (nextCursorPayload) break;
    }

    // Candidate window was full but fully scanned: continue past the last book
    // (a follow-up page simply comes back empty if no books remain).
    if (!nextCursorPayload && bookRows.length >= TXT_GLOBAL_SEARCH_MAX_CANDIDATE_BOOKS) {
      nextCursorPayload = { lastPath: bookRows[bookRows.length - 1].path, chunkNo: -1, charOffset: 0 };
    }

    const response = {
      storageId: env.STORAGE_ID,
      success: true,
      query,
      results,
      limit,
      scannedBooks,
      scannedChunks,
      hasMore: !!nextCursorPayload,
      nextCursor: null
    };
    if (nextCursorPayload) {
      response.nextCursor = await signTxtCursor({
        v: 1,
        kind: 'txt-global-search',
        storageId: env.STORAGE_ID,
        query,
        lastPath: nextCursorPayload.lastPath,
        chunkNo: nextCursorPayload.chunkNo,
        charOffset: nextCursorPayload.charOffset,
        issuedAt: Date.now()
      }, env.ADMIN_PASSWORD);
    }
    return jsonResponse(response, 200, { 'Cache-Control': 'private, no-store' });
  } catch (error) {
    return jsonResponse({ success: false, message: 'TXT 全文搜索失败: ' + error.message }, 500);
  }
}

async function listR2Prefix(env, prefix, options = {}) {
  const normalized = String(prefix || '').replace(/^\/+/, '');
  const prefixes = normalized ? [normalized, '/' + normalized] : ['', '/'];
  const objects = [];
  const delimitedPrefixes = new Set();
  let truncated = false;

  for (const listPrefix of prefixes) {
    let cursor;
    do {
      const listed = await env.STORAGE.list({ ...options, prefix: listPrefix, cursor });
      objects.push(...(listed.objects || []));
      for (const folder of listed.delimitedPrefixes || []) delimitedPrefixes.add(folder);
      if (options.limit && objects.length >= options.limit) {
        truncated = truncated || !!listed.truncated;
        break;
      }
      cursor = listed.truncated ? listed.cursor : null;
      truncated = truncated || !!listed.truncated;
    } while (cursor);
    if (options.limit && objects.length >= options.limit) break;
  }

  return { objects, delimitedPrefixes: Array.from(delimitedPrefixes), truncated };
}

function joinItemPath(parentPath, name) {
  const parent = normalizeDirectoryPath(parentPath);
  return parent === '/' ? '/' + name : parent + '/' + name;
}

async function folderExists(env, folderPath) {
  const info = await getCurrentResourceInfo(env, folderPath);
  return !!(info && info.itemType === 'folder');
}

async function getCurrentResourceInfo(env, rawPath) {
  const path = normalizeItemPath(rawPath || '');
  if (!path) return null;
  if (path === '/') {
    return {
      path,
      itemType: 'folder',
      key: '',
      resourceKey: '/',
      resourceVersion: 'root',
      resourceEtag: '"root"'
    };
  }

  const key = itemPathToR2Key(path);
  const exact = await headR2Object(env, key);
  const folderPrefix = key + '/';
  const folderListing = await listR2Prefix(env, folderPrefix, { limit: 1 });
  const hasFolder = !!(folderListing.objects && folderListing.objects.length > 0);
  if (exact && hasFolder) {
    return null;
  }
  if (exact) {
    const object = exact.object;
    return {
      path,
      itemType: 'file',
      key: exact.key,
      object,
      size: Number(object.size || 0),
      resourceKey: exact.key,
      resourceVersion: object.version || null,
      resourceEtag: currentTxtEtag(object)
    };
  }
  if (!hasFolder) return null;

  const marker = await headR2Object(env, folderPrefix + '.folder');
  const firstObject = folderListing.objects[0];
  return {
    path,
    itemType: 'folder',
    key,
    resourceKey: marker?.key || folderPrefix,
    resourceVersion: marker?.object?.version || firstObject.version || null,
    resourceEtag: currentTxtEtag(marker?.object) || (firstObject.etag ? `"${String(firstObject.etag).replace(/^"|"$/g, '')}"` : null)
  };
}

function indexedRowToResourceInfo(row) {
  if (!row || row.sync_status === 'stale') return null;
  const path = normalizeItemPath(row.path || '');
  if (!path || path === '/') return null;
  const itemType = row.item_type === 'folder' ? 'folder' : 'file';
  const key = row.resource_key || (itemType === 'folder'
    ? itemPathToR2Key(path) + '/'
    : itemPathToR2Key(path));
  const resourceEtag = row.resource_etag || null;
  const object = itemType === 'file' ? {
    key,
    size: Number(row.size || 0),
    version: row.resource_version || null,
    etag: resourceEtag ? String(resourceEtag).replace(/^"|"$/g, '') : '',
    httpEtag: resourceEtag || '',
    uploaded: row.last_modified ? new Date(row.last_modified) : null,
    httpMetadata: { contentType: getMimeType(row.name || nameFromItemPath(path)) }
  } : null;
  return {
    storageId: row.storage_id,
    path,
    itemType,
    key,
    object,
    size: Number(row.size || 0),
    resourceKey: key,
    resourceVersion: row.resource_version || null,
    resourceEtag,
    syncStatus: row.sync_status || 'ready',
    indexedAt: row.indexed_at || null,
    updatedAt: row.updated_at || null
  };
}

async function getIndexedResourceInfo(env, rawPath) {
  const path = normalizeItemPath(rawPath || '');
  if (!path) return null;
  if (path === '/') {
    return {
      storageId: env.STORAGE_ID,
      path,
      itemType: 'folder',
      key: '',
      resourceKey: '/',
      resourceVersion: 'root',
      resourceEtag: '"root"',
      syncStatus: 'ready'
    };
  }
  if (!env.D1_DB) return null;
  const row = await env.D1_DB.prepare(`
    SELECT * FROM search_items
    WHERE storage_id = ? AND path = ? AND COALESCE(sync_status, 'ready') != 'stale'
  `).bind(env.STORAGE_ID, path).first();
  return indexedRowToResourceInfo(row);
}

async function getIndexedResourceInfoMap(env, rawPaths) {
  const paths = Array.from(new Set((rawPaths || [])
    .map(path => normalizeItemPath(path || ''))
    .filter(path => path && path !== '/')));
  const result = new Map();
  for (let index = 0; index < paths.length; index += 50) {
    const chunk = paths.slice(index, index + 50);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await env.D1_DB.prepare(`
      SELECT * FROM search_items
      WHERE storage_id = ? AND path IN (${placeholders})
        AND COALESCE(sync_status, 'ready') != 'stale'
    `).bind(env.STORAGE_ID, ...chunk).all();
    for (const row of rows.results || []) {
      const info = indexedRowToResourceInfo(row);
      if (info) result.set(info.path, info);
    }
  }
  return result;
}

async function getIndexedResourceInfoWithInitialSync(env, rawPath) {
  const indexed = await getIndexedResourceInfo(env, rawPath);
  if (indexed || !env.STORAGE) return indexed;
  const current = await getCurrentResourceInfo(env, rawPath);
  if (!current) return null;
  if (current.itemType === 'file') await upsertSearchFileFromR2Object(env, current.key, current.object);
  else if (current.path !== '/') await upsertSearchFolderRow(env, current.path);
  return current;
}

async function getIndexedR2Object(env, info, options) {
  if (!info || info.itemType !== 'file' || !info.key) return null;
  const object = await env.STORAGE.get(info.key, options);
  return object ? { key: info.key, object } : null;
}

function r2ObjectMatchesIndexedResource(info, key, object) {
  if (!info || !object) return false;
  return resourceBindingMatches({
    itemType: 'file',
    resourceKey: key,
    resourceVersion: object.version || null,
    resourceEtag: currentTxtEtag(object) || null
  }, info) !== false;
}

async function markIndexedResourceStale(env, info) {
  if (!env.D1_DB || !info?.path) return;
  await env.D1_DB.prepare(`
    UPDATE search_items
    SET sync_status = 'stale', updated_at = ?
    WHERE storage_id = ? AND path = ?
      AND COALESCE(resource_key, '') = COALESCE(?, '')
      AND COALESCE(resource_version, '') = COALESCE(?, '')
  `).bind(Date.now(), env.STORAGE_ID, info.path, info.resourceKey || null, info.resourceVersion || null).run();
}

async function pathHasAnyR2Object(env, rawPath) {
  const path = normalizeItemPath(rawPath || '');
  if (!path || path === '/') return path === '/';
  const key = itemPathToR2Key(path);
  if (await headR2Object(env, key)) return true;
  const listing = await listR2Prefix(env, key + '/', { limit: 1 });
  return !!(listing.objects && listing.objects.length > 0);
}

function resourceBindingMatches(info, row) {
  if (!info || !row) return false;
  const itemType = row.item_type || row.itemType;
  const resourceKey = row.resource_key ?? row.resourceKey;
  const resourceVersion = row.resource_version ?? row.resourceVersion;
  const resourceEtag = row.resource_etag ?? row.resourceEtag;
  if (itemType && itemType !== info.itemType) return false;
  if (!resourceKey && !resourceVersion && !resourceEtag) return null;
  if (resourceKey && info.resourceKey && resourceKey !== info.resourceKey) return false;
  if (resourceVersion && info.resourceVersion && resourceVersion !== info.resourceVersion) return false;
  if (resourceEtag && info.resourceEtag && resourceEtag !== info.resourceEtag) return false;
  if ((resourceKey && !info.resourceKey)
    || (resourceVersion && !info.resourceVersion)
    || (resourceEtag && !info.resourceEtag)) return null;
  return true;
}

async function destinationExists(env, key, isFolder) {
  return pathHasAnyR2Object(env, r2KeyToPath(key));
}

function copyNameCandidate(name, index) {
  const suffix = index === 1 ? ' - 副本' : ' - 副本 ' + index;
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex > 0) {
    return name.slice(0, dotIndex) + suffix + name.slice(dotIndex);
  }
  return name + suffix;
}

async function findAvailableDestinationKey(env, desiredKey, isFolder) {
  if (!(await destinationExists(env, desiredKey, isFolder))) {
    return desiredKey;
  }

  const slashIndex = desiredKey.lastIndexOf('/');
  const parent = slashIndex >= 0 ? desiredKey.slice(0, slashIndex + 1) : '';
  const name = slashIndex >= 0 ? desiredKey.slice(slashIndex + 1) : desiredKey;

  // Each probe is a Class B HEAD + a Class A LIST against the storage
  // backend; cap retries so pathological name collisions cannot fan out
  // into thousands of billed operations.
  for (let index = 1; index <= 10; index++) {
    const candidate = parent + copyNameCandidate(name, index);
    if (!(await destinationExists(env, candidate, isFolder))) {
      return candidate;
    }
  }

  throw new Error('目标目录中存在太多同名项目');
}

async function findAvailableDestinationKeyReserved(env, desiredKey, isFolder, reservedKeys) {
  const reserved = reservedKeys || new Set();
  if (!reserved.has(desiredKey) && !(await destinationExists(env, desiredKey, isFolder))) {
    reserved.add(desiredKey);
    return desiredKey;
  }

  const slashIndex = desiredKey.lastIndexOf('/');
  const parent = slashIndex >= 0 ? desiredKey.slice(0, slashIndex + 1) : '';
  const name = slashIndex >= 0 ? desiredKey.slice(slashIndex + 1) : desiredKey;
  for (let index = 1; index <= 10; index++) {
    const candidate = parent + copyNameCandidate(name, index);
    if (!reserved.has(candidate) && !(await destinationExists(env, candidate, isFolder))) {
      reserved.add(candidate);
      return candidate;
    }
  }

  throw new Error('目标目录中存在太多同名项目');
}

async function deleteItemAtPath(env, path) {
  const key = itemPathToR2Key(path);
  if (!key) throw new Error('不能操作根目录');

  const listed = await listR2Prefix(env, key + '/', { limit: 1 });
  if (listed.objects && listed.objects.length > 0) {
    const batch = await listR2Prefix(env, key + '/');
    if (batch.objects && batch.objects.length > 0) {
      await deleteR2Keys(env, batch.objects.map(obj => obj.key));
    }
  }

  const resolved = await headR2Object(env, key);
  if (resolved) await env.STORAGE.delete(resolved.key);
  await invalidatePathReferences(env, r2KeyToPath(key));
}

async function deleteR2Keys(env, keys) {
  for (let index = 0; index < keys.length; index += 1000) {
    await env.STORAGE.delete(keys.slice(index, index + 1000));
  }
}

async function copyR2Object(env, sourceKey, targetKey) {
  const source = await env.STORAGE.head(sourceKey);
  if (!source) return null;
  const copied = await env.STORAGE.copy(sourceKey, targetKey);
  return {
    ...source,
    ...copied,
    key: targetKey,
    size: Number(copied?.size || source.size || 0),
    httpMetadata: copied?.httpMetadata || source.httpMetadata
  };
}

async function copyOrMoveItem(env, sourcePath, destinationPath, shouldMove) {
  const normalizedSourcePath = normalizeItemPath(sourcePath);
  const normalizedDestinationPath = normalizeDirectoryPath(destinationPath);
  const sourceKey = itemPathToR2Key(normalizedSourcePath);
  const name = nameFromItemPath(normalizedSourcePath);

  if (!sourceKey || !name) throw new Error('不能操作根目录');
  if (!(await folderExists(env, normalizedDestinationPath))) {
    throw new Error('目标文件夹不存在: ' + normalizedDestinationPath);
  }

  const sourceInfo = await getCurrentResourceInfo(env, normalizedSourcePath);
  const sourceObject = sourceInfo?.itemType === 'file' ? sourceInfo.object : null;
  const actualSourceKey = sourceInfo?.key || sourceKey;
  const sourcePrefix = sourceKey + '/';
  const isFolder = sourceInfo?.itemType === 'folder';

  if (!sourceInfo) {
    throw new Error('项目不存在: ' + normalizedSourcePath);
  }

  const desiredPath = joinItemPath(normalizedDestinationPath, name);
  let targetKey = itemPathToR2Key(desiredPath);
  if (shouldMove && targetKey === sourceKey) {
    return { sourcePath: normalizedSourcePath, targetPath: normalizedSourcePath, skipped: true };
  }
  targetKey = await findAvailableDestinationKey(env, targetKey, isFolder);
  const targetPath = r2KeyToPath(targetKey);

  if (isFolder) {
    const targetPrefix = targetKey + '/';
    if (targetPrefix.startsWith(sourcePrefix) || sourcePrefix.startsWith(targetPrefix)) {
      throw new Error('不能把文件夹复制或移动到自身或其子目录中');
    }

    const copiedKeys = [];
    let cursor;
    do {
      const batch = await listR2Prefix(env, sourcePrefix);
      if (batch.objects && batch.objects.length > 0) {
        for (const obj of batch.objects) {
          const relativeKey = obj.key.replace(/^\/+/, '').slice(sourcePrefix.length);
          const copied = await copyR2Object(env, obj.key, targetPrefix + relativeKey);
          if (copied) copiedKeys.push(obj.key);
        }
      }
      cursor = null;
    } while (cursor);

    if (shouldMove && copiedKeys.length > 0) {
      await deleteR2Keys(env, copiedKeys);
    }
  } else {
    const copiedObject = await copyR2Object(env, actualSourceKey, targetKey);
    if (!copiedObject) throw new Error('源对象不存在: ' + normalizedSourcePath);
    if (shouldMove) {
      await env.STORAGE.delete(actualSourceKey);
    }
    sourceInfo.copiedObject = copiedObject;
  }

  if (shouldMove) {
    await invalidatePathReferences(env, normalizedSourcePath);
  }
  if (isFolder) {
    await enqueueStorageSync(env, env.STORAGE_ID, { path: targetPath, requestedBy: 'mutation' });
  } else {
    await upsertSearchFileFromR2Object(env, targetKey, sourceInfo.copiedObject || sourceObject || {});
  }

  return { sourcePath: normalizedSourcePath, targetPath };
}

async function handleBatchFileOperation(request, env) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const body = await request.json();
    const operation = body.operation;
    const items = Array.isArray(body.items) ? body.items : [];
    const destinationPath = normalizeDirectoryPath(body.destinationPath || '/');

    if (!['copy', 'move', 'delete'].includes(operation)) {
      return jsonResponse({ success: false, message: '不支持的批量操作' }, 400);
    }

    if (items.length === 0) {
      return jsonResponse({ success: false, message: '请选择要操作的文件或文件夹' }, 400);
    }

    if (operation !== 'delete' && !(await folderExists(env, destinationPath))) {
      return jsonResponse({ success: false, message: '目标文件夹不存在' }, 400);
    }

    if (operation !== 'delete') {
      const destinationPermission = await requirePathPermission(env, auth, 'upload', destinationPath);
      if (destinationPermission) return destinationPermission;
    }

    const results = [];
    const errors = [];

    for (const item of items) {
      const itemPath = normalizeItemPath(typeof item === 'string' ? item : item.path);
      try {
        if (!itemPath || itemPath === '/') {
          throw new Error('不能操作根目录');
        }

        if (operation === 'delete') {
          const permissionError = await requirePathPermission(env, auth, 'delete', itemPath);
          if (permissionError) {
            const data = await permissionError.json();
            throw new Error(data.message || '没有删除权限');
          }
          await deleteItemAtPath(env, itemPath);
          results.push({ path: itemPath });
        } else {
          const action = operation === 'move' ? 'modify' : 'download';
          const permissionError = await requirePathPermission(env, auth, action, itemPath);
          if (permissionError) {
            const data = await permissionError.json();
            throw new Error(data.message || '没有操作权限');
          }
          const result = await copyOrMoveItem(env, itemPath, destinationPath, operation === 'move');
          results.push(result);
        }
      } catch (error) {
        errors.push({ path: itemPath, message: error.message });
      }
    }

    if (errors.length > 0) {
      return jsonResponse({
        success: results.length > 0,
        message: results.length > 0 ? '部分项目操作失败' : '批量操作失败',
        results,
        errors
      }, results.length > 0 ? 207 : 400);
    }

    return jsonResponse({ success: true, message: '批量操作成功', results });
  } catch (e) {
    return jsonResponse({ success: false, message: '批量操作失败: ' + e.message }, 500);
  }
}

const TASK_ACTIVE_STATUSES = new Set(['queued', 'running']);
const TASK_TYPES = new Set(['upload', 'download', 'batch_download', 'copy', 'move', 'rename', 'delete']);

function taskRowToClient(row) {
  let result = null;
  if (row.result_json) {
    try {
      result = JSON.parse(row.result_json);
    } catch {
      result = null;
    }
  }

  return {
    storageId: row.storage_id,
    storageName: row.storage_name || '',
    id: row.id,
    type: row.task_type,
    status: row.status,
    title: row.title,
    sourcePath: row.source_path || '',
    destinationPath: row.destination_path || '',
    totalBytes: Number(row.total_bytes || 0),
    processedBytes: Number(row.processed_bytes || 0),
    totalItems: Number(row.total_items || 0),
    processedItems: Number(row.processed_items || 0),
    errorMessage: row.error_message || '',
    result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null
  };
}

async function getTaskForAuth(env, auth, taskId) {
  const row = await env.D1_DB.prepare(`
    SELECT file_tasks.*, storage_connections.name AS storage_name
    FROM file_tasks
    LEFT JOIN storage_connections ON storage_connections.id = file_tasks.storage_id
    WHERE file_tasks.id = ? AND file_tasks.owner_key = ?
    LIMIT 1
  `).bind(taskId, ownerKeyFromAuth(auth)).first();
  return row || null;
}

async function updateTaskStatus(env, taskId, status, fields = {}) {
  const now = Date.now();
  const completedAt = ['succeeded', 'failed', 'canceled'].includes(status) ? now : null;
  // 注意：error_message / result_json 使用 CASE 表达式区分"未传"和"显式置空"。
  // 调用方未传该字段时保留旧值；显式传 null 才清空。
  // 此前直接 ?, ? 绑定会导致只传 status 的更新把这两列抹成 NULL，
  // 例如批量下载任务的 items 存在 result_json 中，被覆盖后 /api/tasks/:id/download 拿到 items=[] 失败。
  const errorMessageProvided = Object.prototype.hasOwnProperty.call(fields, 'errorMessage');
  const resultProvided = Object.prototype.hasOwnProperty.call(fields, 'result');
  await env.D1_DB.prepare(`
    UPDATE file_tasks
    SET status = ?,
        processed_bytes = COALESCE(?, processed_bytes),
        total_bytes = COALESCE(?, total_bytes),
        processed_items = COALESCE(?, processed_items),
        total_items = COALESCE(?, total_items),
        error_message = CASE WHEN ? = 1 THEN ? ELSE error_message END,
        result_json = CASE WHEN ? = 1 THEN ? ELSE result_json END,
        updated_at = ?,
        completed_at = COALESCE(?, completed_at)
    WHERE id = ?
  `).bind(
    status,
    fields.processedBytes ?? null,
    fields.totalBytes ?? null,
    fields.processedItems ?? null,
    fields.totalItems ?? null,
    errorMessageProvided ? 1 : 0,
    errorMessageProvided ? (fields.errorMessage ?? null) : null,
    resultProvided ? 1 : 0,
    resultProvided ? (fields.result ? JSON.stringify(fields.result) : null) : null,
    now,
    completedAt,
    taskId
  ).run();
}

async function insertFileTask(env, auth, input) {
  const now = Date.now();
  const taskId = generateId(20);
  await env.D1_DB.prepare(`
    INSERT INTO file_tasks (
      id, storage_id, owner_key, task_type, status, title, source_path, destination_path,
      total_bytes, processed_bytes, total_items, processed_items, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    taskId,
    env.STORAGE_ID,
    ownerKeyFromAuth(auth),
    input.type,
    input.status || 'queued',
    input.title || TASK_TYPE_LABELS[input.type] || '任务',
    input.sourcePath || '',
    input.destinationPath || '',
    input.totalBytes || 0,
    input.processedBytes || 0,
    input.totalItems || 0,
    input.processedItems || 0,
    now,
    now
  ).run();
  return taskId;
}

const TASK_TYPE_LABELS = {
  upload: '上传',
  download: '下载',
  batch_download: '批量下载',
  copy: '复制',
  move: '移动',
  rename: '重命名',
  delete: '删除'
};

async function buildCopyMoveTaskItems(env, auth, operation, selectedItems, destinationPath) {
  if (!(await folderExists(env, destinationPath))) {
    throw new Error('目标文件夹不存在');
  }

  const destinationPermission = await requirePathPermission(env, auth, 'upload', destinationPath);
  if (destinationPermission) {
    const data = await destinationPermission.json();
    throw new Error(data.message || '没有上传权限');
  }

  const reservedTargets = new Set();
  const taskItems = [];
  const errors = [];

  for (const item of selectedItems) {
    const itemPath = normalizeItemPath(typeof item === 'string' ? item : item.path);
    try {
      if (!itemPath || itemPath === '/') throw new Error('不能操作根目录');

      const action = operation === 'move' ? 'modify' : 'download';
      const permissionError = await requirePathPermission(env, auth, action, itemPath);
      if (permissionError) {
        const data = await permissionError.json();
        throw new Error(data.message || '没有操作权限');
      }

      const sourceKey = itemPathToR2Key(itemPath);
      const sourceInfo = await getCurrentResourceInfo(env, itemPath);
      const sourceObject = sourceInfo?.itemType === 'file' ? sourceInfo.object : null;
      const actualSourceKey = sourceInfo?.key || sourceKey;
      const sourcePrefix = sourceKey + '/';
      const isFolder = sourceInfo?.itemType === 'folder';
      if (!sourceInfo) throw new Error('项目不存在: ' + itemPath);

      const desiredPath = joinItemPath(destinationPath, nameFromItemPath(itemPath));
      let targetKey = itemPathToR2Key(desiredPath);
      if (operation === 'move' && targetKey === sourceKey) {
        continue;
      }
      targetKey = await findAvailableDestinationKeyReserved(env, targetKey, isFolder, reservedTargets);
      const targetPath = r2KeyToPath(targetKey);

      if (isFolder) {
        const targetPrefix = targetKey + '/';
        if (targetPrefix.startsWith(sourcePrefix) || sourcePrefix.startsWith(targetPrefix)) {
          throw new Error('不能把文件夹复制或移动到自身或其子目录中');
        }

        let cursor;
        do {
          const listed = await listR2Prefix(env, sourcePrefix);
          for (const obj of listed.objects || []) {
            const relativeKey = obj.key.replace(/^\/+/, '').slice(sourcePrefix.length);
            taskItems.push({
              sourcePath: r2KeyToPath(obj.key),
              sourceKey: obj.key,
              targetPath: r2KeyToPath(targetPrefix + relativeKey),
              targetKey: targetPrefix + relativeKey,
              size: obj.size || 0,
              sourceVersion: obj.version || null,
              sourceEtag: currentTxtEtag(obj)
            });
          }
          cursor = null;
        } while (cursor);
      } else {
        taskItems.push({
          sourcePath: itemPath,
          sourceKey: actualSourceKey,
          targetPath,
          targetKey,
          size: sourceObject.size || 0,
          sourceVersion: sourceInfo.resourceVersion,
          sourceEtag: sourceInfo.resourceEtag
        });
      }
    } catch (error) {
      errors.push({ path: itemPath, message: error.message });
    }
  }

  if (taskItems.length === 0 && errors.length > 0) {
    throw new Error(errors[0].message);
  }

  return { taskItems, errors };
}

async function buildDeleteTaskItems(env, auth, selectedItems) {
  const taskItems = [];
  const errors = [];
  const reservedKeys = new Set();

  for (const item of selectedItems) {
    const itemPath = normalizeItemPath(typeof item === 'string' ? item : item.path);
    try {
      if (!itemPath || itemPath === '/') throw new Error('不能操作根目录');

      const permissionError = await requirePathPermission(env, auth, 'delete', itemPath);
      if (permissionError) {
        const data = await permissionError.json();
        throw new Error(data.message || '没有删除权限');
      }

      const sourceKey = itemPathToR2Key(itemPath);
      const sourceInfo = await getCurrentResourceInfo(env, itemPath);
      const sourceObject = sourceInfo?.itemType === 'file' ? sourceInfo.object : null;
      const actualSourceKey = sourceInfo?.key || sourceKey;
      const sourcePrefix = sourceKey + '/';
      const isFolder = sourceInfo?.itemType === 'folder';
      if (!sourceInfo) throw new Error('项目不存在: ' + itemPath);

      if (sourceObject && !reservedKeys.has(actualSourceKey)) {
        reservedKeys.add(actualSourceKey);
        taskItems.push({
          sourcePath: itemPath,
          sourceKey: actualSourceKey,
          targetPath: itemPath,
          targetKey: actualSourceKey,
          size: sourceObject.size || 0,
          sourceVersion: sourceInfo.resourceVersion,
          sourceEtag: sourceInfo.resourceEtag
        });
      }

      if (isFolder) {
        let cursor;
        do {
          const listed = await listR2Prefix(env, sourcePrefix);
          for (const obj of listed.objects || []) {
            if (reservedKeys.has(obj.key)) continue;
            reservedKeys.add(obj.key);
            const objectPath = r2KeyToPath(obj.key);
            taskItems.push({
              sourcePath: objectPath,
              sourceKey: obj.key,
              targetPath: objectPath,
              targetKey: obj.key,
              size: obj.size || 0,
              sourceVersion: obj.version || null,
              sourceEtag: currentTxtEtag(obj)
            });
          }
          cursor = null;
        } while (cursor);
      }
    } catch (error) {
      errors.push({ path: itemPath, message: error.message });
    }
  }

  if (taskItems.length === 0 && errors.length > 0) {
    throw new Error(errors[0].message);
  }

  return { taskItems, errors };
}

async function insertTaskItems(env, taskId, taskItems) {
  if (taskItems.length === 0) return;
  const now = Date.now();
  const insert = env.D1_DB.prepare(`
    INSERT INTO file_task_items (
      task_id, storage_id, source_path, source_key, target_path, target_key, size, source_version, source_etag, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
  `);

  for (let index = 0; index < taskItems.length; index += 50) {
    await env.D1_DB.batch(taskItems.slice(index, index + 50).map(item => insert.bind(
      taskId,
      env.STORAGE_ID,
      item.sourcePath,
      item.sourceKey,
      item.targetPath,
      item.targetKey,
      item.size || 0,
      item.sourceVersion || null,
      item.sourceEtag || null,
      now,
      now
    )));
  }
}

async function handleCreateTask(request, env) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const body = await request.json();
    const sourceStorageId = body.storageId || body.sourceStorageId || env.STORAGE_ID;
    const destinationStorageId = body.destinationStorageId || sourceStorageId;
    if (sourceStorageId !== env.STORAGE_ID || destinationStorageId !== env.STORAGE_ID) {
      return jsonResponse({
        success: false,
        code: 'CROSS_STORAGE_NOT_SUPPORTED',
        message: '第一版不支持跨存储复制或移动'
      }, 400);
    }
    const type = body.type;
    if (!TASK_TYPES.has(type)) {
      return jsonResponse({ success: false, message: '不支持的任务类型' }, 400);
    }

    let taskId;
    if (type === 'upload') {
      const destinationPath = normalizeDirectoryPath(body.destinationPath || body.path || '/');
      const permissionError = await requirePathPermission(env, auth, 'upload', destinationPath);
      if (permissionError) return permissionError;
      const destination = await getCurrentResourceInfo(env, destinationPath);
      if (!destination || destination.itemType !== 'folder') {
        return jsonResponse({ success: false, message: '目标文件夹不存在' }, 404);
      }
      taskId = await insertFileTask(env, auth, {
        type,
        status: 'running',
        title: body.title || ('上传 ' + (body.name || '文件')),
        destinationPath,
        totalBytes: Number(body.totalBytes || 0)
      });
    } else if (type === 'download') {
      const filePath = normalizeItemPath(body.path || body.sourcePath || '');
      const permissionError = await requirePathPermission(env, auth, 'download', filePath);
      if (permissionError) return permissionError;
      const current = await getCurrentResourceInfo(env, filePath);
      if (!current || current.itemType !== 'file' || !current.object) {
        return jsonResponse({ success: false, message: '文件不存在' }, 404);
      }
      const object = current.object;
      taskId = await insertFileTask(env, auth, {
        type,
        status: 'running',
        title: body.title || ('下载 ' + nameFromItemPath(filePath)),
        sourcePath: filePath,
        totalBytes: object.size || 0
      });
    } else if (type === 'batch_download') {
      const items = Array.isArray(body.items) ? body.items : [];
      if (items.length === 0) return jsonResponse({ success: false, message: '请选择要下载的文件或文件夹' }, 400);
      for (const item of items) {
        const itemPath = normalizeItemPath(typeof item === 'string' ? item : item.path);
        const permissionError = await requirePathPermission(env, auth, 'download', itemPath);
        if (permissionError) return permissionError;
      }
      taskId = await insertFileTask(env, auth, {
        type,
        status: 'running',
        title: body.title || ('批量下载 ' + items.length + ' 项'),
        sourcePath: items.map(item => normalizeItemPath(typeof item === 'string' ? item : item.path)).join('\n'),
        totalItems: items.length
      });
      await updateTaskStatus(env, taskId, 'running', {
        result: {
          items: items.map(item => ({
            path: normalizeItemPath(typeof item === 'string' ? item : item.path),
            name: item && typeof item === 'object' ? item.name : ''
          }))
        }
      });
    } else if (type === 'copy' || type === 'move') {
      const items = Array.isArray(body.items) ? body.items : [];
      if (items.length === 0) return jsonResponse({ success: false, message: '请选择要操作的文件或文件夹' }, 400);
      const destinationPath = normalizeDirectoryPath(body.destinationPath || '/');
      const built = await buildCopyMoveTaskItems(env, auth, type, items, destinationPath);
      taskId = await insertFileTask(env, auth, {
        type,
        title: body.title || ((type === 'move' ? '移动 ' : '复制 ') + items.length + ' 项'),
        sourcePath: items.map(item => normalizeItemPath(typeof item === 'string' ? item : item.path)).join('\n'),
        destinationPath,
        totalItems: built.taskItems.length
      });
      await insertTaskItems(env, taskId, built.taskItems);
      if (built.errors.length > 0) {
        await updateTaskStatus(env, taskId, 'queued', { result: { errors: built.errors } });
      }
    } else if (type === 'delete') {
      const items = Array.isArray(body.items) ? body.items : [];
      if (items.length === 0) return jsonResponse({ success: false, message: '请选择要删除的文件或文件夹' }, 400);
      const built = await buildDeleteTaskItems(env, auth, items);
      taskId = await insertFileTask(env, auth, {
        type,
        title: body.title || ('删除 ' + items.length + ' 项'),
        sourcePath: items.map(item => normalizeItemPath(typeof item === 'string' ? item : item.path)).join('\n'),
        totalItems: built.taskItems.length
      });
      await insertTaskItems(env, taskId, built.taskItems);
      if (built.errors.length > 0) {
        await updateTaskStatus(env, taskId, 'queued', { result: { errors: built.errors } });
      }
    }

    const task = await getTaskForAuth(env, auth, taskId);
    return jsonResponse({ success: true, task: taskRowToClient(task) });
  } catch (e) {
    return jsonResponse({ success: false, message: '创建任务失败: ' + e.message }, 500);
  }
}

async function handleListTasks(request, env) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const url = new URL(request.url);
    const activeOnly = ['1', 'true', 'yes'].includes((url.searchParams.get('active') || '').toLowerCase());
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 50) || 50));
    const ownerKey = ownerKeyFromAuth(auth);
    await env.D1_DB.prepare(`
      UPDATE file_tasks
      SET status = 'failed',
          error_message = '任务连接已中断或超时',
          updated_at = ?,
          completed_at = ?
      WHERE owner_key = ?
        AND task_type IN ('upload', 'download', 'batch_download')
        AND status IN ('queued', 'running')
        AND updated_at < ?
    `).bind(Date.now(), Date.now(), ownerKey, Date.now() - 30 * 60 * 1000).run();
    const rows = activeOnly
      ? await env.D1_DB.prepare(`
          SELECT file_tasks.*, storage_connections.name AS storage_name
          FROM file_tasks
          LEFT JOIN storage_connections ON storage_connections.id = file_tasks.storage_id
          WHERE owner_key = ? AND status IN ('queued', 'running')
          ORDER BY created_at DESC
          LIMIT ?
        `).bind(ownerKey, limit).all()
      : await env.D1_DB.prepare(`
          SELECT file_tasks.*, storage_connections.name AS storage_name
          FROM file_tasks
          LEFT JOIN storage_connections ON storage_connections.id = file_tasks.storage_id
          WHERE owner_key = ?
          ORDER BY created_at DESC
          LIMIT ?
        `).bind(ownerKey, limit).all();

    return jsonResponse({ success: true, tasks: (rows.results || []).map(taskRowToClient) });
  } catch (e) {
    return jsonResponse({ success: false, message: '获取任务失败: ' + e.message }, 500);
  }
}

async function handleUpdateTaskProgress(request, env, taskId) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const task = await getTaskForAuth(env, auth, taskId);
    if (!task) return jsonResponse({ success: false, message: '任务不存在' }, 404);

    const body = await request.json();
    const status = body.status && ['queued', 'running', 'succeeded', 'failed', 'canceled'].includes(body.status)
      ? body.status
      : task.status;
    // 只把客户端实际带上来的字段塞进 fields，避免误把 result_json/error_message 抹空。
    const updateFields = {
      processedBytes: Number.isFinite(Number(body.processedBytes)) ? Math.max(0, Math.floor(Number(body.processedBytes))) : null,
      totalBytes: Number.isFinite(Number(body.totalBytes)) ? Math.max(0, Math.floor(Number(body.totalBytes))) : null,
      processedItems: Number.isFinite(Number(body.processedItems)) ? Math.max(0, Math.floor(Number(body.processedItems))) : null,
      totalItems: Number.isFinite(Number(body.totalItems)) ? Math.max(0, Math.floor(Number(body.totalItems))) : null
    };
    if (Object.prototype.hasOwnProperty.call(body, 'errorMessage')) {
      updateFields.errorMessage = body.errorMessage || null;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'result')) {
      updateFields.result = body.result || null;
    }
    await updateTaskStatus(env, taskId, status, updateFields);

    const updated = await getTaskForAuth(env, auth, taskId);
    return jsonResponse({ success: true, task: taskRowToClient(updated) });
  } catch (e) {
    return jsonResponse({ success: false, message: '更新任务失败: ' + e.message }, 500);
  }
}

async function handleCancelTask(request, env, taskId) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const task = await getTaskForAuth(env, auth, taskId);
    if (!task) return jsonResponse({ success: false, message: '任务不存在' }, 404);
    if (!['queued', 'running'].includes(task.status)) {
      return jsonResponse({ success: true, task: taskRowToClient(task) });
    }

    await updateTaskStatus(env, taskId, 'canceled', { errorMessage: '任务已停止' });
    const updated = await getTaskForAuth(env, auth, taskId);
    return jsonResponse({ success: true, task: taskRowToClient(updated) });
  } catch (e) {
    return jsonResponse({ success: false, message: '停止任务失败: ' + e.message }, 500);
  }
}

async function handleDeleteTask(request, env, taskId) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const task = await getTaskForAuth(env, auth, taskId);
    if (!task) return jsonResponse({ success: true });

    await env.D1_DB.batch([
      env.D1_DB.prepare('DELETE FROM file_task_items WHERE task_id = ?').bind(taskId),
      env.D1_DB.prepare('DELETE FROM file_tasks WHERE id = ? AND owner_key = ?').bind(taskId, ownerKeyFromAuth(auth))
    ]);
    return jsonResponse({ success: true });
  } catch (e) {
    return jsonResponse({ success: false, message: '删除任务失败: ' + e.message }, 500);
  }
}

async function handleTaskDownload(request, env, taskId) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const task = await getTaskForAuth(env, auth, taskId);
    if (!task) return jsonResponse({ success: false, message: '任务不存在' }, 404);

    if (task.task_type === 'download') {
      await updateTaskStatus(env, taskId, 'succeeded', {
        processedBytes: task.total_bytes || 0,
        totalBytes: task.total_bytes || 0,
        result: { nativeDownload: true }
      });
      return await handleDownloadFile(request, env, task.source_path || '');
    }

    if (task.task_type !== 'batch_download') {
      return jsonResponse({ success: false, message: '此任务不是下载任务' }, 400);
    }

    let result = {};
    try {
      result = task.result_json ? JSON.parse(task.result_json) : {};
    } catch {
      result = {};
    }
    const items = Array.isArray(result.items) ? result.items : [];
    const response = await createBatchDownloadResponse(env, auth, items);
    if (response.ok) {
      await updateTaskStatus(env, taskId, 'succeeded', {
        processedItems: task.total_items || items.length,
        totalItems: task.total_items || items.length,
        result: { ...result, nativeDownload: true }
      });
    } else {
      await updateTaskStatus(env, taskId, 'failed', { errorMessage: '批量下载启动失败' });
    }
    return response;
  } catch (e) {
    await updateTaskStatus(env, taskId, 'failed', { errorMessage: e.message }).catch(() => null);
    return jsonResponse({ success: false, message: '下载任务失败: ' + e.message }, 500);
  }
}

async function handleRunTask(request, env, taskId) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const task = await getTaskForAuth(env, auth, taskId);
    if (!task) return jsonResponse({ success: false, message: '任务不存在' }, 404);
    if (!['copy', 'move', 'rename', 'delete'].includes(task.task_type)) {
      return jsonResponse({ success: false, message: '此任务不支持分片执行' }, 400);
    }
    if (!TASK_ACTIVE_STATUSES.has(task.status)) {
      return jsonResponse({ success: true, task: taskRowToClient(task), done: true });
    }

    await updateTaskStatus(env, taskId, 'running');
    const limit = Math.min(20, Math.max(1, Number(new URL(request.url).searchParams.get('limit') || 5) || 5));
    const rows = await env.D1_DB.prepare(`
      SELECT * FROM file_task_items
      WHERE task_id = ? AND storage_id = ? AND status = 'queued'
      ORDER BY id ASC
      LIMIT ?
    `).bind(taskId, task.storage_id, limit).all();

    const errors = [];
    for (const item of rows.results || []) {
      let sourceInvalid = false;
      try {
        const currentSource = await headR2Object(env, item.source_key);
        if (!currentSource) {
          sourceInvalid = true;
          throw new Error('源对象不存在或已被替换');
        }
        if (item.source_version && currentSource.object.version !== item.source_version) {
          sourceInvalid = true;
          throw new Error('源对象已变化，请重新创建任务');
        }
        if (item.source_etag && currentTxtEtag(currentSource.object) !== item.source_etag) {
          sourceInvalid = true;
          throw new Error('源对象已变化，请重新创建任务');
        }
        let sourceRemoved = false;
        if (task.task_type === 'delete') {
          await env.STORAGE.delete(item.source_key);
          sourceRemoved = true;
        } else {
          const copied = await copyR2Object(env, item.source_key, item.target_key);
          if (!copied) throw new Error('源对象不存在');
          await upsertSearchFileFromR2Object(env, item.target_key, copied);
          if (task.task_type === 'move' || task.task_type === 'rename') {
            await env.STORAGE.delete(item.source_key);
            sourceRemoved = true;
          }
        }
        if (sourceRemoved) await invalidatePathReferences(env, item.source_path);
        await env.D1_DB.prepare(`
          UPDATE file_task_items
          SET status = 'succeeded', error_message = NULL, updated_at = ?
          WHERE id = ? AND storage_id = ?
        `).bind(Date.now(), item.id, task.storage_id).run();
      } catch (error) {
        if (sourceInvalid) await invalidatePathReferences(env, item.source_path);
        await env.D1_DB.prepare(`
          UPDATE file_task_items
          SET status = 'failed', error_message = ?, updated_at = ?
          WHERE id = ? AND storage_id = ?
        `).bind(error.message, Date.now(), item.id, task.storage_id).run();
        errors.push({ path: item.source_path, message: error.message });
      }
    }

    const counts = await env.D1_DB.prepare(`
      SELECT
        SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        COUNT(*) AS total
      FROM file_task_items
      WHERE task_id = ? AND storage_id = ?
    `).bind(taskId, task.storage_id).first();

    const succeeded = Number(counts?.succeeded || 0);
    const failed = Number(counts?.failed || 0);
    const total = Number(counts?.total || 0);
    const done = succeeded + failed >= total;

    if (done) {
      if (task.task_type === 'move' || task.task_type === 'rename') {
        await cleanupMovedTaskSources(env, taskId);
      }
      if (task.task_type === 'delete') {
        await cleanupDeletedTaskSources(env, task);
      }
      if (task.task_type === 'move' || task.task_type === 'rename') {
        await cleanupMovedTaskD1(env, taskId);
      }
      await updateTaskStatus(env, taskId, failed > 0 ? 'failed' : 'succeeded', {
        processedItems: succeeded + failed,
        totalItems: total,
        errorMessage: failed > 0 ? '有 ' + failed + ' 个对象处理失败' : null,
        result: { errors }
      });
    } else {
      await updateTaskStatus(env, taskId, 'running', {
        processedItems: succeeded + failed,
        totalItems: total,
        result: errors.length > 0 ? { errors } : null
      });
    }

    const updated = await getTaskForAuth(env, auth, taskId);
    return jsonResponse({ success: true, task: taskRowToClient(updated), done });
  } catch (e) {
    await updateTaskStatus(env, taskId, 'failed', { errorMessage: e.message }).catch(() => null);
    return jsonResponse({ success: false, message: '执行任务失败: ' + e.message }, 500);
  }
}

async function cleanupDeletedTaskSources(env, task) {
  const sourceRoots = String(task?.source_path || '')
    .split('\n')
    .map(path => normalizeItemPath(path))
    .filter(path => path && path !== '/');

  for (const path of sourceRoots) {
    await invalidatePathReferences(env, path);
  }
}

async function cleanupMovedTaskSources(env, taskId) {
  const rows = await env.D1_DB.prepare(`
    SELECT DISTINCT source_path FROM file_task_items
    WHERE task_id = ? AND status = 'succeeded'
  `).bind(taskId).all();

  const folders = new Set();
  for (const row of rows.results || []) {
    let parent = parentPathFromItemPath(row.source_path);
    while (parent && parent !== '/') {
      folders.add(parent);
      parent = parentPathFromItemPath(parent);
    }
  }

  const folderList = Array.from(folders).sort((a, b) => b.length - a.length);
  for (const folder of folderList) {
    const key = itemPathToR2Key(folder);
    const listed = await listR2Prefix(env, key + '/', { limit: 1 });
    if (!listed.objects || listed.objects.length === 0) {
      await env.STORAGE.delete(key + '/.folder').catch(() => null);
      await cleanupD1ItemPath(env, folder);
    }
  }
}

async function cleanupMovedTaskD1(env, taskId) {
  const task = await env.D1_DB.prepare('SELECT source_path FROM file_tasks WHERE id = ?').bind(taskId).first();
  const sourceRoots = String(task?.source_path || '')
    .split('\n')
    .map(path => normalizeItemPath(path))
    .filter(path => path && path !== '/');

  const roots = new Set();
  if (sourceRoots.length > 0) {
    sourceRoots.forEach(path => roots.add(path));
  } else {
    const rows = await env.D1_DB.prepare(`
      SELECT DISTINCT source_path FROM file_task_items
      WHERE task_id = ? AND status = 'succeeded'
    `).bind(taskId).all();
    for (const row of rows.results || []) {
      roots.add(normalizeItemPath(row.source_path));
    }
  }

  for (const path of roots) {
    await invalidatePathReferences(env, path);
  }
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function updateCrc32(crc, chunk) {
  let value = crc;
  for (let index = 0; index < chunk.length; index++) {
    value = CRC32_TABLE[(value ^ chunk[index]) & 0xff] ^ (value >>> 8);
  }
  return value >>> 0;
}

function finalizeCrc32(crc) {
  return (crc ^ 0xffffffff) >>> 0;
}

function createZipDateParts(value) {
  const date = value ? new Date(value) : new Date();
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function writeUint16(buffer, offset, value) {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32(buffer, offset, value) {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >>> 8) & 0xff;
  buffer[offset + 2] = (value >>> 16) & 0xff;
  buffer[offset + 3] = (value >>> 24) & 0xff;
}

function createZipLocalHeader(entry) {
  const header = new Uint8Array(30 + entry.nameBytes.length);
  const dateParts = createZipDateParts(entry.lastModified);
  const flags = 0x0800 | (entry.isDirectory ? 0 : 0x0008);

  writeUint32(header, 0, 0x04034b50);
  writeUint16(header, 4, 20);
  writeUint16(header, 6, flags);
  writeUint16(header, 8, 0);
  writeUint16(header, 10, dateParts.time);
  writeUint16(header, 12, dateParts.date);
  writeUint32(header, 14, 0);
  writeUint32(header, 18, 0);
  writeUint32(header, 22, 0);
  writeUint16(header, 26, entry.nameBytes.length);
  writeUint16(header, 28, 0);
  header.set(entry.nameBytes, 30);
  return header;
}

function createZipDataDescriptor(crc, size) {
  const descriptor = new Uint8Array(16);
  writeUint32(descriptor, 0, 0x08074b50);
  writeUint32(descriptor, 4, crc);
  writeUint32(descriptor, 8, size);
  writeUint32(descriptor, 12, size);
  return descriptor;
}

function createZipCentralDirectoryHeader(entry) {
  const header = new Uint8Array(46 + entry.nameBytes.length);
  const dateParts = createZipDateParts(entry.lastModified);
  const flags = 0x0800 | (entry.isDirectory ? 0 : 0x0008);

  writeUint32(header, 0, 0x02014b50);
  writeUint16(header, 4, 20);
  writeUint16(header, 6, 20);
  writeUint16(header, 8, flags);
  writeUint16(header, 10, 0);
  writeUint16(header, 12, dateParts.time);
  writeUint16(header, 14, dateParts.date);
  writeUint32(header, 16, entry.crc || 0);
  writeUint32(header, 20, entry.size || 0);
  writeUint32(header, 24, entry.size || 0);
  writeUint16(header, 28, entry.nameBytes.length);
  writeUint16(header, 30, 0);
  writeUint16(header, 32, 0);
  writeUint16(header, 34, 0);
  writeUint16(header, 36, 0);
  writeUint32(header, 38, entry.isDirectory ? 0x10 : 0);
  writeUint32(header, 42, entry.offset);
  header.set(entry.nameBytes, 46);
  return header;
}

function createZipEndRecord(entryCount, centralDirectorySize, centralDirectoryOffset) {
  const record = new Uint8Array(22);
  writeUint32(record, 0, 0x06054b50);
  writeUint16(record, 4, 0);
  writeUint16(record, 6, 0);
  writeUint16(record, 8, entryCount);
  writeUint16(record, 10, entryCount);
  writeUint32(record, 12, centralDirectorySize);
  writeUint32(record, 16, centralDirectoryOffset);
  writeUint16(record, 20, 0);
  return record;
}

function sanitizeZipEntryName(name) {
  const value = name || '未命名';
  const isDirectory = value.endsWith('/');
  const normalized = value
    .replace(/^\/+/, '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .join('/');
  return isDirectory && normalized ? normalized + '/' : normalized;
}

function uniqueZipEntryName(name, usedNames) {
  const sanitized = sanitizeZipEntryName(name);
  const isDirectory = sanitized.endsWith('/');
  const normalized = isDirectory ? sanitized : sanitized.replace(/\/+$/, '');
  const baseName = isDirectory ? normalized.slice(0, -1) : normalized;
  let candidate = isDirectory ? baseName + '/' : baseName;
  let index = 2;

  while (usedNames.has(candidate)) {
    if (isDirectory) {
      candidate = baseName + ' (' + index + ')/';
    } else {
      const slashIndex = baseName.lastIndexOf('/');
      const parent = slashIndex >= 0 ? baseName.slice(0, slashIndex + 1) : '';
      const filename = slashIndex >= 0 ? baseName.slice(slashIndex + 1) : baseName;
      const dotIndex = filename.lastIndexOf('.');
      candidate = dotIndex > 0
        ? parent + filename.slice(0, dotIndex) + ' (' + index + ')' + filename.slice(dotIndex)
        : parent + filename + ' (' + index + ')';
    }
    index++;
  }

  usedNames.add(candidate);
  return candidate;
}

function addZipEntry(entries, usedNames, entry) {
  const encoder = new TextEncoder();
  const name = uniqueZipEntryName(entry.name, usedNames);
  const nameBytes = encoder.encode(name);
  if (nameBytes.length > 0xffff) {
    throw new Error('文件名过长，无法打包: ' + name);
  }
  entries.push({ ...entry, name, nameBytes });
}

async function collectBatchDownloadEntries(env, items) {
  const entries = [];
  const usedNames = new Set();
  const usedKeys = new Set();

  for (const item of items) {
    const itemPath = normalizeItemPath(typeof item === 'string' ? item : item.path);
    if (!itemPath || itemPath === '/') throw new Error('不能打包根目录');
    const current = await getIndexedResourceInfo(env, itemPath);
    if (!current) throw new Error('项目不存在: ' + itemPath);

    if (current.itemType === 'file') {
      if (usedKeys.has(current.key)) continue;
      usedKeys.add(current.key);
      addZipEntry(entries, usedNames, {
        name: nameFromItemPath(itemPath),
        key: current.key,
        isDirectory: false,
        size: current.size || 0,
        lastModified: current.object?.uploaded || new Date()
      });
      continue;
    }

    const directoryName = uniqueZipEntryName(nameFromItemPath(itemPath) + '/', usedNames);
    const directoryNameBytes = new TextEncoder().encode(directoryName);
    if (directoryNameBytes.length > 0xffff) throw new Error('文件名过长，无法打包: ' + directoryName);
    entries.push({ name: directoryName, nameBytes: directoryNameBytes, isDirectory: true, lastModified: new Date() });

    const descendants = await env.D1_DB.prepare(`
      SELECT * FROM search_items
      WHERE storage_id = ?
        AND substr(path, 1, length(?) + 1) = ? || '/'
        AND COALESCE(sync_status, 'ready') != 'stale'
      ORDER BY length(path) ASC, path ASC
    `).bind(env.STORAGE_ID, itemPath, itemPath).all();
    for (const row of descendants.results || []) {
      const relativeName = row.path.slice(itemPath.length + 1);
      if (!relativeName) continue;
      if (row.item_type === 'folder') {
        addZipEntry(entries, usedNames, {
          name: directoryName + relativeName + '/',
          isDirectory: true,
          lastModified: row.last_modified ? new Date(row.last_modified) : new Date()
        });
        continue;
      }
      if (!row.resource_key || usedKeys.has(row.resource_key)) continue;
      usedKeys.add(row.resource_key);
      addZipEntry(entries, usedNames, {
        name: directoryName + relativeName,
        key: row.resource_key,
        isDirectory: false,
        size: Number(row.size || 0),
        lastModified: row.last_modified ? new Date(row.last_modified) : new Date()
      });
    }
  }

  if (entries.length === 0) throw new Error('没有可打包的文件');
  return entries;
}

function createZipStream(env, entries) {
  return new ReadableStream({
    async start(controller) {
      const centralDirectory = [];
      let offset = 0;

      function enqueue(chunk) {
        controller.enqueue(chunk);
        offset += chunk.length;
        if (offset > 0xffffffff) {
          throw new Error('打包文件过大，暂不支持超过 4GB 的 zip');
        }
      }

      try {
        for (const entry of entries) {
          entry.offset = offset;
          const localHeader = createZipLocalHeader(entry);
          enqueue(localHeader);

          let crc = 0xffffffff;
          let size = 0;
          if (!entry.isDirectory) {
            const object = await env.STORAGE.get(entry.key);
            if (!object) throw new Error('文件不存在: ' + entry.name);

            const reader = object.body.getReader();
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
              crc = updateCrc32(crc, chunk);
              size += chunk.length;
              if (size > 0xffffffff) {
                throw new Error('单个文件过大，暂不支持超过 4GB 的文件: ' + entry.name);
              }
              enqueue(chunk);
            }
          }

          entry.crc = entry.isDirectory ? 0 : finalizeCrc32(crc);
          entry.size = size;
          if (!entry.isDirectory) {
            enqueue(createZipDataDescriptor(entry.crc, entry.size));
          }
          centralDirectory.push(createZipCentralDirectoryHeader(entry));
        }

        const centralDirectoryOffset = offset;
        let centralDirectorySize = 0;
        for (const header of centralDirectory) {
          centralDirectorySize += header.length;
          if (centralDirectorySize > 0xffffffff) {
            throw new Error('打包文件过大，暂不支持超过 4GB 的 zip 目录');
          }
          enqueue(header);
        }
        if (entries.length > 0xffff) {
          throw new Error('打包文件数量过多，暂不支持超过 65535 个条目');
        }
        enqueue(createZipEndRecord(entries.length, centralDirectorySize, centralDirectoryOffset));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    }
  });
}

async function handleBatchDownload(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) {
    return jsonResponse({ success: false, message: '未授权' }, 401);
  }

  try {
    const body = await request.json();
    const items = Array.isArray(body.items) ? body.items : [];
    return await createBatchDownloadResponse(env, auth, items);
  } catch (e) {
    return jsonResponse({ success: false, message: '批量下载失败: ' + e.message }, 500);
  }
}

async function createBatchDownloadResponse(env, auth, items) {
  if (items.length === 0) {
    return jsonResponse({ success: false, message: '请选择要下载的文件或文件夹' }, 400);
  }

  for (const item of items) {
    const itemPath = normalizeItemPath(typeof item === 'string' ? item : item.path);
    const permissionError = await requirePathPermission(env, auth, 'download', itemPath);
    if (permissionError) return permissionError;
  }

  const entries = await collectBatchDownloadEntries(env, items);
  const fileCount = entries.filter(entry => !entry.isDirectory).length;
  if (fileCount > 40) {
    return jsonResponse({
      success: false,
      code: 'ZIP_ENTRY_LIMIT',
      message: '单个 ZIP 最多包含 40 个文件，请缩小选择范围'
    }, 422);
  }
  const filename = 'edgestashpro-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.zip';

  // 注意：不要预先设置 Content-Length。
  // zip 的字节是在 createZipStream 边读 R2 边算 CRC/size 的过程中动态生成的，
  // 若用 head()/list() 返回的 size 预先计算并写入 Content-Length，一旦与真实流出的字节数有任何
  // 偏差（例如 R2 索引与对象间瞬时不一致、搜索结果跨目录、文件在 head 之后被修改等），
  // 浏览器就会按 Content-Length 截断响应，得到一个"损坏/截断"的 zip。
  // 让 Cloudflare 用 Transfer-Encoding: chunked 输出即可，少了进度百分比但保证不会被截断。
  return new Response(createZipStream(env, entries), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': createAttachmentDisposition(filename)
    }
  });
}

async function handleSearchFolders(request, env) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const url = new URL(request.url);
    const query = (url.searchParams.get('q') || '').trim().toLowerCase();
    const permissionAction = PERMISSION_COLUMNS[url.searchParams.get('permission') || 'view']
      ? (url.searchParams.get('permission') || 'view')
      : 'view';
    const requestedLimit = Number(url.searchParams.get('limit') || 50);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(100, Math.max(1, requestedLimit))
      : 50;
    // Serve folder candidates from the virtual directory tree (D1) instead of
    // scanning the whole R2 bucket on every keystroke.
    const rows = await env.D1_DB.prepare(`
      SELECT path FROM search_items
      WHERE storage_id = ? AND item_type = 'folder'
    `).bind(env.STORAGE_ID).all();

    const folderPaths = new Set(['/']);
    for (const row of rows.results || []) {
      const path = normalizeItemPath(row.path);
      if (path && path !== '/') folderPaths.add(path);
    }

    let folders = Array.from(folderPaths)
      .filter(path => {
        if (!query) return true;
        return path.toLowerCase().includes(query) || nameFromItemPath(path).toLowerCase().includes(query);
      })
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
      .map(path => ({
        storageId: env.STORAGE_ID,
        path,
        name: path === '/' ? '根目录' : nameFromItemPath(path)
      }));

    const scanned = folders.length;
    folders = (await filterItemsByPermissionD1(env, auth, folders, permissionAction)).slice(0, limit);

    return jsonResponse({
      storageId: env.STORAGE_ID,
      success: true,
      folders,
      truncated: false,
      scanned
    });
  } catch (e) {
    return jsonResponse({ success: false, message: '搜索文件夹失败: ' + e.message }, 500);
  }
}

async function handleCreateFolder(request, env) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const body = await request.json();
    let { path: folderPath } = body;

    if (!folderPath) {
      return jsonResponse({ success: false, message: '请提供文件夹路径' }, 400);
    }

    const normalizedFolderPath = normalizeDirectoryPath(folderPath);
    const parentPath = parentPathFromItemPath(normalizedFolderPath);
    const permissionError = await requirePathPermission(env, auth, 'upload', parentPath);
    if (permissionError) return permissionError;
    const parent = await getCurrentResourceInfo(env, parentPath);
    if (!parent || parent.itemType !== 'folder') {
      return jsonResponse({ success: false, message: '父文件夹不存在' }, 404);
    }

    folderPath = normalizedFolderPath;
    if (folderPath.startsWith('/')) folderPath = folderPath.slice(1);
    if (!folderPath.endsWith('/')) folderPath += '/';
    const folderItemPath = r2KeyToPath(folderPath.slice(0, -1));
    if (await pathHasAnyR2Object(env, folderItemPath)) {
      return jsonResponse({ success: false, message: '文件夹已存在' }, 409);
    }

    // Create an empty placeholder file to represent the folder
    const markerObject = await env.STORAGE.put(folderPath + '.folder', new Uint8Array(0));
    await upsertSearchFolderRow(env, folderItemPath, markerObject);

    return jsonResponse({ success: true, message: '文件夹创建成功', path: '/' + folderPath.slice(0, -1) });
  } catch (e) {
    return jsonResponse({ success: false, message: '创建文件夹失败: ' + e.message }, 500);
  }
}

async function handleDownloadFile(request, env, path, ctx) {
  const auth = await verifyAuth(request, env);
  if (!auth) {
    return jsonResponse({ success: false, message: '未授权' }, 401);
  }

  try {
    let key = path || '';
    if (key.startsWith('/')) key = key.slice(1);
    const itemPath = r2KeyToPath(key);
    const permissionError = await requirePathPermission(env, auth, 'download', itemPath);
    if (permissionError) return permissionError;

    const current = await getIndexedResourceInfoWithInitialSync(env, itemPath);
    if (!current || current.itemType !== 'file') {
      return jsonResponse({ success: false, message: '文件不存在' }, 404);
    }
    const resolved = await getIndexedR2Object(env, current);
    if (!resolved) {
      await deferBackground(ctx, markIndexedResourceStale(env, current));
      return jsonResponse({ success: false, message: '文件不存在' }, 404);
    }
    const object = resolved.object;
    if (!r2ObjectMatchesIndexedResource(current, resolved.key, object)) {
      await upsertSearchFileFromR2Object(env, resolved.key, object);
      return jsonResponse({ success: false, message: '文件已变化，请重试' }, 409);
    }

    const filename = nameFromItemPath(itemPath);
    await deferBackground(ctx, recordRecentVisit(env, auth, {
      path: itemPath,
      name: filename,
      itemType: 'file',
      sizeFormatted: formatFileSize(object.size || 0),
      previewType: getPreviewType(filename) || ''
    }));

    return new Response(object.body, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType || getMimeType(filename),
        'Content-Disposition': createAttachmentDisposition(filename),
        'Content-Length': object.size
      }
    });
  } catch (e) {
    return jsonResponse({ success: false, message: '下载失败: ' + e.message }, 500);
  }
}

// Preview file handler - returns file content for inline viewing
async function handlePreviewFile(request, env, path, ctx) {
  const auth = await verifyAuth(request, env);
  if (!auth) {
    return jsonResponse({ success: false, message: '未授权' }, 401);
  }

  try {
    let key = path || '';
    if (key.startsWith('/')) key = key.slice(1);
    const itemPath = r2KeyToPath(key);
    const permissionError = await requirePathPermission(env, auth, 'preview', itemPath);
    if (permissionError) return permissionError;

    const current = await getIndexedResourceInfoWithInitialSync(env, itemPath);
    if (!current || current.itemType !== 'file') {
      return jsonResponse({ success: false, message: '文件不存在' }, 404);
    }
    const resolved = await getIndexedR2Object(env, current, { range: request.headers });
    if (!resolved) {
      await deferBackground(ctx, markIndexedResourceStale(env, current));
      return jsonResponse({ success: false, message: '文件不存在' }, 404);
    }
    const object = resolved.object;
    if (!r2ObjectMatchesIndexedResource(current, resolved.key, object)) {
      await upsertSearchFileFromR2Object(env, resolved.key, object);
      return jsonResponse({ success: false, message: '文件已变化，请重试' }, 409);
    }

    const filename = nameFromItemPath(itemPath);
    const contentType = object.httpMetadata?.contentType || getMimeType(filename);
    await deferBackground(ctx, recordRecentVisit(env, auth, {
      path: itemPath,
      name: filename,
      itemType: 'file',
      sizeFormatted: formatFileSize(object.size || 0),
      previewType: getPreviewType(filename) || ''
    }));
    const headers = new Headers({
      'Content-Type': contentType,
      'Content-Disposition': createInlineDisposition(filename),
      'Cache-Control': 'private, max-age=3600',
      'Accept-Ranges': 'bytes'
    });

    if (object.httpEtag) {
      headers.set('ETag', object.httpEtag);
    }

    if (object.range && typeof object.range.offset === 'number') {
      const rangeLength = typeof object.range.length === 'number' ? object.range.length : null;
      const end = object.range.end ?? (rangeLength === null
        ? object.size - 1
        : object.range.offset + rangeLength - 1);
      headers.set('Content-Range', `bytes ${object.range.offset}-${end}/${object.size}`);
      headers.set('Content-Length', String(end - object.range.offset + 1));
      return new Response(object.body, {
        status: 206,
        headers
      });
    }

    headers.set('Content-Length', String(object.size));

    return new Response(object.body, {
      headers
    });
  } catch (e) {
    return jsonResponse({ success: false, message: '预览失败: ' + e.message }, 500);
  }
}

function isTxtReaderPath(path) {
  return typeof path === 'string' && path.toLowerCase().endsWith('.txt');
}

async function readerProgressKey(auth, path, storageId = 'legacy-default', legacy = false) {
  const normalizedPath = normalizeItemPath(path);
  const pathHash = await sha256Hex(legacy ? normalizedPath : `${storageId}\n${normalizedPath}`);
  if (auth.role === 'admin') {
    return `reader:admin:${pathHash}`;
  }
  return `reader:user:${auth.email}:${pathHash}`;
}

function normalizeReaderNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function readerProgressRowToClient(row) {
  if (!row) return null;
  return {
    storageId: row.storage_id,
    path: row.path,
    charOffset: Number(row.char_offset || 0),
    byteOffset: Number(row.byte_offset || 0),
    anchorCharOffset: Number(row.anchor_char_offset || row.char_offset || 0),
    anchorByteOffset: Number(row.anchor_byte_offset || row.byte_offset || 0),
    anchorRatio: Number(row.anchor_ratio || 0),
    sourceEtag: row.source_etag || null,
    progress: Number(row.progress || 0),
    scrollTop: Number(row.scroll_top || 0),
    scrollHeight: Number(row.scroll_height || 0),
    revision: Number(row.revision || 0),
    updatedAt: Number(row.updated_at || 0)
  };
}

async function getD1ReaderProgress(env, ownerKey, filePath) {
  if (!env.D1_DB) return null;
  return env.D1_DB.prepare(`
    SELECT * FROM reader_progress
    WHERE owner_key = ? AND storage_id = ? AND path = ?
  `).bind(ownerKey, env.STORAGE_ID, filePath).first();
}

async function insertLegacyReaderProgress(env, ownerKey, progress) {
  if (!env.D1_DB || !progress) return;
  await env.D1_DB.prepare(`
    INSERT INTO reader_progress (
      owner_key, storage_id, path, source_etag, char_offset, byte_offset,
      anchor_char_offset, anchor_byte_offset, anchor_ratio, progress,
      scroll_top, scroll_height, revision, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(owner_key, storage_id, path) DO NOTHING
  `).bind(
    ownerKey,
    env.STORAGE_ID,
    progress.path,
    progress.sourceEtag || null,
    Number(progress.charOffset || 0),
    Number(progress.byteOffset || 0),
    Number(progress.anchorCharOffset || progress.charOffset || 0),
    Number(progress.anchorByteOffset || progress.byteOffset || 0),
    Number(progress.anchorRatio || 0),
    Number(progress.progress || 0),
    Number(progress.scrollTop || 0),
    Number(progress.scrollHeight || 0),
    Number(progress.updatedAt || Date.now())
  ).run();
}

async function validateReaderProgressPath(env, auth, rawPath) {
  const filePath = normalizeItemPath(rawPath || '');
  if (!filePath || filePath === '/' || !isTxtReaderPath(filePath)) {
    return { error: jsonResponse({ success: false, message: '只支持保存 txt 文件阅读进度' }, 400) };
  }
  const permissionError = await requirePathPermission(env, auth, 'preview', filePath);
  if (permissionError) return { error: permissionError };
  const current = await getIndexedResourceInfoWithInitialSync(env, filePath);
  if (!current || current.itemType !== 'file') {
    return { error: jsonResponse({ success: false, message: '文件不存在' }, 404) };
  }
  return {
    filePath,
    current,
    sourceEtag: current.resourceEtag || currentTxtEtag(current.object),
    size: Number(current.size || current.object?.size || 0)
  };
}

async function loadReaderProgressForAuth(env, auth, filePath, sourceEtag, ctx) {
  const ownerKey = ownerKeyFromAuth(auth);
  let progress = readerProgressRowToClient(await getD1ReaderProgress(env, ownerKey, filePath));
  if (!progress && env.KV_STORE) {
    const key = await readerProgressKey(auth, filePath, env.STORAGE_ID);
    let legacy = await env.KV_STORE.get(key, 'json');
    if (!legacy && env.STORAGE_ID === 'legacy-default') {
      legacy = await env.KV_STORE.get(await readerProgressKey(auth, filePath, env.STORAGE_ID, true), 'json');
    }
    if (legacy) {
      progress = { ...legacy, storageId: env.STORAGE_ID, path: filePath, revision: 1 };
      await insertLegacyReaderProgress(env, ownerKey, progress);
    }
  }
  if (progress && progress.sourceEtag && progress.sourceEtag !== sourceEtag) return null;
  return progress;
}

async function handleGetReaderProgress(request, env, ctx) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const url = new URL(request.url);
    const checked = await validateReaderProgressPath(env, auth, url.searchParams.get('path'));
    if (checked.error) return checked.error;
    const existing = await getD1ReaderProgress(env, ownerKeyFromAuth(auth), checked.filePath);
    if (existing && existing.source_etag && existing.source_etag !== checked.sourceEtag) {
      return jsonResponse({ success: true, progress: null, stale: true, sourceEtag: checked.sourceEtag });
    }
    const progress = await loadReaderProgressForAuth(env, auth, checked.filePath, checked.sourceEtag, ctx);
    return jsonResponse({ success: true, progress: progress || null, sourceEtag: checked.sourceEtag });
  } catch (e) {
    return jsonResponse({ success: false, message: '读取阅读进度失败: ' + e.message }, 500);
  }
}

async function handlePutReaderProgress(request, env, ctx) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const body = await request.json();
    const checked = await validateReaderProgressPath(env, auth, body.path);
    if (checked.error) return checked.error;
    if (body.sourceEtag && body.sourceEtag !== checked.sourceEtag) {
      return jsonResponse({ success: false, message: '文件已变化，请重新加载' }, 412, { ETag: checked.sourceEtag });
    }

    const value = {
      path: checked.filePath,
      charOffset: Math.floor(normalizeReaderNumber(body.charOffset, 0, 0, Number.MAX_SAFE_INTEGER)),
      byteOffset: Math.floor(normalizeReaderNumber(body.byteOffset, 0, 0, checked.size)),
      anchorCharOffset: Math.floor(normalizeReaderNumber(body.anchorCharOffset, body.charOffset || 0, 0, Number.MAX_SAFE_INTEGER)),
      anchorByteOffset: Math.floor(normalizeReaderNumber(body.anchorByteOffset, body.byteOffset || 0, 0, checked.size)),
      sourceEtag: checked.sourceEtag,
      progress: normalizeReaderNumber(body.progress, 0, 0, 1),
      anchorRatio: normalizeReaderNumber(body.anchorRatio, 0, 0, 1),
      scrollTop: normalizeReaderNumber(body.scrollTop, 0, 0, Number.MAX_SAFE_INTEGER),
      scrollHeight: normalizeReaderNumber(body.scrollHeight, 0, 0, Number.MAX_SAFE_INTEGER),
      updatedAt: Date.now()
    };
    const ownerKey = ownerKeyFromAuth(auth);
    const existing = await getD1ReaderProgress(env, ownerKey, checked.filePath);
    const hasBaseRevision = Number.isSafeInteger(Number(body.baseRevision)) && Number(body.baseRevision) >= 0;
    const baseRevision = hasBaseRevision ? Number(body.baseRevision) : Number(existing?.revision || 0);
    if ((existing && !hasBaseRevision) || (hasBaseRevision && Number(existing?.revision || 0) !== baseRevision)) {
      return jsonResponse({
        success: false,
        code: 'READER_PROGRESS_CONFLICT',
        message: '阅读进度已在其他设备更新',
        progress: readerProgressRowToClient(existing)
      }, 409);
    }

    let writeResult;
    if (existing) {
      writeResult = await env.D1_DB.prepare(`
        UPDATE reader_progress
        SET source_etag = ?, char_offset = ?, byte_offset = ?,
            anchor_char_offset = ?, anchor_byte_offset = ?, anchor_ratio = ?,
            progress = ?, scroll_top = ?, scroll_height = ?,
            revision = revision + 1, updated_at = ?
        WHERE owner_key = ? AND storage_id = ? AND path = ? AND revision = ?
      `).bind(
        value.sourceEtag,
        value.charOffset,
        value.byteOffset,
        value.anchorCharOffset,
        value.anchorByteOffset,
        value.anchorRatio,
        value.progress,
        value.scrollTop,
        value.scrollHeight,
        value.updatedAt,
        ownerKey,
        env.STORAGE_ID,
        value.path,
        baseRevision
      ).run();
    } else {
      try {
        writeResult = await env.D1_DB.prepare(`
          INSERT INTO reader_progress (
            owner_key, storage_id, path, source_etag, char_offset, byte_offset,
            anchor_char_offset, anchor_byte_offset, anchor_ratio, progress,
            scroll_top, scroll_height, revision, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        `).bind(
          ownerKey,
          env.STORAGE_ID,
          value.path,
          value.sourceEtag,
          value.charOffset,
          value.byteOffset,
          value.anchorCharOffset,
          value.anchorByteOffset,
          value.anchorRatio,
          value.progress,
          value.scrollTop,
          value.scrollHeight,
          value.updatedAt
        ).run();
      } catch {
        writeResult = null;
      }
    }

    if (!writeResult || Number(writeResult.meta?.changes ?? 1) === 0) {
      const latest = await getD1ReaderProgress(env, ownerKey, checked.filePath);
      return jsonResponse({
        success: false,
        code: 'READER_PROGRESS_CONFLICT',
        message: '阅读进度已在其他设备更新',
        progress: readerProgressRowToClient(latest)
      }, 409);
    }

    const saved = readerProgressRowToClient(await getD1ReaderProgress(env, ownerKey, checked.filePath));
    if (env.KV_STORE) {
      const key = await readerProgressKey(auth, checked.filePath, env.STORAGE_ID);
      await deferBackground(ctx, env.KV_STORE.put(key, JSON.stringify(saved)));
    }
    return jsonResponse({ success: true, progress: saved });
  } catch (e) {
    return jsonResponse({ success: false, message: '保存阅读进度失败: ' + e.message }, 500);
  }
}

function readerBookmarkToClient(row) {
  return {
    storageId: row.storage_id,
    id: row.id,
    path: row.path,
    charOffset: Number(row.char_offset || 0),
    byteOffset: row.source_etag ? Number(row.byte_offset || 0) : null,
    anchorRatio: row.anchor_ratio === null || row.anchor_ratio === undefined
      ? null
      : Number(row.anchor_ratio),
    sourceEtag: row.source_etag || null,
    progress: Number(row.progress || 0),
    snippet: row.snippet || '',
    createdAt: Number(row.created_at || 0)
  };
}

async function validateReaderBookmarkPath(env, auth, rawPath) {
  const filePath = normalizeItemPath(rawPath || '');
  if (!filePath || filePath === '/' || !isTxtReaderPath(filePath)) {
    return { error: jsonResponse({ success: false, message: '书签只支持 txt 文件' }, 400) };
  }
  const permissionError = await requirePathPermission(env, auth, 'preview', filePath);
  if (permissionError) return { error: permissionError };
  const current = await getIndexedResourceInfoWithInitialSync(env, filePath);
  if (!current || current.itemType !== 'file') {
    return { error: jsonResponse({ success: false, message: '文件不存在' }, 404) };
  }
  return {
    filePath,
    resolved: { key: current.key, object: current.object },
    sourceEtag: current.resourceEtag || currentTxtEtag(current.object),
    size: Number(current.size || current.object?.size || 0)
  };
}

async function handleReaderBookmarks(request, env) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    await ensureD1Schema(env);
    const ownerKey = ownerKeyFromAuth(auth);

    if (request.method === 'GET') {
      const checked = await validateReaderBookmarkPath(
        env,
        auth,
        new URL(request.url).searchParams.get('path')
      );
      if (checked.error) return checked.error;
      const result = await env.D1_DB.prepare(`
        SELECT storage_id, id, path, char_offset, byte_offset, anchor_ratio, source_etag, progress, snippet, created_at
        FROM reader_bookmarks
        WHERE owner_key = ? AND storage_id = ? AND path = ?
          AND (source_etag IS NULL OR source_etag = ?)
        ORDER BY created_at DESC
        LIMIT 200
      `).bind(ownerKey, env.STORAGE_ID, checked.filePath, checked.sourceEtag).all();
      return jsonResponse({
        success: true,
        bookmarks: (result.results || []).map(readerBookmarkToClient)
      });
    }

    if (request.method === 'POST') {
      const body = await request.json();
      const checked = await validateReaderBookmarkPath(env, auth, body.path);
      if (checked.error) return checked.error;
      const charOffset = Math.floor(normalizeReaderNumber(body.charOffset, 0, 0, Number.MAX_SAFE_INTEGER));
      const byteOffset = Math.floor(normalizeReaderNumber(body.byteOffset, 0, 0, checked.size));
      const anchorRatio = normalizeReaderNumber(body.anchorRatio, 0, 0, 1);
      if (body.sourceEtag && body.sourceEtag !== checked.sourceEtag) {
        return jsonResponse({ success: false, message: '文件已变化，请重新加载' }, 412, { ETag: checked.sourceEtag });
      }
      const progress = normalizeReaderNumber(body.progress, 0, 0, 1);
      const snippet = String(body.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      const duplicate = await env.D1_DB.prepare(`
        SELECT id FROM reader_bookmarks
        WHERE owner_key = ? AND storage_id = ? AND path = ? AND ABS(char_offset - ?) <= 2
          AND ABS(COALESCE(anchor_ratio, 0) - ?) <= 0.002
        LIMIT 1
      `).bind(ownerKey, env.STORAGE_ID, checked.filePath, charOffset, anchorRatio).first();
      if (duplicate) {
        return jsonResponse({ success: false, message: '当前位置已经有书签' }, 409);
      }
      const bookmark = {
        storageId: env.STORAGE_ID,
        id: generateId(20),
        path: checked.filePath,
        charOffset,
        byteOffset,
        anchorRatio,
        sourceEtag: checked.sourceEtag,
        progress,
        snippet,
        createdAt: Date.now()
      };
      await env.D1_DB.prepare(`
        INSERT INTO reader_bookmarks (id, storage_id, owner_key, path, char_offset, byte_offset, anchor_ratio, source_etag, progress, snippet, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        bookmark.id,
        env.STORAGE_ID,
        ownerKey,
        bookmark.path,
        bookmark.charOffset,
        bookmark.byteOffset,
        bookmark.anchorRatio,
        bookmark.sourceEtag,
        bookmark.progress,
        bookmark.snippet,
        bookmark.createdAt
      ).run();
      return jsonResponse({ success: true, bookmark }, 201);
    }

    return jsonResponse({ success: false, message: '方法不支持' }, 405);
  } catch (e) {
    return jsonResponse({ success: false, message: '书签操作失败: ' + e.message }, 500);
  }
}

async function handleDeleteReaderBookmark(request, env, bookmarkId) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    await env.D1_DB.prepare('DELETE FROM reader_bookmarks WHERE id = ? AND owner_key = ? AND storage_id = ?')
      .bind(bookmarkId, ownerKeyFromAuth(auth), env.STORAGE_ID).run();
    return jsonResponse({ success: true });
  } catch (e) {
    return jsonResponse({ success: false, message: '删除书签失败: ' + e.message }, 500);
  }
}

async function deleteReaderProgressForUser(env, email) {
  const prefix = `reader:user:${email}:`;
  let cursor;

  do {
    const listed = await env.KV_STORE.list({ prefix, cursor });
    await Promise.all(listed.keys.map(key => env.KV_STORE.delete(key.name)));
    cursor = listed.list_complete ? null : listed.cursor;
  } while (cursor);

  if (env.D1_DB) {
    await env.D1_DB.batch([
      env.D1_DB.prepare('DELETE FROM reader_bookmarks WHERE owner_key = ?').bind(`user:${email}`),
      env.D1_DB.prepare('DELETE FROM reader_progress WHERE owner_key = ?').bind(`user:${email}`)
    ]);
  }
}

function shareRowToClient(row) {
  return {
    storageId: row.storage_id,
    shareId: row.share_id,
    filePath: row.file_path,
    fileName: row.file_name,
    fileSize: row.file_size || 0,
    passwordHash: row.password_hash || null,
    expiresAt: row.expires_at ?? null,
    viewCount: row.view_count || 0,
    downloadCount: row.download_count || 0,
    itemsInitialized: Number(row.items_initialized || 0),
    createdAt: row.created_at || 0,
    revokedAt: row.revoked_at || null
  };
}

function shareItemRowToClient(row) {
  return {
    storageId: row.storage_id,
    path: normalizeItemPath(row.item_path),
    name: row.item_name || nameFromItemPath(row.item_path),
    itemType: row.item_type === 'folder' ? 'folder' : 'file',
    sortOrder: row.sort_order || 0,
    resourceKey: row.resource_key || null,
    resourceVersion: row.resource_version || null,
    resourceEtag: row.resource_etag || null
  };
}

function isPathWithinFolder(folderPath, targetPath) {
  const folder = normalizeDirectoryPath(folderPath);
  const target = normalizeItemPath(targetPath);
  return target === folder || target.startsWith(folder + '/');
}

async function describeShareItem(env, rawPath) {
  const path = normalizeItemPath(rawPath);
  if (!path || path === '/') throw new Error('不能分享根目录');
  const current = await getIndexedResourceInfoWithInitialSync(env, path);
  if (current?.itemType === 'file') {
    const object = current.object;
    return {
      path,
      name: nameFromItemPath(path),
      itemType: 'file',
      size: object.size || 0,
      lastModified: isoDateString(object.uploaded),
      previewType: getPreviewType(nameFromItemPath(path)),
      resourceKey: current.resourceKey,
      resourceVersion: current.resourceVersion,
      resourceEtag: current.resourceEtag
    };
  }
  if (current?.itemType === 'folder') {
    return {
      path,
      name: nameFromItemPath(path),
      itemType: 'folder',
      size: 0,
      lastModified: null,
      previewType: null,
      resourceKey: current.resourceKey,
      resourceVersion: current.resourceVersion,
      resourceEtag: current.resourceEtag
    };
  }

  throw new Error('项目不存在: ' + path);
}

async function upsertD1Share(env, share) {
  const storageId = share.storageId || env.STORAGE_ID || 'legacy-default';
  await env.D1_DB.prepare(`
    INSERT INTO share_links (
      share_id, storage_id, file_path, file_name, file_size, password_hash, expires_at, view_count, download_count, items_initialized, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(share_id) DO NOTHING
  `).bind(
    share.shareId,
    storageId,
    share.filePath,
    share.fileName,
    share.fileSize || 0,
    share.passwordHash || null,
    share.expiresAt ?? null,
    share.viewCount || 0,
    share.downloadCount || 0,
    1,
    share.createdAt || Date.now()
  ).run();

  if (Array.isArray(share.items) && share.items.length > 0) {
    const insertItem = env.D1_DB.prepare(`
      INSERT OR IGNORE INTO share_items (
        share_id, storage_id, item_path, item_name, item_type, sort_order, resource_key, resource_version, resource_etag, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    await env.D1_DB.batch(share.items.map((item, index) => insertItem.bind(
      share.shareId,
      storageId,
      normalizeItemPath(item.path),
      item.name || nameFromItemPath(item.path),
      item.itemType === 'folder' ? 'folder' : 'file',
      Number.isFinite(item.sortOrder) ? item.sortOrder : index,
      item.resourceKey || null,
      item.resourceVersion || null,
      item.resourceEtag || null,
      share.createdAt || Date.now()
    )));
  }
}

async function getD1ShareItems(env, share) {
  const rows = await env.D1_DB.prepare(`
    SELECT * FROM share_items
    WHERE share_id = ? AND storage_id = ?
    ORDER BY sort_order ASC, item_name ASC
  `).bind(share.shareId, share.storageId || env.STORAGE_ID || 'legacy-default').all();

  const items = (rows.results || []).map(shareItemRowToClient);
  if (items.length > 0) return items;

  if (share.itemsInitialized === 1) return [];

  const fallbackPath = r2KeyToPath(share.filePath || '');
  if (!fallbackPath || fallbackPath === '/') return [];
  const fallbackItem = {
    path: fallbackPath,
    name: share.fileName || nameFromItemPath(fallbackPath),
    itemType: 'file',
    sortOrder: 0,
    resourceKey: null,
    resourceVersion: null,
    resourceEtag: null
  };

  const current = await getIndexedResourceInfo(env, fallbackItem.path);
  if (!current || current.itemType !== 'file') {
    await env.D1_DB.prepare('UPDATE share_links SET items_initialized = 1 WHERE share_id = ? AND storage_id = ?')
      .bind(share.shareId, share.storageId || env.STORAGE_ID || 'legacy-default').run();
    return [];
  }
  fallbackItem.resourceKey = current.resourceKey;
  fallbackItem.resourceVersion = current.resourceVersion;
  fallbackItem.resourceEtag = current.resourceEtag;

  await env.D1_DB.prepare(`
    INSERT OR IGNORE INTO share_items (
      share_id, storage_id, item_path, item_name, item_type, sort_order, resource_key, resource_version, resource_etag, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    share.shareId,
    share.storageId || env.STORAGE_ID || 'legacy-default',
    fallbackItem.path,
    fallbackItem.name,
    fallbackItem.itemType,
    0,
    fallbackItem.resourceKey,
    fallbackItem.resourceVersion,
    fallbackItem.resourceEtag,
    share.createdAt || Date.now()
  ).run();
  await env.D1_DB.prepare('UPDATE share_links SET items_initialized = 1 WHERE share_id = ? AND storage_id = ?')
    .bind(share.shareId, share.storageId || env.STORAGE_ID || 'legacy-default').run();

  return [fallbackItem];
}

async function getD1Share(env, shareId) {
  const row = await env.D1_DB.prepare('SELECT * FROM share_links WHERE share_id = ?').bind(shareId).first();
  if (row) {
    const share = shareRowToClient(row);
    const scopedEnv = { ...env, STORAGE_ID: share.storageId };
    share.items = await getD1ShareItems(scopedEnv, share);
    return share;
  }

  const legacyData = await env.KV_STORE.get(`share:${shareId}`);
  if (!legacyData) return null;

  const legacyShare = JSON.parse(legacyData);
  legacyShare.storageId = env.STORAGE_ID || 'legacy-default';
  legacyShare.items = [{
    path: r2KeyToPath(legacyShare.filePath || ''),
    name: legacyShare.fileName || nameFromItemPath(legacyShare.filePath || ''),
    itemType: 'file'
  }];
  const scopedEnv = { ...env, STORAGE_ID: legacyShare.storageId };
  await upsertD1Share(scopedEnv, legacyShare);
  legacyShare.items = await getD1ShareItems(scopedEnv, legacyShare);
  return legacyShare;
}

async function getShareState(env, share) {
  const validItems = [];
  const invalidItems = [];
  const items = Array.isArray(share?.items) ? share.items : [];
  const indexedMap = await getIndexedResourceInfoMap(env, items.map(item => item.path));

  for (const item of items) {
    const current = indexedMap.get(normalizeItemPath(item.path));
    if (!current || current.itemType !== item.itemType) {
      invalidItems.push(item);
      continue;
    }
    const binding = resourceBindingMatches(current, item);
    if (binding === false) {
      invalidItems.push(item);
      continue;
    }
    validItems.push({ ...item, current });
  }

  const state = validItems.length === 0
    ? 'orphaned'
    : invalidItems.length > 0
      ? 'partial'
      : 'active';
  return { state, validItems, invalidItems, allItems: items };
}

function shareStateGoneResponse(state) {
  return jsonResponse({
    success: false,
    state: state.state,
    message: '分享链接对应的文件已不存在'
  }, 410);
}

async function migrateLegacySharesToD1(env) {
  const marker = await env.D1_DB.prepare('SELECT value FROM app_stats WHERE storage_id = ? AND key = ?')
    .bind(env.STORAGE_ID || 'legacy-default', 'legacySharesMigrated')
    .first();
  if (marker) return 0;

  let cursor;
  let migrated = 0;

  do {
    const listed = await env.KV_STORE.list({ prefix: 'share:', cursor });
    for (const key of listed.keys) {
      const data = await env.KV_STORE.get(key.name);
      if (!data) continue;
      try {
        const legacyShare = JSON.parse(data);
        legacyShare.storageId = env.STORAGE_ID || 'legacy-default';
        if (!Array.isArray(legacyShare.items) || legacyShare.items.length === 0) {
          legacyShare.items = [{
            path: r2KeyToPath(legacyShare.filePath || ''),
            name: legacyShare.fileName || nameFromItemPath(legacyShare.filePath || ''),
            itemType: 'file'
          }];
        }
        await upsertD1Share(env, legacyShare);
        migrated++;
      } catch (error) {
        console.warn('Legacy share migration failed:', key.name, error.message);
      }
    }
    cursor = listed.list_complete ? null : listed.cursor;
  } while (cursor);

  await reconcileD1StatsMinimums(env);
  await env.D1_DB.prepare(`
    INSERT INTO app_stats (storage_id, key, value, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(storage_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).bind(env.STORAGE_ID || 'legacy-default', 'legacySharesMigrated', 1, Date.now()).run();
  return migrated;
}

async function getLegacyStat(env, key) {
  const value = await env.KV_STORE.get(`stats:${key}`);
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function calculateD1StatFallback(env, key) {
  const legacy = await getLegacyStat(env, key);
  let aggregate = 0;

  if (key === 'totalShares') {
    const row = await env.D1_DB.prepare('SELECT COUNT(*) AS value FROM share_links WHERE storage_id = ?').bind(env.STORAGE_ID).first();
    aggregate = Number(row?.value || 0);
  } else if (key === 'totalViews') {
    const row = await env.D1_DB.prepare('SELECT COALESCE(SUM(view_count), 0) AS value FROM share_links WHERE storage_id = ?').bind(env.STORAGE_ID).first();
    aggregate = Number(row?.value || 0);
  } else if (key === 'totalDownloads') {
    const row = await env.D1_DB.prepare('SELECT COALESCE(SUM(download_count), 0) AS value FROM share_links WHERE storage_id = ?').bind(env.STORAGE_ID).first();
    aggregate = Number(row?.value || 0);
  }

  return Math.max(legacy ?? 0, aggregate);
}

async function ensureD1Stat(env, key) {
  await ensureD1Schema(env);
  const existing = await env.D1_DB.prepare('SELECT value FROM app_stats WHERE storage_id = ? AND key = ?').bind(env.STORAGE_ID, key).first();
  if (existing) return Number(existing.value || 0);

  const value = await calculateD1StatFallback(env, key);
  await env.D1_DB.prepare(`
    INSERT OR IGNORE INTO app_stats (storage_id, key, value, updated_at)
    VALUES (?, ?, ?, ?)
  `).bind(env.STORAGE_ID, key, value, Date.now()).run();

  const row = await env.D1_DB.prepare('SELECT value FROM app_stats WHERE storage_id = ? AND key = ?').bind(env.STORAGE_ID, key).first();
  return Number(row?.value || value);
}

async function changeD1Stat(env, key, delta) {
  await ensureD1Stat(env, key);
  await env.D1_DB.prepare(`
    UPDATE app_stats
    SET value = MAX(0, value + ?), updated_at = ?
    WHERE storage_id = ? AND key = ?
  `).bind(delta, Date.now(), env.STORAGE_ID, key).run();
}

async function reconcileD1StatsMinimums(env) {
  await ensureD1Schema(env);
  const totals = {
    totalShares: Number((await env.D1_DB.prepare('SELECT COUNT(*) AS value FROM share_links WHERE storage_id = ?').bind(env.STORAGE_ID).first())?.value || 0),
    totalViews: Number((await env.D1_DB.prepare('SELECT COALESCE(SUM(view_count), 0) AS value FROM share_links WHERE storage_id = ?').bind(env.STORAGE_ID).first())?.value || 0),
    totalDownloads: Number((await env.D1_DB.prepare('SELECT COALESCE(SUM(download_count), 0) AS value FROM share_links WHERE storage_id = ?').bind(env.STORAGE_ID).first())?.value || 0)
  };

  for (const [key, value] of Object.entries(totals)) {
    const existing = await env.D1_DB.prepare('SELECT value FROM app_stats WHERE storage_id = ? AND key = ?').bind(env.STORAGE_ID, key).first();
    if (!existing) continue;
    await env.D1_DB.prepare(`
      UPDATE app_stats
      SET value = MAX(value, ?), updated_at = ?
      WHERE storage_id = ? AND key = ?
    `).bind(value, Date.now(), env.STORAGE_ID, key).run();
  }
}

async function getD1Stats(env) {
  return {
    totalShares: await ensureD1Stat(env, 'totalShares'),
    totalViews: await ensureD1Stat(env, 'totalViews'),
    totalDownloads: await ensureD1Stat(env, 'totalDownloads')
  };
}

// ============================================================================
// SHARE HANDLERS
// ============================================================================

async function handleCreateShare(request, env) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const body = await request.json();
    const { filePath, password, expiresIn } = body;
    const requestedItems = Array.isArray(body.items) && body.items.length > 0
      ? body.items
      : (filePath ? [{ path: filePath }] : []);

    if (requestedItems.length === 0) {
      return jsonResponse({ success: false, message: '请选择要分享的文件或文件夹' }, 400);
    }

    const seenPaths = new Set();
    const shareItems = [];

    for (const rawItem of requestedItems) {
      const rawPath = typeof rawItem === 'string' ? rawItem : rawItem?.path;
      const itemPath = normalizeItemPath(rawPath);
      if (!itemPath || itemPath === '/') {
        return jsonResponse({ success: false, message: '不能分享根目录' }, 400);
      }
      if (seenPaths.has(itemPath)) continue;

      const permissionError = await requirePathPermission(env, auth, 'share', itemPath);
      if (permissionError) return permissionError;

      const item = await describeShareItem(env, itemPath);
      seenPaths.add(item.path);
      shareItems.push(item);
    }

    if (shareItems.length === 0) {
      return jsonResponse({ success: false, message: '请选择要分享的文件或文件夹' }, 400);
    }

    let shareId = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateId(12);
      if (!(await getD1Share(env, candidate))) {
        shareId = candidate;
        break;
      }
    }
    if (!shareId) {
      throw new Error('分享 ID 生成失败，请重试');
    }

    const firstItem = shareItems[0];
    const shareData = {
      storageId: env.STORAGE_ID,
      shareId,
      filePath: itemPathToR2Key(firstItem.path),
      fileName: shareItems.length === 1 ? firstItem.name : shareItems.length + ' 个项目',
      fileSize: shareItems.length === 1 && firstItem.itemType === 'file' ? firstItem.size : 0,
      passwordHash: password ? await hashPassword(password) : null,
      expiresAt: getExpirationTime(expiresIn || '1d'),
      viewCount: 0,
      downloadCount: 0,
      createdAt: Date.now(),
      items: shareItems
    };

    await upsertD1Share(env, shareData);
    await changeD1Stat(env, 'totalShares', 1);

    return jsonResponse({
      storageId: env.STORAGE_ID,
      success: true,
      shareId,
      shareUrl: `/s/${shareId}`
    });
  } catch (e) {
    return jsonResponse({ success: false, message: '创建分享链接失败: ' + e.message }, 500);
  }
}

async function readShareRequestBody(request) {
  return await request.json().catch(() => ({}));
}

async function validateSharePassword(share, body) {
  if (!share.passwordHash) return null;

  const password = body?.password || '';
  if (!password) {
    return jsonResponse({ success: false, message: '请输入密码' }, 401);
  }

  const passwordHash = await hashPassword(password);
  if (passwordHash !== share.passwordHash) {
    return jsonResponse({ success: false, message: '密码错误' }, 401);
  }
  return null;
}

function findSharedFolderForPath(share, path) {
  const targetPath = normalizeItemPath(path);
  return (share.items || []).find(item => (
    item.itemType === 'folder' && isPathWithinFolder(item.path, targetPath)
  ));
}

function isSharedFilePath(share, path) {
  const targetPath = normalizeItemPath(path);
  return (share.items || []).some(item => (
    item.itemType === 'file' && normalizeItemPath(item.path) === targetPath
  ));
}

function isDownloadPathAllowedByShare(share, path) {
  const targetPath = normalizeItemPath(path);
  if (isSharedFilePath(share, targetPath)) return true;
  return (share.items || []).some(item => {
    if (item.itemType !== 'folder') return false;
    const folderPath = normalizeDirectoryPath(item.path);
    return targetPath.startsWith(folderPath + '/');
  });
}

async function buildShareRootListing(env, share, state) {
  const files = [];
  const folders = [];

  for (const item of state.validItems || []) {
    if (item.itemType === 'folder') {
      if (item.current && item.current.itemType === 'folder') {
        folders.push({
          name: item.name,
          path: normalizeItemPath(item.path)
        });
      }
      continue;
    }

    const object = item.current?.object;
    if (!object) continue;
    files.push({
      name: item.name,
      path: normalizeItemPath(item.path),
      size: object.size || 0,
      sizeFormatted: formatFileSize(object.size || 0),
      lastModified: isoDateString(object.uploaded),
      previewType: getPreviewType(item.name)
    });
  }

  folders.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  files.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));

  return {
    success: true,
    currentPath: '/',
    files,
    folders
  };
}

async function recordShareMetric(env, shareId, metric) {
  try {
    const now = Date.now();
    const isDownload = metric === 'download';
    const statKey = isDownload ? 'totalDownloads' : 'totalViews';
    const shareUpdate = isDownload
      ? env.D1_DB.prepare('UPDATE share_links SET download_count = download_count + 1 WHERE share_id = ? AND storage_id = ?').bind(shareId, env.STORAGE_ID)
      : env.D1_DB.prepare('UPDATE share_links SET view_count = view_count + 1 WHERE share_id = ? AND storage_id = ?').bind(shareId, env.STORAGE_ID);
    // Single UPDATE: app_stats totals are derived on demand by
    // reconcileD1StatsMinimums, so per-event aggregate writes are wasted D1
    // rows. One row written per share view/download instead of three.
    await shareUpdate.run();
  } catch (error) {
    console.warn('Share metric update failed:', error.message);
  }
}

async function createPublicShareRuntime(request, env, share) {
  if (env.STORAGE) return { ...env, STORAGE_ID: share.storageId || env.STORAGE_ID || 'legacy-default' };
  const url = new URL(request.url);
  url.searchParams.set('storageId', share.storageId);
  const runtime = await createStorageRuntime(new Request(url.toString()), env, { role: 'admin' });
  return runtime.env;
}

async function handleGetShareInfo(request, env, shareId, ctx) {
  try {
    await ensureD1Schema(env);
    const share = await getD1Share(env, shareId);
    if (!share) {
      return jsonResponse({ success: false, message: '分享链接不存在' }, 404);
    }
    if (share.revokedAt) return jsonResponse({ success: false, message: '分享链接已撤销' }, 410);
    env = await createPublicShareRuntime(request, env, share);

    // Check expiration
    if (share.expiresAt && Date.now() > share.expiresAt) {
      return jsonResponse({ success: false, message: '分享链接已过期' }, 410);
    }
    const state = await getShareState(env, share);
    if (state.state === 'orphaned') return shareStateGoneResponse(state);

    await deferBackground(ctx, recordShareMetric(env, shareId, 'view'));

    const visibleItems = state.validItems || [];
    const itemCount = visibleItems.length || 1;
    const firstItem = visibleItems[0] || null;

    return jsonResponse({
      success: true,
      fileName: share.fileName,
      fileSize: firstItem?.current?.size ?? share.fileSize,
      fileSizeFormatted: itemCount === 1 && firstItem?.itemType === 'folder'
        ? '文件夹'
        : formatFileSize(firstItem?.current?.size ?? share.fileSize),
      itemCount,
      state: state.state,
      validItemCount: state.validItems.length,
      invalidItemCount: state.invalidItems.length,
      requiresPassword: !!share.passwordHash,
      expiresAt: share.expiresAt
    });
  } catch (e) {
    return jsonResponse({ success: false, message: '获取分享信息失败: ' + e.message }, 500);
  }
}

async function handleShareList(request, env, shareId) {
  try {
    await ensureD1Schema(env);
    const share = await getD1Share(env, shareId);
    if (!share) {
      return jsonResponse({ success: false, message: '分享链接不存在' }, 404);
    }
    if (share.revokedAt) return jsonResponse({ success: false, message: '分享链接已撤销' }, 410);
    env = await createPublicShareRuntime(request, env, share);

    if (share.expiresAt && Date.now() > share.expiresAt) {
      return jsonResponse({ success: false, message: '分享链接已过期' }, 410);
    }
    const state = await getShareState(env, share);
    if (state.state === 'orphaned') return shareStateGoneResponse(state);

    const body = await readShareRequestBody(request);
    const passwordError = await validateSharePassword(share, body);
    if (passwordError) return passwordError;

    const currentPath = normalizeDirectoryPath(body.path || '/');
    if (currentPath === '/') {
      const listing = await buildShareRootListing(env, share, state);
      return jsonResponse({ ...listing, state: state.state });
    }

    const sharedFolder = findSharedFolderForPath({ items: state.validItems }, currentPath);
    if (!sharedFolder) {
      return jsonResponse({ success: false, message: '无权访问该路径' }, 403);
    }

    const listing = await listDirectoryFromD1(env, currentPath);
    if (listing.folders.length === 0 && listing.files.length === 0) {
      const knownFolder = await env.D1_DB.prepare(
        "SELECT path FROM search_items WHERE storage_id = ? AND path = ? AND item_type = 'folder'"
      ).bind(env.STORAGE_ID, currentPath).first();
      if (!knownFolder) {
        return jsonResponse({ success: false, message: '文件夹不存在或索引待刷新' }, 404);
      }
    }
    return jsonResponse({
      storageId: env.STORAGE_ID,
      success: true,
      currentPath,
      state: state.state,
      files: listing.files,
      folders: listing.folders
    });
  } catch (e) {
    return jsonResponse({ success: false, message: '获取分享目录失败: ' + e.message }, 500);
  }
}

async function handleShareDownload(request, env, shareId, ctx) {
  try {
    await ensureD1Schema(env);
    const share = await getD1Share(env, shareId);
    if (!share) {
      return jsonResponse({ success: false, message: '分享链接不存在' }, 404);
    }
    if (share.revokedAt) return jsonResponse({ success: false, message: '分享链接已撤销' }, 410);
    env = await createPublicShareRuntime(request, env, share);

    // Check expiration
    if (share.expiresAt && Date.now() > share.expiresAt) {
      return jsonResponse({ success: false, message: '分享链接已过期' }, 410);
    }
    const state = await getShareState(env, share);
    if (state.state === 'orphaned') return shareStateGoneResponse(state);

    const body = await readShareRequestBody(request);
    const passwordError = await validateSharePassword(share, body);
    if (passwordError) return passwordError;

    let targetPath = body.path || body.filePath || body.targetPath || '';
    if (!targetPath && (share.items || []).length === 1 && share.items[0].itemType === 'file') {
      targetPath = share.items[0].path;
    }
    targetPath = normalizeItemPath(targetPath);

    if (!targetPath || targetPath === '/') {
      return jsonResponse({ success: false, message: '请选择要下载的文件' }, 400);
    }

    if (!isDownloadPathAllowedByShare({ items: state.validItems }, targetPath)) {
      return jsonResponse({ success: false, message: '无权下载该文件' }, 403);
    }

    // Get file from R2
    const filename = nameFromItemPath(targetPath);
    const current = await getIndexedResourceInfo(env, targetPath);
    if (!current || current.itemType !== 'file') {
      return jsonResponse({ success: false, message: '文件不存在' }, 404);
    }
    const directRoot = (state.validItems || []).find(item => item.itemType === 'file' && normalizeItemPath(item.path) === targetPath);
    if (directRoot && resourceBindingMatches(current, directRoot) !== true) {
      return jsonResponse({ success: false, state: 'orphaned', message: '分享文件已变化' }, 410);
    }
    const resolved = await getIndexedR2Object(env, current);
    if (!resolved || !resolved.object) {
      await deferBackground(ctx, markIndexedResourceStale(env, current));
      return jsonResponse({ success: false, message: '文件不存在' }, 404);
    }
    const object = resolved.object;
    if (!r2ObjectMatchesIndexedResource(current, resolved.key, object)) {
      await upsertSearchFileFromR2Object(env, resolved.key, object);
      return jsonResponse({ success: false, state: 'orphaned', message: '分享文件已变化' }, 410);
    }

    await deferBackground(ctx, recordShareMetric(env, shareId, 'download'));

    return new Response(object.body, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType || getMimeType(filename),
        'Content-Disposition': createAttachmentDisposition(filename),
        'Content-Length': object.size
      }
    });
  } catch (e) {
    return jsonResponse({ success: false, message: '下载失败: ' + e.message }, 500);
  }
}

// ============================================================================
// ADMIN HANDLERS
// ============================================================================

async function handleGetStats(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  try {
    await migrateLegacySharesToD1(env);
    const { totalShares, totalViews, totalDownloads } = await getD1Stats(env);

    return jsonResponse({
      storageId: env.STORAGE_ID,
      success: true,
      totalShares,
      totalViews,
      totalDownloads
    });
  } catch (e) {
    return jsonResponse({ success: false, message: '获取统计数据失败: ' + e.message }, 500);
  }
}

async function handleListShares(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  try {
    await migrateLegacySharesToD1(env);
    const rows = await env.D1_DB.prepare(`
      SELECT * FROM share_links
      WHERE storage_id = ?
      ORDER BY created_at DESC
      LIMIT 1000
    `).bind(env.STORAGE_ID).all();
    const shares = (rows.results || []).map(row => {
      const share = shareRowToClient(row);
      return {
        ...share,
        fileSizeFormatted: formatFileSize(share.fileSize),
        isExpired: share.expiresAt && Date.now() > share.expiresAt
      };
    });

    return jsonResponse({ success: true, shares });
  } catch (e) {
    return jsonResponse({ success: false, message: '获取分享列表失败: ' + e.message }, 500);
  }
}

async function handleDeleteShare(request, env, shareId) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  try {
    const existing = await getD1Share(env, shareId);
    await env.D1_DB.batch([
      env.D1_DB.prepare('DELETE FROM share_items WHERE share_id = ? AND storage_id = ?').bind(shareId, env.STORAGE_ID),
      env.D1_DB.prepare('DELETE FROM share_links WHERE share_id = ? AND storage_id = ?').bind(shareId, env.STORAGE_ID)
    ]);
    await env.KV_STORE.delete(`share:${shareId}`);
    if (existing) await changeD1Stat(env, 'totalShares', -1);

    return jsonResponse({ success: true, message: '分享链接已删除' });
  } catch (e) {
    return jsonResponse({ success: false, message: '删除分享链接失败: ' + e.message }, 500);
  }
}

async function handleListUsers(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  try {
    const users = [];
    let cursor;

    do {
      const listed = await env.KV_STORE.list({ prefix: 'user:', cursor });
      for (const key of listed.keys) {
        const data = await env.KV_STORE.get(key.name);
        if (data) {
          const user = JSON.parse(data);
          const permissionRows = await getUserPermissionRows(env, user.email);
          users.push({
            email: user.email,
            role: user.role,
            createdAt: user.createdAt,
            permissionCount: permissionRows.length,
            permissions: permissionRows.slice(0, 3).map(row => ({
              path: row.path,
              itemType: row.item_type,
              summary: summarizePermissionFlags(row)
            }))
          });
        }
      }
      cursor = listed.list_complete ? null : listed.cursor;
    } while (cursor);

    return jsonResponse({ success: true, users });
  } catch (e) {
    return jsonResponse({ success: false, message: '获取用户列表失败: ' + e.message }, 500);
  }
}

async function handleCreateUser(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  try {
    const body = await request.json();
    const { email, password } = body;
    const permissions = Array.isArray(body.permissions) ? body.permissions : [];

    if (!email || !password) {
      return jsonResponse({ success: false, message: '请提供邮箱和密码' }, 400);
    }

    // Check if user already exists
    const existing = await env.KV_STORE.get(`user:${email}`);
    if (existing) {
      return jsonResponse({ success: false, message: '用户已存在' }, 409);
    }

    const userData = {
      email,
      passwordHash: await hashPassword(password),
      role: 'user',
      createdAt: Date.now()
    };

    await env.KV_STORE.put(`user:${email}`, JSON.stringify(userData));
    await replaceUserPermissions(env, email, permissions);

    return jsonResponse({ success: true, message: '用户创建成功', email });
  } catch (e) {
    return jsonResponse({ success: false, message: '创建用户失败: ' + e.message }, 500);
  }
}

async function handleDeleteUser(request, env, email) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  try {
    const decodedEmail = decodeURIComponent(email);
    await env.KV_STORE.delete(`user:${decodedEmail}`);
    await deleteReaderProgressForUser(env, decodedEmail);
    await env.D1_DB.prepare('DELETE FROM user_permissions WHERE email = ?').bind(decodedEmail).run();

    return jsonResponse({ success: true, message: '用户已删除' });
  } catch (e) {
    return jsonResponse({ success: false, message: '删除用户失败: ' + e.message }, 500);
  }
}

async function handleGetUserPermissions(request, env, email) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  try {
    const decodedEmail = decodeURIComponent(email);
    const rows = await getUserPermissionRows(env, decodedEmail);
    return jsonResponse({ success: true, permissions: rows.map(permissionRowToClient) });
  } catch (e) {
    return jsonResponse({ success: false, message: '获取用户授权失败: ' + e.message }, 500);
  }
}

async function handleUpdateUserPermissions(request, env, email) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  try {
    const decodedEmail = decodeURIComponent(email);
    const existing = await env.KV_STORE.get(`user:${decodedEmail}`);
    if (!existing) {
      return jsonResponse({ success: false, message: '用户不存在' }, 404);
    }
    const body = await request.json();
    await replaceUserPermissions(env, decodedEmail, Array.isArray(body.permissions) ? body.permissions : []);
    return jsonResponse({ success: true, message: '用户授权已更新' });
  } catch (e) {
    return jsonResponse({ success: false, message: '更新用户授权失败: ' + e.message }, 500);
  }
}

async function handleCheckAuth(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) {
    return jsonResponse({ authenticated: false });
  }
  return jsonResponse({ authenticated: true, role: auth.role, email: auth.email });
}

async function handleBootstrap(request, env) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    requireRequiredConfig(env, ['KV_STORE', 'D1_DB']);
    const schemaInitialized = await ensureD1Schema(env);
    const sync = syncJobToClient(await getStorageSyncJob(env, env.STORAGE_ID));
    const listing = await getDirectoryListingForAuth(env, auth, '/');
    if (listing instanceof Response) return listing;
    const [favorites, tags] = await Promise.all([
      listFavoriteItemsForAuth(env, auth, 500),
      listTagOptionsForAuth(env, auth)
    ]);
    return jsonResponse({
      storageId: env.STORAGE_ID,
      storage: env.STORAGE_CONNECTION ? {
        id: env.STORAGE_CONNECTION.id,
        name: env.STORAGE_CONNECTION.name,
        isDefault: !!env.STORAGE_CONNECTION.is_default,
        lastSyncAt: env.STORAGE_CONNECTION.last_sync_at || null,
        lastSyncStatus: env.STORAGE_CONNECTION.last_sync_status || null
      } : null,
      success: true,
      authenticated: true,
      role: auth.role,
      email: auth.email || null,
      schemaInitialized,
      listing,
      sync,
      favorites,
      tags
    });
  } catch (e) {
    return jsonResponse({ success: false, message: '初始化页面失败: ' + e.message }, 500);
  }
}

async function handleAdminSearchResources(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  try {
    const url = new URL(request.url);
    const query = (url.searchParams.get('q') || '').trim().toLowerCase();
    const type = url.searchParams.get('type') || 'all';
    const requestedLimit = Number(url.searchParams.get('limit') || 50);
    const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit)) : 50;

    const clauses = ["storage_id = ?", "COALESCE(sync_status, 'ready') != 'stale'"];
    const params = [env.STORAGE_ID];
    if (query) {
      clauses.push('(lower(name) LIKE ? OR lower(path) LIKE ?)');
      params.push('%' + query + '%', '%' + query + '%');
    }
    if (type === 'file') {
      clauses.push("item_type = 'file'");
    } else if (type === 'folder') {
      clauses.push("item_type = 'folder'");
    }

    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const rows = await env.D1_DB.prepare(`
      SELECT * FROM search_items
      ${where}
      ORDER BY item_type DESC, name COLLATE NOCASE ASC, path COLLATE NOCASE ASC
      LIMIT ?
    `).bind(...params, limit).all();

    const items = await filterItemsByPermissionD1(env, auth, (rows.results || []).map(d1RowToClientItem), 'view');
    if ((!query || '/'.includes(query)) && type !== 'file' && !items.some(item => item.path === '/')) {
      items.unshift({
        storageId: env.STORAGE_ID,
        path: '/',
        name: '根目录',
        itemType: 'folder',
        isFolder: true,
        sizeFormatted: '',
        previewType: '',
        parentPath: '/'
      });
    }

    return jsonResponse({ success: true, storageId: env.STORAGE_ID, items: items.slice(0, limit) });
  } catch (e) {
    return jsonResponse({ success: false, message: '搜索资源失败: ' + e.message }, 500);
  }
}

async function handleAdminListResources(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  try {
    const url = new URL(request.url);
    const currentPath = normalizeDirectoryPath(url.searchParams.get('path') || '/');
    const listing = await listDirectoryFromD1(env, currentPath);
    const items = await filterItemsByPermissionD1(env, auth, [
      ...(listing.folders || []),
      ...(listing.files || [])
    ], 'view');
    return jsonResponse({
      storageId: env.STORAGE_ID,
      success: true,
      currentPath,
      items
    });
  } catch (e) {
    return jsonResponse({ success: false, message: '读取资源列表失败: ' + e.message }, 500);
  }
}

async function handleAdminStorageDebug(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  try {
    requireRequiredConfig(env, ['KV_STORE', 'STORAGE', 'D1_DB']);
    const url = new URL(request.url);
    const currentPath = normalizeDirectoryPath(url.searchParams.get('path') || '/');
    const prefix = directoryPathToR2Prefix(currentPath);
    const slashPrefix = '/' + prefix;
    const indexListing = await listDirectoryFromD1(env, currentPath).catch(error => ({
      error: error.message,
      files: [],
      folders: []
    }));
    const directoryListing = await env.STORAGE.list({ prefix, delimiter: '/', limit: 20 });
    const slashDirectoryListing = slashPrefix === prefix
      ? null
      : await env.STORAGE.list({ prefix: slashPrefix, delimiter: '/', limit: 20 });
    const rawListing = await env.STORAGE.list({ limit: 20 });
    const d1Count = await env.D1_DB.prepare('SELECT COUNT(*) AS count FROM search_items WHERE storage_id = ?').bind(env.STORAGE_ID).first().catch(error => ({
      error: error.message
    }));

    return jsonResponse({
      success: true,
      path: currentPath,
      prefix,
      slashPrefix,
      index: indexListing
        ? {
            error: indexListing.error || null,
            files: Array.isArray(indexListing.files) ? indexListing.files.length : 0,
            folders: Array.isArray(indexListing.folders) ? indexListing.folders.length : 0
          }
        : null,
      r2Directory: {
        files: (directoryListing.objects || []).map(obj => ({
          key: obj.key,
          size: obj.size || 0,
          uploaded: isoDateString(obj.uploaded)
        })),
        folders: directoryListing.delimitedPrefixes || [],
        truncated: !!directoryListing.truncated
      },
      r2SlashDirectory: slashDirectoryListing
        ? {
            files: (slashDirectoryListing.objects || []).map(obj => ({
              key: obj.key,
              size: obj.size || 0,
              uploaded: isoDateString(obj.uploaded)
            })),
            folders: slashDirectoryListing.delimitedPrefixes || [],
            truncated: !!slashDirectoryListing.truncated
          }
        : null,
      r2RawSample: {
        objects: (rawListing.objects || []).map(obj => ({
          key: obj.key,
          size: obj.size || 0,
          uploaded: isoDateString(obj.uploaded)
        })),
        truncated: !!rawListing.truncated
      },
      d1SearchItems: d1Count && d1Count.error ? d1Count : Number(d1Count?.count || 0)
    });
  } catch (e) {
    return jsonResponse({ success: false, message: '存储诊断失败: ' + e.message }, 500);
  }
}

/**
 * Admin bulk rebuild of the txt full-text index. Processes one batch of books
 * per request (the admin page loops with the returned cursor), skipping books
 * whose index is already up to date unless force=1. Resumable and safe to
 * re-run at any time.
 */
async function handleAdminTxtRebuild(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;
  if (!env.D1_DB) {
    return jsonResponse({ success: false, code: 'TXT_INDEX_UNAVAILABLE', message: 'D1 未配置，无法建立 TXT 索引' }, 503);
  }

  try {
    const body = await request.json().catch(() => ({}));
    const force = ['1', 'true', 'yes', true].includes(body.force);
    const batchSize = Math.min(20, Math.max(1, Number(body.batch || 5) || 5));
    const afterPath = typeof body.cursor === 'string' ? body.cursor : '';

    const totalRow = await env.D1_DB.prepare(`
      SELECT COUNT(*) AS count FROM search_items
      WHERE storage_id = ? AND item_type = 'file' AND lower(path) LIKE '%.txt'
    `).bind(env.STORAGE_ID).first();

    const rows = await env.D1_DB.prepare(`
      SELECT path FROM search_items
      WHERE storage_id = ? AND item_type = 'file' AND lower(path) LIKE '%.txt' AND path > ?
      ORDER BY path ASC
      LIMIT ?
    `).bind(env.STORAGE_ID, afterPath, batchSize).all();

    const books = rows.results || [];
    const details = [];
    let indexed = 0;
    let skipped = 0;
    let missing = 0;

    for (const book of books) {
      const filePath = normalizeItemPath(book.path);
      try {
        const head = await headR2Object(env, itemPathToR2Key(filePath));
        if (!head || !head.object) {
          missing++;
          details.push({ path: filePath, status: 'missing' });
          continue;
        }
        const etag = currentTxtEtag(head.object);
        const size = Number(head.object.size || 0);
        const existing = await getTxtIndexRecord(env, filePath);
        const upToDate = existing
          && existing.status === 'ready'
          && existing.source_etag === etag
          && Number(existing.size || 0) === size;
        if (!force && upToDate) {
          skipped++;
          details.push({ path: filePath, status: 'skipped' });
          continue;
        }
        const resolved = {
          filePath,
          resolved: { key: head.key, object: head.object },
          etag
        };
        const detected = await detectTxtObjectEncoding(env, resolved.resolved, size);
        let record = await prepareTxtIndexRecord(env, resolved, size, detected.encoding, detected.byteOffset, force);
        if (record?.status !== 'ready') {
          await stepTxtIndexBuild(env, resolved, size, detected.encoding, record, detected.byteOffset);
          record = await getTxtIndexRecord(env, filePath);
        }
        indexed++;
        details.push({ path: filePath, status: record?.status || 'building' });
      } catch (error) {
        details.push({ path: filePath, status: 'error', message: String(error.message || '').slice(0, 200) });
      }
    }

    return jsonResponse({
      storageId: env.STORAGE_ID,
      success: true,
      total: Number(totalRow?.count || 0),
      batch: books.length,
      indexed,
      skipped,
      missing,
      cursor: books.length > 0 ? books[books.length - 1].path : afterPath,
      done: books.length < batchSize,
      details
    });
  } catch (e) {
    return jsonResponse({ success: false, message: '重建 TXT 索引失败: ' + e.message }, 500);
  }
}

// ============================================================================
// D1 SEARCH, FAVORITES, AND RECENT VISITS
// ============================================================================


function ownerKeyFromAuth(auth) {
  return auth && auth.role === 'admin' ? 'admin' : `user:${auth.email || ''}`;
}

const PERMISSION_COLUMNS = {
  view: 'can_view',
  preview: 'can_preview',
  download: 'can_download',
  upload: 'can_upload',
  modify: 'can_modify',
  delete: 'can_delete',
  share: 'can_share'
};

const PERMISSION_PRESETS = {
  readonly: {
    view: true,
    preview: true,
    download: true,
    upload: false,
    modify: false,
    delete: false,
    share: false
  },
  uploader: {
    view: true,
    preview: true,
    download: true,
    upload: true,
    modify: false,
    delete: false,
    share: false
  },
  editor: {
    view: true,
    preview: true,
    download: true,
    upload: true,
    modify: true,
    delete: false,
    share: false
  },
  manager: {
    view: true,
    preview: true,
    download: true,
    upload: true,
    modify: true,
    delete: true,
    share: true
  }
};

const PERMISSION_LABELS = {
  view: '查看',
  preview: '预览',
  download: '下载',
  upload: '上传',
  modify: '修改',
  delete: '删除',
  share: '分享'
};

function normalizePermissionFlags(input) {
  const preset = typeof input?.preset === 'string' ? input.preset : '';
  const source = input?.permissions || input || {};
  const base = PERMISSION_PRESETS[preset] || {};
  const flags = {};
  for (const key of Object.keys(PERMISSION_COLUMNS)) {
    flags[key] = !!(key in source ? source[key] : base[key]);
  }

  if (flags.preview || flags.download || flags.upload || flags.modify || flags.delete || flags.share) {
    flags.view = true;
  }
  if (flags.modify || flags.delete || flags.share) {
    flags.preview = true;
    flags.download = true;
  }
  if (flags.modify) {
    flags.upload = true;
  }
  return flags;
}

function normalizeUserPermissionEntry(entry) {
  const path = normalizeItemPath(entry?.path || '');
  if (!path) throw new Error('授权路径无效');

  const itemType = entry?.itemType || entry?.item_type || (entry?.isFolder ? 'folder' : 'file');
  if (!['file', 'folder'].includes(itemType)) {
    throw new Error('授权资源类型无效: ' + path);
  }
  if (path === '/' && itemType !== 'folder') {
    throw new Error('根目录只能按文件夹授权');
  }

  return {
    path,
    itemType,
    permissions: normalizePermissionFlags(entry)
  };
}

function permissionRowToClient(row) {
  const permissions = {};
  for (const [key, column] of Object.entries(PERMISSION_COLUMNS)) {
    permissions[key] = !!row[column];
  }
  return {
    id: row.id,
    email: row.email,
    path: row.path,
    itemType: row.item_type,
    name: row.path === '/' ? '根目录' : nameFromItemPath(row.path),
    permissions,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function summarizePermissionFlags(row) {
  const names = [];
  for (const [key, label] of Object.entries(PERMISSION_LABELS)) {
    if (row[PERMISSION_COLUMNS[key]]) names.push(label);
  }
  return names.join('、') || '无权限';
}

async function replaceUserPermissions(env, email, permissions) {
  permissionRowsCache.delete(permissionCacheKey(env, email));
  const normalized = Array.isArray(permissions) ? permissions.map(normalizeUserPermissionEntry) : [];
  const bound = [];
  for (const item of normalized) {
    const current = await getIndexedResourceInfoWithInitialSync(env, item.path);
    if (!current || current.itemType !== item.itemType) {
      throw new Error('授权资源不存在或类型已变化: ' + item.path);
    }
    bound.push({
      ...item,
      resourceKey: current.resourceKey,
      resourceVersion: current.resourceVersion,
      resourceEtag: current.resourceEtag
    });
  }
  await env.D1_DB.prepare('DELETE FROM user_permissions WHERE email = ? AND storage_id = ?').bind(email, env.STORAGE_ID).run();
  if (bound.length === 0) return;

  const now = Date.now();
  const insert = env.D1_DB.prepare(`
    INSERT INTO user_permissions (
      email, storage_id, path, item_type, can_view, can_preview, can_download, can_upload, can_modify, can_delete, can_share,
      resource_key, resource_version, resource_etag, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email, storage_id, path, item_type) DO UPDATE SET
      can_view = excluded.can_view,
      can_preview = excluded.can_preview,
      can_download = excluded.can_download,
      can_upload = excluded.can_upload,
      can_modify = excluded.can_modify,
      can_delete = excluded.can_delete,
      can_share = excluded.can_share,
      resource_key = excluded.resource_key,
      resource_version = excluded.resource_version,
      resource_etag = excluded.resource_etag,
      updated_at = excluded.updated_at
  `);

  for (let index = 0; index < bound.length; index += 50) {
    const batch = bound.slice(index, index + 50).map(item => insert.bind(
      email,
      env.STORAGE_ID,
      item.path,
      item.itemType,
      item.permissions.view ? 1 : 0,
      item.permissions.preview ? 1 : 0,
      item.permissions.download ? 1 : 0,
      item.permissions.upload ? 1 : 0,
      item.permissions.modify ? 1 : 0,
      item.permissions.delete ? 1 : 0,
      item.permissions.share ? 1 : 0,
      item.resourceKey,
      item.resourceVersion,
      item.resourceEtag,
      now,
      now
    ));
    await env.D1_DB.batch(batch);
  }
}

// Permission grants change rarely but are consulted on every user request.
// Cache per isolate keyed by email+storage; the TTL bounds staleness and
// replaceUserPermissions drops the entry on writes.
const permissionRowsCache = new Map();
const PERMISSION_CACHE_TTL_MS = 60_000;

function permissionCacheKey(env, email) {
  return `${env.STORAGE_ID}:${email}`;
}

async function getUserPermissionRows(env, email) {
  const cacheKey = permissionCacheKey(env, email);
  const cached = permissionRowsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < PERMISSION_CACHE_TTL_MS) return cached.rows;
  const result = await env.D1_DB.prepare(`
    SELECT * FROM user_permissions
    WHERE email = ? AND storage_id = ?
    ORDER BY path = '/' DESC, length(path) ASC, path COLLATE NOCASE ASC
  `).bind(email, env.STORAGE_ID).all();
  const rows = result.results || [];
  const indexedMap = await getIndexedResourceInfoMap(env, rows.map(row => row.path));
  const valid = [];
  for (const row of rows) {
    const current = row.path === '/'
      ? await getIndexedResourceInfo(env, '/')
      : indexedMap.get(normalizeItemPath(row.path));
    const binding = current && current.itemType === row.item_type
      ? resourceBindingMatches(current, row)
      : false;
    if (!current || binding === false) continue;
    valid.push(row);
  }
  permissionRowsCache.set(cacheKey, { rows: valid, at: Date.now() });
  return valid;
}

async function getPermissionRowsForAuth(env, auth) {
  if (!auth || auth.role === 'admin' || !auth.email) return [];
  if (!auth._permissionRowsPromise) {
    auth._permissionRowsPromise = getUserPermissionRows(env, auth.email);
  }
  return auth._permissionRowsPromise;
}

async function findUserPermissionForPath(env, email, path) {
  const normalized = normalizeItemPath(path);
  const result = await env.D1_DB.prepare(`
    SELECT * FROM user_permissions
    WHERE email = ? AND storage_id = ?
      AND (
        path = ?
        OR (item_type = 'folder' AND path = '/')
        OR (item_type = 'folder' AND ? LIKE path || '/%')
      )
    ORDER BY length(path) DESC
  `).bind(email, env.STORAGE_ID, normalized, normalized).all();
  return result.results || [];
}

async function hasPathPermission(env, auth, action, path) {
  if (auth && auth.role === 'admin') return true;
  if (!auth || !auth.email) return false;
  const column = PERMISSION_COLUMNS[action];
  if (!column) throw new Error('未知权限类型: ' + action);
  const normalized = normalizeItemPath(path);
  const currentTarget = await getIndexedResourceInfoWithInitialSync(env, normalized);
  if (!currentTarget) return false;
  const rows = await getPermissionRowsForAuth(env, auth);
  for (const row of rows) {
    if (!row[column]) continue;
    if (row.item_type === 'file' && row.path !== normalized) continue;
    if (row.item_type === 'folder' && !isPathWithinFolder(row.path, normalized)) continue;
    return true;
  }
  return false;
}

async function requirePathPermission(env, auth, action, path) {
  if (await hasPathPermission(env, auth, action, path)) return null;
  return jsonResponse({
    success: false,
    message: '没有' + (PERMISSION_LABELS[action] || action) + '权限: ' + normalizeItemPath(path)
  }, 403);
}

/**
 * Pure-D1 permission filter: loads the user's permission grants once (cost is
 * bounded by the number of grants, not by the listing size) and filters items
 * in memory. Zero R2 calls — replaces the old per-item HEAD+LIST filter.
 */
async function filterItemsByPermissionD1(env, auth, items, action = 'view') {
  if (!Array.isArray(items) || items.length === 0) return [];
  if (auth?.role === 'admin') return items;
  if (!auth?.email) return [];
  const column = PERMISSION_COLUMNS[action];
  if (!column) throw new Error('未知权限类型: ' + action);

  const rows = await getPermissionRowsForAuth(env, auth);
  const folderGrants = [];
  const fileGrants = new Set();
  for (const row of rows) {
    if (!row[column]) continue;
    const grantPath = normalizeItemPath(row.path);
    if (row.item_type === 'folder') folderGrants.push(grantPath);
    else fileGrants.add(grantPath);
  }
  if (folderGrants.length === 0 && fileGrants.size === 0) return [];

  return items.filter(item => {
    const itemPath = normalizeItemPath(item.path || '');
    if (!itemPath || itemPath === '/') return false;
    const itemType = item.itemType || item.item_type;
    if (itemType === 'file' && fileGrants.has(itemPath)) return true;
    return folderGrants.some(grantPath => grantPath === '/' || isPathWithinFolder(grantPath, itemPath));
  });
}

async function listVirtualPermissionDirectory(env, auth, dirPath) {
  if (!auth || auth.role === 'admin' || !auth.email) return null;
  const currentPath = normalizeDirectoryPath(dirPath);
  const rows = await getPermissionRowsForAuth(env, auth);
  const candidateMap = new Map(); // childPath -> { itemType, exact }

  for (const row of rows) {
    const permissionPath = normalizeItemPath(row.path);
    if (permissionPath === '/') continue;

    const currentPrefix = currentPath === '/' ? '/' : currentPath + '/';
    if (permissionPath !== currentPath && !permissionPath.startsWith(currentPrefix)) continue;

    const relative = currentPath === '/'
      ? permissionPath.slice(1)
      : permissionPath.slice(currentPrefix.length);
    const parts = relative.split('/').filter(Boolean);
    if (parts.length === 0) continue;

    const childPath = currentPath === '/' ? '/' + parts[0] : currentPath + '/' + parts[0];
    const isExactPermission = parts.length === 1;
    const itemType = isExactPermission ? row.item_type : 'folder';
    const existing = candidateMap.get(childPath);
    if (existing && existing.itemType === 'folder') continue;

    candidateMap.set(childPath, { itemType, exact: isExactPermission });
  }

  if (candidateMap.size === 0) return null;

  // Batch existence check against the virtual directory tree (no R2 calls).
  const candidatePaths = [...candidateMap.keys()];
  const rowMap = new Map();
  for (let index = 0; index < candidatePaths.length; index += 50) {
    const chunk = candidatePaths.slice(index, index + 50);
    const placeholders = chunk.map(() => '?').join(',');
    const found = await env.D1_DB.prepare(
      `SELECT * FROM search_items WHERE storage_id = ? AND path IN (${placeholders})`
    ).bind(env.STORAGE_ID, ...chunk).all();
    for (const row of found.results || []) rowMap.set(row.path, row);
  }

  const itemMap = new Map();
  for (const [childPath, candidate] of candidateMap) {
    const existingRow = rowMap.get(childPath);
    if (existingRow) {
      if (candidate.exact && existingRow.item_type !== candidate.itemType) continue;
      if (!candidate.exact && existingRow.item_type !== 'folder') continue;
      itemMap.set(childPath, d1RowToClientItem(existingRow));
      continue;
    }

    // Missing D1 rows are intentionally not repaired on a page read. Manual
    // refresh is the explicit R2 reconciliation path.
  }

  const items = Array.from(itemMap.values()).sort((a, b) => {
    if (a.itemType !== b.itemType) return a.itemType === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });

  if (items.length === 0) return null;
  return {
    storageId: env.STORAGE_ID,
    success: true,
    files: items.filter(item => item.itemType === 'file'),
    folders: items.filter(item => item.itemType === 'folder'),
    currentPath
  };
}

function d1RowToClientItem(row) {
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
    size: row.size || 0,
    sizeFormatted: row.size_formatted || '',
    previewType: row.preview_type || '',
    syncStatus: row.sync_status || 'ready',
    parentPath: row.parent_path || parentPathFromItemPath(row.path),
    lastModified: row.last_modified || null,
    indexedAt: row.indexed_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    visitedAt: row.visited_at || null,
    tags
  };
}

function escapeLike(value) {
  return String(value || '').replace(/[\\%_]/g, match => '\\' + match);
}

function normalizeTags(input) {
  if (!Array.isArray(input)) throw new Error('tags 必须是数组');
  const seen = new Set();
  const tags = [];
  for (const raw of input) {
    const tag = String(raw || '').trim();
    if (!tag) continue;
    if (tag.length > 20) throw new Error('单个标签不能超过 20 个字符');
    if (!seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }
  if (tags.length > 20) throw new Error('每个项目最多 20 个标签');
  return tags.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

const TAG_CACHE_TTL_SECONDS = 60;

function tagCacheKey(storageId, ownerKey) {
  return `tags:${storageId}:${ownerKey}`;
}

async function listTagOptionsForAuth(env, auth) {
  // Tag aggregation reads every tagged catalog row; D1 bills per row read.
  // Cache per user+storage in KV for a minute and invalidate on tag writes.
  const ownerKey = ownerKeyFromAuth(auth);
  const cacheKey = tagCacheKey(env.STORAGE_ID, ownerKey);
  if (env.KV_STORE) {
    try {
      const cached = await env.KV_STORE.get(cacheKey, 'json');
      if (Array.isArray(cached)) return cached;
    } catch {
      // Cache failures must not break the listing path.
    }
  }
  const rows = await env.D1_DB.prepare(`
    SELECT path, item_type, tags FROM search_items
    WHERE storage_id = ? AND tags IS NOT NULL AND tags != '[]'
      AND COALESCE(sync_status, 'ready') != 'stale'
  `).bind(env.STORAGE_ID).all();
  const allowedItems = await filterItemsByPermissionD1(
    env,
    auth,
    (rows.results || []).map(row => ({ path: row.path, itemType: row.item_type })),
    'view'
  );
  const allowedPaths = new Set(allowedItems.map(item => normalizeItemPath(item.path)));
  const counts = new Map();
  for (const row of rows.results || []) {
    if (!allowedPaths.has(normalizeItemPath(row.path))) continue;
    let tags = [];
    try {
      const parsed = JSON.parse(row.tags || '[]');
      if (Array.isArray(parsed)) tags = parsed;
    } catch {
      tags = [];
    }
    for (const tag of tags) {
      if (typeof tag !== 'string' || !tag) continue;
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  const options = Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hans-CN'));
  if (env.KV_STORE && options.length > 0) {
    try {
      await env.KV_STORE.put(cacheKey, JSON.stringify(options), { expirationTtl: TAG_CACHE_TTL_SECONDS });
    } catch {
      // Cache write failures are non-fatal.
    }
  }
  return options;
}

async function handleListTags(request, env) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    return jsonResponse({ success: true, tags: await listTagOptionsForAuth(env, auth) });
  } catch (e) {
    return jsonResponse({ success: false, message: '读取标签失败: ' + e.message }, 500);
  }
}

async function handleUpdateTags(request, env) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const url = new URL(request.url);
    const path = normalizeItemPath(url.searchParams.get('path') || '');
    if (!path || path === '/') return jsonResponse({ success: false, message: '请提供有效路径' }, 400);
    const permissionError = await requirePathPermission(env, auth, 'modify', path);
    if (permissionError) return permissionError;

    const body = await request.json().catch(() => ({}));
    const tags = normalizeTags(body.tags || []);
    const existing = await env.D1_DB.prepare('SELECT * FROM search_items WHERE storage_id = ? AND path = ?').bind(env.STORAGE_ID, path).first();
    const now = Date.now();
    const bodyItemType = body.itemType || body.item_type || (body.isFolder ? 'folder' : '');
    const itemType = existing?.item_type || (['file', 'folder'].includes(bodyItemType) ? bodyItemType : 'file');
    const parentPath = existing?.parent_path || parentPathFromItemPath(path);
    await env.D1_DB.prepare(`
      INSERT INTO search_items (
        storage_id, path, name, item_type, parent_path, size, size_formatted, preview_type, last_modified, tags, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(storage_id, path) DO UPDATE SET
        tags = excluded.tags,
        indexed_at = CASE WHEN search_items.indexed_at IS NULL OR search_items.indexed_at = 0 THEN excluded.indexed_at ELSE search_items.indexed_at END
    `).bind(
      env.STORAGE_ID,
      path,
      existing?.name || nameFromItemPath(path),
      itemType,
      parentPath,
      existing?.size || 0,
      existing?.size_formatted || '',
      existing?.preview_type || '',
      existing?.last_modified || null,
      JSON.stringify(tags),
      existing?.indexed_at || now
    ).run();
    // Invalidate cached tag options so the next listing reflects this write.
    if (env.KV_STORE) {
      try { await env.KV_STORE.delete(tagCacheKey(env.STORAGE_ID, ownerKeyFromAuth(auth))); } catch {}
    }
    return jsonResponse({ success: true, storageId: env.STORAGE_ID, path, tags });
  } catch (e) {
    return jsonResponse({ success: false, message: '保存标签失败: ' + e.message }, 500);
  }
}

async function cleanupD1ItemPath(env, path) {
  if (!env.D1_DB) return;

  try {
    const normalized = normalizeItemPath(path);
    if (!normalized || normalized === '/') return;
    const scopedDelete = table => env.D1_DB.prepare(
      `DELETE FROM ${table}
       WHERE storage_id = ? AND (
         path = ? OR substr(path, 1, length(?) + 1) = ? || '/'
       )`
    ).bind(env.STORAGE_ID, normalized, normalized, normalized);
    const statements = [
      scopedDelete('search_items'),
      scopedDelete('favorites'),
      scopedDelete('recent_items'),
      scopedDelete('reader_bookmarks'),
      scopedDelete('reader_progress'),
      scopedDelete('txt_index_chunks'),
      scopedDelete('txt_index_files')
    ];
    await env.D1_DB.batch(statements);
  } catch (e) {
    console.warn('D1 item reference cleanup failed:', e.message);
  }
}

async function deleteReaderProgressForPath(env, rawPath) {
  if (!env.KV_STORE) return;
  const normalized = normalizeItemPath(rawPath);
  const pathHash = await sha256Hex(normalized);
  let cursor;
  do {
    const listed = await env.KV_STORE.list({ prefix: 'reader:', cursor });
    const keys = [];
    for (const key of listed.keys || []) {
      if (key.name.endsWith(':' + pathHash)) {
        keys.push(key.name);
        continue;
      }
      try {
        const value = await env.KV_STORE.get(key.name, 'json');
        if (value?.path && isPathWithinFolder(normalized, value.path)) keys.push(key.name);
      } catch {
        // Legacy reader values may not be JSON; the exact hashed key was still checked above.
      }
    }
    if (keys.length > 0) await Promise.all(keys.map(key => env.KV_STORE.delete(key)));
    cursor = listed.list_complete ? null : listed.cursor;
  } while (cursor);
}

async function invalidatePathReferences(env, rawPath) {
  const normalized = normalizeItemPath(rawPath);
  if (!normalized || normalized === '/') return;
  await cleanupD1ItemPath(env, normalized);
  await deleteReaderProgressForPath(env, normalized);
  // Permissions were just deleted below; drop any cached grant rows so the
  // next request re-reads authoritative state instead of the stale cache.
  permissionRowsCache.clear();
  if (!env.D1_DB) return;

  try {
    const affected = await env.D1_DB.prepare(`
      SELECT DISTINCT share_id FROM share_items
      WHERE storage_id = ?
        AND (item_path = ? OR substr(item_path, 1, length(?) + 1) = ? || '/')
    `).bind(env.STORAGE_ID, normalized, normalized, normalized).all();
    const statements = [
      env.D1_DB.prepare(`
        DELETE FROM user_permissions
        WHERE storage_id = ?
          AND (path = ? OR substr(path, 1, length(?) + 1) = ? || '/')
      `).bind(env.STORAGE_ID, normalized, normalized, normalized),
      env.D1_DB.prepare('UPDATE share_links SET items_initialized = 1 WHERE storage_id = ? AND file_path = ?').bind(env.STORAGE_ID, itemPathToR2Key(normalized))
    ];
    for (const row of affected.results || []) {
      statements.push(env.D1_DB.prepare('UPDATE share_links SET items_initialized = 1 WHERE storage_id = ? AND share_id = ?').bind(env.STORAGE_ID, row.share_id));
    }
    await env.D1_DB.batch(statements);
  } catch (error) {
    console.warn('Path reference invalidation failed:', error.message);
  }
}

// ---------------------------------------------------------------------------
// Virtual directory helpers — `search_items` (D1) is the authoritative tree.
// Listings are served from D1; R2 is only scanned by the manual reconcile
// (refresh) flow and the incremental upserts performed on every mutation.
// ---------------------------------------------------------------------------

function searchItemsUpsertStatement(db, replaceIdentity = false) {
  const resourceKeyUpdate = replaceIdentity ? 'excluded.resource_key' : 'COALESCE(excluded.resource_key, search_items.resource_key)';
  const resourceVersionUpdate = replaceIdentity ? 'excluded.resource_version' : 'COALESCE(excluded.resource_version, search_items.resource_version)';
  const resourceEtagUpdate = replaceIdentity ? 'excluded.resource_etag' : 'COALESCE(excluded.resource_etag, search_items.resource_etag)';
  return db.prepare(`
    INSERT INTO search_items (
      storage_id, path, name, item_type, parent_path, size, size_formatted, preview_type, last_modified,
      indexed_at, resource_key, resource_version, resource_etag, sync_status, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)
    ON CONFLICT(storage_id, path) DO UPDATE SET
      name = excluded.name,
      item_type = excluded.item_type,
      parent_path = excluded.parent_path,
      size = excluded.size,
      size_formatted = excluded.size_formatted,
      preview_type = excluded.preview_type,
      last_modified = excluded.last_modified,
      indexed_at = excluded.indexed_at,
      resource_key = ${resourceKeyUpdate},
      resource_version = ${resourceVersionUpdate},
      resource_etag = ${resourceEtagUpdate},
      sync_status = 'ready',
      updated_at = excluded.updated_at
  `);
}

function bindSearchItemRow(statement, storageId, item) {
  return statement.bind(
    storageId,
    item.path,
    item.name,
    item.item_type,
    item.parent_path,
    item.size || 0,
    item.size_formatted || '',
    item.preview_type || '',
    item.last_modified || null,
    item.indexed_at,
    item.resource_key || null,
    item.resource_version || null,
    item.resource_etag || null,
    item.updated_at || item.indexed_at || Date.now()
  );
}

async function upsertSearchItemRows(env, rows, options = {}) {
  if (!env.D1_DB || !Array.isArray(rows) || rows.length === 0) return;
  for (let index = 0; index < rows.length; index += 50) {
    const batch = rows.slice(index, index + 50)
      .map(item => bindSearchItemRow(searchItemsUpsertStatement(env.D1_DB, options.replaceIdentity), env.STORAGE_ID, item));
    if (batch.length > 0) {
      await env.D1_DB.batch(batch);
    }
  }
}

function buildSearchFileRowFromObject(key, obj, indexedAt) {
  const path = r2KeyToPath(key);
  const name = nameFromItemPath(path);
  const size = Number(obj?.size || 0);
  return {
    path,
    name,
    item_type: 'file',
    parent_path: parentPathFromItemPath(path),
    size,
    size_formatted: formatFileSize(size),
    preview_type: getPreviewType(name) || '',
    last_modified: isoDateString(obj?.uploaded),
    indexed_at: indexedAt,
    resource_key: key,
    resource_version: obj?.version || null,
    resource_etag: currentTxtEtag(obj) || null,
    updated_at: indexedAt
  };
}

function collectFolderRowsForItem(folderRows, itemPath, indexedAt, includeSelf) {
  const normalized = normalizeItemPath(itemPath);
  if (!normalized || normalized === '/') return;
  const parts = normalized.split('/').filter(Boolean);
  const depth = includeSelf ? parts.length : parts.length - 1;
  for (let index = 0; index < depth; index++) {
    addFolderSearchRows(folderRows, '/' + parts.slice(0, index + 1).join('/'), indexedAt);
  }
}

async function upsertSearchFileFromR2Object(env, key, obj, indexedAt = Date.now()) {
  if (!env.D1_DB) return;
  const filePath = r2KeyToPath(key);
  if (!nameFromItemPath(filePath)) return;
  const rows = [];
  const folderRows = new Map();
  collectFolderRowsForItem(folderRows, filePath, indexedAt, false);
  rows.push(...folderRows.values());
  rows.push(buildSearchFileRowFromObject(key, obj, indexedAt));
  await upsertSearchItemRows(env, rows);
}

async function upsertSearchFolderRow(env, folderPath, markerObject = null, indexedAt = Date.now()) {
  if (!env.D1_DB) return;
  const normalized = normalizeItemPath(folderPath);
  if (!normalized || normalized === '/') return;
  const folderRows = new Map();
  collectFolderRowsForItem(folderRows, normalized, indexedAt, true);
  const row = folderRows.get(normalized);
  if (row) {
    row.resource_key = itemPathToR2Key(normalized) + '/.folder';
    row.resource_version = markerObject?.version || null;
    row.resource_etag = currentTxtEtag(markerObject) || null;
  }
  await upsertSearchItemRows(env, [...folderRows.values()]);
}

async function listDirectoryFromD1(env, dirPath) {
  const currentPath = normalizeDirectoryPath(dirPath);
  const result = await env.D1_DB.prepare(`
    SELECT * FROM search_items
    WHERE storage_id = ? AND parent_path = ? AND COALESCE(sync_status, 'ready') != 'stale'
    ORDER BY item_type DESC, name COLLATE NOCASE ASC, path COLLATE NOCASE ASC
  `).bind(env.STORAGE_ID, currentPath).all();

  const folders = [];
  const files = [];
  for (const row of result.results || []) {
    const item = d1RowToClientItem(row);
    if (row.item_type === 'folder') folders.push(item);
    else files.push(item);
  }
  return {
    storageId: env.STORAGE_ID,
    success: true,
    files,
    folders,
    currentPath,
    fromIndex: true
  };
}


function normalizeD1ItemFromBody(body) {
  const path = normalizeItemPath(body.path || '');
  if (!path || path === '/') {
    throw new Error('请提供有效路径');
  }

  const itemType = body.itemType || body.item_type || (body.isFolder ? 'folder' : 'file');
  if (!['file', 'folder'].includes(itemType)) {
    throw new Error('项目类型无效');
  }

  const name = (body.name || nameFromItemPath(path)).trim();
  if (!name) {
    throw new Error('项目名称无效');
  }

  return {
    path,
    name,
    itemType,
    sizeFormatted: body.sizeFormatted || body.size_formatted || '',
    previewType: body.previewType || body.preview_type || ''
  };
}

function addFolderSearchRows(folderRows, folderPath, indexedAt) {
  const normalized = normalizeDirectoryPath(folderPath);
  if (normalized === '/') return;
  if (!folderRows.has(normalized)) {
    folderRows.set(normalized, {
      path: normalized,
      name: nameFromItemPath(normalized),
      item_type: 'folder',
      parent_path: parentPathFromItemPath(normalized),
      size: 0,
      size_formatted: '',
      preview_type: '',
      last_modified: null,
      indexed_at: indexedAt,
      resource_key: itemPathToR2Key(normalized) + '/',
      resource_version: null,
      resource_etag: null,
      updated_at: indexedAt
    });
  }
}

function addFolderSearchRowsFromR2Key(folderRows, key, indexedAt, object) {
  const rawKey = String(key || '');
  const leadingSlash = rawKey.startsWith('/') ? '/' : '';
  const parts = (key || '').split('/').filter(Boolean);
  const folderParts = parts.slice(0, -1);
  for (let index = 0; index < folderParts.length; index++) {
    const folderPath = '/' + folderParts.slice(0, index + 1).join('/');
    addFolderSearchRows(folderRows, folderPath, indexedAt);
    const row = folderRows.get(folderPath);
    if (!row) continue;
    const folderPrefix = leadingSlash + folderParts.slice(0, index + 1).join('/') + '/';
    const isMarker = rawKey === folderPrefix + '.folder';
    // Only a real folder marker has a stable object identity. Binding an
    // implicit folder to an arbitrary first child would invalidate shares and
    // permissions whenever that child changes.
    if (isMarker) {
      row.resource_key = rawKey;
      row.resource_version = object?.version || null;
      row.resource_etag = currentTxtEtag(object) || null;
    }
  }
}

async function handleSearch(request, env) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const url = new URL(request.url);
    const refresh = ['1', 'true', 'yes'].includes((url.searchParams.get('refresh') || '').toLowerCase());
    const refreshResult = refresh
      ? syncJobToClient(await enqueueStorageSync(env, env.STORAGE_ID, { requestedBy: auth.role }))
      : null;
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const type = url.searchParams.get('type') || 'all';
    const requestedLimit = Number(url.searchParams.get('limit') || 100);
    const limit = Number.isFinite(requestedLimit) ? Math.min(500, Math.max(1, requestedLimit)) : 100;

    const clauses = ["storage_id = ?", "COALESCE(sync_status, 'ready') != 'stale'"];
    const params = [env.STORAGE_ID];
    if (q) {
      clauses.push('(lower(name) LIKE ? OR lower(path) LIKE ?)');
      params.push('%' + q + '%', '%' + q + '%');
    }
    if (type === 'files') {
      clauses.push("item_type = 'file'");
    } else if (type === 'folders') {
      clauses.push("item_type = 'folder'");
    }
    const tagFilters = url.searchParams.getAll('tag').map(tag => tag.trim()).filter(Boolean);
    for (const tag of tagFilters) {
      clauses.push("tags LIKE ? ESCAPE '\\'");
      params.push('%"' + escapeLike(tag) + '"%');
    }

    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const results = await env.D1_DB.prepare(`
      SELECT * FROM search_items
      ${where}
      ORDER BY item_type DESC, name COLLATE NOCASE ASC, path COLLATE NOCASE ASC
      LIMIT ?
    `).bind(...params, limit).all();

    return jsonResponse({
      storageId: env.STORAGE_ID,
      success: true,
      items: await filterItemsByPermissionD1(env, auth, (results.results || []).map(d1RowToClientItem), 'view'),
      refresh: refreshResult
    });
  } catch (e) {
    return jsonResponse({ success: false, message: '搜索失败: ' + e.message }, 500);
  }
}

async function listFavoriteItemsForAuth(env, auth, limit = 200) {
  const ownerKey = ownerKeyFromAuth(auth);
  const results = await env.D1_DB.prepare(`
    SELECT favorites.*, search_items.tags AS tags
    FROM favorites
    LEFT JOIN search_items
      ON search_items.storage_id = favorites.storage_id AND search_items.path = favorites.path
    WHERE favorites.owner_key = ? AND favorites.storage_id = ?
    ORDER BY favorites.updated_at DESC
    LIMIT ?
  `).bind(ownerKey, env.STORAGE_ID, limit).all();
  const items = (results.results || []).map(d1RowToClientItem);
  const indexedMap = await getIndexedResourceInfoMap(env, items.map(item => item.path));
  return filterItemsByPermissionD1(
    env,
    auth,
    items.filter(item => indexedMap.has(normalizeItemPath(item.path))),
    'view'
  );
}

async function handleFavorites(request, env) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const ownerKey = ownerKeyFromAuth(auth);

    if (request.method === 'GET') {
      const requestedLimit = Number(new URL(request.url).searchParams.get('limit') || 200);
      const limit = Number.isFinite(requestedLimit) ? Math.min(500, Math.max(1, requestedLimit)) : 200;
      return jsonResponse({
        success: true,
        favorites: await listFavoriteItemsForAuth(env, auth, limit)
      });
    }

    if (request.method === 'POST') {
      const item = normalizeD1ItemFromBody(await request.json());
      const permissionError = await requirePathPermission(env, auth, 'view', item.path);
      if (permissionError) return permissionError;
      const now = Date.now();
      await env.D1_DB.prepare(`
        INSERT INTO favorites (owner_key, storage_id, path, name, item_type, size_formatted, preview_type, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_key, storage_id, path) DO UPDATE SET
          name = excluded.name,
          item_type = excluded.item_type,
          size_formatted = excluded.size_formatted,
          preview_type = excluded.preview_type,
          updated_at = excluded.updated_at
      `).bind(ownerKey, env.STORAGE_ID, item.path, item.name, item.itemType, item.sizeFormatted, item.previewType, now, now).run();
      return jsonResponse({ success: true, favorite: { ...item, updatedAt: now } });
    }

    if (request.method === 'DELETE') {
      const url = new URL(request.url);
      const body = await request.json().catch(() => ({}));
      const path = normalizeItemPath(body.path || url.searchParams.get('path') || '');
      if (!path || path === '/') {
        return jsonResponse({ success: false, message: '请提供有效路径' }, 400);
      }
      await env.D1_DB.prepare('DELETE FROM favorites WHERE owner_key = ? AND storage_id = ? AND path = ?').bind(ownerKey, env.STORAGE_ID, path).run();
      return jsonResponse({ success: true });
    }

    return jsonResponse({ success: false, message: '方法不支持' }, 405);
  } catch (e) {
    return jsonResponse({ success: false, message: '收藏操作失败: ' + e.message }, 500);
  }
}

async function pruneRecentItems(env, ownerKey, keepCount = 100) {
  // Single-statement prune: D1 bills per row scanned and per row written,
  // so the previous read-up-to-1000-then-delete-in-batches approach cost
  // ~1 write per browse. A subquery delete touches only the cutoff row.
  await env.D1_DB.prepare(`
    DELETE FROM recent_items
    WHERE owner_key = ? AND storage_id = ? AND visited_at < (
      SELECT visited_at FROM recent_items
      WHERE owner_key = ? AND storage_id = ?
      ORDER BY visited_at DESC
      LIMIT 1 OFFSET ?
    )
  `).bind(ownerKey, env.STORAGE_ID, ownerKey, env.STORAGE_ID, keepCount).run();
}

async function saveRecentItem(env, auth, item) {
  const ownerKey = ownerKeyFromAuth(auth);
  const now = Date.now();
  await env.D1_DB.prepare(`
    INSERT INTO recent_items (owner_key, storage_id, path, name, item_type, size_formatted, preview_type, visited_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_key, storage_id, path) DO UPDATE SET
      name = excluded.name,
      item_type = excluded.item_type,
      size_formatted = excluded.size_formatted,
      preview_type = excluded.preview_type,
      visited_at = excluded.visited_at
  `).bind(ownerKey, env.STORAGE_ID, item.path, item.name, item.itemType, item.sizeFormatted, item.previewType, now).run();
  // Prune only on ~2% of writes: rows beyond the cap are harmless and a
  // full prune per visit multiplied D1 write volume by the visit count.
  if (Math.random() < 0.02) await pruneRecentItems(env, ownerKey, 100);
  return now;
}

async function recordRecentVisit(env, auth, item) {
  try {
    await saveRecentItem(env, auth, item);
  } catch (e) {
    console.warn('D1 recent visit record failed:', e.message);
  }
}

async function deferBackground(ctx, promise) {
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(promise);
    return;
  }
  await promise;
}

async function listRecentItemsForAuth(env, auth, limit = 100) {
  const ownerKey = ownerKeyFromAuth(auth);
  const results = await env.D1_DB.prepare(`
    SELECT recent_items.*, search_items.tags AS tags
    FROM recent_items
    LEFT JOIN search_items
      ON search_items.storage_id = recent_items.storage_id AND search_items.path = recent_items.path
    WHERE recent_items.owner_key = ? AND recent_items.storage_id = ?
    ORDER BY recent_items.visited_at DESC
    LIMIT ?
  `).bind(ownerKey, env.STORAGE_ID, limit).all();
  const items = (results.results || []).map(d1RowToClientItem);
  const indexedMap = await getIndexedResourceInfoMap(env, items.map(item => item.path));
  return filterItemsByPermissionD1(
    env,
    auth,
    items.filter(item => indexedMap.has(normalizeItemPath(item.path))),
    'view'
  );
}

async function handleRecent(request, env) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const ownerKey = ownerKeyFromAuth(auth);

    if (request.method === 'GET') {
      const requestedLimit = Number(new URL(request.url).searchParams.get('limit') || 100);
      const limit = Number.isFinite(requestedLimit) ? Math.min(200, Math.max(1, requestedLimit)) : 100;
      return jsonResponse({
        success: true,
        recent: await listRecentItemsForAuth(env, auth, limit)
      });
    }

    if (request.method === 'POST') {
      const item = normalizeD1ItemFromBody(await request.json());
      const permissionError = await requirePathPermission(env, auth, 'view', item.path);
      if (permissionError) return permissionError;
      const visitedAt = await saveRecentItem(env, auth, item);
      return jsonResponse({ success: true, recent: { ...item, visitedAt } });
    }

    return jsonResponse({ success: false, message: '方法不支持' }, 405);
  } catch (e) {
    return jsonResponse({ success: false, message: '最近访问操作失败: ' + e.message }, 500);
  }
}

// ============================================================================
// HTML PAGES
// ============================================================================








// ============================================================================
// MAIN REQUEST HANDLER
// ============================================================================

function isStorageRuntimeExempt(path) {
  return path === '/api/login'
    || path === '/api/logout'
    || path === '/api/auth/check'
    || path === '/api/storages'
    || path === '/api/d1/init'
    || path.startsWith('/api/admin/storages')
    || (path.startsWith('/api/share/') && path !== '/api/share');
}

function storageRuntimeErrorResponse(error) {
  const status = Number(error?.status || 500);
  return jsonResponse({
    success: false,
    code: error?.code || 'STORAGE_ERROR',
    message: isStorageRuntimeError(error) ? error.message : '存储初始化失败'
  }, status);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS headers for API requests
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // API Routes
      if (path.startsWith('/api/')) {
        if (!isStorageRuntimeExempt(path)) {
          const auth = await verifyAuth(request, env);
          if (!auth) return jsonResponse({ success: false, message: '未授权' }, 401);
          if (env.D1_DB) await ensureD1Schema(env);
          if (env.STORAGE) {
            env = { ...env, STORAGE_ID: url.searchParams.get('storageId') || env.STORAGE_ID || 'legacy-default' };
          } else {
            try {
              const runtime = await createStorageRuntime(request, env, auth);
              env = runtime.env;
            } catch (error) {
              if (path === '/api/bootstrap' && ['STORAGE_NOT_CONFIGURED', 'STORAGE_SETUP_REQUIRED', 'STORAGE_FORBIDDEN'].includes(error?.code)) {
                return jsonResponse({
                  success: true,
                  authenticated: true,
                  role: auth.role,
                  email: auth.email || null,
                  setupRequired: true,
                  storages: [],
                  listing: { success: true, currentPath: '/', files: [], folders: [], fromIndex: true },
                  favorites: [],
                  tags: []
                });
              }
              return storageRuntimeErrorResponse(error);
            }
          }
        }

        // Auth routes
        if (path === '/api/login' && method === 'POST') {
          try {
            await ensureD1Schema(env);
          } catch (error) {
            return jsonResponse({
              success: false,
              message: 'D1 初始化失败，请确认已绑定 D1_DB: ' + error.message
            }, 500);
          }
          return await handleLogin(request, env);
        }

        if (path === '/api/logout' && method === 'POST') {
          return await handleLogout();
        }

        if (path === '/api/auth/check') {
          return await handleCheckAuth(request, env);
        }
        if (path === '/api/storages' && method === 'GET') {
          return await handleListVisibleStorages(request, env);
        }


        if (path === '/api/bootstrap' && method === 'GET') {
          return await handleBootstrap(request, env);
        }

        if (path === '/api/d1/init' && method === 'GET') {
          const auth = await verifyAuth(request, env);
          if (!auth) return jsonResponse({ success: false }, 401);
          const initialized = await ensureD1Schema(env);
          return jsonResponse({ success: true, initialized });
        }

        if (path === '/api/sync/status' && method === 'GET') {
          const job = await getStorageSyncJob(env, env.STORAGE_ID);
          return jsonResponse({ success: true, sync: syncJobToClient(job) });
        }

        if (path === '/api/cache/refresh' && method === 'POST') {
          return await handleRefreshDirectoryCache(request, env);
        }

        if (path === '/api/search' && method === 'GET') {
          return await handleSearch(request, env);
        }

        if (path === '/api/tags/list' && method === 'GET') {
          return await handleListTags(request, env);
        }

        if (path === '/api/tags' && method === 'PUT') {
          return await handleUpdateTags(request, env);
        }

        if (path === '/api/favorites' && ['GET', 'POST', 'DELETE'].includes(method)) {
          return await handleFavorites(request, env);
        }

        if (path === '/api/recent' && ['GET', 'POST'].includes(method)) {
          return await handleRecent(request, env);
        }

        if (path === '/api/tasks' && method === 'GET') {
          return await handleListTasks(request, env);
        }

        if (path === '/api/tasks' && method === 'POST') {
          return await handleCreateTask(request, env);
        }

        if (path.match(/^\/api\/tasks\/[^/]+\/progress$/) && method === 'PATCH') {
          const taskId = path.split('/')[3];
          return await handleUpdateTaskProgress(request, env, taskId);
        }

        if (path.match(/^\/api\/tasks\/[^/]+\/cancel$/) && method === 'POST') {
          const taskId = path.split('/')[3];
          return await handleCancelTask(request, env, taskId);
        }

        if (path.match(/^\/api\/tasks\/[^/]+\/download$/) && method === 'GET') {
          const taskId = path.split('/')[3];
          return await handleTaskDownload(request, env, taskId);
        }

        if (path.match(/^\/api\/tasks\/[^/]+$/) && method === 'DELETE') {
          const taskId = path.split('/')[3];
          return await handleDeleteTask(request, env, taskId);
        }

        if (path.match(/^\/api\/tasks\/[^/]+\/run$/) && method === 'POST') {
          const taskId = path.split('/')[3];
          return await handleRunTask(request, env, taskId);
        }

        if (path === '/api/reader/progress' && method === 'GET') {
          return await handleGetReaderProgress(request, env, ctx);
        }

        if (path === '/api/reader/progress' && method === 'PUT') {
          return await handlePutReaderProgress(request, env, ctx);
        }

        if (path === '/api/reader/bookmarks' && ['GET', 'POST'].includes(method)) {
          return await handleReaderBookmarks(request, env);
        }

        if (path.match(/^\/api\/reader\/bookmarks\/[^/]+$/) && method === 'DELETE') {
          return await handleDeleteReaderBookmark(request, env, path.split('/').pop());
        }

        if (path === '/api/batch' && method === 'POST') {
          return await handleBatchFileOperation(request, env);
        }

        if (path === '/api/batch/download' && method === 'POST') {
          return await handleBatchDownload(request, env);
        }

        if (path === '/api/folders/search' && method === 'GET') {
          return await handleSearchFolders(request, env);
        }

        if (path === '/api/txt/meta' && method === 'GET') {
          return await handleTxtMeta(request, env);
        }

        if (path === '/api/txt/open' && method === 'GET') {
          return await handleTxtOpen(request, env, ctx);
        }

        if (path === '/api/txt/chunk' && method === 'GET') {
          return await handleTxtChunk(request, env);
        }

        if (path === '/api/txt/index' && method === 'GET') {
          return await handleTxtIndexStatus(request, env);
        }

        if (path === '/api/txt/index' && method === 'POST') {
          return await handleTxtIndexBuild(request, env);
        }

        if (path === '/api/txt/search' && method === 'GET') {
          return await handleTxtSearch(request, env);
        }

        if (path === '/api/txt/search/global' && method === 'GET') {
          return await handleTxtGlobalSearch(request, env);
        }

        if (path === '/api/preview/txt/meta' && method === 'GET') {
          return await handleTxtMeta(request, env);
        }

        if (path === '/api/preview/txt/chunk' && method === 'GET') {
          return await handleTxtChunk(request, env);
        }

        if (path === '/api/preview/txt/search' && method === 'GET') {
          return await handleTxtSearch(request, env);
        }

        // File management routes
        if (path.startsWith('/api/files')) {
          const filePath = safeDecodePath(path.slice('/api/files'.length) || '/');

          if (method === 'GET') {
            return await handleListFiles(request, env, filePath, ctx);
          }
          if (method === 'POST') {
            return await handleUploadFile(request, env, filePath, ctx);
          }
          if (method === 'PUT') {
            return await handleRenameFile(request, env, filePath);
          }
          if (method === 'DELETE') {
            return await handleDeleteFile(request, env, filePath);
          }
        }

        // Folder creation
        if (path === '/api/folders' && method === 'POST') {
          return await handleCreateFolder(request, env);
        }

        // Download route
        if (path.startsWith('/api/download')) {
          const filePath = safeDecodePath(path.slice('/api/download'.length));
          return await handleDownloadFile(request, env, filePath, ctx);
        }

        // Preview route
        if (path.startsWith('/api/preview')) {
          const filePath = safeDecodePath(path.slice('/api/preview'.length));
          return await handlePreviewFile(request, env, filePath, ctx);
        }

        // Share routes
        if (path === '/api/share' && method === 'POST') {
          return await handleCreateShare(request, env);
        }

        if (path.match(/^\/api\/share\/[^/]+$/) && method === 'GET') {
          const shareId = path.split('/').pop();
          return await handleGetShareInfo(request, env, shareId, ctx);
        }

        if (path.match(/^\/api\/share\/[^/]+\/list$/) && method === 'POST') {
          const shareId = path.split('/')[3];
          return await handleShareList(request, env, shareId);
        }

        if (path.match(/^\/api\/share\/[^/]+\/download$/) && method === 'POST') {
          const shareId = path.split('/')[3];
          return await handleShareDownload(request, env, shareId, ctx);
        }

        // Admin routes
        if (path === '/api/admin/storages' && method === 'GET') {
          return await handleAdminListStorages(request, env);
        }

        if (path === '/api/admin/storages/test' && method === 'POST') {
          return await handleAdminTestStorage(request, env);
        }

        if (path === '/api/admin/storages' && method === 'POST') {
          return await handleAdminCreateStorage(request, env);
        }

        if (path.match(/^\/api\/admin\/storages\/[^/]+\/sync$/) && method === 'POST') {
          return await handleAdminTriggerStorageSync(request, env, path.split('/')[4]);
        }

        if (path.match(/^\/api\/admin\/storages\/[^/]+\/sync$/) && method === 'GET') {
          return await handleAdminGetStorageSync(request, env, path.split('/')[4]);
        }

        if (path.match(/^\/api\/admin\/storages\/[^/]+$/) && method === 'PUT') {
          return await handleAdminUpdateStorage(request, env, path.split('/')[4]);
        }

        if (path.match(/^\/api\/admin\/storages\/[^/]+$/) && method === 'DELETE') {
          return await handleAdminDeleteStorage(request, env, path.split('/')[4]);
        }

        if (path === '/api/admin/stats' && method === 'GET') {
          return await handleGetStats(request, env);
        }

        if (path === '/api/admin/shares' && method === 'GET') {
          return await handleListShares(request, env);
        }

        if (path.match(/^\/api\/admin\/shares\/[^/]+$/) && method === 'DELETE') {
          const shareId = path.split('/').pop();
          return await handleDeleteShare(request, env, shareId);
        }

        if (path === '/api/admin/users' && method === 'GET') {
          return await handleListUsers(request, env);
        }

        if (path === '/api/admin/users' && method === 'POST') {
          return await handleCreateUser(request, env);
        }

        if (path === '/api/admin/resources/search' && method === 'GET') {
          return await handleAdminSearchResources(request, env);
        }

        if (path === '/api/admin/resources/list' && method === 'GET') {
          return await handleAdminListResources(request, env);
        }

        if (path === '/api/admin/debug/storage' && method === 'GET') {
          return await handleAdminStorageDebug(request, env);
        }

        if (path === '/api/admin/txt/rebuild' && method === 'POST') {
          return await handleAdminTxtRebuild(request, env);
        }

        if (path.match(/^\/api\/admin\/users\/[^/]+\/permissions$/) && method === 'GET') {
          const email = path.split('/')[4];
          return await handleGetUserPermissions(request, env, email);
        }

        if (path.match(/^\/api\/admin\/users\/[^/]+\/permissions$/) && method === 'PUT') {
          const email = path.split('/')[4];
          return await handleUpdateUserPermissions(request, env, email);
        }

        if (path.match(/^\/api\/admin\/users\/[^/]+$/) && method === 'DELETE') {
          const email = path.split('/').pop();
          return await handleDeleteUser(request, env, email);
        }

        return jsonResponse({ success: false, message: 'API 路径不存在' }, 404);
      }

      // Share page route
      if (path.startsWith('/s/')) {
        return htmlResponse(FIXED_SHARE_PAGE);
      }

      // Static page routes
      if (path === '/login.html' || path === '/login') {
        return htmlResponse(FIXED_LOGIN_PAGE);
      }

      if (path === '/admin.html' || path === '/admin') {
        // Check iadmin
        const auth = await verifyAuth(request, env);
        if (!auth || auth.role !== 'admin') {
          return Response.redirect(url.origin + '/login.html', 302);
        }
        return htmlResponse(FIXED_ADMIN_PAGE);
      }

      // Root and index - check auth
      if (path === '/' || path === '/index.html') {
        const auth = await verifyAuth(request, env);
        if (!auth) {
          return Response.redirect(url.origin + '/login.html', 302);
        }
        return htmlResponse(FIXED_INDEX_PAGE);
      }

      // Default: redirect to root
      return Response.redirect(url.origin + '/', 302);

    } catch (error) {
      console.error('Error:', error);
      return jsonResponse({ success: false, message: '服务器错误: ' + error.message }, 500);
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      await ensureD1Schema(env);
      await runScheduledMaintenance(env, controller.scheduledTime, processPendingTxtIndexes);
    })());
  }
};
