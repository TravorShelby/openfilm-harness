import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url));
let temp;
let client;

before(async () => {
  temp = await mkdtemp(join(tmpdir(), 'openfilm-codex-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    stderr: 'pipe',
  });
  client = new Client({ name: 'openfilm-codex-test', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  if (temp) await rm(temp, { recursive: true, force: true });
});

test('advertises editor, official checks, render and isolated shutdown tools', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(({ name }) => name), [
    'openfilm_open_editor',
    'openfilm_get_context',
    'openfilm_clear_references',
    'openfilm_editor_command',
    'openfilm_patch_project',
    'openfilm_get_operation',
    'openfilm_undo_operation',
    'openfilm_check_project',
    'openfilm_render_project',
    'openfilm_stop_editor',
  ]);
});

test('requires a real OpenFilm project folder before opening the editor', async () => {
  const folder = join(temp, 'empty');
  await mkdir(folder);
  const result = await client.callTool({ name: 'openfilm_open_editor', arguments: { projectPath: folder } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No film\.html found/);
});

test('runs the official look command in the selected project folder', async () => {
  const folder = join(temp, 'film');
  await mkdir(folder);
  await writeFile(join(folder, 'film.html'), '<meta name="viewport" content="width=1920,height=1080">\n');

  const marker = join(temp, 'cli-invocation.json');
  const fakeCli = join(temp, 'fake-openfilm.mjs');
  await writeFile(fakeCli, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\nconsole.log('fake OpenFilm command completed');\nconsole.error('Studio http://127.0.0.1:4567/open?key=test-private-credential&to=project');\nif (process.argv.at(-1) === '4') process.exit(1);\n`);

  const child = spawn(process.execPath, [SERVER], {
    cwd: temp,
    env: { ...process.env, OPENFILM_CLI: fakeCli },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = child.stdout;
  const pending = new Map();
  let buffer = '';
  lines.on('data', (chunk) => {
    buffer += chunk.toString();
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    }
  });
  const send = (id, method, params) => new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  try {
    await send(1, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'openfilm-codex-test', version: '0.1.0' },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    const result = await send(2, 'tools/call', {
      name: 'openfilm_check_project',
      arguments: { projectPath: folder, range: '3-8' },
    });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /fake OpenFilm command completed/);
    assert.doesNotMatch(result.content[0].text, /test-private-credential/);
    assert.match(result.content[0].text, /private launch URL omitted/);

    const invocation = JSON.parse(await readFile(marker, 'utf8'));
    assert.deepEqual(invocation.args, ['look', '3-8']);
    assert.equal(invocation.cwd, folder);
    const failed = await send(3, 'tools/call', { name: 'openfilm_check_project', arguments: { projectPath: folder, range: '4' } });
    assert.equal(failed.isError, true);
    assert.doesNotMatch(failed.content[0].text, /test-private-credential/);
  } finally {
    child.kill();
  }
});
