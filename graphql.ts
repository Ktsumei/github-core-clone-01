// GraphQL v4 surface (POST /api/graphql): a small executor for exactly the
// documents the suite sends (gh and github-mcp-server). No general GraphQL
// engine: a lexer + parser for the subset used, resolvers over the shared
// store, hardcoded introspection for the types the suite asks about.
// Unknown field -> HTTP 200 with an errors array naming it. Unknown repo ->
// data.repository null, no errors. No token -> 401.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { globalId, ident, parseGlobalId, stamp, store, VIEWER_LOGIN, type Issue, type Pull, type Repo } from './store.ts';
import { buildCommit, parseCommit } from './git-objects.ts';
import { isObject, readBody, sendJson } from './http-util.ts';
import { checkAuth } from './rest.ts';

// ---------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function lex(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      out.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(c)) {
      out.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1];
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          j += 2;
        } else {
          s += src[j];
          j += 1;
        }
      }
      out.push({ kind: 'string', value: s });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      out.push({ kind: 'int', value: parseInt(src.slice(i, j), 10) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      out.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${c}`);
  }
  return out;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  alias: string;
  name: string;
  args: { name: string; value: ValueNode }[];
  selection: FieldNode[] | null;
  fragmentType: string | null; // for inline fragments
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: { name: string; defaultValue?: ValueNode }[];
  selection: FieldNode[];
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new Error('unexpected end of document');
    this.pos += 1;
    return t;
  }
  private expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected ${v}`);
  }
  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error('expected name');
    return t.value;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, FieldNode[]> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, FieldNode[]>();
    while (this.pos < this.tokens.length) {
      const t = this.peek()!;
      if (t.kind === 'punct' && t.value === '{') {
        operations.push({ kind: 'query', name: null, variables: [], selection: this.parseSelectionSet() });
        continue;
      }
      const kw = this.expectName();
      if (kw === 'fragment') {
        const fragName = this.expectName();
        this.expectName(); // 'on'
        this.expectName(); // type name
        fragments.set(fragName, this.parseSelectionSet());
        continue;
      }
      if (kw !== 'query' && kw !== 'mutation') throw new Error(`unexpected keyword ${kw}`);
      let name: string | null = null;
      const next = this.peek();
      if (next?.kind === 'name') name = this.next().value as string;
      const variables: Operation['variables'] = [];
      if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
        this.next();
        while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
          this.expectPunct('$');
          const vname = this.expectName();
          this.expectPunct(':');
          this.parseType();
          let defaultValue: ValueNode | undefined;
          if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '=') {
            this.next();
            defaultValue = this.parseValue();
          }
          variables.push({ name: vname, defaultValue });
        }
        this.expectPunct(')');
      }
      operations.push({ kind: kw, name, variables, selection: this.parseSelectionSet() });
    }
    return { operations, fragments };
  }

  private parseType(): void {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '[') {
      this.parseType();
      this.expectPunct(']');
    } else if (t.kind !== 'name') {
      throw new Error('expected type');
    }
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '!') this.next();
  }

  private parseSelectionSet(): FieldNode[] {
    this.expectPunct('{');
    const fields: FieldNode[] = [];
    while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      fields.push(this.parseField());
    }
    this.expectPunct('}');
    return fields;
  }

  private parseField(): FieldNode {
    const t = this.next();
    if (t.kind === 'spread') {
      // Inline fragment (... on Type { ... }) or fragment spread (...Name).
      const n = this.peek();
      if (n?.kind === 'name' && n.value === 'on') {
        this.next();
        const typeName = this.expectName();
        const selection = this.parseSelectionSet();
        return { alias: '', name: '', args: [], selection, fragmentType: typeName };
      }
      const fragName = this.expectName();
      return { alias: '', name: `...${fragName}`, args: [], selection: null, fragmentType: null };
    }
    if (t.kind !== 'name') throw new Error('expected field name');
    let alias = t.value;
    let name = t.value;
    const n = this.peek();
    if (n?.kind === 'punct' && n.value === ':') {
      this.next();
      name = this.expectName();
    }
    const args: FieldNode['args'] = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let selection: FieldNode[] | null = null;
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selection = this.parseSelectionSet();
    }
    return { alias, name, args, selection, fragmentType: null };
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'var', name: this.expectName() };
    if (t.kind === 'punct' && t.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const fname = this.expectName();
        this.expectPunct(':');
        fields.push({ name: fname, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'bool', value: true };
      if (t.value === 'false') return { kind: 'bool', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error('unexpected value');
  }
}

// ---------------------------------------------------------------- values

function resolveValue(node: ValueNode, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var':
      return vars[node.name] ?? null;
    case 'string':
    case 'int':
    case 'bool':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((i) => resolveValue(i, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, vars);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, vars: Record<string, unknown>): unknown {
  const a = field.args.find((x) => x.name === name);
  return a ? resolveValue(a.value, vars) : undefined;
}

// ---------------------------------------------------------------- schema metadata

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'body', 'headRef', 'baseRef', 'createdAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  User: ['id', 'login', 'name'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'WIKI', 'PACKAGE', 'MARKETPLACE', 'TOPIC', 'MILESTONE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------- executor

interface ExecCtx {
  vars: Record<string, unknown>;
  errors: { message: string; path?: (string | number)[] }[];
  fragments: Map<string, FieldNode[]>;
}

type AnyObj = Record<string, unknown>;

function issueObj(repo: Repo, i: Issue): AnyObj {
  return {
    __typename: 'Issue',
    id: globalId('Issue', repo.id, i.number),
    number: i.number,
    title: i.title,
    state: i.state.toUpperCase(),
    body: i.body,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    _repo: repo,
    _issue: i,
  };
}

function pullObj(repo: Repo, p: Pull): AnyObj {
  return {
    __typename: 'PullRequest',
    id: globalId('PullRequest', repo.id, p.number),
    number: p.number,
    title: p.title,
    state: p.merged ? 'MERGED' : p.state.toUpperCase(),
    merged: p.merged,
    headRefName: p.headRef,
    baseRefName: p.baseRef,
    mergeable: prMergeable(repo, p),
    body: p.body,
    createdAt: p.createdAt,
    _repo: repo,
    _pull: p,
  };
}

function prMergeable(repo: Repo, p: Pull): string {
  if (p.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.refs.get(`refs/heads/${p.baseRef}`);
  if (!baseTip) return 'UNKNOWN';
  for (const f of p.files) {
    const nowBlob = store.blobAt(baseTip, f.filename);
    if (nowBlob !== f.baseSha && nowBlob !== f.headSha) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

function repoObj(repo: Repo): AnyObj {
  return {
    __typename: 'Repository',
    id: globalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __typename: 'User', login: repo.owner, id: globalId('User', repo.owner) },
    defaultBranchRef: repo.refs.get(`refs/heads/${repo.defaultBranch}`)
      ? { __typename: 'Ref', name: repo.defaultBranch }
      : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    _repo: repo,
  };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`).toString('base64');
}

function cursorNumber(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function executeSelection(obj: AnyObj, fields: FieldNode[], ctx: ExecCtx, typeName: string): AnyObj {
  const out: AnyObj = {};
  for (const f of fields) {
    if (f.fragmentType !== null) {
      if (f.fragmentType === typeName || f.fragmentType === obj.__typename) {
        Object.assign(out, executeSelection(obj, f.selection ?? [], ctx, typeName));
      }
      continue;
    }
    if (f.name.startsWith('...')) {
      const frag = ctx.fragments.get(f.name.slice(3));
      if (frag) Object.assign(out, executeSelection(obj, frag, ctx, typeName));
      continue;
    }
    const value = resolveField(obj, f, ctx, typeName);
    out[f.alias] = value;
  }
  return out;
}

function resolveField(obj: AnyObj, field: FieldNode, ctx: ExecCtx, typeName: string): unknown {
  const name = field.name;
  // __typename
  if (name === '__typename') return obj.__typename ?? typeName;
  // __type introspection (root only)
  if (name === '__type' && typeName === 'Query') {
    const typeArg = argValue(field, 'name', ctx.vars) as string;
    const includeDeprecated = argValue(field, 'includeDeprecated', ctx.vars);
    void includeDeprecated;
    if (TYPE_FIELDS[typeArg]) {
      return {
        name: typeArg,
        fields: TYPE_FIELDS[typeArg].map((n) => ({ name: n })),
        enumValues: ENUM_VALUES[typeArg] ? ENUM_VALUES[typeArg].map((n) => ({ name: n })) : null,
      };
    }
    if (ENUM_VALUES[typeArg]) {
      return { name: typeArg, fields: null, enumValues: ENUM_VALUES[typeArg].map((n) => ({ name: n })) };
    }
    return null;
  }

  if (typeName === 'Query') {
    if (name === 'viewer') {
      const sub = { __typename: 'User', login: VIEWER_LOGIN, id: globalId('User', VIEWER_LOGIN) };
      return field.selection ? executeSelection(sub, field.selection, ctx, 'User') : sub;
    }
    if (name === 'repository') {
      const owner = argValue(field, 'owner', ctx.vars) as string;
      const repoName = argValue(field, 'name', ctx.vars) as string;
      const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
      if (!repo) return null;
      const r = repoObj(repo);
      return field.selection ? executeSelection(r, field.selection, ctx, 'Repository') : r;
    }
    if (name === 'node') {
      const id = argValue(field, 'id', ctx.vars) as string;
      const parsed = parseGlobalId(id);
      if (!parsed) return null;
      const [kind, a, b] = [parsed.kind, parsed.parts[0], parsed.parts[1]];
      if (kind === 'Repository') {
        const repo = [...store.repos.values()].find((r) => r.id === Number(a));
        if (!repo) return null;
        const r = repoObj(repo);
        return field.selection ? executeSelection(r, field.selection, ctx, 'Repository') : r;
      }
      if (kind === 'Issue') {
        const repo = [...store.repos.values()].find((r) => r.id === Number(a));
        const issue = repo?.issues.find((i) => i.number === Number(b));
        if (!repo || !issue) return null;
        const o = issueObj(repo, issue);
        return field.selection ? executeSelection(o, field.selection, ctx, 'Issue') : o;
      }
      if (kind === 'PullRequest') {
        const repo = [...store.repos.values()].find((r) => r.id === Number(a));
        const pull = repo?.pulls.find((p) => p.number === Number(b));
        if (!repo || !pull) return null;
        const o = pullObj(repo, pull);
        return field.selection ? executeSelection(o, field.selection, ctx, 'PullRequest') : o;
      }
      return null;
    }
  }

  if (typeName === 'Mutation') {
    if (name === 'createIssue') return mutateCreateIssue(field, ctx);
    if (name === 'closeIssue') return mutateCloseIssue(field, ctx);
    if (name === 'createPullRequest') return mutateCreatePullRequest(field, ctx);
    if (name === 'mergePullRequest') return mutateMergePullRequest(field, ctx);
    if (name === 'addComment') return mutateAddComment(field, ctx);
  }

  if (typeName === 'Repository') {
    const repo = obj._repo as Repo;
    if (name === 'issue') {
      const num = argValue(field, 'number', ctx.vars) as number;
      const issue = repo.issues.find((i) => i.number === num);
      if (!issue) return null;
      const o = issueObj(repo, issue);
      return field.selection ? executeSelection(o, field.selection, ctx, 'Issue') : o;
    }
    if (name === 'issues') {
      const first = (argValue(field, 'first', ctx.vars) as number | undefined) ?? 10;
      const states = (argValue(field, 'states', ctx.vars) as string[] | undefined) ?? null;
      const orderBy = (argValue(field, 'orderBy', ctx.vars) as { field?: string; direction?: string } | undefined) ?? null;
      const after = argValue(field, 'after', ctx.vars) as string | null | undefined;
      let list = [...repo.issues];
      if (states) list = list.filter((i) => states.includes(i.state.toUpperCase()));
      const dir = orderBy?.direction ?? 'DESC';
      list.sort((a, b) => (dir === 'ASC' ? a.number - b.number : b.number - a.number));
      const afterNum = cursorNumber(after);
      if (afterNum !== null) list = list.filter((i) => (dir === 'ASC' ? i.number > afterNum : i.number < afterNum));
      const nodes = list.slice(0, first);
      const hasNextPage = list.length > first;
      const endCursor = nodes.length > 0 ? cursorFor(nodes[nodes.length - 1].number) : null;
      const conn: AnyObj = {
        __typename: 'IssueConnection',
        nodes: nodes.map((i) => issueObj(repo, i)),
        pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
        totalCount: list.length,
      };
      if (field.selection) return executeSelection(conn, field.selection, ctx, 'IssueConnection');
      return conn;
    }
    if (name === 'pullRequests') {
      const first = (argValue(field, 'first', ctx.vars) as number | undefined) ?? 10;
      const list = [...repo.pulls].sort((a, b) => b.number - a.number).slice(0, first);
      const conn: AnyObj = {
        __typename: 'PullRequestConnection',
        nodes: list.map((p) => pullObj(repo, p)),
        pageInfo: { __typename: 'PageInfo', hasNextPage: repo.pulls.length > first, endCursor: null },
        totalCount: repo.pulls.length,
      };
      if (field.selection) return executeSelection(conn, field.selection, ctx, 'PullRequestConnection');
      return conn;
    }
    if (name === 'pullRequest') {
      const num = argValue(field, 'number', ctx.vars) as number;
      const pull = repo.pulls.find((p) => p.number === num);
      if (!pull) return null;
      const o = pullObj(repo, pull);
      return field.selection ? executeSelection(o, field.selection, ctx, 'PullRequest') : o;
    }
  }

  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection') {
    if (name === 'nodes') {
      const nodes = obj.nodes as AnyObj[];
      return nodes.map((n) => (field.selection ? executeSelection(n, field.selection, ctx, n.__typename as string) : n));
    }
    if (name === 'pageInfo') {
      const pi = obj.pageInfo as AnyObj;
      return field.selection ? executeSelection(pi, field.selection, ctx, 'PageInfo') : pi;
    }
    if (name === 'totalCount') return obj.totalCount ?? (obj.nodes as unknown[])?.length ?? 0;
  }

  if (typeName === 'PullRequest') {
    const pull = obj._pull as Pull;
    const repo = obj._repo as Repo;
    if (name === 'files') {
      const first = (argValue(field, 'first', ctx.vars) as number | undefined) ?? 10;
      const nodes = pull.files.slice(0, first).map((f) => ({ __typename: 'PullRequestChangedFile', path: f.filename }));
      const conn: AnyObj = { __typename: 'PullRequestChangedFileConnection', nodes, pageInfo: { hasNextPage: false, endCursor: null } };
      if (field.selection) return executeSelection(conn, field.selection, ctx, 'PullRequestChangedFileConnection');
      return conn;
    }
  }

  // Plain scalar fields on any object.
  if (name in obj && obj[name] !== undefined) {
    const v = obj[name];
    if (typeof v === 'object' && v !== null && field.selection) {
      const subType = (v as AnyObj).__typename as string | undefined;
      if (subType) return executeSelection(v as AnyObj, field.selection, ctx, subType);
    }
    return v;
  }

  ctx.errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
  return null;
}

function mutateCreateIssue(field: FieldNode, ctx: ExecCtx): unknown {
  const input = argValue(field, 'input', ctx.vars) as { repositoryId?: string; title?: string; body?: string };
  const parsed = parseGlobalId(input?.repositoryId ?? '');
  const repo = parsed?.kind === 'Repository' ? [...store.repos.values()].find((r) => r.id === Number(parsed.parts[0])) : undefined;
  if (!repo) {
    ctx.errors.push({ message: 'Repository not found.' });
    return { issue: null };
  }
  const now = stamp();
  const issue: Issue = { number: ++repo.issueSeq, title: input.title ?? '', body: input.body ?? '', state: 'open', labels: [], createdAt: now, updatedAt: now };
  repo.issues.push(issue);
  const out = { issue: issueObj(repo, issue) };
  return field.selection ? executeSelection(out as AnyObj, field.selection, ctx, 'CreateIssuePayload') : out;
}

function mutateCloseIssue(field: FieldNode, ctx: ExecCtx): unknown {
  const input = argValue(field, 'input', ctx.vars) as { issueId?: string };
  const parsed = parseGlobalId(input?.issueId ?? '');
  const repo = parsed?.kind === 'Issue' ? [...store.repos.values()].find((r) => r.id === Number(parsed.parts[0])) : undefined;
  const issue = repo?.issues.find((i) => i.number === Number(parsed?.parts[1]));
  if (!repo || !issue) {
    ctx.errors.push({ message: 'Issue not found.' });
    return { issue: null };
  }
  issue.state = 'closed';
  issue.updatedAt = stamp();
  const out = { issue: issueObj(repo, issue) };
  return field.selection ? executeSelection(out as AnyObj, field.selection, ctx, 'CloseIssuePayload') : out;
}

function mutateCreatePullRequest(field: FieldNode, ctx: ExecCtx): unknown {
  const input = argValue(field, 'input', ctx.vars) as { repositoryId?: string; baseRefName?: string; headRefName?: string; title?: string; body?: string };
  const parsed = parseGlobalId(input?.repositoryId ?? '');
  const repo = parsed?.kind === 'Repository' ? [...store.repos.values()].find((r) => r.id === Number(parsed.parts[0])) : undefined;
  if (!repo) {
    ctx.errors.push({ message: 'Repository not found.' });
    return { pullRequest: null };
  }
  const headSha = repo.refs.get(`refs/heads/${input.headRefName ?? ''}`);
  const baseSha = repo.refs.get(`refs/heads/${input.baseRefName ?? ''}`);
  if (!headSha || !baseSha) {
    ctx.errors.push({ message: 'head or base branch does not exist.' });
    return { pullRequest: null };
  }
  const baseTree = parseCommit(store.getObject(baseSha)!.payload).tree;
  const headTree = parseCommit(store.getObject(headSha)!.payload).tree;
  const files = store.diffTrees(baseTree, headTree).map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, headSha: f.headSha, baseSha: f.baseSha }));
  const pull: Pull = {
    number: ++repo.pullSeq,
    title: input.title ?? '',
    body: input.body ?? '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: input.headRefName ?? '',
    headSha,
    baseRef: input.baseRefName ?? '',
    baseSha,
    files,
    createdAt: stamp(),
  };
  repo.pulls.push(pull);
  const out = { pullRequest: pullObj(repo, pull) };
  return field.selection ? executeSelection(out as AnyObj, field.selection, ctx, 'CreatePullRequestPayload') : out;
}

function mutateMergePullRequest(field: FieldNode, ctx: ExecCtx): unknown {
  const input = argValue(field, 'input', ctx.vars) as { pullRequestId?: string; mergeMethod?: string };
  const parsed = parseGlobalId(input?.pullRequestId ?? '');
  const repo = parsed?.kind === 'PullRequest' ? [...store.repos.values()].find((r) => r.id === Number(parsed.parts[0])) : undefined;
  const pull = repo?.pulls.find((p) => p.number === Number(parsed?.parts[1]));
  if (!repo || !pull) {
    ctx.errors.push({ message: 'Pull request not found.' });
    return { pullRequest: null };
  }
  if (pull.state !== 'open') {
    ctx.errors.push({ message: 'Pull request is not open.' });
    return { pullRequest: pullObj(repo, pull) };
  }
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
    ctx.errors.push({ message: 'Merge conflict.' });
    return { pullRequest: pullObj(repo, pull) };
  }
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
  const out = { pullRequest: pullObj(repo, pull) };
  return field.selection ? executeSelection(out as AnyObj, field.selection, ctx, 'MergePullRequestPayload') : out;
}

function mutateAddComment(field: FieldNode, ctx: ExecCtx): unknown {
  const input = argValue(field, 'input', ctx.vars) as { subjectId?: string; body?: string };
  const parsed = parseGlobalId(input?.subjectId ?? '');
  const repo = parsed?.kind === 'Issue' ? [...store.repos.values()].find((r) => r.id === Number(parsed.parts[0])) : undefined;
  const issue = repo?.issues.find((i) => i.number === Number(parsed?.parts[1]));
  if (!repo || !issue) {
    ctx.errors.push({ message: 'Issue not found.' });
    return { commentEdge: null };
  }
  const list = repo.comments.get(issue.number) ?? [];
  const comment = { id: ++repo.commentSeq, body: input.body ?? '', createdAt: stamp() };
  list.push(comment);
  repo.comments.set(issue.number, list);
  const node = { __typename: 'IssueComment', id: globalId('IssueComment', repo.id, issue.number, list.length), body: comment.body };
  const out = { commentEdge: { node } };
  return field.selection ? executeSelection(out as AnyObj, field.selection, ctx, 'AddCommentPayload') : out;
}

// ---------------------------------------------------------------- handler

function executeOne(doc: { query?: string; variables?: Record<string, unknown>; operationName?: string }): { data?: unknown; errors?: unknown[] } {
  const query = doc.query ?? '';
  const vars = (doc.variables ?? {}) as Record<string, unknown>;
  const ctx: ExecCtx = { vars, errors: [], fragments: new Map() };
  try {
    const { operations, fragments } = new Parser(lex(query)).parseDocument();
    ctx.fragments = fragments;
    let op = operations[0];
    if (doc.operationName) {
      op = operations.find((o) => o.name === doc.operationName) ?? op;
    }
    if (!op) return { data: {}, errors: [{ message: 'No operation.' }] };
    const typeName = op.kind === 'mutation' ? 'Mutation' : 'Query';
    const root: AnyObj = { __typename: typeName };
    const data = executeSelection(root, op.selection, ctx, typeName);
    return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
  } catch (e) {
    return { data: null, errors: [{ message: e instanceof Error ? e.message : 'Parse error.' }] };
  }
}

export async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!checkAuth(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  const body = await readBody(req);
  if (!body.ok) {
    sendJson(res, 400, { message: 'Malformed JSON body' });
    return true;
  }
  const v = body.value;
  if (Array.isArray(v)) {
    // Batched operations: one envelope per operation, in order.
    const results = v.map((op) => (isObject(op) ? executeOne(op as { query?: string; variables?: Record<string, unknown>; operationName?: string }) : { data: null, errors: [{ message: 'Invalid operation.' }] }));
    sendJson(res, 200, results);
    return true;
  }
  if (isObject(v)) {
    sendJson(res, 200, executeOne(v as { query?: string; variables?: Record<string, unknown>; operationName?: string }));
    return true;
  }
  sendJson(res, 400, { message: 'Malformed GraphQL body' });
  return true;
}
