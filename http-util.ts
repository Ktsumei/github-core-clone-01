// Small HTTP helpers shared by every surface: JSON replies (always
// application/json, always a non-empty X-GitHub-Request-Id), body parsing
// (malformed JSON -> 400), and path/query parsing.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestSeq = 0;
export function nextRequestId(): string {
  return `req-${++requestSeq}`;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(text);
}

export function sendEmpty(res: ServerResponse, status: number, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId(), ...extra });
  res.end();
}

export function sendText(res: ServerResponse, status: number, text: string, contentType: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(text);
}

export interface ParsedUrl {
  pathname: string;
  query: URLSearchParams;
  segments: string[];
}

export function parseUrl(req: IncomingMessage): ParsedUrl {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    url = new URL('/', 'http://entry');
  }
  const pathname = url.pathname;
  const segments = pathname.split('/').filter((s) => s.length > 0).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  return { pathname, query: url.searchParams, segments };
}

export interface BodyResult {
  ok: boolean;
  /** Parsed JSON ({} when the body is empty). */
  value: unknown;
  /** Raw bytes, for surfaces that need them (git). */
  raw: Buffer;
}

/** Read the whole request body as raw bytes (cap 8 MiB). */
export async function readRaw(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > 8 * 1024 * 1024) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Read the whole request body (cap 8 MiB) and JSON-parse it when non-empty. */
export async function readBody(req: IncomingMessage): Promise<BodyResult> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > 8 * 1024 * 1024) {
      return { ok: false, value: null, raw: Buffer.concat(chunks) };
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks);
  if (raw.length === 0) return { ok: true, value: {}, raw };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')), raw };
  } catch {
    return { ok: false, value: null, raw };
  }
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
