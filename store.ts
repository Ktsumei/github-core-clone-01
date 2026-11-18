// The forge's in-memory store. One process, no disk, no clock: every id is a
// counter and every timestamp is the trial's fixed "now" plus a monotonic
// sequence, so two runs of the same request sequence produce identical state
// (the replay check compares the suite's export byte for byte).
//
// The viewer login is the competition's sealed scenario viewer (wire.ts
// buildScenario, seed 6a09e667f3bcc909, deterministic in every trial):
// "adaiversen". The bearer token comes from MAKEFUN_SHOP_TOKEN.

import { blobId, buildCommit, buildTree, objectId, parseCommit, parseTree } from './git-objects.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;

export const ZERO_OID = '0'.repeat(40);

/** Deterministic clock: trial now + 1s per stamp, in creation order. */
const BASE_MS = Date.parse(process.env.MAKEFUN_TRIAL_NOW ?? '2026-11-14T06:30:00.000Z');
let stampSeq = 0;
export function stamp(): string {
  return new Date(BASE_MS + stampSeq++ * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The deterministic git identity stamp (author/committer line). */
export function ident(): string {
  return `${VIEWER_LOGIN} <${VIEWER_EMAIL}> ${Math.floor(BASE_MS / 1000)} +0000`;
}

let repoIdSeq = 0;
let commentIdSeq = 0;

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  /** Files the head changed vs the merge base, with their head blob shas. */
  files: { filename: string; status: 'added' | 'modified'; additions: number; deletions: number; headSha: string | null; baseSha: string | null }[];
  createdAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  issueSeq: number;
  pulls: Pull[];
  pullSeq: number;
  comments: Map<number, Comment[]>;
  commentSeq: number;
  /** Pack cache for the clone workload: key = tip + ':' + depth. */
  packCache: Map<string, Buffer>;
}

export class Store {
  repos = new Map<string, Repo>(); // key: owner + '/' + name
  /** Global git object store: sha -> {type, payload}. Content-addressed, so
   *  sharing across repos is safe: reachability is always walked from refs. */
  objects = new Map<string, { type: string; payload: Buffer }>();

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(this.repoKey(VIEWER_LOGIN, name))) return null;
    const repo: Repo = {
      id: ++repoIdSeq,
      name,
      owner: VIEWER_LOGIN,
      description,
      isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      issues: [],
      issueSeq: 0,
      pulls: [],
      pullSeq: 0,
      comments: new Map(),
      commentSeq: 0,
      packCache: new Map(),
    };
    this.repos.set(this.repoKey(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === VIEWER_LOGIN);
  }

  putObject(type: string, payload: Buffer): string {
    const sha = objectId(type, payload);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, payload });
    return sha;
  }

  getObject(sha: string): { type: string; payload: Buffer } | undefined {
    return this.objects.get(sha.toLowerCase());
  }

  /** Resolve a ref to a sha, or undefined. HEAD resolves to the default branch. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    return repo.refs.get(ref);
  }

  /** All refs of a repo as [name, sha] pairs, sorted by name. */
  allRefs(repo: Repo): [string, string][] {
    return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }

  /** Walk commit parents: is `desc` a descendant of (or equal to) `anc`? */
  isDescendant(desc: string, anc: string): boolean {
    if (desc === anc) return true;
    const seen = new Set<string>();
    const stack = [desc];
    while (stack.length > 0) {
      const sha = stack.pop()!;
      if (sha === anc) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const obj = this.getObject(sha);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.payload).parents) stack.push(p);
    }
    return false;
  }

  /** Reachable object shas from a set of roots (commits/tags), following
   *  commit->tree+parents, tag->target, tree->entries (skip gitlinks). */
  reachable(roots: string[]): Set<string> {
    const out = new Set<string>();
    const stack = [...roots];
    while (stack.length > 0) {
      const sha = stack.pop()!;
      if (out.has(sha)) continue;
      const obj = this.getObject(sha);
      if (!obj) continue;
      out.add(sha);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.payload);
        stack.push(c.tree);
        for (const p of c.parents) stack.push(p);
      } else if (obj.type === 'tag') {
        const target = /^object ([0-9a-f]{40})$/m.exec(obj.payload.toString('utf8'))?.[1];
        if (target) stack.push(target);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.payload)) {
          if (e.mode !== '160000') stack.push(e.sha);
        }
      }
    }
    return out;
  }

  /** Read a file's blob sha at a commit's tree, following a path. */
  blobAt(commitSha: string, path: string): string | null {
    const commit = this.getObject(commitSha);
    if (!commit || commit.type !== 'commit') return null;
    const parts = path.split('/').filter((p) => p.length > 0);
    let treeSha = parseCommit(commit.payload).tree;
    for (let i = 0; i < parts.length; i += 1) {
      const tree = this.getObject(treeSha);
      if (!tree || tree.type !== 'tree') return null;
      const entry = parseTree(tree.payload).find((e) => e.name === parts[i]);
      if (!entry) return null;
      if (i === parts.length - 1) return entry.mode === '100644' ? entry.sha : null;
      if (entry.mode !== '40000') return null;
      treeSha = entry.sha;
    }
    return null;
  }

  /** List a directory's entries at a commit's tree (null when not a dir). */
  dirAt(commitSha: string, path: string): { name: string; path: string; sha: string; type: 'file' | 'dir' }[] | null {
    const commit = this.getObject(commitSha);
    if (!commit || commit.type !== 'commit') return null;
    const parts = path.split('/').filter((p) => p.length > 0);
    let treeSha = parseCommit(commit.payload).tree;
    for (const part of parts) {
      const tree = this.getObject(treeSha);
      if (!tree || tree.type !== 'tree') return null;
      const entry = parseTree(tree.payload).find((e) => e.name === part);
      if (!entry || entry.mode !== '40000') return null;
      treeSha = entry.sha;
    }
    const tree = this.getObject(treeSha);
    if (!tree || tree.type !== 'tree') return null;
    return parseTree(tree.payload).map((e) => ({
      name: e.name,
      path: parts.length > 0 ? `${parts.join('/')}/${e.name}` : e.name,
      sha: e.sha,
      type: e.mode === '40000' ? ('dir' as const) : ('file' as const),
    }));
  }

  /**
   * Commit a new tree state on top of `parentSha` (or as a root commit when
   * parentSha is null), setting one file's content. Returns the new commit sha.
   * Directory trees are rebuilt bottom-up; unchanged subtrees are reused.
   */
  commitFile(repo: Repo, parentSha: string | null, path: string, content: Buffer, message: string, author?: string): { commitSha: string; blobSha: string } {
    const blobSha = this.putObject('blob', content);
    const parts = path.split('/').filter((p) => p.length > 0);
    const parentTree = parentSha ? parseCommit(this.getObject(parentSha)!.payload).tree : null;
    const newTree = this.writeTree(parentTree, parts, blobSha);
    const ident = author ?? `${VIEWER_LOGIN} <${VIEWER_EMAIL}> ${Math.floor(BASE_MS / 1000)} +0000`;
    const commit = buildCommit({
      tree: newTree,
      parents: parentSha ? [parentSha] : [],
      author: ident,
      committer: ident,
      message,
    });
    const commitSha = this.putObject('commit', commit.payload);
    return { commitSha, blobSha };
  }

  /** Rebuild the tree chain for one path change; returns the new root tree sha. */
  private writeTree(treeSha: string | null, parts: string[], blobSha: string): string {
    if (parts.length === 1) {
      const entries = treeSha ? parseTree(this.getObject(treeSha)!.payload) : [];
      const next = entries.filter((e) => e.name !== parts[0]);
      next.push({ mode: '100644', name: parts[0], sha: blobSha });
      const t = buildTree(next);
      return this.putObject('tree', t.payload);
    }
    const entries = treeSha ? parseTree(this.getObject(treeSha)!.payload) : [];
    const child = entries.find((e) => e.name === parts[0]);
    const childTree = child && child.mode === '40000' ? child.sha : null;
    const newChild = this.writeTree(childTree, parts.slice(1), blobSha);
    const next = entries.filter((e) => e.name !== parts[0]);
    next.push({ mode: '40000', name: parts[0], sha: newChild });
    const t = buildTree(next);
    return this.putObject('tree', t.payload);
  }

  /** Delete one file from a commit's tree. Returns {sha, removed}: sha is the
   *  new tree sha, or null when the tree became empty (caller prunes the
   *  parent dir, or uses the empty tree at the root); removed false means the
   *  file was not present. */
  deleteFromTree(treeSha: string, parts: string[]): { sha: string | null; removed: boolean } {
    const entries = parseTree(this.getObject(treeSha)!.payload);
    if (parts.length === 1) {
      const next = entries.filter((e) => e.name !== parts[0]);
      if (next.length === entries.length) return { sha: treeSha, removed: false };
      if (next.length === 0) return { sha: null, removed: true };
      const t = buildTree(next);
      return { sha: this.putObject('tree', t.payload), removed: true };
    }
    const child = entries.find((e) => e.name === parts[0]);
    if (!child || child.mode !== '40000') return { sha: treeSha, removed: false };
    const res = this.deleteFromTree(child.sha, parts.slice(1));
    if (!res.removed) return { sha: treeSha, removed: false };
    let next: { mode: string; name: string; sha: string }[];
    if (res.sha === null) {
      next = entries.filter((e) => e.name !== parts[0]);
      if (next.length === 0) return { sha: null, removed: true };
    } else {
      next = entries.filter((e) => e.name !== parts[0]);
      next.push({ mode: '40000', name: parts[0], sha: res.sha });
    }
    const t = buildTree(next);
    return { sha: this.putObject('tree', t.payload), removed: true };
  }

  /** Diff two trees (base -> head): changed files with line counts. */
  diffTrees(baseTree: string | null, headTree: string): { filename: string; status: 'added' | 'modified'; additions: number; deletions: number; headSha: string | null; baseSha: string | null }[] {
    const baseFiles = new Map<string, string>();
    const headFiles = new Map<string, string>();
    const walk = (treeSha: string | null, prefix: string, into: Map<string, string>) => {
      if (!treeSha) return;
      const tree = this.getObject(treeSha);
      if (!tree || tree.type !== 'tree') return;
      for (const e of parseTree(tree.payload)) {
        const p = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.mode === '40000') walk(e.sha, p, into);
        else into.set(p, e.sha);
      }
    };
    walk(baseTree, '', baseFiles);
    walk(headTree, '', headFiles);
    const out: { filename: string; status: 'added' | 'modified'; additions: number; deletions: number; headSha: string | null; baseSha: string | null }[] = [];
    for (const [path, sha] of headFiles) {
      const baseSha = baseFiles.get(path) ?? null;
      if (baseSha === sha) continue;
      const headText = this.getObject(sha)?.payload.toString('utf8') ?? '';
      const baseText = baseSha ? this.getObject(baseSha)?.payload.toString('utf8') ?? '' : '';
      const headLines = headText === '' ? 0 : headText.split('\n').length - (headText.endsWith('\n') ? 1 : 0);
      const baseLines = baseText === '' ? 0 : baseText.split('\n').length - (baseText.endsWith('\n') ? 1 : 0);
      out.push({
        filename: path,
        status: baseSha === null ? 'added' : 'modified',
        additions: Math.max(0, headLines - baseLines),
        deletions: Math.max(0, baseLines - headLines),
        headSha: sha,
        baseSha,
      });
    }
    out.sort((a, b) => (a.filename < b.filename ? -1 : 1));
    return out;
  }

  /** Flat file map of a tree (path -> blob sha). */
  flatFiles(treeSha: string | null): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (sha: string | null, prefix: string) => {
      if (!sha) return;
      const tree = this.getObject(sha);
      if (!tree || tree.type !== 'tree') return;
      for (const e of parseTree(tree.payload)) {
        const p = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.mode === '40000') walk(e.sha, p);
        else out.set(p, e.sha);
      }
    };
    walk(treeSha, '');
    return out;
  }
}

export const store = new Store();

/** Opaque global ids (Relay-style): never the plain numeric id as a string. */
export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`).toString('base64');
}

export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}
