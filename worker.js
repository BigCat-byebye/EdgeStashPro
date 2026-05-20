/**
 * EdgeStash - Cloudflare-based Cloud Drive
 * 
 * A complete cloud storage solution built on Cloudflare Worker, R2, and KV.
 * 
 * Environment Variables (set in Cloudflare Dashboard):
 * - ADMIN_PASSWORD: Administrator password for login
 * 
 * Bindings (set in Cloudflare Dashboard):
 * - R2_BUCKET: R2 bucket binding for file storage
 * - KV_STORE: KV namespace binding for metadata storage
 */

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Generate a random string for IDs and tokens
 */
function generateId(length = 16) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const randomValues = new Uint8Array(length);
  crypto.getRandomValues(randomValues);
  for (let i = 0; i < length; i++) {
    result += chars[randomValues[i] % chars.length];
  }
  return result;
}

/**
 * Hash a password using SHA-256
 */
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value) {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Create a JWT token
 */
async function createJWT(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = btoa(JSON.stringify(header)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const encodedPayload = btoa(JSON.stringify(payload)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${encodedHeader}.${encodedPayload}`)
  );
  
  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  
  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

/**
 * Verify a JWT token
 */
async function verifyJWT(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    
    const signatureData = Uint8Array.from(atob(encodedSignature.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      signatureData,
      encoder.encode(`${encodedHeader}.${encodedPayload}`)
    );
    
    if (!valid) return null;
    
    const payload = JSON.parse(atob(encodedPayload.replace(/-/g, '+').replace(/_/g, '/')));
    
    // Check expiration
    if (payload.exp && Date.now() > payload.exp) return null;
    
    return payload;
  } catch (e) {
    return null;
  }
}

/**
 * Get expiration timestamp based on duration string
 */
function getExpirationTime(expiresIn) {
  const now = Date.now();
  switch (expiresIn) {
    case '1h': return now + 60 * 60 * 1000;
    case '1d': return now + 24 * 60 * 60 * 1000;
    case '1m': return now + 30 * 24 * 60 * 60 * 1000;
    case 'permanent': return null;
    default: return now + 24 * 60 * 60 * 1000;
  }
}

/**
 * Format file size for display
 */
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Get MIME type from file extension
 */
function getMimeType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const mimeTypes = {
    'html': 'text/html',
    'css': 'text/css',
    'js': 'application/javascript',
    'json': 'application/json',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
    'webp': 'image/webp',
    'ico': 'image/x-icon',
    'pdf': 'application/pdf',
    'zip': 'application/zip',
    'txt': 'text/plain',
    'md': 'text/markdown',
    'mp3': 'audio/mpeg',
    'mp4': 'video/mp4',
    'webm': 'video/webm',
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'ppt': 'application/vnd.ms-powerpoint',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Safely decode a URL pathname segment/path for R2 keys.
 * Browsers percent-encode non-ASCII path chars (for example Chinese names),
 * while R2 keys are stored as the original UTF-8 strings.
 */
function safeDecodePath(path) {
  try {
    return decodeURIComponent(path);
  } catch (e) {
    return path;
  }
}

/**
 * Encode filename for Content-Disposition according to RFC 5987.
 */
function encodeRFC5987ValueChars(value) {
  return encodeURIComponent(value).replace(/['()*]/g, char =>
    '%' + char.charCodeAt(0).toString(16).toUpperCase()
  );
}

function createAttachmentDisposition(filename) {
  const fallback = filename
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_') || 'download';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRFC5987ValueChars(filename)}`;
}

function createInlineDisposition(filename) {
  const fallback = filename
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_') || 'preview';
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeRFC5987ValueChars(filename)}`;
}

const DIRECTORY_CACHE_PREFIX = 'cache:dir:';

function normalizeDirectoryPath(path) {
  let normalized = path || '/';
  if (!normalized.startsWith('/')) normalized = '/' + normalized;
  normalized = normalized.replace(/\/+/g, '/');
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized || '/';
}

function normalizeItemPath(path) {
  let normalized = path || '/';
  if (!normalized.startsWith('/')) normalized = '/' + normalized;
  normalized = normalized.replace(/\/+/g, '/');
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function directoryPathToR2Prefix(path) {
  const normalized = normalizeDirectoryPath(path);
  return normalized === '/' ? '' : normalized.slice(1) + '/';
}

function r2KeyToPath(key) {
  return normalizeItemPath('/' + (key || '').replace(/^\/+/, ''));
}

function parentPathFromItemPath(path) {
  const normalized = normalizeItemPath(path);
  if (normalized === '/') return '/';
  const slashIndex = normalized.lastIndexOf('/');
  return slashIndex <= 0 ? '/' : normalized.slice(0, slashIndex);
}

function nameFromItemPath(path) {
  const normalized = normalizeItemPath(path);
  if (normalized === '/') return '';
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function parentPathFromR2Key(key) {
  return parentPathFromItemPath(r2KeyToPath(key));
}

function isoDateString(value) {
  if (!value) return new Date().toISOString();
  if (typeof value.toISOString === 'function') return value.toISOString();
  return new Date(value).toISOString();
}

function cacheItemsToResponse(items, currentPath) {
  const folders = [];
  const files = [];

  for (const item of items) {
    if (item.itemType === 'folder') {
      folders.push({
        name: item.name,
        path: item.path
      });
    } else {
      files.push({
        name: item.name,
        path: item.path,
        size: item.size || 0,
        sizeFormatted: formatFileSize(item.size || 0),
        lastModified: item.lastModified,
        previewType: item.previewType || null
      });
    }
  }

  folders.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  files.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));

  return { success: true, files, folders, currentPath };
}

async function listDirectoryFromR2(env, dirPath) {
  const currentPath = normalizeDirectoryPath(dirPath);
  const prefix = directoryPathToR2Prefix(currentPath);
  const folderMap = new Map();
  const fileMap = new Map();
  let cursor;

  do {
    const listed = await env.R2_BUCKET.list({ prefix, delimiter: '/', cursor });

    if (listed.delimitedPrefixes) {
      for (const folderPath of listed.delimitedPrefixes) {
        const path = r2KeyToPath(folderPath.slice(0, -1));
        const name = folderPath.slice(prefix.length, -1);
        if (name) {
          folderMap.set(path, {
            itemType: 'folder',
            name,
            path,
            parentPath: currentPath,
            r2Key: folderPath.slice(0, -1),
            size: 0,
            contentType: null,
            previewType: null,
            lastModified: null
          });
        }
      }
    }

    if (listed.objects) {
      for (const obj of listed.objects) {
        const name = obj.key.slice(prefix.length);
        if (!name || name === '.folder' || name.includes('/')) continue;

        const path = r2KeyToPath(obj.key);
        fileMap.set(path, {
          itemType: 'file',
          name,
          path,
          parentPath: currentPath,
          r2Key: obj.key,
          size: obj.size || 0,
          contentType: obj.httpMetadata?.contentType || getMimeType(name),
          previewType: getPreviewType(name),
          lastModified: isoDateString(obj.uploaded)
        });
      }
    }

    cursor = listed.truncated ? listed.cursor : null;
  } while (cursor);

  const items = [...folderMap.values(), ...fileMap.values()];
  return {
    ...cacheItemsToResponse(items, currentPath),
    items
  };
}

function directoryCacheKey(dirPath) {
  return DIRECTORY_CACHE_PREFIX + normalizeDirectoryPath(dirPath);
}

async function readDirectoryCache(env, dirPath) {
  const currentPath = normalizeDirectoryPath(dirPath);
  const cachedValue = await env.KV_STORE.get(directoryCacheKey(currentPath), 'json');
  let cached = cachedValue;

  if (!cached) return null;
  if (typeof cached === 'string') {
    cached = JSON.parse(cached);
  }
  if (cached.currentPath !== currentPath) return null;

  const files = Array.isArray(cached.files) ? cached.files : [];
  const folders = Array.isArray(cached.folders) ? cached.folders : [];
  return {
    success: true,
    files,
    folders,
    currentPath,
    cached: true,
    refreshedAt: cached.refreshedAt || null
  };
}

async function writeDirectoryCache(env, dirPath, listing) {
  const currentPath = normalizeDirectoryPath(dirPath);
  const payload = {
    success: true,
    files: listing.files || [],
    folders: listing.folders || [],
    currentPath,
    refreshedAt: Date.now()
  };

  await env.KV_STORE.put(directoryCacheKey(currentPath), JSON.stringify(payload));
  return {
    ...payload,
    cached: false
  };
}

async function deleteDirectoryCache(env, dirPath) {
  await env.KV_STORE.delete(directoryCacheKey(dirPath));
}

async function deleteDirectoryCacheTree(env, dirPath) {
  const currentPath = normalizeDirectoryPath(dirPath);
  const exactKey = directoryCacheKey(currentPath);
  const prefix = currentPath === '/'
    ? DIRECTORY_CACHE_PREFIX
    : exactKey + '/';

  await env.KV_STORE.delete(exactKey);

  let cursor;
  do {
    const listed = await env.KV_STORE.list({ prefix, cursor });
    const keys = listed.keys || [];
    for (const key of keys) {
      await env.KV_STORE.delete(key.name);
    }
    cursor = listed.list_complete ? null : listed.cursor;
  } while (cursor);
}

async function invalidateCachePath(env, path) {
  try {
    const itemPath = normalizeItemPath(path);
    const parentPath = parentPathFromItemPath(itemPath);
    await deleteDirectoryCache(env, parentPath);
    await deleteDirectoryCacheTree(env, itemPath);
  } catch (e) {
    console.warn('KV directory cache invalidation failed:', e.message);
  }
}

async function refreshDirectoryCache(env, dirPath) {
  const currentPath = normalizeDirectoryPath(dirPath);
  const listing = await listDirectoryFromR2(env, currentPath);

  try {
    const previous = await readDirectoryCache(env, currentPath).catch(() => null);
    const newFolderPaths = new Set((listing.folders || []).map(folder => folder.path));

    if (previous) {
      for (const folder of previous.folders || []) {
        if (!newFolderPaths.has(folder.path)) {
          await deleteDirectoryCacheTree(env, folder.path);
        }
      }
    }

    return await writeDirectoryCache(env, currentPath, listing);
  } catch (e) {
    console.warn('KV directory cache refresh failed:', e.message);
    return {
      success: true,
      files: listing.files,
      folders: listing.folders,
      currentPath,
      cached: false,
      cacheWarning: e.message
    };
  }
}

async function syncFileCacheIfParentCached(env, key, metadata = {}) {
  try {
    await deleteDirectoryCache(env, parentPathFromR2Key(key));
  } catch (e) {
    console.warn('KV file cache sync failed:', e.message);
  }
}

async function syncFolderCacheIfParentCached(env, key) {
  try {
    const path = r2KeyToPath(key);
    await deleteDirectoryCache(env, parentPathFromItemPath(path));
  } catch (e) {
    console.warn('KV folder cache sync failed:', e.message);
  }
}

/**
 * Check if file is previewable
 */
function getPreviewType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  
  // Image files
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'ico', 'bmp'].includes(ext)) {
    return 'image';
  }
  
  // PDF files
  if (ext === 'pdf') {
    return 'pdf';
  }
  
  // Text/code files
  if (['txt', 'md', 'json', 'js', 'ts', 'css', 'html', 'xml', 'yaml', 'yml', 'ini', 'conf', 'sh', 'bash', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'go', 'rs', 'sql', 'log'].includes(ext)) {
    return 'text';
  }
  
  // Word documents (use Mammoth.js)
  if (ext === 'docx') {
    return 'word';
  }
  
  // Video files
  if (['mp4', 'webm', 'ogg'].includes(ext)) {
    return 'video';
  }
  
  // Audio files
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) {
    return 'audio';
  }
  
  return null;
}

/**
 * Parse cookies from request
 */
function parseCookies(request) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const cookies = {};
  cookieHeader.split(';').forEach(cookie => {
    const [name, value] = cookie.trim().split('=');
    if (name && value) {
      cookies[name] = decodeURIComponent(value);
    }
  });
  return cookies;
}

/**
 * Create JSON response
 */
function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    }
  });
}

/**
 * Create HTML response
 */
function htmlResponse(html, status = 200, headers = {}) {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      ...headers
    }
  });
}

// ============================================================================
// AUTHENTICATION HANDLERS
// ============================================================================

async function handleLogin(request, env) {
  try {
    const body = await request.json();
    const { email, password, isAdmin } = body;
    
    if (isAdmin) {
      // Admin login
      if (password === env.ADMIN_PASSWORD) {
        const token = await createJWT(
          { role: 'admin', exp: Date.now() + 24 * 60 * 60 * 1000 },
          env.ADMIN_PASSWORD
        );
        return jsonResponse(
          { success: true, role: 'admin' },
          200,
          { 'Set-Cookie': `token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400` }
        );
      }
      return jsonResponse({ success: false, message: '管理员密码错误' }, 401);
    } else {
      // User login
      if (!email || !password) {
        return jsonResponse({ success: false, message: '请输入邮箱和密码' }, 400);
      }
      
      const userData = await env.KV_STORE.get(`user:${email}`);
      if (!userData) {
        return jsonResponse({ success: false, message: '用户不存在' }, 401);
      }
      
      const user = JSON.parse(userData);
      const passwordHash = await hashPassword(password);
      
      if (user.passwordHash !== passwordHash) {
        return jsonResponse({ success: false, message: '密码错误' }, 401);
      }
      
      const token = await createJWT(
        { email: user.email, role: 'user', exp: Date.now() + 24 * 60 * 60 * 1000 },
        env.ADMIN_PASSWORD
      );
      
      return jsonResponse(
        { success: true, role: 'user', email: user.email },
        200,
        { 'Set-Cookie': `token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400` }
      );
    }
  } catch (e) {
    return jsonResponse({ success: false, message: '登录失败: ' + e.message }, 500);
  }
}

async function handleLogout() {
  return jsonResponse(
    { success: true },
    200,
    { 'Set-Cookie': 'token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' }
  );
}

async function verifyAuth(request, env) {
  const cookies = parseCookies(request);
  const token = cookies.token;
  
  if (!token) return null;
  
  return await verifyJWT(token, env.ADMIN_PASSWORD);
}

async function requireAuth(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) {
    return jsonResponse({ success: false, message: '未授权' }, 401);
  }
  return auth;
}

async function requireAdmin(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth || auth.role !== 'admin') {
    return jsonResponse({ success: false, message: '需要管理员权限' }, 403);
  }
  return auth;
}

// ============================================================================
// FILE MANAGEMENT HANDLERS
// ============================================================================

async function handleListFiles(request, env, path) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  
  try {
    const currentPath = normalizeDirectoryPath(path);
    let cached = null;
    try {
      cached = await readDirectoryCache(env, currentPath);
    } catch (cacheError) {
      console.warn('KV directory cache read failed:', cacheError.message);
    }

    if (cached) {
      return jsonResponse(cached);
    }

    const fresh = await refreshDirectoryCache(env, currentPath);
    return jsonResponse(fresh);
  } catch (e) {
    return jsonResponse({ success: false, message: '获取文件列表失败: ' + e.message }, 500);
  }
}

async function handleRefreshDirectoryCache(request, env) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const body = await request.json().catch(() => ({}));
    const currentPath = normalizeDirectoryPath(body.path || '/');
    const refreshed = await refreshDirectoryCache(env, currentPath);
    return jsonResponse(refreshed);
  } catch (e) {
    return jsonResponse({ success: false, message: '刷新缓存失败: ' + e.message }, 500);
  }
}

async function handleUploadFile(request, env, path) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    
    if (!file) {
      return jsonResponse({ success: false, message: '没有上传文件' }, 400);
    }
    
    // Normalize path
    let filePath = path || '';
    if (filePath.startsWith('/')) filePath = filePath.slice(1);
    if (filePath && !filePath.endsWith('/')) filePath += '/';
    
    const key = filePath + file.name;
    
    await env.R2_BUCKET.put(key, file.stream(), {
      httpMetadata: { contentType: file.type || getMimeType(file.name) }
    });

    await syncFileCacheIfParentCached(env, key, {
      size: file.size || 0,
      contentType: file.type || getMimeType(file.name),
      lastModified: new Date().toISOString()
    });
    
    return jsonResponse({ success: true, message: '文件上传成功', path: '/' + key });
  } catch (e) {
    return jsonResponse({ success: false, message: '文件上传失败: ' + e.message }, 500);
  }
}

async function handleDeleteFile(request, env, path) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  
  try {
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
    const body = await request.json();
    const { newName } = body;
    
    if (!newName) {
      return jsonResponse({ success: false, message: '请提供新名称' }, 400);
    }
    
    let oldKey = path || '';
    if (oldKey.startsWith('/')) oldKey = oldKey.slice(1);
    
    const parentPath = oldKey.includes('/') ? oldKey.substring(0, oldKey.lastIndexOf('/') + 1) : '';
    const newKey = parentPath + newName;
    
    // Get the old file
    const oldObject = await env.R2_BUCKET.get(oldKey);
    if (oldObject) {
      // Copy to new location
      await env.R2_BUCKET.put(newKey, oldObject.body, {
        httpMetadata: oldObject.httpMetadata
      });

      // Delete old file
      await env.R2_BUCKET.delete(oldKey);
      await invalidateCachePath(env, r2KeyToPath(oldKey));

      const newObject = await env.R2_BUCKET.head(newKey);
      await syncFileCacheIfParentCached(env, newKey, {
        size: newObject?.size || oldObject.size || 0,
        contentType: newObject?.httpMetadata?.contentType || oldObject.httpMetadata?.contentType || getMimeType(newName),
        lastModified: isoDateString(newObject?.uploaded || new Date())
      });

      return jsonResponse({ success: true, message: '重命名成功', newPath: '/' + newKey });
    }

    const oldPrefix = oldKey.endsWith('/') ? oldKey : oldKey + '/';
    const folderCheck = await env.R2_BUCKET.list({ prefix: oldPrefix, limit: 1 });
    if (!folderCheck.objects || folderCheck.objects.length === 0) {
      return jsonResponse({ success: false, message: '文件不存在' }, 404);
    }

    const newPrefix = newKey.endsWith('/') ? newKey : newKey + '/';
    let cursor;
    do {
      const batch = await env.R2_BUCKET.list({ prefix: oldPrefix, cursor });
      const oldKeys = [];

      if (batch.objects && batch.objects.length > 0) {
        for (const obj of batch.objects) {
          const targetKey = newPrefix + obj.key.slice(oldPrefix.length);
          const source = await env.R2_BUCKET.get(obj.key);
          if (source) {
            await env.R2_BUCKET.put(targetKey, source.body, {
              httpMetadata: source.httpMetadata
            });
            oldKeys.push(obj.key);
          }
        }
      }

      if (oldKeys.length > 0) {
        await env.R2_BUCKET.delete(oldKeys);
      }

      cursor = batch.truncated ? batch.cursor : null;
    } while (cursor);

    await invalidateCachePath(env, r2KeyToPath(oldKey));
    await syncFolderCacheIfParentCached(env, newKey);

    return jsonResponse({ success: true, message: '重命名成功', newPath: '/' + newKey });
  } catch (e) {
    return jsonResponse({ success: false, message: '重命名失败: ' + e.message }, 500);
  }
}

function itemPathToR2Key(path) {
  const normalized = normalizeItemPath(path);
  return normalized === '/' ? '' : normalized.slice(1);
}

function joinItemPath(parentPath, name) {
  const parent = normalizeDirectoryPath(parentPath);
  return parent === '/' ? '/' + name : parent + '/' + name;
}

async function folderExists(env, folderPath) {
  const normalized = normalizeDirectoryPath(folderPath);
  if (normalized === '/') return true;

  const prefix = directoryPathToR2Prefix(normalized);
  const listed = await env.R2_BUCKET.list({ prefix, limit: 1 });
  return !!(listed.objects && listed.objects.length > 0);
}

async function destinationExists(env, key, isFolder) {
  if (isFolder) {
    const listed = await env.R2_BUCKET.list({ prefix: key + '/', limit: 1 });
    return !!(listed.objects && listed.objects.length > 0);
  }
  return !!(await env.R2_BUCKET.head(key));
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

  for (let index = 1; index <= 999; index++) {
    const candidate = parent + copyNameCandidate(name, index);
    if (!(await destinationExists(env, candidate, isFolder))) {
      return candidate;
    }
  }

  throw new Error('目标目录中存在太多同名项目');
}

async function deleteItemAtPath(env, path) {
  const key = itemPathToR2Key(path);
  if (!key) throw new Error('不能操作根目录');

  const listed = await env.R2_BUCKET.list({ prefix: key + '/', limit: 1 });
  if (listed.objects && listed.objects.length > 0) {
    let cursor;
    do {
      const batch = await env.R2_BUCKET.list({ prefix: key + '/', cursor });
      if (batch.objects && batch.objects.length > 0) {
        await deleteR2Keys(env, batch.objects.map(obj => obj.key));
      }
      cursor = batch.truncated ? batch.cursor : null;
    } while (cursor);
  }

  await env.R2_BUCKET.delete(key);
  await invalidateCachePath(env, r2KeyToPath(key));
}

async function deleteR2Keys(env, keys) {
  for (let index = 0; index < keys.length; index += 1000) {
    await env.R2_BUCKET.delete(keys.slice(index, index + 1000));
  }
}

async function copyR2Object(env, sourceKey, targetKey) {
  const object = await env.R2_BUCKET.get(sourceKey);
  if (!object) return false;

  await env.R2_BUCKET.put(targetKey, object.body, {
    httpMetadata: object.httpMetadata,
    customMetadata: object.customMetadata
  });
  return true;
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

  const sourceObject = await env.R2_BUCKET.head(sourceKey);
  const sourcePrefix = sourceKey + '/';
  const folderCheck = sourceObject ? null : await env.R2_BUCKET.list({ prefix: sourcePrefix, limit: 1 });
  const isFolder = !sourceObject && !!(folderCheck.objects && folderCheck.objects.length > 0);

  if (!sourceObject && !isFolder) {
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
      const batch = await env.R2_BUCKET.list({ prefix: sourcePrefix, cursor });
      if (batch.objects && batch.objects.length > 0) {
        for (const obj of batch.objects) {
          const relativeKey = obj.key.slice(sourcePrefix.length);
          const copied = await copyR2Object(env, obj.key, targetPrefix + relativeKey);
          if (copied) copiedKeys.push(obj.key);
        }
      }
      cursor = batch.truncated ? batch.cursor : null;
    } while (cursor);

    if (shouldMove && copiedKeys.length > 0) {
      await deleteR2Keys(env, copiedKeys);
    }
  } else {
    await copyR2Object(env, sourceKey, targetKey);
    if (shouldMove) {
      await env.R2_BUCKET.delete(sourceKey);
    }
  }

  if (shouldMove) {
    await invalidateCachePath(env, normalizedSourcePath);
  }
  await invalidateCachePath(env, targetPath);

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

    const results = [];
    const errors = [];

    for (const item of items) {
      const itemPath = normalizeItemPath(typeof item === 'string' ? item : item.path);
      try {
        if (!itemPath || itemPath === '/') {
          throw new Error('不能操作根目录');
        }

        if (operation === 'delete') {
          await deleteItemAtPath(env, itemPath);
          results.push({ path: itemPath });
        } else {
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
    const key = itemPathToR2Key(itemPath);
    if (!key) throw new Error('不能打包根目录');

    const fileObject = await env.R2_BUCKET.head(key);
    if (fileObject) {
      if (usedKeys.has(key)) continue;
      usedKeys.add(key);
      addZipEntry(entries, usedNames, {
        name: nameFromItemPath(itemPath),
        key,
        isDirectory: false,
        lastModified: fileObject.uploaded
      });
      continue;
    }

    const prefix = key + '/';
    let cursor;
    let foundFolderObject = false;
    const directoryName = uniqueZipEntryName(nameFromItemPath(itemPath) + '/', usedNames);
    const directoryNameBytes = new TextEncoder().encode(directoryName);
    if (directoryNameBytes.length > 0xffff) {
      throw new Error('文件名过长，无法打包: ' + directoryName);
    }
    entries.push({
      name: directoryName,
      nameBytes: directoryNameBytes,
      isDirectory: true,
      lastModified: new Date()
    });

    do {
      const listed = await env.R2_BUCKET.list({ prefix, cursor });
      for (const obj of listed.objects || []) {
        foundFolderObject = true;
        const relativeName = obj.key.slice(prefix.length);
        if (!relativeName || relativeName === '.folder') continue;
        if (relativeName.endsWith('/.folder')) {
          addZipEntry(entries, usedNames, {
            name: directoryName + relativeName.slice(0, -'.folder'.length),
            isDirectory: true,
            lastModified: obj.uploaded
          });
          continue;
        }
        if (usedKeys.has(obj.key)) continue;
        usedKeys.add(obj.key);
        addZipEntry(entries, usedNames, {
          name: directoryName + relativeName,
          key: obj.key,
          isDirectory: false,
          lastModified: obj.uploaded
        });
      }
      cursor = listed.truncated ? listed.cursor : null;
    } while (cursor);

    if (!foundFolderObject) {
      throw new Error('项目不存在: ' + itemPath);
    }
  }

  if (entries.length === 0) {
    throw new Error('没有可打包的文件');
  }
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
            const object = await env.R2_BUCKET.get(entry.key);
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
    if (items.length === 0) {
      return jsonResponse({ success: false, message: '请选择要下载的文件或文件夹' }, 400);
    }

    const entries = await collectBatchDownloadEntries(env, items);
    const filename = 'edgestash-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.zip';

    return new Response(createZipStream(env, entries), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': createAttachmentDisposition(filename)
      }
    });
  } catch (e) {
    return jsonResponse({ success: false, message: '批量下载失败: ' + e.message }, 500);
  }
}

function addFolderPathsFromR2Key(folderPaths, key) {
  const parts = (key || '').split('/').filter(Boolean);
  const folderParts = parts.slice(0, -1);

  for (let index = 0; index < folderParts.length; index++) {
    folderPaths.add('/' + folderParts.slice(0, index + 1).join('/'));
  }
}

async function handleSearchFolders(request, env) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const url = new URL(request.url);
    const query = (url.searchParams.get('q') || '').trim().toLowerCase();
    const requestedLimit = Number(url.searchParams.get('limit') || 50);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(100, Math.max(1, requestedLimit))
      : 50;
    const folderPaths = new Set(['/']);
    let cursor;
    let scanned = 0;
    const maxScannedObjects = 20000;

    do {
      const listed = await env.R2_BUCKET.list({ cursor, limit: 1000 });
      const objects = listed.objects || [];
      for (const obj of objects) {
        addFolderPathsFromR2Key(folderPaths, obj.key);
      }
      scanned += objects.length;
      cursor = listed.truncated ? listed.cursor : null;
    } while (cursor && scanned < maxScannedObjects);

    const folders = Array.from(folderPaths)
      .filter(path => {
        if (!query) return true;
        return path.toLowerCase().includes(query) || nameFromItemPath(path).toLowerCase().includes(query);
      })
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
      .slice(0, limit)
      .map(path => ({
        path,
        name: path === '/' ? '根目录' : nameFromItemPath(path)
      }));

    return jsonResponse({
      success: true,
      folders,
      truncated: !!cursor,
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
    
    if (folderPath.startsWith('/')) folderPath = folderPath.slice(1);
    if (!folderPath.endsWith('/')) folderPath += '/';
    
    // Create an empty placeholder file to represent the folder
    await env.R2_BUCKET.put(folderPath + '.folder', new Uint8Array(0));
    await syncFolderCacheIfParentCached(env, folderPath.slice(0, -1));
    
    return jsonResponse({ success: true, message: '文件夹创建成功', path: '/' + folderPath.slice(0, -1) });
  } catch (e) {
    return jsonResponse({ success: false, message: '创建文件夹失败: ' + e.message }, 500);
  }
}

async function handleDownloadFile(request, env, path) {
  const auth = await verifyAuth(request, env);
  if (!auth) {
    return jsonResponse({ success: false, message: '未授权' }, 401);
  }
  
  try {
    let key = path || '';
    if (key.startsWith('/')) key = key.slice(1);
    
    const object = await env.R2_BUCKET.get(key);
    if (!object) {
      return jsonResponse({ success: false, message: '文件不存在' }, 404);
    }
    
    const filename = key.split('/').pop();
    
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
async function handlePreviewFile(request, env, path) {
  const auth = await verifyAuth(request, env);
  if (!auth) {
    return jsonResponse({ success: false, message: '未授权' }, 401);
  }
  
  try {
    let key = path || '';
    if (key.startsWith('/')) key = key.slice(1);
    
    const object = await env.R2_BUCKET.get(key, {
      range: request.headers
    });
    if (!object) {
      return jsonResponse({ success: false, message: '文件不存在' }, 404);
    }
    
    const filename = key.split('/').pop();
    const contentType = object.httpMetadata?.contentType || getMimeType(filename);
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
      const end = object.range.end ?? object.size - 1;
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

async function readerProgressKey(auth, path) {
  const normalizedPath = normalizeItemPath(path);
  const pathHash = await sha256Hex(normalizedPath);
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

async function handleGetReaderProgress(request, env) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const url = new URL(request.url);
    const filePath = normalizeItemPath(url.searchParams.get('path') || '');

    if (!filePath || filePath === '/' || !isTxtReaderPath(filePath)) {
      return jsonResponse({ success: false, message: '只支持保存 txt 文件阅读进度' }, 400);
    }

    const key = await readerProgressKey(auth, filePath);
    const progress = await env.KV_STORE.get(key, 'json');
    return jsonResponse({ success: true, progress: progress || null });
  } catch (e) {
    return jsonResponse({ success: false, message: '读取阅读进度失败: ' + e.message }, 500);
  }
}

async function handlePutReaderProgress(request, env) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    const body = await request.json();
    const filePath = normalizeItemPath(body.path || '');

    if (!filePath || filePath === '/' || !isTxtReaderPath(filePath)) {
      return jsonResponse({ success: false, message: '只支持保存 txt 文件阅读进度' }, 400);
    }

    const value = {
      path: filePath,
      charOffset: Math.floor(normalizeReaderNumber(body.charOffset, 0, 0, Number.MAX_SAFE_INTEGER)),
      progress: normalizeReaderNumber(body.progress, 0, 0, 1),
      scrollTop: normalizeReaderNumber(body.scrollTop, 0, 0, Number.MAX_SAFE_INTEGER),
      scrollHeight: normalizeReaderNumber(body.scrollHeight, 0, 0, Number.MAX_SAFE_INTEGER),
      updatedAt: Date.now()
    };

    const key = await readerProgressKey(auth, filePath);
    await env.KV_STORE.put(key, JSON.stringify(value));

    return jsonResponse({ success: true, progress: value });
  } catch (e) {
    return jsonResponse({ success: false, message: '保存阅读进度失败: ' + e.message }, 500);
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
    
    if (!filePath) {
      return jsonResponse({ success: false, message: '请提供文件路径' }, 400);
    }
    
    // Verify file exists
    let key = filePath;
    if (key.startsWith('/')) key = key.slice(1);
    
    const object = await env.R2_BUCKET.head(key);
    if (!object) {
      return jsonResponse({ success: false, message: '文件不存在' }, 404);
    }
    
    const shareId = generateId(12);
    const shareData = {
      shareId,
      filePath: key,
      fileName: key.split('/').pop(),
      fileSize: object.size,
      passwordHash: password ? await hashPassword(password) : null,
      expiresAt: getExpirationTime(expiresIn || '1d'),
      viewCount: 0,
      downloadCount: 0,
      createdAt: Date.now()
    };
    
    await env.KV_STORE.put(`share:${shareId}`, JSON.stringify(shareData));
    
    // Update stats
    const totalShares = parseInt(await env.KV_STORE.get('stats:totalShares') || '0');
    await env.KV_STORE.put('stats:totalShares', String(totalShares + 1));
    
    return jsonResponse({
      success: true,
      shareId,
      shareUrl: `/s/${shareId}`
    });
  } catch (e) {
    return jsonResponse({ success: false, message: '创建分享链接失败: ' + e.message }, 500);
  }
}

async function handleGetShareInfo(request, env, shareId) {
  try {
    const shareData = await env.KV_STORE.get(`share:${shareId}`);
    if (!shareData) {
      return jsonResponse({ success: false, message: '分享链接不存在' }, 404);
    }
    
    const share = JSON.parse(shareData);
    
    // Check expiration
    if (share.expiresAt && Date.now() > share.expiresAt) {
      return jsonResponse({ success: false, message: '分享链接已过期' }, 410);
    }
    
    // Update view count
    share.viewCount++;
    await env.KV_STORE.put(`share:${shareId}`, JSON.stringify(share));
    
    // Update global stats
    const totalViews = parseInt(await env.KV_STORE.get('stats:totalViews') || '0');
    await env.KV_STORE.put('stats:totalViews', String(totalViews + 1));
    
    return jsonResponse({
      success: true,
      fileName: share.fileName,
      fileSize: share.fileSize,
      fileSizeFormatted: formatFileSize(share.fileSize),
      requiresPassword: !!share.passwordHash,
      expiresAt: share.expiresAt
    });
  } catch (e) {
    return jsonResponse({ success: false, message: '获取分享信息失败: ' + e.message }, 500);
  }
}

async function handleShareDownload(request, env, shareId) {
  try {
    const shareData = await env.KV_STORE.get(`share:${shareId}`);
    if (!shareData) {
      return jsonResponse({ success: false, message: '分享链接不存在' }, 404);
    }
    
    const share = JSON.parse(shareData);
    
    // Check expiration
    if (share.expiresAt && Date.now() > share.expiresAt) {
      return jsonResponse({ success: false, message: '分享链接已过期' }, 410);
    }
    
    // Check password
    if (share.passwordHash) {
      const body = await request.json();
      const { password } = body;
      
      if (!password) {
        return jsonResponse({ success: false, message: '请输入密码' }, 401);
      }
      
      const passwordHash = await hashPassword(password);
      if (passwordHash !== share.passwordHash) {
        return jsonResponse({ success: false, message: '密码错误' }, 401);
      }
    }
    
    // Get file from R2
    const object = await env.R2_BUCKET.get(share.filePath);
    if (!object) {
      return jsonResponse({ success: false, message: '文件不存在' }, 404);
    }
    
    // Update download count
    share.downloadCount++;
    await env.KV_STORE.put(`share:${shareId}`, JSON.stringify(share));
    
    // Update global stats
    const totalDownloads = parseInt(await env.KV_STORE.get('stats:totalDownloads') || '0');
    await env.KV_STORE.put('stats:totalDownloads', String(totalDownloads + 1));
    
    return new Response(object.body, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType || getMimeType(share.fileName),
        'Content-Disposition': createAttachmentDisposition(share.fileName),
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
    const totalShares = parseInt(await env.KV_STORE.get('stats:totalShares') || '0');
    const totalViews = parseInt(await env.KV_STORE.get('stats:totalViews') || '0');
    const totalDownloads = parseInt(await env.KV_STORE.get('stats:totalDownloads') || '0');
    
    return jsonResponse({
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
    const shares = [];
    let cursor;
    
    do {
      const listed = await env.KV_STORE.list({ prefix: 'share:', cursor });
      for (const key of listed.keys) {
        const data = await env.KV_STORE.get(key.name);
        if (data) {
          const share = JSON.parse(data);
          shares.push({
            ...share,
            fileSizeFormatted: formatFileSize(share.fileSize),
            isExpired: share.expiresAt && Date.now() > share.expiresAt
          });
        }
      }
      cursor = listed.list_complete ? null : listed.cursor;
    } while (cursor);
    
    // Sort by creation date, newest first
    shares.sort((a, b) => b.createdAt - a.createdAt);
    
    return jsonResponse({ success: true, shares });
  } catch (e) {
    return jsonResponse({ success: false, message: '获取分享列表失败: ' + e.message }, 500);
  }
}

async function handleDeleteShare(request, env, shareId) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;
  
  try {
    await env.KV_STORE.delete(`share:${shareId}`);
    
    // Update stats
    const totalShares = parseInt(await env.KV_STORE.get('stats:totalShares') || '0');
    if (totalShares > 0) {
      await env.KV_STORE.put('stats:totalShares', String(totalShares - 1));
    }
    
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
          users.push({
            email: user.email,
            role: user.role,
            createdAt: user.createdAt
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
    
    return jsonResponse({ success: true, message: '用户已删除' });
  } catch (e) {
    return jsonResponse({ success: false, message: '删除用户失败: ' + e.message }, 500);
  }
}

async function handleCheckAuth(request, env) {
  const auth = await verifyAuth(request, env);
  if (!auth) {
    return jsonResponse({ authenticated: false });
  }
  return jsonResponse({ authenticated: true, role: auth.role, email: auth.email });
}

// ============================================================================
// HTML PAGES
// ============================================================================

const CSS_STYLES = `
<style>
  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }
  
  :root {
    --primary: #6366f1;
    --primary-dark: #4f46e5;
    --primary-light: #818cf8;
    --secondary: #8b5cf6;
    --accent: #06b6d4;
    --background: #0f172a;
    --surface: #1e293b;
    --surface-light: #334155;
    --text: #f8fafc;
    --text-muted: #94a3b8;
    --success: #10b981;
    --warning: #f59e0b;
    --error: #ef4444;
    --gradient: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #06b6d4 100%);
  }
  
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--background);
    color: var(--text);
    min-height: 100vh;
    line-height: 1.6;
  }
  
  .container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 20px;
  }
  
  /* Buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 10px 20px;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
    text-decoration: none;
  }
  
  .btn-primary {
    background: var(--gradient);
    color: white;
  }
  
  .btn-primary:hover {
    transform: translateY(-2px);
    box-shadow: 0 10px 20px rgba(99, 102, 241, 0.3);
  }
  
  .btn-secondary {
    background: var(--surface-light);
    color: var(--text);
  }
  
  .btn-secondary:hover {
    background: var(--surface);
  }
  
  .btn-danger {
    background: var(--error);
    color: white;
  }
  
  .btn-danger:hover {
    background: #dc2626;
  }
  
  .btn-sm {
    padding: 6px 12px;
    font-size: 12px;
  }

  .icon-btn {
    width: 34px;
    height: 34px;
    padding: 0;
    flex: 0 0 34px;
    border-radius: 50%;
  }

  .icon-btn.btn-secondary:hover {
    background: var(--primary);
    color: white;
    transform: scale(1.1);
  }

  .icon-btn.btn-danger:hover {
    transform: scale(1.1);
  }

  .action-icon {
    display: block;
    width: 16px;
    height: 16px;
    pointer-events: none;
  }
  
  /* Forms */
  .form-group {
    margin-bottom: 20px;
  }
  
  .form-label {
    display: block;
    margin-bottom: 8px;
    font-weight: 500;
    color: var(--text-muted);
  }
  
  .form-input {
    width: 100%;
    padding: 12px 16px;
    background: var(--surface);
    border: 1px solid var(--surface-light);
    border-radius: 8px;
    color: var(--text);
    font-size: 14px;
    transition: all 0.2s ease;
  }
  
  .form-input:focus {
    outline: none;
    border-color: var(--primary);
    box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2);
  }
  
  .form-select {
    width: 100%;
    padding: 12px 16px;
    background: var(--surface);
    border: 1px solid var(--surface-light);
    border-radius: 8px;
    color: var(--text);
    font-size: 14px;
    cursor: pointer;
  }
  
  /* Cards */
  .card {
    background: var(--surface);
    border-radius: 16px;
    padding: 24px;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
  }
  
  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 20px;
  }
  
  .card-title {
    font-size: 18px;
    font-weight: 600;
  }
  
  /* Tables */
  .table-container {
    overflow-x: auto;
  }
  
  table {
    width: 100%;
    border-collapse: collapse;
  }
  
  th, td {
    padding: 12px 16px;
    text-align: left;
    border-bottom: 1px solid var(--surface-light);
  }
  
  th {
    font-weight: 600;
    color: var(--text-muted);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  
  tr:hover {
    background: var(--surface-light);
  }
  
  /* Modal */
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    opacity: 0;
    visibility: hidden;
    transition: all 0.3s ease;
  }
  
  .modal-overlay.active {
    opacity: 1;
    visibility: visible;
  }
  
  .modal {
    background: var(--surface);
    border-radius: 16px;
    padding: 24px;
    width: 90%;
    max-width: 500px;
    transform: scale(0.9);
    transition: all 0.3s ease;
    max-height: 90vh;
    overflow-y: auto;
  }
  
  .modal-overlay.active .modal {
    transform: scale(1);
  }
  
  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 20px;
  }
  
  .modal-title {
    font-size: 20px;
    font-weight: 600;
  }
  
  .modal-close {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 24px;
    cursor: pointer;
    padding: 0;
    line-height: 1;
  }
  
  .modal-close:hover {
    color: var(--text);
  }
  
  /* Preview Modal - Full Screen */
  .preview-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.95);
    display: flex;
    flex-direction: column;
    z-index: 2000;
    opacity: 0;
    visibility: hidden;
    transition: all 0.3s ease;
  }
  
  .preview-overlay.active {
    opacity: 1;
    visibility: visible;
  }
  
  .preview-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 24px;
    background: var(--surface);
    border-bottom: 1px solid var(--surface-light);
  }
  
  .preview-filename {
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
    text-align: center;
  }

  .preview-actions {
    display: flex;
    gap: 12px;
    align-items: center;
  }

  .preview-icon-btn {
    display: none;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: none;
    cursor: pointer;
    transition: all 0.2s ease;
    flex-shrink: 0;
    font-size: 16px;
    line-height: 1;
    padding: 0;
  }

  .preview-icon-btn.preview-close {
    background: var(--surface-light);
    color: var(--text);
  }

  .preview-icon-btn.preview-close:hover {
    background: var(--surface);
    transform: scale(1.05);
  }

  .preview-icon-btn.preview-download {
    background: var(--gradient);
    color: white;
  }

  .preview-icon-btn.preview-download:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 14px rgba(99, 102, 241, 0.3);
  }
  
  .preview-content {
    flex: 1;
    overflow: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }

  .preview-content.reader-mode {
    align-items: stretch;
    justify-content: flex-start;
    padding: 0;
  }
  
  .preview-image {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  
  .preview-text {
    width: 100%;
    height: 100%;
    background: var(--surface);
    border-radius: 8px;
    padding: 20px;
    overflow: auto;
    font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
    font-size: 14px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-wrap: break-word;
  }

  .preview-reader {
    width: 100%;
    height: 100%;
    overflow: auto;
    background: var(--surface);
    color: var(--text);
    padding: 28px;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 18px;
    line-height: 1.85;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  
  .preview-pdf {
    width: 100%;
    height: 100%;
    border: none;
    border-radius: 8px;
  }
  
  .preview-video, .preview-audio {
    max-width: 100%;
    max-height: 100%;
  }
  
  .preview-markdown {
    width: 100%;
    max-width: 900px;
    height: 100%;
    background: var(--surface);
    border-radius: 8px;
    padding: 40px;
    overflow: auto;
    line-height: 1.8;
  }
  
  .preview-markdown h1, .preview-markdown h2, .preview-markdown h3 {
    margin-top: 24px;
    margin-bottom: 16px;
    color: var(--text);
  }
  
  .preview-markdown p {
    margin-bottom: 16px;
  }
  
  .preview-markdown code {
    background: var(--background);
    padding: 2px 6px;
    border-radius: 4px;
    font-family: 'Monaco', 'Menlo', monospace;
  }
  
  .preview-markdown pre {
    background: var(--background);
    padding: 16px;
    border-radius: 8px;
    overflow-x: auto;
    margin-bottom: 16px;
  }
  
  .preview-markdown pre code {
    background: none;
    padding: 0;
  }
  
  .preview-markdown blockquote {
    border-left: 4px solid var(--primary);
    padding-left: 16px;
    margin: 16px 0;
    color: var(--text-muted);
  }
  
  .preview-markdown ul, .preview-markdown ol {
    margin-bottom: 16px;
    padding-left: 24px;
  }
  
  .preview-markdown li {
    margin-bottom: 8px;
  }
  
  .preview-markdown a {
    color: var(--primary);
  }
  
  .preview-markdown img {
    max-width: 100%;
    border-radius: 8px;
  }
  
  .preview-markdown table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 16px;
  }
  
  .preview-markdown th, .preview-markdown td {
    border: 1px solid var(--surface-light);
    padding: 8px 12px;
  }
  
  .preview-office {
    width: 100%;
    height: 100%;
    background: white;
    border-radius: 8px;
  }
  
  .preview-loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    color: var(--text-muted);
  }
  
  .preview-error {
    text-align: center;
    color: var(--error);
  }
  
  /* Toast */
  .toast-container {
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 3000;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  
  .toast {
    padding: 16px 20px;
    border-radius: 8px;
    color: white;
    font-weight: 500;
    animation: slideIn 0.3s ease;
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 300px;
  }
  
  .toast-success {
    background: var(--success);
  }
  
  .toast-error {
    background: var(--error);
  }
  
  .toast-info {
    background: var(--primary);
  }
  
  @keyframes slideIn {
    from {
      transform: translateX(100%);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }
  
  /* Header */
  .header {
    background: var(--surface);
    padding: 16px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--surface-light);
  }
  
  .logo {
    font-size: 24px;
    font-weight: 700;
    background: var(--gradient);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  
  .header-actions {
    display: flex;
    gap: 12px;
  }
  
  /* Breadcrumb */
  .breadcrumb {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 16px 0;
    flex-wrap: wrap;
  }
  
  .breadcrumb-item {
    color: var(--text-muted);
    text-decoration: none;
    transition: color 0.2s;
  }
  
  .breadcrumb-item:hover {
    color: var(--primary);
  }
  
  .breadcrumb-item.active {
    color: var(--text);
  }
  
  .breadcrumb-separator {
    color: var(--text-muted);
  }
  
  /* File List */
  .file-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 16px;
  }
  
  .file-item {
    background: var(--surface);
    border-radius: 12px;
    padding: 16px;
    cursor: pointer;
    transition: all 0.2s ease;
    border: 1px solid transparent;
    position: relative;
  }
  
  .file-item:hover {
    border-color: var(--primary);
    transform: translateY(-2px);
  }

  .file-item.selected {
    border-color: var(--primary);
    box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.25);
  }

  .file-select {
    position: absolute;
    top: 10px;
    left: 10px;
    width: 18px;
    height: 18px;
    accent-color: var(--primary);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.2s ease;
  }

  .file-item:hover .file-select,
  .file-select:checked {
    opacity: 1;
  }
  
  .file-icon {
    font-size: 48px;
    margin-bottom: 12px;
    text-align: center;
  }
  
  .file-name {
    font-weight: 500;
    text-align: center;
    line-height: 1.35;
    min-height: 2.7em;
    overflow: hidden;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    margin-bottom: 4px;
  }
  
  .file-meta {
    font-size: 12px;
    color: var(--text-muted);
    text-align: center;
  }
  
  .file-actions {
    display: flex;
    gap: 6px;
    margin-top: 12px;
    justify-content: center;
    flex-wrap: wrap;
    max-width: 100%;
    opacity: 0;
    max-height: 0;
    overflow: hidden;
    margin-top: 0;
    transition: opacity 0.2s ease, max-height 0.25s ease, margin-top 0.25s ease;
  }

  .file-item:hover .file-actions {
    opacity: 1;
    max-height: 80px;
    margin-top: 12px;
  }
  
  /* Stats Cards */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 20px;
    margin-bottom: 30px;
  }
  
  .stat-card {
    background: var(--surface);
    border-radius: 16px;
    padding: 24px;
    text-align: center;
  }
  
  .stat-value {
    font-size: 36px;
    font-weight: 700;
    background: var(--gradient);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  
  .stat-label {
    color: var(--text-muted);
    font-size: 14px;
    margin-top: 8px;
  }
  
  /* Tabs */
  .tabs {
    display: flex;
    gap: 4px;
    background: var(--surface);
    padding: 4px;
    border-radius: 12px;
    margin-bottom: 24px;
  }
  
  .tab {
    flex: 1;
    padding: 12px 20px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    border-radius: 8px;
    transition: all 0.2s ease;
  }
  
  .tab.active {
    background: var(--primary);
    color: white;
  }
  
  .tab:hover:not(.active) {
    color: var(--text);
  }
  
  .tab-content {
    display: none;
  }
  
  .tab-content.active {
    display: block;
  }
  
  /* Badge */
  .badge {
    display: inline-block;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
  }
  
  .badge-success {
    background: rgba(16, 185, 129, 0.2);
    color: var(--success);
  }
  
  .badge-warning {
    background: rgba(245, 158, 11, 0.2);
    color: var(--warning);
  }
  
  .badge-error {
    background: rgba(239, 68, 68, 0.2);
    color: var(--error);
  }
  
  .badge-info {
    background: rgba(99, 102, 241, 0.2);
    color: var(--primary);
  }
  
  /* Login Page */
  .login-container {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--background);
    padding: 20px;
  }
  
  .login-card {
    background: var(--surface);
    border-radius: 24px;
    padding: 40px;
    width: 100%;
    max-width: 420px;
    box-shadow: 0 25px 50px rgba(0, 0, 0, 0.25);
  }
  
  .login-header {
    text-align: center;
    margin-bottom: 32px;
  }
  
  .login-logo {
    font-size: 32px;
    font-weight: 700;
    background: var(--gradient);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    margin-bottom: 8px;
  }
  
  .login-subtitle {
    color: var(--text-muted);
  }
  
  .login-tabs {
    display: flex;
    gap: 4px;
    background: var(--background);
    padding: 4px;
    border-radius: 12px;
    margin-bottom: 24px;
  }
  
  .login-tab {
    flex: 1;
    padding: 12px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    border-radius: 8px;
    transition: all 0.2s ease;
  }
  
  .login-tab.active {
    background: var(--primary);
    color: white;
  }
  
  /* Share Page */
  .share-container {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--background);
    padding: 20px;
  }
  
  .share-card {
    background: var(--surface);
    border-radius: 24px;
    padding: 40px;
    width: 100%;
    max-width: 480px;
    text-align: center;
  }
  
  .share-icon {
    font-size: 64px;
    margin-bottom: 20px;
  }
  
  .share-filename {
    font-size: 20px;
    font-weight: 600;
    margin-bottom: 8px;
    word-break: break-all;
  }
  
  .share-filesize {
    color: var(--text-muted);
    margin-bottom: 24px;
  }
  
  .share-expired {
    color: var(--error);
    font-size: 18px;
  }
  
  /* Empty State */
  .empty-state {
    text-align: center;
    padding: 60px 20px;
    color: var(--text-muted);
  }
  
  .empty-icon {
    font-size: 64px;
    margin-bottom: 16px;
    opacity: 0.5;
  }
  
  /* Responsive */
  @media (max-width: 768px) {
    .header {
      flex-direction: row;
      gap: 8px;
      padding: 12px 16px;
    }
    
    .header-actions {
      gap: 6px;
    }

    .header-actions .btn {
      padding: 6px 10px;
      font-size: 12px;
    }

    .logo {
      font-size: 18px;
    }

    .container {
      padding: 16px;
    }

    .toolbar .btn {
      padding: 8px 12px;
      font-size: 13px;
    }
    
    .file-grid {
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 12px;
    }
    
    .stats-grid {
      grid-template-columns: 1fr;
    }
    
    .tabs {
      flex-direction: column;
    }
    
    .file-actions {
      opacity: 1;
      max-height: none;
      margin-top: 10px;
    }

    .file-select {
      opacity: 1;
    }

    .preview-header {
      flex-direction: row;
      gap: 12px;
      padding: 12px 16px;
    }

    .preview-actions .btn {
      display: none;
    }

    .preview-icon-btn {
      display: inline-flex;
    }
  }
  
  /* Loading Spinner */
  .spinner {
    width: 40px;
    height: 40px;
    border: 3px solid var(--surface-light);
    border-top-color: var(--primary);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }
  
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  
  .loading-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(15, 23, 42, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 3000;
  }
  
  /* Context Menu */
  .context-menu {
    position: fixed;
    background: var(--surface);
    border-radius: 8px;
    padding: 8px 0;
    min-width: 160px;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
    z-index: 1500;
    display: none;
  }
  
  .context-menu.active {
    display: block;
  }
  
  .context-menu-item {
    padding: 10px 16px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 10px;
    transition: background 0.2s;
  }
  
  .context-menu-item:hover {
    background: var(--surface-light);
  }
  
  .context-menu-item.danger {
    color: var(--error);
  }
  
  /* Toolbar */
  .toolbar {
    display: flex;
    gap: 12px;
    margin-bottom: 20px;
    flex-wrap: wrap;
  }

  .batch-toolbar {
    display: none;
    align-items: center;
    gap: 10px;
    margin-bottom: 20px;
    padding: 12px;
    background: var(--surface);
    border: 1px solid var(--surface-light);
    border-radius: 8px;
    flex-wrap: wrap;
  }

  .batch-toolbar.active {
    display: flex;
  }

  .batch-count {
    color: var(--text-muted);
    margin-right: auto;
    font-size: 14px;
  }

  .folder-search-results {
    display: none;
    margin-top: 8px;
    max-height: 220px;
    overflow: auto;
    border: 1px solid var(--surface-light);
    border-radius: 8px;
    background: var(--background);
  }

  .folder-search-results.active {
    display: block;
  }

  .folder-search-item {
    width: 100%;
    padding: 10px 12px;
    border: none;
    border-bottom: 1px solid var(--surface-light);
    background: transparent;
    color: var(--text);
    cursor: pointer;
    text-align: left;
    font-size: 14px;
  }

  .folder-search-item:last-child {
    border-bottom: none;
  }

  .folder-search-item:hover {
    background: var(--surface-light);
  }

  .folder-search-empty {
    padding: 10px 12px;
    color: var(--text-muted);
    font-size: 14px;
  }
  
  /* Upload Area */
  .upload-area {
    border: 2px dashed var(--surface-light);
    border-radius: 12px;
    padding: 40px;
    text-align: center;
    cursor: pointer;
    transition: all 0.2s ease;
  }
  
  .upload-area:hover, .upload-area.dragover {
    border-color: var(--primary);
    background: rgba(99, 102, 241, 0.1);
  }
  
  .upload-area input {
    display: none;
  }
</style>
`;

const LOGIN_PAGE = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>登录 - EdgeStash</title>
  ${CSS_STYLES}
</head>
<body>
  <div class="login-container">
    <div class="login-card">
      <div class="login-header">
        <div class="login-logo">EdgeStash</div>
        <div class="logibtitle">基于 Cloudflare 的云盘服务</div>
      </div>
      
      <div class="login-tabs">
        <button class="login-tab active" onclick="switchLoginTab('admin')">管理员登录</button>
        <button class="login-tab" onclick="switchLoginTab('user')">用户登录</button>
      </div>
      
      <form id="loginForm" onsubmit="handleLogin(event)">
        <div id="emailField" class="form-group" style="display: none;">
          <label class="form-label">邮箱</label>
          <input type="l" id="email" class="form-input" placeholder="请输入邮箱">
        </div>
        
        <div class="form-group">
          <label class="form-label">密码</label>
          <input type="password" id="password" class="form-input" placeholder="请输入密码" required>
        </div>
        
        <button type="submit" class="btn btn-primary" style="width: 100%;">
          登录
        </button>
      </form>
    </div>
  </div>
  
  <div class="toast-container" id="toastContainer"></div>
  
   let isAdminLogin = true;
    
    function switchLoginTab(type) {
      isAdminLogin = type === 'admin';
      document.querySelectorAll('.login-tab').forEach((tab, index) => {
        tab.classList.toggle('active', (index === 0 && isAdminLogin) || (index === 1 && !isAdminLogin));
      });
      document.getElementById('emailField').style.display = isAdminLogin ? 'none' : 'block';
    }
    
    async function handleLogin(e) {
      e.preventDefault();
      
      const password = document.getElementById('password').value;
      const email = document.getElementById('email').value;
      
      try {
        const response = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            isAdmin: isAdminLogin,
            email: isAdminLogin ? undefined : email,
            password
          })
        });
        
        const data = await response.json();
        
        if (data.success) {
          showToast('登录成功', 'success');
          setTimeout(() => {
            window.location.href = '/';
          }, 500);
        } else {
          showToast(data.message || '登录失败', 'error');
        }
      } catch (error) {
        showToast('登录失败: ' + error.message, 'error');
      }
    }
    
    function showToast(message, type = 'info') {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = 'toast t type;
      toast.textContent = message;
      container.appendChild(toast);
      
      setTimeout(() => {
        toast.remove();
      }, 3000);
    }
  </script>
</body>
</html>
`;

const INDEX_PAGE = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EdgeStash - 云盘</title>
  ${CSS_STYLES}
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script src="https://cdn.jsdelivt/npm/mammoth@1.6.0/mammoth.browser.min.js"></script>
</head>
<body>
  <div class="header">
    <div class="logo">EdgeStash</div>
    <div class="header-actions">
      <button class="btn btn-secondary" onclick="window.location.href='/admin.html'">管理后台</button>
      <button class="btn btn-secondary" onclick="logout()">退出登录</button>
    </div>
  </div>
  
  <div class="container">
    <div class="breadcrumb" id="breadcrumb"></div>
    
    <div class="toolbar">
      <button class="btn btn-primary" onclick="showNewFolderModal()">
        📁 新建文件夹
      </button>
      <button class="btn btn-primary" onclick="document.getElementById('fileInput').click()">
        📤 上传文件
      </button>
      <input type="file" id="fileInput" multiple style="display: none;" onchange="handleFileUpload(event)">
    </div>
    
    <div class="card">
      <div id="fileList" class="file-grid"></div>
      <div id="emptyState" class="empty-state" style="display: none;">
        <div class="empon">📂</div>
        <div>此文件夹为空</div>
      </div>
    </div>
  </div>
  
  <!-- New Folder Modal -->
  <div class="modal-overlay" id="newFolderModal">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">新建文件夹</div>
        <button class="modal-close" onclick="closeModal('newFolderModal')">&times;</button>
      </div>
      <form onsubmit="createFolder(event)">
        <div class="form-group">
          <label class="form-label">文件夹名称label>
          <input type="text" id="folderName" class="form-input" placeholder="请输入文件夹名称" required>
        </div>
        <button type="submit" class="btn btn-primary" style="width: 100%;">创建</button>
      </form>
    </div>
  </div>
  
  <!-- Rename Modal -->
  <div class="modal-overlay" id="renameModal">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">重命名</div>
        <button class="modal-close" onclick="closeModal('renameModal')">utton>
      </div>
      <form onsubmit="renameFile(event)">
        <div class="form-group">
          <label class="form-label">新名称</label>
          <input type="text" id="newFileName" class="form-input" required>
        </div>
        <input type="hidden" id="renameFilePath">
        <button type="submit" class="btn btn-primary" style="width: 100%;">确认</button>
      </form>
    </div>
  </div>
  
  <!-- Share Modal -->
  <div class="modal-overlay" id="shareModal">
    <div class="modal">
  lass="modal-header">
        <div class="modal-title">创建分享链接</div>
        <button class="modal-close" onclick="closeModal('shareModal')">&times;</button>
      </div>
      <form onsubmit="createShare(event)">
        <div class="form-group">
          <label class="form-label">分享密码（留空则无密码）</label>
          <input type="text" id="sharePassword" class="form-input" placeholder="可选">
        </div>
        <div class="form-group">
          <label class="form-label">æ
          <select id="shareExpiry" class="form-select">
            <option value="1h">1小时</option>
            <option value="1d" selected>1天</option>
            <option value="1m">1个月</option>
            <option value="permanent">永久有效</option>
          </select>
        </div>
        <input type="hidden" id="shareFilePath">
        <button type="submit" class="btn btn-primary" style="width: 100%;">创建分享链接</button>
      </form>
    </div>
  </div>
  
  <!-- Share Result iv class="modal-overlay" id="shareResultModal">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">分享链接已创建</div>
        <button class="modal-close" onclick="closeModal('shareResultModal')">&times;</button>
      </div>
      <div class="form-group">
        <label class="form-label">分享链接</label>
        <input type="text" id="shareResultUrl" class="form-input" readonly>
      </div>
      <button class="btn btn-primary" style="width: 100%;" onclipyShareLink()">复制链接</button>
    </div>
  </div>
  
  <!-- Preview Modal -->
  <div class="preview-overlay" id="previewOverlay">
    <div class="preview-header">
      <div class="preview-filename" id="previewFilename"></div>
      <div class="preview-actions">
        <button class="btn btn-primary" id="previewDownloadBtn">下载</button>
        <button class="btn btn-secondary" onclick="closePreview()">关闭</button>
        <button type="button" class="preview-icon-btn preview-download" onclick="document.getElementById('previewDownloadBtn').click()">⬇</button>
        <button type="button" class="preview-icon-btn preview-close" onclick="closePreview()">✕</button>
      </div>
    </div>
    <div class="preview-content" id="previewContent">
      <div class="preview-loading">
        <div class="spinner"></div>
        <div>加载中...</div>
      </div>
    </div>
  </div>
  
  <div class="toast-container" id="toastContainer"></div>
  
  <div class="loading-overlay" id="loadingOverlay" style="display: none;">
    <div class="spinner"></div>
  </div>
  
  <script>
    let currentPath = '/';

    function encodePathForUrl(path) {
      if (!path || path === '/') return '/';
      return path.split('/').map((part, index) => {
        if (index === 0 && part === '') return '';
        return encodeURIComponent(part);
      }).join('/');
    }

    function apiFileUrl(prefix, path) {
      return prefix + encodePathForUrl(path);
    }
    
    async function checkAuth() {
      try {
        const response = await fetch('/api/auth/check');
        const data = await response.json();
     (!data.authenticated) {
          window.location.href = '/login.html';
        }
      } catch (error) {
        window.location.href = '/login.html';
      }
    }
    
    async function loadFiles() {
      showLoading(true);
      try {
        const response = await fetch(apiFileUrl('/api/files', currentPath));
        const data = await response.json();
        
        if (!data.success) {
          if (response.status === 401) {
            window.location.href = '/login.html';
            return;
          }
          throw new Error(data.message);
        }
        
        renderBreadcrumb();
        renderFiles(data.folders, data.files);
      } catch (error) {
        showToast('加载文件失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }
    
    function renderBreadcrumb() {
      const breadcrumb = document.getElementById('breadcrumb');
      const parts = currentPath.split('/').filter(p => p);
      
      let html = '<a href="#" class="breadcrumb-item" ogateTo(\\'/\\')">🏠 根目录</a>';
      
      let path = '';
      parts.forEach((part, index) => {
        path += '/' + part;
        const isLast = index === parts.length - 1;
        html += '<span class="breadcrumb-separator">/</span>';
        if (isLast) {
          html += '<span class="breadcrumb-item active">' + part + '</span>';
        } else {
          html += '<a href="#" class="breadcrumb-item" onclick="navigateTo(\\'' + path + '\\')">' + part + '</a>';
        }
      });
      
      mb.innerHTML = html;
    }
    
    function renderFiles(folders, files) {
      const fileList = document.getElementById('fileList');
      const emptyState = document.getElementById('emptyState');
      
      if (folders.length === 0 && files.length === 0) {
        fileList.innerHTML = '';
        emptyState.style.display = 'block';
        return;
      }
      
      emptyState.style.display = 'none';
      
      let html = '';
      
      // Render folders
      folders.forEach(folder => {
        html += \`
          <div class="file-item" ondblclick="navigateTo('\${folder.path}')">
            <div class="file-icon">📁</div>
            <div class="file-name">\${escapeHtml(folder.name)}</div>
            <div class="file-meta">文件夹</div>
            <div class="file-actions">
              <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation(); showRenameModal('\${folder.path}', '\${escapeHtml(folder.name)}')">重命名</button>
              <button class="btn btn-sm btn-k="event.stopPropagation(); deleteFile('\${folder.path}')">删除</button>
            </div>
          </div>
        \`;
      });
      
      // Render files
      files.forEach(file => {
        const icon = getFileIcon(file.name);
        const previewable = file.previewType ? 'true' : 'false';
        const previewType = file.previewType || '';
        html += \`
          <div class="file-item" ondblclick="handleFileClick('\${file.path}', '\${previewType}', '\${escapeHtml(file.name)}')" data-preview="\${previewable}">
            <div class="file-icon">\${icon}</div>
            <div class="file-name">\${escapeHtml(file.name)}</div>
            <div class="file-meta">\${file.sizeFormatted}\${previewType ? ' <span class="badge badge-info">可预览</span>' : ''}</div>
            <div class="file-actions">
              \${previewType ? '<button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); previewFile(\\'' + file.path + '\\', \\'' + previewType + '\\', \\'' + escapeHtml(file.name) +">预览</button>' : ''}
              <button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); downloadFile('\${file.path}')">下载</button>
              <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation(); showShareModal('\${file.path}')">分享</button>
              <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation(); showRenameModal('\${file.path}', '\${escapeHtml(file.name)}')">重命名</button>
              <button class="btn btn-sm btn-nger" onclick="event.stopPropagation(); deleteFile('\${file.path}')">删除</button>
            </div>
          </div>
        \`;
      });
      
      fileList.innerHTML = html;
    }
    
    function handleFileClick(path, previewType, filename) {
      if (previewType) {
        previewFile(path, previewType, filename);
      } else {
        downloadFile(path);
      }
    }
    
    function getFileIcon(filename) {
      const ext = filename.split('.').pop().toLowerCase();
      const icons = {
    'pdf': '📕',
        'doc': '📘', 'docx': '📘',
        'xls': '📗', 'xlsx': '📗',
        'ppt': '📙', 'pptx': '📙',
        'jpg': '🖼️', 'jpeg': '🖼️', 'png': '🖼️', 'gif': '🖼️', 'svg': '🖼️', 'webp': '🖼️',
        'mp3': '🎵', 'wav': '🎵', 'flac': '🎵',
        'mp4': '🎬', 'avi': '🎬', 'mkv': '🎬', 'mov': '🎬',
        'zip': '📦', 'rar': '📦', '7z': '📦', 'tar': '📦', 'gz': '📦',
        'js': '📜', 'ts': '📜', 'py': '📜', 'java': 📜', 'c': '📜',
        'html': '🌐', 'css': '🎨', 'json': '📋',
        'txt': '📄', 'md': '📝'
      };
      return icons[ext] || '📄';
    }
    
    function navigateTo(path) {
      currentPath = path;
      loadFiles();
    }
    
    // ========== Preview Functions ==========
    
    async function previewFile(path, previewType, filename) {
      const overlay = document.getElementById('previewOverlay');
      const content = document.getElementById('previewContent');
      const fiocument.getElementById('previewFilename');
      const downloadBtn = document.getElementById('previewDownloadBtn');
      
      filenameEl.textContent = filename;
      downloadBtn.onclick = () => downloadFile(path);
      
      // Show loading
      content.innerHTML = '<div class="preview-loading"><div class="spinner"></div><div>加载中...</div></div>';
      overlay.classList.add('active');
      
      try {
        const previewUrl = apiFileUrl('/api/preview', path);
        
        switch (previewType) {
    case 'image':
            content.innerHTML = '<img class="preview-image" src="' + previewUrl + '" alt="' + escapeHtml(filename) + '">';
            break;
            
          case 'pdf':
            content.innerHTML = '<iframe class="preview-pdf" src="' + previewUrl + '"></iframe>';
            break;
            
          case 'text':
            const textResponse = await fetch(previewUrl);
            const text = await textResponse.text();
            const ext = filename.split('.').pop().toLowerCase();
            
            if (ext === 'md') {
              // Render Markdown
              const htmlContent = marked.parse(text);
              content.innerHTML = '<div class="preview-markdown">' + htmlContent + '</div>';
            } else if (ext === 'json') {
              // Pretty print JSON
              try {
                const json = JSON.parse(text);
                content.innerHTML = '<pre class="preview-text">' + escapeHtml(JSON.stringify(json, null, 2)) + '</pre>';
              } catch {
                content.innerHTML = '<pre class="preview-text">' + escapeHtml(text) + '</pre>';
              }
            } else {
              content.innerHTML = '<pre class="preview-text">' + escapeHtml(text) + '</pre>';
            }
            break;
            
          case 'video':
            content.innerHTML = '<video class="preview-video" controls autoplay><source src="' + previewUrl + '"></video>';
            break;
            
          case 'audio':
            content.innerHTML = '<audio class="preview-audio" controls autoplay><source src="' + previewUrl + '"></audio>';
            break;
            
          case 'word':
            // Use Mammoth.js to convert docx to HTML
            const docxResponse = await fetch(previewUrl);
            const docxArrayBuffer = await docxResponse.arrayBuffer();
            const result = await mammoth.convertToHtml({ arrayBuffer: docxArrayBuffer });
            content.innerHTML = '<div class="preview-markdown">' + result.value + '</div>';
            break;
            
          default:
            content.innerHTML = '<div class="preview-error">不支持预览此文件类型</div>';
        }
      } catch (error) {
        content.innerHTML = '<div class="preview-error">预览加载失败: ' + escapeHtml(error.message) + '</div>';
      }
    }
    
    function closePreview() {
      const overlay = document.getElementById('previewOverlay');
      overlay.classList.remove('active');
      // Clear content to stop any playing media
      document.getElementById('previewContent').innerHTML = '';
    }
    
    // Close preview on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closePreview();
      }
    });
    
    // ========== File Operations ==========
    
    async function handleFileUpload(event) {
      const files = event.target.files;
      if (!files.length) return;
      
      showLoading(true);
      
      for (const file of files) {
        try {
          const formData = new FormData();
          formData.append('file', file);
          
          const response = await fetch(apiFileUrl('/api/files', currentPath), {
            method: 'POST',
            body: formData
          });
          
          const data = await response.json();
          
          if (data.success) {
            showToast('文件 ' + file.name + ' 上传成功', 'success');
          } else {
            showToast('文件 ' + file.name + ' 上传失败: ' + data.message, 'error');
          }
    tch (error) {
          showToast('文件 ' + file.name + ' 上传失败: ' + error.message, 'error');
        }
      }
      
      event.target.value = '';
      loadFiles();
    }
    
    function showNewFolderModal() {
      document.getElementById('folderName').value = '';
      document.getElementById('newFolderModal').classList.add('active');
    }
    
    async function createFolder(event) {
      event.preventDefault();
      const name = document.getElementById('folderName').value.trim();
     !name) {
        showToast('请输入文件夹名称', 'error');
        return;
      }
      
      showLoading(true);
      closeModal('newFolderModal');
      
      try {
        let folderPath = currentPath;
        if (!folderPath.endsWith('/')) folderPath += '/';
        folderPath += name;
        
        const response = await fetch('/api/folders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: folderPath })
        });
        
        const data = await response.json();
        
        if (data.success) {
          showToast('文件夹创建成功', 'success');
          loadFiles();
        } else {
          showToast('创建失败: ' + data.message, 'error');
        }
      } catch (error) {
        showToast('创建失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }
    
    function showRenameModal(path, currentName) {
      document.getElementById('renameFilePath').v     document.getElementById('newFileName').value = currentName;
      document.getElementById('renameModal').classList.add('active');
    }
    
    async function renameFile(event) {
      event.preventDefault();
      const path = document.getElementById('renameFilePath').value;
      const newName = document.getElementById('newFileName').value.trim();
      
      if (!newName) {
        showToast('请输入新名称', 'error');
        return;
      }
      
      showLoading(true);
      closeModal('r;
      
      try {
        const response = await fetch(apiFileUrl('/api/files', path), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newName })
        });
        
        const data = await response.json();
        
        if (data.success) {
          showToast('重命名成功', 'success');
          loadFiles();
        } else {
          showToast('重命名失败: ' + data.message, 'error');
        }
      } catch (error) {
        shast('重命名失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }
    
    async function deleteFile(path) {
      if (!confirm('确定要删除吗？此操作不可恢复。')) return;
      
      showLoading(true);
      
      try {
        const response = await fetch(apiFileUrl('/api/files', path), {
          method: 'DELETE'
        });
        
        const data = await response.json();
        
        if (data.success) {
          showToast('删除成功', 'success');
          loadFiles();
        } else {
          showToast('删除失败: ' + data.message, 'error');
        }
      } catch (error) {
        showToast('删除失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }
    
    async function downloadFile(path) {
      window.open(apiFileUrl('/api/download', path), '_blank');
    }
    
    function showShareModal(path) {
      document.getElementById('shareFilePath').value = path;
      document.getElementById('sharePassword').value = '';
      document.getElementById('shareExpiry').value = '1d';
      document.getElementById('shareModal').classList.add('active');
    }
    
    async function createShare(event) {
      event.preventDefault();
      const filePath = document.getElementById('shareFilePath').value;
      const password = document.getElementById('sharePassword').value;
      const expiresIn = document.getElementById('shareExpiry').value;
      
      showLoading(true);
      closeModal('shareModal');
      
      try {
        const response = await fetch('/api/share', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath, password, expiresIn })
        });
        
        const data = await response.json();
        
        if (data.success) {
          const fullUrl = window.location.origin + data.shareUrl;
          document.getElementById('shareResultUrl').value = fullUrl;
          document.getElementById('shareResultModal').classList.add('active');
        } else {
          showToast('创建分享链接失败: ' + data.message, 'error');
        }
      } catch (error) {
        showToast('创建分享链接失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }
    
    function copyShareLink() {
      const input = document.getElementById('shareResultUrl');
      input.select();
      document.execCommand('copy');
      showToast('链接已复制到剪贴板', 'success');
    }
    
    asc function logout() {
      try {
        await fetch('/api/logout', { method: 'POST' });
        window.location.href = '/login.html';
      } catch (error) {
        window.location.href = '/login.html';
      }
    }
    
    function closeModal(id) {
      document.getElementById(id).classList.remove('active');
    }
    
    function showLoading(show) {
      document.getElementById('loadingOverlay').style.display = show ? 'flex' : 'none';
    }
    
    function showToast(message, type = 'info') {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = 'toast toast-' + type;
      toast.textContent = message;
      container.appendChild(toast);
      
      setTimeout(() => {
        toast.remove();
      }, 3000);
    }
    
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
    
    // Initialize
    checkAuth();
    loadFiles();
  </script>
</body>
</html>
`;

const ADMIN_PAGE = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>管理后台 - EdgeStash</title>
  ${CSS_STYLES}
</head>
<body>
  <div class="header">
    <div class="logo">EdgeStash 管理后台</div>
    <div class="header-actions">
      <button class="btn btn-secondary" onclick="window.location.href='/'">返回云盘</button>
      <button class="btn btn-secondlick="logout()">退出登录</button>
    </div>
  </div>
  
  <div class="container">
    <div class="tabs">
      <button class="tab active" onclick="switchTab('stats')">统计数据</button>
      <button class="tab" onclick="switchTab('shares')">分享链接</button>
      <button class="tab" onclick="switchTab('users')">授权用户</button>
    </div>
    
    <!-- Stats Tab -->
    <div id="statsTab" class="tab-content active">
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-value" id="totalShares">0</div>
          <div class="stat-label">总分享链接数</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" id="totalViews">0</div>
          <div class="stat-label">总浏览次数</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" id="totalDownloads">0</div>
          <div class="stat-label">总下载次数</div>
        </div>
      </div>
    </div>
    
    <!-- Shares Tab -->
    <div id="sharesTab" class="tab-content">
      <div class="card">
        <div class="card-header">
          <div class="card-title">分享链接管理</div>
        </div>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>文件名</th>
                <th>分享ID</th>
                <th>密码保护</th>
                <th>浏览次数</th>
                <th>下载次数</th>
                <th>状态</th>
                <th>操作</th>
        </tr>
            </thead>
            <tbody id="sharesTable"></tbody>
          </table>
        </div>
      </div>
    </div>
    
    <!-- Users Tab -->
    <div id="usersTab" class="tab-content">
      <div class="card">
        <div class="card-header">
          <div class="card-title">授权用户管理</div>
          <button class="btn btn-primary" onclick="showAddUserModal()">添加用户</button>
        </div>
        <div class="table-container">
          <table>
            <thead>
          <tr>
                <th>邮箱</th>
                <th>角色</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody id="usersTable"></tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
  
  <!-- Add User Modal -->
  <div class="modal-overlay" id="addUserModal">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">添加授权用户</div>
        <button class="modal-close" onclick="closeModal('addUserModal')">&times;</button>
      </div>
      <form onsubmit="addUser(event)">
        <div class="form-group">
          <label class="form-label">邮箱</label>
          <input type="email" id="newUserEmail" class="form-input" placeholder="请输入邮箱" required>
        </div>
        <div class="form-group">
          <label class="form-label">密码</label>
          <input type="text" id="newUserPassword" class="form-input" placeholder="请输入密码" re    </div>
        <button type="submit" class="btn btn-primary" style="width: 100%;">添加用户</button>
      </form>
    </div>
  </div>
  
  <div class="toast-container" id="toastContainer"></div>
  
  <div class="loading-overlay" id="loadingOverlay" style="display: none;">
    <div class="spinner"></div>
  </div>
  
  <script>
    async function checkAdminAuth() {
      try {
        const response = await fetch('/api/auth/check');
        const data = await response.json();
        if (!data.authent| data.role !== 'admin') {
          window.location.href = '/login.html';
        }
      } catch (error) {
        window.location.href = '/login.html';
      }
    }
    
    function switchTab(tab) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      
      event.target.classList.add('active');
      document.getElementById(tab + 'Tab').classList.add('active');
      
      if (tab === 'stats') loadStats();
      else if (tab === 'shares') loadShares();
      else if (tab === 'users') loadUsers();
    }
    
    async function loadStats() {
      try {
        const response = await fetch('/api/admin/stats');
        const data = await response.json();
        
        if (data.success) {
          document.getElementById('totalShares').textContent = data.totalShares;
          document.getElementById('totalViews').textContent = data.totalViews;
          document.getElementById('totalDownloads').textContent = data.totalDownloads;
        }
      } catch (error) {
        showToast('加载统计数据失败', 'error');
      }
    }
    
    async function loadShares() {
      showLoading(true);
      try {
        const response = await fetch('/api/admin/shares');
        const data = await response.json();
        
        if (data.success) {
          const tbody = document.getElementById('sharesTable');
          
          if (data.shares.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">暂无分享链接</td></tr>';
            return;
          }
          
          tbody.innerHTML = data.shares.map(share => \`
            <tr>
              <td>\${escapeHtml(share.fileName)}</td>
              <td><code>\${share.shareId}</code></td>
              <td>\${share.passwordHash ? '是' : '否'}</td>
              <td>\${share.viewCount}</td>
              <td>\${share.downloadCount}</td>
              <td>
                \${share.isExpired 
                  ? '<span class="badge badge-error">已过期</span>' 
                  : '<span class="badge badge-success">有效</span>'}
              </td>
              <td>
                <button class="btn btn-sm btn-secondary" onclick="copyShareLink('\${share.shareId}')">复制链接</button>
                <button class="btn btn-sm btn-danger" onclick="deleteShare('\${share.shareId}')">删除</button>
              </td>
            </tr>
          \`).join(       }
      } catch (error) {
        showToast('加载分享列表失败', 'error');
      } finally {
        showLoading(false);
      }
    }
    
    async function loadUsers() {
      showLoading(true);
      try {
        const response = await fetch('/api/admin/users');
        const data = await response.json();
        
        if (data.success) {
          const tbody = document.getElementById('usersTable');
          
          if (data.users.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">暂无授权用户</td></tr>';
            return;
          }
          
          tbody.innerHTML = data.users.map(user => \`
            <tr>
              <td>\${escapeHtml(user.email)}</td>
              <td>\${user.role === 'admin' ? '管理员' : '普通用户'}</td>
              <td>\${user.createdAt ? new Date(user.createdAt).toLocaleString() : '-'}</td>
              <td>
                <button class="btn btn-sm btn-danger" oleteUser('\${encodeURIComponent(user.email)}')">撤销授权</button>
              </td>
            </tr>
          \`).join('');
        }
      } catch (error) {
        showToast('加载用户列表失败', 'error');
      } finally {
        showLoading(false);
      }
    }
    
    function showAddUserModal() {
      document.getElementById('newUserEmail').value = '';
      document.getElementById('newUserPassword').value = '';
      document.getElementById('addUserModal').classList.add('active');
  
    async function addUser(event) {
      event.preventDefault();
      const email = document.getElementById('newUserEmail').value;
      const password = document.getElementById('newUserPassword').value;
      
      showLoading(true);
      closeModal('addUserModal');
      
      try {
        const response = await fetch('/api/admin/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        
        const data = await response.json();
        
        if (data.success) {
          showToast('用户添加成功', 'success');
          loadUsers();
        } else {
          showToast('添加失败: ' + data.message, 'error');
        }
      } catch (error) {
        showToast('添加失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }
    
    async function deleteUser(email) {
      if (!confirm('确定要撤销该用户的授权吗？')) return;
       showLoading(true);
      
      try {
        const response = await fetch('/api/admin/users/' + email, {
          method: 'DELETE'
        });
        
        const data = await response.json();
        
        if (data.success) {
          showToast('用户已删除', 'success');
          loadUsers();
        } else {
          showToast('删除失败: ' + data.message, 'error');
        }
      } catch (error) {
        showToast('删除失败: ' + error.message, 'error');
      } finally {
       ng(false);
      }
    }
    
    async function deleteShare(shareId) {
      if (!confirm('确定要删除该分享链接吗？')) return;
      
      showLoading(true);
      
      try {
        const response = await fetch('/api/admin/shares/' + shareId, {
          method: 'DELETE'
        });
        
        const data = await response.json();
        
        if (data.success) {
          showToast('分享链接已删除', 'success');
          loadShares();
        } else {
          showToast('å data.message, 'error');
        }
      } catch (error) {
        showToast('删除失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }
    
    function copyShareLink(shareId) {
      const url = window.location.origin + '/s/' + shareId;
      navigator.clipboard.writeText(url).then(() => {
        showToast('链接已复制', 'success');
      }).catch(() => {
        showToast('复制失败', 'error');
      });
    }
    
    async function logout() {
          await fetch('/api/logout', { method: 'POST' });
        window.location.href = '/login.html';
      } catch (error) {
        window.location.href = '/login.html';
      }
    }
    
    function closeModal(id) {
      document.getElementById(id).classList.remove('active');
    }
    
    function showLoading(show) {
      document.getElementById('loadingOverlay').style.display = show ? 'flex' : 'none';
    }
    
    function showToast(message, type = 'info') {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = 'toast toast-' + type;
      toast.textContent = message;
      container.appendChild(toast);
      
      setTimeout(() => {
        toast.remove();
      }, 3000);
    }
    
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
    
    // Initialize
    checkAdminAuth();
    loadStats();
  </script>
</body>
</html>
`;

const SHARE_PAGE = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>文件分享 - EdgeStash</title>
  ${CSS_STYLES}
</head>
<body>
  <div class="share-container">
    <div class="share-card" id="shareCard">
      <div id="loadingState">
        <div class="spinner" style="margin: 0 auto 20px;"></div>
        <div>加载中...</div>
      </div>
      
      <div id="expiredState" style="display: noneiv class="share-icon">⚠️</div>
        <div class="share-expired">分享链接已过期或不存在</div>
        <p style="color: var(--text-muted); margin-top: 16px;">请联系分享者获取新的链接</p>
      </div>
      
      <div id="shareContent" style="display: none;">
        <div class="share-icon">📄</div>
        <div class="share-filename" id="fileName"></div>
        <div class="share-filesize" id="fileSize"></div>
        
        <div id="passwordForm" style="display: none;">
      <div class="form-group">
            <label class="form-label">请输入分享密码</label>
            <input type="password" id="sharePassword" class="form-input" placeholder="输入密码">
          </div>
        </div>
        
        <button class="btn btn-primary" style="width: 100%; margin-top: 20px;" onclick="downloadFile()">
          下载文件
        </button>
      </div>
    </div>
  </div>
  
  <div class="toast-container" id="toastContainer"></div>
  
  <script>
    let shareId = '';resPassword = false;
    
    async function loadShareInfo() {
      // Get share ID from URL
      const pathParts = window.location.pathname.split('/');
      shareId = pathParts[pathParts.length - 1];
      
      if (!shareId) {
        showExpired();
        return;
      }
      
      try {
        const response = await fetch('/api/share/' + shareId);
        const data = await response.json();
        
        if (!data.success) {
          showExpired();
          return;
        }
        
        document.getElementById('loadingState').style.display = 'none';
        document.getElementById('shareContent').style.display = 'block';
        
        document.getElementById('fileName').textContent = data.fileName;
        document.getElementById('fileSize').textContent = data.fileSizeFormatted;
        
        requiresPassword = data.requiresPassword;
        if (requiresPassword) {
          document.getElementById('passwordForm').style.display = 'block';
        }
      } catch (error) {
        showExpired();
      }
    }
    
    function showExpired() {
      document.getElementById('loadingState').style.display = 'none';
      document.getElementById('expiredState').style.display = 'block';
    }
    
    async function downloadFile() {
      const password = document.getElementById('sharePassword')?.value || '';
      
      if (requiresPassword && !password) {
        showToast('请输入分享密码', 'error');
        return;
      }
      
      try {
        const response = await fetch(' shareId + '/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        });
        
        if (response.ok) {
          // Get filename from Content-Disposition header
          const contentDisposition = response.headers.get('Content-Disposition');
          let filename = 'download';
          if (contentDisposition) {
            const utf8Match = contentDisposition.match(/filename\\*=UTF-8''([^;\\n]+)/i);
            const fallbackMatch = contentDisposition.match(/filename=["']?([^"';\\n]+)/i);
            if (utf8Match) {
              filename = decodeURIComponent(utf8Match[1]);
            } else if (fallbackMatch) {
              filename = fallbackMatch[1];
            }
          }
          
          // Download the file
          const blob = await response.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          
          showToast('下载开始', 'success');
        } else {
          const data = await response.json();
          showToast(data.message || '下载失败', 'error');
        }
      } catch (error) {
        showToast('下载失败: ' + error.message, 'error');
      }
    }
    
    function showToast(message, type = 'info') {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = 'toast toast-' + type;
      toast.textContesage;
      container.appendChild(toast);
      
      setTimeout(() => {
        toast.remove();
      }, 3000);
    }
    
    // Initialize
    loadShareInfo();
  </script>
</body>
</html>
`;

const FIXED_LOGIN_PAGE = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>登录 - EdgeStash</title>
  ${CSS_STYLES}
</head>
<body>
  <div class="login-container">
    <div class="login-card">
      <div class="login-header">
        <div class="login-logo">EdgeStash</div>
        <div class="login-subtitle">基于 Cloudflare 的云盘服务</div>
      </div>

      <div class="login-tabs">
        <button type="button" class="login-tab active" onclick="switchLoginTab('admin')">管理员登录</button>
        <button type="button" class="login-tab" onclick="switchLoginTab('user')">用户登录</button>
      </div>

      <form id="loginForm" onsubmit="handleLogin(event)">
        <div id="emailField" class="form-group" style="display: none;">
          <label class="form-label" for="email">邮箱</label>
          <input type="email" id="email" class="form-input" placeholder="请输入邮箱">
        </div>

        <div class="form-group">
          <label class="form-label" for="password">密码</label>
          <input type="password" id="password" class="form-input" placeholder="请输入密码" required>
        </div>

        <button type="submit" class="btn btn-primary" style="width: 100%;">登录</button>
      </form>
    </div>
  </div>

  <div class="toast-container" id="toastContainer"></div>

  <script>
    let isAdminLogin = true;

    function switchLoginTab(type) {
      isAdminLogin = type === 'admin';
      const tabs = document.querySelectorAll('.login-tab');
      tabs[0].classList.toggle('active', isAdminLogin);
      tabs[1].classList.toggle('active', !isAdminLogin);
      document.getElementById('emailField').style.display = isAdminLogin ? 'none' : 'block';
    }

    async function handleLogin(event) {
      event.preventDefault();

      const password = document.getElementById('password').value;
      const email = document.getElementById('email').value.trim();

      try {
        const response = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            isAdmin: isAdminLogin,
            email: isAdminLogin ? undefined : email,
            password
          })
        });

        const data = await response.json();
        if (data.success) {
          showToast('登录成功', 'success');
          window.setTimeout(function () {
            window.location.href = '/';
          }, 300);
        } else {
          showToast(data.message || '登录失败', 'error');
        }
      } catch (error) {
        showToast('登录失败: ' + error.message, 'error');
      }
    }

    function showToast(message, type) {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = 'toast toast-' + (type || 'info');
      toast.textContent = message;
      container.appendChild(toast);
      window.setTimeout(function () {
        toast.remove();
      }, 3000);
    }
  </script>
</body>
</html>
`;

const FIXED_INDEX_PAGE = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EdgeStash - 云盘</title>
  ${CSS_STYLES}
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js"></script>
</head>
<body>
  <div class="header">
    <div class="logo">EdgeStash</div>
    <div class="header-actions">
      <button type="button" class="btn btn-secondary" onclick="refreshCurrentDirectory()">刷新</button>
      <button type="button" class="btn btn-secondary" onclick="window.location.href='/admin.html'">管理后台</button>
      <button type="button" class="btn btn-secondary" onclick="logout()">退出登录</button>
    </div>
  </div>

  <div class="container">
    <div class="breadcrumb" id="breadcrumb"></div>

    <div class="toolbar">
      <button type="button" class="btn btn-primary" onclick="showNewFolderModal()">📁 新建文件夹</button>
      <button type="button" class="btn btn-primary" onclick="document.getElementById('fileInput').click()">📤 上传文件</button>
      <input type="file" id="fileInput" multiple style="display: none;" onchange="handleFileUpload(event)">
    </div>

    <div class="batch-toolbar" id="batchToolbar">
      <label class="batch-count">
        <input type="checkbox" id="selectAllCheckbox" onchange="toggleSelectAll(this.checked)">
        已选择 <span id="selectedCount">0</span> 项
      </label>
      <button type="button" class="btn btn-sm btn-secondary" onclick="showBatchTargetModal('copy')">复制</button>
      <button type="button" class="btn btn-sm btn-secondary" onclick="showBatchTargetModal('move')">移动</button>
      <button type="button" class="btn btn-sm btn-secondary" onclick="batchDownload()">下载</button>
      <button type="button" class="btn btn-sm btn-danger" onclick="batchDelete()">删除</button>
    </div>

    <div class="card">
      <div id="fileList" class="file-grid"></div>
      <div id="emptyState" class="empty-state" style="display: none;">
        <div class="empty-icon">📂</div>
        <div>此文件夹为空</div>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="newFolderModal">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">新建文件夹</div>
        <button type="button" class="modal-close" onclick="closeModal('newFolderModal')">&times;</button>
      </div>
      <form onsubmit="createFolder(event)">
        <div class="form-group">
          <label class="form-label" for="folderName">文件夹名称</label>
          <input type="text" id="folderName" class="form-input" placeholder="请输入文件夹名称" required>
        </div>
        <button type="submit" class="btn btn-primary" style="width: 100%;">创建</button>
      </form>
    </div>
  </div>

  <div class="modal-overlay" id="renameModal">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">重命名</div>
        <button type="button" class="modal-close" onclick="closeModal('renameModal')">&times;</button>
      </div>
      <form onsubmit="renameFile(event)">
        <div class="form-group">
          <label class="form-label" for="newFileName">新名称</label>
          <input type="text" id="newFileName" class="form-input" required>
        </div>
        <input type="hidden" id="renameFilePath">
        <button type="submit" class="btn btn-primary" style="width: 100%;">确认</button>
      </form>
    </div>
  </div>

  <div class="modal-overlay" id="shareModal">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">创建分享链接</div>
        <button type="button" class="modal-close" onclick="closeModal('shareModal')">&times;</button>
      </div>
      <form onsubmit="createShare(event)">
        <div class="form-group">
          <label class="form-label" for="sharePassword">分享密码（留空则无密码）</label>
          <input type="text" id="sharePassword" class="form-input" placeholder="可选">
        </div>
        <div class="form-group">
          <label class="form-label" for="shareExpiry">有效期</label>
          <select id="shareExpiry" class="form-select">
            <option value="1h">1小时</option>
            <option value="1d" selected>1天</option>
            <option value="1m">1个月</option>
            <option value="permanent">永久有效</option>
          </select>
        </div>
        <input type="hidden" id="shareFilePath">
        <button type="submit" class="btn btn-primary" style="width: 100%;">创建分享链接</button>
      </form>
    </div>
  </div>

  <div class="modal-overlay" id="shareResultModal">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">分享链接已创建</div>
        <button type="button" class="modal-close" onclick="closeModal('shareResultModal')">&times;</button>
      </div>
      <div class="form-group">
        <label class="form-label" for="shareResultUrl">分享链接</label>
        <input type="text" id="shareResultUrl" class="form-input" readonly>
      </div>
      <button type="button" class="btn btn-primary" style="width: 100%;" onclick="copyShareLink()">复制链接</button>
    </div>
  </div>

  <div class="modal-overlay" id="batchTargetModal">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title" id="batchTargetTitle">批量操作</div>
        <button type="button" class="modal-close" onclick="closeModal('batchTargetModal')">&times;</button>
      </div>
      <form onsubmit="submitBatchTarget(event)">
        <div class="form-group">
          <label class="form-label" for="batchFolderSearch">搜索文件夹</label>
          <input type="text" id="batchFolderSearch" class="form-input" placeholder="输入文件夹名称或路径">
          <div class="folder-search-results" id="batchFolderSearchResults"></div>
        </div>
        <div class="form-group">
          <label class="form-label" for="batchDestinationPath">目标文件夹路径</label>
          <input type="text" id="batchDestinationPath" class="form-input" placeholder="/ 或 /文件夹/子文件夹" required>
        </div>
        <input type="hidden" id="batchOperation">
        <button type="submit" class="btn btn-primary" style="width: 100%;">确认</button>
      </form>
    </div>
  </div>

  <div class="preview-overlay" id="previewOverlay">
    <div class="preview-header">
      <div class="preview-filename" id="previewFilename"></div>
      <div class="preview-actions">
        <button type="button" class="btn btn-primary" id="previewDownloadBtn">下载</button>
        <button type="button" class="btn btn-secondary" onclick="closePreview()">关闭</button>
        <button type="button" class="preview-icon-btn preview-download" onclick="document.getElementById('previewDownloadBtn').click()">⬇</button>
        <button type="button" class="preview-icon-btn preview-close" onclick="closePreview()">✕</button>
      </div>
    </div>
    <div class="preview-content" id="previewContent"></div>
  </div>

  <div class="toast-container" id="toastContainer"></div>
  <div class="loading-overlay" id="loadingOverlay" style="display: none;"><div class="spinner"></div></div>

  <script>
    let currentPath = '/';
    let currentReader = null;
    let readerSaveTimer = null;
    const selectedItems = new Map();
    let folderSearchTimer = null;
    let folderSearchRequestId = 0;
    const ACTION_ICONS = {
      download: '<svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>',
      share: '<svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 10.6l6.8-4.2"/><path d="M8.6 13.4l6.8 4.2"/></svg>',
      rename: '<svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
      delete: '<svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>'
    };

    function encodePathForUrl(path) {
      if (!path || path === '/') return '/';
      return path.split('/').map(function (part, index) {
        if (index === 0 && part === '') return '';
        return encodeURIComponent(part);
      }).join('/');
    }

    function apiFileUrl(prefix, path) {
      return prefix + encodePathForUrl(path);
    }

    async function checkAuth() {
      try {
        const response = await fetch('/api/auth/check');
        const data = await response.json();
        if (!data.authenticated) {
          window.location.href = '/login.html';
        }
      } catch (error) {
        window.location.href = '/login.html';
      }
    }

    async function loadFiles() {
      showLoading(true);
      try {
        const response = await fetch(apiFileUrl('/api/files', currentPath));
        const data = await response.json();
        if (!data.success) {
          if (response.status === 401) {
            window.location.href = '/login.html';
            return;
          }
          throw new Error(data.message || '加载失败');
        }
        currentPath = data.currentPath || currentPath;
        clearSelection(false);
        renderBreadcrumb();
        renderFiles(data.folders || [], data.files || []);
      } catch (error) {
        showToast('加载文件失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }

    async function refreshCurrentDirectory() {
      showLoading(true);
      try {
        const response = await fetch('/api/cache/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: currentPath })
        });
        const data = await response.json();
        if (!data.success) {
          throw new Error(data.message || '刷新失败');
        }
        currentPath = data.currentPath || currentPath;
        clearSelection(false);
        renderBreadcrumb();
        renderFiles(data.folders || [], data.files || []);
        showToast('已刷新当前目录', 'success');
      } catch (error) {
        showToast('刷新失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }

    function renderBreadcrumb() {
      const breadcrumb = document.getElementById('breadcrumb');
      breadcrumb.replaceChildren();

      const root = document.createElement('a');
      root.href = '#';
      root.className = 'breadcrumb-item';
      root.textContent = '根目录';
      root.addEventListener('click', function (event) {
        event.preventDefault();
        navigateTo('/');
      });
      breadcrumb.appendChild(root);

      let path = '';
      currentPath.split('/').filter(Boolean).forEach(function (part, index, parts) {
        const separator = document.createElement('span');
        separator.className = 'breadcrumb-separator';
        separator.textContent = '/';
        breadcrumb.appendChild(separator);

        path += '/' + part;
        if (index === parts.length - 1) {
          const active = document.createElement('span');
          active.className = 'breadcrumb-item active';
          active.textContent = part;
          breadcrumb.appendChild(active);
        } else {
          const link = document.createElement('a');
          link.href = '#';
          link.className = 'breadcrumb-item';
          link.textContent = part;
          const targetPath = path;
          link.addEventListener('click', function (event) {
            event.preventDefault();
            navigateTo(targetPath);
          });
          breadcrumb.appendChild(link);
        }
      });
    }

    function renderFiles(folders, files) {
      const fileList = document.getElementById('fileList');
      const emptyState = document.getElementById('emptyState');
      fileList.replaceChildren();

      if (folders.length === 0 && files.length === 0) {
        emptyState.style.display = 'block';
        return;
      }

      emptyState.style.display = 'none';
      folders.forEach(function (folder) {
        fileList.appendChild(createFileCard({
          name: folder.name,
          path: folder.path,
          typeLabel: '📁',
          meta: '文件夹',
          isFolder: true
        }));
      });

      files.forEach(function (file) {
        fileList.appendChild(createFileCard({
          name: file.name,
          path: file.path,
          typeLabel: getFileIcon(file.name),
          meta: file.sizeFormatted || '',
          previewType: file.previewType || '',
          isFolder: false
        }));
      });
    }

    function createFileCard(item) {
      const card = document.createElement('div');
      card.className = 'file-item';
      if (selectedItems.has(item.path)) {
        card.classList.add('selected');
      }
      card.addEventListener('dblclick', function () {
        if (item.isFolder) {
          navigateTo(item.path);
        } else {
          handleFileClick(item.path, item.previewType, item.name);
        }
      });
      card.addEventListener('click', function () {
        if (item.isFolder && window.matchMedia('(max-width: 768px)').matches) {
          navigateTo(item.path);
        }
      });

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'file-select';
      checkbox.checked = selectedItems.has(item.path);
      checkbox.setAttribute('aria-label', '选择 ' + item.name);
      checkbox.addEventListener('click', function (event) {
        event.stopPropagation();
      });
      checkbox.addEventListener('change', function () {
        toggleItemSelection(item, checkbox.checked, card);
      });
      card.appendChild(checkbox);

      const icon = document.createElement('div');
      icon.className = 'file-icon';
      icon.textContent = item.typeLabel;
      card.appendChild(icon);

      const name = document.createElement('div');
      name.className = 'file-name';
      name.textContent = item.name;
      name.title = item.name;
      card.appendChild(name);

      const meta = document.createElement('div');
      meta.className = 'file-meta';
      meta.textContent = item.meta;
      if (item.previewType) {
        const badge = document.createElement('span');
        badge.className = 'badge badge-info';
        badge.textContent = ' 可预览';
        meta.appendChild(badge);
      }
      card.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'file-actions';
      if (!item.isFolder) {
        actions.appendChild(createActionButton('download', '下载', 'btn-secondary', function () {
          downloadFile(item.path);
        }));
        actions.appendChild(createActionButton('share', '分享', 'btn-secondary', function () {
          showShareModal(item.path);
        }));
        actions.appendChild(createActionButton('rename', '重命名', 'btn-secondary', function () {
          showRenameModal(item.path, item.name);
        }));
        actions.appendChild(createActionButton('delete', '删除', 'btn-danger', function () {
          deleteFile(item.path);
        }));
        card.appendChild(actions);
      }
      return card;
    }

    function createActionButton(actionKey, label, className, handler) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-sm icon-btn ' + className;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.innerHTML = ACTION_ICONS[actionKey] || label;
      button.addEventListener('click', function (event) {
        event.stopPropagation();
        handler();
      });
      return button;
    }

    function toggleItemSelection(item, checked, card) {
      if (checked) {
        selectedItems.set(item.path, {
          path: item.path,
          name: item.name,
          isFolder: !!item.isFolder
        });
      } else {
        selectedItems.delete(item.path);
      }
      if (card) {
        card.classList.toggle('selected', checked);
      }
      updateBatchToolbar();
    }

    function toggleSelectAll(checked) {
      document.querySelectorAll('.file-select').forEach(function (checkbox) {
        checkbox.checked = checked;
        checkbox.dispatchEvent(new Event('change'));
      });
    }

    function clearSelection(updateOnly) {
      selectedItems.clear();
      document.querySelectorAll('.file-select').forEach(function (checkbox) {
        checkbox.checked = false;
        const card = checkbox.closest('.file-item');
        if (card) card.classList.remove('selected');
      });
      if (updateOnly !== false) {
        updateBatchToolbar();
      } else {
        const toolbar = document.getElementById('batchToolbar');
        const selectedCount = document.getElementById('selectedCount');
        const selectAll = document.getElementById('selectAllCheckbox');
        if (toolbar) toolbar.classList.remove('active');
        if (selectedCount) selectedCount.textContent = '0';
        if (selectAll) {
          selectAll.checked = false;
          selectAll.indeterminate = false;
        }
      }
    }

    function updateBatchToolbar() {
      const count = selectedItems.size;
      const toolbar = document.getElementById('batchToolbar');
      const selectedCount = document.getElementById('selectedCount');
      const selectAll = document.getElementById('selectAllCheckbox');
      const total = document.querySelectorAll('.file-select').length;

      toolbar.classList.toggle('active', count > 0);
      selectedCount.textContent = String(count);
      selectAll.checked = total > 0 && count === total;
      selectAll.indeterminate = count > 0 && count < total;
    }

    function getSelectedItems() {
      return Array.from(selectedItems.values());
    }

    function getFileIcon(filename) {
      const ext = (filename.split('.').pop() || '').toLowerCase();
      const icons = {
        pdf: '📕',
        doc: '📘',
        docx: '📘',
        xls: '📗',
        xlsx: '📗',
        ppt: '📙',
        pptx: '📙',
        jpg: '🖼️',
        jpeg: '🖼️',
        png: '🖼️',
        gif: '🖼️',
        svg: '🖼️',
        webp: '🖼️',
        mp3: '🎵',
        wav: '🎵',
        flac: '🎵',
        m4a: '🎵',
        mp4: '🎬',
        webm: '🎬',
        zip: '📦',
        rar: '📦',
        '7z': '📦',
        tar: '📦',
        gz: '📦',
        txt: '📄',
        md: '📝',
        json: '📋',
        js: '📜',
        ts: '📜',
        css: '🎨',
        html: '🌐'
      };
      return icons[ext] || '📄';
    }

    function navigateTo(path) {
      currentPath = path || '/';
      loadFiles();
    }

    function handleFileClick(path, previewType, filename) {
      if (previewType) {
        previewFile(path, previewType, filename);
      } else {
        downloadFile(path);
      }
    }

    async function previewFile(path, previewType, filename) {
      const overlay = document.getElementById('previewOverlay');
      const content = document.getElementById('previewContent');
      const filenameEl = document.getElementById('previewFilename');
      const downloadBtn = document.getElementById('previewDownloadBtn');

      stopReaderProgressTracking();
      content.classList.remove('reader-mode');
      filenameEl.textContent = filename;
      downloadBtn.onclick = function () {
        downloadFile(path);
      };
      content.innerHTML = '<div class="preview-loading"><div class="spinner"></div><div>加载中...</div></div>';
      overlay.classList.add('active');

      const previewUrl = apiFileUrl('/api/preview', path);
      try {
        if (previewType === 'image') {
          const img = document.createElement('img');
          img.className = 'preview-image';
          img.src = previewUrl;
          img.alt = filename;
          content.replaceChildren(img);
        } else if (previewType === 'pdf') {
          const iframe = document.createElement('iframe');
          iframe.className = 'preview-pdf';
          iframe.src = previewUrl + '#toolbar=1';
          content.replaceChildren(iframe);
        } else if (previewType === 'video') {
          const video = document.createElement('video');
          video.className = 'preview-video';
          video.controls = true;
          video.autoplay = true;
          video.src = previewUrl;
          content.replaceChildren(video);
        } else if (previewType === 'audio') {
          const audio = document.createElement('audio');
          audio.className = 'preview-audio';
          audio.controls = true;
          audio.autoplay = true;
          audio.src = previewUrl;
          content.replaceChildren(audio);
        } else if (previewType === 'word') {
          if (!window.mammoth) throw new Error('文档预览组件加载失败');
          const response = await fetch(previewUrl);
          if (!response.ok) throw new Error('文件读取失败');
          const buffer = await response.arrayBuffer();
          const result = await window.mammoth.convertToHtml({ arrayBuffer: buffer });
          const wrapper = document.createElement('div');
          wrapper.className = 'preview-markdown';
          wrapper.innerHTML = result.value;
          content.replaceChildren(wrapper);
        } else if (previewType === 'text') {
          const response = await fetch(previewUrl);
          if (!response.ok) throw new Error('文件读取失败');
          const buffer = await response.arrayBuffer();
          const text = decodeTextBuffer(buffer);
          const ext = (filename.split('.').pop() || '').toLowerCase();
          if (ext === 'txt') {
            await renderTxtReader(content, path, text);
          } else if (ext === 'md' && window.marked) {
            const wrapper = document.createElement('div');
            wrapper.className = 'preview-markdown';
            wrapper.innerHTML = window.marked.parse(text);
            content.replaceChildren(wrapper);
          } else {
            const pre = document.createElement('pre');
            pre.className = 'preview-text';
            if (ext === 'json') {
              try {
                pre.textContent = JSON.stringify(JSON.parse(text), null, 2);
              } catch (error) {
                pre.textContent = text;
              }
            } else {
              pre.textContent = text;
            }
            content.replaceChildren(pre);
          }
        } else {
          showPreviewError('不支持预览此文件类型');
        }
      } catch (error) {
        showPreviewError('预览加载失败: ' + error.message);
      }
    }

    async function renderTxtReader(content, path, text) {
      content.classList.add('reader-mode');

      const reader = document.createElement('div');
      reader.className = 'preview-reader';
      reader.tabIndex = 0;
      const textNode = document.createTextNode(text);
      reader.appendChild(textNode);
      content.replaceChildren(reader);

      const state = { path, text, reader, textNode };
      currentReader = state;

      await restoreReaderProgress(state);
      reader.addEventListener('scroll', function () {
        scheduleReaderProgressSave(state);
      }, { passive: true });
    }

    async function restoreReaderProgress(state) {
      try {
        const response = await fetch('/api/reader/progress?path=' + encodeURIComponent(state.path));
        if (!response.ok) return;

        const data = await response.json();
        const saved = data.progress;
        if (!saved) return;

        await waitForReaderLayout();

        const restoredByChar = scrollReaderToCharOffset(state, saved.charOffset);
        if (!restoredByChar) {
          scrollReaderToProgress(state, saved.progress);
        }
      } catch (error) {
        console.warn('Reader progress restore failed:', error);
      }
    }

    function waitForReaderLayout() {
      return new Promise(function (resolve) {
        requestAnimationFrame(function () {
          requestAnimationFrame(resolve);
        });
      });
    }

    function scrollReaderToCharOffset(state, charOffset) {
      const textLength = state.text.length;
      if (!Number.isFinite(charOffset) || textLength === 0) return false;

      const offset = Math.max(0, Math.min(textLength, Math.floor(charOffset)));
      if (offset === 0) {
        state.reader.scrollTop = 0;
        return true;
      }

      const range = document.createRange();
      const start = Math.max(0, Math.min(offset, textLength - 1));
      const end = Math.min(textLength, start + 1);
      range.setStart(state.textNode, start);
      range.setEnd(state.textNode, end);

      const rect = range.getBoundingClientRect();
      if (range.detach) range.detach();

      if (!rect || (rect.width === 0 && rect.height === 0)) return false;

      const readerRect = state.reader.getBoundingClientRect();
      state.reader.scrollTop += rect.top - readerRect.top - 28;
      return true;
    }

    function scrollReaderToProgress(state, progress) {
      const safeProgress = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
      const maxScrollTop = Math.max(0, state.reader.scrollHeight - state.reader.clientHeight);
      state.reader.scrollTop = maxScrollTop * safeProgress;
    }

    function scheduleReaderProgressSave(state) {
      if (currentReader !== state) return;
      if (readerSaveTimer) clearTimeout(readerSaveTimer);
      readerSaveTimer = setTimeout(function () {
        readerSaveTimer = null;
        saveReaderProgress(state);
      }, 500);
    }

    function stopReaderProgressTracking() {
      if (readerSaveTimer) {
        clearTimeout(readerSaveTimer);
        readerSaveTimer = null;
      }

      const state = currentReader;
      currentReader = null;
      if (state) {
        saveReaderProgress(state);
      }
    }

    async function saveReaderProgress(state) {
      try {
        const maxScrollTop = Math.max(0, state.reader.scrollHeight - state.reader.clientHeight);
        const progress = maxScrollTop > 0 ? state.reader.scrollTop / maxScrollTop : 0;
        const payload = {
          path: state.path,
          charOffset: getReaderCharOffset(state),
          progress,
          scrollTop: state.reader.scrollTop,
          scrollHeight: state.reader.scrollHeight
        };

        await fetch('/api/reader/progress', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true
        });
      } catch (error) {
        console.warn('Reader progress save failed:', error);
      }
    }

    function getReaderCharOffset(state) {
      const rect = state.reader.getBoundingClientRect();
      const x = rect.left + Math.min(48, Math.max(8, state.reader.clientWidth - 8));
      const y = rect.top + 32;
      let offset = null;

      if (document.caretPositionFromPoint) {
        const position = document.caretPositionFromPoint(x, y);
        if (position && position.offsetNode === state.textNode) {
          offset = position.offset;
        }
      } else if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(x, y);
        if (range && range.startContainer === state.textNode) {
          offset = range.startOffset;
        }
      }

      if (!Number.isFinite(offset)) {
        const maxScrollTop = Math.max(0, state.reader.scrollHeight - state.reader.clientHeight);
        const progress = maxScrollTop > 0 ? state.reader.scrollTop / maxScrollTop : 0;
        offset = Math.floor(state.text.length * progress);
      }

      return Math.max(0, Math.min(state.text.length, Math.floor(offset)));
    }

    function decodeTextBuffer(buffer) {
      const bytes = new Uint8Array(buffer);
      if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        return new TextDecoder('utf-8').decode(bytes.subarray(3));
      }
      if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return new TextDecoder('utf-16le').decode(bytes.subarray(2));
      }
      if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return new TextDecoder('utf-16be').decode(bytes.subarray(2));
      }

      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch (error) {
        try {
          return new TextDecoder('gb18030').decode(bytes);
        } catch (gbError) {
          return new TextDecoder('utf-8').decode(bytes);
        }
      }
    }

    function showPreviewError(message) {
      const content = document.getElementById('previewContent');
      const error = document.createElement('div');
      error.className = 'preview-error';
      error.textContent = message;
      content.replaceChildren(error);
    }

    function closePreview() {
      stopReaderProgressTracking();
      document.getElementById('previewOverlay').classList.remove('active');
      const content = document.getElementById('previewContent');
      content.classList.remove('reader-mode');
      content.replaceChildren();
    }

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closePreview();
    });

    async function handleFileUpload(event) {
      const files = Array.from(event.target.files || []);
      if (files.length === 0) return;

      showLoading(true);
      for (const file of files) {
        try {
          const formData = new FormData();
          formData.append('file', file);
          const response = await fetch(apiFileUrl('/api/files', currentPath), {
            method: 'POST',
            body: formData
          });
          const data = await response.json();
          if (data.success) {
            showToast('文件 ' + file.name + ' 上传成功', 'success');
          } else {
            showToast('文件 ' + file.name + ' 上传失败: ' + (data.message || '未知错误'), 'error');
          }
        } catch (error) {
          showToast('文件 ' + file.name + ' 上传失败: ' + error.message, 'error');
        }
      }
      event.target.value = '';
      showLoading(false);
      loadFiles();
    }

    function showNewFolderModal() {
      document.getElementById('folderName').value = '';
      document.getElementById('newFolderModal').classList.add('active');
    }

    async function createFolder(event) {
      event.preventDefault();
      const name = document.getElementById('folderName').value.trim();
      if (!name) {
        showToast('请输入文件夹名称', 'error');
        return;
      }

      showLoading(true);
      closeModal('newFolderModal');
      try {
        let folderPath = currentPath;
        if (!folderPath.endsWith('/')) folderPath += '/';
        folderPath += name;
        const response = await fetch('/api/folders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: folderPath })
        });
        const data = await response.json();
        if (data.success) {
          showToast('文件夹创建成功', 'success');
          loadFiles();
        } else {
          showToast('创建失败: ' + (data.message || '未知错误'), 'error');
        }
      } catch (error) {
        showToast('创建失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }

    function showRenameModal(path, currentName) {
      document.getElementById('renameFilePath').value = path;
      document.getElementById('newFileName').value = currentName;
      document.getElementById('renameModal').classList.add('active');
    }

    async function renameFile(event) {
      event.preventDefault();
      const path = document.getElementById('renameFilePath').value;
      const newName = document.getElementById('newFileName').value.trim();
      if (!newName) {
        showToast('请输入新名称', 'error');
        return;
      }

      showLoading(true);
      closeModal('renameModal');
      try {
        const response = await fetch(apiFileUrl('/api/files', path), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newName })
        });
        const data = await response.json();
        if (data.success) {
          showToast('重命名成功', 'success');
          loadFiles();
        } else {
          showToast('重命名失败: ' + (data.message || '未知错误'), 'error');
        }
      } catch (error) {
        showToast('重命名失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }

    async function deleteFile(path) {
      if (!window.confirm('确定要删除吗？此操作不可恢复。')) return;
      showLoading(true);
      try {
        const response = await fetch(apiFileUrl('/api/files', path), { method: 'DELETE' });
        const data = await response.json();
        if (data.success) {
          showToast('删除成功', 'success');
          loadFiles();
        } else {
          showToast('删除失败: ' + (data.message || '未知错误'), 'error');
        }
      } catch (error) {
        showToast('删除失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }

    function initializeBatchFolderSearch() {
      const input = document.getElementById('batchFolderSearch');
      if (!input) return;

      input.addEventListener('input', function () {
        if (folderSearchTimer) clearTimeout(folderSearchTimer);
        folderSearchTimer = window.setTimeout(function () {
          searchBatchFolders(input.value);
        }, 300);
      });

      input.addEventListener('focus', function () {
        searchBatchFolders(input.value);
      });
    }

    function clearBatchFolderSearchResults() {
      const results = document.getElementById('batchFolderSearchResults');
      if (!results) return;
      results.classList.remove('active');
      results.replaceChildren();
    }

    async function searchBatchFolders(query) {
      const results = document.getElementById('batchFolderSearchResults');
      if (!results) return;

      const requestId = ++folderSearchRequestId;
      results.classList.add('active');
      results.replaceChildren(createFolderSearchMessage('搜索中...'));

      try {
        const response = await fetch('/api/folders/search?q=' + encodeURIComponent(query || '') + '&limit=50');
        const data = await response.json();
        if (requestId !== folderSearchRequestId) return;
        results.replaceChildren();

        if (!data.success) {
          results.appendChild(createFolderSearchMessage(data.message || '搜索失败'));
          return;
        }

        if (!data.folders || data.folders.length === 0) {
          results.appendChild(createFolderSearchMessage('没有匹配的文件夹'));
          return;
        }

        data.folders.forEach(function (folder) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'folder-search-item';
          button.textContent = folder.path;
          button.addEventListener('click', function () {
            document.getElementById('batchDestinationPath').value = folder.path;
            document.getElementById('batchFolderSearch').value = folder.path;
            clearBatchFolderSearchResults();
          });
          results.appendChild(button);
        });

        if (data.truncated) {
          results.appendChild(createFolderSearchMessage('仅显示前 50 条结果，请输入更精确的关键词'));
        }
      } catch (error) {
        if (requestId !== folderSearchRequestId) return;
        results.replaceChildren(createFolderSearchMessage('搜索失败: ' + error.message));
      }
    }

    function createFolderSearchMessage(message) {
      const div = document.createElement('div');
      div.className = 'folder-search-empty';
      div.textContent = message;
      return div;
    }

    function showBatchTargetModal(operation) {
      const items = getSelectedItems();
      if (items.length === 0) {
        showToast('请先选择文件或文件夹', 'error');
        return;
      }

      document.getElementById('batchOperation').value = operation;
      document.getElementById('batchDestinationPath').value = currentPath;
      document.getElementById('batchFolderSearch').value = '';
      clearBatchFolderSearchResults();
      document.getElementById('batchTargetTitle').textContent = operation === 'copy' ? '复制到' : '移动到';
      document.getElementById('batchTargetModal').classList.add('active');
      searchBatchFolders('');
    }

    async function submitBatchTarget(event) {
      event.preventDefault();
      const operation = document.getElementById('batchOperation').value;
      const destinationPath = document.getElementById('batchDestinationPath').value.trim() || '/';
      closeModal('batchTargetModal');
      await runBatchOperation(operation, destinationPath);
    }

    async function batchDelete() {
      const items = getSelectedItems();
      if (items.length === 0) {
        showToast('请先选择文件或文件夹', 'error');
        return;
      }

      if (!window.confirm('确定要删除选中的 ' + items.length + ' 项吗？此操作不可恢复。')) return;
      await runBatchOperation('delete', '/');
    }

    async function batchDownload() {
      const items = getSelectedItems();
      if (items.length === 0) {
        showToast('请先选择文件或文件夹', 'error');
        return;
      }

      showLoading(true);
      try {
        const response = await fetch('/api/batch/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: items })
        });

        if (!response.ok) {
          let message = '下载失败';
          try {
            const data = await response.json();
            message = data.message || message;
          } catch (error) {
            message = response.statusText || message;
          }
          throw new Error(message);
        }

        const blob = await response.blob();
        const filename = getDownloadFilename(response.headers.get('Content-Disposition')) || 'edgestash.zip';
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        showToast('批量下载已开始', 'success');
      } catch (error) {
        showToast('批量下载失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }

    function getDownloadFilename(header) {
      if (!header) return '';
      const utf8Match = header.match(/filename\\*=UTF-8''([^;\\n]+)/i);
      if (utf8Match) {
        try {
          return decodeURIComponent(utf8Match[1]);
        } catch (error) {
          return utf8Match[1];
        }
      }
      const fallbackMatch = header.match(/filename=["']?([^"';\\n]+)/i);
      return fallbackMatch ? fallbackMatch[1] : '';
    }

    async function runBatchOperation(operation, destinationPath) {
      const items = getSelectedItems();
      if (items.length === 0) return;

      showLoading(true);
      try {
        const response = await fetch('/api/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            operation: operation,
            destinationPath: destinationPath,
            items: items
          })
        });
        const data = await response.json();
        if (data.success) {
          const failed = Array.isArray(data.errors) ? data.errors.length : 0;
          showToast(failed > 0 ? '部分项目操作失败，已完成其余项目' : '批量操作成功', failed > 0 ? 'info' : 'success');
          if (failed > 0 && data.errors[0]) {
            showToast(data.errors[0].path + ': ' + data.errors[0].message, 'error');
          }
          clearSelection();
          await loadFiles();
        } else {
          const detail = data.errors && data.errors[0] ? data.errors[0].message : (data.message || '未知错误');
          showToast('批量操作失败: ' + detail, 'error');
        }
      } catch (error) {
        showToast('批量操作失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }

    function downloadFile(path) {
      window.open(apiFileUrl('/api/download', path), '_blank');
    }

    function showShareModal(path) {
      document.getElementById('shareFilePath').value = path;
      document.getElementById('sharePassword').value = '';
      document.getElementById('shareExpiry').value = '1d';
      document.getElementById('shareModal').classList.add('active');
    }

    async function createShare(event) {
      event.preventDefault();
      const filePath = document.getElementById('shareFilePath').value;
      const password = document.getElementById('sharePassword').value;
      const expiresIn = document.getElementById('shareExpiry').value;

      showLoading(true);
      closeModal('shareModal');
      try {
        const response = await fetch('/api/share', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: filePath, password: password, expiresIn: expiresIn })
        });
        const data = await response.json();
        if (data.success) {
          document.getElementById('shareResultUrl').value = window.location.origin + data.shareUrl;
          document.getElementById('shareResultModal').classList.add('active');
        } else {
          showToast('创建分享链接失败: ' + (data.message || '未知错误'), 'error');
        }
      } catch (error) {
        showToast('创建分享链接失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }

    function copyShareLink() {
      const input = document.getElementById('shareResultUrl');
      input.select();
      const text = input.value;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          showToast('链接已复制', 'success');
        }).catch(function () {
          document.execCommand('copy');
          showToast('链接已复制', 'success');
        });
      } else {
        document.execCommand('copy');
        showToast('链接已复制', 'success');
      }
    }

    async function logout() {
      try {
        await fetch('/api/logout', { method: 'POST' });
      } finally {
        window.location.href = '/login.html';
      }
    }

    function closeModal(id) {
      document.getElementById(id).classList.remove('active');
    }

    function showLoading(show) {
      document.getElementById('loadingOverlay').style.display = show ? 'flex' : 'none';
    }

    function showToast(message, type) {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = 'toast toast-' + (type || 'info');
      toast.textContent = message;
      container.appendChild(toast);
      window.setTimeout(function () {
        toast.remove();
      }, 3000);
    }

    initializeBatchFolderSearch();
    checkAuth();
    loadFiles();
  </script>
</body>
</html>
`;

const FIXED_ADMIN_PAGE = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>管理后台 - EdgeStash</title>
  ${CSS_STYLES}
</head>
<body>
  <div class="header">
    <div class="logo">EdgeStash 管理后台</div>
    <div class="header-actions">
      <button type="button" class="btn btn-secondary" onclick="window.location.href='/'">返回云盘</button>
      <button type="button" class="btn btn-secondary" onclick="logout()">退出登录</button>
    </div>
  </div>

  <div class="container">
    <div class="tabs">
      <button type="button" class="tab active" onclick="switchTab('stats', event)">统计数据</button>
      <button type="button" class="tab" onclick="switchTab('shares', event)">分享链接</button>
      <button type="button" class="tab" onclick="switchTab('users', event)">授权用户</button>
    </div>

    <div id="statsTab" class="tab-content active">
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-value" id="totalShares">0</div><div class="stat-label">总分享链接数</div></div>
        <div class="stat-card"><div class="stat-value" id="totalViews">0</div><div class="stat-label">总浏览次数</div></div>
        <div class="stat-card"><div class="stat-value" id="totalDownloads">0</div><div class="stat-label">总下载次数</div></div>
      </div>
    </div>

    <div id="sharesTab" class="tab-content">
      <div class="card">
        <div class="card-header"><div class="card-title">分享链接管理</div></div>
        <div class="table-container">
          <table>
            <thead><tr><th>文件名</th><th>分享ID</th><th>密码保护</th><th>浏览次数</th><th>下载次数</th><th>状态</th><th>操作</th></tr></thead>
            <tbody id="sharesTable"></tbody>
          </table>
        </div>
      </div>
    </div>

    <div id="usersTab" class="tab-content">
      <div class="card">
        <div class="card-header">
          <div class="card-title">授权用户管理</div>
          <button type="button" class="btn btn-primary" onclick="showAddUserModal()">添加用户</button>
        </div>
        <div class="table-container">
          <table>
            <thead><tr><th>邮箱</th><th>角色</th><th>创建时间</th><th>操作</th></tr></thead>
            <tbody id="usersTable"></tbody>
          </table>
        </div>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="addUserModal">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">添加授权用户</div>
        <button type="button" class="modal-close" onclick="closeModal('addUserModal')">&times;</button>
      </div>
      <form onsubmit="addUser(event)">
        <div class="form-group">
          <label class="form-label" for="newUserEmail">邮箱</label>
          <input type="email" id="newUserEmail" class="form-input" placeholder="请输入邮箱" required>
        </div>
        <div class="form-group">
          <label class="form-label" for="newUserPassword">密码</label>
          <input type="text" id="newUserPassword" class="form-input" placeholder="请输入密码" required>
        </div>
        <button type="submit" class="btn btn-primary" style="width: 100%;">添加用户</button>
      </form>
    </div>
  </div>

  <div class="toast-container" id="toastContainer"></div>
  <div class="loading-overlay" id="loadingOverlay" style="display: none;"><div class="spinner"></div></div>

  <script>
    async function checkAdminAuth() {
      try {
        const response = await fetch('/api/auth/check');
        const data = await response.json();
        if (!data.authenticated || data.role !== 'admin') {
          window.location.href = '/login.html';
        }
      } catch (error) {
        window.location.href = '/login.html';
      }
    }

    function switchTab(tab, event) {
      document.querySelectorAll('.tab').forEach(function (item) {
        item.classList.remove('active');
      });
      document.querySelectorAll('.tab-content').forEach(function (item) {
        item.classList.remove('active');
      });
      event.target.classList.add('active');
      document.getElementById(tab + 'Tab').classList.add('active');
      if (tab === 'stats') loadStats();
      if (tab === 'shares') loadShares();
      if (tab === 'users') loadUsers();
    }

    async function loadStats() {
      try {
        const response = await fetch('/api/admin/stats');
        const data = await response.json();
        if (data.success) {
          document.getElementById('totalShares').textContent = data.totalShares;
          document.getElementById('totalViews').textContent = data.totalViews;
          document.getElementById('totalDownloads').textContent = data.totalDownloads;
        }
      } catch (error) {
        showToast('加载统计数据失败: ' + error.message, 'error');
      }
    }

    async function loadShares() {
      showLoading(true);
      try {
        const response = await fetch('/api/admin/shares');
        const data = await response.json();
        const tbody = document.getElementById('sharesTable');
        tbody.replaceChildren();
        if (!data.success) throw new Error(data.message || '加载失败');
        if (data.shares.length === 0) {
          appendEmptyRow(tbody, 7, '暂无分享链接');
          return;
        }
        data.shares.forEach(function (share) {
          const tr = document.createElement('tr');
          appendCell(tr, share.fileName);
          appendCell(tr, share.shareId);
          appendCell(tr, share.passwordHash ? '是' : '否');
          appendCell(tr, String(share.viewCount || 0));
          appendCell(tr, String(share.downloadCount || 0));
          appendCell(tr, share.isExpired ? '已过期' : '有效');
          const actions = document.createElement('td');
          actions.appendChild(createSmallButton('复制链接', 'btn-secondary', function () {
            copyShareLink(share.shareId);
          }));
          actions.appendChild(createSmallButton('删除', 'btn-danger', function () {
            deleteShare(share.shareId);
          }));
          tr.appendChild(actions);
          tbody.appendChild(tr);
        });
      } catch (error) {
        showToast('加载分享列表失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }

    async function loadUsers() {
      showLoading(true);
      try {
        const response = await fetch('/api/admin/users');
        const data = await response.json();
        const tbody = document.getElementById('usersTable');
        tbody.replaceChildren();
        if (!data.success) throw new Error(data.message || '加载失败');
        if (data.users.length === 0) {
          appendEmptyRow(tbody, 4, '暂无授权用户');
          return;
        }
        data.users.forEach(function (user) {
          const tr = document.createElement('tr');
          appendCell(tr, user.email);
          appendCell(tr, user.role === 'admin' ? '管理员' : '普通用户');
          appendCell(tr, user.createdAt ? new Date(user.createdAt).toLocaleString() : '-');
          const actions = document.createElement('td');
          actions.appendChild(createSmallButton('撤销授权', 'btn-danger', function () {
            deleteUser(user.email);
          }));
          tr.appendChild(actions);
          tbody.appendChild(tr);
        });
      } catch (error) {
        showToast('加载用户列表失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }

    function appendCell(tr, value) {
      const td = document.createElement('td');
      td.textContent = value == null ? '' : value;
      tr.appendChild(td);
    }

    function appendEmptyRow(tbody, colspan, message) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = colspan;
      td.style.textAlign = 'center';
      td.style.color = 'var(--text-muted)';
      td.textContent = message;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }

    function createSmallButton(label, className, handler) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-sm ' + className;
      button.textContent = label;
      button.addEventListener('click', handler);
      return button;
    }

    function showAddUserModal() {
      document.getElementById('newUserEmail').value = '';
      document.getElementById('newUserPassword').value = '';
      document.getElementById('addUserModal').classList.add('active');
    }

    async function addUser(event) {
      event.preventDefault();
      const email = document.getElementById('newUserEmail').value.trim();
      const password = document.getElementById('newUserPassword').value;
      showLoading(true);
      closeModal('addUserModal');
      try {
        const response = await fetch('/api/admin/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email, password: password })
        });
        const data = await response.json();
        if (data.success) {
          showToast('用户添加成功', 'success');
          loadUsers();
        } else {
          showToast('添加失败: ' + (data.message || '未知错误'), 'error');
        }
      } catch (error) {
        showToast('添加失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }

    async function deleteUser(email) {
      if (!window.confirm('确定要撤销该用户的授权吗？')) return;
      showLoading(true);
      try {
        const response = await fetch('/api/admin/users/' + encodeURIComponent(email), { method: 'DELETE' });
        const data = await response.json();
        if (data.success) {
          showToast('用户已删除', 'success');
          loadUsers();
        } else {
          showToast('删除失败: ' + (data.message || '未知错误'), 'error');
        }
      } catch (error) {
        showToast('删除失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }

    async function deleteShare(shareId) {
      if (!window.confirm('确定要删除该分享链接吗？')) return;
      showLoading(true);
      try {
        const response = await fetch('/api/admin/shares/' + encodeURIComponent(shareId), { method: 'DELETE' });
        const data = await response.json();
        if (data.success) {
          showToast('分享链接已删除', 'success');
          loadShares();
        } else {
          showToast('删除失败: ' + (data.message || '未知错误'), 'error');
        }
      } catch (error) {
        showToast('删除失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }

    function copyShareLink(shareId) {
      const url = window.location.origin + '/s/' + shareId;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () {
          showToast('链接已复制', 'success');
        }).catch(function () {
          showToast('复制失败', 'error');
        });
      } else {
        showToast(url, 'info');
      }
    }

    async function logout() {
      try {
        await fetch('/api/logout', { method: 'POST' });
      } finally {
        window.location.href = '/login.html';
      }
    }

    function closeModal(id) {
      document.getElementById(id).classList.remove('active');
    }

    function showLoading(show) {
      document.getElementById('loadingOverlay').style.display = show ? 'flex' : 'none';
    }

    function showToast(message, type) {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = 'toast toast-' + (type || 'info');
      toast.textContent = message;
      container.appendChild(toast);
      window.setTimeout(function () {
        toast.remove();
      }, 3000);
    }

    checkAdminAuth();
    loadStats();
  </script>
</body>
</html>
`;

const FIXED_SHARE_PAGE = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>文件分享 - EdgeStash</title>
  ${CSS_STYLES}
</head>
<body>
  <div class="share-container">
    <div class="share-card">
      <div id="loadingState">
        <div class="spinner" style="margin: 0 auto 20px;"></div>
        <div>加载中...</div>
      </div>

      <div id="expiredState" style="display: none;">
        <div class="share-expired">分享链接已过期或不存在</div>
        <p style="color: var(--text-muted); margin-top: 16px;">请联系分享者获取新的链接</p>
      </div>

      <div id="shareContent" style="display: none;">
        <div class="share-icon">📄</div>
        <div class="share-filename" id="fileName"></div>
        <div class="share-filesize" id="fileSize"></div>
        <div id="passwordForm" style="display: none;">
          <div class="form-group">
            <label class="form-label" for="sharePassword">请输入分享密码</label>
            <input type="password" id="sharePassword" class="form-input" placeholder="输入密码">
          </div>
        </div>
        <button type="button" class="btn btn-primary" style="width: 100%; margin-top: 20px;" onclick="downloadFile()">下载文件</button>
      </div>
    </div>
  </div>

  <div class="toast-container" id="toastContainer"></div>

  <script>
    let shareId = '';
    let requiresPassword = false;

    async function loadShareInfo() {
      const parts = window.location.pathname.split('/').filter(Boolean);
      shareId = parts[1] || '';
      if (!shareId) {
        showExpired();
        return;
      }

      try {
        const response = await fetch('/api/share/' + encodeURIComponent(shareId));
        const data = await response.json();
        if (!data.success) {
          showExpired();
          return;
        }
        document.getElementById('loadingState').style.display = 'none';
        document.getElementById('shareContent').style.display = 'block';
        document.getElementById('fileName').textContent = data.fileName;
        document.getElementById('fileSize').textContent = data.fileSizeFormatted;
        requiresPassword = !!data.requiresPassword;
        document.getElementById('passwordForm').style.display = requiresPassword ? 'block' : 'none';
      } catch (error) {
        showExpired();
      }
    }

    function showExpired() {
      document.getElementById('loadingState').style.display = 'none';
      document.getElementById('expiredState').style.display = 'block';
    }

    async function downloadFile() {
      const password = document.getElementById('sharePassword') ? document.getElementById('sharePassword').value : '';
      if (requiresPassword && !password) {
        showToast('请输入分享密码', 'error');
        return;
      }

      try {
        const response = await fetch('/api/share/' + encodeURIComponent(shareId) + '/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: password })
        });
        if (!response.ok) {
          const data = await response.json();
          showToast(data.message || '下载失败', 'error');
          return;
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = getFilenameFromDisposition(response.headers.get('Content-Disposition'));
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('下载开始', 'success');
      } catch (error) {
        showToast('下载失败: ' + error.message, 'error');
      }
    }

    function getFilenameFromDisposition(header) {
      if (!header) return 'download';
      const utf8Match = header.match(/filename\\*=UTF-8''([^;\\n]+)/i);
      if (utf8Match) {
        try {
          return decodeURIComponent(utf8Match[1]);
        } catch (error) {
          return utf8Match[1];
        }
      }
      const fallbackMatch = header.match(/filename=["']?([^"';\\n]+)/i);
      return fallbackMatch ? fallbackMatch[1] : 'download';
    }

    function showToast(message, type) {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = 'toast toast-' + (type || 'info');
      toast.textContent = message;
      container.appendChild(toast);
      window.setTimeout(function () {
        toast.remove();
      }, 3000);
    }

    loadShareInfo();
  </script>
</body>
</html>
`;

// ============================================================================
// MAIN REQUEST HANDLER
// ============================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    
    // CORS headers for API requests
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };
    
    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    try {
      // API Routes
      if (path.startsWith('/api/')) {
        // Auth routes
        if (path === '/api/login' && method === 'POST') {
          return await handleLogin(request, env);
        }
        
        if (path === '/api/logout' && method === 'POST') {
          return await handleLogout();
        }
        
        if (path === '/api/auth/check') {
          return await handleCheckAuth(request, env);
        }

        if (path === '/api/cache/refresh' && method === 'POST') {
          return await handleRefreshDirectoryCache(request, env);
        }

        if (path === '/api/reader/progress' && method === 'GET') {
          return await handleGetReaderProgress(request, env);
        }

        if (path === '/api/reader/progress' && method === 'PUT') {
          return await handlePutReaderProgress(request, env);
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
        
        // File management routes
        if (path.startsWith('/api/files')) {
          const filePath = safeDecodePath(path.slice('/api/files'.length) || '/');
          
          if (method === 'GET') {
            return await handleListFiles(request, env, filePath);
          }
          if (method === 'POST') {
            return await handleUploadFile(request, env, filePath);
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
          return await handleDownloadFile(request, env, filePath);
        }
        
        // Preview route
        if (path.startsWith('/api/preview')) {
          const filePath = safeDecodePath(path.slice('/api/preview'.length));
          return await handlePreviewFile(request, env, filePath);
        }
        
        // Share routes
        if (path === '/api/share' && method === 'POST') {
          return await handleCreateShare(request, env);
        }
        
        if (path.match(/^\/api\/share\/[^/]+$/) && method === 'GET') {
          const shareId = path.split('/').pop();
          return await handleGetShareInfo(request, env, shareId);
        }
        
        if (path.match(/^\/api\/share\/[^/]+\/download$/) && method === 'POST') {
          const shareId = path.split('/')[3];
          return await handleShareDownload(request, env, shareId);
        }
        
        // Admin routes
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
  }
};
