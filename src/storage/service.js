import { decryptStorageCredentials } from './credentials.js';
import { resolveStorageConnection, StorageError } from './repository.js';
import { createS3Adapter, S3StorageError } from './s3.js';

function toLegacyObject(object) {
  if (!object) return null;
  const etag = String(object.etag || '').replace(/^"|"$/g, '');
  return {
    key: object.key,
    size: Number(object.size || 0),
    version: object.version || null,
    etag,
    httpEtag: object.etag || (etag ? `"${etag}"` : ''),
    uploaded: object.lastModified ? new Date(object.lastModified) : null,
    httpMetadata: { contentType: object.contentType || 'application/octet-stream' },
    body: object.body || null,
    range: object.range || undefined,
    writeHttpMetadata(headers) {
      if (object.contentType) headers.set('Content-Type', object.contentType);
    }
  };
}

export function createStorageFacade(adapter) {
  return {
    async head(key) {
      return toLegacyObject(await adapter.head(key));
    },
    async get(key, options = {}) {
      return toLegacyObject(await adapter.get(key, options));
    },
    async list(options = {}) {
      const listed = await adapter.list({
        prefix: options.prefix || '',
        cursor: options.cursor || null,
        limit: options.limit || 1000
      });
      let objects = listed.objects.map(toLegacyObject);
      const delimitedPrefixes = new Set();
      if (options.delimiter) {
        const direct = [];
        for (const object of objects) {
          const remainder = object.key.slice(String(options.prefix || '').length);
          const delimiterIndex = remainder.indexOf(options.delimiter);
          if (delimiterIndex < 0) direct.push(object);
          else delimitedPrefixes.add(String(options.prefix || '') + remainder.slice(0, delimiterIndex + options.delimiter.length));
        }
        objects = direct;
      }
      return {
        objects,
        delimitedPrefixes: [...delimitedPrefixes],
        cursor: listed.cursor,
        truncated: listed.truncated
      };
    },
    async put(key, body, options = {}) {
      const object = await adapter.put(key, body, { contentType: options.httpMetadata?.contentType });
      return toLegacyObject(object);
    },
    async delete(keys) {
      for (const key of (Array.isArray(keys) ? keys : [keys])) await adapter.delete(key);
    },
    async copy(sourceKey, targetKey) {
      return toLegacyObject(await adapter.copy(sourceKey, targetKey));
    }
  };
}

export async function createStorageRuntime(request, env, auth, options = {}) {
  const connection = await resolveStorageConnection(request, env, auth, options);
  const credentials = await decryptStorageCredentials(env.STORAGE_CONFIG_KEY, connection.id, connection);
  const adapter = createS3Adapter(connection, credentials);
  return {
    connection,
    adapter,
    env: {
      ...env,
      STORAGE_ID: connection.id,
      STORAGE_CONNECTION: connection,
      STORAGE: createStorageFacade(adapter)
    }
  };
}

export function isStorageRuntimeError(error) {
  return error instanceof StorageError || error instanceof S3StorageError || error?.code === 'STORAGE_CONFIG_KEY_INVALID';
}
