// The forge's HTTP surface: git smart HTTP, REST v3, GraphQL v4 and MCP,
// all served from one process over one in-memory store. main.ts owns the
// lifecycle (bind, register, wait for done); this file is the server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './git.ts';
import { parseUrl, sendJson } from './http-util.ts';

function isGitPath(pathname: string): boolean {
  return /\.git\//.test(pathname) || pathname.endsWith('.git');
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const { pathname } = parseUrl(req);
      const method = req.method ?? 'GET';

      // The env's boot check calls this twice: 200 {"ok":true}.
      if (method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/...
      if (isGitPath(pathname)) {
        if (await handleGit(req, res)) return;
      }

      // GraphQL v4.
      if (pathname === '/api/graphql' && method === 'POST') {
        await handleGraphql(req, res);
        return;
      }

      // MCP (Streamable HTTP).
      if (pathname === '/mcp' && (method === 'POST' || method === 'DELETE')) {
        await handleMcp(req, res);
        return;
      }

      // REST v3.
      if (pathname.startsWith('/api/v3')) {
        await handleRest(req, res);
        return;
      }

      // Everything else: GitHub's 404 body.
      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      // Never let one bad request kill the process: the suite checks that
      // the server survives malformed input.
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      } catch {
        // response already gone
      }
      process.stderr.write(`[entry] request error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  });
}
