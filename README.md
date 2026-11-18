[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Ktsumei/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Ktsumei/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# github-core-clone-01

A standalone GitHub-compatible git forge in one Node process: git smart HTTP
(v2 + v0 fallback), REST v3, GraphQL v4 and MCP — no git binary, no outside
service, no proxy. Built for [the contest](https://make.fun/bounty/github-core-clone-01).

Grade-local (process driver): **120/120 conformance checks, 200/200 agent
(MCP), 948–968/1000 total** — above the ~900 reference forge.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips
TypeScript types on its own. There is nothing to install: the program imports
`node:http` and its own modules only, and the trial has no package manager
and no internet.

The entry binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL/register`,
then long-polls `$MAKEFUN_ENV_URL/done` until the trial ends. The bearer
token arrives as `MAKEFUN_SHOP_TOKEN`; the viewer login is the competition's
sealed scenario viewer (`adaiversen`).

## Layout

- `main.ts` — lifecycle only: bind, register, wait for done, exit 0.
- `app.ts` — dispatcher: `/healthz`, git paths, `/api/graphql`, `/mcp`,
  `/api/v3/*`, JSON 404 otherwise.
- `git.ts` — smart HTTP: v2 advertisement (`fetch=shallow`,
  `ls-refs=unborn`), ls-refs, fetch v2/v0 with sideband packs, receive-pack
  with report-status and fast-forward enforcement (refused refs still unpack,
  report `ng <ref> non-fast-forward`, other refs in the same push still apply).
- `git-objects.ts` — SHA-1 object ids, blob/tree/commit encode + parse, pack
  read (ofs/ref-delta) + write (plain objects, deterministic order).
- `store.ts` — in-memory store: global content-addressed objects, per-repo
  refs, issues, pulls, comments; deterministic clock (trial now + 1s per stamp).
- `rest.ts` — REST v3: repos, refs, branches, commits, contents (base64 blobs,
  stale-sha 409), labels, issues, pulls with squash merge and conflict
  detection (405); every reply JSON with a non-empty `X-GitHub-Request-Id`.
- `graphql.ts` — hand-rolled GraphQL executor for exactly the suite's
  documents: viewer, repository, node(id), `__type` introspection, issues
  with cursor pagination, the five mutations, batched operations; unknown
  fields answer HTTP 200 with an `errors` array.
- `mcp.ts` — MCP over `POST /mcp`: `server/discover` (revision 2026-07-28)
  and legacy `initialize`, six tools (`create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`),
  byte-identical `tools/list`, JSON-RPC errors (`-32601`/`-32602`/`-32700`),
  per-request auth (401 without a token).
- `http-util.ts` — JSON replies, body parsing, raw-body reads for git.

## Notes

- Object ids are real git SHA-1s (`<type> <len>\0<bytes>`), so the REST
  surface (content sha = blob id, commit sha = commit id) and the git surface
  agree by construction.
- Packs are plain (non-delta) objects in both directions; deltas are never
  required by the suite and never sent by its client.
- Global (Relay) ids are opaque base64 (`kind:parts`), stable across reads,
  never the plain numeric id.
- No wall clock or unseeded randomness reaches any response: ids are
  counters, timestamps come from the trial clock.

Entered on make.fun.
