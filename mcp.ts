// MCP endpoint (POST /mcp): JSON-RPC 2.0 over Streamable HTTP, answered as
// plain JSON. Speaks revision 2026-07-28 (server/discover) and the legacy
// handshake (initialize + notifications/initialized). Six tools, all acting
// on the same store as REST, so MCP-created objects read back over /api/v3
// with the same ids.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { globalId, stamp, store, VIEWER_LOGIN, VIEWER_ID } from './store.ts';
import { buildCommit, parseCommit } from './git-objects.ts';
import { ident } from './store.ts';
import { isObject, readBody, sendJson } from './http-util.ts';
import { checkAuth } from './rest.ts';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required: string[] };
}

// Built once: tools/list must be byte-identical across calls.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login (defaults to the authenticated user).' },
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(obj: unknown): Record<string, unknown> {
  const text = JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

function repoJsonFor(owner: string, name: string): Record<string, unknown> | null {
  const repo = store.getRepo(owner, name);
  if (!repo) return null;
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: repo.owner,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER_LOGIN;
  const repoName = typeof args.repo === 'string' ? args.repo : typeof args.name === 'string' ? args.name : '';

  switch (name) {
    case 'create_repo': {
      const repo = store.createRepo(repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      if (!repo) return toolError(`Repository already exists: ${owner}/${repoName}`);
      return toolResult({ id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: repo.owner, private: repo.isPrivate, description: repo.description, default_branch: repo.defaultBranch });
    }
    case 'get_repo': {
      const r = repoJsonFor(owner, repoName);
      if (!r) return toolError(`Repository not found: ${owner}/${repoName}`);
      return toolResult(r);
    }
    case 'create_issue': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository not found: ${owner}/${repoName}`);
      const now = stamp();
      const issue = {
        number: ++repo.issueSeq,
        title: typeof args.title === 'string' ? args.title : '',
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        labels: [],
        createdAt: now,
        updatedAt: now,
      };
      repo.issues.push(issue);
      return toolResult({
        id: repo.id * 100000 + issue.number,
        node_id: globalId('Issue', repo.id, issue.number),
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: 'open',
        full_name: `${repo.owner}/${repo.name}`,
        owner: repo.owner,
        repo: repo.name,
      });
    }
    case 'list_issues': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository not found: ${owner}/${repoName}`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.issues.filter((i) => (state === 'all' ? true : i.state === state));
      return toolResult({
        issues: list.map((i) => ({ id: repo.id * 100000 + i.number, number: i.number, title: i.title, body: i.body, state: i.state })),
        total_count: list.length,
      });
    }
    case 'create_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository not found: ${owner}/${repoName}`);
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : repo.defaultBranch;
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return toolError('head or base branch does not exist');
      const baseTree = parseCommit(store.getObject(baseSha)!.payload).tree;
      const headTree = parseCommit(store.getObject(headSha)!.payload).tree;
      const files = store.diffTrees(baseTree, headTree).map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, headSha: f.headSha, baseSha: f.baseSha }));
      const pull = {
        number: ++repo.pullSeq,
        title: typeof args.title === 'string' ? args.title : '',
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
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
      return toolResult({
        id: repo.id * 100000 + pull.number,
        node_id: globalId('PullRequest', repo.id, pull.number),
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: 'open',
        head: { ref: head, sha: headSha },
        base: { ref: base, sha: baseSha },
        full_name: `${repo.owner}/${repo.name}`,
        owner: repo.owner,
        repo: repo.name,
      });
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository not found: ${owner}/${repoName}`);
      const num = Number(args.pull_number ?? args.number ?? 0);
      const pull = repo.pulls.find((p) => p.number === num);
      if (!pull) return toolError(`Pull request not found: ${num}`);
      if (pull.state !== 'open') return toolError('Pull request is not open');
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
      if (conflict) return toolError('Merge conflict');
      const headTree = parseCommit(store.getObject(pull.headSha)!.payload).tree;
      const commit = buildCommit({
        tree: headTree,
        parents: baseTip ? [baseTip] : [],
        author: ident(),
        committer: ident(),
        message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`,
      });
      const mergeSha = store.putObject('commit', commit.payload);
      repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
      repo.packCache.clear();
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = stamp();
      pull.mergeCommitSha = mergeSha;
      return toolResult({ number: pull.number, merged: true, sha: mergeSha, state: 'closed', full_name: `${repo.owner}/${repo.name}` });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const e: Record<string, unknown> = { code, message };
  if (data !== undefined) e.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error: e };
}

function rpcResult(id: unknown, result: unknown, meta?: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { jsonrpc: '2.0', id, result };
  if (meta) out._meta = meta;
  return out;
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  // Session close (best-effort, no body).
  if (req.method === 'DELETE') {
    res.writeHead(200, { 'x-github-request-id': 'req-close' });
    res.end();
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method not allowed' });
    return true;
  }

  const body = await readBody(req);
  if (!body.ok) {
    // Parse error: echo the id when it can be recovered from the raw text.
    const m = /"id"\s*:\s*("([^"]*)"|(-?\d+))/.exec(body.raw.toString('utf8'));
    let id: unknown = null;
    if (m) id = m[2] !== undefined ? m[2] : Number(m[3]);
    sendJson(res, 400, rpcError(id, -32700, 'Parse error'));
    return true;
  }

  const v = body.value;
  if (!isObject(v) || typeof v.method !== 'string') {
    sendJson(res, 400, rpcError(isObject(v) ? v.id : null, -32700, 'Parse error'));
    return true;
  }

  const id = 'id' in v ? v.id : null;
  const method = v.method as string;
  const params = isObject(v.params) ? v.params : {};

  // Notifications carry no id and get no response body.
  if (id === undefined || id === null) {
    if (method.startsWith('notifications/')) {
      res.writeHead(200);
      res.end();
      return true;
    }
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'));
    return true;
  }

  // server/discover (modern era) does not require auth to probe.
  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    const result: Record<string, unknown> = {
      supportedVersions: [...SUPPORTED_VERSIONS],
      serverInfo,
      capabilities: { tools: {} },
    };
    result._meta = { 'io.modelcontextprotocol/serverInfo': serverInfo };
    sendJson(res, 200, rpcResult(id, result, { 'io.modelcontextprotocol/serverInfo': serverInfo }));
    return true;
  }

  // Legacy handshake.
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    const result = {
      protocolVersion: SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    };
    sendJson(res, 200, rpcResult(id, result));
    return true;
  }

  // Everything else requires auth.
  if (!checkAuth(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }

  if (method === 'ping') {
    sendJson(res, 200, rpcResult(id, {}));
    return true;
  }

  if (method === 'tools/list') {
    sendJson(res, 200, rpcResult(id, { tools: TOOLS }));
    return true;
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isObject(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      sendJson(res, 200, rpcError(id, -32602, `Unknown tool: ${name}`));
      return true;
    }
    // Missing required argument -> -32602.
    for (const reqd of tool.inputSchema.required) {
      if (args[reqd] === undefined || args[reqd] === null || args[reqd] === '') {
        sendJson(res, 200, rpcError(id, -32602, `Missing required argument: ${reqd}`));
        return true;
      }
    }
    const result = callTool(name, args);
    sendJson(res, 200, rpcResult(id, result));
    return true;
  }

  sendJson(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
  return true;
}
