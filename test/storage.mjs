import assert from 'node:assert/strict';
import { decryptStorageCredentials, encryptStorageCredentials } from '../src/storage/credentials.js';
import { normalizeStorageInput } from '../src/storage/repository.js';
import { createS3Adapter } from '../src/storage/s3.js';

const master = Buffer.alloc(32, 7).toString('base64');
const credentials = {
  accessKeyId: 'dev-access-key',
  secretAccessKey: 'dev-secret-key',
  sessionToken: 'dev-session-token'
};
const encrypted = await encryptStorageCredentials(master, 'storage-a', credentials);
assert.equal(encrypted.iv.byteLength, 12);
assert.ok(!Buffer.from(encrypted.ciphertext).toString('utf8').includes(credentials.secretAccessKey));
assert.deepEqual(await decryptStorageCredentials(master, 'storage-a', {
  credentials_ciphertext: encrypted.ciphertext,
  credentials_iv: encrypted.iv,
  credential_version: encrypted.version
}), credentials);

// D1 returns BLOB columns as plain number arrays; decryption must accept them.
assert.deepEqual(await decryptStorageCredentials(master, 'storage-a', {
  credentials_ciphertext: Array.from(encrypted.ciphertext),
  credentials_iv: Array.from(encrypted.iv),
  credential_version: encrypted.version
}), credentials, 'decryption must accept D1 plain-array BLOB values');
await assert.rejects(
  decryptStorageCredentials(Buffer.alloc(32, 8).toString('base64'), 'storage-a', {
    credentials_ciphertext: encrypted.ciphertext,
    credentials_iv: encrypted.iv,
    credential_version: encrypted.version
  }),
  error => error.code === 'STORAGE_CONFIG_KEY_INVALID'
);

const anyBucket = normalizeStorageInput({
  name: 'prod',
  endpoint: 'https://example.test',
  region: 'auto',
  bucket: 'production-bucket',
  addressingStyle: 'path',
  syncIntervalMinutes: 1440
}, { ENVIRONMENT: 'dev' });
assert.equal(anyBucket.bucket, 'production-bucket', 'dev environment must accept any bucket name without suffix restriction');

const normalized = normalizeStorageInput({
  name: 'dev',
  endpoint: 'https://account.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'files-dev',
  addressingStyle: 'path',
  syncIntervalMinutes: 1440
}, { ENVIRONMENT: 'dev' });
assert.equal(normalized.bucket, 'files-dev');

const calls = [];
const encoder = new TextEncoder();
const fetchMock = async request => {
  calls.push(request);
  assert.match(request.headers.get('authorization') || '', /^AWS4-HMAC-SHA256 /);
  const url = new URL(request.url);
  if (request.method === 'GET' && url.searchParams.get('list-type') === '2') {
    return new Response(`<?xml version="1.0" encoding="UTF-8"?>
      <ListBucketResult>
        <IsTruncated>false</IsTruncated>
        <Contents><Key>same.txt</Key><LastModified>2026-08-23T00:00:00Z</LastModified><ETag>&quot;etag-a&quot;</ETag><Size>4</Size></Contents>
      </ListBucketResult>`, { status: 200, headers: { 'Content-Type': 'application/xml' } });
  }
  if (request.method === 'GET') {
    return new Response(encoder.encode('data'), {
      status: 200,
      headers: { 'Content-Length': '4', ETag: '"etag-a"', 'Content-Type': 'text/plain' }
    });
  }
  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers: { 'Content-Length': '4', ETag: '"etag-a"' } });
  }
  if (request.method === 'PUT' && request.headers.has('x-amz-copy-source')) {
    return new Response('<CopyObjectResult><ETag>&quot;etag-copy&quot;</ETag></CopyObjectResult>', { status: 200 });
  }
  return new Response(null, { status: 200, headers: { ETag: '"etag-put"' } });
};

const adapter = createS3Adapter({
  id: 'storage-a',
  endpoint: normalized.endpoint,
  region: normalized.region,
  bucket: normalized.bucket,
  addressing_style: normalized.addressingStyle
}, credentials, fetchMock);
const listed = await adapter.list({ limit: 1 });
assert.equal(listed.objects[0].key, 'same.txt');
assert.equal(listed.objects[0].etag, '"etag-a"');
const object = await adapter.get('same.txt', { range: { offset: 1, length: 2 } });
assert.equal(await new Response(object.body).text(), 'data');
assert.equal(calls.at(-1).headers.get('range'), 'bytes=1-2');
assert.equal((await adapter.head('same.txt')).size, 4);
assert.equal((await adapter.copy('same.txt', 'copy.txt')).etag, '"etag-copy"');
await adapter.put('upload.txt', new ReadableStream({
  start(controller) {
    controller.enqueue(encoder.encode('upload'));
    controller.close();
  }
}), { contentType: 'text/plain' });
assert.equal(calls.at(-1).headers.get('x-amz-content-sha256'), 'UNSIGNED-PAYLOAD');

// Aliyun OSS: virtual-host addressing must put the bucket in the hostname,
// and SecondLevelDomainForbidden must produce a targeted actionable error.
const ossCalls = [];
const ossFetch = async request => {
  ossCalls.push(request);
  assert.ok(request.url.includes('nextcloud-273691735.oss-cn-hongkong.aliyuncs.com'), 'OSS requests must use virtual-host addressing');
  assert.equal(request.headers.get('authorization').includes('/oss-cn-hongkong/s3/'), true, 'OSS SigV4 must carry the region and s3 service in the credential scope');
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Error><Code>SecondLevelDomainForbidden</Code><Message>Please use virtual hosted style to access.</Message></Error>', {
    status: 403,
    headers: { 'Content-Type': 'application/xml' }
  });
};
const ossAdapter = createS3Adapter({
  id: 'oss-a',
  endpoint: 'https://oss-cn-hongkong.aliyuncs.com',
  region: 'oss-cn-hongkong',
  bucket: 'nextcloud-273691735',
  addressing_style: 'virtual'
}, credentials, ossFetch);
await assert.rejects(ossAdapter.list({ limit: 1 }), error => {
  assert.equal(error.code, 'STORAGE_VIRTUAL_HOST_REQUIRED');
  assert.match(error.message, /Virtual host style/);
  return true;
});
assert.equal(ossCalls.length, 1);

console.log('storage: encryption, dev isolation, SigV4, XML, Range, streaming and OSS virtual-host contracts passed');
