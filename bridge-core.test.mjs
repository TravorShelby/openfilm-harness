import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { EditorBridge } from './bridge-core.mjs';
import { loadRuntime } from './runtime.mjs';

let temp, runtime, bridge, folder;
before(async () => {
  temp = await mkdtemp(join(tmpdir(), 'openfilm-bridge-core-'));
  process.env.OPENFILM_HOME = join(temp, 'studio');
  runtime = await loadRuntime();
  folder = join(temp, 'film'); await mkdir(folder);
  await writeFile(join(folder, 'film.html'), runtime.filmHtml({ stage: { w: 640, h: 360 }, tracks: [{ clips: [{ id: 'shot', src: 'scene.html', time: [0, 3] }] }] }));
  bridge = new EditorBridge({ home: temp, runtime }); await bridge.init();
});
after(async () => { await rm(temp, { recursive: true, force: true }); });
const bind = (sessionId) => bridge.bind({ projectPath: folder, harness: 'test', sessionId, sessionScope: 'conversation' });

test('bindings survive restart; two conversations and editor references remain isolated', async () => {
  const a = await bind('chat-a'), b = await bind('chat-b');
  assert.notEqual(a.binding.id, b.binding.id);
  const pageId = randomUUID();
  await bridge.updatePage(a.pageToken, { pageId, selection: { projectId: a.binding.projectId, time: 1.25, refs: [{ kind: 'clip', id: 'shot' }] }, reference: { kind: 'clip', id: 'shot' } });
  assert.equal((await bridge.context(a.binding.id)).references.length, 1);
  assert.equal((await bridge.context(b.binding.id)).references.length, 0);
  await assert.rejects(bridge.updatePage(a.pageToken, { pageId, selection: { projectId: 'other', time: 0, refs: [] } }), { code: 'PROJECT_MISMATCH' });
  await assert.rejects(bridge.updatePage(a.pageToken, { pageId: randomUUID() }), { code: 'EDITOR_ALREADY_OPEN' });
  const restored = new EditorBridge({ home: temp, runtime }); await restored.init();
  assert.equal((await restored.bind({ projectPath: folder, harness: 'test', sessionId: 'chat-a', sessionScope: 'conversation' })).binding.id, a.binding.id);
  assert.equal((await restored.context(a.binding.id)).editor.online, false);
  assert.throws(() => restored.page(a.pageToken), { code: 'PAGE_UNAUTHORIZED' });
});

test('stale edits refuse to overwrite human changes; locked tracks are protected', async () => {
  const { binding } = await bind('conflict');
  const before = await bridge.context(binding.id);
  await runtime.editProjectFilm(folder, before.filmRevision, [{ op: 'set', clip: 'shot', field: 'at', value: 1.2 }]);
  await assert.rejects(bridge.patch(binding.id, { baseRevision: before.filmRevision, requestId: randomUUID(), ops: [{ op: 'remove', clip: 'shot' }] }), { code: 'REVISION_CONFLICT' });
  let now = await bridge.context(binding.id);
  assert.equal(now.timeline.tracks[0].clips[0].at, 1.2);
  await runtime.editProjectFilm(folder, now.filmRevision, [{ op: 'track', track: 0, field: 'locked', value: true }]);
  now = await bridge.context(binding.id);
  await assert.rejects(bridge.patch(binding.id, { baseRevision: now.filmRevision, requestId: randomUUID(), ops: [{ op: 'set', clip: 'shot', field: 'at', value: 2 }] }), { code: 'TRACK_LOCKED' });
  assert.equal((await bridge.context(binding.id)).filmRevision, now.filmRevision);
  await runtime.editProjectFilm(folder, now.filmRevision, [{ op: 'track', track: 0, field: 'locked', value: false }]);
});

test('request replay is idempotent and undo preserves later edits', async () => {
  const { binding } = await bind('edits');
  const before = await bridge.context(binding.id);
  const request = { baseRevision: before.filmRevision, requestId: randomUUID(), ops: [{ op: 'set', clip: 'shot', field: 'at', value: 1.5 }] };
  const done = await bridge.patch(binding.id, request);
  assert.equal((await bridge.patch(binding.id, request)).replayed, true);
  await assert.rejects(bridge.patch(binding.id, { ...request, ops: [{ op: 'remove', clip: 'shot' }] }), { code: 'REQUEST_ID_REUSED' });
  assert.equal((await bridge.operation(binding.id, request.requestId)).status, 'applied');
  await bridge.undo(binding.id, { requestId: request.requestId, baseRevision: done.filmRevision });
  assert.equal((await bridge.context(binding.id)).timeline.tracks[0].clips[0].at, before.timeline.tracks[0].clips[0].at);
  const second = { ...request, baseRevision: (await bridge.context(binding.id)).filmRevision, requestId: randomUUID() };
  const changed = await bridge.patch(binding.id, second);
  await runtime.editProjectFilm(folder, changed.filmRevision, [{ op: 'set', clip: 'shot', field: 'at', value: 1.7 }]);
  await assert.rejects(bridge.undo(binding.id, { requestId: second.requestId, baseRevision: changed.filmRevision }), { code: 'REVISION_CONFLICT' });
  assert.equal((await bridge.context(binding.id)).timeline.tracks[0].clips[0].at, 1.7);
});

test('editor commands require a connected page and expose acknowledgement', async () => {
  const { binding, pageToken } = await bind('commands');
  await assert.rejects(bridge.command(binding.id, { type: 'seek', time: 2 }), { code: 'EDITOR_OFFLINE' });
  const pageId = randomUUID();
  await bridge.updatePage(pageToken, { pageId, selection: { projectId: binding.projectId, time: 0, refs: [] } });
  const queued = await bridge.command(binding.id, { type: 'seek', time: 2 });
  const delivery = await bridge.updatePage(pageToken, { pageId });
  assert.equal(delivery.command.id, queued.id);
  await bridge.updatePage(pageToken, { pageId, ack: { id: queued.id, ok: true }, selection: { projectId: binding.projectId, time: 2, refs: [] } });
  const context = await bridge.context(binding.id);
  assert.equal(context.editor.selection.time, 2);
  assert.equal(context.editor.lastCommandReceipt.id, queued.id);
  const abandoned = await bridge.command(binding.id, { type: 'seek', time: 1 });
  bridge.commands.get(binding.id).createdAt = new Date(Date.now() - 16_000).toISOString();
  const recovered = await bridge.context(binding.id);
  assert.equal(recovered.editor.lastCommandReceipt.id, abandoned.id);
  assert.equal(recovered.editor.lastCommandReceipt.reason, 'expired');
  assert.equal((await bridge.command(binding.id, { type: 'seek', time: 0 })).status, 'queued');
});
