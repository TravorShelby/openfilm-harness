import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EditorBridge, BridgeError, atomicJson } from './bridge-core.mjs';
import { loadRuntime } from './runtime.mjs';

const home = process.env.OPENFILM_BRIDGE_HOME;
if (!home) throw new Error('Start the worker through the plugin server.');
process.env.OPENFILM_HOME = join(home, 'studio');
process.env.OPENFILM_NO_BROWSER = '1';
process.env.OPENFILM_NO_UPDATE_CHECK = '1';
const runtime = await loadRuntime();
const bridge = new EditorBridge({ home, runtime });
await bridge.init();
const key = randomUUID();
let studio;
let closing = false;
let origin;

function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}
async function body(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw new BridgeError('BODY_TOO_LARGE', 'Request exceeds 256 KiB.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new BridgeError('INVALID_JSON', 'Expected JSON body.'); }
}

const http = createServer((req, res) => {
  void (async () => {
    if (req.headers.host !== new URL(origin).host) throw new BridgeError('HOST_DENIED', 'Invalid local address.', 403);
    const url = new URL(req.url, origin);
    const browserOrigin = req.headers.origin;
    // The film preview is a separate origin and has no access to this surface.
    if (browserOrigin && browserOrigin !== studio?.origin) throw new BridgeError('ORIGIN_DENIED', 'Only the editor may use this page API.', 403);
    const cors = browserOrigin ? { 'access-control-allow-origin': browserOrigin, vary: 'Origin' } : {};
    if (req.method === 'OPTIONS') {
      if (!browserOrigin || url.pathname !== '/page') throw new BridgeError('ORIGIN_DENIED', 'Invalid preflight.', 403);
      res.writeHead(204, { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'authorization, content-type' });
      return res.end();
    }
    const token = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    if (url.pathname === '/page' && req.method === 'POST') {
      const result = await bridge.updatePage(token, await body(req));
      return json(res, 200, result, cors);
    }
    if (browserOrigin || token !== key) throw new BridgeError('UNAUTHORIZED', 'Plugin control credential required.', 401);
    if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, { product: 'openfilm-harness-bridge', version: '0.2.0' });
    if (req.method !== 'POST') throw new BridgeError('NOT_FOUND', 'Unknown route.', 404);
    const data = await body(req);
    if (url.pathname === '/bind') {
      const bound = await bridge.bind(data);
      const editor = new URL(`/projects/${encodeURIComponent(bound.binding.projectId)}`, studio.origin);
      editor.searchParams.set('key', studio.key);
      editor.hash = new URLSearchParams({ harness: bound.pageToken }).toString();
      return json(res, 200, { binding: bound.binding, editorUrl: editor.href });
    }
    if (url.pathname === '/context') return json(res, 200, await bridge.context(data.bindingId));
    if (url.pathname === '/references/clear') return json(res, 200, bridge.clearReferences(data.bindingId, data.ids));
    if (url.pathname === '/command') return json(res, 200, await bridge.command(data.bindingId, data.command));
    if (url.pathname === '/patch') return json(res, 200, await bridge.patch(data.bindingId, data));
    if (url.pathname === '/operation') return json(res, 200, await bridge.operation(data.bindingId, data.requestId));
    if (url.pathname === '/undo') return json(res, 200, await bridge.undo(data.bindingId, data));
    if (url.pathname === '/stop') {
      const response = await fetch(`${studio.origin}/api/quit`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-studio-key': studio.key }, body: JSON.stringify({ whenIdle: true }) });
      const result = await response.json();
      return json(res, response.status, response.ok ? { status: 'stopping' } : result);
    }
    throw new BridgeError('NOT_FOUND', 'Unknown route.', 404);
  })().catch((error) => {
    const status = error.status ?? (error.name === 'ZodError' || error.kind === 'invalid' ? 422 : error.kind === 'conflict' ? 409 : 500);
    const cors = req.headers.origin === studio?.origin ? { 'access-control-allow-origin': studio.origin } : {};
    if (!res.headersSent) json(res, status, { code: error.code ?? 'BRIDGE_ERROR', error: error.message, ...error.details }, cors);
    else res.end();
  });
});
http.requestTimeout = 30_000;
await new Promise((done, fail) => { http.once('error', fail); http.listen(0, '127.0.0.1', done); });
origin = `http://127.0.0.1:${http.address().port}`;

const editorDir = join(home, `editor-${process.pid}`);
await mkdir(editorDir, { recursive: true });
await cp(join(runtime.root, 'studio/ui/dist'), editorDir, { recursive: true });
const script = `globalThis.__OPENFILM_BRIDGE_ORIGIN__=${JSON.stringify(origin)};\n${await readFile(new URL('./browser-bridge.js', import.meta.url), 'utf8')}`;
await writeFile(join(editorDir, 'assets/harness-bridge.js'), script);
const index = await readFile(join(editorDir, 'index.html'), 'utf8');
await writeFile(join(editorDir, 'index.html'), index.replace('<head>', '<head><script src="/assets/harness-bridge.js"></script>'));
studio = await runtime.startStudio({ port: 0, editorDir, advertise: true, onQuit: () => void stop(), openBrowser: () => {} });
await atomicJson(join(home, 'runtime.json'), { pid: process.pid, origin, key, studioOrigin: studio.origin, studioHome: process.env.OPENFILM_HOME });
console.error('OpenFilm Harness bridge ready.');

async function stop() {
  if (closing) return; closing = true;
  await studio?.close();
  http.closeAllConnections(); await new Promise((done) => http.close(done));
  try {
    const current = JSON.parse(await readFile(join(home, 'runtime.json'), 'utf8'));
    if (current.pid === process.pid) await rm(join(home, 'runtime.json'), { force: true });
  } catch {}
  // This exact generated directory belongs to this worker, never the installed runtime or a project.
  await rm(editorDir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
