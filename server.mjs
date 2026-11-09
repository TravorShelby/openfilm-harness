#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bridgeRequest, ensureWorker } from './bridge-client.mjs';
import { runtimeRoot } from './runtime.mjs';
import { commandSchema } from './bridge-core.mjs';
import { redactLaunchUrls } from './private-output.mjs';

const PORT = Number.parseInt(process.env.OPENFILM_STUDIO_PORT || '4873', 10);
const SHARED_HOME = process.env.OPENFILM_SHARED_HOME || join(homedir(), '.openfilm');
const HOME = process.env.OPENFILM_CODEX_HOME || join(process.env.LOCALAPPDATA || homedir(), 'OpenFilm Codex Studio');
const OUTPUT_LIMIT = 32_000;

function localRuntimeEnv() {
  return {
    ...process.env,
    OPENFILM_HOME: HOME,
    OPENFILM_SHARED_HOME: SHARED_HOME,
    OPENFILM_STUDIO_PORT: String(PORT),
    OPENFILM_NO_BROWSER: '1',
    OPENFILM_NO_UPDATE_CHECK: '1',
  };
}

export function findOpenfilmCli(env = process.env) {
  const configured = env.OPENFILM_CLI;
  if (configured) {
    if (!isAbsolute(configured) || !existsSync(configured)) throw new Error('OPENFILM_CLI must be an existing absolute path.');
    return { command: extname(configured).toLowerCase() === '.mjs' ? process.execPath : configured,
      prefix: extname(configured).toLowerCase() === '.mjs' ? [configured] : [], shell: process.platform === 'win32' && extname(configured).toLowerCase() === '.cmd' };
  }
  try { return { command: process.execPath, prefix: [join(runtimeRoot(env), 'bin/openfilm.mjs')], shell: false }; } catch {}
  const command = process.platform === 'win32' ? 'openfilm.cmd' : 'openfilm';
  return { command, prefix: [], shell: process.platform === 'win32' };
}

export function projectFolder(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Provide the OpenFilm project folder path.');
  const folder = realpathSync(resolve(value));
  if (!existsSync(join(folder, 'film.html'))) throw new Error(`No film.html found in ${folder}. Open an OpenFilm film project folder.`);
  return folder;
}

function run(command, args, { cwd, env = process.env, timeoutMs = 120_000, maxBytes = OUTPUT_LIMIT } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, shell: process.platform === 'win32' && /\.cmd$/i.test(command), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let overflow = false;
    const collect = (target) => (chunk) => {
      if (stdout.length + stderr.length >= maxBytes) { overflow = true; return; }
      target(chunk.toString('utf8'));
    };
    child.stdout.on('data', collect((chunk) => { stdout += chunk; }));
    child.stderr.on('data', collect((chunk) => { stderr += chunk; }));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(redactLaunchUrls([`Command exited ${code ?? signal ?? 'without a status'}.`, stderr.trim(), stdout.trim()].filter(Boolean).join('\n'))));
      else resolvePromise({ stdout: redactLaunchUrls(stdout.trim()), stderr: redactLaunchUrls(stderr.trim()), truncated: overflow });
    });
  });
}

async function runOpenfilm(args, options = {}) {
  const cli = findOpenfilmCli();
  return run(cli.command, [...cli.prefix, ...args], options);
}

function resultText(text) { return { content: [{ type: 'text', text }] }; }
function resultJson(value) { return resultText(JSON.stringify(value, null, 2)); }
async function workerEnv() {
  const worker = await ensureWorker();
  return { ...localRuntimeEnv(), OPENFILM_HOME: worker.studioHome };
}

const server = new McpServer({ name: 'openfilm-harness-editor', version: '0.2.0' });
// Only real host-provided IDs are called conversation IDs; fallback is explicitly connection-scoped.
const connectionId = randomUUID();
let activeBindingId;
function bindingId(explicit) {
  const value = explicit || activeBindingId;
  if (!value) throw new Error('Open a project in this connection or pass a bindingId from an earlier open result.');
  return value;
}

server.registerTool('openfilm_open_editor', {
  title: 'Open OpenFilm Editor',
  description: 'Open a film project in OpenFilm Studio alongside the current agent conversation. Returns a private local editor URL for a host browser pane or normal browser.',
  inputSchema: {
    projectPath: z.string().describe('Absolute path to a folder containing film.html.'),
    harness: z.string().max(80).optional().describe('Host name, for example codex, claude-code, opencode or dsh.'),
    sessionId: z.string().min(1).max(200).optional().describe('Actual current conversation ID, only if the host provides it. Never invent one.'),
  },
}, async ({ projectPath: path, harness, sessionId }) => {
  const folder = projectFolder(path);
  const realId = sessionId || process.env.CODEX_THREAD_ID || process.env.OPENFILM_SESSION_ID;
  const opened = await bridgeRequest('/bind', { projectPath: folder,
    harness: harness || process.env.OPENFILM_HARNESS || server.server.getClientVersion()?.name || 'mcp', sessionId: realId || connectionId,
    sessionScope: realId ? 'conversation' : 'connection' });
  activeBindingId = opened.binding.id;
  return resultJson({ ...opened, instructions: 'Open editorUrl in this host browser pane (or an external browser). Continue the same chat. Read openfilm_get_context before edits. Keep launch URLs private.' });
});

const bindingInput = { bindingId: z.string().uuid().optional().describe('Binding from open_editor. Omit only for the project opened by this MCP connection.') };
server.registerTool('openfilm_get_context', {
  description: 'Read the bound project revision/timeline, current editor selection/playhead, freshness, pending references and command receipts. Offline or stale selection must not be treated as current.',
  inputSchema: bindingInput, annotations: { readOnlyHint: true },
}, async ({ bindingId: id }) => resultJson(await bridgeRequest('/context', { bindingId: bindingId(id) })));
server.registerTool('openfilm_clear_references', {
  description: 'Acknowledge only references already read and handled. Other new references remain queued.',
  inputSchema: { ...bindingInput, ids: z.array(z.string().uuid()).max(64) },
}, async ({ bindingId: id, ids }) => resultJson(await bridgeRequest('/references/clear', { bindingId: bindingId(id), ids })));
server.registerTool('openfilm_editor_command', {
  description: 'Ask the connected editor to seek, select a clip or show a range. Result is queued; read context for acknowledgement. It does not modify film.html.',
  inputSchema: { ...bindingInput, command: commandSchema },
}, async ({ bindingId: id, command }) => resultJson(await bridgeRequest('/command', { bindingId: bindingId(id), command })));
server.registerTool('openfilm_patch_project', {
  description: 'Apply targeted OpenFilm timeline operations against an exact revision. Rejects outdated edits and changes to locked tracks. Use get_context first. Keep the same UUID on uncertain retry; inspect operation status. Ops: set {clip,field,value}; move {clip,at,track?}; insert {clip:{src,time?,id?},track?,at?}; remove {clip}; fields {clip,fields}; stage {w,h}. Times are seconds. Never bypass a lock by writing the file directly.',
  inputSchema: { ...bindingInput, baseRevision: z.string().regex(/^[a-f0-9]{16}$/),
    requestId: z.string().uuid(), ops: z.array(z.record(z.string(), z.unknown())).min(1).max(100) },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
}, async ({ bindingId: id, ...data }) => resultJson(await bridgeRequest('/patch', { bindingId: bindingId(id), ...data })));
server.registerTool('openfilm_get_operation', {
  description: 'Read a persisted edit receipt after a lost response or before undoing. Prepared means outcome unknown; reread the project before another decision.',
  inputSchema: { ...bindingInput, requestId: z.string().uuid() }, annotations: { readOnlyHint: true },
}, async ({ bindingId: id, requestId }) => resultJson(await bridgeRequest('/operation', { bindingId: bindingId(id), requestId })));
server.registerTool('openfilm_undo_operation', {
  description: 'Undo exactly one plugin operation only if the current revision is still its resulting revision. Later human or AI edits cause a conflict and are preserved.',
  inputSchema: { ...bindingInput, requestId: z.string().uuid(), baseRevision: z.string().regex(/^[a-f0-9]{16}$/) },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
}, async ({ bindingId: id, ...data }) => resultJson(await bridgeRequest('/undo', { bindingId: bindingId(id), ...data })));

server.registerTool('openfilm_check_project', {
  title: 'Check OpenFilm Project',
  description: 'Run OpenFilm look at requested timestamps, checking frames for deterministic output and visual/rendering errors.',
  inputSchema: {
    projectPath: z.string().describe('Absolute path to a folder containing film.html.'),
    range: z.string().regex(/^\d+(\.\d+)?(-\d+(\.\d+)?)?$/).optional().describe('Optional timestamp or range accepted by OpenFilm look, such as 3 or 3-8.'),
  },
}, async ({ projectPath: path, range }) => {
  const folder = projectFolder(path);
  const args = ['look', ...(range ? [range] : [])];
  const output = await runOpenfilm(args, { cwd: folder, env: process.env.OPENFILM_CLI ? localRuntimeEnv() : await workerEnv(), timeoutMs: 180_000 });
  return resultText([output.stdout, output.stderr, output.truncated ? '[output truncated]' : ''].filter(Boolean).join('\n'));
});

server.registerTool('openfilm_render_project', {
  title: 'Render OpenFilm Project',
  description: 'Render the current OpenFilm project with its official renderer. This writes a video file in the configured export location.',
  inputSchema: {
    projectPath: z.string().describe('Absolute path to a folder containing film.html.'),
    range: z.string().regex(/^\d+(\.\d+)?(-\d+(\.\d+)?)?$/).optional().describe('Optional time range accepted by OpenFilm render, such as 3-8.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ projectPath: path, range }) => {
  const folder = projectFolder(path);
  const args = ['render', ...(range ? [range] : [])];
  const output = await runOpenfilm(args, { cwd: folder, env: await workerEnv(), timeoutMs: 30 * 60_000 });
  return resultText([output.stdout, output.stderr, output.truncated ? '[output truncated]' : ''].filter(Boolean).join('\n'));
});

server.registerTool('openfilm_stop_editor', {
  title: 'Stop OpenFilm Editor',
  description: 'Stop the shared Harness editor only when idle. This closes editor tabs across clients; use only when the user is finished. Running exports keep it alive.',
  inputSchema: {},
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => resultJson(await bridgeRequest('/stop', {}, { start: false })));

await server.connect(new StdioServerTransport());
