// Git object layer: SHA-1 object ids, blob/tree/commit encoding, zlib.
// No git binary, no network: everything is computed in-process from buffers.
// Object ids are the real git ids (sha1("<type> <len>\0<bytes>")), so the
// REST surface (content sha = blob id, commit sha = commit id) and the git
// smart-HTTP surface agree on every id by construction.

import { createHash } from 'node:crypto';
import { inflateSync as zinflate, deflateSync as zdeflate } from 'node:zlib';

export function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object header framing: "<type> <len>\0" + payload. */
export function frameObject(type: string, payload: Buffer): Buffer {
  const header = Buffer.from(`${type} ${payload.length}\0`, 'ascii');
  return Buffer.concat([header, payload]);
}

/** Object id of a framed object. */
export function objectId(type: string, payload: Buffer): string {
  return sha1(frameObject(type, payload));
}

export function blobId(content: Buffer): string {
  return objectId('blob', content);
}

/** Parse a framed object (after inflate) into type + payload. */
export function parseObject(raw: Buffer): { type: string; payload: Buffer } {
  const nul = raw.indexOf(0);
  const header = raw.subarray(0, nul).toString('ascii');
  const [type] = header.split(' ');
  return { type, payload: Buffer.from(raw.subarray(nul + 1)) };
}

export function zlibInflate(data: Buffer): Buffer {
  return zinflate(data);
}

export function zlibDeflate(data: Buffer): Buffer {
  return zdeflate(data, { level: 6 });
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string; // e.g. "100644", "40000"
  name: string;
  sha: string;
}

/** Parse a tree payload into entries (sorted by git's order: name + '/' for dirs). */
export function parseTree(payload: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < payload.length) {
    const sp = payload.indexOf(0x20, i);
    const mode = payload.subarray(i, sp).toString('ascii');
    const nul = payload.indexOf(0, sp);
    const name = payload.subarray(sp + 1, nul).toString('utf8');
    const sha = payload.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    i = nul + 21;
  }
  return entries;
}

/** Git tree sort: entries sort by name, directories as if the name ends with '/'. */
export function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? `${e.name}/` : e.name;
}

export function buildTree(entries: TreeEntry[]): { payload: Buffer; sha: string } {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  const payload = Buffer.concat(parts);
  return { payload, sha: objectId('tree', payload) };
}

// ---------------------------------------------------------------- commits

export interface CommitData {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

const AUTHOR = 'adaiversen <adaiversen@example.invalid>';

export function buildCommit(c: CommitData): { payload: Buffer; sha: string } {
  const lines: string[] = [`tree ${c.tree}`];
  for (const p of c.parents) lines.push(`parent ${p}`);
  lines.push(`author ${c.author}`, `committer ${c.committer}`, '', c.message);
  const payload = Buffer.from(lines.join('\n'), 'utf8');
  return { payload, sha: objectId('commit', payload) };
}

export function parseCommit(payload: Buffer): CommitData {
  const text = payload.toString('utf8');
  const [head, ...rest] = text.split('\n\n');
  const message = rest.join('\n\n');
  const tree = /^tree ([0-9a-f]{40})$/m.exec(head)?.[1] ?? '';
  const parents = [...head.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1]);
  const author = /^author (.*)$/m.exec(head)?.[1] ?? AUTHOR;
  const committer = /^committer (.*)$/m.exec(head)?.[1] ?? AUTHOR;
  return { tree, parents, author, committer, message };
}

// ---------------------------------------------------------------- packfiles

/** One object inside a packfile, after delta resolution. */
export interface PackObject {
  type: 'commit' | 'tree' | 'blob' | 'tag';
  payload: Buffer;
  sha: string;
}

const PACK_TYPES: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta' };

/** Read a variable-length size field (pack object header). Returns [size, bytesRead]. */
function readVarint(buf: Buffer, off: number): [number, number] {
  let size = buf[off] & 0x0f;
  let shift = 4;
  let i = off + 1;
  let b = buf[off];
  while (b & 0x80) {
    b = buf[i++];
    size |= (b & 0x7f) << shift;
    shift += 7;
  }
  return [size, i - off];
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const readVar = (): number => {
    let v = 0;
    let shift = 0;
    while (true) {
      const b = delta[p++];
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readVar();
  const dstSize = readVar();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let outLen = 0;
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) off |= delta[p++] << (8 * i);
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) size |= delta[p++] << (8 * i);
      if (size === 0) size = 0x10000;
      out.push(base.subarray(off, off + size));
      outLen += size;
    } else if (op !== 0) {
      out.push(delta.subarray(p, p + op));
      p += op;
      outLen += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== dstSize || outLen !== dstSize) throw new Error('delta output size mismatch');
  return result;
}

/**
 * Parse a packfile (v2, no trailing checksum verification beyond the 20-byte
 * trailer) into resolved objects. Handles ofs-delta and ref-delta against
 * objects in the same pack and against objects already in `baseObjects`.
 */
export function parsePack(pack: Buffer, baseObjects?: Map<string, PackObject>): PackObject[] {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  let off = 12;
  const objects: PackObject[] = [];
  const byOffset = new Map<number, PackObject>();
  const bySha = new Map<string, PackObject>(baseObjects);
  // First pass: read all non-delta objects and record delta positions.
  const deltas: { start: number; typeNum: number; baseRef: string | number; data: Buffer; size: number }[] = [];
  for (let n = 0; n < count; n += 1) {
    const start = off;
    const typeNum = (pack[off] >> 4) & 0x7;
    const [size, hdrLen] = readVarint(pack, off);
    off += hdrLen;
    let baseRef: string | number | null = null;
    if (typeNum === 6) {
      // ofs-delta: negative offset
      let b = pack[off++];
      let deltaOff = b & 0x7f;
      while (b & 0x80) {
        b = pack[off++];
        deltaOff = ((deltaOff + 1) << 7) | (b & 0x7f);
      }
      baseRef = start - deltaOff;
    } else if (typeNum === 7) {
      baseRef = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const zoff = off;
    const data = zinflate(pack.subarray(zoff));
    // Find the true end of the zlib stream: inflateSync throws on a truncated
    // stream and succeeds (ignoring trailing bytes) on a complete one, so the
    // minimal prefix that inflates cleanly is the stream end (binary search).
    let lo = 2;
    let hi = pack.length - zoff;
    const tryInflate = (len: number): boolean => {
      try {
        zinflate(pack.subarray(zoff, zoff + len));
        return true;
      } catch {
        return false;
      }
    };
    // The minimal prefix that inflates cleanly is the stream end.
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tryInflate(mid)) hi = mid;
      else lo = mid + 1;
    }
    off = zoff + lo;
    if (typeNum === 6 || typeNum === 7) {
      deltas.push({ start, typeNum, baseRef: baseRef as string | number, data, size });
    } else {
      const type = PACK_TYPES[typeNum] as PackObject['type'];
      const payload = data;
      const sha = objectId(type, payload);
      const obj: PackObject = { type, payload, sha };
      objects.push(obj);
      byOffset.set(start, obj);
      bySha.set(sha, obj);
    }
  }
  // Resolve deltas in dependency order (repeat until all resolved).
  let pending = deltas;
  while (pending.length > 0) {
    const next: typeof pending = [];
    let progressed = false;
    for (const d of pending) {
      const base = typeof d.baseRef === 'number' ? byOffset.get(d.baseRef) : bySha.get(d.baseRef);
      if (!base) {
        next.push(d);
        continue;
      }
      const payload = applyDelta(base.payload, d.data);
      const type = base.type;
      const sha = objectId(type, payload);
      const obj: PackObject = { type, payload, sha };
      objects.push(obj);
      byOffset.set(d.start, obj);
      bySha.set(sha, obj);
      progressed = true;
    }
    if (!progressed) throw new Error('unresolvable pack delta');
    pending = next;
  }
  return objects;
}

/** Build a packfile (v2) of full (non-delta) objects. */
export function buildPack(objects: PackObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeNum = { commit: 1, tree: 2, blob: 3, tag: 4 }[obj.type];
    const size = obj.payload.length;
    // varint header: type in bits 4-6, size low 4 bits first
    const hdr: number[] = [];
    let s = size;
    let first = ((typeNum & 0x7) << 4) | (s & 0x0f);
    s >>= 4;
    if (s > 0) first |= 0x80;
    hdr.push(first);
    while (s > 0) {
      let b = s & 0x7f;
      s >>= 7;
      if (s > 0) b |= 0x80;
      hdr.push(b);
    }
    parts.push(Buffer.from(hdr));
    parts.push(zdeflate(obj.payload));
  }
  const trailer = createHash('sha1').update(Buffer.concat(parts)).digest();
  parts.push(trailer);
  return Buffer.concat(parts);
}
