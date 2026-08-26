const CREDENTIAL_VERSION = 1;
const IV_BYTES = 12;

export class StorageConfigKeyError extends Error {
  constructor(message = 'STORAGE_CONFIG_KEY 无效') {
    super(message);
    this.name = 'StorageConfigKeyError';
    this.code = 'STORAGE_CONFIG_KEY_INVALID';
  }
}

function decodeBase64(value) {
  try {
    const binary = atob(String(value || '').trim());
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    throw new StorageConfigKeyError();
  }
}

async function importMasterKey(value) {
  const bytes = decodeBase64(value);
  if (bytes.byteLength !== 32) throw new StorageConfigKeyError('STORAGE_CONFIG_KEY 必须是 base64 编码的 32 字节密钥');
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function credentialAad(storageId) {
  return new TextEncoder().encode(`edgestash:storage:${storageId}:v${CREDENTIAL_VERSION}`);
}

export function normalizeStorageCredentials(input) {
  const accessKeyId = String(input?.accessKeyId || '').trim();
  const secretAccessKey = String(input?.secretAccessKey || '').trim();
  const sessionToken = String(input?.sessionToken || '').trim();
  if (!accessKeyId || !secretAccessKey) throw new Error('Access Key ID 和 Secret Access Key 不能为空');
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

export async function encryptStorageCredentials(masterKeyValue, storageId, input) {
  const key = await importMasterKey(masterKeyValue);
  const credentials = normalizeStorageCredentials(input);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(credentials));
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: credentialAad(storageId),
    tagLength: 128
  }, key, plaintext);
  return {
    ciphertext: new Uint8Array(ciphertext),
    iv,
    version: CREDENTIAL_VERSION
  };
}

// D1 binds BLOB parameters correctly when given an ArrayBuffer; Uint8Array
// values can be serialized as JSON objects on the wire and corrupt the stored
// ciphertext. Convert before persisting.
export function storageCredentialsForDb(encrypted) {
  return {
    ciphertext: encrypted.ciphertext.buffer.slice(
      encrypted.ciphertext.byteOffset,
      encrypted.ciphertext.byteOffset + encrypted.ciphertext.byteLength
    ),
    iv: encrypted.iv.buffer.slice(
      encrypted.iv.byteOffset,
      encrypted.iv.byteOffset + encrypted.iv.byteLength
    ),
    version: encrypted.version
  };
}

function toBytes(value) {
  if (value == null) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (typeof value === 'string') {
    const bytes = new Uint8Array(value.length);
    for (let index = 0; index < value.length; index += 1) bytes[index] = value.charCodeAt(index) & 255;
    return bytes;
  }
  return null;
}

export async function decryptStorageCredentials(masterKeyValue, storageId, row) {
  const ciphertext = toBytes(row?.credentials_ciphertext);
  const iv = toBytes(row?.credentials_iv);
  if (!ciphertext || !iv) {
    throw new StorageConfigKeyError('存储凭证尚未配置');
  }
  if (Number(row.credential_version || 0) !== CREDENTIAL_VERSION) {
    throw new StorageConfigKeyError('存储凭证版本不受支持');
  }
  const key = await importMasterKey(masterKeyValue);
  try {
    const plaintext = await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv,
      additionalData: credentialAad(storageId),
      tagLength: 128
    }, key, ciphertext);
    return normalizeStorageCredentials(JSON.parse(new TextDecoder().decode(plaintext)));
  } catch (error) {
    if (error instanceof StorageConfigKeyError) throw error;
    throw new StorageConfigKeyError('存储凭证无法解密，请重新输入凭证');
  }
}
