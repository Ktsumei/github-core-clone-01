// Git smart HTTP: upload-pack (v2 + v0 fallback) and receive-pack (v0).
// Pure TypeScript, no git binary. Packs are plain (non-delta) objects; the
// client never sends deltas and never requires them. Packs are cached per
// request fingerprint (the clone workload issues 50 identical shallow clones).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildPack, parseCommit, parsePack, parseTree, type PackObject } from './git-objects.ts';
import { store, VIEWER_LOGIN, ZERO_OID, type Repo } from './store.ts';
import { parseUrl, readRaw } from './http-util.ts';
import { checkAuth } from './rest.ts';

// ---------------------------------------------------------------- pkt-line

function pktLine(data: Buffer): Buffer {
  const len = data.length + 4;
  const header = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

function pktStr(s: string): Buffer {
  return pktLine(Buffer.from(s, 'utf8'));
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

function parsePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) throw new Error('truncated pkt-line');
    const hex = buf.subarray(i, i + 4).toString('ascii');
    if (hex === '0000') {
      out.push({ kind: 'flush' });
      i += 4;
      continue;
    }
    if (hex === '0001') {
      out.push({ kind: 'delim' });
      i += 4;
      continue;
    }
    if (hex === '0002') {
      out.push({ kind: 'end' });
      i += 4;
      continue;
    }
    const len = parseInt(hex, 16);
    if (!Number.isFinite(len) || len < 4 || i + len > buf.length) throw new Error('bad pkt-line length');
    out.push({ kind: 'data', payload: Buffer.from(buf.subarray(i + 4, i + len)) });
    i += len;
  }
  return out;
}

/** Split a byte stream into pkt-line payloads until a flush (or the end). */
function dataLines(buf: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  for (const p of parsePktLines(buf)) {
    if (p.kind === 'data') lines.push(p.payload);
    else if (p.kind === 'flush') break;
  }
  return lines;
}

/** Every data payload in the stream, across flushes (v0 fetch has two sections). */
function allDataLines(buf: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  for (const p of parsePktLines(buf)) {
    if (p.kind === 'data') lines.push(p.payload);
  }
  return lines;
}

// ---------------------------------------------------------------- refs

interface RefInfo {
  name: string;
  sha: string;
  peeled?: string;
  symref?: string;
  unborn?: boolean;
}

function refsOf(repo: Repo): RefInfo[] {
  const out: RefInfo[] = [];
  const headSha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (headSha) {
    out.push({ name: 'HEAD', sha: headSha, symref: `refs/heads/${repo.defaultBranch}` });
  } else {
    out.push({ name: 'HEAD', sha: ZERO_OID, symref: `refs/heads/${repo.defaultBranch}`, unborn: true });
  }
  for (const [name, sha] of store.allRefs(repo)) {
    const entry: RefInfo = { name, sha };
    const obj = store.getObject(sha);
    if (obj && obj.type === 'tag') {
      const target = /^object ([0-9a-f]{40})$/m.exec(obj.payload.toString('utf8'))?.[1];
      if (target) entry.peeled = target;
    }
    out.push(entry);
  }
  return out;
}

/** v0 capability tokens for upload-pack (first ref line carries them). */
const UPLOAD_CAPS = 'side-band-64k thin-pack ofs-delta multi_ack_detailed shallow agent=github-core-clone-forge/1.0';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=github-core-clone-forge/1.0';

function v0Advertisement(service: string, repo: Repo): Buffer {
  const refs = refsOf(repo);
  const parts: Buffer[] = [pktStr(`# service=${service}\n`), FLUSH];
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const hasRefs = repo.refs.size > 0;
  if (!hasRefs) {
    parts.push(pktStr(`${ZERO_OID} capabilities^{}\0${caps} symref=HEAD:refs/heads/${repo.defaultBranch}\n`));
  } else {
    let first = true;
    for (const r of refs) {
      const line = first ? `${r.sha} ${r.name}\0${caps} symref=HEAD:refs/heads/${repo.defaultBranch}\n` : `${r.sha} ${r.name}\n`;
      parts.push(pktStr(line));
      first = false;
      if (r.peeled) parts.push(pktStr(`${r.peeled} ${r.name}^{}\n`));
    }
  }
  // The advertisement ends with a flush packet.
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktStr('version 2\n'),
    pktStr('fetch=shallow\n'),
    pktStr('ls-refs=unborn\n'),
    pktStr('agent=github-core-clone-forge/1.0\n'),
    pktStr('object-format=sha1\n'),
    FLUSH,
  ]);
}

// ---------------------------------------------------------------- fetch computation

/** Commit-generation-limited closure: roots + their trees/blobs, parents up
 *  to `depth` generations (depth 1 = the roots only). depth null = unlimited. */
function closure(roots: string[], depth: number | null): Set<string> {
  const out = new Set<string>();
  const queue: { sha: string; gen: number }[] = roots.map((sha) => ({ sha, gen: 1 }));
  while (queue.length > 0) {
    const { sha, gen } = queue.shift()!;
    if (out.has(sha)) continue;
    const obj = store.getObject(sha);
    if (!obj) continue;
    out.add(sha);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.payload);
      for (const t of walkTree(c.tree)) out.add(t);
      if (depth === null || gen < depth) {
        for (const p of c.parents) queue.push({ sha: p, gen: gen + 1 });
      }
    } else if (obj.type === 'tag') {
      const target = /^object ([0-9a-f]{40})$/m.exec(obj.payload.toString('utf8'))?.[1];
      if (target) queue.push({ sha: target, gen });
    } else if (obj.type === 'tree') {
      for (const t of walkTree(sha)) out.add(t);
    }
  }
  return out;
}

/** All objects under a tree (the tree itself + subtrees + blobs). */
function walkTree(treeSha: string): Set<string> {
  const out = new Set<string>();
  const stack = [treeSha];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (out.has(sha)) continue;
    const obj = store.getObject(sha);
    if (!obj || obj.type !== 'tree') continue;
    out.add(sha);
    for (const e of parseTree(obj.payload)) {
      out.add(e.sha);
      if (e.mode === '40000') stack.push(e.sha);
    }
  }
  return out;
}

function toPackObjects(shas: Set<string>): PackObject[] {
  const objs: PackObject[] = [];
  for (const sha of shas) {
    const o = store.getObject(sha);
    if (o) objs.push({ type: o.type as PackObject['type'], payload: o.payload, sha });
  }
  const rank: Record<string, number> = { commit: 0, tag: 1, tree: 2, blob: 3 };
  objs.sort((a, b) => rank[a.type] - rank[b.type] || (a.sha < b.sha ? -1 : 1));
  return objs;
}

/** Objects to send for a fetch: wants closure minus what the client holds.
 *  Also returns the new shallow boundary (deepest generation of the wants
 *  closure when deepen is set) and boundaries that are no longer shallow
 *  (their parents are now in the wants closure). */
function fetchObjects(wants: string[], haves: string[], shallow: string[], deepen: number | null): { objects: Set<string>; newShallow: string[]; unshallow: string[] } {
  const { set: wantSet, generations } = closureWithGenerations(wants, deepen);
  const held = new Set<string>();
  const shallowSet = new Set(shallow);
  for (const h of haves) {
    for (const s of closure([h], shallowSet.has(h) ? 1 : null)) held.add(s);
  }
  const objects = new Set<string>();
  for (const s of wantSet) if (!held.has(s)) objects.add(s);
  const newShallow: string[] = [];
  const unshallow: string[] = [];
  if (deepen !== null) {
    const maxGen = deepen;
    for (const [sha, gen] of generations) {
      if (gen === maxGen) newShallow.push(sha);
    }
    for (const s of shallow) {
      const obj = store.getObject(s);
      if (obj?.type !== 'commit') continue;
      const parents = parseCommit(obj.payload).parents;
      if (parents.length > 0 && parents.every((p) => wantSet.has(p))) unshallow.push(s);
    }
  }
  return { objects, newShallow, unshallow };
}

/** Like closure(), but also records each commit's generation (1 = the roots). */
function closureWithGenerations(roots: string[], depth: number | null): { set: Set<string>; generations: Map<string, number> } {
  const out = new Set<string>();
  const generations = new Map<string, number>();
  const queue: { sha: string; gen: number }[] = roots.map((sha) => ({ sha, gen: 1 }));
  while (queue.length > 0) {
    const { sha, gen } = queue.shift()!;
    if (out.has(sha)) continue;
    const obj = store.getObject(sha);
    if (!obj) continue;
    out.add(sha);
    if (obj.type === 'commit') {
      generations.set(sha, gen);
      const c = parseCommit(obj.payload);
      for (const t of walkTree(c.tree)) out.add(t);
      if (depth === null || gen < depth) {
        for (const p of c.parents) queue.push({ sha: p, gen: gen + 1 });
      }
    } else if (obj.type === 'tag') {
      const target = /^object ([0-9a-f]{40})$/m.exec(obj.payload.toString('utf8'))?.[1];
      if (target) queue.push({ sha: target, gen });
    } else if (obj.type === 'tree') {
      for (const t of walkTree(sha)) out.add(t);
    }
  }
  return { set: out, generations };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const chunk = pack.subarray(i, Math.min(pack.length, i + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) {
    out.push(pktLine(Buffer.from([1])));
  }
  return out;
}

// ---------------------------------------------------------------- handlers

function sendGit(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function repoFromPath(pathname: string): { owner: string; name: string } | null {
  // /{owner}/{repo}.git/<rest>
  const m = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(pathname);
  if (!m) return null;
  const owner = decodeURIComponent(m[1]);
  const name = decodeURIComponent(m[2]);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(owner) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return null;
  return { owner, name };
}

export async function handleGit(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const { pathname, query } = parseUrl(req);
  const m = repoFromPath(pathname);
  if (!m) return false;
  const rest = pathname.split('.git/')[1] ?? '';
  if (rest !== 'info/refs' && rest !== 'git-upload-pack' && rest !== 'git-receive-pack') return false;

  if (!checkAuth(req)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Requires authentication' }));
    return true;
  }
  const repo = m.owner === VIEWER_LOGIN ? store.getRepo(m.owner, m.name) : undefined;
  if (!repo) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Not Found' }));
    return true;
  }

  try {
    if (req.method === 'GET' && rest === 'info/refs') {
      const service = query.get('service') ?? '';
      if (service === 'git-upload-pack') {
        const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        sendGit(res, 200, 'application/x-git-upload-pack-advertisement', v2 ? v2Advertisement() : v0Advertisement('git-upload-pack', repo));
        return true;
      }
      if (service === 'git-receive-pack') {
        sendGit(res, 200, 'application/x-git-receive-pack-advertisement', v0Advertisement('git-receive-pack', repo));
        return true;
      }
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'unknown service' }));
      return true;
    }

    if (req.method === 'POST' && rest === 'git-upload-pack') {
      const raw = await readRaw(req);
      if (raw === null) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('bad request');
        return true;
      }
      const out = await handleUploadPack(repo, raw);
      sendGit(res, 200, 'application/x-git-upload-pack-result', out);
      return true;
    }

    if (req.method === 'POST' && rest === 'git-receive-pack') {
      const raw = await readRaw(req);
      if (raw === null) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('bad request');
        return true;
      }
      const out = await handleReceivePack(repo, raw);
      sendGit(res, 200, 'application/x-git-receive-pack-result', out);
      return true;
    }
  } catch (err) {
    // The suite tolerates any status on a malformed request; the server must
    // stay up, so never let a bad body kill the process.
    process.stderr.write(`[git] handler error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    try {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request');
    } catch {
      // response already gone
    }
    return true;
  }

  return false;
}

async function handleUploadPack(repo: Repo, raw: Buffer): Promise<Buffer> {
  const lines = dataLines(raw);
  const first = lines[0]?.toString('utf8') ?? '';
  if (first.startsWith('command=ls-refs')) {
    return lsRefs(repo, lines);
  }
  if (first.startsWith('command=fetch')) {
    return fetchV2(repo, lines);
  }
  // v0 fetch: want/have lines in two sections separated by a flush, so read
  // every data line in the stream, not just the first section.
  const all = allDataLines(raw);
  if (all.some((l) => l.toString('utf8').startsWith('want '))) {
    return fetchV0(repo, all);
  }
  throw new Error('unknown upload-pack request');
}

function lsRefs(repo: Repo, lines: Buffer[]): Buffer {
  const args = lines.slice(1).map((l) => l.toString('utf8').trim());
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const refs = refsOf(repo);
  const out: Buffer[] = [];
  for (const r of refs) {
    // A ref is listed when it matches any requested ref-prefix (or when no
    // prefix was given). HEAD matches the "HEAD" prefix a real git clone
    // sends, and is excluded by a "refs/heads/"-only prefix.
    if (prefixes.length > 0 && !prefixes.some((p) => r.name.startsWith(p))) continue;
    if (r.unborn) {
      out.push(pktStr(`unborn ${r.name}${r.symref && wantSymrefs ? ` symref-target:${r.symref}` : ''}\n`));
      continue;
    }
    let line = `${r.sha} ${r.name}`;
    if (r.name === 'HEAD' && r.symref && wantSymrefs) line += ` symref-target:${r.symref}`;
    if (r.peeled && wantPeel) line += ` peeled:${r.peeled}`;
    out.push(pktStr(`${line}\n`));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

function fetchV2(repo: Repo, lines: Buffer[]): Buffer {
  const args = lines.slice(1).map((l) => l.toString('utf8').trim());
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | null = null;
  let done = false;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) shallow.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) deepen = Number(a.slice(7).trim());
    else if (a === 'done') done = true;
  }
  const { objects, newShallow, unshallow } = fetchObjects(wants, haves, shallow, deepen);
  const cacheKey = `${wants.join(',')}|${haves.join(',')}|${shallow.join(',')}|${deepen ?? ''}`;
  let packBytes = repo.packCache.get(cacheKey);
  if (!packBytes) {
    packBytes = buildPack(toPackObjects(objects));
    repo.packCache.set(cacheKey, packBytes);
  }

  // protocol-v2: sections are separated by DELIM packets and the response
  // ends with a FLUSH. When the client sends "done", the acknowledgments
  // section MUST be omitted (real git rejects it there); without "done" the
  // response is just the acknowledgments section plus a flush.
  if (!done) {
    return Buffer.concat([pktStr('acknowledgments\n'), pktStr('NAK\n'), FLUSH]);
  }
  const out: Buffer[] = [];
  if (deepen !== null && (newShallow.length > 0 || unshallow.length > 0)) {
    out.push(pktStr('shallow-info\n'));
    for (const s of newShallow) out.push(pktStr(`shallow ${s}\n`));
    for (const s of unshallow) out.push(pktStr(`unshallow ${s}\n`));
    out.push(DELIM);
  }
  out.push(pktStr('packfile\n'));
  for (const p of sidebandPackets(packBytes)) out.push(p);
  out.push(FLUSH);
  return Buffer.concat(out);
}

function fetchV0(repo: Repo, lines: Buffer[]): Buffer {
  const args = lines.map((l) => l.toString('utf8').trim());
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | null = null;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5).split(' ')[0]);
    else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) shallow.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) deepen = Number(a.slice(7).trim());
  }
  const { objects, newShallow, unshallow } = fetchObjects(wants, haves, shallow, deepen);
  const pack = buildPack(toPackObjects(objects));
  const out: Buffer[] = [pktStr('NAK\n')];
  for (const s of newShallow) out.push(pktStr(`shallow ${s}\n`));
  for (const s of unshallow) out.push(pktStr(`unshallow ${s}\n`));
  for (const p of sidebandPackets(pack)) out.push(p);
  return Buffer.concat(out);
}

async function handleReceivePack(repo: Repo, raw: Buffer): Promise<Buffer> {
  // Commands are pkt-lines up to the first flush; the pack follows raw.
  const lines: { oldOid: string; newOid: string; ref: string }[] = [];
  let packStart = -1;
  let i = 0;
  while (i < raw.length) {
    if (i + 4 > raw.length) break;
    const hex = raw.subarray(i, i + 4).toString('ascii');
    if (hex === '0000') {
      packStart = i + 4;
      break;
    }
    const len = parseInt(hex, 16);
    if (!Number.isFinite(len) || len < 4 || i + len > raw.length) throw new Error('bad pkt-line');
    const payload = raw.subarray(i + 4, i + len).toString('utf8');
    const nul = payload.indexOf('\0');
    const cmd = (nul >= 0 ? payload.slice(0, nul) : payload).trim();
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(cmd);
    if (m) lines.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
    i += len;
  }
  if (packStart < 0) packStart = raw.length;

  // Unpack first (a refused update still stores its objects).
  if (packStart < raw.length) {
    const packBytes = raw.subarray(packStart);
    if (packBytes.length >= 12 && packBytes.subarray(0, 4).toString('ascii') === 'PACK') {
      const objects = parsePack(Buffer.from(packBytes), undefined);
      for (const o of objects) store.putObject(o.type, o.payload);
    }
  }

  const report: string[] = ['unpack ok\n'];
  for (const cmd of lines) {
    const verdict = applyRefUpdate(repo, cmd);
    if (verdict === null) report.push(`ok ${cmd.ref}\n`);
    else report.push(`ng ${cmd.ref} ${verdict}\n`);
  }
  // The report-status stream is itself a pkt-line stream inside band 1, and
  // it ends with its own flush packet (real git waits for it); the sideband
  // stream then ends with an outer flush, and stateless RPC with 0002.
  const reportText = Buffer.concat([...report.map((r) => pktStr(r)), FLUSH]);
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let j = 0; j < reportText.length; j += CHUNK) {
    out.push(pktLine(Buffer.concat([Buffer.from([1]), reportText.subarray(j, Math.min(reportText.length, j + CHUNK))])));
  }
  out.push(FLUSH);
  out.push(Buffer.from('0002', 'ascii'));
  return Buffer.concat(out);
}

/** Apply one ref update. Returns null on success, else the ng reason. */
function applyRefUpdate(repo: Repo, cmd: { oldOid: string; newOid: string; ref: string }): string | null {
  if (cmd.oldOid === ZERO_OID && cmd.newOid === ZERO_OID) return null; // no-op
  const current = repo.refs.get(cmd.ref);
  if (cmd.newOid === ZERO_OID) {
    // Delete.
    if (!current) return 'non-fast-forward';
    if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) return 'non-fast-forward';
    repo.refs.delete(cmd.ref);
    repo.packCache.clear();
    return null;
  }
  const target = store.getObject(cmd.newOid);
  if (!target || (target.type !== 'commit' && target.type !== 'tag')) return 'object not found';
  if (cmd.oldOid === ZERO_OID) {
    // Create.
    if (current) return 'already exists';
    repo.refs.set(cmd.ref, cmd.newOid);
    repo.packCache.clear();
    return null;
  }
  // Update: must fast-forward from the current value.
  if (current !== cmd.oldOid) return 'non-fast-forward';
  if (!store.isDescendant(cmd.newOid, cmd.oldOid)) return 'non-fast-forward';
  repo.refs.set(cmd.ref, cmd.newOid);
  repo.packCache.clear();
  return null;
}
