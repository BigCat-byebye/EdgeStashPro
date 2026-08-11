import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker from '../worker.js';

const encoder = new TextEncoder();
const workerSource = await readFile(new URL('../worker.js', import.meta.url), 'utf8');

function toBase64Url(value) {
  const bytes = value instanceof Uint8Array ? value : encoder.encode(value);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function signCookie(secret, payload) {
  const header = toBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const encodedPayload = toBase64Url(JSON.stringify({ ...payload, exp: payload.exp || Date.now() + 60_000 }));
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${header}.${encodedPayload}`));
  return `token=${header}.${encodedPayload}.${toBase64Url(new Uint8Array(signature))}`;
}

async function signAdminCookie(secret) {
  return signCookie(secret, { role: 'admin' });
}

async function signUserCookie(secret, email) {
  return signCookie(secret, { role: 'user', email });
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

function makeObject(key, bytes, etag = '"txt-v1"') {
  const bodyBytes = bytes instanceof Uint8Array ? bytes : encoder.encode(bytes);
  return {
    key,
    size: bodyBytes.length,
    version: etag,
    etag: etag.replaceAll('"', ''),
    httpEtag: etag,
    uploaded: new Date('2026-08-03T00:00:00.000Z'),
    httpMetadata: { contentType: 'text/plain; charset=utf-8' },
    range: undefined,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bodyBytes);
        controller.close();
      }
    }),
    async arrayBuffer() {
      throw new Error('regression guard: full arrayBuffer() is forbidden');
    },
    async text() {
      throw new Error('regression guard: full text() is forbidden');
    }
  };
}

function encodeUtf16Le(value) {
  const bytes = new Uint8Array(2 + value.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    bytes[2 + index * 2] = code & 0xff;
    bytes[3 + index * 2] = code >>> 8;
  }
  return bytes;
}

function makeR2(objects) {
  const store = new Map(objects.map(({ key, bytes, etag }) => [key, {
    bytes: bytes instanceof Uint8Array ? bytes : encoder.encode(bytes),
    etag: etag || '"txt-v1"'
  }]));
  const ranges = [];
  const heads = [];
  const gets = [];
  const lists = [];
  let generation = objects.length;
  return {
    ranges,
    heads,
    gets,
    lists,
    async head(key) {
      heads.push(key);
      const record = store.get(key);
      return record ? { ...makeObject(key, record.bytes, record.etag), body: undefined } : null;
    },
    async get(key, options = {}) {
      let range = options.range || null;
      if (range instanceof Headers) {
        const header = range.get('Range');
        const match = header && header.match(/^bytes=(\d+)-(\d*)$/i);
        range = match
          ? { offset: Number(match[1]), length: match[2] ? Number(match[2]) - Number(match[1]) + 1 : undefined }
          : null;
      }
      gets.push({ key, range });
      const record = store.get(key);
      if (!record) return null;
      if (!range) return makeObject(key, record.bytes, record.etag);
      const offset = Number(range.offset || 0);
      const length = Number(range.length ?? (record.bytes.length - offset));
      ranges.push({ key, offset, length });
      const bounded = record.bytes.slice(offset, Math.min(record.bytes.length, offset + length));
      const ranged = makeObject(key, bounded, record.etag);
      ranged.size = record.bytes.length;
      ranged.range = { offset, length: bounded.length };
      return ranged;
    },
    async list(options = {}) {
      const prefix = options.prefix || '';
      lists.push({ prefix, delimiter: options.delimiter || '', cursor: options.cursor || null });
      const records = Array.from(store.entries())
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, record]) => ({
          key,
          size: record.bytes.length,
          version: record.etag,
          etag: record.etag.replaceAll('"', ''),
          httpEtag: record.etag,
          uploaded: new Date('2026-08-03T00:00:00.000Z'),
          httpMetadata: { contentType: 'text/plain; charset=utf-8' }
        }));
      if (!options.delimiter) return { objects: records, delimitedPrefixes: [], truncated: false };
      const objects = [];
      const prefixes = new Set();
      for (const object of records) {
        const remainder = object.key.slice(prefix.length);
        const slash = remainder.indexOf(options.delimiter);
        if (slash < 0) objects.push(object);
        else prefixes.add(prefix + remainder.slice(0, slash + 1));
      }
      return { objects, delimitedPrefixes: Array.from(prefixes), truncated: false };
    },
    async put(key, value, options = {}) {
      let bytes;
      if (value instanceof Uint8Array) bytes = value;
      else if (typeof value === 'string') bytes = encoder.encode(value);
      else bytes = await readBody(value);
      generation += 1;
      const etag = '"txt-v' + generation + '-' + key + '"';
      store.set(key, { bytes, etag, options });
      return { ...makeObject(key, bytes, etag), body: undefined };
    },
    async delete(keys) {
      for (const key of (Array.isArray(keys) ? keys : [keys])) store.delete(key);
    }
  };
}

async function readBody(stream) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    chunks.push(chunk);
    total += chunk.length;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

class MemoryKV {
  constructor() {
    this.values = new Map();
  }

  async get(key, type) {
    const value = this.values.get(key);
    if (value === undefined) return null;
    if (type === 'json') {
      try { return JSON.parse(value); } catch { return null; }
    }
    return value;
  }

  async put(key, value) {
    this.values.set(key, String(value));
  }

  async delete(key) {
    this.values.delete(key);
  }

  async list(options = {}) {
    const prefix = options.prefix || '';
    const keys = Array.from(this.values.keys())
      .filter(key => key.startsWith(prefix))
      .sort()
      .map(name => ({ name }));
    return { keys, list_complete: true, cursor: undefined };
  }
}

function tableNameFromSql(sql) {
  const match = sql.match(/(?:FROM|INTO|UPDATE|TABLE|DELETE FROM)\s+([A-Za-z_][A-Za-z0-9_]*)/i);
  return match ? match[1].toLowerCase() : '';
}

function pathMatchesRoot(root, target) {
  return target === root || target.startsWith(root === '/' ? '/' : root + '/');
}

class MemoryD1Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.args = [];
  }

  bind(...args) {
    const bound = new MemoryD1Statement(this.db, this.sql);
    bound.args = args;
    return bound;
  }

  async run() {
    return this.db.run(this.sql, this.args);
  }

  async first() {
    const result = await this.db.all(this.sql, this.args);
    return result.results[0] || null;
  }

  async all() {
    return this.db.all(this.sql, this.args);
  }
}

class MemoryD1 {
  constructor() {
    this.tables = new Map();
    this.columns = new Map();
    this.nextPermissionId = 1;
  }

  prepare(sql) {
    return new MemoryD1Statement(this, sql);
  }

  async batch(statements) {
    for (const statement of statements) await statement.run();
    return { success: true };
  }

  ensureTable(name) {
    const table = name.toLowerCase();
    if (!this.tables.has(table)) this.tables.set(table, []);
    if (!this.columns.has(table)) this.columns.set(table, []);
    return table;
  }

  parseCreateTable(sql) {
    const match = sql.match(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)/is);
    if (!match) return false;
    const table = this.ensureTable(match[1]);
    const columns = this.columns.get(table);
    for (const part of match[2].split(',')) {
      const column = part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s+/);
      if (column && !/^(PRIMARY|UNIQUE|CONSTRAINT|FOREIGN|CHECK)$/i.test(column[1]) && !columns.includes(column[1])) {
        columns.push(column[1]);
      }
    }
    return true;
  }

  async run(sql, args) {
    const text = sql.trim();
    const lower = text.toLowerCase();
    const compact = lower.replace(/\s+/g, ' ');
    if (this.parseCreateTable(text) || lower.startsWith('create index')) return { success: true };
    const alter = text.match(/ALTER TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD COLUMN\s+([A-Za-z_][A-Za-z0-9_]*)/i);
    if (alter) {
      const table = this.ensureTable(alter[1]);
      if (!this.columns.get(table).includes(alter[2])) this.columns.get(table).push(alter[2]);
      return { success: true };
    }

    const insert = text.match(/INSERT(?: OR IGNORE)? INTO\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]+)\)/i);
    if (insert) {
      const table = this.ensureTable(insert[1]);
      const columns = insert[2].split(',').map(column => column.trim());
      const row = {};
      columns.forEach((column, index) => { row[column] = args[index]; });
      if (table === 'search_items') {
        row.updated_at = row.sync_status;
        row.sync_status = 'ready';
        const existing = this.tables.get(table).find(item => item.path === row.path);
        if (existing) Object.assign(existing, row);
        else this.tables.get(table).push(row);
      } else if (table === 'user_permissions') {
        row.id = this.nextPermissionId++;
        const existing = this.tables.get(table).find(item => item.email === row.email && item.path === row.path && item.item_type === row.item_type);
        if (existing) Object.assign(existing, row);
        else this.tables.get(table).push(row);
      } else if (table === 'share_links') {
        const existing = this.tables.get(table).find(item => item.share_id === row.share_id);
        if (!existing) this.tables.get(table).push(row);
      } else if (table === 'share_items') {
        const existing = this.tables.get(table).find(item => item.share_id === row.share_id && item.item_path === row.item_path);
        if (!existing) this.tables.get(table).push(row);
      } else if (table === 'reader_bookmarks') {
        this.tables.get(table).push(row);
      } else if (table === 'reader_progress') {
        const progressRow = {
          owner_key: args[0],
          path: args[1],
          source_etag: args[2],
          char_offset: args[3],
          byte_offset: args[4],
          anchor_char_offset: args[5],
          anchor_byte_offset: args[6],
          anchor_ratio: args[7],
          progress: args[8],
          scroll_top: args[9],
          scroll_height: args[10],
          revision: 1,
          updated_at: args[11]
        };
        const existing = this.tables.get(table).find(item => item.owner_key === progressRow.owner_key && item.path === progressRow.path);
        if (!existing) this.tables.get(table).push(progressRow);
      } else if (table === 'app_stats') {
        const existing = this.tables.get(table).find(item => item.key === row.key);
        if (existing) Object.assign(existing, row);
        else this.tables.get(table).push(row);
      } else if (table === 'txt_index_files') {
        const existing = this.tables.get(table).find(item => item.path === row.path);
        if (existing) Object.assign(existing, row);
        else this.tables.get(table).push(row);
      } else if (table === 'txt_index_chunks') {
        const existing = this.tables.get(table).find(item => item.path === row.path && item.chunk_no === row.chunk_no);
        if (existing) Object.assign(existing, row);
        else this.tables.get(table).push(row);
      } else {
        this.tables.get(table).push(row);
      }
      return { success: true };
    }

    if (lower.startsWith('delete from')) {
      const table = tableNameFromSql(text);
      const rows = this.tables.get(table) || [];
      const original = rows.length;
      if (table === 'user_permissions' && compact.includes('email = ?') && !compact.includes('path = ?')) {
        this.tables.set(table, rows.filter(row => row.email !== args[0]));
      } else if (table === 'user_permissions' && compact.includes('id = ?')) {
        this.tables.set(table, rows.filter(row => row.id !== args[0]));
      } else if (table === 'user_permissions' && compact.includes('path = ?')) {
        const root = args[0];
        this.tables.set(table, rows.filter(row => !(row.path === root || pathMatchesRoot(root, row.path))));
      } else if (table === 'share_items' && compact.includes('share_id = ?')) {
        this.tables.set(table, rows.filter(row => row.share_id !== args[0]));
      } else if (table === 'share_items' && compact.includes('item_path = ?')) {
        this.tables.set(table, rows.filter(row => !(row.item_path === args[0] || pathMatchesRoot(args[0], row.item_path))));
      } else if (table === 'share_links' && compact.includes('share_id = ?')) {
        this.tables.set(table, rows.filter(row => row.share_id !== args[0]));
      } else if (table === 'reader_bookmarks' && compact.includes('id = ?')) {
        this.tables.set(table, rows.filter(row => !(row.id === args[0] && row.owner_key === args[1])));
      } else if (table === 'reader_bookmarks' && compact.includes('owner_key = ?')) {
        this.tables.set(table, rows.filter(row => row.owner_key !== args[0]));
      } else if (table === 'reader_progress' && compact.includes('owner_key = ?') && !compact.includes('path = ?')) {
        this.tables.set(table, rows.filter(row => row.owner_key !== args[0]));
      } else if ((table === 'txt_index_files' || table === 'txt_index_chunks') && compact.includes('path = ?')) {
        const root = args[0];
        this.tables.set(table, rows.filter(row => !(row.path === root || pathMatchesRoot(root, row.path))));
      } else if (table === 'search_items' || table === 'favorites' || table === 'recent_items' || table === 'reader_bookmarks' || table === 'reader_progress') {
        const root = args[0];
        if (table === 'search_items' && compact.includes('indexed_at != ?')) {
          const indexedAt = args[args.length - 1];
          if (compact.includes('path = ?')) {
            // Subtree reconcile: drop stale rows under the subtree only.
            this.tables.set(table, rows.filter(row => {
              const inSubtree = row.path === root || pathMatchesRoot(root, row.path);
              return !inSubtree || row.indexed_at === indexedAt;
            }));
          } else {
            // Full rebuild: keep only rows stamped during this reconcile.
            this.tables.set(table, rows.filter(row => row.indexed_at === indexedAt));
          }
        } else {
          const owner = table === 'reader_bookmarks' ? null : null;
          this.tables.set(table, rows.filter(row => !(row.path === root || pathMatchesRoot(root, row.path)) && (!owner || row.owner_key !== owner)));
        }
      }
      return { success: true, changes: original - this.tables.get(table).length };
    }

    if (lower.startsWith('update')) {
      const table = tableNameFromSql(text);
      const rows = this.tables.get(table) || [];
      if (table === 'user_permissions' && compact.includes('where id = ?')) {
        const row = rows.find(item => item.id === args[4]);
        if (row) {
          row.resource_key = args[0];
          row.resource_version = args[1];
          row.resource_etag = args[2];
          row.updated_at = args[3];
        }
      } else if (table === 'share_items' && compact.includes('where share_id = ? and item_path = ?')) {
        const row = rows.find(item => item.share_id === args[3] && item.item_path === args[4]);
        if (row) {
          row.resource_key = args[0];
          row.resource_version = args[1];
          row.resource_etag = args[2];
        }
      } else if (table === 'txt_index_files') {
        const path = args[args.length - 2];
        const sourceEtag = args[args.length - 1];
        const row = rows.find(item => item.path === path && item.source_etag === sourceEtag);
        if (row) {
          if (compact.includes("set status = 'ready'")) {
            row.status = 'ready';
            row.indexed_at = args[0];
            row.updated_at = args[1];
            row.error_message = null;
          } else if (compact.includes("set status = 'error'")) {
            row.status = 'error';
            row.error_message = args[0];
            row.updated_at = args[1];
          } else {
            row.status = args[0];
            row.scanned_bytes = args[1];
            row.next_offset = args[2];
            row.next_chunk_no = args[3];
            row.next_char_offset = args[4];
            row.total_chars = args[5];
            row.tail_text = args[6];
            row.error_message = null;
            row.indexed_at = args[7];
            row.updated_at = args[8];
          }
        }
      } else if (table === 'reader_progress') {
        const row = rows.find(item => item.owner_key === args[10]
          && item.path === args[11]
          && Number(item.revision) === Number(args[12]));
        if (row) {
          row.source_etag = args[0];
          row.char_offset = args[1];
          row.byte_offset = args[2];
          row.anchor_char_offset = args[3];
          row.anchor_byte_offset = args[4];
          row.anchor_ratio = args[5];
          row.progress = args[6];
          row.scroll_top = args[7];
          row.scroll_height = args[8];
          row.revision = Number(row.revision || 0) + 1;
          row.updated_at = args[9];
        }
        return { success: true, meta: { changes: row ? 1 : 0 } };
      } else if (table === 'share_links') {
        const shareId = args[args.length - 1];
        const row = rows.find(item => item.share_id === shareId);
        if (row) {
          if (compact.includes('view_count = view_count + 1')) row.view_count = Number(row.view_count || 0) + 1;
          if (compact.includes('download_count = download_count + 1')) row.download_count = Number(row.download_count || 0) + 1;
          if (compact.includes('items_initialized = 1')) row.items_initialized = 1;
        }
        if (compact.includes('where file_path = ?')) {
          const filePath = args[0];
          rows.filter(item => item.file_path === filePath).forEach(item => { item.items_initialized = 1; });
        }
      } else if (table === 'app_stats') {
        const key = args[args.length - 1];
        const row = rows.find(item => item.key === key);
        if (row) row.value = Math.max(0, Number(row.value || 0) + Number(args[0] || 0));
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
    if (pragma) {
      const table = this.ensureTable(pragma[1]);
      return { results: this.columns.get(table).map(name => ({ name })) };
    }
    const table = tableNameFromSql(text);
    const rows = this.tables.get(table) || [];
    if (compact.includes('count(*) as value')) {
      if (table === 'share_links') return { results: [{ value: rows.length }] };
      return { results: [{ value: 0 }] };
    }
    if (compact.includes('coalesce(sum(view_count)')) return { results: [{ value: rows.reduce((sum, row) => sum + Number(row.view_count || 0), 0) }] };
    if (compact.includes('coalesce(sum(download_count)')) return { results: [{ value: rows.reduce((sum, row) => sum + Number(row.download_count || 0), 0) }] };
    if (table === 'user_permissions') {
      if (compact.includes('where email = ?') && compact.includes('path = ? or')) {
        const email = args[0];
        const target = args[1];
        return { results: rows.filter(row => row.email === email && (row.path === target || (row.item_type === 'folder' && (row.path === '/' || target.startsWith(row.path + '/'))))) };
      }
      return { results: rows.filter(row => row.email === args[0]) };
    }
    if (table === 'share_links') return { results: rows.filter(row => row.share_id === args[0]) };
    if (table === 'share_items') {
      if (compact.includes('distinct share_id')) {
        const root = args[0];
        return { results: rows.filter(row => row.item_path === root || pathMatchesRoot(root, row.item_path)).map(row => ({ share_id: row.share_id })) };
      }
      return { results: rows.filter(row => row.share_id === args[0]) };
    }
    if (table === 'app_stats') return { results: rows.filter(row => row.key === args[0]) };
    if (table === 'reader_bookmarks') {
      return {
        results: rows.filter(row => row.owner_key === args[0]
          && row.path === args[1]
          && (!compact.includes('source_etag') || row.source_etag === null || row.source_etag === args[2]))
      };
    }
    if (table === 'reader_progress') {
      return { results: rows.filter(row => row.owner_key === args[0] && row.path === args[1]) };
    }
    if (table === 'txt_index_files' && compact.includes('where path = ?')) {
      return { results: rows.filter(row => row.path === args[0]) };
    }
    if (table === 'txt_index_files' && compact.includes("status = 'ready'")) {
      const startPath = String(args[0] || '');
      const limit = Number(args[1] || 500);
      return {
        results: rows
          .filter(row => row.status === 'ready' && row.path >= startPath)
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
          .slice(0, limit)
      };
    }
    if (table === 'txt_index_chunks' && compact.includes('content like ?')) {
      const pattern = String(args[3] || '');
      const inner = pattern.startsWith('%') && pattern.endsWith('%')
        ? pattern.slice(1, -1)
        : pattern;
      const literal = inner.replace(/\\([\\%_])/g, '$1');
      const startChunk = Number(args[2] || 0);
      const limit = Number(args[4] || 100);
      return {
        results: rows
          .filter(row => row.path === args[0]
            && row.source_etag === args[1]
            && Number(row.chunk_no) >= startChunk
            && String(row.content || '').includes(literal))
          .sort((a, b) => Number(a.chunk_no) - Number(b.chunk_no))
          .slice(0, limit)
      };
    }
    if (table === 'txt_index_chunks' && compact.includes('byte_start <= ?') && compact.includes('byte_end > ?')) {
      const target = Number(args[2]);
      return {
        results: rows
          .filter(row => row.path === args[0]
            && row.source_etag === args[1]
            && Number(row.byte_start) <= target
            && Number(row.byte_end) > target)
          .sort((a, b) => Number(b.chunk_no) - Number(a.chunk_no))
          .map(row => ({ chunk_no: row.chunk_no }))
          .slice(0, 1)
      };
    }
    if (table === 'txt_index_chunks' && compact.includes('chunk_no between ? and ?')) {
      return {
        results: rows
          .filter(row => row.path === args[0]
            && row.source_etag === args[1]
            && Number(row.chunk_no) >= Number(args[2])
            && Number(row.chunk_no) <= Number(args[3]))
          .sort((a, b) => Number(a.chunk_no) - Number(b.chunk_no))
          .slice(0, 4)
      };
    }
    if (table === 'txt_index_chunks' && compact.includes('select chunk_no, byte_start')) {
      return {
        results: rows
          .filter(row => row.path === args[0] && row.source_etag === args[1])
          .sort((a, b) => Number(a.chunk_no) - Number(b.chunk_no))
          .map(row => ({ chunk_no: row.chunk_no, byte_start: row.byte_start }))
          .slice(0, 1)
      };
    }
    if (table === 'txt_index_chunks' && compact.includes('chunk_no = ?')) {
      return {
        results: rows.filter(row => row.path === args[0]
          && row.source_etag === args[1]
          && Number(row.chunk_no) === Number(args[2]))
      };
    }
    if (table === 'user_permissions' && compact.includes('select id')) return { results: [] };
    if (table === 'search_items') {
      if (compact.includes('count(*) as count')) {
        if (compact.includes("lower(path) like '%.txt'")) {
          const count = rows.filter(row => row.item_type === 'file' && String(row.path).toLowerCase().endsWith('.txt')).length;
          return { results: [{ count }] };
        }
        return { results: [{ count: rows.length }] };
      }
      if (compact.includes('where parent_path = ?')) {
        return {
          results: rows
            .filter(row => row.parent_path === args[0])
            .sort((a, b) => {
              if (a.item_type !== b.item_type) return a.item_type === 'folder' ? -1 : 1;
              return String(a.name).localeCompare(String(b.name));
            })
        };
      }
      if (compact.includes('where path in (')) {
        const wanted = new Set(args);
        return { results: rows.filter(row => wanted.has(row.path)) };
      }
      if (compact.includes('where path = ?')) {
        return { results: rows.filter(row => row.path === args[0] && row.sync_status !== 'stale') };
      }
      if (compact.includes("where path = ? and item_type = 'folder'")) {
        return { results: rows.filter(row => row.path === args[0] && row.item_type === 'folder') };
      }
      if (compact.includes("lower(path) like '%.txt'") && compact.includes('path > ?')) {
        const limit = Number(args[1] || 0);
        return {
          results: rows
            .filter(row => row.item_type === 'file' && String(row.path).toLowerCase().endsWith('.txt') && row.path > args[0])
            .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
            .slice(0, limit)
        };
      }
      if (compact.includes("where item_type = 'folder'")) {
        return { results: rows.filter(row => row.item_type === 'folder') };
      }
      return { results: rows };
    }
    return { results: rows };
  }
}

function makeEnv(bytes, options = {}) {
  const objects = options.objects || [{ key: 'notes.txt', bytes, etag: '"txt-v1"' }];
  return {
    ADMIN_PASSWORD: 'regression-secret',
    R2_BUCKET: makeR2(objects),
    KV_STORE: options.kv || new MemoryKV(),
    D1_DB: options.d1 || null
  };
}

async function request(path, env, cookie, init = {}) {
  const headers = new Headers(init.headers || {});
  if (cookie) headers.set('Cookie', cookie);
  const pending = [];
  const response = await worker.fetch(new Request(`https://example.test${path}`, { ...init, headers }), env, {
    waitUntil(promise) { pending.push(Promise.resolve(promise)); }
  });
  await Promise.all(pending);
  return response;
}

async function testTxtRoutes() {
  const bytes = encoder.encode('ababa\n跨chunk aba\n');
  const env = makeEnv(bytes);
  const cookie = await signAdminCookie(env.ADMIN_PASSWORD);

  const unauthorized = await request('/api/txt/meta?path=%2Fnotes.txt', env);
  assert.equal(unauthorized.status, 401, 'TXT meta must require authentication');

  const meta = await request('/api/txt/meta?path=%2Fnotes.txt', env, cookie);
  assert.equal(meta.status, 200);
  const metaBody = await meta.json();
  assert.equal(metaBody.size, bytes.length);
  assert.equal(metaBody.etag, '"txt-v1"');
  assert.equal(metaBody.byteOffset, 0);

  const chunk = await request('/api/txt/chunk?path=%2Fnotes.txt&offset=1&length=4', env, cookie);
  assert.equal(chunk.status, 206);
  assert.equal(chunk.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(chunk.headers.get('Content-Range'), `bytes 1-4/${bytes.length}`);
  assert.equal(chunk.headers.get('Content-Length'), '4');
  assert.equal(chunk.headers.get('ETag'), '"txt-v1"');
  assert.deepEqual(await readBody(chunk.body), bytes.slice(1, 5));

  const rangeChunk = await request('/api/txt/chunk?path=%2Fnotes.txt', env, cookie, {
    headers: { Range: 'bytes=1-4', 'If-Match': '"txt-v1"' }
  });
  assert.equal(rangeChunk.status, 206);
  assert.equal(rangeChunk.headers.get('Content-Range'), `bytes 1-4/${bytes.length}`);
  assert.deepEqual(await readBody(rangeChunk.body), bytes.slice(1, 5));

  const staleChunk = await request('/api/txt/chunk?path=%2Fnotes.txt&offset=1&length=4', env, cookie, {
    headers: { 'If-Match': '"stale"' }
  });
  assert.equal(staleChunk.status, 412);

  const invalid = await request(`/api/txt/chunk?path=%2Fnotes.txt&offset=${bytes.length}&length=4`, env, cookie);
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get('Content-Range'), `bytes */${bytes.length}`);
  assert.equal(invalid.headers.get('Accept-Ranges'), 'bytes');

  const negative = await request('/api/txt/chunk?path=%2Fnotes.txt&offset=-1&length=4', env, cookie);
  assert.equal(negative.status, 416);

  const utf16Bytes = encodeUtf16Le('aba case');
  const utf16Env = makeEnv(utf16Bytes, { objects: [{ key: 'notes.txt', bytes: utf16Bytes, etag: '"utf16-v1"' }] });
  const utf16Cookie = await signAdminCookie(utf16Env.ADMIN_PASSWORD);
  const utf16Meta = await request('/api/txt/meta?path=%2Fnotes.txt', utf16Env, utf16Cookie);
  assert.equal((await utf16Meta.json()).encoding, 'utf-16le');
  const utf16Search = await request('/api/txt/search?path=%2Fnotes.txt&q=aba', utf16Env, utf16Cookie);
  assert.equal((await utf16Search.json()).results[0].byteOffset, 2);

  // 无 BOM 的 GBK/GB18030 小说是中文 TXT 的常见来源；分块阅读器必须不能把它当 UTF-8。
  const gb18030Bytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]); // 中文测试
  const gb18030Env = makeEnv(gb18030Bytes, { objects: [{ key: 'notes.txt', bytes: gb18030Bytes, etag: '"gb18030-v1"' }] });
  const gb18030Cookie = await signAdminCookie(gb18030Env.ADMIN_PASSWORD);
  const gb18030Meta = await request('/api/txt/meta?path=%2Fnotes.txt', gb18030Env, gb18030Cookie);
  assert.equal((await gb18030Meta.json()).encoding, 'gb18030', 'BOM-less GBK/GB18030 TXT must be detected before incremental reading');

  const search = await request('/api/txt/search?path=%2Fnotes.txt&q=aba&limit=50', env, cookie);
  assert.equal(search.status, 200);
  const searchBody = await search.json();
  assert.deepEqual(searchBody.results.map(result => result.byteOffset), [0, 2, 15]);
  assert.ok(searchBody.results.every(result => !('text' in result)), 'search must not return full text');
  assert.ok(env.R2_BUCKET.ranges.some(range => range.length <= 1_048_576), 'search reads must be bounded R2 ranges');

  const caseSensitive = await request('/api/txt/search?path=%2Fnotes.txt&q=ABA', env, cookie);
  assert.deepEqual((await caseSensitive.json()).results, [], 'TXT search must remain case-sensitive');
}

async function testTxtSearchPagingAndBoundaries() {
  const boundaryText = 'x'.repeat(65_535) + 'aba' + 'a'.repeat(70);
  const env = makeEnv(encoder.encode(boundaryText));
  const cookie = await signAdminCookie(env.ADMIN_PASSWORD);

  const boundary = await request('/api/txt/search?path=%2Fnotes.txt&q=aba&limit=50', env, cookie);
  assert.equal(boundary.status, 200);
  const boundaryBody = await boundary.json();
  assert.equal(boundaryBody.results[0].byteOffset, 65_535, 'matches split across R2 ranges must be found');

  const pagedEnv = makeEnv(encoder.encode('a'.repeat(70)));
  const pagedCookie = await signAdminCookie(pagedEnv.ADMIN_PASSWORD);
  const first = await request('/api/txt/search?path=%2Fnotes.txt&q=aa&limit=50', pagedEnv, pagedCookie);
  const firstBody = await first.json();
  assert.equal(firstBody.results.length, 50);
  assert.ok(firstBody.nextCursor, 'bounded result pages must return a cursor');
  assert.deepEqual(firstBody.results.slice(0, 3).map(result => result.byteOffset), [0, 1, 2]);

  const wrongQuery = await request('/api/txt/search?path=%2Fnotes.txt&q=AA&limit=50&cursor=' + encodeURIComponent(firstBody.nextCursor), pagedEnv, pagedCookie);
  assert.equal(wrongQuery.status, 400, 'cursor must be bound to the literal query');
  const wrongPath = await request('/api/txt/search?path=%2Fother.txt&q=aa&limit=50&cursor=' + encodeURIComponent(firstBody.nextCursor), pagedEnv, pagedCookie);
  assert.equal(wrongPath.status, 404, 'the path must be resolved before a cursor can be reused');

  await pagedEnv.R2_BUCKET.put('notes.txt', encoder.encode('a'.repeat(70)));
  await request('/api/txt/meta?path=%2Fnotes.txt', pagedEnv, pagedCookie);
  const changedCursor = await request('/api/txt/search?path=%2Fnotes.txt&q=aa&limit=50&cursor=' + encodeURIComponent(firstBody.nextCursor), pagedEnv, pagedCookie);
  assert.equal(changedCursor.status, 400, 'a cursor must be invalid after the source ETag changes');

  const lateMatchEnv = makeEnv(encoder.encode('x'.repeat(1_048_576 + 64) + 'late-needle'));
  const lateMatchCookie = await signAdminCookie(lateMatchEnv.ADMIN_PASSWORD);
  const firstScan = await request('/api/txt/search?path=%2Fnotes.txt&q=late-needle', lateMatchEnv, lateMatchCookie);
  const firstScanBody = await firstScan.json();
  assert.deepEqual(firstScanBody.results, [], 'one bounded scan cannot claim a full-file miss before the later page is checked');
  assert.ok(firstScanBody.nextCursor, 'a bounded scan must expose a cursor for the remaining file');
  const secondScan = await request('/api/txt/search?path=%2Fnotes.txt&q=late-needle&cursor=' + encodeURIComponent(firstScanBody.nextCursor), lateMatchEnv, lateMatchCookie);
  assert.equal((await secondScan.json()).results[0].match, 'late-needle', 'the later TXT scan page must find a literal match beyond the first MiB');
}

async function buildTxtIndex(env, cookie, path = '/notes.txt') {
  let lastBody = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request('/api/txt/index?path=' + encodeURIComponent(path), env, cookie, { method: 'POST' });
    lastBody = await response.json();
    assert.equal(response.status, 200, lastBody.message || 'TXT index build request must succeed');
    if (lastBody.done) return lastBody;
  }
  assert.fail('TXT index build did not finish: ' + JSON.stringify(lastBody));
}

async function testTxtIndexedSearchLifecycle() {
  // The match starts two characters before the 64 KiB index page boundary and
  // must still be owned by the following page through the overlap tail.
  const boundaryText = 'x'.repeat(65_534) + 'abcde' + '正文中的进度标记' + 'y'.repeat(80);
  const bytes = encoder.encode(boundaryText);
  const d1 = new MemoryD1();
  const env = makeEnv(bytes, { d1 });
  const cookie = await signAdminCookie(env.ADMIN_PASSWORD);

  const initialMeta = await request('/api/txt/meta?path=%2Fnotes.txt', env, cookie);
  const initialMetaBody = await initialMeta.json();
  assert.equal(initialMetaBody.index.status, 'stale', 'a TXT file without an index must report a stale/missing index');

  const built = await buildTxtIndex(env, cookie);
  assert.equal(built.index.status, 'ready');
  assert.equal(built.index.totalChars, boundaryText.length);
  assert.equal(built.index.encoding, 'utf-8');

  const rangesBeforeSearch = env.R2_BUCKET.ranges.length;
  const search = await request('/api/txt/search?path=%2Fnotes.txt&q=abcde&limit=50', env, cookie);
  assert.equal(search.status, 200);
  const searchBody = await search.json();
  assert.equal(searchBody.indexed, true);
  assert.equal(searchBody.results[0].charOffset, 65_534, 'indexed search must return an exact character offset across a page boundary');
  assert.equal(searchBody.results[0].chunkByteOffset, 0, 'a boundary-spanning result must jump from the previous indexed byte page');
  assert.equal(searchBody.results[0].chunkCharOffset, 0, 'a boundary-spanning result must use the previous indexed character base');
  assert.equal(searchBody.results[0].match, 'abcde');
  assert.ok(searchBody.results[0].progressPercent > 0);
  assert.equal(env.R2_BUCKET.ranges.length, rangesBeforeSearch, 'a ready index search must not rescan R2 content');

  const rangesBeforeOpen = env.R2_BUCKET.ranges.length;
  const opened = await request('/api/txt/open?path=%2Fnotes.txt', env, cookie);
  assert.equal(opened.status, 200);
  const openedBody = await opened.json();
  assert.equal(openedBody.windowSource, 'd1', 'an indexed novel must open from the D1 text read model');
  assert.ok(openedBody.chunks.length >= 2, 'the open response must include nearby indexed chunks');
  assert.equal(env.R2_BUCKET.ranges.length, rangesBeforeOpen, 'a ready D1 text window must not read R2');
  const cachedOpen = await request('/api/txt/open?path=%2Fnotes.txt&cachedEtag='
    + encodeURIComponent(openedBody.meta.etag)
    + '&cached=' + openedBody.chunks[0].byteStart, env, cookie);
  const cachedOpenBody = await cachedOpen.json();
  assert.equal(cachedOpenBody.chunks[0].cached, true, 'the server must omit a chunk already present in the device cache');
  assert.equal('text' in cachedOpenBody.chunks[0], false, 'cached open windows must not resend cached text');

  const firstPaged = await request('/api/txt/search?path=%2Fnotes.txt&q=x&limit=1', env, cookie);
  const firstPagedBody = await firstPaged.json();
  assert.equal(firstPagedBody.results[0].charOffset, 0);
  assert.ok(firstPagedBody.nextCursor, 'indexed result pages must expose a cursor');
  const secondPaged = await request('/api/txt/search?path=%2Fnotes.txt&q=x&limit=1&cursor=' + encodeURIComponent(firstPagedBody.nextCursor), env, cookie);
  assert.equal((await secondPaged.json()).results[0].charOffset, 1, 'indexed cursors must continue after the previous exact character offset');

  const metaAfterBuild = await request('/api/txt/meta?path=%2Fnotes.txt', env, cookie);
  assert.equal((await metaAfterBuild.json()).index.status, 'ready');

  await env.R2_BUCKET.put('notes.txt', encoder.encode('new body needle')); 
  const staleMeta = await request('/api/txt/meta?path=%2Fnotes.txt', env, cookie);
  assert.equal((await staleMeta.json()).index.status, 'stale', 'changing the R2 ETag must invalidate the TXT index');
  const staleSearch = await request('/api/txt/search?path=%2Fnotes.txt&q=needle', env, cookie);
  assert.equal(staleSearch.status, 409);
  assert.equal((await staleSearch.json()).code, 'TXT_INDEX_NOT_READY');

  await buildTxtIndex(env, cookie);
  const rebuiltSearch = await request('/api/txt/search?path=%2Fnotes.txt&q=needle', env, cookie);
  assert.equal((await rebuiltSearch.json()).results[0].match, 'needle');

  const gb18030Bytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]);
  const gb18030D1 = new MemoryD1();
  const gb18030Env = makeEnv(gb18030Bytes, {
    d1: gb18030D1,
    objects: [{ key: 'notes.txt', bytes: gb18030Bytes, etag: '"gb18030-v1"' }]
  });
  const gb18030Cookie = await signAdminCookie(gb18030Env.ADMIN_PASSWORD);
  await buildTxtIndex(gb18030Env, gb18030Cookie);
  const gbSearch = await request('/api/txt/search?path=%2Fnotes.txt&q=中文', gb18030Env, gb18030Cookie);
  const gbSearchBody = await gbSearch.json();
  assert.equal(gbSearch.status, 200);
  assert.equal(gbSearchBody.results[0].match, '中文', 'indexed search must decode GB18030 before matching Unicode queries');
}

async function testReaderProgressAndBookmarks() {
  const d1 = new MemoryD1();
  const env = makeEnv(encoder.encode('bookmarkable text'), { d1 });
  const cookie = await signAdminCookie(env.ADMIN_PASSWORD);

  const saved = await request('/api/reader/progress', env, cookie, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: '/notes.txt',
      charOffset: 4,
      byteOffset: 4,
      sourceEtag: '"txt-v1"',
      progress: 0.25,
      anchorRatio: 0.625,
      anchorCharOffset: 7,
      anchorByteOffset: 7,
      baseRevision: 0
    })
  });
  assert.equal(saved.status, 200);

  const progress = await request('/api/reader/progress?path=%2Fnotes.txt', env, cookie);
  assert.equal(progress.status, 200);
  const progressBody = await progress.json();
  assert.equal(progressBody.progress.byteOffset, 4);
  assert.equal(progressBody.progress.sourceEtag, '"txt-v1"');
  assert.equal(progressBody.progress.anchorRatio, 0.625, 'reader progress must preserve the position inside a large TXT chunk');
  assert.equal(progressBody.progress.anchorCharOffset, 7);
  assert.equal(progressBody.progress.revision, 1, 'the first global book progress write starts revision tracking');

  const advanced = await request('/api/reader/progress', env, cookie, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: '/notes.txt',
      charOffset: 8,
      byteOffset: 8,
      anchorCharOffset: 9,
      anchorByteOffset: 9,
      sourceEtag: '"txt-v1"',
      progress: 0.5,
      baseRevision: 1
    })
  });
  assert.equal(advanced.status, 200);
  assert.equal((await advanced.json()).progress.revision, 2, 'another device must advance the shared book revision');

  const staleDevice = await request('/api/reader/progress', env, cookie, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: '/notes.txt',
      charOffset: 5,
      byteOffset: 5,
      sourceEtag: '"txt-v1"',
      progress: 0.3,
      baseRevision: 1
    })
  });
  assert.equal(staleDevice.status, 409, 'a stale device must not overwrite newer global reading progress');
  const staleDeviceBody = await staleDevice.json();
  assert.equal(staleDeviceBody.code, 'READER_PROGRESS_CONFLICT');
  assert.equal(staleDeviceBody.progress.revision, 2);

  const reopened = await request('/api/txt/open?path=%2Fnotes.txt', env, cookie);
  assert.equal(reopened.status, 200);
  const reopenedBody = await reopened.json();
  assert.equal(reopenedBody.progress.revision, 2, 'every device must open from the same account-and-book progress');
  assert.equal(reopenedBody.target.byteOffset, 8);
  assert.equal(reopenedBody.target.anchorByteOffset, 9);

  const legacyKv = new MemoryKV();
  const legacyD1 = new MemoryD1();
  await legacyKv.put('reader:admin:' + await sha256Hex('/notes.txt'), JSON.stringify({
    path: '/notes.txt',
    charOffset: 3,
    byteOffset: 3,
    sourceEtag: '"txt-v1"',
    progress: 0.2,
    updatedAt: 1234
  }));
  const legacyEnv = makeEnv(encoder.encode('legacy progress text'), { d1: legacyD1, kv: legacyKv });
  const legacyCookie = await signAdminCookie(legacyEnv.ADMIN_PASSWORD);
  const legacyProgress = await request('/api/reader/progress?path=%2Fnotes.txt', legacyEnv, legacyCookie);
  assert.equal((await legacyProgress.json()).progress.byteOffset, 3, 'legacy KV progress must remain readable');
  assert.equal((legacyD1.tables.get('reader_progress') || []).length, 1, 'legacy KV progress must migrate into D1 on first read');

  const bookmark = await request('/api/reader/bookmarks', env, cookie, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: '/notes.txt',
      charOffset: 4,
      byteOffset: 4,
      sourceEtag: '"txt-v1"',
      progress: 0.25,
      snippet: 'bookmarkable'
    })
  });
  assert.equal(bookmark.status, 201);

  const bookmarks = await request('/api/reader/bookmarks?path=%2Fnotes.txt', env, cookie);
  assert.equal(bookmarks.status, 200);
  const bookmarkBody = await bookmarks.json();
  assert.equal(bookmarkBody.bookmarks[0].byteOffset, 4);
  assert.equal(bookmarkBody.bookmarks[0].sourceEtag, '"txt-v1"');

  await env.R2_BUCKET.put('notes.txt', encoder.encode('changed text'));
  await request('/api/txt/meta?path=%2Fnotes.txt', env, cookie);
  const staleProgress = await request('/api/reader/progress?path=%2Fnotes.txt', env, cookie);
  assert.equal(staleProgress.status, 200);
  const staleProgressBody = await staleProgress.json();
  assert.equal(staleProgressBody.progress, null);
  assert.equal(staleProgressBody.stale, true);

  const staleBookmarks = await request('/api/reader/bookmarks?path=%2Fnotes.txt', env, cookie);
  assert.equal(staleBookmarks.status, 200);
  assert.deepEqual((await staleBookmarks.json()).bookmarks, []);
}

async function testPathBoundPermissionsAndShares() {
  const d1 = new MemoryD1();
  const env = makeEnv(encoder.encode('original notes'), {
    d1,
    objects: [
      { key: 'notes.txt', bytes: encoder.encode('original notes'), etag: '"notes-v1"' },
      { key: 'other.txt', bytes: encoder.encode('other file'), etag: '"other-v1"' }
    ]
  });
  const adminCookie = await signAdminCookie(env.ADMIN_PASSWORD);
  const userEmail = 'reader@example.test';

  const createUser = await request('/api/admin/users', env, adminCookie, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: userEmail,
      password: 'reader-secret',
      permissions: [{ path: '/notes.txt', itemType: 'file', preset: 'manager' }]
    })
  });
  assert.equal(createUser.status, 200);

  const userCookie = await signUserCookie(env.ADMIN_PASSWORD, userEmail);

  // A non-admin root listing is virtual: only granted paths may appear, and
  // it must work even before any admin has opened the directory.
  const userRootListing = await request('/api/files/', env, userCookie);
  assert.equal(userRootListing.status, 200, 'a restricted user must still get a virtual root listing');
  const userRootData = await userRootListing.json();
  const userVisiblePaths = [...(userRootData.files || []), ...(userRootData.folders || [])].map(item => item.path);
  assert.ok(userVisiblePaths.includes('/notes.txt'), 'the granted file must appear in the virtual root listing');
  assert.ok(!userVisiblePaths.includes('/other.txt'), 'an ungranted file must never leak into a restricted listing');

  const userPreview = await request('/api/txt/meta?path=%2Fnotes.txt', env, userCookie);
  assert.equal(userPreview.status, 200, 'TXT metadata must honor a normal user preview permission');
  const permittedDownload = await request('/api/download/notes.txt', env, userCookie);
  assert.equal(permittedDownload.status, 200);
  assert.equal(await permittedDownload.text(), 'original notes');

  const unsafeRename = await request('/api/files/notes.txt', env, userCookie, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newName: 'renamed/escape.txt' })
  });
  assert.equal(unsafeRename.status, 400, 'rename must reject path-like names');

  const unauthorizedRename = await request('/api/files/notes.txt', env, userCookie, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newName: 'renamed.txt' })
  });
  assert.equal(unauthorizedRename.status, 403, 'rename must require target-parent upload permission before changing storage');

  const adminRename = await request('/api/files/notes.txt', env, adminCookie, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newName: 'renamed.txt' })
  });
  assert.equal(adminRename.status, 200);
  assert.equal((await adminRename.json()).newPath, '/renamed.txt');

  const oldPermission = await request('/api/download/notes.txt', env, userCookie);
  assert.equal(oldPermission.status, 403, 'rename must invalidate the old exact-path permission');
  const renamedPermission = await request('/api/download/renamed.txt', env, userCookie);
  assert.equal(renamedPermission.status, 403, 'rename must not grant the new path implicitly');

  await env.R2_BUCKET.put('notes.txt', encoder.encode('reused path'));
  const reusedPath = await request('/api/download/notes.txt', env, userCookie);
  assert.equal(reusedPath.status, 403, 'a reused path must not resurrect an invalidated permission');

  const createShare = await request('/api/share', env, adminCookie, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [{ path: '/renamed.txt' }, { path: '/other.txt' }],
      expiresIn: 'permanent'
    })
  });
  assert.equal(createShare.status, 200);
  const share = await createShare.json();
  assert.ok(share.shareId);

  const shareInfo = await request('/api/share/' + share.shareId, env);
  assert.equal(shareInfo.status, 200);
  assert.equal((await shareInfo.json()).state, 'active');

  const sharedDownload = await request('/api/share/' + share.shareId + '/download', env, null, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/renamed.txt' })
  });
  assert.equal(sharedDownload.status, 200);
  assert.equal(await sharedDownload.text(), 'original notes');

  const deleteOther = await request('/api/files/other.txt', env, adminCookie, { method: 'DELETE' });
  assert.equal(deleteOther.status, 200);
  const partialInfo = await request('/api/share/' + share.shareId, env);
  assert.equal(partialInfo.status, 200);
  assert.equal((await partialInfo.json()).state, 'partial');

  const deleteRenamed = await request('/api/files/renamed.txt', env, adminCookie, { method: 'DELETE' });
  assert.equal(deleteRenamed.status, 200);
  const orphanedInfo = await request('/api/share/' + share.shareId, env);
  assert.equal(orphanedInfo.status, 410, 'a share with no valid roots must be gone');

  await env.R2_BUCKET.put('renamed.txt', encoder.encode('reused share path'));
  const resurrectedShare = await request('/api/share/' + share.shareId, env);
  assert.equal(resurrectedShare.status, 410, 'reusing a deleted share path must not revive the share');
}

async function testCachedAdminDirectoryNavigationAvoidsPerItemR2Checks() {
  const env = makeEnv(null, {
    d1: new MemoryD1(),
    objects: [
      { key: 'mybox/novel/first.txt', bytes: encoder.encode('first') },
      { key: 'mybox/novel/second.txt', bytes: encoder.encode('second') }
    ]
  });
  const cookie = await signAdminCookie(env.ADMIN_PASSWORD);
  const initial = await request('/api/files/mybox/novel', env, cookie);
  assert.equal(initial.status, 200);
  const initialData = await initial.json();
  assert.equal(initialData.files.length, 2, 'first listing must reconcile the virtual tree from R2');

  env.R2_BUCKET.heads.length = 0;
  env.R2_BUCKET.lists.length = 0;
  const cached = await request('/api/files/mybox/novel', env, cookie);
  assert.equal(cached.status, 200);
  const cachedData = await cached.json();
  assert.deepEqual(
    cachedData.files.map(file => file.name).sort(),
    ['first.txt', 'second.txt'],
    'repeat navigation must be served from the virtual directory tree'
  );
  assert.equal(env.R2_BUCKET.heads.length, 0, 'virtual-directory navigation must not HEAD every displayed item');
  assert.equal(env.R2_BUCKET.lists.length, 0, 'virtual-directory navigation must not list every displayed folder');
}

async function testVirtualDirectoryIncrementalAndGlobalTxtSearch() {
  const firstText = '第一章 风起 ' + '这是第一本书的内容。'.repeat(50) + '灵狐传说';
  const secondText = '第二章 云涌 ' + '这是第二本书的内容。'.repeat(50) + '灵狐传说';
  const d1 = new MemoryD1();
  const env = makeEnv(null, {
    d1,
    objects: [
      { key: 'novels/book-one.txt', bytes: encoder.encode(firstText) },
      { key: 'novels/book-two.txt', bytes: encoder.encode(secondText) }
    ]
  });
  const cookie = await signAdminCookie(env.ADMIN_PASSWORD);

  // The first listing reconciles the virtual tree from R2.
  const listing = await request('/api/files/novels', env, cookie);
  assert.equal(listing.status, 200);
  assert.equal((await listing.json()).files.length, 2);

  // Creating a folder must show up immediately via the incremental upsert —
  // no manual refresh, no R2 rescan of the directory.
  const createFolder = await request('/api/folders', env, cookie, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/novels/annotations' })
  });
  assert.equal(createFolder.status, 200);
  const afterFolder = await (await request('/api/files/novels', env, cookie)).json();
  assert.ok(
    afterFolder.folders.some(folder => folder.path === '/novels/annotations'),
    'a newly created folder must appear in the listing without a refresh'
  );

  const deleteFolder = await request('/api/files/novels/annotations', env, cookie, { method: 'DELETE' });
  assert.equal(deleteFolder.status, 200);
  const afterDelete = await (await request('/api/files/novels', env, cookie)).json();
  assert.ok(
    !afterDelete.folders.some(folder => folder.path === '/novels/annotations'),
    'a deleted folder must disappear from the listing without a refresh'
  );

  // Build content indexes for both books, then search across all of them.
  await buildTxtIndex(env, cookie, '/novels/book-one.txt');
  await buildTxtIndex(env, cookie, '/novels/book-two.txt');

  const globalSearch = await request('/api/txt/search/global?q=' + encodeURIComponent('灵狐传说'), env, cookie);
  assert.equal(globalSearch.status, 200);
  const globalBody = await globalSearch.json();
  assert.equal(globalBody.success, true);
  assert.equal(globalBody.results.length, 2, 'global full-text search must find the phrase in every indexed book');
  assert.deepEqual(
    globalBody.results.map(result => result.path).sort(),
    ['/novels/book-one.txt', '/novels/book-two.txt']
  );
  for (const result of globalBody.results) {
    assert.ok(Number.isFinite(result.charOffset) && result.charOffset > 0, 'each global result needs an exact jump offset');
    assert.ok(Number.isFinite(result.chunkByteOffset) && result.chunkByteOffset >= 0, 'each global result needs an indexed byte-page start for a direct reader seek');
    assert.ok(Number.isFinite(result.chunkCharOffset) && result.chunkCharOffset >= 0 && result.chunkCharOffset <= result.charOffset, 'each global result needs the matching page character base for a direct reader seek');
    assert.equal(result.match, '灵狐传说');
    assert.ok(result.snippetBefore.length > 0, 'each global result needs surrounding context');
    assert.ok(result.name.endsWith('.txt'));
  }

  // A non-matching query returns nothing and does not fabricate results.
  const emptySearch = await request('/api/txt/search/global?q=' + encodeURIComponent('不存在的词'), env, cookie);
  assert.equal(emptySearch.status, 200);
  assert.equal((await emptySearch.json()).results.length, 0);
}

async function testD1ReadModelHotPaths() {
  const env = makeEnv(encoder.encode('fast-path text'), { d1: new MemoryD1() });
  const cookie = await signAdminCookie(env.ADMIN_PASSWORD);
  const bootstrap = await request('/api/bootstrap', env, cookie);
  assert.equal(bootstrap.status, 200);
  const bootstrapBody = await bootstrap.json();
  assert.equal(bootstrapBody.success, true);
  assert.equal(bootstrapBody.listing.files[0].path, '/notes.txt');
  assert.ok(env.R2_BUCKET.lists.length > 0, 'the first bootstrap must import R2 metadata once');

  function resetR2Calls() {
    env.R2_BUCKET.heads.length = 0;
    env.R2_BUCKET.lists.length = 0;
    env.R2_BUCKET.gets.length = 0;
    env.R2_BUCKET.ranges.length = 0;
  }

  function assertNoR2MetadataReads(message) {
    assert.equal(env.R2_BUCKET.heads.length, 0, message + ': no R2 HEAD');
    assert.equal(env.R2_BUCKET.lists.length, 0, message + ': no R2 LIST');
    assert.equal(env.R2_BUCKET.gets.length, 0, message + ': no R2 GET');
  }

  resetR2Calls();
  assert.equal((await request('/api/files/', env, cookie)).status, 200);
  assertNoR2MetadataReads('repeat directory listing must be D1-only');

  assert.equal((await request('/api/search?q=notes', env, cookie)).status, 200);
  assertNoR2MetadataReads('metadata search must be D1-only');
  assert.equal((await request('/api/favorites', env, cookie)).status, 200);
  assertNoR2MetadataReads('favorites must be D1-only');
  assert.equal((await request('/api/recent', env, cookie)).status, 200);
  assertNoR2MetadataReads('recent items must be D1-only');
  assert.equal((await request('/api/tags/list', env, cookie)).status, 200);
  assertNoR2MetadataReads('tag options must be D1-only');

  resetR2Calls();
  const preview = await request('/api/preview/notes.txt', env, cookie);
  assert.equal(preview.status, 200);
  assert.equal(env.R2_BUCKET.gets.length, 1, 'preview must issue one exact R2 GET');
  assert.equal(env.R2_BUCKET.heads.length, 0, 'preview must not issue a separate R2 HEAD');
  assert.equal(env.R2_BUCKET.lists.length, 0, 'preview must not issue an R2 LIST');

  resetR2Calls();
  const txtMeta = await request('/api/txt/meta?path=%2Fnotes.txt', env, cookie);
  assert.equal(txtMeta.status, 200);
  assert.equal(env.R2_BUCKET.gets.length, 1, 'TXT metadata must use one bounded R2 GET');
  resetR2Calls();
  assert.equal((await request('/api/reader/progress?path=%2Fnotes.txt', env, cookie)).status, 200);
  assertNoR2MetadataReads('reader progress must use the D1 source identity');

  const shareResponse = await request('/api/share', env, cookie, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ path: '/notes.txt' }], expiresIn: 'permanent' })
  });
  const share = await shareResponse.json();
  resetR2Calls();
  const shareInfo = await request('/api/share/' + share.shareId, env);
  assert.equal(shareInfo.status, 200);
  assertNoR2MetadataReads('share metadata must be D1-only');

  resetR2Calls();
  const shareDownload = await request('/api/share/' + share.shareId + '/download', env, null, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/notes.txt' })
  });
  assert.equal(shareDownload.status, 200);
  assert.equal(env.R2_BUCKET.gets.length, 1, 'share download must issue one exact R2 GET');
  assert.equal(env.R2_BUCKET.heads.length, 0);
  assert.equal(env.R2_BUCKET.lists.length, 0);

  const emptyEnv = makeEnv(null, { d1: new MemoryD1(), objects: [] });
  const emptyCookie = await signAdminCookie(emptyEnv.ADMIN_PASSWORD);
  assert.equal((await request('/api/bootstrap', emptyEnv, emptyCookie)).status, 200);
  emptyEnv.R2_BUCKET.lists.length = 0;
  assert.equal((await request('/api/files/', emptyEnv, emptyCookie)).status, 200);
  assert.equal(emptyEnv.R2_BUCKET.lists.length, 0, 'an initialized empty bucket must not be rescanned');
}

function testStaticContracts() {
  const txtBranchStart = workerSource.indexOf("if (ext === 'txt')");
  const txtBranchEnd = workerSource.indexOf('await renderTxtReader(content, path, options && options.txtJump);', txtBranchStart)
    + 'await renderTxtReader(content, path, options && options.txtJump);'.length;
  const txtBranch = workerSource.slice(txtBranchStart, txtBranchEnd);
  assert.ok(txtBranchStart >= 0 && txtBranchEnd > txtBranchStart);
  assert.doesNotMatch(txtBranch, /arrayBuffer\(\)/, 'TXT preview must not load a whole file buffer');
  assert.doesNotMatch(txtBranch, /createTextNode\(/, 'TXT preview must append bounded text chunks safely');

  const searchStart = workerSource.indexOf('async function handleTxtSearch');
  const searchEnd = workerSource.indexOf('\nasync function listR2Prefix', searchStart);
  const searchSource = workerSource.slice(searchStart, searchEnd);
  assert.match(searchSource, /binary\.indexOf\(pattern/);
  assert.doesNotMatch(searchSource, /RegExp|\.match\(|toLowerCase\(|\.normalize\(/);
  assert.match(workerSource, /const TXT_SEARCH_MAX_RESULTS = 50/);
  assert.match(workerSource, /new AbortController\(\)/);
  assert.match(workerSource, /sourceEtag/);
  assert.match(workerSource, /txt-search-jump/, 'each TXT search result must expose a visible jump action');
  assert.match(workerSource, /textContent = '跳转'/, 'the TXT search result action must be labeled 跳转');
  assert.match(workerSource, /function setTxtReaderLoading\(/, 'long TXT navigation must expose a loading state');
  assert.match(workerSource, /正在跳转到搜索位置/, 'TXT search jump must show progress while loading remote chunks');
  assert.match(workerSource, /正在搜索正文/, 'TXT search must show the body-search state while the index is ready');
  assert.match(workerSource, /while \(cursor\)/, 'TXT search UI must consume cursors until the whole file has been scanned');
  assert.match(workerSource, /async function ensureTxtIndex\(/, 'TXT search must build the current novel index on demand');
  assert.match(workerSource, /txt_index_files/, 'D1 must persist TXT index file state');
  assert.match(workerSource, /charOffset/, 'indexed search results must expose exact character offsets');
  assert.match(workerSource, /txt-search-highlight/, 'TXT jumps must highlight the exact matched text');
  assert.match(workerSource, /txt-reader-jump-overlay/, 'long TXT jumps must cover incremental rendering with a consistent loading overlay');
  assert.match(workerSource, /function resetReaderToIndexedWindow\(/, 'indexed TXT results must reset the reader directly to the indexed chunk');
  assert.match(workerSource, /result\s*&&\s*result\.chunkByteOffset/, 'direct TXT jumps must consume indexed byte-page offsets');
  assert.match(workerSource, /result\s*&&\s*result\.chunkCharOffset/, 'direct TXT jumps must consume indexed character-page offsets');
  assert.match(workerSource, /anchorRatio/, 'reader progress must retain a location within the current chunk');
  assert.match(workerSource, /@media\s*\(prefers-reduced-motion:\s*reduce\)/, 'new TXT reader motion must respect reduced-motion preferences');
  assert.match(workerSource, /\.preview-actions\s*>\s*\.btn\s*\{\s*display:\s*none;/, 'mobile styles must hide only direct desktop actions');
  assert.doesNotMatch(workerSource, /\.preview-actions\s+\.btn\s*\{\s*display:\s*none;/, 'mobile styles must not hide search and bookmark panel buttons');

  assert.match(workerSource, /fetch\('\/api\/txt\/open\?'/, 'TXT opening must aggregate progress, metadata, and nearby content into one request');
  assert.match(workerSource, /indexedDB\.open\(TXT_CACHE_DB_NAME/, 'TXT content must use a persistent device-local IndexedDB cache');
  assert.match(workerSource, /READER_PROGRESS_CONFLICT/, 'global reading progress must reject stale device revisions');
  assert.match(workerSource, /baseRevision/, 'reader saves must carry the last synchronized global revision');
  assert.match(workerSource, /windowSource = 'd1'/, 'ready TXT indexes must serve nearby text from D1 before R2');

  const readerScrollStart = workerSource.indexOf('function scrollTxtReaderElementIntoView(');
  const readerScrollEnd = workerSource.indexOf('\n    async function scrollReaderToByteOffset', readerScrollStart);
  const readerScrollSource = workerSource.slice(readerScrollStart, readerScrollEnd);
  assert.ok(readerScrollStart >= 0 && readerScrollEnd > readerScrollStart, 'TXT reader must own an explicit scroll helper');
  assert.match(readerScrollSource, /reader\.scrollTop\s*=\s*targetTop/, 'search navigation must update the nested reader scroll container');
  assert.doesNotMatch(readerScrollSource, /scrollIntoView\(/, 'the nested reader helper must not delegate to the ambiguous outer-container scroll API');
  assert.match(workerSource, /return scrollTxtReaderElementIntoView\(state, resolvedChunk\.element, ratio\)/, 'character-offset jumps must preserve an exact in-chunk reading position');
  assert.match(workerSource, /return scrollTxtReaderElementIntoView\(state, firstMark\)/, 'highlighted global-search results must use the nested reader scroll helper');
  assert.match(workerSource, /getElementById\('txtSearchPanel'\)\.hidden = true/, 'successful in-reader result activation must close the search panel');
  assert.match(workerSource, /row\.addEventListener\('click', activateResult\)/, 'clicking an in-reader result row must activate the jump');
  assert.match(workerSource, /row\.setAttribute\('role', 'button'\)/, 'in-reader result rows must expose their click behavior');
}

await testTxtRoutes();
await testTxtSearchPagingAndBoundaries();
await testTxtIndexedSearchLifecycle();
await testReaderProgressAndBookmarks();
await testPathBoundPermissionsAndShares();
await testCachedAdminDirectoryNavigationAvoidsPerItemR2Checks();
await testVirtualDirectoryIncrementalAndGlobalTxtSearch();
await testD1ReadModelHotPaths();
testStaticContracts();
console.log('regression: TXT, reader, D1 read model, path-bound permission/share, virtual-directory and global-search contracts passed');
