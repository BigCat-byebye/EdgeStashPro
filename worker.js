/**
 * EdgeStashPro - Cloudflare-based Cloud Drive
 * 
 * A complete cloud storage solution built on Cloudflare Worker, R2, and KV.
 * 
 * Environment Variables (set in Cloudflare Dashboard):
 * - ADMIN_PASSWORD: Administrator password for login
 * 
 * Bindings (set in Cloudflare Dashboard):
 * - R2_BUCKET: R2 bucket binding for file storage
 * - KV_STORE: KV namespace binding for metadata storage
 * - D1_DB: D1 database binding for search, favorites, recent visits, shares, permissions, and file tasks
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

function base32Encode(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(value || '').toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  const bytes = [];
  let bits = 0;
  let buffer = 0;

  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) continue;
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return new Uint8Array(bytes);
}

function generateOtpSecret() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

async function generateTotp(secret, timeStep) {
  const keyBytes = base32Decode(secret);
  const counter = Math.floor((timeStep || Date.now()) / 30000);
  const counterBytes = new Uint8Array(8);
  let value = counter;
  for (let index = 7; index >= 0; index--) {
    counterBytes[index] = value & 255;
    value = Math.floor(value / 256);
  }

  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBytes));
  const offset = signature[signature.length - 1] & 15;
  const code = (
    ((signature[offset] & 127) << 24) |
    ((signature[offset + 1] & 255) << 16) |
    ((signature[offset + 2] & 255) << 8) |
    (signature[offset + 3] & 255)
  ) % 1000000;

  return String(code).padStart(6, '0');
}

async function verifyTotp(secret, token) {
  const normalized = String(token || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) return false;

  const now = Date.now();
  for (const offset of [-30000, 0, 30000]) {
    if (await generateTotp(secret, now + offset) === normalized) {
      return true;
    }
  }
  return false;
}

function createOtpUri(secret) {
  const issuer = 'EdgeStashPro';
  const label = `${issuer}:admin`;
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
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
  const slashPrefix = '/' + prefix;
  const prefixes = slashPrefix === prefix ? [prefix] : [prefix, slashPrefix];
  const folderMap = new Map();
  const fileMap = new Map();

  for (const listPrefix of prefixes) {
    let cursor;
    do {
      const listed = await env.R2_BUCKET.list({ prefix: listPrefix, delimiter: '/', cursor });

      if (listed.delimitedPrefixes) {
        for (const folderPath of listed.delimitedPrefixes) {
          const path = r2KeyToPath(folderPath.slice(0, -1));
          const name = folderPath.slice(listPrefix.length, -1);
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
          const name = obj.key.slice(listPrefix.length);
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
  }

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

function missingRequiredConfig(env, names) {
  return names.filter(name => {
    if (name === 'ADMIN_PASSWORD') return !env.ADMIN_PASSWORD;
    return !env[name];
  });
}

function requireRequiredConfig(env, names) {
  const missing = missingRequiredConfig(env, names);
  if (missing.length > 0) {
    throw new Error('缺少必要配置: ' + missing.join(', '));
  }
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
    requireRequiredConfig(env, ['ADMIN_PASSWORD', 'KV_STORE', 'D1_DB']);
    const body = await request.json();
    const { email, password, isAdmin, otp } = body;
    
    if (isAdmin) {
      // Admin login
      if (password === env.ADMIN_PASSWORD) {
        const otpSecret = await env.KV_STORE.get('admin:otp:secret');
        if (otpSecret) {
          if (!(await verifyTotp(otpSecret, otp))) {
            return jsonResponse({
              success: false,
              requiresOtp: true,
              message: otp ? 'OTP 验证码错误' : '请输入 OTP 验证码'
            }, 401);
          }
        } else {
          let pendingSecret = await env.KV_STORE.get('admin:otp:pending');
          if (!pendingSecret) {
            pendingSecret = generateOtpSecret();
            await env.KV_STORE.put('admin:otp:pending', pendingSecret, { expirationTtl: 600 });
          }

          if (!(await verifyTotp(pendingSecret, otp))) {
            return jsonResponse({
              success: false,
              requiresOtpSetup: true,
              otpSecret: pendingSecret,
              otpUri: createOtpUri(pendingSecret),
              message: otp ? 'OTP 验证码错误，请确认扫码后输入 6 位验证码' : '请先绑定管理员 OTP'
            }, 401);
          }

          await env.KV_STORE.put('admin:otp:secret', pendingSecret);
          await env.KV_STORE.delete('admin:otp:pending');
        }

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
    requireRequiredConfig(env, ['KV_STORE', 'R2_BUCKET', 'D1_DB']);
    const url = new URL(request.url);
    const forceRefresh = url.searchParams.get('refresh') === '1';
    const currentPath = normalizeDirectoryPath(path);
    const permissionError = await requirePathPermission(env, auth, 'view', currentPath);
    if (permissionError) {
      const virtualListing = await listVirtualPermissionDirectory(env, auth, currentPath);
      if (virtualListing) return jsonResponse(virtualListing);
      return permissionError;
    }

    if (currentPath !== '/') {
      await recordRecentVisit(env, auth, {
        path: currentPath,
        name: nameFromItemPath(currentPath),
        itemType: 'folder',
        sizeFormatted: '',
        previewType: ''
      });
    }
    let cached = null;
    if (!forceRefresh) {
      try {
        cached = await readDirectoryCache(env, currentPath);
      } catch (cacheError) {
        console.warn('KV directory cache read failed:', cacheError.message);
      }
    }

    if (cached) {
      const folders = await mergeSearchItemTags(env, await filterItemsByPermission(env, auth, cached.folders || [], 'view'));
      const files = await mergeSearchItemTags(env, await filterItemsByPermission(env, auth, cached.files || [], 'view'));
      return jsonResponse({
        ...cached,
        folders,
        files
      });
    }

    const fresh = await refreshDirectoryCache(env, currentPath);
    const folders = await mergeSearchItemTags(env, await filterItemsByPermission(env, auth, fresh.folders || [], 'view'));
    const files = await mergeSearchItemTags(env, await filterItemsByPermission(env, auth, fresh.files || [], 'view'));
    return jsonResponse({
      ...fresh,
      folders,
      files
    });
  } catch (e) {
    return jsonResponse({ success: false, message: '获取文件列表失败: ' + e.message }, 500);
  }
}

async function handleRefreshDirectoryCache(request, env) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    requireRequiredConfig(env, ['KV_STORE', 'R2_BUCKET', 'D1_DB']);
    const body = await request.json().catch(() => ({}));
    const currentPath = normalizeDirectoryPath(body.path || '/');
    const permissionError = await requirePathPermission(env, auth, 'view', currentPath);
    if (permissionError) {
      const virtualListing = await listVirtualPermissionDirectory(env, auth, currentPath);
      if (virtualListing) return jsonResponse(virtualListing);
      return permissionError;
    }

    const refreshed = await refreshDirectoryCache(env, currentPath);
    const folders = await mergeSearchItemTags(env, await filterItemsByPermission(env, auth, refreshed.folders || [], 'view'));
    const files = await mergeSearchItemTags(env, await filterItemsByPermission(env, auth, refreshed.files || [], 'view'));
    return jsonResponse({
      ...refreshed,
      folders,
      files
    });
  } catch (e) {
    return jsonResponse({ success: false, message: '刷新缓存失败: ' + e.message }, 500);
  }
}

async function handleUploadFile(request, env, path) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  
  try {
    const destinationPath = normalizeDirectoryPath(path || '/');
    const permissionError = await requirePathPermission(env, auth, 'upload', destinationPath);
    if (permissionError) return permissionError;

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
    if (!baseName) {
      return jsonResponse({ success: false, message: '文件名无效' }, 400);
    }

    const key = filePath + baseName;

    await env.R2_BUCKET.put(key, file.stream(), {
      httpMetadata: { contentType: file.type || getMimeType(baseName) }
    });

    await syncFileCacheIfParentCached(env, key, {
      size: file.size || 0,
      contentType: file.type || getMimeType(baseName),
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
    const permissionError = await requirePathPermission(env, auth, 'modify', path);
    if (permissionError) return permissionError;

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
    const resolvedOld = await getR2Object(env, oldKey);
    if (resolvedOld) {
      const oldObject = resolvedOld.object;
      // Copy to new location
      await env.R2_BUCKET.put(newKey, oldObject.body, {
        httpMetadata: oldObject.httpMetadata
      });

      // Delete old file
      await env.R2_BUCKET.delete(resolvedOld.key);
      await invalidateCachePath(env, r2KeyToPath(oldKey));
      await cleanupD1ItemPath(env, r2KeyToPath(oldKey));

      const newObject = await env.R2_BUCKET.head(newKey);
      await syncFileCacheIfParentCached(env, newKey, {
        size: newObject?.size || oldObject.size || 0,
        contentType: newObject?.httpMetadata?.contentType || oldObject.httpMetadata?.contentType || getMimeType(newName),
        lastModified: isoDateString(newObject?.uploaded || new Date())
      });

      return jsonResponse({ success: true, message: '重命名成功', newPath: '/' + newKey });
    }

    const oldPrefix = oldKey.endsWith('/') ? oldKey : oldKey + '/';
    const folderCheck = await listR2Prefix(env, oldPrefix, { limit: 1 });
    if (!folderCheck.objects || folderCheck.objects.length === 0) {
      return jsonResponse({ success: false, message: '文件不存在' }, 404);
    }

    const newPrefix = newKey.endsWith('/') ? newKey : newKey + '/';
    const batch = await listR2Prefix(env, oldPrefix);
    const oldKeys = [];

    if (batch.objects && batch.objects.length > 0) {
      for (const obj of batch.objects) {
        const relativeKey = obj.key.replace(/^\/+/, '').slice(oldPrefix.length);
        const targetKey = newPrefix + relativeKey;
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

    await invalidateCachePath(env, r2KeyToPath(oldKey));
    await cleanupD1ItemPath(env, r2KeyToPath(oldKey));
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

function r2KeyCandidates(key) {
  const normalized = String(key || '').replace(/^\/+/, '');
  if (!normalized) return [''];
  return [normalized, '/' + normalized];
}

async function headR2Object(env, key) {
  for (const candidate of r2KeyCandidates(key)) {
    const object = await env.R2_BUCKET.head(candidate);
    if (object) return { key: candidate, object };
  }
  return null;
}

async function getR2Object(env, key, options) {
  for (const candidate of r2KeyCandidates(key)) {
    const object = await env.R2_BUCKET.get(candidate, options);
    if (object) return { key: candidate, object };
  }
  return null;
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
      const listed = await env.R2_BUCKET.list({ ...options, prefix: listPrefix, cursor });
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
  const normalized = normalizeDirectoryPath(folderPath);
  if (normalized === '/') return true;

  const prefix = directoryPathToR2Prefix(normalized);
  const listed = await listR2Prefix(env, prefix, { limit: 1 });
  return !!(listed.objects && listed.objects.length > 0);
}

async function destinationExists(env, key, isFolder) {
  if (isFolder) {
    const listed = await listR2Prefix(env, key + '/', { limit: 1 });
    return !!(listed.objects && listed.objects.length > 0);
  }
  return !!(await headR2Object(env, key));
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

async function findAvailableDestinationKeyReserved(env, desiredKey, isFolder, reservedKeys) {
  const reserved = reservedKeys || new Set();
  if (!reserved.has(desiredKey) && !(await destinationExists(env, desiredKey, isFolder))) {
    reserved.add(desiredKey);
    return desiredKey;
  }

  const slashIndex = desiredKey.lastIndexOf('/');
  const parent = slashIndex >= 0 ? desiredKey.slice(0, slashIndex + 1) : '';
  const name = slashIndex >= 0 ? desiredKey.slice(slashIndex + 1) : desiredKey;

  for (let index = 1; index <= 999; index++) {
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
  if (resolved) await env.R2_BUCKET.delete(resolved.key);
  await invalidateCachePath(env, r2KeyToPath(key));
  await cleanupD1ItemPath(env, r2KeyToPath(key));
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

  const resolvedSource = await headR2Object(env, sourceKey);
  const sourceObject = resolvedSource?.object || null;
  const actualSourceKey = resolvedSource?.key || sourceKey;
  const sourcePrefix = sourceKey + '/';
  const folderCheck = sourceObject ? null : await listR2Prefix(env, sourcePrefix, { limit: 1 });
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
    await copyR2Object(env, actualSourceKey, targetKey);
    if (shouldMove) {
      await env.R2_BUCKET.delete(actualSourceKey);
    }
  }

  if (shouldMove) {
    await invalidateCachePath(env, normalizedSourcePath);
    await cleanupD1ItemPath(env, normalizedSourcePath);
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
const TASK_TYPES = new Set(['upload', 'download', 'batch_download', 'copy', 'move', 'delete']);

function taskRowToClient(row) {
  let result = null;
  if (row.result_json) {
    try {
      result = JSON.parse(row.result_json);
    } catch (error) {
      result = null;
    }
  }

  return {
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
  await ensureD1Schema(env);
  const row = await env.D1_DB.prepare(`
    SELECT * FROM file_tasks
    WHERE id = ? AND owner_key = ?
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
  await ensureD1Schema(env);
  const now = Date.now();
  const taskId = generateId(20);
  await env.D1_DB.prepare(`
    INSERT INTO file_tasks (
      id, owner_key, task_type, status, title, source_path, destination_path,
      total_bytes, processed_bytes, total_items, processed_items, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    taskId,
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
      const resolvedSource = await headR2Object(env, sourceKey);
      const sourceObject = resolvedSource?.object || null;
      const actualSourceKey = resolvedSource?.key || sourceKey;
      const sourcePrefix = sourceKey + '/';
      const folderCheck = sourceObject ? null : await listR2Prefix(env, sourcePrefix, { limit: 1 });
      const isFolder = !sourceObject && !!(folderCheck.objects && folderCheck.objects.length > 0);
      if (!sourceObject && !isFolder) throw new Error('项目不存在: ' + itemPath);

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
              size: obj.size || 0
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
          size: sourceObject.size || 0
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
      const resolvedSource = await headR2Object(env, sourceKey);
      const sourceObject = resolvedSource?.object || null;
      const actualSourceKey = resolvedSource?.key || sourceKey;
      const sourcePrefix = sourceKey + '/';
      const folderCheck = await listR2Prefix(env, sourcePrefix, { limit: 1 });
      const isFolder = !!(folderCheck.objects && folderCheck.objects.length > 0);
      if (!sourceObject && !isFolder) throw new Error('项目不存在: ' + itemPath);

      if (sourceObject && !reservedKeys.has(actualSourceKey)) {
        reservedKeys.add(actualSourceKey);
        taskItems.push({
          sourcePath: itemPath,
          sourceKey: actualSourceKey,
          targetPath: itemPath,
          targetKey: actualSourceKey,
          size: sourceObject.size || 0
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
              size: obj.size || 0
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
      task_id, source_path, source_key, target_path, target_key, size, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)
  `);

  for (let index = 0; index < taskItems.length; index += 50) {
    await env.D1_DB.batch(taskItems.slice(index, index + 50).map(item => insert.bind(
      taskId,
      item.sourcePath,
      item.sourceKey,
      item.targetPath,
      item.targetKey,
      item.size || 0,
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
    const type = body.type;
    if (!TASK_TYPES.has(type)) {
      return jsonResponse({ success: false, message: '不支持的任务类型' }, 400);
    }

    let taskId;
    if (type === 'upload') {
      const destinationPath = normalizeDirectoryPath(body.destinationPath || body.path || '/');
      const permissionError = await requirePathPermission(env, auth, 'upload', destinationPath);
      if (permissionError) return permissionError;
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
      const resolved = await headR2Object(env, itemPathToR2Key(filePath));
      if (!resolved) return jsonResponse({ success: false, message: '文件不存在' }, 404);
      const object = resolved.object;
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
    await ensureD1Schema(env);
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
          SELECT * FROM file_tasks
          WHERE owner_key = ? AND status IN ('queued', 'running')
          ORDER BY created_at DESC
          LIMIT ?
        `).bind(ownerKey, limit).all()
      : await env.D1_DB.prepare(`
          SELECT * FROM file_tasks
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
    } catch (error) {
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
    if (!['copy', 'move', 'delete'].includes(task.task_type)) {
      return jsonResponse({ success: false, message: '此任务不支持分片执行' }, 400);
    }
    if (!TASK_ACTIVE_STATUSES.has(task.status)) {
      return jsonResponse({ success: true, task: taskRowToClient(task), done: true });
    }

    await updateTaskStatus(env, taskId, 'running');
    const limit = Math.min(20, Math.max(1, Number(new URL(request.url).searchParams.get('limit') || 5) || 5));
    const rows = await env.D1_DB.prepare(`
      SELECT * FROM file_task_items
      WHERE task_id = ? AND status = 'queued'
      ORDER BY id ASC
      LIMIT ?
    `).bind(taskId, limit).all();

    const errors = [];
    for (const item of rows.results || []) {
      try {
        if (task.task_type === 'delete') {
          await env.R2_BUCKET.delete(item.source_key);
        } else {
          const copied = await copyR2Object(env, item.source_key, item.target_key);
          if (!copied) throw new Error('源对象不存在');
          if (task.task_type === 'move') {
            await env.R2_BUCKET.delete(item.source_key);
          }
        }
        await env.D1_DB.prepare(`
          UPDATE file_task_items
          SET status = 'succeeded', error_message = NULL, updated_at = ?
          WHERE id = ?
        `).bind(Date.now(), item.id).run();
      } catch (error) {
        await env.D1_DB.prepare(`
          UPDATE file_task_items
          SET status = 'failed', error_message = ?, updated_at = ?
          WHERE id = ?
        `).bind(error.message, Date.now(), item.id).run();
        errors.push({ path: item.source_path, message: error.message });
      }
    }

    const counts = await env.D1_DB.prepare(`
      SELECT
        SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        COUNT(*) AS total
      FROM file_task_items
      WHERE task_id = ?
    `).bind(taskId).first();

    const succeeded = Number(counts?.succeeded || 0);
    const failed = Number(counts?.failed || 0);
    const total = Number(counts?.total || 0);
    const done = succeeded + failed >= total;

    if (done) {
      const targetPath = task.destination_path || '/';
      if (task.task_type === 'move') {
        await cleanupMovedTaskSources(env, taskId);
      }
      if (task.task_type === 'delete') {
        await cleanupDeletedTaskSources(env, task);
      } else {
        await invalidateCachePath(env, targetPath);
      }
      if (task.task_type === 'move') {
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
    await invalidateCachePath(env, path);
    await cleanupD1ItemPath(env, path);
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
      await env.R2_BUCKET.delete(key + '/.folder').catch(() => null);
    }
    await invalidateCachePath(env, folder);
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
    await cleanupD1ItemPath(env, path);
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

    const resolvedFile = await headR2Object(env, key);
    if (resolvedFile) {
      const actualKey = resolvedFile.key;
      const fileObject = resolvedFile.object;
      if (usedKeys.has(actualKey)) continue;
      usedKeys.add(actualKey);
      addZipEntry(entries, usedNames, {
        name: nameFromItemPath(itemPath),
        key: actualKey,
        isDirectory: false,
        size: fileObject.size || 0,
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
      const listed = await listR2Prefix(env, prefix, { cursor });
      for (const obj of listed.objects || []) {
        foundFolderObject = true;
        const relativeName = obj.key.replace(/^\/+/, '').slice(prefix.length);
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
          size: obj.size || 0,
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
    const permissionAction = PERMISSION_COLUMNS[url.searchParams.get('permission') || 'view']
      ? (url.searchParams.get('permission') || 'view')
      : 'view';
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

    let folders = Array.from(folderPaths)
      .filter(path => {
        if (!query) return true;
        return path.toLowerCase().includes(query) || nameFromItemPath(path).toLowerCase().includes(query);
      })
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
      .map(path => ({
        path,
        name: path === '/' ? '根目录' : nameFromItemPath(path)
      }));

    folders = (await filterItemsByPermission(env, auth, folders, permissionAction)).slice(0, limit);

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
    
    const normalizedFolderPath = normalizeDirectoryPath(folderPath);
    const parentPath = parentPathFromItemPath(normalizedFolderPath);
    const permissionError = await requirePathPermission(env, auth, 'upload', parentPath);
    if (permissionError) return permissionError;

    folderPath = normalizedFolderPath;
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
    const itemPath = r2KeyToPath(key);
    const permissionError = await requirePathPermission(env, auth, 'download', itemPath);
    if (permissionError) return permissionError;
    
    const resolved = await getR2Object(env, key);
    if (!resolved) {
      return jsonResponse({ success: false, message: '文件不存在' }, 404);
    }
    const object = resolved.object;
    
    const filename = nameFromItemPath(itemPath);
    await recordRecentVisit(env, auth, {
      path: itemPath,
      name: filename,
      itemType: 'file',
      sizeFormatted: formatFileSize(object.size || 0),
      previewType: getPreviewType(filename) || ''
    });
    
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
    const itemPath = r2KeyToPath(key);
    const permissionError = await requirePathPermission(env, auth, 'preview', itemPath);
    if (permissionError) return permissionError;
    
    const resolved = await getR2Object(env, key, {
      range: request.headers
    });
    if (!resolved) {
      return jsonResponse({ success: false, message: '文件不存在' }, 404);
    }
    const object = resolved.object;
    
    const filename = nameFromItemPath(itemPath);
    const contentType = object.httpMetadata?.contentType || getMimeType(filename);
    await recordRecentVisit(env, auth, {
      path: itemPath,
      name: filename,
      itemType: 'file',
      sizeFormatted: formatFileSize(object.size || 0),
      previewType: getPreviewType(filename) || ''
    });
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

    const permissionError = await requirePathPermission(env, auth, 'preview', filePath);
    if (permissionError) return permissionError;

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

    const permissionError = await requirePathPermission(env, auth, 'preview', filePath);
    if (permissionError) return permissionError;

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

function readerBookmarkToClient(row) {
  return {
    id: row.id,
    path: row.path,
    charOffset: Number(row.char_offset || 0),
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
  return permissionError ? { error: permissionError } : { filePath };
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
        SELECT id, path, char_offset, progress, snippet, created_at
        FROM reader_bookmarks
        WHERE owner_key = ? AND path = ?
        ORDER BY created_at DESC
        LIMIT 200
      `).bind(ownerKey, checked.filePath).all();
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
      const progress = normalizeReaderNumber(body.progress, 0, 0, 1);
      const snippet = String(body.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      const duplicate = await env.D1_DB.prepare(`
        SELECT id FROM reader_bookmarks
        WHERE owner_key = ? AND path = ? AND ABS(char_offset - ?) <= 2
        LIMIT 1
      `).bind(ownerKey, checked.filePath, charOffset).first();
      if (duplicate) {
        return jsonResponse({ success: false, message: '当前位置已经有书签' }, 409);
      }
      const bookmark = {
        id: generateId(20),
        path: checked.filePath,
        charOffset,
        progress,
        snippet,
        createdAt: Date.now()
      };
      await env.D1_DB.prepare(`
        INSERT INTO reader_bookmarks (id, owner_key, path, char_offset, progress, snippet, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        bookmark.id,
        ownerKey,
        bookmark.path,
        bookmark.charOffset,
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
    await ensureD1Schema(env);
    await env.D1_DB.prepare('DELETE FROM reader_bookmarks WHERE id = ? AND owner_key = ?')
      .bind(bookmarkId, ownerKeyFromAuth(auth)).run();
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
    await ensureD1Schema(env);
    await env.D1_DB.prepare('DELETE FROM reader_bookmarks WHERE owner_key = ?')
      .bind(`user:${email}`).run();
  }
}

function shareRowToClient(row) {
  return {
    shareId: row.share_id,
    filePath: row.file_path,
    fileName: row.file_name,
    fileSize: row.file_size || 0,
    passwordHash: row.password_hash || null,
    expiresAt: row.expires_at ?? null,
    viewCount: row.view_count || 0,
    downloadCount: row.download_count || 0,
    createdAt: row.created_at || 0
  };
}

function shareItemRowToClient(row) {
  return {
    path: normalizeItemPath(row.item_path),
    name: row.item_name || nameFromItemPath(row.item_path),
    itemType: row.item_type === 'folder' ? 'folder' : 'file',
    sortOrder: row.sort_order || 0
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

  const key = itemPathToR2Key(path);
  const resolved = await headR2Object(env, key);
  if (resolved) {
    const object = resolved.object;
    return {
      path,
      name: nameFromItemPath(path),
      itemType: 'file',
      size: object.size || 0,
      lastModified: isoDateString(object.uploaded),
      previewType: getPreviewType(nameFromItemPath(path))
    };
  }

  const folderCheck = await listR2Prefix(env, key + '/', { limit: 1 });
  if (folderCheck.objects && folderCheck.objects.length > 0) {
    return {
      path,
      name: nameFromItemPath(path),
      itemType: 'folder',
      size: 0,
      lastModified: null,
      previewType: null
    };
  }

  throw new Error('项目不存在: ' + path);
}

async function upsertD1Share(env, share) {
  await ensureD1Schema(env);
  await env.D1_DB.prepare(`
    INSERT INTO share_links (
      share_id, file_path, file_name, file_size, password_hash, expires_at, view_count, download_count, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(share_id) DO NOTHING
  `).bind(
    share.shareId,
    share.filePath,
    share.fileName,
    share.fileSize || 0,
    share.passwordHash || null,
    share.expiresAt ?? null,
    share.viewCount || 0,
    share.downloadCount || 0,
    share.createdAt || Date.now()
  ).run();

  if (Array.isArray(share.items) && share.items.length > 0) {
    const insertItem = env.D1_DB.prepare(`
      INSERT OR IGNORE INTO share_items (
        share_id, item_path, item_name, item_type, sort_order, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    await env.D1_DB.batch(share.items.map((item, index) => insertItem.bind(
      share.shareId,
      normalizeItemPath(item.path),
      item.name || nameFromItemPath(item.path),
      item.itemType === 'folder' ? 'folder' : 'file',
      Number.isFinite(item.sortOrder) ? item.sortOrder : index,
      share.createdAt || Date.now()
    )));
  }
}

async function getD1ShareItems(env, share) {
  const rows = await env.D1_DB.prepare(`
    SELECT * FROM share_items
    WHERE share_id = ?
    ORDER BY sort_order ASC, item_name ASC
  `).bind(share.shareId).all();

  const items = (rows.results || []).map(shareItemRowToClient);
  if (items.length > 0) return items;

  const fallbackPath = r2KeyToPath(share.filePath || '');
  if (!fallbackPath || fallbackPath === '/') return [];
  const fallbackItem = {
    path: fallbackPath,
    name: share.fileName || nameFromItemPath(fallbackPath),
    itemType: 'file',
    sortOrder: 0
  };

  await env.D1_DB.prepare(`
    INSERT OR IGNORE INTO share_items (
      share_id, item_path, item_name, item_type, sort_order, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    share.shareId,
    fallbackItem.path,
    fallbackItem.name,
    fallbackItem.itemType,
    0,
    share.createdAt || Date.now()
  ).run();

  return [fallbackItem];
}

async function getD1Share(env, shareId) {
  await ensureD1Schema(env);
  const row = await env.D1_DB.prepare('SELECT * FROM share_links WHERE share_id = ?').bind(shareId).first();
  if (row) {
    const share = shareRowToClient(row);
    share.items = await getD1ShareItems(env, share);
    return share;
  }

  const legacyData = await env.KV_STORE.get(`share:${shareId}`);
  if (!legacyData) return null;

  const legacyShare = JSON.parse(legacyData);
  legacyShare.items = [{
    path: r2KeyToPath(legacyShare.filePath || ''),
    name: legacyShare.fileName || nameFromItemPath(legacyShare.filePath || ''),
    itemType: 'file'
  }];
  await upsertD1Share(env, legacyShare);
  legacyShare.items = await getD1ShareItems(env, legacyShare);
  return legacyShare;
}

async function migrateLegacySharesToD1(env) {
  await ensureD1Schema(env);
  const marker = await env.D1_DB.prepare('SELECT value FROM app_stats WHERE key = ?')
    .bind('legacySharesMigrated')
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
    INSERT INTO app_stats (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).bind('legacySharesMigrated', 1, Date.now()).run();
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
    const row = await env.D1_DB.prepare('SELECT COUNT(*) AS value FROM share_links').first();
    aggregate = Number(row?.value || 0);
  } else if (key === 'totalViews') {
    const row = await env.D1_DB.prepare('SELECT COALESCE(SUM(view_count), 0) AS value FROM share_links').first();
    aggregate = Number(row?.value || 0);
  } else if (key === 'totalDownloads') {
    const row = await env.D1_DB.prepare('SELECT COALESCE(SUM(download_count), 0) AS value FROM share_links').first();
    aggregate = Number(row?.value || 0);
  }

  return Math.max(legacy ?? 0, aggregate);
}

async function ensureD1Stat(env, key) {
  await ensureD1Schema(env);
  const existing = await env.D1_DB.prepare('SELECT value FROM app_stats WHERE key = ?').bind(key).first();
  if (existing) return Number(existing.value || 0);

  const value = await calculateD1StatFallback(env, key);
  await env.D1_DB.prepare(`
    INSERT OR IGNORE INTO app_stats (key, value, updated_at)
    VALUES (?, ?, ?)
  `).bind(key, value, Date.now()).run();

  const row = await env.D1_DB.prepare('SELECT value FROM app_stats WHERE key = ?').bind(key).first();
  return Number(row?.value || value);
}

async function changeD1Stat(env, key, delta) {
  await ensureD1Stat(env, key);
  await env.D1_DB.prepare(`
    UPDATE app_stats
    SET value = MAX(0, value + ?), updated_at = ?
    WHERE key = ?
  `).bind(delta, Date.now(), key).run();
}

async function reconcileD1StatsMinimums(env) {
  await ensureD1Schema(env);
  const totals = {
    totalShares: Number((await env.D1_DB.prepare('SELECT COUNT(*) AS value FROM share_links').first())?.value || 0),
    totalViews: Number((await env.D1_DB.prepare('SELECT COALESCE(SUM(view_count), 0) AS value FROM share_links').first())?.value || 0),
    totalDownloads: Number((await env.D1_DB.prepare('SELECT COALESCE(SUM(download_count), 0) AS value FROM share_links').first())?.value || 0)
  };

  for (const [key, value] of Object.entries(totals)) {
    const existing = await env.D1_DB.prepare('SELECT value FROM app_stats WHERE key = ?').bind(key).first();
    if (!existing) continue;
    await env.D1_DB.prepare(`
      UPDATE app_stats
      SET value = MAX(value, ?), updated_at = ?
      WHERE key = ?
    `).bind(value, Date.now(), key).run();
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

async function buildShareRootListing(env, share) {
  const files = [];
  const folders = [];

  for (const item of share.items || []) {
    if (item.itemType === 'folder') {
      if (await folderExists(env, item.path)) {
        folders.push({
          name: item.name,
          path: normalizeItemPath(item.path)
        });
      }
      continue;
    }

    const resolved = await headR2Object(env, itemPathToR2Key(item.path));
    if (!resolved) continue;
    const object = resolved.object;
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

async function handleGetShareInfo(request, env, shareId) {
  try {
    const share = await getD1Share(env, shareId);
    if (!share) {
      return jsonResponse({ success: false, message: '分享链接不存在' }, 404);
    }
    
    // Check expiration
    if (share.expiresAt && Date.now() > share.expiresAt) {
      return jsonResponse({ success: false, message: '分享链接已过期' }, 410);
    }
    
    await env.D1_DB.prepare(`
      UPDATE share_links
      SET view_count = view_count + 1
      WHERE share_id = ?
    `).bind(shareId).run();
    await changeD1Stat(env, 'totalViews', 1);

    const itemCount = (share.items || []).length || 1;
    const firstItem = (share.items || [])[0] || null;
    
    return jsonResponse({
      success: true,
      fileName: share.fileName,
      fileSize: share.fileSize,
      fileSizeFormatted: itemCount === 1 && firstItem?.itemType === 'folder' ? '文件夹' : formatFileSize(share.fileSize),
      itemCount,
      requiresPassword: !!share.passwordHash,
      expiresAt: share.expiresAt
    });
  } catch (e) {
    return jsonResponse({ success: false, message: '获取分享信息失败: ' + e.message }, 500);
  }
}

async function handleShareList(request, env, shareId) {
  try {
    const share = await getD1Share(env, shareId);
    if (!share) {
      return jsonResponse({ success: false, message: '分享链接不存在' }, 404);
    }

    if (share.expiresAt && Date.now() > share.expiresAt) {
      return jsonResponse({ success: false, message: '分享链接已过期' }, 410);
    }

    const body = await readShareRequestBody(request);
    const passwordError = await validateSharePassword(share, body);
    if (passwordError) return passwordError;

    const currentPath = normalizeDirectoryPath(body.path || '/');
    if (currentPath === '/') {
      return jsonResponse(await buildShareRootListing(env, share));
    }

    const sharedFolder = findSharedFolderForPath(share, currentPath);
    if (!sharedFolder) {
      return jsonResponse({ success: false, message: '无权访问该路径' }, 403);
    }

    if (!(await folderExists(env, currentPath))) {
      return jsonResponse({ success: false, message: '文件夹不存在' }, 404);
    }

    const listing = await listDirectoryFromR2(env, currentPath);
    return jsonResponse({
      success: true,
      currentPath,
      files: listing.files,
      folders: listing.folders
    });
  } catch (e) {
    return jsonResponse({ success: false, message: '获取分享目录失败: ' + e.message }, 500);
  }
}

async function handleShareDownload(request, env, shareId) {
  try {
    const share = await getD1Share(env, shareId);
    if (!share) {
      return jsonResponse({ success: false, message: '分享链接不存在' }, 404);
    }
    
    // Check expiration
    if (share.expiresAt && Date.now() > share.expiresAt) {
      return jsonResponse({ success: false, message: '分享链接已过期' }, 410);
    }
    
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

    if (!isDownloadPathAllowedByShare(share, targetPath)) {
      return jsonResponse({ success: false, message: '无权下载该文件' }, 403);
    }
    
    // Get file from R2
    const filename = nameFromItemPath(targetPath);
    const resolved = await getR2Object(env, itemPathToR2Key(targetPath));
    if (!resolved) {
      return jsonResponse({ success: false, message: '文件不存在' }, 404);
    }
    const object = resolved.object;
    
    await env.D1_DB.prepare(`
      UPDATE share_links
      SET download_count = download_count + 1
      WHERE share_id = ?
    `).bind(shareId).run();
    await changeD1Stat(env, 'totalDownloads', 1);
    
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
      ORDER BY created_at DESC
      LIMIT 1000
    `).all();
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
      env.D1_DB.prepare('DELETE FROM share_items WHERE share_id = ?').bind(shareId),
      env.D1_DB.prepare('DELETE FROM share_links WHERE share_id = ?').bind(shareId)
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
    await ensureD1Schema(env);
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

async function handleAdminSearchResources(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  try {
    await ensureD1Schema(env);
    const url = new URL(request.url);
    const query = (url.searchParams.get('q') || '').trim().toLowerCase();
    const type = url.searchParams.get('type') || 'all';
    const requestedLimit = Number(url.searchParams.get('limit') || 50);
    const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit)) : 50;

    const clauses = [];
    const params = [];
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

    const items = (rows.results || []).map(d1RowToClientItem);
    if ((!query || '/'.includes(query)) && type !== 'file' && !items.some(item => item.path === '/')) {
      items.unshift({
        path: '/',
        name: '根目录',
        itemType: 'folder',
        isFolder: true,
        sizeFormatted: '',
        previewType: '',
        parentPath: '/'
      });
    }

    return jsonResponse({ success: true, items: items.slice(0, limit) });
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
    let listing = await readDirectoryCache(env, currentPath).catch(() => null);
    if (!listing) listing = await refreshDirectoryCache(env, currentPath);
    return jsonResponse({
      success: true,
      currentPath,
      items: [
        ...(listing.folders || []).map(folder => ({ ...folder, itemType: 'folder', isFolder: true })),
        ...(listing.files || []).map(file => ({ ...file, itemType: 'file', isFolder: false }))
      ]
    });
  } catch (e) {
    return jsonResponse({ success: false, message: '读取资源列表失败: ' + e.message }, 500);
  }
}

async function handleAdminStorageDebug(request, env) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  try {
    requireRequiredConfig(env, ['KV_STORE', 'R2_BUCKET', 'D1_DB']);
    const url = new URL(request.url);
    const currentPath = normalizeDirectoryPath(url.searchParams.get('path') || '/');
    const prefix = directoryPathToR2Prefix(currentPath);
    const slashPrefix = '/' + prefix;
    const cached = await readDirectoryCache(env, currentPath).catch(error => ({
      error: error.message
    }));
    const directoryListing = await env.R2_BUCKET.list({ prefix, delimiter: '/', limit: 20 });
    const slashDirectoryListing = slashPrefix === prefix
      ? null
      : await env.R2_BUCKET.list({ prefix: slashPrefix, delimiter: '/', limit: 20 });
    const rawListing = await env.R2_BUCKET.list({ limit: 20 });
    const d1Count = await env.D1_DB.prepare('SELECT COUNT(*) AS count FROM search_items').first().catch(error => ({
      error: error.message
    }));

    return jsonResponse({
      success: true,
      path: currentPath,
      prefix,
      slashPrefix,
      cache: cached
        ? {
            error: cached.error || null,
            cached: cached.cached === true,
            files: Array.isArray(cached.files) ? cached.files.length : 0,
            folders: Array.isArray(cached.folders) ? cached.folders.length : 0,
            refreshedAt: cached.refreshedAt || null
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

// ============================================================================
// D1 SEARCH, FAVORITES, AND RECENT VISITS
// ============================================================================

let d1SchemaReady = false;
const D1_SCHEMA_KV_KEY = 'd1:schema:v1';
const D1_SCHEMA_TAGS_KV_KEY = 'd1:schema:v2-tags';

async function ensureD1Schema(env) {
  if (!env.D1_DB) throw new Error('D1_DB binding 未配置');
  if (d1SchemaReady) return;

  const kvReady = env.KV_STORE ? await env.KV_STORE.get(D1_SCHEMA_KV_KEY) : null;
  const ddlStatements = [
    `CREATE TABLE IF NOT EXISTS search_items (
      path TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      item_type TEXT NOT NULL,
      parent_path TEXT NOT NULL,
      size INTEGER DEFAULT 0,
      size_formatted TEXT,
      preview_type TEXT,
      last_modified TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      indexed_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_search_items_type ON search_items(item_type)',
    'CREATE INDEX IF NOT EXISTS idx_search_items_parent ON search_items(parent_path)',
    'CREATE INDEX IF NOT EXISTS idx_search_items_name ON search_items(name)',
    `CREATE TABLE IF NOT EXISTS favorites (
      owner_key TEXT NOT NULL,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      item_type TEXT NOT NULL,
      size_formatted TEXT,
      preview_type TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner_key, path)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_favorites_owner_updated ON favorites(owner_key, updated_at DESC)',
    `CREATE TABLE IF NOT EXISTS recent_items (
      owner_key TEXT NOT NULL,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      item_type TEXT NOT NULL,
      size_formatted TEXT,
      preview_type TEXT,
      visited_at INTEGER NOT NULL,
      PRIMARY KEY (owner_key, path)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_recent_items_owner_visited ON recent_items(owner_key, visited_at DESC)',
    `CREATE TABLE IF NOT EXISTS share_links (
      share_id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      password_hash TEXT,
      expires_at INTEGER,
      view_count INTEGER NOT NULL DEFAULT 0,
      download_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_share_links_created ON share_links(created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_share_links_expires ON share_links(expires_at)',
    `CREATE TABLE IF NOT EXISTS share_items (
      share_id TEXT NOT NULL,
      item_path TEXT NOT NULL,
      item_name TEXT NOT NULL,
      item_type TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (share_id, item_path)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_share_items_share_order ON share_items(share_id, sort_order)',
    `CREATE TABLE IF NOT EXISTS app_stats (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS reader_bookmarks (
      id TEXT PRIMARY KEY,
      owner_key TEXT NOT NULL,
      path TEXT NOT NULL,
      char_offset INTEGER NOT NULL DEFAULT 0,
      progress REAL NOT NULL DEFAULT 0,
      snippet TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_reader_bookmarks_owner_path_created ON reader_bookmarks(owner_key, path, created_at DESC)',
    ...USER_PERMISSIONS_DDL,
    ...FILE_TASKS_DDL
  ];

  for (const statement of ddlStatements) {
    await env.D1_DB.prepare(statement).run();
  }

  const tagsReady = env.KV_STORE ? await env.KV_STORE.get(D1_SCHEMA_TAGS_KV_KEY) : null;
  if (!tagsReady) {
    const tableInfo = await env.D1_DB.prepare('PRAGMA table_info(search_items)').all();
    const hasTags = (tableInfo.results || []).some(row => row.name === 'tags');
    if (!hasTags) {
      await env.D1_DB.prepare("ALTER TABLE search_items ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'").run();
    }
    if (env.KV_STORE) await env.KV_STORE.put(D1_SCHEMA_TAGS_KV_KEY, '1');
  }

  if (!kvReady && env.KV_STORE) await env.KV_STORE.put(D1_SCHEMA_KV_KEY, '1');
  d1SchemaReady = true;
}

const USER_PERMISSIONS_DDL = [
  `CREATE TABLE IF NOT EXISTS user_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    path TEXT NOT NULL,
    item_type TEXT NOT NULL,
    can_view INTEGER NOT NULL DEFAULT 0,
    can_preview INTEGER NOT NULL DEFAULT 0,
    can_download INTEGER NOT NULL DEFAULT 0,
    can_upload INTEGER NOT NULL DEFAULT 0,
    can_modify INTEGER NOT NULL DEFAULT 0,
    can_delete INTEGER NOT NULL DEFAULT 0,
    can_share INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(email, path, item_type)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_user_permissions_email_path ON user_permissions(email, path)',
  'CREATE INDEX IF NOT EXISTS idx_user_permissions_email_updated ON user_permissions(email, updated_at DESC)'
];

const FILE_TASKS_DDL = [
  `CREATE TABLE IF NOT EXISTS file_tasks (
    id TEXT PRIMARY KEY,
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
  'CREATE INDEX IF NOT EXISTS idx_file_tasks_owner_status ON file_tasks(owner_key, status, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_file_tasks_owner_updated ON file_tasks(owner_key, updated_at DESC)',
  `CREATE TABLE IF NOT EXISTS file_task_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    source_path TEXT NOT NULL,
    source_key TEXT NOT NULL,
    target_path TEXT NOT NULL,
    target_key TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'queued',
    error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_file_task_items_task_status ON file_task_items(task_id, status, id)'
];

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
  await ensureD1Schema(env);
  const normalized = Array.isArray(permissions) ? permissions.map(normalizeUserPermissionEntry) : [];
  await env.D1_DB.prepare('DELETE FROM user_permissions WHERE email = ?').bind(email).run();
  if (normalized.length === 0) return;

  const now = Date.now();
  const insert = env.D1_DB.prepare(`
    INSERT INTO user_permissions (
      email, path, item_type, can_view, can_preview, can_download, can_upload, can_modify, can_delete, can_share, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email, path, item_type) DO UPDATE SET
      can_view = excluded.can_view,
      can_preview = excluded.can_preview,
      can_download = excluded.can_download,
      can_upload = excluded.can_upload,
      can_modify = excluded.can_modify,
      can_delete = excluded.can_delete,
      can_share = excluded.can_share,
      updated_at = excluded.updated_at
  `);

  for (let index = 0; index < normalized.length; index += 50) {
    const batch = normalized.slice(index, index + 50).map(item => insert.bind(
      email,
      item.path,
      item.itemType,
      item.permissions.view ? 1 : 0,
      item.permissions.preview ? 1 : 0,
      item.permissions.download ? 1 : 0,
      item.permissions.upload ? 1 : 0,
      item.permissions.modify ? 1 : 0,
      item.permissions.delete ? 1 : 0,
      item.permissions.share ? 1 : 0,
      now,
      now
    ));
    await env.D1_DB.batch(batch);
  }
}

async function getUserPermissionRows(env, email) {
  await ensureD1Schema(env);
  const rows = await env.D1_DB.prepare(`
    SELECT * FROM user_permissions
    WHERE email = ?
    ORDER BY path = '/' DESC, length(path) ASC, path COLLATE NOCASE ASC
  `).bind(email).all();
  return rows.results || [];
}

async function findUserPermissionForPath(env, email, path) {
  await ensureD1Schema(env);
  const normalized = normalizeItemPath(path);
  return await env.D1_DB.prepare(`
    SELECT * FROM user_permissions
    WHERE email = ?
      AND (
        path = ?
        OR (item_type = 'folder' AND path = '/')
        OR (item_type = 'folder' AND ? LIKE path || '/%')
      )
    ORDER BY length(path) DESC
    LIMIT 1
  `).bind(email, normalized, normalized).first();
}

async function hasPathPermission(env, auth, action, path) {
  if (auth && auth.role === 'admin') return true;
  if (!auth || !auth.email) return false;
  const column = PERMISSION_COLUMNS[action];
  if (!column) throw new Error('未知权限类型: ' + action);
  const row = await findUserPermissionForPath(env, auth.email, path);
  return !!(row && row[column]);
}

async function requirePathPermission(env, auth, action, path) {
  if (await hasPathPermission(env, auth, action, path)) return null;
  return jsonResponse({
    success: false,
    message: '没有' + (PERMISSION_LABELS[action] || action) + '权限: ' + normalizeItemPath(path)
  }, 403);
}

async function filterItemsByPermission(env, auth, items, action = 'view') {
  if (!Array.isArray(items) || auth?.role === 'admin') return items || [];
  const allowed = [];
  for (const item of items) {
    if (await hasPathPermission(env, auth, action, item.path)) allowed.push(item);
  }
  return allowed;
}

async function mergeSearchItemTags(env, items) {
  if (!env.D1_DB || !Array.isArray(items) || items.length === 0) return items || [];
  await ensureD1Schema(env);
  const tagMap = new Map();
  const paths = items.map(item => normalizeItemPath(item.path || '')).filter(path => path && path !== '/');
  for (let index = 0; index < paths.length; index += 50) {
    const chunk = paths.slice(index, index + 50);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await env.D1_DB.prepare(`SELECT path, tags FROM search_items WHERE path IN (${placeholders})`).bind(...chunk).all();
    for (const row of rows.results || []) {
      try {
        const tags = JSON.parse(row.tags || '[]');
        tagMap.set(row.path, Array.isArray(tags) ? tags.filter(tag => typeof tag === 'string') : []);
      } catch (error) {
        tagMap.set(row.path, []);
      }
    }
  }
  return items.map(item => ({ ...item, tags: tagMap.get(item.path) || [] }));
}

async function listVirtualPermissionDirectory(env, auth, dirPath) {
  if (!auth || auth.role === 'admin' || !auth.email) return null;
  const currentPath = normalizeDirectoryPath(dirPath);
  const rows = await getUserPermissionRows(env, auth.email);
  const itemMap = new Map();

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
    const existing = itemMap.get(childPath);
    if (existing && existing.itemType === 'folder') continue;

    itemMap.set(childPath, {
      path: childPath,
      name: nameFromItemPath(childPath),
      itemType,
      isFolder: itemType === 'folder',
      sizeFormatted: '',
      previewType: ''
    });
  }

  const items = Array.from(itemMap.values()).sort((a, b) => {
    if (a.itemType !== b.itemType) return a.itemType === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });

  if (items.length === 0) return null;
  return {
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
  } catch (error) {
    tags = [];
  }
  return {
    path: row.path,
    name: row.name,
    itemType: row.item_type,
    isFolder: row.item_type === 'folder',
    size: row.size || 0,
    sizeFormatted: row.size_formatted || '',
    previewType: row.preview_type || '',
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

async function handleListTags(request, env) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    await ensureD1Schema(env);
    const rows = await env.D1_DB.prepare("SELECT path, tags FROM search_items WHERE tags IS NOT NULL AND tags != '[]'").all();
    const counts = new Map();
    for (const row of rows.results || []) {
      if (!(await hasPathPermission(env, auth, 'view', row.path))) continue;
      let tags = [];
      try {
        const parsed = JSON.parse(row.tags || '[]');
        if (Array.isArray(parsed)) tags = parsed;
      } catch (error) {
        tags = [];
      }
      for (const tag of tags) {
        if (typeof tag !== 'string' || !tag) continue;
        counts.set(tag, (counts.get(tag) || 0) + 1);
      }
    }
    const tags = Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hans-CN'));
    return jsonResponse({ success: true, tags });
  } catch (e) {
    return jsonResponse({ success: false, message: '读取标签失败: ' + e.message }, 500);
  }
}

async function handleUpdateTags(request, env) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    await ensureD1Schema(env);
    const url = new URL(request.url);
    const path = normalizeItemPath(url.searchParams.get('path') || '');
    if (!path || path === '/') return jsonResponse({ success: false, message: '请提供有效路径' }, 400);
    const permissionError = await requirePathPermission(env, auth, 'modify', path);
    if (permissionError) return permissionError;

    const body = await request.json().catch(() => ({}));
    const tags = normalizeTags(body.tags || []);
    const existing = await env.D1_DB.prepare('SELECT * FROM search_items WHERE path = ?').bind(path).first();
    const now = Date.now();
    const bodyItemType = body.itemType || body.item_type || (body.isFolder ? 'folder' : '');
    const itemType = existing?.item_type || (['file', 'folder'].includes(bodyItemType) ? bodyItemType : 'file');
    const parentPath = existing?.parent_path || parentPathFromItemPath(path);
    await env.D1_DB.prepare(`
      INSERT INTO search_items (
        path, name, item_type, parent_path, size, size_formatted, preview_type, last_modified, tags, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        tags = excluded.tags,
        indexed_at = CASE WHEN search_items.indexed_at IS NULL OR search_items.indexed_at = 0 THEN excluded.indexed_at ELSE search_items.indexed_at END
    `).bind(
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
    return jsonResponse({ success: true, path, tags });
  } catch (e) {
    return jsonResponse({ success: false, message: '保存标签失败: ' + e.message }, 500);
  }
}

async function cleanupD1ItemPath(env, path) {
  if (!env.D1_DB) return;

  try {
    await ensureD1Schema(env);
    const normalized = normalizeItemPath(path);
    if (!normalized || normalized === '/') return;
    const childPattern = escapeLike(normalized) + '/%';
    const statements = [
      env.D1_DB.prepare("DELETE FROM search_items WHERE path = ? OR path LIKE ? ESCAPE '\\'").bind(normalized, childPattern),
      env.D1_DB.prepare("DELETE FROM favorites WHERE path = ? OR path LIKE ? ESCAPE '\\'").bind(normalized, childPattern),
      env.D1_DB.prepare("DELETE FROM recent_items WHERE path = ? OR path LIKE ? ESCAPE '\\'").bind(normalized, childPattern),
      env.D1_DB.prepare("DELETE FROM reader_bookmarks WHERE path = ? OR path LIKE ? ESCAPE '\\'").bind(normalized, childPattern)
    ];
    await env.D1_DB.batch(statements);
  } catch (e) {
    console.warn('D1 item reference cleanup failed:', e.message);
  }
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
      indexed_at: indexedAt
    });
  }
}

function addFolderSearchRowsFromR2Key(folderRows, key, indexedAt) {
  const parts = (key || '').split('/').filter(Boolean);
  const folderParts = parts.slice(0, -1);
  for (let index = 0; index < folderParts.length; index++) {
    addFolderSearchRows(folderRows, '/' + folderParts.slice(0, index + 1).join('/'), indexedAt);
  }
}

async function rebuildSearchIndex(env) {
  requireRequiredConfig(env, ['R2_BUCKET', 'D1_DB']);
  await ensureD1Schema(env);

  const indexedAt = Date.now();
  const folderRows = new Map();
  const fileRows = new Map();
  let cursor;
  let scanned = 0;

  do {
    const listed = await env.R2_BUCKET.list({ cursor, limit: 1000 });
    for (const obj of listed.objects || []) {
      scanned++;
      addFolderSearchRowsFromR2Key(folderRows, obj.key, indexedAt);
      if (obj.key.endsWith('/.folder') || obj.key === '.folder') continue;

      const path = r2KeyToPath(obj.key);
      const name = nameFromItemPath(path);
      if (!name) continue;

      fileRows.set(path, {
        path,
        name,
        item_type: 'file',
        parent_path: parentPathFromItemPath(path),
        size: obj.size || 0,
        size_formatted: formatFileSize(obj.size || 0),
        preview_type: getPreviewType(name) || '',
        last_modified: isoDateString(obj.uploaded),
        indexed_at: indexedAt
      });
    }
    cursor = listed.truncated ? listed.cursor : null;
  } while (cursor);

  const rows = [...folderRows.values(), ...fileRows.values()];
  const upsert = env.D1_DB.prepare(`
    INSERT INTO search_items (
      path, name, item_type, parent_path, size, size_formatted, preview_type, last_modified, indexed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      name = excluded.name,
      item_type = excluded.item_type,
      parent_path = excluded.parent_path,
      size = excluded.size,
      size_formatted = excluded.size_formatted,
      preview_type = excluded.preview_type,
      last_modified = excluded.last_modified,
      indexed_at = excluded.indexed_at
  `);

  for (let index = 0; index < rows.length; index += 50) {
    const batch = rows.slice(index, index + 50).map(item => upsert.bind(
      item.path,
      item.name,
      item.item_type,
      item.parent_path,
      item.size,
      item.size_formatted,
      item.preview_type,
      item.last_modified,
      item.indexed_at
    ));
    if (batch.length > 0) {
      await env.D1_DB.batch(batch);
    }
  }

  await env.D1_DB.prepare('DELETE FROM search_items WHERE indexed_at != ?').bind(indexedAt).run();

  return { indexedAt, scanned, count: rows.length };
}

async function handleSearch(request, env) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    await ensureD1Schema(env);
    const url = new URL(request.url);
    const refresh = ['1', 'true', 'yes'].includes((url.searchParams.get('refresh') || '').toLowerCase());
    const refreshResult = refresh ? await rebuildSearchIndex(env) : null;
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const type = url.searchParams.get('type') || 'all';
    const requestedLimit = Number(url.searchParams.get('limit') || 100);
    const limit = Number.isFinite(requestedLimit) ? Math.min(500, Math.max(1, requestedLimit)) : 100;

    const clauses = [];
    const params = [];
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
      success: true,
      items: await filterItemsByPermission(env, auth, (results.results || []).map(d1RowToClientItem), 'view'),
      refresh: refreshResult
    });
  } catch (e) {
    return jsonResponse({ success: false, message: '搜索失败: ' + e.message }, 500);
  }
}

async function handleFavorites(request, env) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    await ensureD1Schema(env);
    const ownerKey = ownerKeyFromAuth(auth);

    if (request.method === 'GET') {
      const requestedLimit = Number(new URL(request.url).searchParams.get('limit') || 200);
      const limit = Number.isFinite(requestedLimit) ? Math.min(500, Math.max(1, requestedLimit)) : 200;
      const results = await env.D1_DB.prepare(`
        SELECT favorites.*, search_items.tags AS tags
        FROM favorites
        LEFT JOIN search_items ON search_items.path = favorites.path
        WHERE owner_key = ?
        ORDER BY updated_at DESC
        LIMIT ?
      `).bind(ownerKey, limit).all();
      return jsonResponse({
        success: true,
        favorites: await filterItemsByPermission(env, auth, (results.results || []).map(d1RowToClientItem), 'view')
      });
    }

    if (request.method === 'POST') {
      const item = normalizeD1ItemFromBody(await request.json());
      const permissionError = await requirePathPermission(env, auth, 'view', item.path);
      if (permissionError) return permissionError;
      const now = Date.now();
      await env.D1_DB.prepare(`
        INSERT INTO favorites (owner_key, path, name, item_type, size_formatted, preview_type, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_key, path) DO UPDATE SET
          name = excluded.name,
          item_type = excluded.item_type,
          size_formatted = excluded.size_formatted,
          preview_type = excluded.preview_type,
          updated_at = excluded.updated_at
      `).bind(ownerKey, item.path, item.name, item.itemType, item.sizeFormatted, item.previewType, now, now).run();
      return jsonResponse({ success: true, favorite: { ...item, updatedAt: now } });
    }

    if (request.method === 'DELETE') {
      const url = new URL(request.url);
      const body = await request.json().catch(() => ({}));
      const path = normalizeItemPath(body.path || url.searchParams.get('path') || '');
      if (!path || path === '/') {
        return jsonResponse({ success: false, message: '请提供有效路径' }, 400);
      }
      await env.D1_DB.prepare('DELETE FROM favorites WHERE owner_key = ? AND path = ?').bind(ownerKey, path).run();
      return jsonResponse({ success: true });
    }

    return jsonResponse({ success: false, message: '方法不支持' }, 405);
  } catch (e) {
    return jsonResponse({ success: false, message: '收藏操作失败: ' + e.message }, 500);
  }
}

async function pruneRecentItems(env, ownerKey, keepCount = 100) {
  const oldRows = await env.D1_DB.prepare(`
    SELECT path FROM recent_items
    WHERE owner_key = ?
    ORDER BY visited_at DESC
    LIMIT 1000 OFFSET ?
  `).bind(ownerKey, keepCount).all();

  const paths = (oldRows.results || []).map(row => row.path);
  if (paths.length === 0) return;
  const statement = env.D1_DB.prepare('DELETE FROM recent_items WHERE owner_key = ? AND path = ?');
  for (let index = 0; index < paths.length; index += 50) {
    await env.D1_DB.batch(paths.slice(index, index + 50).map(path => statement.bind(ownerKey, path)));
  }
}

async function saveRecentItem(env, auth, item) {
  await ensureD1Schema(env);
  const ownerKey = ownerKeyFromAuth(auth);
  const now = Date.now();
  await env.D1_DB.prepare(`
    INSERT INTO recent_items (owner_key, path, name, item_type, size_formatted, preview_type, visited_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_key, path) DO UPDATE SET
      name = excluded.name,
      item_type = excluded.item_type,
      size_formatted = excluded.size_formatted,
      preview_type = excluded.preview_type,
      visited_at = excluded.visited_at
  `).bind(ownerKey, item.path, item.name, item.itemType, item.sizeFormatted, item.previewType, now).run();
  await pruneRecentItems(env, ownerKey, 100);
  return now;
}

async function recordRecentVisit(env, auth, item) {
  try {
    await saveRecentItem(env, auth, item);
  } catch (e) {
    console.warn('D1 recent visit record failed:', e.message);
  }
}

async function handleRecent(request, env) {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  try {
    await ensureD1Schema(env);
    const ownerKey = ownerKeyFromAuth(auth);

    if (request.method === 'GET') {
      const requestedLimit = Number(new URL(request.url).searchParams.get('limit') || 100);
      const limit = Number.isFinite(requestedLimit) ? Math.min(200, Math.max(1, requestedLimit)) : 100;
      const results = await env.D1_DB.prepare(`
        SELECT recent_items.*, search_items.tags AS tags
        FROM recent_items
        LEFT JOIN search_items ON search_items.path = recent_items.path
        WHERE owner_key = ?
        ORDER BY visited_at DESC
        LIMIT ?
      `).bind(ownerKey, limit).all();
      return jsonResponse({
        success: true,
        recent: await filterItemsByPermission(env, auth, (results.results || []).map(d1RowToClientItem), 'view')
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

const CSS_STYLES = `
<style>
  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }
  
  :root {
    color-scheme: dark;
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

  :root[data-theme="light"] {
    color-scheme: light;
    --primary: #4f46e5;
    --primary-dark: #4338ca;
    --primary-light: #6366f1;
    --secondary: #7c3aed;
    --accent: #0891b2;
    --background: #f1f5f9;
    --surface: #ffffff;
    --surface-light: #e2e8f0;
    --text: #0f172a;
    --text-muted: #64748b;
    --success: #059669;
    --warning: #d97706;
    --error: #dc2626;
    --gradient: linear-gradient(135deg, #4f46e5 0%, #7c3aed 50%, #0891b2 100%);
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

  .theme-toggle {
    width: 38px;
    height: 38px;
    padding: 0;
    flex: 0 0 38px;
    font-size: 18px;
  }

  .theme-toggle-floating {
    position: fixed;
    top: 18px;
    right: 18px;
    z-index: 50;
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

  .modal-wide {
    max-width: 820px;
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
    flex-wrap: nowrap;
    gap: 16px;
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
    flex: 0 0 auto;
  }

  .reader-tools {
    display: none;
    align-items: center;
    gap: 6px;
    position: relative;
  }

  .reader-tools.active {
    display: flex;
  }

  .reader-font-size {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 34px;
    flex: 0 0 32px;
    color: var(--text-muted);
    text-align: center;
    font-size: 13px;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }

  .reader-tool-btn {
    padding: 7px 10px;
  }

  .bookmark-panel {
    position: fixed;
    top: 76px;
    left: 50%;
    right: auto;
    transform: translateX(-50%);
    width: min(520px, calc(100vw - 24px));
    max-height: min(460px, 65vh);
    overflow: auto;
    padding: 12px;
    border: 1px solid var(--surface-light);
    border-radius: 10px;
    background: var(--surface);
    box-shadow: 0 18px 45px rgba(0, 0, 0, 0.28);
    z-index: 5;
  }

  .bookmark-panel[hidden] {
    display: none;
  }

  .bookmark-add {
    width: 100%;
    margin-bottom: 10px;
  }

  .bookmark-empty {
    padding: 20px 8px;
    color: var(--text-muted);
    text-align: center;
  }

  .bookmark-item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 30px;
    align-items: center;
    gap: 10px;
    padding: 8px 0;
    border-top: 1px solid var(--surface-light);
  }

  .bookmark-jump {
    display: grid;
    grid-template-columns: 48px minmax(0, 1fr);
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text);
    text-align: left;
    cursor: pointer;
  }

  .bookmark-meta {
    color: var(--primary-light);
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
  }

  .bookmark-snippet {
    min-width: 0;
    color: var(--text-muted);
    font-size: 13px;
    line-height: 30px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .bookmark-delete {
    width: 30px;
    height: 30px;
    padding: 0;
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

  .toast-warning {
    background: var(--warning);
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
    align-items: center;
  }

  .task-chip {
    display: none;
    align-items: center;
    gap: 8px;
    max-width: 260px;
    padding: 8px 10px;
    border: 1px solid var(--surface-light);
    border-radius: 8px;
    background: var(--background);
    color: var(--text);
    font-size: 13px;
    line-height: 1.2;
    cursor: pointer;
    white-space: nowrap;
  }

  .task-chip.active {
    display: inline-flex;
  }

  .task-chip-text {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .task-panel-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .task-panel-empty {
    color: var(--text-muted);
    padding: 14px 0;
    text-align: center;
  }

  .task-row {
    border: 1px solid var(--surface-light);
    border-radius: 8px;
    padding: 12px;
    background: var(--background);
  }

  .task-row-head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
    font-size: 14px;
  }

  .task-row-title {
    font-weight: 600;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .task-row-status {
    color: var(--text-muted);
    flex: 0 0 auto;
  }

  .task-row-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
  }

  .task-icon-btn {
    width: 28px;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--surface-light);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text-muted);
    cursor: pointer;
    padding: 0;
  }

  .task-icon-btn:hover {
    color: var(--text);
    border-color: var(--primary);
  }

  .task-icon-btn.danger:hover {
    color: var(--error);
    border-color: var(--error);
  }

  .task-icon-btn svg {
    width: 15px;
    height: 15px;
  }

  .task-progress {
    height: 6px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--surface-light);
  }

  .task-progress-fill {
    width: 0;
    height: 100%;
    background: var(--primary);
    transition: width 0.2s ease;
  }

  .task-row-meta {
    margin-top: 8px;
    color: var(--text-muted);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .task-fly-icon {
    position: fixed;
    z-index: 4000;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: var(--primary);
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    box-shadow: 0 10px 24px rgba(99, 102, 241, 0.35);
    font-size: 14px;
    font-weight: 700;
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

  .tag-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    justify-content: center;
    margin-top: 8px;
  }

  .tag-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 100%;
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 12px;
    line-height: 1.3;
    color: white;
    overflow: hidden;
  }

  .tag-chip span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tag-chip button {
    width: 16px;
    height: 16px;
    border: none;
    border-radius: 50%;
    padding: 0;
    line-height: 1;
    cursor: pointer;
    background: rgba(255, 255, 255, 0.22);
    color: white;
  }

  .tag-editor-list {
    justify-content: flex-start;
    min-height: 30px;
    margin: 0 0 12px;
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
    align-items: flex-start;
    justify-content: center;
    background: var(--background);
    padding: 20px;
  }
  
  .share-card {
    background: var(--surface);
    border-radius: 12px;
    padding: 28px;
    width: 100%;
    max-width: 960px;
  }

  .share-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 18px;
  }

  .share-title {
    min-width: 0;
  }
  
  .share-icon {
    font-size: 36px;
    margin-bottom: 8px;
  }
  
  .share-filename {
    font-size: 20px;
    font-weight: 600;
    margin-bottom: 8px;
    word-break: break-all;
  }
  
  .share-filesize {
    color: var(--text-muted);
    font-size: 14px;
  }

  .share-browser {
    display: none;
  }

  .share-browser.active {
    display: block;
  }

  .share-browser .file-item {
    cursor: pointer;
  }

  .share-browser .file-actions,
  .share-browser .file-select {
    display: none;
  }
  
  .share-expired {
    color: var(--error);
    font-size: 18px;
    text-align: center;
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

    .task-chip {
      max-width: 150px;
      padding: 6px 8px;
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
      gap: 6px;
      padding: 10px 8px;
    }

    .preview-filename {
      text-align: left;
      font-size: 13px;
    }

    .preview-actions .btn {
      display: none;
    }

    .preview-actions .reader-tools .reader-tool-btn,
    .preview-actions .reader-tools .bookmark-add,
    .preview-actions .reader-tools .bookmark-delete {
      display: inline-flex;
    }

    .reader-tools {
      gap: 2px;
    }

    .reader-tool-btn {
      min-width: 30px;
      height: 30px;
      padding: 0 6px;
      font-size: 12px;
    }

    .reader-font-size {
      width: 26px;
      height: 30px;
      flex-basis: 26px;
      font-size: 12px;
    }

    .bookmark-panel {
      top: 58px;
    }

    .preview-icon-btn {
      display: inline-flex;
      width: 30px;
      height: 30px;
      font-size: 13px;
    }

    .preview-actions {
      gap: 3px;
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

  .view-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }

  .view-tabs {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px;
    height: 36px;
    background: var(--surface);
    border: 1px solid var(--surface-light);
    border-radius: 8px;
    box-sizing: border-box;
    flex: 0 0 auto;
  }

  .view-tab {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-muted);
    height: 100%;
    padding: 6px 10px;
    margin: 0;
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
    white-space: nowrap;
  }

  .view-tab.active {
    background: var(--primary);
    color: white;
  }

  .search-tools {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 1 560px;
    min-width: 260px;
  }

  .search-tools .form-input {
    flex: 1 1 auto;
    min-width: 150px;
    height: 34px;
    padding: 6px 10px;
    margin: 0;
    font-size: 13px;
  }

  .search-tools .form-select {
    width: 96px;
    height: 34px;
    padding: 6px 28px 6px 10px;
    margin: 0;
    font-size: 13px;
  }

  .search-tools .tag-filter {
    position: relative;
    width: 150px;
    height: 34px;
  }

  .tag-filter-trigger {
    width: 100%;
    height: 34px;
    padding: 6px 28px 6px 10px;
    margin: 0;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .tag-filter-trigger #tagFilterLabel {
    display: inline-block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    vertical-align: middle;
    color: var(--text-muted);
  }

  .tag-filter-trigger.has-selection #tagFilterLabel {
    color: var(--text);
  }

  .tag-filter-menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 50;
    width: 240px;
    max-width: 80vw;
    background: var(--surface);
    border: 1px solid var(--surface-light);
    border-radius: 8px;
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.32);
    overflow: hidden;
  }

  .tag-filter-menu-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--surface-light);
    font-size: 12px;
    color: var(--text-muted);
  }

  .tag-filter-clear {
    background: transparent;
    border: none;
    color: var(--primary-light);
    cursor: pointer;
    font-size: 12px;
    padding: 2px 4px;
  }

  .tag-filter-clear:hover {
    color: var(--primary);
  }

  .tag-filter-list {
    max-height: 240px;
    overflow-y: auto;
    padding: 4px 0;
  }

  .tag-filter-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    font-size: 13px;
    color: var(--text);
    cursor: pointer;
    user-select: none;
  }

  .tag-filter-item:hover {
    background: var(--surface-light);
  }

  .tag-filter-item input[type="checkbox"] {
    margin: 0;
    accent-color: var(--primary);
    cursor: pointer;
  }

  .tag-filter-item .tag-filter-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tag-filter-item .tag-filter-count {
    color: var(--text-muted);
    font-size: 12px;
  }

  .tag-filter-empty {
    padding: 16px 12px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
  }

  .search-tools .btn {
    height: 34px;
    padding: 6px 10px;
    margin: 0;
    font-size: 13px;
    white-space: nowrap;
  }

  .section-title {
    margin: 0 0 16px;
    color: var(--text-muted);
    font-size: 14px;
    font-weight: 500;
  }

  .qr-panel {
    display: flex;
    justify-content: center;
    margin: 14px 0 18px;
  }

  #shareQrCanvas {
    width: 180px;
    height: 180px;
    padding: 10px;
    background: white;
    border-radius: 8px;
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

  .resource-picker-toolbar {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 130px;
    gap: 10px;
    margin-bottom: 12px;
  }

  .resource-list,
  .permission-list {
    border: 1px solid var(--surface-light);
    border-radius: 8px;
    overflow: hidden;
    background: var(--background);
  }

  .resource-list {
    max-height: 280px;
    overflow-y: auto;
  }

  .resource-row,
  .permission-row {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    padding: 10px 12px;
    border-bottom: 1px solid var(--surface-light);
  }

  .permission-row {
    grid-template-columns: minmax(0, 1fr) 150px 34px;
  }

  .resource-row:last-child,
  .permission-row:last-child {
    border-bottom: none;
  }

  .resource-main,
  .permission-main {
    min-width: 0;
  }

  .resource-name,
  .permission-path {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .resource-path,
  .permission-summary {
    color: var(--text-muted);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .permission-empty {
    padding: 14px 12px;
    color: var(--text-muted);
    font-size: 14px;
  }

  .permission-checks {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px 12px;
    margin-top: 10px;
  }

  .permission-checks label {
    color: var(--text-muted);
    font-size: 13px;
    white-space: nowrap;
  }

  .permission-checks input {
    margin-right: 6px;
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

  @media (max-width: 768px) {
    .view-toolbar {
      align-items: stretch;
      flex-direction: column;
      gap: 8px;
    }

    .view-tabs {
      width: 100%;
    }

    .view-tab {
      flex: 1 1 0;
    }

    .search-tools {
      min-width: 0;
      flex: 1 1 auto;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 92px;
      gap: 6px;
    }

    .search-tools .form-select {
      width: 100%;
    }

    .search-tools .tag-filter {
      width: 100%;
    }

    .search-tools .btn {
      width: 100%;
      padding: 6px 8px;
    }
  }
</style>
`;

const THEME_BOOTSTRAP = `
  <script>
    (function () {
      const key = 'edgestash:theme:v1';
      let saved = null;
      try { saved = localStorage.getItem(key); } catch (error) {}
      const preferred = saved === 'light' || saved === 'dark'
        ? saved
        : (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
      document.documentElement.dataset.theme = preferred;

      window.toggleTheme = function () {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem(key, next); } catch (error) {}
        updateThemeButtons();
      };

      function updateThemeButtons() {
        const dark = document.documentElement.dataset.theme === 'dark';
        document.querySelectorAll('[data-theme-toggle]').forEach(function (button) {
          button.textContent = dark ? '☀️' : '🌙';
          button.title = dark ? '切换到日间模式' : '切换到夜间模式';
          button.setAttribute('aria-label', button.title);
        });
      }

      document.addEventListener('DOMContentLoaded', updateThemeButtons);
    })();
  </script>`;

const THEME_TOGGLE_BUTTON = `<button type="button" class="btn btn-secondary theme-toggle" data-theme-toggle onclick="toggleTheme()" aria-label="切换颜色主题"></button>`;

const FIXED_LOGIN_PAGE = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>登录 - EdgeStashPro</title>
  ${THEME_BOOTSTRAP}
  ${CSS_STYLES}
</head>
<body>
  <div class="theme-toggle-floating">${THEME_TOGGLE_BUTTON}</div>
  <div class="login-container">
    <div class="login-card">
      <div class="login-header">
        <div class="login-logo">EdgeStashPro</div>
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

        <div id="otpField" class="form-group">
          <label class="form-label" for="otp">OTP 验证码</label>
          <input type="text" id="otp" class="form-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 位验证码">
        </div>

        <div id="otpSetupPanel" class="form-group" style="display: none;">
          <label class="form-label">首次绑定管理员 OTP</label>
          <div class="qr-panel">
            <canvas id="otpQrCanvas" width="180" height="180" aria-label="管理员 OTP 二维码"></canvas>
          </div>
          <input type="text" id="otpSecret" class="form-input" readonly>
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
      document.getElementById('otpField').style.display = isAdminLogin ? 'block' : 'none';
      document.getElementById('otpSetupPanel').style.display = 'none';
    }

    async function handleLogin(event) {
      event.preventDefault();

      const password = document.getElementById('password').value;
      const email = document.getElementById('email').value.trim();
      const otp = document.getElementById('otp').value.trim();

      try {
        const response = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            isAdmin: isAdminLogin,
            email: isAdminLogin ? undefined : email,
            password,
            otp: isAdminLogin ? otp : undefined
          })
        });

        const data = await response.json().catch(function () {
          return { success: false, message: '服务返回异常，请检查 Worker 日志和绑定配置' };
        });
        if (data.success) {
          showToast('登录成功', 'success');
          window.setTimeout(function () {
            window.location.href = '/';
          }, 300);
        } else if (data.requiresOtpSetup) {
          document.getElementById('otpSetupPanel').style.display = 'block';
          document.getElementById('otpSecret').value = data.otpSecret || '';
          if (data.otpUri) renderOtpQr(data.otpUri);
          showToast(data.message || '请扫码绑定 OTP 后输入验证码', 'info');
        } else if (data.requiresOtp) {
          document.getElementById('otpField').style.display = 'block';
          showToast(data.message || '请输入 OTP 验证码', 'error');
        } else {
          showToast(data.message || '登录失败', 'error');
        }
      } catch (error) {
        showToast('登录失败: ' + error.message, 'error');
      }
    }

    function renderOtpQr(text) {
      const canvas = document.getElementById('otpQrCanvas');
      if (!canvas) return;
      try {
        const qr = createQrMatrix(text);
        const ctx = canvas.getContext('2d');
        const quiet = 4;
        const scale = Math.max(1, Math.floor(canvas.width / (qr.size + quiet * 2)));
        const imageSize = (qr.size + quiet * 2) * scale;
        const offset = Math.floor((canvas.width - imageSize) / 2);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#000000';
        for (let y = 0; y < qr.size; y++) {
          for (let x = 0; x < qr.size; x++) {
            if (qr.matrix[y][x]) {
              ctx.fillRect(offset + (x + quiet) * scale, offset + (y + quiet) * scale, scale, scale);
            }
          }
        }
      } catch (error) {
        showToast('二维码生成失败，请手动输入 Secret', 'error');
      }
    }

    function createQrMatrix(text) {
      const version = 6;
      const size = 17 + version * 4;
      const dataCodewords = 136;
      const blockCount = 2;
      const blockDataCodewords = 68;
      const eccCodewords = 18;
      const bytes = Array.from(new TextEncoder().encode(text));
      const bits = [];

      function pushBits(value, length) {
        for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
      }

      if (bytes.length > dataCodewords - 3) throw new Error('QR payload too long');
      pushBits(4, 4);
      pushBits(bytes.length, 8);
      bytes.forEach(function (byte) { pushBits(byte, 8); });

      const capacityBits = dataCodewords * 8;
      for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
      while (bits.length % 8 !== 0) bits.push(0);

      const data = [];
      for (let i = 0; i < bits.length; i += 8) {
        let value = 0;
        for (let j = 0; j < 8; j++) value = (value << 1) | bits[i + j];
        data.push(value);
      }
      for (let pad = 0xec; data.length < dataCodewords; pad ^= 0xec ^ 0x11) data.push(pad);

      const blocks = [];
      for (let block = 0; block < blockCount; block++) {
        const blockData = data.slice(block * blockDataCodewords, (block + 1) * blockDataCodewords);
        blocks.push({ data: blockData, ecc: reedSolomonCompute(blockData, eccCodewords) });
      }

      const codewords = [];
      for (let i = 0; i < blockDataCodewords; i++) {
        for (let block = 0; block < blockCount; block++) codewords.push(blocks[block].data[i]);
      }
      for (let i = 0; i < eccCodewords; i++) {
        for (let block = 0; block < blockCount; block++) codewords.push(blocks[block].ecc[i]);
      }

      const matrix = Array.from({ length: size }, function () { return Array(size).fill(false); });
      const isFunction = Array.from({ length: size }, function () { return Array(size).fill(false); });

      function setModule(x, y, dark, func) {
        if (x < 0 || y < 0 || x >= size || y >= size) return;
        matrix[y][x] = !!dark;
        if (func) isFunction[y][x] = true;
      }

      function drawFinder(cx, cy) {
        for (let dy = -4; dy <= 4; dy++) {
          for (let dx = -4; dx <= 4; dx++) {
            const dist = Math.max(Math.abs(dx), Math.abs(dy));
            setModule(cx + dx, cy + dy, dist !== 2 && dist <= 3, true);
          }
        }
      }

      function drawAlignment(cx, cy) {
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const dist = Math.max(Math.abs(dx), Math.abs(dy));
            setModule(cx + dx, cy + dy, dist === 2 || dist === 0, true);
          }
        }
      }

      function drawFormat(mask) {
        const bits = getFormatBits(1, mask);
        for (let i = 0; i <= 5; i++) setModule(8, i, ((bits >>> i) & 1) !== 0, true);
        setModule(8, 7, ((bits >>> 6) & 1) !== 0, true);
        setModule(8, 8, ((bits >>> 7) & 1) !== 0, true);
        setModule(7, 8, ((bits >>> 8) & 1) !== 0, true);
        for (let i = 9; i < 15; i++) setModule(14 - i, 8, ((bits >>> i) & 1) !== 0, true);
        for (let i = 0; i < 8; i++) setModule(size - 1 - i, 8, ((bits >>> i) & 1) !== 0, true);
        for (let i = 8; i < 15; i++) setModule(8, size - 15 + i, ((bits >>> i) & 1) !== 0, true);
        setModule(8, size - 8, true, true);
      }

      drawFinder(3, 3);
      drawFinder(size - 4, 3);
      drawFinder(3, size - 4);
      for (let i = 8; i < size - 8; i++) {
        setModule(6, i, i % 2 === 0, true);
        setModule(i, 6, i % 2 === 0, true);
      }
      drawAlignment(34, 34);
      drawFormat(0);

      let bitIndex = 0;
      let upward = true;
      for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right--;
        for (let vertical = 0; vertical < size; vertical++) {
          const y = upward ? size - 1 - vertical : vertical;
          for (let j = 0; j < 2; j++) {
            const x = right - j;
            if (isFunction[y][x]) continue;
            let dark = false;
            if (bitIndex < codewords.length * 8) {
              dark = ((codewords[Math.floor(bitIndex / 8)] >>> (7 - (bitIndex % 8))) & 1) !== 0;
            }
            bitIndex++;
            if ((x + y) % 2 === 0) dark = !dark;
            setModule(x, y, dark, false);
          }
        }
        upward = !upward;
      }
      drawFormat(0);
      return { size: size, matrix: matrix };
    }

    function getFormatBits(ecl, mask) {
      let data = (ecl << 3) | mask;
      let bits = data << 10;
      for (let i = 14; i >= 10; i--) {
        if (((bits >>> i) & 1) !== 0) bits ^= 0x537 << (i - 10);
      }
      return ((data << 10) | bits) ^ 0x5412;
    }

    function reedSolomonCompute(data, degree) {
      const divisor = Array(degree).fill(0);
      divisor[degree - 1] = 1;
      let root = 1;
      for (let i = 0; i < degree; i++) {
        for (let j = 0; j < degree; j++) {
          divisor[j] = gfMultiply(divisor[j], root);
          if (j + 1 < degree) divisor[j] ^= divisor[j + 1];
        }
        root = gfMultiply(root, 2);
      }

      const result = Array(degree).fill(0);
      data.forEach(function (byte) {
        const factor = byte ^ result.shift();
        result.push(0);
        for (let i = 0; i < degree; i++) result[i] ^= gfMultiply(divisor[i], factor);
      });
      return result;
    }

    function gfMultiply(x, y) {
      let z = 0;
      for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11d);
        if (((y >>> i) & 1) !== 0) z ^= x;
      }
      return z & 0xff;
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
  <title>EdgeStashPro - 云盘</title>
  ${THEME_BOOTSTRAP}
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">
  ${CSS_STYLES}
  <script src="https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js" integrity="sha384-948ahk4ZmxYVYOc+rxN1H2gM1EJ2Duhp7uHtZ4WSLkV4Vtx5MUqnV+l7u9B+jFv+" crossorigin="anonymous"></script>
  <script src="https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js" integrity="sha384-nFoSjZIoH3CCp8W639jJyQkuPHinJ2NHe7on1xvlUA7SuGfJAfvMldrsoAVm6ECz" crossorigin="anonymous"></script>
</head>
<body>
  <div class="header">
    <div class="logo">EdgeStashPro</div>
    <div class="header-actions">
      ${THEME_TOGGLE_BUTTON}
      <button type="button" class="task-chip" id="taskChip" onclick="openTaskPanel()">
        <span class="task-chip-text" id="taskChipText"></span>
      </button>
      <button type="button" class="btn btn-secondary" onclick="refreshCurrentDirectory()">刷新</button>
      <button type="button" class="btn btn-secondary" onclick="window.location.href='/admin.html'">管理后台</button>
      <button type="button" class="btn btn-secondary" onclick="logout()">退出登录</button>
    </div>
  </div>

  <div class="container">
    <div class="breadcrumb" id="breadcrumb"></div>

    <div class="toolbar">
      <button type="button" class="btn btn-primary" onclick="showNewFolderModal()">📁 新建文件夹</button>
      <button type="button" class="btn btn-primary" onclick="setTaskOrigin(this);document.getElementById('fileInput').click()">📤 上传文件</button>
      <button type="button" class="btn btn-primary" onclick="setTaskOrigin(this);document.getElementById('folderInput').click()">📁 上传文件夹</button>
      <input type="file" id="fileInput" multiple style="display: none;" onchange="handleFileUpload(event)">
      <input type="file" id="folderInput" webkitdirectory directory multiple style="display: none;" onchange="handleFolderUpload(event)">
    </div>

    <div class="view-toolbar">
      <div class="view-tabs">
        <button type="button" class="view-tab active" data-view="files" onclick="switchMainView('files')">文件</button>
        <button type="button" class="view-tab" data-view="favorites" onclick="switchMainView('favorites')">收藏</button>
        <button type="button" class="view-tab" data-view="recent" onclick="switchMainView('recent')">最近</button>
      </div>
      <div class="search-tools">
        <input type="search" id="globalSearchInput" class="form-input" placeholder="搜索名称或路径" oninput="handleSearchInput()" onkeydown="handleSearchKey(event)">
        <select id="globalSearchType" class="form-select" onchange="handleSearchTypeChange()">
          <option value="all">全部</option>
          <option value="files">文件</option>
          <option value="folders">文件夹</option>
        </select>
        <div class="tag-filter" id="tagFilterWrap">
          <button type="button" id="tagFilterTrigger" class="form-select tag-filter-trigger" onclick="toggleTagFilterMenu(event)" title="按标签筛选" aria-haspopup="listbox" aria-expanded="false">
            <span id="tagFilterLabel">标签</span>
          </button>
          <div id="tagFilterMenu" class="tag-filter-menu" hidden>
            <div class="tag-filter-menu-head">
              <span>按标签筛选</span>
              <button type="button" class="tag-filter-clear" onclick="clearTagFilters()">清除</button>
            </div>
            <div id="tagFilterList" class="tag-filter-list"></div>
            <div id="tagFilterEmpty" class="tag-filter-empty" hidden>暂无标签</div>
          </div>
        </div>
      </div>
    </div>

    <div class="section-title" id="viewTitle">当前目录</div>

    <div class="batch-toolbar" id="batchToolbar">
      <label class="batch-count">
        <input type="checkbox" id="selectAllCheckbox" onchange="toggleSelectAll(this.checked)">
        已选择 <span id="selectedCount">0</span> 项
      </label>
      <button type="button" class="btn btn-sm btn-secondary" onclick="setTaskOrigin(this);showBatchTargetModal('copy')">复制</button>
      <button type="button" class="btn btn-sm btn-secondary" onclick="setTaskOrigin(this);showBatchTargetModal('move')">移动</button>
      <button type="button" class="btn btn-sm btn-secondary" onclick="setTaskOrigin(this);batchDownload()">下载</button>
      <button type="button" class="btn btn-sm btn-secondary" onclick="batchShare()">分享</button>
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
        <input type="hidden" id="shareItems">
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
      <div class="qr-panel">
        <canvas id="shareQrCanvas" width="180" height="180" aria-label="分享二维码"></canvas>
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

  <div class="modal-overlay" id="taskPanelModal">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">任务状态</div>
        <button type="button" class="modal-close" onclick="closeModal('taskPanelModal')">&times;</button>
      </div>
      <div class="task-panel-list" id="taskPanelList"></div>
    </div>
  </div>

  <div class="modal-overlay" id="tagModal">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">编辑标签</div>
        <button type="button" class="modal-close" onclick="closeModal('tagModal')">&times;</button>
      </div>
      <form onsubmit="saveTags(event)">
        <div class="form-group">
          <label class="form-label" id="tagItemName"></label>
          <div class="tag-list tag-editor-list" id="tagEditorList"></div>
          <input type="text" id="tagInput" class="form-input" maxlength="20" placeholder="输入标签后回车">
        </div>
        <input type="hidden" id="tagItemPath">
        <input type="hidden" id="tagItemType">
        <button type="submit" class="btn btn-primary" style="width: 100%;">保存</button>
      </form>
    </div>
  </div>

  <div class="preview-overlay" id="previewOverlay">
    <div class="preview-header">
      <div class="preview-filename" id="previewFilename"></div>
      <div class="preview-actions">
        <div class="reader-tools" id="readerTools">
          <button type="button" class="btn btn-secondary reader-tool-btn" onclick="adjustReaderFontSize(-2)" aria-label="缩小字体">A−</button>
          <span class="reader-font-size" id="readerFontSize">18</span>
          <button type="button" class="btn btn-secondary reader-tool-btn" onclick="adjustReaderFontSize(2)" aria-label="放大字体">A+</button>
          <button type="button" class="btn btn-secondary reader-tool-btn" id="bookmarkToggleBtn" onclick="toggleBookmarkPanel(event)" title="书签" aria-label="打开书签">🔖</button>
          <div class="bookmark-panel" id="bookmarkPanel" hidden onclick="event.stopPropagation()">
            <button type="button" class="btn btn-primary bookmark-add" onclick="addCurrentBookmark()">添加当前位置</button>
            <div id="bookmarkList"></div>
          </div>
        </div>
        <button type="button" class="btn btn-primary" id="previewDownloadBtn">下载</button>
        <button type="button" class="btn btn-secondary" onclick="closePreview()">关闭</button>
        <button type="button" class="preview-icon-btn preview-download" onclick="document.getElementById('previewDownloadBtn').click()">⬇</button>
        <button type="button" class="preview-icon-btn preview-close" onclick="closePreview()">✕</button>
      </div>
    </div>
    <div class="preview-content" id="previewContent"></div>
  </div>

  <div class="toast-container" id="toastContainer"></div>
  <div class="loading-overlay" id="loadingOverlay" style="display: none;"><div class="spinner"></div><div id="loadingMsg" style="color:#fff;margin-top:12px;font-size:14px;"></div></div>

  <script>
    let currentPath = '/';
    let currentView = 'files';
    let currentUserRole = null;
    let currentReader = null;
    let readerSaveTimer = null;
    let readerBookmarks = [];
    const READER_FONT_SIZE_KEY = 'edgestash:reader-font-size:v1';
    const selectedItems = new Map();
    const favoritePaths = new Set();
    let folderSearchTimer = null;
    let folderSearchRequestId = 0;
    let globalSearchTimer = null;
    let globalSearchRequestId = 0;
    let tagOptionsLoaded = false;
    let editingTagItem = null;
    let editingTags = [];
    const taskStore = new Map();
    const runningTaskLoops = new Set();
    const uploadQueue = [];
    const activeUploadXhrs = new Map();
    const canceledLocalTasks = new Set();
    const deletedLocalTasks = new Set();
    let activeUploadCount = 0;
    let taskPollTimer = null;
    let lastTaskOriginElement = null;
    let batchTaskOriginElement = null;
    const TASK_DONE_TOAST_KEY = 'edgestash:task-terminal-toasts:v1';
    const TASK_ACTION_ICONS = {
      stop: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="1"/></svg>',
      delete: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>'
    };
    const ACTION_ICONS = {
      download: '<svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>',
      share: '<svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 10.6l6.8-4.2"/><path d="M8.6 13.4l6.8 4.2"/></svg>',
      rename: '<svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
      tag: '<svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/></svg>',
      delete: '<svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>',
      favorite: '<svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5l2.8 5.7 6.3.9-4.5 4.4 1.1 6.3-5.7-3-5.7 3 1.1-6.3-4.5-4.4 6.3-.9Z"/></svg>',
      favoriteOn: '<svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5l2.8 5.7 6.3.9-4.5 4.4 1.1 6.3-5.7-3-5.7 3 1.1-6.3-4.5-4.4 6.3-.9Z"/></svg>'
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

    function normalizeClientPath(path) {
      const parts = String(path || '').split('/').filter(Boolean);
      return parts.length ? '/' + parts.join('/') : '/';
    }

    function parentClientPath(path) {
      const normalized = normalizeClientPath(path);
      if (normalized === '/') return '/';
      const index = normalized.lastIndexOf('/');
      return index <= 0 ? '/' : normalized.slice(0, index);
    }

    function setTaskOrigin(element) {
      if (element && element.getBoundingClientRect) {
        lastTaskOriginElement = element;
      }
    }

    function getDoneTaskToastSet() {
      try {
        return new Set(JSON.parse(localStorage.getItem(TASK_DONE_TOAST_KEY) || '[]'));
      } catch (error) {
        return new Set();
      }
    }

    function saveDoneTaskToastSet(set) {
      try {
        localStorage.setItem(TASK_DONE_TOAST_KEY, JSON.stringify(Array.from(set).slice(-200)));
      } catch (error) {
        console.warn('Task toast state save failed:', error);
      }
    }

    function mergeTask(task, options) {
      if (!task || !task.id) return;
      if (deletedLocalTasks.has(task.id)) return;
      const previous = taskStore.get(task.id);
      if (previous && (previous.updatedAt || 0) > (task.updatedAt || 0)) return;
      taskStore.set(task.id, task);
      maybeNotifyTaskTerminal(task, previous, options && options.forceToast);
      updateTaskUi();
      if ((task.type === 'copy' || task.type === 'move' || task.type === 'delete') && (task.status === 'queued' || task.status === 'running')) {
        runCopyMoveTaskLoop(task.id);
      }
    }

    function maybeNotifyTaskTerminal(task, previous, forceToast) {
      if (!['succeeded', 'failed', 'canceled'].includes(task.status)) return;
      const key = task.id + ':' + task.status;
      const shown = getDoneTaskToastSet();
      const becameTerminal = forceToast || (previous && previous.status !== task.status);
      if (!becameTerminal || shown.has(key)) return;
      shown.add(key);
      saveDoneTaskToastSet(shown);
      const verb = task.type === 'upload' ? '上传' : task.type === 'download' || task.type === 'batch_download' ? '下载' : task.type === 'move' ? '移动' : task.type === 'delete' ? '删除' : '复制';
      if (task.status === 'succeeded') {
        showToast(verb + (task.result && task.result.nativeDownload ? '已开始: ' : '完成: ') + task.title, 'success');
      } else if (task.status === 'failed') {
        showToast(verb + '失败: ' + (task.errorMessage || task.title), 'error');
      }
    }

    async function createTask(payload, originElement) {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.message || '创建任务失败');
      mergeTask(data.task);
      animateTaskCreated(originElement || lastTaskOriginElement || document.activeElement);
      return data.task;
    }

    function animateTaskCreated(originElement) {
      const chip = document.getElementById('taskChip');
      if (!chip || !originElement || !originElement.getBoundingClientRect) return;
      const from = originElement.getBoundingClientRect();
      const to = chip.getBoundingClientRect();
      if (!from.width || !from.height || !to.width || !to.height) return;

      const fly = document.createElement('div');
      fly.className = 'task-fly-icon';
      fly.textContent = '+';
      fly.style.left = (from.left + from.width / 2 - 15) + 'px';
      fly.style.top = (from.top + from.height / 2 - 15) + 'px';
      document.body.appendChild(fly);
      if (!fly.animate) {
        window.setTimeout(function () { fly.remove(); }, 300);
        return;
      }

      const dx = to.left + to.width / 2 - (from.left + from.width / 2);
      const dy = to.top + to.height / 2 - (from.top + from.height / 2);
      fly.animate([
        { transform: 'translate(0, 0) scale(1)', opacity: 1 },
        { transform: 'translate(' + dx + 'px, ' + dy + 'px) scale(0.25)', opacity: 0 }
      ], {
        duration: 520,
        easing: 'cubic-bezier(.2,.8,.2,1)'
      }).addEventListener('finish', function () {
        fly.remove();
      });
    }

    async function patchTaskProgress(taskId, payload, forceToast) {
      const response = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/progress', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.message || '更新任务失败');
      mergeTask(data.task, { forceToast: forceToast });
      return data.task;
    }

    async function loadTasks(activeOnly) {
      try {
        const response = await fetch('/api/tasks?limit=50' + (activeOnly ? '&active=1' : ''));
        const data = await response.json();
        if (!data.success) return;
        (data.tasks || []).forEach(function (task) {
          mergeTask(task);
        });
        updateTaskUi();
      } catch (error) {
        console.warn('Task load failed:', error);
      }
    }

    async function cancelTask(taskId) {
      abortLocalTask(taskId);
      try {
        const response = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/cancel', { method: 'POST' });
        const data = await response.json();
        if (!data.success) throw new Error(data.message || '停止失败');
        mergeTask(data.task, { forceToast: true });
        showToast('任务已停止', 'info');
      } catch (error) {
        showToast('停止任务失败: ' + error.message, 'error');
      }
    }

    async function deleteTask(taskId) {
      abortLocalTask(taskId);
      try {
        const response = await fetch('/api/tasks/' + encodeURIComponent(taskId), { method: 'DELETE' });
        const data = await response.json();
        if (!data.success) throw new Error(data.message || '删除失败');
        deletedLocalTasks.add(taskId);
        taskStore.delete(taskId);
        updateTaskUi();
        showToast('任务已删除', 'success');
      } catch (error) {
        showToast('删除任务失败: ' + error.message, 'error');
      }
    }

    function abortLocalTask(taskId) {
      canceledLocalTasks.add(taskId);
      const xhr = activeUploadXhrs.get(taskId);
      if (xhr) {
        xhr.abort();
        activeUploadXhrs.delete(taskId);
      }
    }

    function startTaskMonitor() {
      loadTasks(false);
      if (taskPollTimer) clearInterval(taskPollTimer);
      taskPollTimer = window.setInterval(function () {
        loadTasks(false);
      }, 5000);
    }

    function taskProgressPercent(task) {
      if (task.totalBytes > 0) return Math.max(0, Math.min(100, Math.round((task.processedBytes / task.totalBytes) * 100)));
      if (task.totalItems > 0) return Math.max(0, Math.min(100, Math.round((task.processedItems / task.totalItems) * 100)));
      return task.status === 'succeeded' ? 100 : 0;
    }

    function estimateRemaining(task) {
      if (!task.totalBytes || !task.processedBytes || !task.createdAt) return '';
      const elapsed = Math.max(1, Date.now() - task.createdAt);
      const speed = task.processedBytes / elapsed;
      if (!speed) return '';
      const remainingMs = (task.totalBytes - task.processedBytes) / speed;
      if (!Number.isFinite(remainingMs) || remainingMs <= 0) return '';
      return ' · 剩余 ' + formatDuration(remainingMs);
    }

    function formatDuration(ms) {
      const seconds = Math.max(1, Math.round(ms / 1000));
      if (seconds < 60) return seconds + '秒';
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return minutes + '分钟';
      return Math.round(minutes / 60) + '小时';
    }

    function taskTypeLabel(type) {
      return { upload: '上传', download: '下载', batch_download: '批量下载', copy: '复制', move: '移动', delete: '删除' }[type] || '任务';
    }

    function taskStatusLabel(task) {
      if ((task.type === 'download' || task.type === 'batch_download') && task.result && task.result.nativeDownload) return '已开始';
      if (task.status === 'succeeded') return '已完成';
      if (task.status === 'failed') return '失败';
      if (task.status === 'canceled') return '已取消';
      if (task.type === 'download' || task.type === 'batch_download') return task.status === 'running' ? '处理中' : '排队中';
      if (task.totalBytes > 0) return taskProgressPercent(task) + '%' + estimateRemaining(task);
      if (task.totalItems > 0) return '已处理 ' + task.processedItems + '/' + task.totalItems;
      return task.status === 'running' ? '处理中' : '排队中';
    }

    function startNativeDownload(url) {
      const frame = document.createElement('iframe');
      frame.style.display = 'none';
      frame.src = url;
      document.body.appendChild(frame);
      window.setTimeout(function () {
        frame.remove();
      }, 60000);
    }

    function updateTaskUi() {
      const chip = document.getElementById('taskChip');
      const text = document.getElementById('taskChipText');
      if (!chip || !text) return;
      const tasks = Array.from(taskStore.values()).sort(function (a, b) {
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
      const activeTasks = tasks.filter(function (task) {
        return task.status === 'queued' || task.status === 'running';
      });
      if (activeTasks.length === 0) {
        chip.classList.remove('active');
      } else {
        chip.classList.add('active');
        if (activeTasks.length > 1) {
          text.textContent = activeTasks.length + ' 个任务进行中';
        } else {
          const task = activeTasks[0];
          text.textContent = taskTypeLabel(task.type) + ' ' + taskStatusLabel(task);
        }
      }
      renderTaskPanel();
    }

    function openTaskPanel() {
      renderTaskPanel();
      document.getElementById('taskPanelModal').classList.add('active');
      loadTasks(false);
    }

    function renderTaskPanel() {
      const list = document.getElementById('taskPanelList');
      if (!list) return;
      const tasks = Array.from(taskStore.values()).sort(function (a, b) {
        return (b.createdAt || 0) - (a.createdAt || 0);
      }).slice(0, 50);
      list.replaceChildren();
      if (tasks.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'task-panel-empty';
        empty.textContent = '暂无任务';
        list.appendChild(empty);
        return;
      }
      tasks.forEach(function (task) {
        const row = document.createElement('div');
        row.className = 'task-row';
        const head = document.createElement('div');
        head.className = 'task-row-head';
        const title = document.createElement('div');
        title.className = 'task-row-title';
        title.textContent = task.title || taskTypeLabel(task.type);
        const status = document.createElement('div');
        status.className = 'task-row-status';
        status.textContent = taskStatusLabel(task);
        const actions = document.createElement('div');
        actions.className = 'task-row-actions';
        if (task.status === 'queued' || task.status === 'running') {
          actions.appendChild(createTaskIconButton('stop', '停止任务', function () {
            cancelTask(task.id);
          }));
        }
        actions.appendChild(createTaskIconButton('delete', '删除任务', function () {
          deleteTask(task.id);
        }, 'danger'));
        head.appendChild(title);
        head.appendChild(status);
        head.appendChild(actions);
        row.appendChild(head);

        const progress = document.createElement('div');
        progress.className = 'task-progress';
        const fill = document.createElement('div');
        fill.className = 'task-progress-fill';
        fill.style.width = taskProgressPercent(task) + '%';
        progress.appendChild(fill);
        row.appendChild(progress);

        if (task.errorMessage || task.sourcePath || task.destinationPath) {
          const meta = document.createElement('div');
          meta.className = 'task-row-meta';
          meta.textContent = task.errorMessage || [task.sourcePath, task.destinationPath].filter(Boolean).join(' -> ');
          row.appendChild(meta);
        }
        list.appendChild(row);
      });
    }

    function createTaskIconButton(iconKey, label, handler, extraClass) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'task-icon-btn' + (extraClass ? ' ' + extraClass : '');
      button.title = label;
      button.setAttribute('aria-label', label);
      button.innerHTML = TASK_ACTION_ICONS[iconKey] || label;
      button.addEventListener('click', function (event) {
        event.stopPropagation();
        handler();
      });
      return button;
    }

    async function runCopyMoveTaskLoop(taskId) {
      if (runningTaskLoops.has(taskId)) return;
      runningTaskLoops.add(taskId);
      try {
        while (true) {
          const task = taskStore.get(taskId);
          if (!task || !['queued', 'running'].includes(task.status)) break;
          const response = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/run?limit=5', { method: 'POST' });
          const data = await response.json();
          if (!data.success) throw new Error(data.message || '任务执行失败');
          mergeTask(data.task);
          if (data.done || !['queued', 'running'].includes(data.task.status)) {
            await loadFiles();
            break;
          }
          await new Promise(function (resolve) { window.setTimeout(resolve, 300); });
        }
      } catch (error) {
        showToast('任务执行失败: ' + error.message, 'error');
      } finally {
        runningTaskLoops.delete(taskId);
      }
    }

    async function checkAuth() {
      try {
        const response = await fetch('/api/auth/check');
        const data = await response.json();
        if (!data.authenticated) { window.location.href = '/login.html'; return false; }
        currentUserRole = data.role || null;
        const initResp = await fetch('/api/d1/init');
        const initData = await initResp.json();
        if (initData.initialized) {
          const msg = document.getElementById('loadingMsg');
          msg.textContent = '正在初始化数据库...';
          document.getElementById('loadingOverlay').style.display = 'flex';
          await new Promise(r => setTimeout(r, 600));
          document.getElementById('loadingOverlay').style.display = 'none';
          msg.textContent = '';
        }
        await loadTagOptions();
        return true;
      } catch (error) {
        window.location.href = '/login.html';
        return false;
      }
    }

    async function loadFiles(options) {
      const searchRequestId = options && options.searchRequestId;
      if (searchRequestId && searchRequestId !== globalSearchRequestId) return;
      currentView = 'files';
      updateViewTabs();
      showLoading(true);
      try {
        const response = await fetch(apiFileUrl('/api/files', currentPath));
        let data = await response.json().catch(function () {
          return { success: false, message: '文件列表接口返回异常' };
        });
        if (!data.success) {
          if (response.status === 401) {
            window.location.href = '/login.html';
            return;
          }
          throw new Error(data.message || '加载失败');
        }
        if (!searchRequestId && data.cached && isEmptyFileListing(data)) {
          const refreshed = await refreshDirectoryFromSource();
          if (refreshed && refreshed.success) data = refreshed;
        }
        if (searchRequestId && searchRequestId !== globalSearchRequestId) return;
        currentPath = data.currentPath || currentPath;
        clearSelection(false);
        await loadFavoritePaths();
        if (searchRequestId && searchRequestId !== globalSearchRequestId) return;
        renderBreadcrumb();
        document.getElementById('viewTitle').textContent = '当前目录';
        renderFiles(data.folders || [], data.files || []);
      } catch (error) {
        showToast('加载文件失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }

    function isEmptyFileListing(data) {
      return (!data.folders || data.folders.length === 0) && (!data.files || data.files.length === 0);
    }

    async function refreshDirectoryFromSource() {
      try {
        const response = await fetch(apiFileUrl('/api/files', currentPath) + '?refresh=1');
        const data = await response.json().catch(function () {
          return { success: false, message: '目录刷新接口返回异常' };
        });
        if (!response.ok || !data.success) {
          throw new Error(data.message || '目录刷新失败');
        }
        return data;
      } catch (error) {
        console.warn('Directory source refresh failed:', error);
        return null;
      }
    }

    function isBatchSelectionView() {
      return ['files', 'search', 'favorites', 'recent'].includes(currentView);
    }

    function updateViewTabs() {
      document.querySelectorAll('.view-tab').forEach(function (tab) {
        tab.classList.toggle('active', tab.dataset.view === currentView);
      });
      document.getElementById('batchToolbar').classList.toggle('active', isBatchSelectionView() && selectedItems.size > 0);
    }

    async function switchMainView(view) {
      if (view === 'files') {
        await loadFiles();
        return;
      }
      currentView = view;
      updateViewTabs();
      clearSelection(false);
      if (view === 'favorites') {
        await loadFavoritesView();
      } else if (view === 'recent') {
        await loadRecentView();
      }
    }

    async function loadFavoritePaths() {
      try {
        const response = await fetch('/api/favorites?limit=500');
        const data = await response.json();
        favoritePaths.clear();
        if (data.success) {
          (data.favorites || []).forEach(function (item) {
            favoritePaths.add(item.path);
          });
        }
      } catch (error) {
        console.warn('Favorites load failed:', error);
      }
    }

    const selectedTagFilters = new Set();

    async function loadTagOptions(force) {
      if (tagOptionsLoaded && !force) return;
      const list = document.getElementById('tagFilterList');
      const empty = document.getElementById('tagFilterEmpty');
      if (!list) return;
      try {
        const response = await fetch('/api/tags/list');
        const data = await response.json();
        if (!data.success) throw new Error(data.message || '读取标签失败');
        const tags = data.tags || [];
        const validTags = new Set(tags.map(function (t) { return t.tag; }));
        Array.from(selectedTagFilters).forEach(function (tag) {
          if (!validTags.has(tag)) selectedTagFilters.delete(tag);
        });
        list.replaceChildren();
        tags.forEach(function (item) {
          const label = document.createElement('label');
          label.className = 'tag-filter-item';
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.value = item.tag;
          checkbox.checked = selectedTagFilters.has(item.tag);
          checkbox.addEventListener('change', function () {
            if (checkbox.checked) selectedTagFilters.add(item.tag);
            else selectedTagFilters.delete(item.tag);
            updateTagFilterLabel();
            handleTagFilterChange();
          });
          const name = document.createElement('span');
          name.className = 'tag-filter-name';
          name.textContent = item.tag;
          const count = document.createElement('span');
          count.className = 'tag-filter-count';
          count.textContent = item.count;
          label.appendChild(checkbox);
          label.appendChild(name);
          label.appendChild(count);
          list.appendChild(label);
        });
        if (empty) empty.hidden = tags.length > 0;
        list.hidden = tags.length === 0;
        updateTagFilterLabel();
        tagOptionsLoaded = true;
      } catch (error) {
        console.warn('Tag options load failed:', error);
      }
    }

    function updateTagFilterLabel() {
      const trigger = document.getElementById('tagFilterTrigger');
      const label = document.getElementById('tagFilterLabel');
      if (!trigger || !label) return;
      const count = selectedTagFilters.size;
      if (count === 0) {
        label.textContent = '标签';
        trigger.classList.remove('has-selection');
      } else if (count === 1) {
        label.textContent = Array.from(selectedTagFilters)[0];
        trigger.classList.add('has-selection');
      } else {
        label.textContent = '已选 ' + count + ' 个标签';
        trigger.classList.add('has-selection');
      }
    }

    function toggleTagFilterMenu(event) {
      if (event) event.stopPropagation();
      const menu = document.getElementById('tagFilterMenu');
      const trigger = document.getElementById('tagFilterTrigger');
      if (!menu || !trigger) return;
      const willOpen = menu.hidden;
      menu.hidden = !willOpen;
      trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    }

    function closeTagFilterMenu() {
      const menu = document.getElementById('tagFilterMenu');
      const trigger = document.getElementById('tagFilterTrigger');
      if (menu && !menu.hidden) menu.hidden = true;
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
    }

    function clearTagFilters() {
      if (selectedTagFilters.size === 0) return;
      selectedTagFilters.clear();
      const list = document.getElementById('tagFilterList');
      if (list) {
        list.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
          cb.checked = false;
        });
      }
      updateTagFilterLabel();
      handleTagFilterChange();
    }

    document.addEventListener('click', function (event) {
      const wrap = document.getElementById('tagFilterWrap');
      if (!wrap) return;
      if (!wrap.contains(event.target)) closeTagFilterMenu();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeTagFilterMenu();
    });

    function getSelectedTagFilters() {
      return Array.from(selectedTagFilters).filter(Boolean);
    }

    async function loadFavoritesView() {
      showLoading(true);
      try {
        const response = await fetch('/api/favorites?limit=500');
        const data = await response.json();
        if (!data.success) throw new Error(data.message || '加载失败');
        favoritePaths.clear();
        (data.favorites || []).forEach(function (item) {
          favoritePaths.add(item.path);
        });
        document.getElementById('viewTitle').textContent = '收藏';
        renderItemList(data.favorites || [], '暂无收藏');
      } catch (error) {
        showToast('加载收藏失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }

    async function loadRecentView() {
      showLoading(true);
      try {
        await loadFavoritePaths();
        const response = await fetch('/api/recent?limit=100');
        const data = await response.json();
        if (!data.success) throw new Error(data.message || '加载失败');
        document.getElementById('viewTitle').textContent = '最近访问';
        renderItemList(data.recent || [], '暂无最近访问');
      } catch (error) {
        showToast('加载最近访问失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }

    function handleSearchKey(event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (globalSearchTimer) {
          clearTimeout(globalSearchTimer);
          globalSearchTimer = null;
        }
        runSearch(false);
      }
    }

    function handleSearchInput() {
      scheduleGlobalSearch(0);
    }

    function handleSearchTypeChange() {
      scheduleGlobalSearch(0);
    }

    function handleTagFilterChange() {
      scheduleGlobalSearch(0);
    }

    function scheduleGlobalSearch(delay) {
      if (globalSearchTimer) {
        clearTimeout(globalSearchTimer);
        globalSearchTimer = null;
      }

      const q = document.getElementById('globalSearchInput').value.trim();
      const tags = getSelectedTagFilters();
      if (!q && tags.length === 0) {
        const requestId = ++globalSearchRequestId;
        loadFiles({ searchRequestId: requestId });
        return;
      }

      globalSearchTimer = window.setTimeout(function () {
        globalSearchTimer = null;
        runSearch(false);
      }, delay);
    }

    async function runSearch(refresh) {
      const q = document.getElementById('globalSearchInput').value.trim();
      const tags = getSelectedTagFilters();
      if (!q && tags.length === 0) {
        const requestId = ++globalSearchRequestId;
        await loadFiles({ searchRequestId: requestId });
        return;
      }

      const requestId = ++globalSearchRequestId;
      currentView = 'search';
      updateViewTabs();
      clearSelection(false);
      if (refresh) showLoading(true);
      try {
        await loadFavoritePaths();
        const type = document.getElementById('globalSearchType').value;
        const params = new URLSearchParams({
          q: q,
          type: type,
          limit: '200',
          refresh: refresh ? '1' : '0'
        });
        tags.forEach(function (tag) { params.append('tag', tag); });
        const response = await fetch('/api/search?' + params.toString());
        const data = await response.json();
        if (requestId !== globalSearchRequestId) return;
        if (!data.success) throw new Error(data.message || '搜索失败');
        document.getElementById('viewTitle').textContent = refresh ? '搜索结果（索引已刷新）' : '搜索结果';
        renderItemList(data.items || [], '没有匹配的项目');
        if (data.refresh) {
          showToast('索引已刷新，共 ' + data.refresh.count + ' 项', 'success');
        }
      } catch (error) {
        if (requestId !== globalSearchRequestId) return;
        showToast('搜索失败: ' + error.message, 'error');
      } finally {
        if (refresh) showLoading(false);
      }
    }

    async function refreshCurrentDirectory() {
      currentView = 'files';
      updateViewTabs();
      showLoading(true);
      try {
        const [cacheResp, indexResp] = await Promise.all([
          fetch('/api/cache/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: currentPath })
          }),
          fetch('/api/search?q=&type=all&limit=1&refresh=1')
        ]);
        const data = await cacheResp.json().catch(function () { return {}; });
        const indexData = await indexResp.json().catch(function () { return {}; });
        if (!cacheResp.ok || !data.success) throw new Error(data.message || '目录刷新失败');
        if (!indexResp.ok || !indexData.success) throw new Error(indexData.message || '索引刷新失败');
        currentPath = data.currentPath || currentPath;
        clearSelection(false);
        await loadFavoritePaths();
        renderBreadcrumb();
        document.getElementById('viewTitle').textContent = '当前目录';
        renderFiles(data.folders || [], data.files || []);
        showToast('已刷新目录和索引', 'success');
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
        emptyState.querySelector('div:last-child').textContent =
          currentUserRole === 'user' && currentPath === '/'
            ? '暂无可访问资源，请联系管理员授权'
            : '此文件夹为空';
        return;
      }

      emptyState.style.display = 'none';
      folders.forEach(function (folder) {
        fileList.appendChild(createFileCard({
          name: folder.name,
          path: folder.path,
          itemType: 'folder',
          typeLabel: '📁',
          meta: '文件夹',
          isFolder: true,
          tags: folder.tags || []
        }));
      });

      files.forEach(function (file) {
        fileList.appendChild(createFileCard({
          name: file.name,
          path: file.path,
          itemType: 'file',
          typeLabel: getFileIcon(file.name),
          meta: file.sizeFormatted || '',
          sizeFormatted: file.sizeFormatted || '',
          previewType: file.previewType || '',
          isFolder: false,
          tags: file.tags || []
        }));
      });
    }

    function renderItemList(items, emptyMessage) {
      const fileList = document.getElementById('fileList');
      const emptyState = document.getElementById('emptyState');
      fileList.replaceChildren();

      if (!items || items.length === 0) {
        emptyState.style.display = 'block';
        emptyState.querySelector('div:last-child').textContent = emptyMessage || '暂无项目';
        return;
      }

      emptyState.style.display = 'none';
      items.forEach(function (item) {
        const isFolder = item.itemType === 'folder' || item.item_type === 'folder' || item.isFolder;
        fileList.appendChild(createFileCard({
          name: item.name,
          path: item.path,
          itemType: isFolder ? 'folder' : 'file',
          typeLabel: isFolder ? '📁' : getFileIcon(item.name),
          meta: isFolder ? '文件夹' : (item.sizeFormatted || ''),
          sizeFormatted: item.sizeFormatted || '',
          previewType: item.previewType || '',
          isFolder,
          tags: item.tags || []
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

      if (item.tags && item.tags.length > 0) {
        card.appendChild(renderTagChips(item.tags, false));
      }

      const actions = document.createElement('div');
      actions.className = 'file-actions';
      actions.appendChild(createActionButton(favoritePaths.has(item.path) ? 'favoriteOn' : 'favorite', favoritePaths.has(item.path) ? '取消收藏' : '收藏', favoritePaths.has(item.path) ? 'btn-primary' : 'btn-secondary', function () {
        toggleFavorite(item);
      }));
      actions.appendChild(createActionButton('tag', '编辑标签', 'btn-secondary', function () {
        showTagModal(item);
      }));
      if (!item.isFolder) {
        actions.appendChild(createActionButton('rename', '重命名', 'btn-secondary', function () {
          showRenameModal(item.path, item.name);
        }));
      }
      card.appendChild(actions);
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
        setTaskOrigin(button);
        handler(button);
      });
      return button;
    }

    function tagColor(tag) {
      const palette = ['#2563eb', '#047857', '#b45309', '#be123c', '#6d28d9', '#0f766e', '#4338ca', '#a21caf'];
      let hash = 0;
      for (let index = 0; index < tag.length; index++) {
        hash = ((hash << 5) - hash + tag.charCodeAt(index)) | 0;
      }
      return palette[Math.abs(hash) % palette.length];
    }

    function renderTagChips(tags, removable) {
      const list = document.createElement('div');
      list.className = 'tag-list' + (removable ? ' tag-editor-list' : '');
      (tags || []).forEach(function (tag) {
        const chip = document.createElement('span');
        chip.className = 'tag-chip';
        chip.style.background = tagColor(tag);
        const text = document.createElement('span');
        text.textContent = tag;
        chip.appendChild(text);
        if (removable) {
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.textContent = 'x';
          remove.setAttribute('aria-label', '移除标签 ' + tag);
          remove.addEventListener('click', function () {
            editingTags = editingTags.filter(function (item) { return item !== tag; });
            renderTagEditor();
          });
          chip.appendChild(remove);
        }
        list.appendChild(chip);
      });
      return list;
    }

    function showTagModal(item) {
      editingTagItem = item;
      editingTags = normalizeClientTags(item.tags || []);
      document.getElementById('tagItemName').textContent = item.name;
      document.getElementById('tagItemPath').value = item.path;
      document.getElementById('tagItemType').value = item.isFolder ? 'folder' : 'file';
      document.getElementById('tagInput').value = '';
      renderTagEditor();
      document.getElementById('tagModal').classList.add('active');
      window.setTimeout(function () {
        document.getElementById('tagInput').focus();
      }, 0);
    }

    function renderTagEditor() {
      const list = document.getElementById('tagEditorList');
      list.replaceChildren();
      const chips = renderTagChips(editingTags, true);
      Array.from(chips.children).forEach(function (chip) {
        list.appendChild(chip);
      });
    }

    function normalizeClientTags(tags) {
      const seen = new Set();
      const normalized = [];
      (tags || []).forEach(function (raw) {
        const tag = String(raw || '').trim();
        if (tag && tag.length <= 20 && !seen.has(tag)) {
          seen.add(tag);
          normalized.push(tag);
        }
      });
      return normalized.sort(function (a, b) { return a.localeCompare(b, 'zh-Hans-CN'); });
    }

    function addTagFromInput() {
      const input = document.getElementById('tagInput');
      const tag = input.value.trim();
      if (!tag) return;
      if (tag.length > 20) {
        showToast('单个标签不能超过 20 个字符', 'warning');
        return;
      }
      if (editingTags.length >= 20 && !editingTags.includes(tag)) {
        showToast('每个项目最多 20 个标签', 'warning');
        return;
      }
      editingTags = normalizeClientTags(editingTags.concat(tag));
      input.value = '';
      renderTagEditor();
    }

    async function saveTags(event) {
      event.preventDefault();
      addTagFromInput();
      const path = document.getElementById('tagItemPath').value;
      const itemType = document.getElementById('tagItemType').value;
      try {
        const response = await fetch('/api/tags?path=' + encodeURIComponent(path), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags: editingTags, itemType: itemType })
        });
        const data = await response.json();
        if (!data.success) throw new Error(data.message || '保存失败');
        closeModal('tagModal');
        if (editingTagItem) editingTagItem.tags = data.tags || [];
        await loadTagOptions(true);
        showToast('标签已保存', 'success');
        if (currentView === 'files') {
          await loadFiles();
        } else if (currentView === 'favorites') {
          await loadFavoritesView();
        } else if (currentView === 'recent') {
          await loadRecentView();
        } else if (currentView === 'search') {
          await runSearch(false);
        }
      } catch (error) {
        showToast('保存标签失败: ' + error.message, 'error');
      }
    }

    document.addEventListener('keydown', function (event) {
      if (event.target && event.target.id === 'tagInput' && event.key === 'Enter') {
        event.preventDefault();
        addTagFromInput();
      }
    });

    async function toggleFavorite(item) {
      const isFavorite = favoritePaths.has(item.path);
      try {
        const response = await fetch('/api/favorites', {
          method: isFavorite ? 'DELETE' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: item.path,
            name: item.name,
            itemType: item.isFolder ? 'folder' : 'file',
            sizeFormatted: item.sizeFormatted || item.meta || '',
            previewType: item.previewType || ''
          })
        });
        const data = await response.json();
        if (!data.success) throw new Error(data.message || '操作失败');
        if (isFavorite) {
          favoritePaths.delete(item.path);
          showToast('已取消收藏', 'success');
          if (currentView === 'favorites') {
            await loadFavoritesView();
            return;
          }
        } else {
          favoritePaths.add(item.path);
          showToast('已收藏', 'success');
        }
        if (currentView === 'files') {
          await loadFiles();
        } else if (currentView === 'recent') {
          await loadRecentView();
        } else if (currentView === 'search') {
          await runSearch(false);
        }
      } catch (error) {
        showToast('收藏操作失败: ' + error.message, 'error');
      }
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

      toolbar.classList.toggle('active', isBatchSelectionView() && count > 0);
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
      const readerTools = document.getElementById('readerTools');

      stopReaderProgressTracking();
      content.classList.remove('reader-mode');
      readerTools.classList.remove('active');
      document.getElementById('bookmarkPanel').hidden = true;
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
          wrapper.innerHTML = sanitizePreviewHtml(result.value);
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
            wrapper.innerHTML = sanitizePreviewHtml(window.marked.parse(text));
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
      document.getElementById('readerTools').classList.add('active');

      const reader = document.createElement('div');
      reader.className = 'preview-reader';
      reader.style.fontSize = getReaderFontSize() + 'px';
      reader.tabIndex = 0;
      const textNode = document.createTextNode(text);
      reader.appendChild(textNode);
      content.replaceChildren(reader);

      const state = {
        path,
        text,
        reader,
        textNode,
        saveInFlight: null,
        saveQueued: false,
        lastSavedOffset: null,
        lastSavedAt: 0,
        retryTimer: null
      };
      currentReader = state;
      updateReaderFontSizeLabel();

      await restoreReaderProgress(state);
      await loadReaderBookmarks(state);
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
      }, 1800);
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
      const waitMs = 1100 - (Date.now() - state.lastSavedAt);
      if (waitMs > 0) {
        if (!state.retryTimer) {
          state.retryTimer = window.setTimeout(function () {
            state.retryTimer = null;
            saveReaderProgress(state);
          }, waitMs);
        }
        return;
      }
      if (state.saveInFlight) {
        state.saveQueued = true;
        return state.saveInFlight;
      }

      try {
        const maxScrollTop = Math.max(0, state.reader.scrollHeight - state.reader.clientHeight);
        const progress = maxScrollTop > 0 ? state.reader.scrollTop / maxScrollTop : 0;
        const charOffset = getReaderCharOffset(state);
        if (charOffset === state.lastSavedOffset) return;
        const payload = {
          path: state.path,
          charOffset,
          progress,
          scrollTop: state.reader.scrollTop,
          scrollHeight: state.reader.scrollHeight
        };

        state.saveInFlight = fetch('/api/reader/progress', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true
        });
        const response = await state.saveInFlight;
        if (!response.ok) throw new Error('HTTP ' + response.status);
        state.lastSavedOffset = charOffset;
        state.lastSavedAt = Date.now();
      } catch (error) {
        console.warn('Reader progress save failed:', error);
      } finally {
        state.saveInFlight = null;
        if (state.saveQueued) {
          state.saveQueued = false;
          window.setTimeout(function () { saveReaderProgress(state); }, 1100);
        }
      }
    }

    function getReaderFontSize() {
      try {
        const saved = Number(localStorage.getItem(READER_FONT_SIZE_KEY));
        if (Number.isFinite(saved)) return Math.max(12, Math.min(32, saved));
      } catch (error) {}
      return 18;
    }

    function updateReaderFontSizeLabel() {
      document.getElementById('readerFontSize').textContent = String(getReaderFontSize());
    }

    async function adjustReaderFontSize(delta) {
      if (!currentReader) return;
      const state = currentReader;
      const offset = getReaderCharOffset(state);
      const next = Math.max(12, Math.min(32, getReaderFontSize() + delta));
      try { localStorage.setItem(READER_FONT_SIZE_KEY, String(next)); } catch (error) {}
      state.reader.style.fontSize = next + 'px';
      updateReaderFontSizeLabel();
      await waitForReaderLayout();
      scrollReaderToCharOffset(state, offset);
      scheduleReaderProgressSave(state);
    }

    function toggleBookmarkPanel(event) {
      if (event) event.stopPropagation();
      const panel = document.getElementById('bookmarkPanel');
      panel.hidden = !panel.hidden;
    }

    async function loadReaderBookmarks(state) {
      try {
        const response = await fetch('/api/reader/bookmarks?path=' + encodeURIComponent(state.path));
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || '读取书签失败');
        if (currentReader !== state) return;
        readerBookmarks = data.bookmarks || [];
        renderReaderBookmarks();
      } catch (error) {
        readerBookmarks = [];
        renderReaderBookmarks('书签加载失败');
      }
    }

    function renderReaderBookmarks(message) {
      const list = document.getElementById('bookmarkList');
      list.replaceChildren();
      if (message || readerBookmarks.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'bookmark-empty';
        empty.textContent = message || '还没有书签';
        list.appendChild(empty);
        return;
      }

      readerBookmarks.forEach(function (bookmark) {
        const item = document.createElement('div');
        item.className = 'bookmark-item';
        const jump = document.createElement('button');
        jump.type = 'button';
        jump.className = 'bookmark-jump';
        jump.addEventListener('click', function () { jumpToReaderBookmark(bookmark); });
        const meta = document.createElement('div');
        meta.className = 'bookmark-meta';
        meta.textContent = Math.round((bookmark.progress || 0) * 100) + '%';
        const snippet = document.createElement('div');
        snippet.className = 'bookmark-snippet';
        snippet.textContent = bookmark.snippet || '无文字摘要';
        jump.append(meta, snippet);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn btn-danger bookmark-delete';
        remove.textContent = '×';
        remove.setAttribute('aria-label', '删除书签');
        remove.addEventListener('click', function () { deleteReaderBookmark(bookmark.id); });
        item.append(jump, remove);
        list.appendChild(item);
      });
    }

    async function addCurrentBookmark() {
      if (!currentReader) return;
      const state = currentReader;
      const charOffset = getReaderCharOffset(state);
      const maxScrollTop = Math.max(0, state.reader.scrollHeight - state.reader.clientHeight);
      const progress = maxScrollTop > 0 ? state.reader.scrollTop / maxScrollTop : 0;
      const snippetStart = Math.max(0, charOffset - 30);
      const snippet = state.text.slice(snippetStart, Math.min(state.text.length, charOffset + 100));
      try {
        const response = await fetch('/api/reader/bookmarks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: state.path, charOffset, progress, snippet })
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || '添加书签失败');
        readerBookmarks.unshift(data.bookmark);
        renderReaderBookmarks();
        showToast('书签已添加', 'success');
      } catch (error) {
        showToast(error.message, 'error');
      }
    }

    function jumpToReaderBookmark(bookmark) {
      if (!currentReader) return;
      if (!scrollReaderToCharOffset(currentReader, bookmark.charOffset)) {
        scrollReaderToProgress(currentReader, bookmark.progress);
      }
      document.getElementById('bookmarkPanel').hidden = true;
      currentReader.reader.focus();
    }

    async function deleteReaderBookmark(bookmarkId) {
      try {
        const response = await fetch('/api/reader/bookmarks/' + encodeURIComponent(bookmarkId), { method: 'DELETE' });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || '删除书签失败');
        readerBookmarks = readerBookmarks.filter(function (bookmark) { return bookmark.id !== bookmarkId; });
        renderReaderBookmarks();
      } catch (error) {
        showToast(error.message, 'error');
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
        return decodeBytes(bytes.subarray(3), 'utf-8');
      }
      if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return decodeBytes(bytes.subarray(2), 'utf-16le');
      }
      if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return decodeUtf16Be(bytes.subarray(2));
      }

      const utf8Text = tryDecodeBytes(bytes, 'utf-8', { fatal: true });
      if (utf8Text !== null) return utf8Text;

      for (const label of ['gb18030', 'gbk']) {
        const decoded = tryDecodeBytes(bytes, label);
        if (decoded !== null) return decoded;
      }

      return decodeBytes(bytes, 'utf-8');
    }

    function tryDecodeBytes(bytes, label, options) {
      try {
        return new TextDecoder(label, options || {}).decode(bytes);
      } catch (error) {
        return null;
      }
    }

    function decodeBytes(bytes, label) {
      const decoded = tryDecodeBytes(bytes, label);
      return decoded !== null ? decoded : latin1Fallback(bytes);
    }

    function latin1Fallback(bytes) {
      const chunkSize = 8192;
      let text = '';
      for (let index = 0; index < bytes.length; index += chunkSize) {
        text += String.fromCharCode.apply(null, Array.from(bytes.subarray(index, index + chunkSize)));
      }
      return text;
    }

    function decodeUtf16Be(bytes) {
      const chars = [];
      for (let index = 0; index + 1 < bytes.length; index += 2) {
        chars.push(String.fromCharCode((bytes[index] << 8) | bytes[index + 1]));
      }
      return chars.join('');
    }

    function sanitizePreviewHtml(html) {
      const template = document.createElement('template');
      template.innerHTML = html || '';
      const blockedTags = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'meta', 'link', 'base']);

      function cleanElement(element) {
        const tagName = element.tagName.toLowerCase();
        if (blockedTags.has(tagName)) {
          element.remove();
          return;
        }

        Array.from(element.attributes).forEach(function (attr) {
          const name = attr.name.toLowerCase();
          const value = attr.value.trim();

          if (name.startsWith('on') || name === 'srcdoc' || name === 'style') {
            element.removeAttribute(attr.name);
            return;
          }

          if (['href', 'src', 'xlink:href'].includes(name) && !isSafePreviewUrl(value, tagName, name)) {
            element.removeAttribute(attr.name);
          }
        });

        Array.from(element.children).forEach(cleanElement);
      }

      Array.from(template.content.children).forEach(cleanElement);
      return template.innerHTML;
    }

    function isSafePreviewUrl(value, tagName, attrName) {
      if (!value || value.startsWith('#') || value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) {
        return true;
      }

      let url;
      try {
        url = new URL(value, window.location.origin);
      } catch (error) {
        return false;
      }

      if (['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) return true;
      return tagName === 'img' && attrName === 'src' && url.protocol === 'data:' && /^data:image\\/(?:png|jpe?g|gif|webp);/i.test(value);
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
      document.getElementById('readerTools').classList.remove('active');
      document.getElementById('bookmarkPanel').hidden = true;
      const content = document.getElementById('previewContent');
      content.classList.remove('reader-mode');
      content.replaceChildren();
      readerBookmarks = [];
    }

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closePreview();
    });

    document.addEventListener('click', function () {
      document.getElementById('bookmarkPanel').hidden = true;
    });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden' && currentReader) {
        saveReaderProgress(currentReader);
      }
    });

    async function handleFileUpload(event) {
      const files = Array.from(event.target.files || []);
      if (files.length === 0) return;

      const origin = lastTaskOriginElement;
      for (const file of files) {
        try {
          const task = await createTask({
            type: 'upload',
            title: '上传 ' + file.name,
            name: file.name,
            destinationPath: currentPath,
            totalBytes: file.size || 0
          }, origin);
          enqueueUpload(task, file, currentPath);
        } catch (error) {
          showToast('创建上传任务失败: ' + error.message, 'error');
        }
      }
      event.target.value = '';
      processUploadQueue();
    }

    async function handleFolderUpload(event) {
      const files = Array.from(event.target.files || []);
      if (files.length === 0) {
        showToast('所选文件夹为空，无法上传', 'warning');
        event.target.value = '';
        return;
      }

      const origin = lastTaskOriginElement;
      const folderPaths = new Set();
      files.forEach(function (file) {
        const relativePath = file.webkitRelativePath || file.name;
        const parts = relativePath.split('/').filter(Boolean);
        for (let index = 0; index < parts.length - 1; index++) {
          folderPaths.add(normalizeClientPath(currentPath + '/' + parts.slice(0, index + 1).join('/')));
        }
      });

      for (const folderPath of Array.from(folderPaths).sort(function (a, b) { return a.length - b.length; })) {
        try {
          await fetch('/api/folders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: folderPath })
          });
        } catch (error) {
          console.warn('Folder pre-create failed:', folderPath, error);
        }
      }

      for (const file of files) {
        const relativePath = file.webkitRelativePath || file.name;
        const targetFilePath = normalizeClientPath(currentPath + '/' + relativePath);
        const targetParentPath = parentClientPath(targetFilePath);
        try {
          const task = await createTask({
            type: 'upload',
            title: '上传 ' + relativePath,
            name: file.name,
            destinationPath: targetParentPath,
            totalBytes: file.size || 0
          }, origin);
          enqueueUpload(task, file, targetParentPath);
        } catch (error) {
          showToast('创建上传任务失败: ' + error.message, 'error');
        }
      }
      event.target.value = '';
      processUploadQueue();
    }

    function enqueueUpload(task, file, path) {
      uploadQueue.push({ task: task, file: file, path: path });
    }

    function processUploadQueue() {
      while (activeUploadCount < 2 && uploadQueue.length > 0) {
        const item = uploadQueue.shift();
        const latest = taskStore.get(item.task.id);
        if (latest && latest.status === 'canceled') continue;
        activeUploadCount++;
        uploadFileWithProgress(item.task, item.file, item.path).finally(function () {
          activeUploadCount--;
          processUploadQueue();
        });
      }
    }

    function uploadFileWithProgress(task, file, path) {
      return new Promise(function (resolve) {
        const xhr = new XMLHttpRequest();
        const formData = new FormData();
        let lastUpdate = 0;
        formData.append('file', file);
        xhr.open('POST', apiFileUrl('/api/files', path));
        activeUploadXhrs.set(task.id, xhr);
        xhr.upload.onprogress = function (event) {
          if (!event.lengthComputable) return;
          const now = Date.now();
          if (now - lastUpdate < 800 && event.loaded < event.total) return;
          lastUpdate = now;
          patchTaskProgress(task.id, {
            status: 'running',
            processedBytes: event.loaded,
            totalBytes: event.total
          }).catch(function () {});
        };
        xhr.onload = async function () {
          activeUploadXhrs.delete(task.id);
          if (canceledLocalTasks.has(task.id) || !taskStore.has(task.id)) {
            resolve();
            return;
          }
          try {
            const data = JSON.parse(xhr.responseText || '{}');
            if (xhr.status >= 200 && xhr.status < 300 && data.success) {
              await patchTaskProgress(task.id, {
                status: 'succeeded',
                processedBytes: file.size || task.totalBytes || 0,
                totalBytes: file.size || task.totalBytes || 0,
                result: { path: data.path }
              }, true);
              if (path === currentPath || path.startsWith(currentPath === '/' ? '/' : currentPath + '/')) await loadFiles();
            } else {
              throw new Error(data.message || xhr.statusText || '上传失败');
            }
          } catch (error) {
            await patchTaskProgress(task.id, {
              status: 'failed',
              errorMessage: error.message
            }, true).catch(function () {});
          }
          resolve();
        };
        xhr.onerror = async function () {
          activeUploadXhrs.delete(task.id);
          await patchTaskProgress(task.id, {
            status: 'failed',
            errorMessage: '网络连接失败'
          }, true).catch(function () {});
          resolve();
        };
        xhr.onabort = function () {
          activeUploadXhrs.delete(task.id);
          resolve();
        };
        xhr.send(formData);
      });
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

      batchTaskOriginElement = lastTaskOriginElement;
      document.getElementById('batchOperation').value = operation;
      document.getElementById('batchDestinationPath').value = currentView === 'files' ? currentPath : '/';
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
      batchTaskOriginElement = lastTaskOriginElement;
      await runBatchOperation('delete', '/');
    }

    async function batchDownload() {
      const items = getSelectedItems();
      if (items.length === 0) {
        showToast('请先选择文件或文件夹', 'error');
        return;
      }

      let task = null;
      try {
        task = await createTask({
          type: 'batch_download',
          title: '批量下载 ' + items.length + ' 项',
          items: items
        }, lastTaskOriginElement);
        startNativeDownload('/api/tasks/' + encodeURIComponent(task.id) + '/download');
        await patchTaskProgress(task.id, {
          status: 'succeeded',
          processedItems: items.length,
          totalItems: items.length,
          result: {
            nativeDownload: true,
            items: items.map(function (item) {
              return {
                path: item.path,
                name: item.name || ''
              };
            })
          }
        }, true);
      } catch (error) {
        if (task) {
          await patchTaskProgress(task.id, { status: 'failed', errorMessage: error.message }, true).catch(function () {});
        } else {
          showToast('批量下载失败: ' + error.message, 'error');
        }
      }
    }

    async function runBatchOperation(operation, destinationPath) {
      const items = getSelectedItems();
      if (items.length === 0) return;

      if (operation === 'copy' || operation === 'move' || operation === 'delete') {
        try {
          const verb = operation === 'move' ? '移动' : operation === 'delete' ? '删除' : '复制';
          const task = await createTask({
            type: operation,
            title: verb + ' ' + items.length + ' 项',
            destinationPath: destinationPath,
            items: items
          }, batchTaskOriginElement || lastTaskOriginElement);
          clearSelection();
          showToast(verb + '任务已开始', 'info');
          runCopyMoveTaskLoop(task.id);
        } catch (error) {
          showToast('创建批量任务失败: ' + error.message, 'error');
        } finally {
          batchTaskOriginElement = null;
        }
        return;
      }

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

    async function downloadFile(path, originElement) {
      let task = null;
      try {
        task = await createTask({
          type: 'download',
          title: '下载 ' + (path.split('/').pop() || '文件'),
          path: path
        }, originElement || lastTaskOriginElement);
        startNativeDownload('/api/tasks/' + encodeURIComponent(task.id) + '/download');
        await patchTaskProgress(task.id, {
          status: 'succeeded',
          processedBytes: task.totalBytes || 0,
          totalBytes: task.totalBytes || 0,
          result: { nativeDownload: true }
        }, true);
      } catch (error) {
        if (task && (canceledLocalTasks.has(task.id) || !taskStore.has(task.id))) return;
        if (task) {
          await patchTaskProgress(task.id, { status: 'failed', errorMessage: error.message }, true).catch(function () {});
        } else {
          showToast('下载失败: ' + error.message, 'error');
        }
      }
    }

    function showShareModal(items) {
      const shareItems = Array.isArray(items) ? items : [{ path: items }];
      document.getElementById('shareFilePath').value = shareItems[0]?.path || '';
      document.getElementById('shareItems').value = JSON.stringify(shareItems.map(function (item) {
        return {
          path: item.path,
          name: item.name || '',
          itemType: item.isFolder ? 'folder' : 'file'
        };
      }));
      document.getElementById('sharePassword').value = '';
      document.getElementById('shareExpiry').value = '1d';
      document.getElementById('shareModal').classList.add('active');
    }

    function batchShare() {
      const items = getSelectedItems();
      if (items.length === 0) {
        showToast('请选择要分享的文件或文件夹', 'error');
        return;
      }
      showShareModal(items);
    }

    async function createShare(event) {
      event.preventDefault();
      const filePath = document.getElementById('shareFilePath').value;
      const shareItemsValue = document.getElementById('shareItems').value;
      const password = document.getElementById('sharePassword').value;
      const expiresIn = document.getElementById('shareExpiry').value;
      let items = [];

      try {
        items = shareItemsValue ? JSON.parse(shareItemsValue) : [];
      } catch (error) {
        items = [];
      }

      showLoading(true);
      closeModal('shareModal');
      try {
        const payload = {
          password: password,
          expiresIn: expiresIn
        };
        if (items.length > 0) {
          payload.items = items;
        } else {
          payload.filePath = filePath;
        }

        const response = await fetch('/api/share', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (data.success) {
          const fullUrl = window.location.origin + data.shareUrl;
          document.getElementById('shareResultUrl').value = fullUrl;
          renderShareQr(fullUrl);
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

    function renderShareQr(text) {
      const canvas = document.getElementById('shareQrCanvas');
      if (!canvas) return;
      try {
        const qr = createQrMatrix(text);
        const ctx = canvas.getContext('2d');
        const quiet = 4;
        const scale = Math.max(1, Math.floor(canvas.width / (qr.size + quiet * 2)));
        const imageSize = (qr.size + quiet * 2) * scale;
        const offset = Math.floor((canvas.width - imageSize) / 2);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#000000';
        for (let y = 0; y < qr.size; y++) {
          for (let x = 0; x < qr.size; x++) {
            if (qr.matrix[y][x]) {
              ctx.fillRect(offset + (x + quiet) * scale, offset + (y + quiet) * scale, scale, scale);
            }
          }
        }
      } catch (error) {
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#111111';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('链接过长', canvas.width / 2, canvas.height / 2);
      }
    }

    function createQrMatrix(text) {
      const version = 6;
      const size = 17 + version * 4;
      const dataCodewords = 136;
      const blockCount = 2;
      const blockDataCodewords = 68;
      const eccCodewords = 18;
      const bytes = Array.from(new TextEncoder().encode(text));
      const bits = [];

      function pushBits(value, length) {
        for (let i = length - 1; i >= 0; i--) {
          bits.push((value >>> i) & 1);
        }
      }

      if (bytes.length > dataCodewords - 3) {
        throw new Error('QR payload too long');
      }

      pushBits(4, 4);
      pushBits(bytes.length, 8);
      bytes.forEach(function (byte) {
        pushBits(byte, 8);
      });

      const capacityBits = dataCodewords * 8;
      for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
      while (bits.length % 8 !== 0) bits.push(0);

      const data = [];
      for (let i = 0; i < bits.length; i += 8) {
        let value = 0;
        for (let j = 0; j < 8; j++) value = (value << 1) | bits[i + j];
        data.push(value);
      }
      for (let pad = 0xec; data.length < dataCodewords; pad ^= 0xec ^ 0x11) {
        data.push(pad);
      }

      const blocks = [];
      for (let block = 0; block < blockCount; block++) {
        const blockData = data.slice(block * blockDataCodewords, (block + 1) * blockDataCodewords);
        blocks.push({ data: blockData, ecc: reedSolomonCompute(blockData, eccCodewords) });
      }

      const codewords = [];
      for (let i = 0; i < blockDataCodewords; i++) {
        for (let block = 0; block < blockCount; block++) codewords.push(blocks[block].data[i]);
      }
      for (let i = 0; i < eccCodewords; i++) {
        for (let block = 0; block < blockCount; block++) codewords.push(blocks[block].ecc[i]);
      }

      const matrix = Array.from({ length: size }, function () { return Array(size).fill(false); });
      const isFunction = Array.from({ length: size }, function () { return Array(size).fill(false); });

      function setModule(x, y, dark, func) {
        if (x < 0 || y < 0 || x >= size || y >= size) return;
        matrix[y][x] = !!dark;
        if (func) isFunction[y][x] = true;
      }

      function drawFinder(cx, cy) {
        for (let dy = -4; dy <= 4; dy++) {
          for (let dx = -4; dx <= 4; dx++) {
            const dist = Math.max(Math.abs(dx), Math.abs(dy));
            setModule(cx + dx, cy + dy, dist !== 2 && dist <= 3, true);
          }
        }
      }

      function drawAlignment(cx, cy) {
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const dist = Math.max(Math.abs(dx), Math.abs(dy));
            setModule(cx + dx, cy + dy, dist === 2 || dist === 0, true);
          }
        }
      }

      function drawFormat(mask) {
        const bits = getFormatBits(1, mask);
        for (let i = 0; i <= 5; i++) setModule(8, i, ((bits >>> i) & 1) !== 0, true);
        setModule(8, 7, ((bits >>> 6) & 1) !== 0, true);
        setModule(8, 8, ((bits >>> 7) & 1) !== 0, true);
        setModule(7, 8, ((bits >>> 8) & 1) !== 0, true);
        for (let i = 9; i < 15; i++) setModule(14 - i, 8, ((bits >>> i) & 1) !== 0, true);
        for (let i = 0; i < 8; i++) setModule(size - 1 - i, 8, ((bits >>> i) & 1) !== 0, true);
        for (let i = 8; i < 15; i++) setModule(8, size - 15 + i, ((bits >>> i) & 1) !== 0, true);
        setModule(8, size - 8, true, true);
      }

      drawFinder(3, 3);
      drawFinder(size - 4, 3);
      drawFinder(3, size - 4);
      for (let i = 8; i < size - 8; i++) {
        setModule(6, i, i % 2 === 0, true);
        setModule(i, 6, i % 2 === 0, true);
      }
      drawAlignment(34, 34);
      drawFormat(0);

      let bitIndex = 0;
      let upward = true;
      for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right--;
        for (let vertical = 0; vertical < size; vertical++) {
          const y = upward ? size - 1 - vertical : vertical;
          for (let j = 0; j < 2; j++) {
            const x = right - j;
            if (isFunction[y][x]) continue;
            let dark = false;
            if (bitIndex < codewords.length * 8) {
              dark = ((codewords[Math.floor(bitIndex / 8)] >>> (7 - (bitIndex % 8))) & 1) !== 0;
            }
            bitIndex++;
            if ((x + y) % 2 === 0) dark = !dark;
            setModule(x, y, dark, false);
          }
        }
        upward = !upward;
      }
      drawFormat(0);
      return { size: size, matrix: matrix };
    }

    function getFormatBits(ecl, mask) {
      let data = (ecl << 3) | mask;
      let bits = data << 10;
      for (let i = 14; i >= 10; i--) {
        if (((bits >>> i) & 1) !== 0) {
          bits ^= 0x537 << (i - 10);
        }
      }
      return ((data << 10) | bits) ^ 0x5412;
    }

    function reedSolomonCompute(data, degree) {
      const divisor = Array(degree).fill(0);
      divisor[degree - 1] = 1;
      let root = 1;
      for (let i = 0; i < degree; i++) {
        for (let j = 0; j < degree; j++) {
          divisor[j] = gfMultiply(divisor[j], root);
          if (j + 1 < degree) divisor[j] ^= divisor[j + 1];
        }
        root = gfMultiply(root, 2);
      }

      const result = Array(degree).fill(0);
      data.forEach(function (byte) {
        const factor = byte ^ result.shift();
        result.push(0);
        for (let i = 0; i < degree; i++) {
          result[i] ^= gfMultiply(divisor[i], factor);
        }
      });
      return result;
    }

    function gfMultiply(x, y) {
      let z = 0;
      for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11d);
        if (((y >>> i) & 1) !== 0) z ^= x;
      }
      return z & 0xff;
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

    function installClientErrorHandlers() {
      window.addEventListener('error', function (event) {
        const message = event && event.message ? event.message : '页面脚本错误';
        console.error('Client script error:', event.error || message);
        showToast('页面脚本错误: ' + message, 'error');
      });
      window.addEventListener('unhandledrejection', function (event) {
        const reason = event && event.reason;
        const message = reason && reason.message ? reason.message : String(reason || '未处理的异步错误');
        console.error('Unhandled promise rejection:', reason || message);
        showToast('页面请求错误: ' + message, 'error');
      });
    }

    installClientErrorHandlers();
    async function initializeApp() {
      initializeBatchFolderSearch();
      const authenticated = await checkAuth();
      if (!authenticated) return;
      startTaskMonitor();
      await loadFiles();
    }

    initializeApp();
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
  <title>管理后台 - EdgeStashPro</title>
  ${THEME_BOOTSTRAP}
  ${CSS_STYLES}
</head>
<body>
  <div class="header">
    <div class="logo">EdgeStashPro 管理后台</div>
    <div class="header-actions">
      ${THEME_TOGGLE_BUTTON}
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
            <thead><tr><th>邮箱</th><th>角色</th><th>授权资源</th><th>创建时间</th><th>操作</th></tr></thead>
            <tbody id="usersTable"></tbody>
          </table>
        </div>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="addUserModal">
    <div class="modal modal-wide">
      <div class="modal-header">
        <div class="modal-title" id="userModalTitle">添加授权用户</div>
        <button type="button" class="modal-close" onclick="closeModal('addUserModal')">&times;</button>
      </div>
      <form onsubmit="addUser(event)">
        <div class="form-group">
          <label class="form-label" for="newUserEmail">邮箱</label>
          <input type="email" id="newUserEmail" class="form-input" placeholder="请输入邮箱" required>
        </div>
        <div class="form-group" id="newUserPasswordGroup">
          <label class="form-label" for="newUserPassword">密码</label>
          <input type="text" id="newUserPassword" class="form-input" placeholder="请输入密码" required>
        </div>
        <div class="form-group">
          <label class="form-label" for="resourceSearchInput">授权文件或目录</label>
          <div class="resource-picker-toolbar">
            <input type="search" id="resourceSearchInput" class="form-input" placeholder="搜索文件或目录">
            <select id="resourceTypeFilter" class="form-select">
              <option value="all">全部</option>
              <option value="folder">文件夹</option>
              <option value="file">文件</option>
            </select>
          </div>
          <div class="resource-list" id="resourceSearchResults"></div>
        </div>
        <div class="form-group">
          <label class="form-label">已选资源权限</label>
          <div class="permission-list" id="selectedPermissionList"></div>
        </div>
        <button type="submit" class="btn btn-primary" id="userModalSubmit" style="width: 100%;">添加用户</button>
      </form>
    </div>
  </div>

  <div class="toast-container" id="toastContainer"></div>
  <div class="loading-overlay" id="loadingOverlay" style="display: none;"><div class="spinner"></div></div>

  <script>
    const selectedPermissions = new Map();
    let resourceSearchTimer = null;
    let resourceSearchRequestId = 0;
    let editingUserEmail = '';
    const permissionPresetFlags = {
      readonly: { view: true, preview: true, download: true, upload: false, modify: false, delete: false, share: false },
      uploader: { view: true, preview: true, download: true, upload: true, modify: false, delete: false, share: false },
      editor: { view: true, preview: true, download: true, upload: true, modify: true, delete: false, share: false },
      manager: { view: true, preview: true, download: true, upload: true, modify: true, delete: true, share: true },
      custom: { view: true, preview: true, download: true, upload: false, modify: false, delete: false, share: false }
    };
    const permissionLabels = {
      view: '查看',
      preview: '预览',
      download: '下载',
      upload: '上传',
      modify: '修改',
      delete: '删除',
      share: '分享'
    };

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
          appendEmptyRow(tbody, 5, '暂无授权用户');
          return;
        }
        data.users.forEach(function (user) {
          const tr = document.createElement('tr');
          appendCell(tr, user.email);
          appendCell(tr, user.role === 'admin' ? '管理员' : '普通用户');
          const permissionText = user.permissionCount
            ? user.permissionCount + ' 个资源' + ((user.permissions || []).length ? '：' + user.permissions.map(function (item) {
              return item.path + '（' + item.summary + '）';
            }).join('；') : '')
            : '未授权';
          appendCell(tr, permissionText);
          appendCell(tr, user.createdAt ? new Date(user.createdAt).toLocaleString() : '-');
          const actions = document.createElement('td');
          actions.appendChild(createSmallButton('编辑授权', 'btn-secondary', function () {
            showEditUserModal(user.email);
          }));
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
      editingUserEmail = '';
      document.getElementById('userModalTitle').textContent = '添加授权用户';
      document.getElementById('userModalSubmit').textContent = '添加用户';
      document.getElementById('newUserEmail').value = '';
      document.getElementById('newUserEmail').disabled = false;
      document.getElementById('newUserPassword').value = '';
      document.getElementById('newUserPassword').required = true;
      document.getElementById('newUserPasswordGroup').style.display = 'block';
      document.getElementById('resourceSearchInput').value = '';
      document.getElementById('resourceTypeFilter').value = 'all';
      selectedPermissions.clear();
      renderSelectedPermissions();
      document.getElementById('addUserModal').classList.add('active');
      searchResources('');
    }

    async function showEditUserModal(email) {
      editingUserEmail = email;
      document.getElementById('userModalTitle').textContent = '编辑用户授权';
      document.getElementById('userModalSubmit').textContent = '保存授权';
      document.getElementById('newUserEmail').value = email;
      document.getElementById('newUserEmail').disabled = true;
      document.getElementById('newUserPassword').value = '';
      document.getElementById('newUserPassword').required = false;
      document.getElementById('newUserPasswordGroup').style.display = 'none';
      document.getElementById('resourceSearchInput').value = '';
      document.getElementById('resourceTypeFilter').value = 'all';
      selectedPermissions.clear();
      renderSelectedPermissions();
      document.getElementById('addUserModal').classList.add('active');
      searchResources('');

      showLoading(true);
      try {
        const response = await fetch('/api/admin/users/' + encodeURIComponent(email) + '/permissions');
        const data = await response.json();
        if (!data.success) throw new Error(data.message || '加载失败');
        (data.permissions || []).forEach(function (permission) {
          selectedPermissions.set(permission.path, {
            path: permission.path,
            name: permission.name || permission.path,
            itemType: permission.itemType,
            preset: 'custom',
            permissions: permission.permissions || { ...permissionPresetFlags.readonly }
          });
        });
        renderSelectedPermissions();
        searchResources('');
      } catch (error) {
        closeModal('addUserModal');
        showToast('加载用户授权失败: ' + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }

    async function addUser(event) {
      event.preventDefault();
      const email = document.getElementById('newUserEmail').value.trim();
      const password = document.getElementById('newUserPassword').value;
      const permissions = Array.from(selectedPermissions.values()).map(function (item) {
        return {
          path: item.path,
          itemType: item.itemType,
          preset: item.preset,
          permissions: item.permissions
        };
      });
      if (permissions.length === 0) {
        showToast('请至少选择一个授权文件或目录', 'error');
        return;
      }
      showLoading(true);
      closeModal('addUserModal');
      try {
        const url = editingUserEmail
          ? '/api/admin/users/' + encodeURIComponent(editingUserEmail) + '/permissions'
          : '/api/admin/users';
        const response = await fetch(url, {
          method: editingUserEmail ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(editingUserEmail
            ? { permissions: permissions }
            : { email: email, password: password, permissions: permissions })
        });
        const data = await response.json();
        if (data.success) {
          showToast(editingUserEmail ? '用户授权已更新' : '用户添加成功', 'success');
          editingUserEmail = '';
          loadUsers();
        } else {
          showToast((editingUserEmail ? '保存失败: ' : '添加失败: ') + (data.message || '未知错误'), 'error');
        }
      } catch (error) {
        showToast((editingUserEmail ? '保存失败: ' : '添加失败: ') + error.message, 'error');
      } finally {
        showLoading(false);
      }
    }

    function initializeResourcePicker() {
      const input = document.getElementById('resourceSearchInput');
      const type = document.getElementById('resourceTypeFilter');
      if (!input || !type) return;

      input.addEventListener('input', function () {
        if (resourceSearchTimer) clearTimeout(resourceSearchTimer);
        resourceSearchTimer = window.setTimeout(function () {
          searchResources(input.value);
        }, 250);
      });

      type.addEventListener('change', function () {
        searchResources(input.value);
      });
    }

    async function searchResources(query) {
      const results = document.getElementById('resourceSearchResults');
      if (!results) return;
      const requestId = ++resourceSearchRequestId;
      const type = document.getElementById('resourceTypeFilter').value;
      results.replaceChildren(createResourceMessage('搜索中...'));

      try {
        const response = await fetch('/api/admin/resources/search?q=' + encodeURIComponent(query || '') + '&type=' + encodeURIComponent(type) + '&limit=80');
        const data = await response.json();
        if (requestId !== resourceSearchRequestId) return;
        results.replaceChildren();
        if (!data.success) {
          results.appendChild(createResourceMessage(data.message || '搜索失败'));
          return;
        }
        if (!data.items || data.items.length === 0) {
          results.appendChild(createResourceMessage('没有匹配的资源'));
          return;
        }
        data.items.forEach(function (item) {
          results.appendChild(createResourceRow(item));
        });
      } catch (error) {
        if (requestId !== resourceSearchRequestId) return;
        results.replaceChildren(createResourceMessage('搜索失败: ' + error.message));
      }
    }

    function createResourceMessage(message) {
      const div = document.createElement('div');
      div.className = 'permission-empty';
      div.textContent = message;
      return div;
    }

    function createResourceRow(item) {
      const normalized = normalizeClientItem(item);
      const row = document.createElement('label');
      row.className = 'resource-row';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedPermissions.has(normalized.path);
      checkbox.addEventListener('change', function () {
        if (checkbox.checked) {
          addSelectedPermission(normalized);
        } else {
          selectedPermissions.delete(normalized.path);
          renderSelectedPermissions();
        }
      });

      const main = document.createElement('div');
      main.className = 'resource-main';
      const name = document.createElement('div');
      name.className = 'resource-name';
      name.textContent = (normalized.itemType === 'folder' ? '文件夹 ' : '文件 ') + normalized.name;
      const path = document.createElement('div');
      path.className = 'resource-path';
      path.textContent = normalized.path;
      main.appendChild(name);
      main.appendChild(path);

      const badge = document.createElement('span');
      badge.className = 'badge badge-info';
      badge.textContent = normalized.itemType === 'folder' ? '目录' : '文件';

      row.appendChild(checkbox);
      row.appendChild(main);
      row.appendChild(badge);
      return row;
    }

    function normalizeClientItem(item) {
      const isFolder = item.itemType === 'folder' || item.item_type === 'folder' || item.isFolder;
      return {
        path: item.path || '/',
        name: item.name || (item.path === '/' ? '根目录' : item.path),
        itemType: isFolder ? 'folder' : 'file'
      };
    }

    function addSelectedPermission(item) {
      if (!selectedPermissions.has(item.path)) {
        selectedPermissions.set(item.path, {
          path: item.path,
          name: item.name,
          itemType: item.itemType,
          preset: 'readonly',
          permissions: { ...permissionPresetFlags.readonly }
        });
      }
      renderSelectedPermissions();
    }

    function renderSelectedPermissions() {
      const list = document.getElementById('selectedPermissionList');
      if (!list) return;
      list.replaceChildren();
      if (selectedPermissions.size === 0) {
        list.appendChild(createResourceMessage('尚未选择授权资源'));
        return;
      }

      selectedPermissions.forEach(function (item) {
        const row = document.createElement('div');
        row.className = 'permission-row';

        const main = document.createElement('div');
        main.className = 'permission-main';
        const path = document.createElement('div');
        path.className = 'permission-path';
        path.textContent = item.path;
        const summary = document.createElement('div');
        summary.className = 'permission-summary';
        summary.textContent = (item.itemType === 'folder' ? '目录' : '文件') + ' · ' + summarizeClientPermissions(item.permissions);
        main.appendChild(path);
        main.appendChild(summary);

        const select = document.createElement('select');
        select.className = 'form-select';
        [
          ['readonly', '只读'],
          ['uploader', '可上传'],
          ['editor', '可编辑'],
          ['manager', '完全管理'],
          ['custom', '自定义']
        ].forEach(function (option) {
          const el = document.createElement('option');
          el.value = option[0];
          el.textContent = option[1];
          select.appendChild(el);
        });
        select.value = item.preset;
        select.addEventListener('change', function () {
          item.preset = select.value;
          if (select.value !== 'custom') {
            item.permissions = { ...permissionPresetFlags[select.value] };
          }
          renderSelectedPermissions();
        });

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn btn-sm btn-danger icon-btn';
        remove.textContent = '×';
        remove.addEventListener('click', function () {
          selectedPermissions.delete(item.path);
          renderSelectedPermissions();
          searchResources(document.getElementById('resourceSearchInput').value);
        });

        row.appendChild(main);
        row.appendChild(select);
        row.appendChild(remove);

        if (item.preset === 'custom') {
          row.appendChild(createPermissionChecks(item));
        }

        list.appendChild(row);
      });
    }

    function createPermissionChecks(item) {
      const checks = document.createElement('div');
      checks.className = 'permission-checks';
      Object.keys(permissionLabels).forEach(function (key) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!item.permissions[key];
        input.addEventListener('change', function () {
          item.permissions[key] = input.checked;
          if (['preview', 'download', 'upload', 'modify', 'delete', 'share'].includes(key) && input.checked) {
            item.permissions.view = true;
          }
          if (key === 'view' && !input.checked && ['preview', 'download', 'upload', 'modify', 'delete', 'share'].some(function (name) {
            return item.permissions[name];
          })) {
            item.permissions.view = true;
          }
          renderSelectedPermissions();
        });
        label.appendChild(input);
        label.appendChild(document.createTextNode(permissionLabels[key]));
        checks.appendChild(label);
      });
      return checks;
    }

    function summarizeClientPermissions(permissions) {
      return Object.keys(permissionLabels).filter(function (key) {
        return !!permissions[key];
      }).map(function (key) {
        return permissionLabels[key];
      }).join('、') || '无权限';
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
    initializeResourcePicker();
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
  <title>文件分享 - EdgeStashPro</title>
  ${THEME_BOOTSTRAP}
  ${CSS_STYLES}
</head>
<body>
  <div class="theme-toggle-floating">${THEME_TOGGLE_BUTTON}</div>
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
        <div class="share-header">
          <div class="share-title">
            <div class="share-icon">📁</div>
            <div class="share-filename" id="fileName"></div>
            <div class="share-filesize" id="fileSize"></div>
          </div>
        </div>
        <div id="passwordForm" style="display: none;">
          <div class="form-group">
            <label class="form-label" for="sharePassword">请输入分享密码</label>
            <input type="password" id="sharePassword" class="form-input" placeholder="输入密码" onkeydown="handlePasswordKey(event)">
          </div>
          <button type="button" class="btn btn-primary" style="width: 100%;" onclick="unlockShare()">进入分享</button>
        </div>
        <div class="share-browser" id="shareBrowser">
          <div class="breadcrumb" id="shareBreadcrumb"></div>
          <div id="shareFileList" class="file-grid"></div>
          <div id="shareEmptyState" class="empty-state" style="display: none;">
            <div class="empty-icon">📂</div>
            <div>此文件夹为空</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="toast-container" id="toastContainer"></div>

  <script>
    let shareId = '';
    let requiresPassword = false;
    let sharePassword = '';
    let currentPath = '/';

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
        document.getElementById('fileSize').textContent = data.itemCount > 1 ? data.itemCount + ' 个项目' : data.fileSizeFormatted;
        requiresPassword = !!data.requiresPassword;
        document.getElementById('passwordForm').style.display = requiresPassword ? 'block' : 'none';
        if (!requiresPassword) {
          await loadShareDirectory('/');
        }
      } catch (error) {
        showExpired();
      }
    }

    function showExpired() {
      document.getElementById('loadingState').style.display = 'none';
      document.getElementById('expiredState').style.display = 'block';
    }

    function handlePasswordKey(event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        unlockShare();
      }
    }

    async function unlockShare() {
      sharePassword = document.getElementById('sharePassword') ? document.getElementById('sharePassword').value : '';
      if (requiresPassword && !sharePassword) {
        showToast('请输入分享密码', 'error');
        return;
      }

      await loadShareDirectory('/');
    }

    async function loadShareDirectory(path) {
      try {
        const response = await fetch('/api/share/' + encodeURIComponent(shareId) + '/list', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: path || '/', password: sharePassword })
        });
        const data = await response.json();
        if (!data.success) {
          showToast(data.message || '加载失败', 'error');
          return;
        }

        currentPath = data.currentPath || path || '/';
        document.getElementById('passwordForm').style.display = 'none';
        document.getElementById('shareBrowser').classList.add('active');
        renderBreadcrumb();
        renderFiles(data.folders || [], data.files || []);
      } catch (error) {
        showToast('加载失败: ' + error.message, 'error');
      }
    }

    function renderBreadcrumb() {
      const breadcrumb = document.getElementById('shareBreadcrumb');
      breadcrumb.replaceChildren();

      const root = document.createElement('a');
      root.href = '#';
      root.className = 'breadcrumb-item';
      root.textContent = '分享根目录';
      root.addEventListener('click', function (event) {
        event.preventDefault();
        loadShareDirectory('/');
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
            loadShareDirectory(targetPath);
          });
          breadcrumb.appendChild(link);
        }
      });
    }

    function renderFiles(folders, files) {
      const fileList = document.getElementById('shareFileList');
      const emptyState = document.getElementById('shareEmptyState');
      fileList.replaceChildren();

      if (folders.length === 0 && files.length === 0) {
        emptyState.style.display = 'block';
        return;
      }

      emptyState.style.display = 'none';
      folders.forEach(function (folder) {
        fileList.appendChild(createShareFileCard({
          name: folder.name,
          path: folder.path,
          isFolder: true,
          typeLabel: '📁',
          meta: '文件夹'
        }));
      });

      files.forEach(function (file) {
        fileList.appendChild(createShareFileCard({
          name: file.name,
          path: file.path,
          isFolder: false,
          typeLabel: getFileIcon(file.name),
          meta: file.sizeFormatted || ''
        }));
      });
    }

    function createShareFileCard(item) {
      const card = document.createElement('div');
      card.className = 'file-item';
      card.addEventListener('click', function () {
        if (item.isFolder) {
          loadShareDirectory(item.path);
        } else {
          downloadFile(item.path);
        }
      });

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
      card.appendChild(meta);
      return card;
    }

    function getFileIcon(filename) {
      const ext = filename.split('.').pop().toLowerCase();
      if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) return '🖼️';
      if (ext === 'pdf') return '📕';
      if (['mp4', 'webm', 'ogg'].includes(ext)) return '🎬';
      if (['mp3', 'wav', 'flac', 'm4a'].includes(ext)) return '🎵';
      if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '📦';
      if (['doc', 'docx'].includes(ext)) return '📝';
      if (['xls', 'xlsx'].includes(ext)) return '📊';
      return '📄';
    }

    async function downloadFile(path) {
      if (requiresPassword && !sharePassword) {
        showToast('请输入分享密码', 'error');
        return;
      }

      try {
        const response = await fetch('/api/share/' + encodeURIComponent(shareId) + '/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: path, password: sharePassword })
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

        if (path === '/api/d1/init' && method === 'GET') {
          const auth = await verifyAuth(request, env);
          if (!auth) return jsonResponse({ success: false }, 401);
          const alreadyReady = d1SchemaReady || (env.KV_STORE ? await env.KV_STORE.get(D1_SCHEMA_KV_KEY) : null);
          if (alreadyReady) return jsonResponse({ success: true, initialized: false });
          await ensureD1Schema(env);
          return jsonResponse({ success: true, initialized: true });
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
          return await handleGetReaderProgress(request, env);
        }

        if (path === '/api/reader/progress' && method === 'PUT') {
          return await handlePutReaderProgress(request, env);
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

        if (path.match(/^\/api\/share\/[^/]+\/list$/) && method === 'POST') {
          const shareId = path.split('/')[3];
          return await handleShareList(request, env, shareId);
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

        if (path === '/api/admin/resources/search' && method === 'GET') {
          return await handleAdminSearchResources(request, env);
        }

        if (path === '/api/admin/resources/list' && method === 'GET') {
          return await handleAdminListResources(request, env);
        }

        if (path === '/api/admin/debug/storage' && method === 'GET') {
          return await handleAdminStorageDebug(request, env);
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
  }
};
