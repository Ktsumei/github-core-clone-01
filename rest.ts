// REST v3 surface (/api/v3). Every reply is JSON with X-GitHub-Request-Id.
// Auth: the trial bearer token (MAKEFUN_SHOP_TOKEN) names the viewer
// "adaiversen"; a missing or wrong token is 401, a repo under any other owner
// is 404 (never 403). All ids/shas are real git ids from the shared store,
// so the git surface and REST agree on every object.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildCommit, parseCommit } from './git-objects.ts';
import { globalId, ident, stamp, store, VIEWER_LOGIN, VIEWER_ID, VIEWER_EMAIL, type Issue, type Pull, type Repo } from './store.ts';
import { isObject, parseUrl, readBody, sendEmpty, sendJson } from './http-util.ts';

export const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

export function checkAuth(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? '';
  if (SHOP_TOKEN === '') return h.startsWith('Bearer ') && h.length > 7;
  return h === `Bearer ${SHOP_TOKEN}`;
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' });
}

function repoJson(r: Repo): Record<string, unknown> {
  return {
    id: r.id,
    node_id: globalId('Repository', r.id),
    name: r.name,
    full_name: `${r.owner}/${r.name}`,
    owner: { login: r.owner, id: VIEWER_ID, type: 'User' },
    private: r.isPrivate,
    description: r.description,
    default_branch: r.defaultBranch,
    created_at: '2026-11-14T06:30:00Z',
    updated_at: '2026-11-14T06:30:00Z',
    html_url: `https://github.com/${r.owner}/${r.name}`,
    url: `/api/v3/repos/${r.owner}/${r.name}`,
    clone_url: `https://github.com/${r.owner}/${r.name}.git`,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    fork: false,
    archived: false,
    disabled: false,
    open_issues_count: r.issues.filter((i) => i.state === 'open').length,
  };
}

function issueJson(r: Repo, i: Issue): Record<string, unknown> {
  return {
    id: r.id * 100000 + i.number,
    node_id: globalId('Issue', r.id, i.number),
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    labels: i.labels.map((l) => ({ name: l.name, color: l.color })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: i.createdAt,
    updatedAt: i.updatedAt,
    updated_at: i.updatedAt,
    html_url: `https://github.com/${r.owner}/${r.name}/issues/${i.number}`,
    url: `/api/v3/repos/${r.owner}/${r.name}/issues/${i.number}`,
  };
}

function pullJson(r: Repo, p: Pull): Record<string, unknown> {
  return {
    id: r.id * 100000 + p.number,
    node_id: globalId('PullRequest', r.id, p.number),
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state,
    merged: p.merged,
    merged_at: p.mergedAt,
    merge_commit_sha: p.mergeCommitSha,
    head: { ref: p.headRef, sha: p.headSha, label: `${r.owner}:${p.headRef}` },
    base: { ref: p.baseRef, sha: p.baseSha, label: `${r.owner}:${p.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: p.createdAt,
    updated_at: p.createdAt,
    html_url: `https://github.com/${r.owner}/${r.name}/pull/${p.number}`,
    url: `/api/v3/repos/${r.owner}/${r.name}/pulls/${p.number}`,
  };
}

/** Paginate a list; returns the page and, when there is a next page, its Link value. */
function paginate<T>(items: T[], query: URLSearchParams, baseUrl: string): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const pageNum = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const next = new URL(baseUrl);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(pageNum + 1));
    link = `<${next.toString()}>; rel="next"`;
  }
  return { page, link };
}

function linkHeader(res: ServerResponse, link: string | null): Record<string, string> {
  return link ? { link } : {};
}

/** Walk a branch's history, newest first. */
function commitHistory(repo: Repo, tipSha: string | undefined): { sha: string; message: string }[] {
  if (!tipSha) return [];
  const out: { sha: string; message: string }[] = [];
  const seen = new Set<string>();
  const stack = [tipSha];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = store.getObject(sha);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.payload);
    out.push({ sha, message: c.message });
    for (const p of c.parents) stack.push(p);
  }
  return out;
}

/** Handle one REST request. Returns true when handled (always, for /api/v3). */
export async function handleRest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const { pathname, query, segments } = parseUrl(req);
  const method = req.method ?? 'GET';
  if (!pathname.startsWith('/api/v3')) return false;

  if (!checkAuth(req)) {
    unauthorized(res);
    return true;
  }

  // Root and meta.
  if (method === 'GET' && (pathname === '/api/v3' || pathname === '/api/v3/')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (method === 'GET' && pathname === '/api/v3/meta') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }
  if (method === 'GET' && pathname === '/api/v3/user') {
    sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: 'ada iversen', email: VIEWER_EMAIL });
    return true;
  }

  // POST /user/repos and GET /user/repos.
  if (pathname === '/api/v3/user/repos') {
    if (method === 'POST') {
      const body = await readBody(req);
      if (!body.ok) {
        sendJson(res, 400, { message: 'Malformed JSON body' });
        return true;
      }
      const v = isObject(body.value) ? body.value : {};
      const name = typeof v.name === 'string' ? v.name : '';
      if (name === '') {
        sendJson(res, 422, { message: 'name is required' });
        return true;
      }
      const repo = store.createRepo(name, typeof v.description === 'string' ? v.description : '', v.private === true);
      if (!repo) {
        sendJson(res, 422, { message: 'Repository already exists' });
        return true;
      }
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    if (method === 'GET') {
      const host = req.headers.host ?? 'entry';
      const base = `http://${host}${pathname}`;
      const { page, link } = paginate(store.listRepos().map(repoJson), query, base);
      sendJson(res, 200, page, linkHeader(res, link));
      return true;
    }
    notFound(res);
    return true;
  }

  // /repos/{owner}/{repo}...
  if (segments.length >= 4 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'repos') {
    const owner = segments[3];
    const name = segments[4];
    const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, name) : undefined;
    const rest = segments.slice(5);

    if (!repo) {
      notFound(res);
      return true;
    }

    // GET / PATCH / DELETE the repo itself.
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        const body = await readBody(req);
        if (!body.ok) {
          sendJson(res, 400, { message: 'Malformed JSON body' });
          return true;
        }
        const v = isObject(body.value) ? body.value : {};
        if (typeof v.description === 'string') repo.description = v.description;
        if (typeof v.private === 'boolean') repo.isPrivate = v.private;
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        sendEmpty(res, 204);
        return true;
      }
      notFound(res);
      return true;
    }

    const section = rest[0];

    // git refs: POST /git/refs, GET /git/refs/heads/{branch}, GET /branches...
    if (section === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const body = await readBody(req);
        if (!body.ok) {
          sendJson(res, 400, { message: 'Malformed JSON body' });
          return true;
        }
        const v = isObject(body.value) ? body.value : {};
        const ref = typeof v.ref === 'string' ? v.ref : '';
        const sha = typeof v.sha === 'string' ? v.sha.toLowerCase() : '';
        if (!/^refs\/(heads|tags)\//.test(ref) || !/^[0-9a-f]{40}$/.test(sha) || !store.getObject(sha)) {
          sendJson(res, 422, { message: 'Invalid ref or sha' });
          return true;
        }
        repo.refs.set(ref, sha);
        repo.packCache.clear();
        sendJson(res, 201, { ref, object: { sha } });
        return true;
      }
      if (method === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
        const branch = rest.slice(3).join('/');
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) {
          notFound(res);
          return true;
        }
        sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha } });
        return true;
      }
      notFound(res);
      return true;
    }

    if (section === 'branches') {
      if (method === 'GET' && rest.length === 1) {
        const list = [...repo.refs.entries()]
          .filter(([r]) => r.startsWith('refs/heads/'))
          .map(([r, sha]) => ({ name: r.slice('refs/heads/'.length), commit: { sha } }));
        sendJson(res, 200, list);
        return true;
      }
      if (method === 'GET' && rest.length === 2) {
        const sha = repo.refs.get(`refs/heads/${rest[1]}`);
        if (!sha) {
          notFound(res);
          return true;
        }
        sendJson(res, 200, { name: rest[1], commit: { sha } });
        return true;
      }
      notFound(res);
      return true;
    }

    if (section === 'commits' && method === 'GET' && rest.length === 1) {
      const refParam = query.get('sha');
      const tip = refParam
        ? repo.refs.get(`refs/heads/${refParam}`) ?? store.resolveRef(repo, refParam) ?? (store.getObject(refParam) ? refParam : undefined)
        : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      const history = commitHistory(repo, tip).map((c) => ({ sha: c.sha, commit: { message: c.message } }));
      sendJson(res, 200, history);
      return true;
    }

    if (section === 'contents') {
      return handleContents(req, res, repo, rest.slice(1), method, query);
    }

    if (section === 'labels') {
      if (method === 'POST' && rest.length === 1) {
        const body = await readBody(req);
        if (!body.ok) {
          sendJson(res, 400, { message: 'Malformed JSON body' });
          return true;
        }
        const v = isObject(body.value) ? body.value : {};
        const labelName = typeof v.name === 'string' ? v.name : '';
        if (labelName === '') {
          sendJson(res, 422, { message: 'name is required' });
          return true;
        }
        const label = { name: labelName, color: typeof v.color === 'string' ? v.color : 'ededed' };
        repo.labels.set(labelName, label);
        sendJson(res, 201, label);
        return true;
      }
      if (method === 'GET' && rest.length === 1) {
        sendJson(res, 200, [...repo.labels.values()]);
        return true;
      }
      notFound(res);
      return true;
    }

    if (section === 'issues') {
      return handleIssues(req, res, repo, rest.slice(1), method, query);
    }

    if (section === 'pulls') {
      return handlePulls(req, res, repo, rest.slice(1), method, query);
    }

    notFound(res);
    return true;
  }

  notFound(res);
  return true;
}

async function handleContents(req: IncomingMessage, res: ServerResponse, repo: Repo, rest: string[], method: string, query: URLSearchParams): Promise<boolean> {
  const path = rest.join('/');
  const refParam = query.get('ref');
  const resolveTip = (): string | undefined => {
    if (!refParam) return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    return repo.refs.get(`refs/heads/${refParam}`) ?? store.resolveRef(repo, refParam) ?? (store.getObject(refParam) ? refParam : undefined);
  };

  if (method === 'GET') {
    const tip = resolveTip();
    if (!tip) {
      notFound(res);
      return true;
    }
    if (path === '') {
      const listing = store.dirAt(tip, '') ?? [];
      sendJson(res, 200, listing);
      return true;
    }
    const blobSha = store.blobAt(tip, path);
    if (blobSha) {
      const obj = store.getObject(blobSha)!;
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        content: obj.payload.toString('base64'),
        sha: blobSha,
        size: obj.payload.length,
        name: path.split('/').pop(),
        path,
      });
      return true;
    }
    const dir = store.dirAt(tip, path);
    if (dir) {
      sendJson(res, 200, dir);
      return true;
    }
    notFound(res);
    return true;
  }

  if (method === 'PUT') {
    const body = await readBody(req);
    if (!body.ok) {
      sendJson(res, 400, { message: 'Malformed JSON body' });
      return true;
    }
    const v = isObject(body.value) ? body.value : {};
    const message = typeof v.message === 'string' ? v.message : 'Update file';
    const contentB64 = typeof v.content === 'string' ? v.content.replace(/\s+/g, '') : '';
    const content = Buffer.from(contentB64, 'base64');
    const branch = typeof v.branch === 'string' ? v.branch : repo.defaultBranch;
    const branchRef = `refs/heads/${branch}`;
    const tip = repo.refs.get(branchRef);
    const currentBlob = tip ? store.blobAt(tip, path) : null;
    const givenSha = typeof v.sha === 'string' ? v.sha.toLowerCase() : null;
    if (givenSha !== null) {
      if (currentBlob === null || currentBlob !== givenSha) {
        sendJson(res, 409, { message: 'sha does not match' });
        return true;
      }
    }
    const isCreate = currentBlob === null;
    const { commitSha, blobSha } = store.commitFile(repo, tip ?? null, path, content, message);
    repo.refs.set(branchRef, commitSha);
    repo.packCache.clear();
    sendJson(res, isCreate ? 201 : 200, {
      content: { name: path.split('/').pop(), path, sha: blobSha, size: content.length, encoding: 'base64' },
      commit: { sha: commitSha, message },
    });
    return true;
  }

  if (method === 'DELETE') {
    const body = await readBody(req);
    if (!body.ok) {
      sendJson(res, 400, { message: 'Malformed JSON body' });
      return true;
    }
    const v = isObject(body.value) ? body.value : {};
    const branch = typeof v.branch === 'string' ? v.branch : repo.defaultBranch;
    const branchRef = `refs/heads/${branch}`;
    const tip = repo.refs.get(branchRef);
    if (!tip) {
      notFound(res);
      return true;
    }
    const currentBlob = store.blobAt(tip, path);
    if (!currentBlob) {
      notFound(res);
      return true;
    }
    const givenSha = typeof v.sha === 'string' ? v.sha.toLowerCase() : null;
    if (givenSha !== null && givenSha !== currentBlob) {
      sendJson(res, 409, { message: 'sha does not match' });
      return true;
    }
    const tree = parseCommit(store.getObject(tip)!.payload).tree;
    const parts = path.split('/').filter((p) => p.length > 0);
    const res2 = store.deleteFromTree(tree, parts);
    if (!res2.removed) {
      notFound(res);
      return true;
    }
    const emptyTree = store.putObject('tree', Buffer.alloc(0));
    const newTree = res2.sha ?? emptyTree;
    const message = typeof v.message === 'string' ? v.message : 'Delete file';
    const commit = buildCommit({ tree: newTree, parents: [tip], author: ident(), committer: ident(), message });
    const commitSha = store.putObject('commit', commit.payload);
    repo.refs.set(branchRef, commitSha);
    repo.packCache.clear();
    sendJson(res, 200, { commit: { sha: commitSha, message } });
    return true;
  }

  notFound(res);
  return true;
}

async function handleIssues(req: IncomingMessage, res: ServerResponse, repo: Repo, rest: string[], method: string, query: URLSearchParams): Promise<boolean> {
  if (rest.length === 0) {
    if (method === 'POST') {
      const body = await readBody(req);
      if (!body.ok) {
        sendJson(res, 400, { message: 'Malformed JSON body' });
        return true;
      }
      const v = isObject(body.value) ? body.value : {};
      const labelsRaw: unknown[] = Array.isArray(v.labels) ? v.labels : [];
      const labels: { name: string; color: string }[] = [];
      for (const l of labelsRaw) {
        const labelName = typeof l === 'string' ? l : isObject(l) && typeof l.name === 'string' ? l.name : '';
        const found = repo.labels.get(labelName);
        if (!found) {
          sendJson(res, 422, { message: `Label does not exist: ${labelName}` });
          return true;
        }
        labels.push(found);
      }
      const now = stamp();
      const issue: Issue = {
        number: ++repo.issueSeq,
        title: typeof v.title === 'string' ? v.title : '',
        body: typeof v.body === 'string' ? v.body : '',
        state: 'open',
        labels,
        createdAt: now,
        updatedAt: now,
      };
      repo.issues.push(issue);
      sendJson(res, 201, issueJson(repo, issue));
      return true;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let list = repo.issues.filter((i) => (state === 'all' ? true : i.state === state));
      if (sort === 'created') {
        list = [...list].sort((a, b) => (direction === 'asc' ? (a.createdAt < b.createdAt ? -1 : 1) : (a.createdAt > b.createdAt ? -1 : 1)));
      }
      const host = req.headers.host ?? 'entry';
      const base = `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/issues`;
      const { page, link } = paginate(list.map((i) => issueJson(repo, i)), query, base);
      sendJson(res, 200, page, linkHeader(res, link));
      return true;
    }
    notFound(res);
    return true;
  }

  const num = Number(rest[0]);
  const issue = repo.issues.find((i) => i.number === num);
  if (!issue) {
    notFound(res);
    return true;
  }

  if (rest.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return true;
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      if (!body.ok) {
        sendJson(res, 400, { message: 'Malformed JSON body' });
        return true;
      }
      const v = isObject(body.value) ? body.value : {};
      if (v.state === 'open' || v.state === 'closed') issue.state = v.state;
      if (typeof v.title === 'string') issue.title = v.title;
      if (typeof v.body === 'string') issue.body = v.body;
      issue.updatedAt = stamp();
      sendJson(res, 200, issueJson(repo, issue));
      return true;
    }
    notFound(res);
    return true;
  }

  if (rest[1] === 'comments') {
    if (method === 'POST' && rest.length === 2) {
      const body = await readBody(req);
      if (!body.ok) {
        sendJson(res, 400, { message: 'Malformed JSON body' });
        return true;
      }
      const v = isObject(body.value) ? body.value : {};
      const comment = { id: ++repo.commentSeq, body: typeof v.body === 'string' ? v.body : '', createdAt: stamp() };
      const list = repo.comments.get(num) ?? [];
      list.push(comment);
      repo.comments.set(num, list);
      sendJson(res, 201, comment);
      return true;
    }
    if (method === 'GET' && rest.length === 2) {
      sendJson(res, 200, repo.comments.get(num) ?? []);
      return true;
    }
  }

  notFound(res);
  return true;
}

async function handlePulls(req: IncomingMessage, res: ServerResponse, repo: Repo, rest: string[], method: string, query: URLSearchParams): Promise<boolean> {
  if (rest.length === 0) {
    if (method === 'POST') {
      const body = await readBody(req);
      if (!body.ok) {
        sendJson(res, 400, { message: 'Malformed JSON body' });
        return true;
      }
      const v = isObject(body.value) ? body.value : {};
      const head = typeof v.head === 'string' ? v.head : '';
      const base = typeof v.base === 'string' ? v.base : repo.defaultBranch;
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) {
        sendJson(res, 422, { message: 'head or base branch does not exist' });
        return true;
      }
      const baseTree = parseCommit(store.getObject(baseSha)!.payload).tree;
      const headTree = parseCommit(store.getObject(headSha)!.payload).tree;
      const files = store.diffTrees(baseTree, headTree).map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        headSha: f.headSha,
        baseSha: f.baseSha,
      }));
      const pull: Pull = {
        number: ++repo.pullSeq,
        title: typeof v.title === 'string' ? v.title : '',
        body: typeof v.body === 'string' ? v.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        headSha,
        baseRef: base,
        baseSha,
        files,
        createdAt: stamp(),
      };
      repo.pulls.push(pull);
      sendJson(res, 201, pullJson(repo, pull));
      return true;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const list = repo.pulls.filter((p) => (state === 'all' ? true : p.state === state));
      const host = req.headers.host ?? 'entry';
      const base = `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/pulls`;
      const { page, link } = paginate(list.map((p) => pullJson(repo, p)), query, base);
      sendJson(res, 200, page, linkHeader(res, link));
      return true;
    }
    notFound(res);
    return true;
  }

  const num = Number(rest[0]);
  const pull = repo.pulls.find((p) => p.number === num);
  if (!pull) {
    notFound(res);
    return true;
  }

  if (rest.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, pullJson(repo, pull));
      return true;
    }
    notFound(res);
    return true;
  }

  if (rest[1] === 'files' && method === 'GET' && rest.length === 2) {
    sendJson(res, 200, pull.files.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.additions + f.deletions,
    })));
    return true;
  }

  if (rest[1] === 'merge' && method === 'PUT' && rest.length === 2) {
    if (pull.state !== 'open') {
      sendJson(res, 405, { message: 'Pull request is not open' });
      return true;
    }
    // Conflict: a file whose base content changed on the base branch since
    // the PR was opened, to something other than the PR's head content.
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    let conflict = false;
    if (baseTip) {
      for (const f of pull.files) {
        const nowBlob = store.blobAt(baseTip, f.filename);
        if (nowBlob !== f.baseSha && nowBlob !== f.headSha) {
          conflict = true;
          break;
        }
      }
    }
    if (conflict) {
      sendJson(res, 405, { message: 'Merge conflict' });
      return true;
    }
    const headTree = parseCommit(store.getObject(pull.headSha)!.payload).tree;
    const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
    const commit = buildCommit({
      tree: headTree,
      parents: baseTip ? [baseTip] : [],
      author: ident(),
      committer: ident(),
      message: `${message}\n\n${pull.title}`,
    });
    const mergeSha = store.putObject('commit', commit.payload);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    repo.packCache.clear();
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = stamp();
    pull.mergeCommitSha = mergeSha;
    sendJson(res, 200, { sha: mergeSha, merged: true, message });
    return true;
  }

  notFound(res);
  return true;
}
