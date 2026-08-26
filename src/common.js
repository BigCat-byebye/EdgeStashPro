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
  } catch {
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
  } catch {
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

function isSafePathSegment(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 255
    && value !== '.'
    && value !== '..'
    && !/[\\/\u0000-\u001f\u007f]/.test(value);
}

function parentPathFromR2Key(key) {
  return parentPathFromItemPath(r2KeyToPath(key));
}

function isoDateString(value) {
  if (!value) return new Date().toISOString();
  if (typeof value.toISOString === 'function') return value.toISOString();
  return new Date(value).toISOString();
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
export const LEGACY_DEFAULT_STORAGE_ID = 'legacy-default';

export {
  generateId,
  hashPassword,
  base32Encode,
  base32Decode,
  generateOtpSecret,
  generateTotp,
  verifyTotp,
  createOtpUri,
  sha256Hex,
  createJWT,
  verifyJWT,
  getExpirationTime,
  formatFileSize,
  getMimeType,
  safeDecodePath,
  encodeRFC5987ValueChars,
  createAttachmentDisposition,
  createInlineDisposition,
  normalizeDirectoryPath,
  normalizeItemPath,
  directoryPathToR2Prefix,
  r2KeyToPath,
  parentPathFromItemPath,
  nameFromItemPath,
  isSafePathSegment,
  parentPathFromR2Key,
  isoDateString,
  getPreviewType,
  parseCookies,
  jsonResponse,
  missingRequiredConfig,
  requireRequiredConfig,
  htmlResponse
};
