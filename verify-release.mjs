// A retained synthetic-film acceptance check. Never targets an existing user film.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright-core';
import { loadRuntime } from './runtime.mjs';
import { redactLaunchUrls } from './private-output.mjs';

const output = process.argv[process.argv.indexOf('--out') + 1];
if (!process.argv.includes('--out') || !output || !isAbsolute(output)) throw new Error('Use --out <new absolute directory>.');
await mkdir(output); // Refuse to overwrite any existing film or evidence directory.
const project = join(output, 'synthetic-film'); await mkdir(project);
const privateHome = await mkdtemp(join(tmpdir(), 'openfilm-release-private-'));
const runtime = await loadRuntime();
await writeFile(join(project, 'film.html'), runtime.filmHtml({ stage: { w: 640, h: 360 }, tracks: [
  { clips: [{ id: 'bridge-demo', src: 'scene.html', time: [0, 2] }] },
] }));
await writeFile(join(project, 'scene.html'), `<!doctype html><html><head>
<meta name="viewport" content="width=640,height=360"><style>
*{box-sizing:border-box}html,body{margin:0;width:640px;height:360px;overflow:hidden}
body{background:#111927;color:#f4f8ff;font-family:Arial,sans-serif;padding:36px}
small{color:#67dfbc;font-size:15px;letter-spacing:4px}h1{font-size:46px;margin:23px 0 10px;line-height:1.02}
p{font-size:18px;color:#afbdd2;margin:0}.track{margin-top:30px;display:flex;gap:6px}
.track div{height:28px;border-radius:5px;background:#3798d1;width:130px}.track div:nth-child(2){background:#806bd8;width:180px}
.track div:nth-child(3){background:#51be9b;width:100px}#cursor{position:absolute;top:258px;height:45px;width:3px;background:white}
</style></head><body><small>OPENFILM / HARNESS</small><h1>Your chat.<br>One shared timeline.</h1>
<p>Selection · references · guarded edits · render</p><div class="track"><div></div><div></div><div></div></div><div id="cursor"></div>
<script>window.film={frame(t){document.getElementById('cursor').style.left=(36+Math.min(1,t/2)*422)+'px'}};</script></body></html>`);
const env = { ...process.env, OPENFILM_BRIDGE_HOME: privateHome };
delete env.OPENFILM_RUNTIME_ROOT; delete env.OPENFILM_CLI;
const transport = new StdioClientTransport({ command: process.execPath,
  args: [fileURLToPath(new URL('./server.mjs', import.meta.url))], env, stderr: 'pipe' });
const client = new Client({ name: 'release-acceptance', version: '0.2.0' });
let browser, binding, phase = 'connect';
const receipt = { version: '0.2.0', runtimeVersion: JSON.parse(await readFile(join(runtime.root, 'package.json'), 'utf8')).version };
async function call(name, args = {}, json = true) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  if (result.isError) throw new Error(result.content[0].text);
  return json ? JSON.parse(result.content[0].text) : result.content[0].text;
}
async function files(folder) {
  const all = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) all.push(...await files(path)); else all.push(path);
  }
  return all;
}
try {
  await client.connect(transport);
  receipt.toolCount = (await client.listTools()).tools.length;
  assert.equal(receipt.toolCount, 10);
  phase = 'open-editor';
  const opened = await call('openfilm_open_editor', { projectPath: project }); binding = opened.binding.id;
  assert.equal(opened.binding.sessionScope, process.env.CODEX_THREAD_ID || process.env.OPENFILM_SESSION_ID ? 'conversation' : 'connection');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(opened.editorUrl);
  await page.getByRole('status').filter({ hasText: '已连接' }).waitFor();
  const queued = await call('openfilm_editor_command', { bindingId: binding, command: { type: 'select-clip', id: 'bridge-demo', seek: true } });
  let context;
  for (let i = 0; i < 50; i++) {
    context = await call('openfilm_get_context', { bindingId: binding });
    if (context.editor.lastCommandReceipt?.id === queued.id && context.editor.selection.refs.some((ref) => ref.id === 'bridge-demo')) break;
    await page.waitForTimeout(100);
  }
  assert.ok(context.editor.selection.refs.some((ref) => ref.id === 'bridge-demo'));
  await page.getByRole('button', { name: '引用所选', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '条引用待助手读取' }).waitFor();
  context = await call('openfilm_get_context', { bindingId: binding });
  assert.ok(context.references.length);
  receipt.selectionAndReference = true;
  await page.screenshot({ path: join(output, 'editor.png') });
  phase = 'official-look';
  await writeFile(join(output, 'look.txt'), redactLaunchUrls(await call('openfilm_check_project', { projectPath: project, range: '0-2' }, false)));
  phase = 'official-render';
  await writeFile(join(output, 'render.txt'), redactLaunchUrls(await call('openfilm_render_project', { projectPath: project, range: '0-2' }, false)));
  const artifacts = await files(project);
  const video = artifacts.find((path) => path.endsWith('.mp4'));
  assert.ok(video, 'Official render did not produce an MP4.');
  phase = 'decode';
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,codec_type,width,height,r_frame_rate', '-of', 'json', video], { encoding: 'utf8', windowsHide: true });
  assert.equal(probe.status, 0, probe.stderr);
  await writeFile(join(output, 'video-probe.json'), probe.stdout);
  const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', video, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
  assert.equal(decoded.status, 0, decoded.stderr);
  Object.assign(receipt, { officialLook: true, officialRender: true, fullVideoDecode: true,
    video: relative(output, video), probe: JSON.parse(probe.stdout),
    images: artifacts.filter((path) => path.endsWith('.png')).map((path) => relative(output, path)) });
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  // Browser errors may include private launch URLs. Persist only the failing phase.
  await writeFile(join(output, 'failure.json'), JSON.stringify({ phase, errorType: error.name }));
  console.error(`Release acceptance failed during ${phase}; ${error.name}. Private launch details omitted.`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (binding) await call('openfilm_stop_editor').catch(() => {});
  await client.close();
  for (let i = 0; i < 50; i++) {
    try { await readFile(join(privateHome, 'runtime.json')); await new Promise((done) => setTimeout(done, 100)); } catch { break; }
  }
  await rm(privateHome, { recursive: true, force: true });
}
