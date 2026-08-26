import assert from 'node:assert/strict';
import { ensureD1Schema } from '../src/db/schema.js';
import { encryptStorageCredentials } from '../src/storage/credentials.js';

function makeTable(db, name, rows) {
  db.tables.set(name, rows);
  db.columns.set(name, Object.keys(rows[0] || {}));
  return name;
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
    const create = text.match(/CREATE TABLE (?:IF NOT EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/i);
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
    const alterRename = text.match(/ALTER TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+RENAME TO\s+([A-Za-z_][A-Za-z0-9_]*)/i);
    if (alterRename) {
      const source = alterRename[1].toLowerCase();
      const target = alterRename[2].toLowerCase();
      this.tables.set(target, this.tables.get(source) || []);
      this.columns.set(target, this.columns.get(source) || []);
      this.tables.delete(source);
      this.columns.delete(source);
      return { success: true };
    }
    if (lower.startsWith('drop table')) {
      const table = text.match(/DROP TABLE\s+([A-Za-z_][A-Za-z0-9_]*)/i)?.[1]?.toLowerCase();
      if (table) { this.tables.delete(table); this.columns.delete(table); }
      return { success: true };
    }
    const insertSelect = text.match(/INSERT(?: OR IGNORE)? INTO\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([^)]+)\)\s*)?SELECT\s+([\s\S]+?)\s*FROM\s+([A-Za-z_][A-Za-z0-9_]*)/i);
    if (insertSelect) {
      const table = this.ensureTable(insertSelect[1]);
      const columns = (insertSelect[2] || this.columns.get(table).join(',')).split(',').map(c => c.trim());
      const selectParts = insertSelect[3].split(',').map(p => p.trim());
      const sourceRows = this.tables.get(insertSelect[4].toLowerCase()) || [];
      for (const src of sourceRows) {
        const row = {};
        selectParts.forEach((part, i) => {
          const quoted = part.match(/^'([^']*)'$/);
          row[columns[i]] = quoted ? quoted[1] : (src[part] === undefined ? null : src[part]);
        });
        const rows = this.tables.get(table);
        const existing = rows.find(r => r.storage_id === row.storage_id && r.path === row.path);
        if (existing) Object.assign(existing, row); else rows.push(row);
      }
      return { success: true };
    }
    const insert = text.match(/INSERT(?: OR IGNORE)? INTO\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
    if (insert) {
      const table = this.ensureTable(insert[1]);
      const columns = insert[2].split(',').map(c => c.trim());
      const valueParts = insert[3].split(',').map(v => v.trim());
      const row = {};
      let argIndex = 0;
      valueParts.forEach((part, i) => { row[columns[i]] = part === '?' ? args[argIndex++] : part.replace(/^'|'$/g, ''); });
      const rows = this.tables.get(table);
      if (table === 'search_items') {
        const existing = rows.find(r => r.storage_id === row.storage_id && r.path === row.path);
        if (existing) Object.assign(existing, row); else rows.push(row);
      } else if (table === 'storage_connections' && !rows.some(r => r.id === row.id)) {
        rows.push(row);
      } else if (table !== 'storage_connections') {
        rows.push(row);
      }
      return { success: true };
    }
    if (lower.startsWith('update')) {
      const table = this.ensureTable(text.match(/UPDATE\s+([A-Za-z_][A-Za-z0-9_]*)/i)[1]);
      const rows = this.tables.get(table) || [];
      if (table === 'storage_connections') {
        const idIndex = lower.includes('where id = ?') ? args.length - 1 : -1;
        if (lower.includes('deleted_at = ?') && lower.includes('last_sync_status')) {
          const row = rows.find(r => r.id === args[idIndex]);
          if (row) { row.deleted_at = args[0]; row.enabled = 0; row.is_default = 0; row.credentials_ciphertext = null; row.credentials_iv = null; }
        } else if (lower.includes('set is_default = 0')) {
          rows.forEach(r => { r.is_default = 0; });
        } else if (lower.includes('set is_default = 1')) {
          const row = rows.find(r => r.id === args[idIndex]);
          if (row) row.is_default = 1;
        } else {
          const row = rows.find(r => r.id === args[args.length - 1]);
          if (row) {
            if (lower.includes('set enabled = 0')) row.enabled = 0;
            if (lower.includes('credentials_ciphertext = null')) { row.credentials_ciphertext = null; row.credentials_iv = null; }
          }
        }
      } else if (table === 'share_links' && lower.includes('set revoked_at')) {
        const shareId = lower.includes('where share_id = ?') ? args[args.length - 1] : null;
        if (shareId) rows.forEach(r => { if (r.share_id === shareId) r.revoked_at = args[0]; });
      }
      return { success: true, meta: { changes: 1 } };
    }
    if (lower.startsWith('delete from')) {
      const table = this.ensureTable(text.match(/DELETE FROM\s+([A-Za-z_][A-Za-z0-9_]*)/i)[1]);
      const rows = this.tables.get(table);
      if (table === 'search_items' || table === 'user_permissions' || table === 'favorites' || table === 'recent_items' || table === 'reader_bookmarks' || table === 'reader_progress' || table === 'txt_index_chunks' || table === 'txt_index_files' || table === 'app_stats') {
        this.tables.set(table, rows.filter(r => r.storage_id !== args[0]));
      } else if (table === 'share_links') {
        this.tables.set(table, rows.filter(r => r.share_id !== args[0]));
      } else if (table === 'storage_connections') {
        this.tables.set(table, rows.filter(r => r.id !== args[0]));
      }
      return { success: true };
    }
    return { success: true };
  }
  async all(sql, args) {
    const text = sql.trim();
    const lower = text.toLowerCase().replace(/\s+/g, ' ');
    const pragma = text.match(/PRAGMA table_info\(([A-Za-z_][A-Za-z0-9_]*)\)/i);
    if (pragma) { const t = this.ensureTable(pragma[1]); return { results: this.columns.get(t).map(n => ({ name: n })) }; }
    const table = text.match(/(?:FROM|INTO|UPDATE|DELETE FROM)\s+([A-Za-z_][A-Za-z0-9_]*)/i)?.[1]?.toLowerCase() || this.ensureTable('unknown');
    const rows = this.tables.get(table) || [];
    if (table === 'schema_migrations') return { results: rows };
    if (table === 'storage_connections') {
      if (lower.includes('where id = ? and deleted_at is null')) return { results: rows.filter(r => r.id === args[0] && !r.deleted_at) };
      if (lower.includes('deleted_at is null order by')) {
        let candidates = rows.filter(r => !r.deleted_at);
        if (lower.includes('id != ?')) {
          const exclude = args[0];
          candidates = candidates.filter(r => r.id !== exclude);
        }
        if (lower.includes('enabled = 1')) candidates = candidates.filter(r => r.enabled === 1 || r.enabled === true);
        return { results: candidates };
      }
      return { results: rows };
    }
    if (table === 'storage_sync_jobs') {
      if (lower.includes('where storage_id = ? and status in')) return { results: rows.filter(r => r.storage_id === args[0] && ['queued', 'running'].includes(r.status)) };
      return { results: rows };
    }
    if (table === 'file_tasks') {
      if (lower.includes('where storage_id = ? and status in')) return { results: rows.filter(r => r.storage_id === args[0] && ['queued', 'running'].includes(r.status)) };
      return { results: rows };
    }
    return { results: rows };
  }
}

const master = Buffer.alloc(32, 5).toString('base64');
const d1 = new MemoryD1();
const kv = new MemoryKV();
const env = { ADMIN_PASSWORD: 'x', STORAGE_CONFIG_KEY: master, KV_STORE: kv, D1_DB: d1 };

// Legacy schema: pre-create old-shape tables with a KV schema marker so the
// migration must still run from the D1 marker check (no KV skip).
makeTable(d1, 'search_items', [{
  path: '/old.txt', name: 'old.txt', item_type: 'file', parent_path: '/', size: 5,
  size_formatted: '5 B', preview_type: 'text', last_modified: null, tags: '[]',
  indexed_at: 1, resource_key: 'old.txt', resource_version: null, resource_etag: '"old-v1"',
  sync_status: 'ready', updated_at: 1
}]);
makeTable(d1, 'favorites', []);
makeTable(d1, 'recent_items', []);
makeTable(d1, 'share_links', []);
makeTable(d1, 'share_items', []);
makeTable(d1, 'app_stats', []);
makeTable(d1, 'reader_bookmarks', []);
makeTable(d1, 'reader_progress', []);
makeTable(d1, 'txt_index_files', []);
makeTable(d1, 'txt_index_chunks', []);
makeTable(d1, 'user_permissions', []);
makeTable(d1, 'file_tasks', []);
makeTable(d1, 'file_task_items', []);
await kv.put('d1:schema:v6-bookmark-anchor', '1');

const migrated = await ensureD1Schema(env);
assert.equal(migrated, true, 'legacy schema must migrate');
const legacyRow = d1.tables.get('search_items').find(r => r.path === '/old.txt');
assert.equal(legacyRow.storage_id, 'legacy-default', 'legacy rows must carry legacy-default storage id');
const legacyConnection = d1.tables.get('storage_connections').find(r => r.id === 'legacy-default');
assert.ok(legacyConnection, 'migration must create the legacy-default placeholder connection');
assert.equal(legacyConnection.last_sync_status, 'setup_required');
assert.equal(await kv.get('d1:schema:v6-bookmark-anchor'), null, 'legacy KV schema marker must be removed');
const migratedAgain = await ensureD1Schema(env);
assert.equal(migratedAgain, false, 're-running ensureD1Schema must be a no-op');

// Encrypted credential write/read round-trip via the repository path.
const enc = await encryptStorageCredentials(master, 'storage-a', { accessKeyId: 'ak', secretAccessKey: 'sk-secret' });
await d1.prepare(`INSERT INTO storage_connections (id, name, provider, endpoint, region, bucket, addressing_style, credentials_ciphertext, credentials_iv, credential_version, enabled, is_default, sync_interval_minutes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind('storage-a', 'A', 's3', 'https://example.test', 'auto', 'a-dev', 'path', enc.ciphertext, enc.iv, 1, 1, 1, 1440, Date.now(), Date.now()).run();
const stored = d1.tables.get('storage_connections').find(r => r.id === 'storage-a');
const serialized = JSON.stringify(stored);
assert.ok(!serialized.includes('sk-secret'), 'raw secret must never appear in stored connection rows');
assert.ok(!serialized.includes('ak'), 'access key id must never appear in stored connection rows');

import { handleAdminDeleteStorage } from '../src/admin.js';

function toBase64Url(value) {
  const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(value);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function signAdminCookie(secret) {
  const header = toBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = toBase64Url(JSON.stringify({ role: 'admin', exp: Date.now() + 60_000 }));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`));
  return `token=${header}.${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

async function deleteStorageFlow(storages, targetId) {
  const flowD1 = new MemoryD1();
  for (const s of storages) {
    flowD1.tables.set('storage_connections', flowD1.tables.get('storage_connections') || []);
    flowD1.tables.get('storage_connections').push({
      id: s.id, name: s.name, provider: 's3', endpoint: 'https://example.test', region: 'auto',
      bucket: s.bucket, addressing_style: 'path', credentials_ciphertext: null, credentials_iv: null,
      credential_version: 1, enabled: s.enabled ? 1 : 0, is_default: s.isDefault ? 1 : 0,
      sync_interval_minutes: 0, last_sync_status: null, created_at: Date.now(), updated_at: Date.now()
    });
  }
  flowD1.tables.set('storage_sync_jobs', []);
  flowD1.tables.set('file_tasks', []);
  flowD1.tables.set('share_links', []);
  flowD1.tables.set('search_items', []);
  flowD1.tables.set('favorites', []);
  flowD1.tables.set('recent_items', []);
  flowD1.tables.set('reader_bookmarks', []);
  flowD1.tables.set('reader_progress', []);
  flowD1.tables.set('txt_index_chunks', []);
  flowD1.tables.set('txt_index_files', []);
  flowD1.tables.set('user_permissions', []);
  flowD1.tables.set('app_stats', []);
  const flowEnv = { ADMIN_PASSWORD: 'x', STORAGE_CONFIG_KEY: master, KV_STORE: new MemoryKV(), D1_DB: flowD1 };
  const target = storages.find(s => s.id === targetId);
  const request = new Request('https://example.test/api/admin/storages/' + targetId, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'Cookie': await signAdminCookie('x') },
    body: JSON.stringify({ confirmationName: target.name })
  });
  const response = await handleAdminDeleteStorage(request, flowEnv, targetId);
  return { response, d1: flowD1 };
}

// Case 1: last remaining default storage may be deleted.
{
  const { response, d1 } = await deleteStorageFlow(
    [{ id: 'only', name: '唯一存储', bucket: 'b-only', enabled: true, isDefault: true }],
    'only'
  );
  assert.equal(response.status, 200, 'the last default storage must be deletable');
  const rows = d1.tables.get('storage_connections');
  assert.ok(rows.every(r => r.deleted_at), 'the last storage must be soft-deleted');
}

// Case 2: default storage with other enabled storage present -> delete transfers default.
{
  const { response, d1 } = await deleteStorageFlow(
    [
      { id: 'a', name: '默认A', bucket: 'b-a', enabled: true, isDefault: true },
      { id: 'b', name: '启用B', bucket: 'b-b', enabled: true, isDefault: false }
    ],
    'a'
  );
  assert.equal(response.status, 200);
  const b = d1.tables.get('storage_connections').find(r => r.id === 'b');
  assert.equal(b.is_default, 1, 'deleting the default must transfer default to another enabled storage');
}

// Case 3: default storage with only disabled storages left -> delete rejected.
{
  const { response } = await deleteStorageFlow(
    [
      { id: 'a', name: '默认A', bucket: 'b-a', enabled: true, isDefault: true },
      { id: 'c', name: '停用C', bucket: 'b-c', enabled: false, isDefault: false }
    ],
    'a'
  );
  assert.equal(response.status, 409, 'deleting the default while another (disabled) storage exists must require an enabled replacement');
}

console.log('lifecycle: legacy migration, placeholder setup state, credential secrecy, and default-storage deletion contracts passed');
