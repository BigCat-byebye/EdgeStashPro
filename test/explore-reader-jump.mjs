// Exploration: simulate the reader's incremental chunk decode + char tracking,
// then verify that the server's indexed-search charOffset matches the reader's
// decoded character offsets. Not part of the harness — a diagnostic tool.
import { readFile } from 'node:fs/promises';
import worker from '../worker.js';

const encoder = new TextEncoder();

function toBase64Url(value) {
  const bytes = value instanceof Uint8Array ? value : encoder.encode(value);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function signAdminCookie(secret) {
  const header = toBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = toBase64Url(JSON.stringify({ role: 'admin', exp: Date.now() + 60_000 }));
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${header}.${payload}`));
  return `token=${header}.${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

function makeObject(key, bytes, etag = '"txt-v1"') {
  const bodyBytes = bytes instanceof Uint8Array ? bytes : encoder.encode(bytes);
  return {
    key, size: bodyBytes.length, version: etag, etag: etag.replaceAll('"', ''), httpEtag: etag,
    uploaded: new Date('2026-08-03T00:00:00.000Z'),
    httpMetadata: { contentType: 'text/plain; charset=utf-8' },
    range: undefined,
    body: new ReadableStream({ start(controller) { controller.enqueue(bodyBytes); controller.close(); } }),
    async arrayBuffer() { throw new Error('guard'); },
    async text() { throw new Error('guard'); }
  };
}

function makeR2(record) {
  return {
    async head(key) { return record ? { ...makeObject('notes.txt', record.bytes, record.etag), body: undefined } : null; },
    async get(key, options = {}) {
      if (!record) return null;
      const range = options.range;
      if (!range) return makeObject(key, record.bytes, record.etag);
      const offset = Number(range.offset || 0);
      const length = Number(range.length ?? (record.bytes.length - offset));
      const bounded = record.bytes.slice(offset, Math.min(record.bytes.length, offset + length));
      const ranged = makeObject(key, bounded, record.etag);
      ranged.range = { offset, length: bounded.length };
      return ranged;
    },
    async list() { return { objects: [], delimitedPrefixes: [], truncated: false }; },
    async put(key, value) {
      const bytes = value instanceof Uint8Array ? value : encoder.encode(value);
      record = { bytes, etag: '"v2"' };
      return { ...makeObject(key, bytes, '"v2"'), body: undefined };
    },
    async delete() {}
  };
}

class KV { async get() { return null; } async put() {} async delete() {} async list() { return { keys: [], list_complete: true }; } }

class MemD1 {
  constructor() { this.tables = new Map(); this.tables.set('txt_index_files', []); this.tables.set('txt_index_chunks', []); }
  prepare(sql) {
    const make = (args) => ({
      bind: (...next) => make(next),
      run: () => this.run(sql, args),
      first: async () => (await this.all(sql, args)).results[0] || null,
      all: async () => this.all(sql, args)
    });
    return make([]);
  }

  async batch(stmts) { for (const s of stmts) await s.run(); return {}; }
  async run(sql, args) {
    if (process.env.DEBUG_D1) console.log('RUN:', sql.trim().slice(0, 120), '| args:', JSON.stringify(args));
    const lower = sql.trim().toLowerCase();
    if (lower.startsWith('create')) return {};
    if (lower.startsWith('delete from')) {
      const table = /from\s+(\w+)/i.exec(sql)[1].toLowerCase();
      const path = args[0];
      this.tables.set(table, this.tables.get(table).filter(r => !(r.path === path || path.startsWith(r.path === '/' ? '/' : r.path + '/'))));
      return {};
    }
    if (lower.startsWith('insert')) {
      const table = /into\s+(\w+)/i.exec(sql)[1].toLowerCase();
      const cols = /\(([^)]+)\)/.exec(sql)[1].split(',').map(c => c.trim());
      const row = {}; cols.forEach((c, i) => { row[c] = args[i]; });
      if (process.env.DEBUG_D1) console.log('INSERT into', table, JSON.stringify(cols), 'len args:', args.length);
      const existing = this.tables.get(table).find(r => r.path === row.path && r.chunk_no === row.chunk_no);
      if (existing) Object.assign(existing, row); else this.tables.get(table).push(row);
      return {};
    }
    if (lower.startsWith('update')) {
      const table = /update\s+(\w+)/i.exec(sql)[1].toLowerCase();
      const row = this.tables.get(table).find(r => r.path === args[args.length - 2] && r.source_etag === args[args.length - 1]);
      if (row) {
        if (lower.includes("set status = 'ready'")) { row.status = 'ready'; row.indexed_at = args[0]; row.updated_at = args[1]; row.error_message = null; }
        else if (lower.includes("set status = 'error'")) { row.status = 'error'; row.error_message = args[0]; row.updated_at = args[1]; }
        else { row.status = args[0]; row.scanned_bytes = args[1]; row.next_offset = args[2]; row.next_chunk_no = args[3]; row.next_char_offset = args[4]; row.total_chars = args[5]; row.tail_text = args[6]; row.error_message = null; row.indexed_at = args[7]; row.updated_at = args[8]; }
      }
      return {};
    }
    return {};
  }
  async all(sql, args) {
    if (process.env.DEBUG_D1) console.log('ALL:', sql.trim().slice(0, 120), '| args:', JSON.stringify(args));
    const lower = sql.trim().toLowerCase();
    const pragma = /PRAGMA table_info\(([A-Za-z_][A-Za-z0-9_]*)\)/i.exec(sql);
    if (pragma) return { results: [] };
    const table = /from\s+(\w+)/i.exec(sql)[1].toLowerCase();
    if (process.env.DEBUG_D1) console.log('ALL table:', table, sql.trim().slice(0, 60));
    const rows = this.tables.get(table) || [];
    if (lower.includes("where path = ?") && table === 'txt_index_files') return { results: rows.filter(r => r.path === args[0]) };
    if (lower.includes("where path = ?") && table === 'txt_index_chunks') {
      if (!args || args.length < 5) { console.log('DEBUG all txt_index_chunks args:', JSON.stringify(args), 'sql:', sql); }
      const pattern = String(args[3] || '');
      const inner = pattern.slice(1, -1);
      const startChunk = Number(args[2]);
      const limit = Number(args[4]);
      return { results: rows.filter(r => r.path === args[0] && r.source_etag === args[1] && Number(r.chunk_no) >= startChunk && String(r.content).includes(inner)).sort((a, b) => Number(a.chunk_no) - Number(b.chunk_no)).slice(0, limit) };
    }
    return { results: rows };
  }
}

// Build a realistic UTF-8 novel: paragraphs of Chinese text, several MB.
function buildNovel() {
  const para = '这是一段中文小说的正文内容，来自于一个虚构的故事。'.repeat(40);
  const parts = [];
  for (let i = 0; i < 60; i++) {
    parts.push(`第${i + 1}章 风起云涌 灵狐传说开始。\n`);
    parts.push(para + '\n');
  }
  parts.push('最终章 灵狐传说 的结局。\n');
  return parts.join('');
}

async function main() {
  const text = buildNovel();
  const bytes = encoder.encode(text);
  const record = { bytes, etag: '"novel-v1"' };
  const env = {
    ADMIN_PASSWORD: 'secret',
    R2_BUCKET: makeR2(record),
    KV_STORE: new KV(),
    D1_DB: new MemD1()
  };
  const cookie = await signAdminCookie(env.ADMIN_PASSWORD);

  async function req(path, init) {
    const headers = new Headers(init?.headers || {});
    headers.set('Cookie', cookie);
    return worker.fetch(new Request(`https://example.test${path}`, { ...init, headers }), env);
  }

  // Build the index to completion.
  const target = '灵狐传说';
  console.log('novel bytes:', bytes.length);
  for (let attempt = 0; attempt < 400; attempt++) {
    const r = await req('/api/txt/index?path=%2Fnotes.txt', { method: 'POST' });
    const body = await r.json();
    if (attempt < 5 || body.done) console.log('build step', attempt + 1, 'status:', r.status, 'done:', body.done, 'idx:', body.index && body.index.status, body.message || '');
    if (body.done) break;
  }

  const search = await req('/api/txt/search?path=%2Fnotes.txt&q=' + encodeURIComponent(target) + '&limit=50');
  const body = await search.json();
  console.log('search status:', search.status, 'indexed:', body.indexed, 'results:', (body.results || []).length, 'code:', body.code, 'message:', body.message || '');
  if (!body.results || body.results.length === 0) {
    console.log('full search body keys:', Object.keys(body));
  }
  const result = body.results[0];
  console.log('first result charOffset:', result.charOffset, 'match:', JSON.stringify(result.match), 'byteOffset:', result.byteOffset);

  // Simulate the reader: load 128KB chunks, decode streaming, track char offsets.
  const metaResp = await req('/api/txt/meta?path=%2Fnotes.txt');
  const meta = await metaResp.json();
  console.log('meta encoding:', meta.encoding, 'byteOffset:', meta.byteOffset, 'size:', meta.size, 'chunkSize:', meta.chunkSize);

  const chunkSize = meta.chunkSize;
  const decoder = new TextDecoder(meta.encoding);
  let nextByteOffset = meta.byteOffset;
  let decodedChars = 0;
  const chunks = [];
  while (true) {
    const start = nextByteOffset;
    const length = Math.min(chunkSize, meta.size - start);
    const r = await req(`/api/txt/chunk?path=%2Fnotes.txt&offset=${start}&length=${length}`);
    if (r.status !== 206) { console.log('chunk fetch status', r.status); break; }
    const buf = await r.arrayBuffer();
    const bytesArr = new Uint8Array(buf);
    const decoded = decoder.decode(bytesArr, { stream: true });
    chunks.push({ byteStart: start, byteEnd: start + bytesArr.length, charStart: decodedChars, charEnd: decodedChars + decoded.length });
    decodedChars += decoded.length;
    nextByteOffset = start + bytesArr.length;
    if (nextByteOffset >= meta.size) {
      const tail = decoder.decode(new Uint8Array(), { stream: false });
      if (tail.length) {
        const last = chunks[chunks.length - 1];
        last.charEnd += tail.length;
        decodedChars += tail.length;
      }
      break;
    }
  }

  // Now find which chunk contains result.charOffset and whether the text there matches.
  const targetChar = result.charOffset;
  const chunk = chunks.find(c => targetChar >= c.charStart && targetChar < c.charEnd);
  console.log('simulated chunks:', chunks.length, 'total chars:', decodedChars, 'index totalChars:', body.totalChars);
  console.log('chunk containing charOffset:', chunk ? JSON.stringify(chunk) : 'NOT FOUND');
  console.log('charOffset === totalChars?', targetChar, decodedChars);

  // Verify against the true text: does text.slice(charOffset, +len) === query?
  const trueSlice = text.slice(targetChar, targetChar + target.length);
  console.log('true text at charOffset:', JSON.stringify(trueSlice), '=== query?', trueSlice === target);
}

main().catch(err => { console.error(err); process.exit(1); });