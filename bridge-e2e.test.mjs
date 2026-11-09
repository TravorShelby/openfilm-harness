import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright-core';
import { loadRuntime } from './runtime.mjs';

test('real Studio: two MCP clients, selection/reference, commands, live edits, undo and local origin isolation', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'openfilm-harness-e2e-'));
  const home = join(temp, 'bridge');
  const film = join(temp, 'film'); await mkdir(film);
  const runtime = await loadRuntime();
  await writeFile(join(film, 'film.html'), runtime.filmHtml({ stage: { w: 640, h: 360 }, tracks: [{ clips: [{ id: 'shot', src: 'scene.html', time: [0, 3] }] }] }));
  await writeFile(join(film, 'scene.html'), '<!doctype html><meta name="viewport" content="width=640,height=360"><style>body{margin:0;background:#123;color:white;font:48px sans-serif}</style><h1>Harness demo</h1><script>window.film={frame(t){document.querySelector("h1").style.transform=`translateX(${t*20}px)`}};</script>');
  const clients = [];
  let browser;
  async function connect(name) {
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('./server.mjs', import.meta.url))],
      env: { ...process.env, OPENFILM_BRIDGE_HOME: home, OPENFILM_SHARED_HOME: join(temp, 'shared'), OPENFILM_HARNESS: name }, stderr: 'pipe' });
    const client = new Client({ name, version: '0.2.0' }, { capabilities: {} });
    await client.connect(transport); clients.push(client); return client;
  }
  async function call(client, name, args = {}) {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(result.content[0].text);
    return JSON.parse(result.content[0].text);
  }
  try {
    const a = await connect('codex'), b = await connect('claude-code');
    const opened = await call(a, 'openfilm_open_editor', { projectPath: film, sessionId: 'test-codex-chat' });
    const other = await call(b, 'openfilm_open_editor', { projectPath: film, sessionId: 'test-claude-chat' });
    assert.notEqual(opened.binding.id, other.binding.id);
    const launch = new URL(opened.editorUrl);
    const state = JSON.parse(await readFile(join(home, 'runtime.json'), 'utf8'));
    const bad = await fetch(`${state.origin}/context`, { method: 'POST', headers: { origin: 'https://untrusted.example', authorization: `Bearer ${state.key}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(bad.status, 403);
    const pageToken = new URLSearchParams(launch.hash.slice(1)).get('harness');
    const escalation = await fetch(`${state.origin}/context`, { method: 'POST', headers: { authorization: `Bearer ${pageToken}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(escalation.status, 401);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(opened.editorUrl);
    await page.getByLabel('Agent 编辑器连接').waitFor();
    await page.getByRole('status').filter({ hasText: '已连接' }).waitFor();
    let context = await call(a, 'openfilm_get_context');
    assert.equal(context.editor.online, true);
    assert.equal(context.editor.selection.projectId, opened.binding.projectId);
    // Host commands exercise Studio's actual registered listener, then read its real selection callback.
    const command = await call(a, 'openfilm_editor_command', { command: { type: 'select-clip', id: 'shot', seek: true } });
    await page.waitForFunction(() => document.querySelector('[aria-label="Agent 编辑器连接"]')?.textContent.includes('已连接'));
    for (let i = 0; i < 40; i++) {
      context = await call(a, 'openfilm_get_context');
      if (context.editor.lastCommandReceipt?.id === command.id && context.editor.selection.refs.some((ref) => ref.id === 'shot')) break;
      await page.waitForTimeout(150);
    }
    assert.equal(context.editor.lastCommandReceipt.id, command.id);
    assert.ok(context.editor.selection.refs.some((ref) => ref.id === 'shot'));
    const seek = await call(a, 'openfilm_editor_command', { command: { type: 'seek', time: 1.25 } });
    for (let i = 0; i < 40; i++) {
      context = await call(a, 'openfilm_get_context');
      if (context.editor.lastCommandReceipt?.id === seek.id && Math.abs(context.editor.selection.time - 1.25) < 0.05) break;
      await page.waitForTimeout(150);
    }
    assert.ok(Math.abs(context.editor.selection.time - 1.25) < 0.05);
    await page.getByRole('button', { name: '引用所选', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '条引用待助手读取' }).waitFor();
    context = await call(a, 'openfilm_get_context');
    assert.ok(context.references.length > 0);
    assert.equal((await call(b, 'openfilm_get_context')).references.length, 0);
    const requestId = randomUUID();
    const changed = await call(a, 'openfilm_patch_project', { requestId, baseRevision: context.filmRevision,
      ops: [{ op: 'set', clip: 'shot', field: 'at', value: 0.5 }] });
    assert.equal((await call(a, 'openfilm_get_context')).timeline.tracks[0].clips[0].at, 0.5);
    assert.equal((await call(b, 'openfilm_get_context')).filmRevision, changed.filmRevision);
    await call(a, 'openfilm_undo_operation', { requestId, baseRevision: changed.filmRevision });
    assert.equal((await call(a, 'openfilm_get_context')).timeline.tracks[0].clips[0].at ?? 0, 0);
    await call(a, 'openfilm_clear_references', { ids: context.references.map((ref) => ref.id) });
    assert.equal((await call(a, 'openfilm_get_context')).references.length, 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (clients[0]) await clients[0].callTool({ name: 'openfilm_stop_editor', arguments: {} }).catch(() => {});
    await Promise.all(clients.map((client) => client.close()));
    // Worker shutdown removes its generated UI before the isolated fixture is removed.
    for (let i = 0; i < 50; i++) {
      try { await readFile(join(home, 'runtime.json')); await new Promise((done) => setTimeout(done, 100)); } catch { break; }
    }
    await rm(temp, { recursive: true, force: true });
  }
});
