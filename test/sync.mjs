import assert from 'node:assert/strict';
import { ensureD1Schema } from '../src/db/schema.js';
import { encryptStorageCredentials } from '../src/storage/credentials.js';
import { enqueueStorageSync, processNextStorageSyncPage, runScheduledMaintenance } from '../src/storage/sync.js';

function makeFakeAdapter(pages) {
  let calls = 0;
  return {
    get calls() { return calls; },
    adapter: {
      async list() {
        const page = pages[Math.min(calls, pages.length - 1)];
        calls += 1;
        return page;
      },
      async head() { return null; },
      async get() { return null; },
      async put() { return null; },
      async copy() { return null; },
      async delete() {}
    }
  };
}

class MemoryKV {
  constructor() { this.v = new Map(); }
  async get(k, t) { const v = this.v.get(k); if (t === 'json') { try { return JSON.parse(v); } catch { return null; } } return v ?? null; }
  async put(k, v) { this.v.set(k, String(v)); }
  async delete(k) { this.v.delete(k); }
  async list() { return { keys: [], list_complete: true }; }
}

class MemoryD1Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { const next = new MemoryD1Statement(this.db, this.sql); next.args = args; return next; }
  async run() { return this.db.run(this.sql, this.args); }
  async first() { const r = await this.db.all(this.sql, this.args); return r.results[0] || null; }
  async all() { return this.db.all(this.sql, this.args); }
}

class MemoryD1 {
  constructor() { this.tables = new Map(); this.columns = new Map(); }
  prepare(sql) { return new MemoryD1Statement(this, sql); }
  async batch(statements) { for (const s of statements) await s.run(); return { success: true }; }
  ensureTable(name) { const t = name.toLowerCase(); if (!this.tables.has(t)) this.tables.set(t, []); if (!this.columns.has(t)) this.columns.set(t, []); return t; }
  async run(sql, args) {
    const text = sql.trim();
    const lower = text.toLowerCase().replace(/\s+/g, ' ');
    const create = text.match(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/i);
    if (create) {
      const table = this.ensureTable(create[1]);
      const body = text.match(/\(([\s\S]*)\)/)?.[1] || '';
      for (const part of body.split(',')) {
        const column = part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s+/);
        if (column && !/^(PRIMARY|UNIQUE|CONSTRAINT|FOREIGN|CHECK)$/i.test(column[1]) && !this.columns.get(table).includes(column[1])) {
          this.columns.get(table).push(column[1]);
        }
      }
      return { success: true };
    }
    if (lower.startsWith('create index')) return { success: true };
    const insert = text.match(/INSERT(?: OR IGNORE)? INTO\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
    if (insert) {
      const table = this.ensureTable(insert[1]);
      const columns = insert[2].split(',').map(c => c.trim());
      const valueParts = insert[3].split(',').map(v => v.trim());
      const row = {};
      let argIndex = 0;
      valueParts.forEach((part, i) => {
        row[columns[i]] = part === '?' ? args[argIndex++] : part.replace(/^'|'$/g, '');
      });
      this.tables.get(table).push(row);
      return { success: true };
    }
    if (lower.startsWith('update')) {
      const table = this.ensureTable(text.match(/UPDATE\s+([A-Za-z_][A-Za-z0-9_]*)/i)[1]);
      const rows = this.tables.get(table) || [];
      if (table === 'storage_sync_jobs') {
        const idMatch = lower.match(/where id = \?/);
        const idIndex = idMatch ? lower.slice(0, idMatch.index).split('?').length - 1 : args.length - 1;
        const job = rows.find(r => r.id === args[idIndex]);
        if (job) {
          if (lower.includes('set status = ?, continuation_token = ?')) {
            job.status = args[0];
            job.continuation_token = args[1];
          } else if (lower.includes("set status = 'queued'")) {
            job.status = 'queued';
            job.error_message = null;
            job.completed_at = null;
          } else if (lower.includes('set status = ?, lease_token = ?')) {
            job.status = args[0];
            job.lease_token = args[1];
            job.lease_expires_at = args[2];
            job.started_at = job.started_at || args[3];
          } else if (lower.includes("set status = 'failed'")) {
            job.status = 'failed';
            job.error_message = args[0];
            job.completed_at = args[1];
          } else if (lower.includes("set status = 'canceled'")) {
            job.status = 'canceled';
            job.completed_at = args[0];
          }
          job.updated_at = Date.now();
        }
        return { success: true, meta: { changes: job ? 1 : 0 } };
      }
      return { success: true, meta: { changes: 1 } };
    }
    if (lower.startsWith('delete from')) {
      const table = this.ensureTable(text.match(/DELETE FROM\s+([A-Za-z_][A-Za-z0-9_]*)/i)[1]);
      const rows = this.tables.get(table);
      if (table === 'search_items') {
        const storageId = args[0];
        this.tables.set(table, rows.filter(r => r.storage_id !== storageId));
      } else if (table === 'storage_sync_jobs') {
        this.tables.set(table, []);
      }
      return { success: true };
    }
    return { success: true };
  }
  async all(sql, args) {
    const text = sql.trim();
    const lower = text.toLowerCase();
    const compact = lower.replace(/\s+/g, ' ');
    const pragma = text.match(/PRAGMA table_info\(([A-Za-z_][A-Za-z0-9_]*)\)/i);
    if (pragma) { const t = this.ensureTable(pragma[1]); return { results: this.columns.get(t).map(n => ({ name: n })) }; }
    const table = text.match(/(?:FROM|INTO|UPDATE|DELETE FROM)\s+([A-Za-z_][A-Za-z0-9_]*)/i)?.[1]?.toLowerCase() || this.ensureTable('unknown');
    const rows = this.tables.get(table) || [];
    if (table === 'schema_migrations') return { results: rows };
    if (compact.includes('from storage_connections')) {
      return { results: rows.filter(r => r.id === args[0]) };
    }
    if (table === 'storage_sync_jobs') {
      if (compact.includes('where id = ?')) return { results: rows.filter(r => r.id === args[0]) };
      if (compact.includes('order by updated_at desc limit 1')) return { results: rows.filter(r => r.storage_id === args[0]).sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0)).slice(0, 1) };
      if (compact.includes('order by updated_at asc limit 1')) {
        const now = Number(args[0] || 0);
        const candidates = rows.filter(r => r.status === 'queued' || (r.status === 'running' && Number(r.lease_expires_at || 0) < now));
        return { results: candidates.sort((a, b) => (a.updated_at || 0) - (b.updated_at || 0)).slice(0, 1) };
      }
      if (compact.includes('where storage_id = ? and status in')) return { results: rows.filter(r => r.storage_id === args[0] && ['queued', 'running'].includes(r.status)) };
      if (compact.includes('where storage_id = ? and scope_prefix = ? and status = \'failed\'')) return { results: rows.filter(r => r.storage_id === args[0] && r.scope_prefix === args[1] && r.status === 'failed') };
      return { results: rows };
    }
    if (table === 'search_items') {
      if (compact.includes('count(*) as count')) return { results: [{ count: rows.length }] };
      if (compact.includes('where storage_id = ? and path = ?')) return { results: rows.filter(r => r.storage_id === args[0] && r.path === args[1]) };
      if (compact.includes('last_seen_scan_id') && compact.includes('order by length(path) desc')) {
        return { results: rows.filter(r => r.storage_id === args[0] && r.last_seen_scan_id !== args[1] && Number(r.updated_at || 0) < Number(args[2] || 0)) };
      }
      if (compact.includes('path in (')) {
        const wanted = new Set(args.slice(1));
        return { results: rows.filter(r => r.storage_id === args[0] && wanted.has(r.path)) };
      }
      return { results: rows };
    }
    return { results: rows };
  }
}

const master = Buffer.alloc(32, 9).toString('base64');
const d1 = new MemoryD1();
const env = {
  ADMIN_PASSWORD: 'test-secret',
  STORAGE_CONFIG_KEY: master,
  KV_STORE: new MemoryKV(),
  D1_DB: d1
};

await ensureD1Schema(env);
assert.ok((await d1.all('SELECT * FROM schema_migrations')).results.some(r => r.id === '007_multi_storage'), 'multi-storage migration marker must be recorded');

const encA = await encryptStorageCredentials(master, 'storage-a', { accessKeyId: 'ak', secretAccessKey: 'sk' });
const encB = await encryptStorageCredentials(master, 'storage-b', { accessKeyId: 'bk', secretAccessKey: 'bk-secret' });
await d1.prepare(`INSERT INTO storage_connections (id, name, provider, endpoint, region, bucket, addressing_style, credentials_ciphertext, credentials_iv, credential_version, enabled, is_default, sync_interval_minutes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind('storage-a', 'A', 's3', 'https://example.test', 'auto', 'a-dev', 'path', encA.ciphertext, encA.iv, 1, 1, 1, 1440, Date.now(), Date.now()).run();
await d1.prepare(`INSERT INTO storage_connections (id, name, provider, endpoint, region, bucket, addressing_style, credentials_ciphertext, credentials_iv, credential_version, enabled, is_default, sync_interval_minutes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind('storage-b', 'B', 's3', 'https://example.test', 'auto', 'b-dev', 'path', encB.ciphertext, encB.iv, 1, 1, 0, 0, Date.now(), Date.now()).run();

const pageOne = {
  objects: [
    { key: 'same.txt', size: 4, etag: '"etag-a"', lastModified: '2026-08-23T00:00:00Z' },
    { key: 'book/one.txt', size: 10, etag: '"etag-one"', lastModified: '2026-08-23T00:00:00Z' },
    { key: 'empty-folder/', size: 0, etag: '"empty-folder"', lastModified: '2026-08-23T00:00:00Z' }
  ],
  cursor: 'TOKEN-1',
  truncated: true
};
const pageTwo = {
  objects: [{ key: 'book/two.txt', size: 11, etag: '"etag-two"', lastModified: '2026-08-23T00:00:00Z' }],
  cursor: null,
  truncated: false
};
const fakeA = makeFakeAdapter([pageOne, pageTwo]);
const fakeB = makeFakeAdapter([{ objects: [{ key: 'same.txt', size: 5, etag: '"etag-b"', lastModified: '2026-08-23T00:00:00Z' }], cursor: null, truncated: false }]);
const scopedA = { ...env, SYNC_ADAPTER_FACTORY: () => fakeA.adapter };
const scopedB = { ...env, SYNC_ADAPTER_FACTORY: () => fakeB.adapter };

await enqueueStorageSync(scopedA, 'storage-a', { requestedBy: 'test' });
await runScheduledMaintenance(scopedA, Date.now(), null);
let job = (await d1.prepare('SELECT * FROM storage_sync_jobs WHERE storage_id = ? ORDER BY updated_at DESC LIMIT 1').bind('storage-a').all()).results[0];
assert.equal(job.status, 'queued', 'first page must leave the job queued with a cursor');
assert.equal(job.continuation_token, 'TOKEN-1');
const remaining = await processNextStorageSyncPage(scopedA);
assert.ok(remaining && remaining.done, 'second page must complete storage-a');
job = (await d1.prepare('SELECT * FROM storage_sync_jobs WHERE storage_id = ? ORDER BY updated_at DESC LIMIT 1').bind('storage-a').all()).results[0];
assert.equal(job.status, 'succeeded', 'completed sync must be marked succeeded');
assert.equal(job.continuation_token, null);

await enqueueStorageSync(scopedB, 'storage-b', { requestedBy: 'test' });
const bRemaining = await processNextStorageSyncPage(scopedB);
assert.ok(bRemaining && bRemaining.done, 'storage-b sync must complete');
const aRows = d1.tables.get('search_items').filter(r => r.storage_id === 'storage-a');
const bRows = d1.tables.get('search_items').filter(r => r.storage_id === 'storage-b');
assert.ok(aRows.some(r => r.path === '/same.txt' && r.resource_etag === '"etag-a"'), 'storage-a catalog must carry its own same.txt identity');
assert.ok(aRows.some(r => r.path === '/empty-folder' && r.item_type === 'folder'), 'trailing-slash directory objects must become folder rows, not zero-byte files');
assert.equal(aRows.find(r => r.path === '/same.txt')?.size, 4, 'remote file size must be preserved in D1');
assert.ok(bRows.some(r => r.path === '/same.txt' && r.resource_etag === '"etag-b"'), 'storage-b catalog must carry its own same.txt identity');
assert.ok(aRows.some(r => r.path === '/book/two.txt'), 'storage-a must ingest second page');
assert.ok(!bRows.some(r => r.path === '/book/one.txt'), 'storage-b must only ingest its own page');
assert.equal(fakeB.calls, 1, 'storage-b must be scanned exactly once for its own job');

console.log('sync: two-storage isolation, pagination, and per-storage scheduling contracts passed');
