// main.ts: the entry's lifecycle and its one HTTP server.
//
// Lifecycle (env/src/wire.ts, settled by the harness): bind an ephemeral port, POST {"port": N} to
// $MAKEFUN_ENV_URL/register, then poll GET $MAKEFUN_ENV_URL/done until {"done": true} and exit 0. The
// server keeps serving for the whole trial: it is the program, not a script.
//
// Surface: GET /healthz, the smart-HTTP git surface at /{owner}/{repo}.git, GitHub REST v3 under
// /api/v3, GraphQL v4 at /api/graphql and MCP at /mcp. Every answer is JSON unless a git service or
// MCP answered with the encoding its own protocol asks for, and every answer carries an
// X-GitHub-Request-Id.

import { createServer } from 'node:http';
import { Forge } from './forge.ts';
import { RestRouter } from './rest.ts';
import { advertisement, advertisementType, receivePack, resultType, uploadPack } from './githttp.ts';
import { executeOperation } from './graphql.ts';
import { handleMcpRequest, parseErrorBody } from './mcp.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
/** The token every API call must present (absent only under the local dev runner). */
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

const forge = new Forge();
const rest = new RestRouter(forge);
/** The shared empty query, so a request without a query string allocates nothing. */
const EMPTY_QUERY = new URLSearchParams();
let requestSeq = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Answer one request with JSON, content-length included. */
function sendJson(res, status, body, headers) {
  const text = body === null || body === undefined ? '' : `${JSON.stringify(body)}\n`;
  const out = { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store', ...(headers ?? {}) };
  res.writeHead(status, out);
  res.end(text);
}

/** Answer one router result: pre-serialized text when the route cached it, JSON otherwise. */
function sendAnswer(res, answer) {
  if (answer.text !== undefined) {
    res.writeHead(answer.status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(answer.text),
      'cache-control': 'no-store',
      ...(answer.headers ?? {}),
    });
    res.end(answer.text);
    return;
  }
  sendJson(res, answer.status, answer.body, answer.headers);
}

/** Answer one request with buffered bytes (a git service answer). */
function sendBytes(res, status, body, contentType) {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}

/** Whether a request carries the bearer token every API call must present. */
function authorized(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  if (TOKEN !== '' && header === `Bearer ${TOKEN}`) return true;
  const space = header.indexOf(' ');
  if (space < 0) return false;
  const scheme = header.slice(0, space).toLowerCase();
  const value = header.slice(space + 1).trim();
  if (scheme !== 'bearer' || value === '') return false;
  if (TOKEN === '') return true;
  return value === TOKEN;
}

/** Percent-decode one path segment; a malformed escape keeps the raw text rather than throwing. */
function decodeSegment(piece) {
  try {
    return decodeURIComponent(piece);
  } catch {
    return piece;
  }
}

/** The whole request body, or null when it is past the cap we are willing to buffer. */
function readBody(req, cap) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > cap) {
        over = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

/** The request's path and query, without building a URL object. */
function splitTarget(url) {
  const value = typeof url === 'string' && url !== '' ? url : '/';
  const mark = value.indexOf('?');
  return mark < 0 ? { path: value, query: '' } : { path: value.slice(0, mark), query: value.slice(mark + 1) };
}

/** The service a `.git` path names, or null when the path is not one. */
function gitTarget(path) {
  if (!path.startsWith('/')) return null;
  const rest2 = path.slice(1);
  const mark = rest2.indexOf('/');
  if (mark < 0) return null;
  const owner = rest2.slice(0, mark);
  const tail = rest2.slice(mark + 1);
  const dot = tail.indexOf('.git');
  if (dot < 0) return null;
  const name = tail.slice(0, dot);
  const suffix = tail.slice(dot + 4);
  if (owner === '' || name === '') return null;
  return { owner: decodeURIComponent(owner), repo: decodeURIComponent(name), suffix };
}

/** Route one request. Every branch answers; nothing throws out of here. */
async function route(req, res) {
  const method = req.method ?? 'GET';
  const target = splitTarget(req.url);
  const path = target.path;
  res.setHeader('x-github-request-id', `MF-${(requestSeq += 1).toString(36)}`);

  if (path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const raw = path.slice('/api/v3'.length);
    // A segment without a percent escape is already decoded, and that is the hot case: skip the call.
    const segments = [];
    if (raw !== '') {
      const pieces = raw.split('/');
      for (const piece of pieces) {
        if (piece === '') continue;
        segments.push(piece.includes('%') ? decodeSegment(piece) : piece);
      }
    }
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication', documentation_url: '/api/v3' });
      return;
    }
    const query = target.query === '' ? EMPTY_QUERY : new URLSearchParams(target.query);
    let body;
    let rawText = '';
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const buffer = await readBody(req, 8 << 20);
      if (buffer === null) {
        sendJson(res, 413, { message: 'Request body too large' });
        return;
      }
      rawText = buffer.toString('utf8');
      if (rawText.trim() !== '') {
        try {
          body = JSON.parse(rawText);
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON', documentation_url: '/api/v3' });
          return;
        }
      }
    }
    const host = typeof req.headers.host === 'string' && req.headers.host !== '' ? req.headers.host : 'localhost';
    const answer = rest.handle({ method, segments, query, body, rawText, origin: `http://${host}` });
    if (answer === null) {
      sendJson(res, 404, { message: 'Not Found', documentation_url: '/api/v3' });
      return;
    }
    sendAnswer(res, answer);
    return;
  }

  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method not allowed' });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const buffer = await readBody(req, 8 << 20);
    if (buffer === null) {
      sendJson(res, 413, { message: 'Request body too large' });
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(buffer.toString('utf8'));
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    // A JSON array body is a batch: one result per entry, in the order they arrived.
    if (Array.isArray(parsed)) {
      const answers = parsed.map((entry) => executeOperation(forge, entry).body);
      sendJson(res, 200, answers);
      return;
    }
    const answer = executeOperation(forge, parsed);
    sendJson(res, 200, answer.body);
    return;
  }

  if (path === '/mcp' || path.startsWith('/mcp/')) {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method not allowed' });
      return;
    }
    const buffer = await readBody(req, 8 << 20);
    const text = buffer === null ? '' : buffer.toString('utf8');
    let parsed = null;
    let bad = false;
    try {
      parsed = JSON.parse(text);
    } catch {
      bad = true;
    }
    if (bad) {
      sendJson(res, 400, parseErrorBody());
      return;
    }
    const answer = handleMcpRequest(forge, text, parsed);
    if (answer.body === null) {
      res.writeHead(answer.status, { 'content-length': 0 });
      res.end();
      return;
    }
    sendJson(res, answer.status, answer.body);
    return;
  }

  const git = gitTarget(path);
  if (git !== null) {
    const repo = forge.getRepo(git.owner, git.repo);
    if (git.suffix.startsWith('/info/refs')) {
      if (repo === null) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const params = new URLSearchParams(target.query);
      const service = params.get('service') ?? 'git-upload-pack';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 403, { message: 'Invalid service' });
        return;
      }
      const protocol = req.headers['git-protocol'];
      const wantsV2 = typeof protocol === 'string' && protocol.includes('version=2');
      const body = advertisement(repo, service, wantsV2);
      sendBytes(res, 200, body, advertisementType(service));
      return;
    }
    if (git.suffix === '/git-upload-pack' || git.suffix === '/git-receive-pack') {
      if (repo === null) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const buffer = await readBody(req, 64 << 20);
      if (buffer === null) {
        sendJson(res, 413, { message: 'Request body too large' });
        return;
      }
      const service = git.suffix === '/git-upload-pack' ? 'git-upload-pack' : 'git-receive-pack';
      try {
        const body = service === 'git-upload-pack' ? uploadPack(repo, buffer) : receivePack(repo, buffer);
        sendBytes(res, 200, body, resultType(service));
      } catch (err) {
        // A malformed git body is answered, never fatal: the process stays up.
        sendJson(res, 400, { message: 'Bad git request', detail: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** The server, with the socket settings a keep-alive client (the suite) wants. */
function startServer(port) {
  const server = createServer((req, res) => {
    route(req, res).catch(() => {
      try {
        sendJson(res, 500, { message: 'Internal server error' });
      } catch {
        // The peer is gone; nothing to answer.
      }
    });
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 0;
  server.noDelay = true;
  server.on('clientError', (err, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch {
      // The socket is already gone.
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve(server));
  });
}

/** POST the bound port until the env accepts it (200, or 409 when another entry registered first). */
async function register(port) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 200 || response.status === 409) {
        await response.arrayBuffer().catch(() => undefined);
        return;
      }
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register answered HTTP ${response.status}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(Math.min(2000, 250 * 2 ** Math.min(attempt, 8)));
  }
}

/** Poll GET /done until the suite says the trial is over. */
async function waitForDone() {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(30_000) });
      if (response.ok) {
        const body = await response.json();
        if (body !== null && typeof body === 'object' && body.done === true) return;
      }
    } catch {
      // The env is not answering yet: it is not done, so poll again.
    }
    await sleep(Math.min(2000, 250 * 2 ** Math.min(attempt, 8)));
  }
}

/** The whole life of the process. */
async function main() {
  const devPort = process.env.MAKEFUN_PORT;
  if (ENV_URL === '' && devPort === undefined) {
    process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
    process.exit(1);
  }
  process.on('uncaughtException', (err) => {
    process.stderr.write(`[entry] uncaught exception: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  });
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[entry] unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}\n`);
  });

  // A local run: MAKEFUN_PORT and no env URL. Serve that port and stay up.
  if (ENV_URL === '') {
    await startServer(Number(devPort));
    process.stdout.write(`[entry] dev server listening on ${devPort}, login ${forge.login}\n`);
    return;
  }

  const server = await startServer(0);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${address.port}, login ${forge.login}\n`);
  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');
  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  if (ENV_URL !== '') process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
