import { DatabaseSync } from 'node:sqlite';

/* ---------- shim D1 ---------- */
export function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args), meta: {} }),
    _exec: () => { const s = db.prepare(sql); return /^\s*(select|with)/i.test(sql) ? { results: s.all(...args) } : (() => { const r = s.run(...args); return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; })(); },
  });
  return {
    exec: (s) => db.exec(s),
    prepare: (sql) => stmt(sql),
    batch: async (list) => { db.exec('BEGIN'); try { const out = list.map((s) => s._exec()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } },
  };
}

/* ---------- shim R2 ---------- */
export function makeR2() {
  const store = new Map();
  const toBuf = async (v) => (v instanceof ReadableStream ? Buffer.from(await new Response(v).arrayBuffer()) : Buffer.from(v));
  const meta = (key, o) => ({ key, size: o.buf.length, httpEtag: `"${key.length}-${o.buf.length}"`, writeHttpMetadata: (h) => h.set('content-type', o.ct) });
  return {
    store,
    put: async (key, v, opts) => { store.set(key, { buf: await toBuf(v), ct: opts?.httpMetadata?.contentType || 'application/octet-stream' }); },
    list: async () => ({ objects: [] }),
    head: async (key) => (store.has(key) ? meta(key, store.get(key)) : null),
    get: async (key, opts = {}) => {
      const o = store.get(key); if (!o) return null;
      let buf = o.buf, range;
      const rh = opts.range?.get?.('range');
      if (rh) { const m = rh.match(/bytes=(\d+)-(\d*)/); const s = +m[1], e = m[2] ? +m[2] : buf.length - 1; buf = buf.subarray(s, e + 1); range = { offset: s, length: buf.length }; }
      return { ...meta(key, o), body: new Response(buf).body, range };
    },
    delete: async (k) => { for (const x of [].concat(k)) store.delete(x); },
  };
}

