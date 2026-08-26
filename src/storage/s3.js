import { AwsClient } from 'aws4fetch';
import { XMLParser } from 'fast-xml-parser';

const MAX_XML_BYTES = 1024 * 1024;
const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  isArray: name => name === 'Contents'
});

export class S3StorageError extends Error {
  constructor(code, message, status = 502, upstreamStatus = null) {
    super(message);
    this.name = 'S3StorageError';
    this.code = code;
    this.status = status;
    this.upstreamStatus = upstreamStatus;
  }
}

function encodePath(value) {
  return String(value || '').split('/').map(part => encodeURIComponent(part)).join('/');
}

function normalizeEtag(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  return `"${text.replace(/^"|"$/g, '')}"`;
}

async function readTextLimited(response, maxBytes = MAX_XML_BYTES) {
  if (!response.body) return '';
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new S3StorageError('STORAGE_UPSTREAM_ERROR', 'S3 元数据响应过大', 502, response.status);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    total += bytes.byteLength;
    if (total > maxBytes) {
      await reader.cancel('metadata response too large').catch(() => {});
      throw new S3StorageError('STORAGE_UPSTREAM_ERROR', 'S3 元数据响应过大', 502, response.status);
    }
    chunks.push(bytes);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function objectFromHeaders(key, headers, body = null) {
  return {
    key,
    size: Number(headers.get('content-length') || 0),
    etag: normalizeEtag(headers.get('etag')),
    version: headers.get('x-amz-version-id') || null,
    lastModified: headers.get('last-modified') || null,
    contentType: headers.get('content-type') || null,
    body
  };
}

function mapStatus(status, code = null) {
  if (status === 404) return new S3StorageError('STORAGE_OBJECT_NOT_FOUND', '文件不存在', 404, status);
  if (status === 416) return new S3StorageError('STORAGE_RANGE_INVALID', '请求范围无效', 416, status);
  if (status === 401 || status === 403) {
    if (code === 'SecondLevelDomainForbidden') {
      return new S3StorageError('STORAGE_VIRTUAL_HOST_REQUIRED', '该服务要求使用 Virtual host 寻址方式（例如阿里云 OSS）。请在存储配置中选择「Virtual host style」后重试', 502, status);
    }
    if (code === 'AccessDenied' || code === 'InvalidAccessKeyId' || code === 'SignatureDoesNotMatch') {
      return new S3StorageError('STORAGE_CREDENTIALS_REJECTED', '存储服务拒绝了访问凭据（AccessKey/Secret 无效、过期或权限不足），请检查后重试', 502, status);
    }
    return new S3StorageError('STORAGE_UPSTREAM_ERROR', 'S3 凭证无效或权限不足', 502, status);
  }
  if (status === 429) return new S3StorageError('STORAGE_UPSTREAM_ERROR', 'S3 请求过于频繁', 503, status);
  return new S3StorageError('STORAGE_UPSTREAM_ERROR', 'S3 上游请求失败', status >= 500 ? 503 : 502, status);
}

function decodeListedKey(value) {
  try {
    return decodeURIComponent(String(value || '').replace(/\+/g, '%20'));
  } catch {
    return String(value || '');
  }
}

export function createS3Adapter(connection, credentials, fetchImpl = globalThis.fetch) {
  const client = new AwsClient({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    service: 's3',
    region: connection.region || 'auto',
    retries: 0
  });
  const endpoint = new URL(connection.endpoint);
  const bucket = connection.bucket;
  const addressingStyle = connection.addressing_style || connection.addressingStyle || 'path';

  function objectUrl(key = '') {
    const url = new URL(endpoint.toString());
    const basePath = url.pathname.replace(/\/+$/, '');
    if (addressingStyle === 'virtual') {
      url.hostname = `${bucket}.${url.hostname}`;
      url.pathname = `${basePath}/${encodePath(key)}`.replace(/\/+/g, '/');
    } else {
      url.pathname = `${basePath}/${encodeURIComponent(bucket)}/${encodePath(key)}`.replace(/\/+/g, '/');
    }
    return url;
  }

  async function signedFetch(url, init = {}) {
    const signed = await client.sign(url, {
      ...init,
      redirect: 'manual',
      aws: { service: 's3', region: connection.region || 'auto' }
    });
    return fetchImpl(signed);
  }

  async function requireSuccess(response, { allowNotFound = false } = {}) {
    if (response.ok) return response;
    if (allowNotFound && response.status === 404) return null;
    let code = null;
    if (response.status >= 400 && response.status < 500 && response.headers.get('content-type')?.includes('xml')) {
      try {
        const text = await readTextLimited(response, 64 * 1024);
        const parsed = xmlParser.parse(text);
        code = parsed?.Error?.Code || parsed?.Code || null;
      } catch {
        code = null;
      }
    }
    throw mapStatus(response.status, code);
  }

  return {
    id: connection.id,
    kind: 's3',

    async head(key) {
      const response = await signedFetch(objectUrl(key), { method: 'HEAD' });
      if (response.status === 404) return null;
      await requireSuccess(response);
      return objectFromHeaders(key, response.headers);
    },

    async get(key, options = {}) {
      const headers = new Headers();
      const range = options.range;
      if (range instanceof Headers) {
        const value = range.get('Range');
        if (value) headers.set('Range', value);
      } else if (range && Number.isFinite(Number(range.offset))) {
        const offset = Math.max(0, Number(range.offset));
        const length = Number(range.length);
        headers.set('Range', Number.isFinite(length) && length > 0
          ? `bytes=${offset}-${offset + length - 1}`
          : `bytes=${offset}-`);
      }
      const response = await signedFetch(objectUrl(key), { method: 'GET', headers });
      if (response.status === 404) return null;
      if (!response.ok && response.status !== 206) throw mapStatus(response.status);
      const object = objectFromHeaders(key, response.headers, response.body);
      object.range = response.headers.get('content-range') || null;
      object.responseHeaders = response.headers;
      return object;
    },

    async list({ prefix = '', cursor = null, limit = 1000 } = {}) {
      const url = objectUrl('');
      url.searchParams.set('list-type', '2');
      url.searchParams.set('encoding-type', 'url');
      url.searchParams.set('max-keys', String(Math.min(1000, Math.max(1, Number(limit) || 1000))));
      if (prefix) url.searchParams.set('prefix', prefix);
      if (cursor) url.searchParams.set('continuation-token', cursor);
      const response = await signedFetch(url, { method: 'GET' });
      await requireSuccess(response);
      const text = await readTextLimited(response);
      const parsed = xmlParser.parse(text)?.ListBucketResult || {};
      const contents = Array.isArray(parsed.Contents) ? parsed.Contents : (parsed.Contents ? [parsed.Contents] : []);
      return {
        objects: contents.map(item => ({
          key: decodeListedKey(item.Key),
          size: Number(item.Size || 0),
          etag: normalizeEtag(item.ETag),
          version: null,
          lastModified: item.LastModified || null,
          contentType: null
        })),
        cursor: parsed.NextContinuationToken || null,
        truncated: String(parsed.IsTruncated || '').toLowerCase() === 'true'
      };
    },

    async put(key, body, options = {}) {
      const headers = new Headers();
      if (options.contentType) headers.set('Content-Type', options.contentType);
      const response = await signedFetch(objectUrl(key), { method: 'PUT', headers, body });
      await requireSuccess(response);
      return objectFromHeaders(key, response.headers);
    },

    async copy(sourceKey, targetKey) {
      const headers = new Headers({
        'x-amz-copy-source': `/${encodeURIComponent(bucket)}/${encodePath(sourceKey)}`
      });
      const response = await signedFetch(objectUrl(targetKey), { method: 'PUT', headers });
      await requireSuccess(response);
      const text = await readTextLimited(response);
      const parsed = text ? xmlParser.parse(text) : {};
      if (parsed?.Error) throw new S3StorageError('STORAGE_UPSTREAM_ERROR', 'S3 CopyObject 失败', 502, response.status);
      return {
        ...objectFromHeaders(targetKey, response.headers),
        etag: normalizeEtag(parsed?.CopyObjectResult?.ETag || response.headers.get('etag')),
        lastModified: parsed?.CopyObjectResult?.LastModified || response.headers.get('last-modified') || null
      };
    },

    async delete(key) {
      const response = await signedFetch(objectUrl(key), { method: 'DELETE' });
      if (response.status === 404) return;
      await requireSuccess(response);
    }
  };
}
