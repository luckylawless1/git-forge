// The HTTP surface: one server routing the git smart-HTTP endpoints, REST v3, GraphQL v4 and MCP.
// Every API reply is JSON with an X-GitHub-Request-Id; every surface but /healthz requires the
// bearer token the environment issued (MAKEFUN_SHOP_TOKEN). A repository under any owner but the
// token's login does not exist. Malformed requests answer JSON errors — the server never crashes
// on bad input.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { infoRefs, receivePack, uploadPackV0, uploadPackV2 } from './gitserver.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestResult } from './rest.ts';
import { setBase } from './serialize.ts';
import { forge } from './store.ts';

/** Kept from the starter's shape: the environment probes GET /healthz over HTTP. */
export function setPortProbe(_probe: unknown): void {
  void _probe;
}

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `F${requestCounter.toString(16).toUpperCase().padStart(4, '0')}:${Date.now().toString(16).toUpperCase()}`;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > 128 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

interface Reply {
  status: number;
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}

function jsonReply(status: number, value: unknown, headers?: Record<string, string>): Reply {
  return {
    status,
    contentType: 'application/json; charset=utf-8',
    body: Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'),
    headers,
  };
}

const notFound = (): Reply => jsonReply(404, { message: 'Not Found' });

async function dispatch(req: IncomingMessage, body: Buffer): Promise<Reply> {
  const url = new URL(req.url ?? '/', 'http://forge.invalid');
  const path = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();
  const base = `http://${req.headers.host ?? '127.0.0.1'}`;
  setBase(base);

  if (path === '/healthz') {
    return jsonReply(200, { ok: true });
  }

  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const authorization = req.headers.authorization ?? '';
  if (expectedToken !== '' && authorization !== `Bearer ${expectedToken}`) {
    return jsonReply(401, { message: 'Bad credentials' });
  }

  // MCP answers its own JSON-RPC errors (including -32700 parse errors) from the raw body.
  if (path === '/mcp') {
    if (method !== 'POST') return jsonReply(405, { message: 'Method Not Allowed' });
    const result = handleMcp(body);
    return { status: result.status, contentType: result.headers['Content-Type'], body: Buffer.from(result.body, 'utf8'), headers: result.headers };
  }

  if (path === '/api/graphql') {
    if (method === 'GET') {
      const query = url.searchParams.get('query');
      if (!query) return jsonReply(400, { message: 'Must provide query string' });
      const variablesRaw = url.searchParams.get('variables');
      let variables: unknown;
      try {
        variables = variablesRaw ? JSON.parse(variablesRaw) : undefined;
      } catch {
        return jsonReply(400, { message: 'Variables are invalid JSON' });
      }
      return jsonReply(200, handleGraphQL({ query, variables, operationName: url.searchParams.get('operationName') }));
    }
    if (method !== 'POST') return jsonReply(405, { message: 'Method Not Allowed' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return jsonReply(400, { message: 'Problems parsing JSON' });
    }
    return jsonReply(200, handleGraphQL(parsed));
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    let parsedBody: Record<string, unknown> | undefined;
    if (body.length > 0 && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
      try {
        const parsed = JSON.parse(body.toString('utf8')) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) parsedBody = parsed as Record<string, unknown>;
        else if (parsed !== null && parsed !== undefined) return jsonReply(400, { message: 'Problems parsing JSON' });
      } catch {
        return jsonReply(400, { message: 'Problems parsing JSON' });
      }
    }
    const parts = path
      .slice('/api/v3'.length)
      .split('/')
      .filter((part) => part !== '')
      .map((part) => decodeURIComponent(part));
    const result: RestResult = handleRest({ method, parts, query: url.searchParams, body: parsedBody, base });
    const headers: Record<string, string> = { 'X-OAuth-Scopes': '', 'X-Accepted-OAuth-Scopes': '' };
    if (result.headers) Object.assign(headers, result.headers);
    if (result.status === 204) return { status: 204, contentType: 'application/json; charset=utf-8', body: Buffer.alloc(0), headers };
    return jsonReply(result.status, result.body ?? {}, headers);
  }

  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (gitMatch) {
    const owner = decodeURIComponent(gitMatch[1]);
    const name = decodeURIComponent(gitMatch[2]);
    const sub = gitMatch[3] ?? '';
    const repo = forge.getRepo(owner, name);
    if (sub === '/info/refs' && method === 'GET') {
      const service = url.searchParams.get('service') ?? '';
      const result = infoRefs(repo, service, (req.headers['git-protocol'] as string | undefined) ?? null);
      return { status: result.status, contentType: result.contentType, body: result.body, headers: { 'Cache-Control': 'no-cache' } };
    }
    if (!repo) return notFound();
    if (sub === '/git-upload-pack' && method === 'POST') {
      const protocol = (req.headers['git-protocol'] as string | undefined) ?? '';
      const result = protocol.includes('version=2') ? uploadPackV2(repo, body) : uploadPackV0(repo, body);
      return { status: result.status, contentType: result.contentType, body: result.body };
    }
    if (sub === '/git-receive-pack' && method === 'POST') {
      const result = receivePack(repo, body);
      return { status: result.status, contentType: result.contentType, body: result.body };
    }
    return notFound();
  }

  return notFound();
}

/** Build the forge's HTTP server; main.ts binds it to an ephemeral port itself. */
export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = nextRequestId();
      try {
        const body = await readBody(req);
        const reply = await dispatch(req, body);
        res.writeHead(reply.status, {
          'Content-Type': reply.contentType,
          'X-GitHub-Request-Id': requestId,
          ...(reply.headers ?? {}),
        });
        res.end(reply.body);
      } catch {
        try {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'X-GitHub-Request-Id': requestId });
          }
          res.end(`${JSON.stringify({ message: 'Internal Server Error' })}\n`);
        } catch {
          // The socket is already gone; nothing more to do.
        }
      }
    })();
  });
  // A trial hammers one keep-alive connection with thousands of requests; don't let the default
  // request timeout cut it.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  return server;
}
