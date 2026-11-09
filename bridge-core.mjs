import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

export class BridgeError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message); Object.assign(this, { code, status, details });
  }
}
export async function atomicJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temp, file);
}

const refSchema = z.object({
  kind: z.string().max(40), id: z.string().max(500).optional(), loc: z.string().max(500).optional(),
  label: z.string().max(1000).optional(), clipId: z.string().max(500).optional(),
  clipKind: z.string().max(40).optional(), src: z.string().max(4096).optional(),
  text: z.string().max(2000).optional(), path: z.string().max(4096).optional(),
  start: z.number().finite().optional(), end: z.number().finite().optional(),
  time: z.number().finite().optional(), track: z.number().int().optional(),
  duration: z.number().finite().optional(), title: z.string().max(1000).optional(),
  box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
});
const selectionSchema = z.object({
  projectId: z.string().min(1).max(200), time: z.number().finite().min(0),
  refs: z.array(refSchema).max(64),
  range: z.object({ start: z.number().min(0), end: z.number().min(0) }).nullable().optional(),
  stage: z.object({ w: z.number().positive(), h: z.number().positive() }).optional(),
});
export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('seek'), time: z.number().finite().min(0) }).strict(),
  z.object({ type: z.literal('select-clip'), id: z.string().min(1).max(200), seek: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('show-range'), start: z.number().min(0), end: z.number().min(0) }).strict(),
]);

function preserveLocks(before, after) {
  for (let i = 0; i < before.tracks.length; i++) {
    if (before.tracks[i].locked && !isDeepStrictEqual(before.tracks[i], after.tracks[i])) {
      throw new BridgeError('TRACK_LOCKED', `Track ${i} is locked. Keep the person's lock and edits.`, 409);
    }
  }
}

/** One worker owns the bindings and uses the exact same edit queue as its Studio. */
export class EditorBridge {
  constructor({ home, runtime }) {
    this.home = home; this.runtime = runtime;
    this.bindings = new Map(); this.pages = new Map(); this.views = new Map(); this.commands = new Map();
    this.turn = Promise.resolve();
  }
  async init() {
    await mkdir(join(this.home, 'operations'), { recursive: true });
    let saved;
    try { saved = JSON.parse(await readFile(join(this.home, 'bindings.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const binding of saved?.bindings ?? []) this.bindings.set(binding.id, binding);
  }
  exclusive(fn) {
    const next = this.turn.then(fn); this.turn = next.catch(() => {}); return next;
  }
  get(id) {
    const binding = this.bindings.get(id);
    if (!binding) throw new BridgeError('BINDING_NOT_FOUND', 'Open or bind the intended project first.', 404);
    return binding;
  }
  async bind({ projectPath, harness, sessionId, sessionScope }) {
    return this.exclusive(async () => {
      const project = await this.runtime.openProject(projectPath);
      z.object({ harness: z.string().min(1).max(80), sessionId: z.string().min(1).max(200),
        sessionScope: z.enum(['conversation', 'connection']), projectPath: z.string().min(1).max(4096) })
        .parse({ harness, sessionId, sessionScope, projectPath });
      const previous = [...this.bindings.values()].find((b) => b.harness === harness && b.sessionId === sessionId && b.projectPath === project.path);
      // A different project gets a different binding: stale tool packets cannot silently switch projects.
      let binding = previous?.projectPath === project.path ? previous : null;
      if (!binding) {
        binding = { id: randomUUID(), harness, sessionId, sessionScope, projectPath: project.path,
          projectId: project.id, projectName: project.name, createdAt: new Date().toISOString() };
        this.bindings.set(binding.id, binding);
        await atomicJson(join(this.home, 'bindings.json'), { version: 1, bindings: [...this.bindings.values()] });
      }
      const pageToken = randomUUID();
      this.pages.set(pageToken, binding.id);
      return { binding, pageToken };
    });
  }
  page(token) {
    const id = this.pages.get(token);
    if (!id) throw new BridgeError('PAGE_UNAUTHORIZED', 'Reopen the editor from your agent.', 401);
    return this.get(id);
  }
  async verifyProject(binding) {
    const project = await this.runtime.projectById(binding.projectId);
    if (project.path !== binding.projectPath || project.missing) {
      throw new BridgeError('PROJECT_MOVED', 'The project moved or is missing. Reopen it to bind its current path.', 409);
    }
  }
  async updatePage(token, { selection, reference, pageId, ack }) {
    const binding = this.page(token);
    if (!z.string().uuid().safeParse(pageId).success) throw new BridgeError('INVALID_PAGE', 'Invalid editor page ID.');
    await this.verifyProject(binding);
    this.expireCommand(binding.id);
    let view = this.views.get(binding.id);
    const currentTime = Date.now();
    if (view && view.pageId !== pageId && currentTime - view.seenAt < 5000) {
      throw new BridgeError('EDITOR_ALREADY_OPEN', 'This binding is active in another editor tab. Use that tab or close it first.', 409);
    }
    view ??= { references: [], lastAck: null };
    if (selection !== undefined) {
      const parsed = selectionSchema.parse(selection);
      if (parsed.projectId !== binding.projectId) throw new BridgeError('PROJECT_MISMATCH', 'This editor shows a different project. Reopen the bound project.', 409);
      const film = await this.runtime.settleProjectFilm(binding.projectPath);
      view.selection = { ...parsed, filmRevision: film.rev, receivedAt: new Date().toISOString() };
    }
    if (reference !== undefined) {
      const ref = refSchema.parse(reference);
      const film = await this.runtime.settleProjectFilm(binding.projectPath);
      if (view.references.length >= 64) throw new BridgeError('REFERENCE_LIMIT', 'Read and clear existing references before adding more.', 409);
      view.references.push({ id: randomUUID(), reference: ref, filmRevision: film.rev, time: view.selection?.time ?? null, createdAt: new Date().toISOString() });
    }
    if (ack) {
      const pending = this.commands.get(binding.id);
      if (pending?.id === ack.id && typeof ack.ok === 'boolean') {
        view.lastAck = { id: ack.id, ok: ack.ok, receivedAt: new Date().toISOString() };
        this.commands.delete(binding.id);
      }
    }
    Object.assign(view, { pageId, seenAt: currentTime }); this.views.set(binding.id, view);
    return { binding: { id: binding.id, harness: binding.harness, projectName: binding.projectName },
      referenceCount: view.references.length, command: this.commands.get(binding.id) ?? null };
  }
  async context(id) {
    const binding = this.get(id); await this.verifyProject(binding);
    this.expireCommand(id);
    const film = await this.runtime.settleProjectFilm(binding.projectPath);
    const view = this.views.get(id);
    const online = Boolean(view && Date.now() - view.seenAt < 5000);
    return { binding, filmRevision: film.rev, timeline: film.value, problems: film.problems,
      editor: { online, lastSeenAt: view ? new Date(view.seenAt).toISOString() : null,
        selection: view?.selection ?? null,
        selectionStale: !online || !view?.selection || view.selection.filmRevision !== film.rev,
        lastCommandReceipt: view?.lastAck ?? null },
      references: (view?.references ?? []).map((ref) => ({ ...ref, stale: ref.filmRevision !== film.rev })) };
  }
  clearReferences(id, ids) {
    this.get(id);
    z.array(z.string().uuid()).max(64).parse(ids);
    const view = this.views.get(id);
    if (view) view.references = view.references.filter((ref) => !ids.includes(ref.id));
    return { remaining: view?.references.length ?? 0 };
  }
  expireCommand(id) {
    const pending = this.commands.get(id);
    if (pending && Date.now() - Date.parse(pending.createdAt) > 15_000) {
      this.commands.delete(id);
      const view = this.views.get(id);
      if (view) view.lastAck = { id: pending.id, ok: false, reason: 'expired', receivedAt: new Date().toISOString() };
    }
  }
  async command(id, command) {
    const context = await this.context(id);
    if (!context.editor.online) throw new BridgeError('EDITOR_OFFLINE', 'The editor is not connected. Open the returned editor URL first.', 409);
    const parsed = commandSchema.parse(command);
    if (parsed.type === 'select-clip' && !context.timeline?.tracks.some((t) => t.clips.some((c) => c.id === parsed.id))) {
      throw new BridgeError('CLIP_NOT_FOUND', 'No clip with that ID in the bound project.', 404);
    }
    if (this.commands.has(id)) throw new BridgeError('COMMAND_PENDING', 'Read the previous command receipt before sending another command.', 409);
    const queued = { id: randomUUID(), command: parsed, createdAt: new Date().toISOString() };
    this.commands.set(id, queued);
    return { ...queued, status: 'queued', note: 'Queued is not applied. Read context for the editor receipt.' };
  }
  async patch(id, { baseRevision, ops, requestId }) {
    return this.exclusive(async () => {
      const binding = this.get(id); await this.verifyProject(binding);
      z.string().regex(/^[a-f0-9]{16}$/).parse(baseRevision);
      z.string().uuid().parse(requestId);
      z.array(z.record(z.string(), z.unknown())).min(1).max(100).parse(ops);
      const file = join(this.home, 'operations', `${requestId}.json`);
      const digest = createHash('sha256').update(JSON.stringify({ id, baseRevision, ops })).digest('hex');
      let old;
      try { old = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (old) {
        if (old.digest !== digest) throw new BridgeError('REQUEST_ID_REUSED', 'Use a new request ID for a different edit.', 409);
        if (old.status === 'applied') return { requestId, filmRevision: old.afterRevision, replayed: true };
        throw new BridgeError('RESULT_UNKNOWN', 'The previous request has an uncertain result. Inspect the project and operation before deciding to retry.', 409, { requestId });
      }
      const before = await this.runtime.settleProjectFilm(binding.projectPath);
      if (before.rev !== baseRevision) throw new BridgeError('REVISION_CONFLICT', 'The project changed. Reread and merge the edit.', 409, { currentRevision: before.rev });
      const record = { requestId, bindingId: id, digest, status: 'prepared', beforeRevision: before.rev, beforeValue: before.value };
      // Durable intent precedes the write. A lost response never blindly repeats an insert or delete.
      await atomicJson(file, record);
      const done = await this.runtime.changeProjectFilm(binding.projectPath, (value, current) => {
        if (current.rev !== baseRevision) throw new BridgeError('REVISION_CONFLICT', 'The project changed. Reread and merge the edit.', 409, { currentRevision: current.rev });
        if (!current.value) throw new BridgeError('INVALID_FILM', 'Repair film.html before editing.');
        const start = structuredClone(value);
        const next = this.runtime.applyOps(value, ops);
        preserveLocks(start, next);
        const { doc, problems } = this.runtime.readFilm(next);
        if (!doc) throw new BridgeError('INVALID_EDIT', problems.join('\n'), 422);
        return { value: next };
      }, { ops });
      Object.assign(record, { status: 'applied', afterRevision: done.rev, appliedAt: new Date().toISOString() });
      await atomicJson(file, record);
      return { requestId, filmRevision: done.rev, previousRevision: before.rev, replayed: false };
    });
  }
  async operation(id, requestId) {
    this.get(id); z.string().uuid().parse(requestId);
    const record = JSON.parse(await readFile(join(this.home, 'operations', `${requestId}.json`), 'utf8'));
    if (record.bindingId !== id) throw new BridgeError('OPERATION_NOT_FOUND', 'No such operation for this binding.', 404);
    const { beforeValue, ...summary } = record; return summary;
  }
  async undo(id, { requestId, baseRevision }) {
    return this.exclusive(async () => {
      const binding = this.get(id); await this.verifyProject(binding);
      const record = await this.operation(id, requestId);
      if (record.status !== 'applied' || baseRevision !== record.afterRevision) {
        throw new BridgeError('UNDO_CONFLICT', 'Only an applied operation at its exact resulting revision can be undone.', 409);
      }
      const saved = JSON.parse(await readFile(join(this.home, 'operations', `${requestId}.json`), 'utf8'));
      const done = await this.runtime.changeProjectFilm(binding.projectPath, (value, current) => {
        if (current.rev !== baseRevision) throw new BridgeError('REVISION_CONFLICT', 'Later edits exist. Reread and merge instead of undoing them.', 409);
        preserveLocks(value, saved.beforeValue);
        return { value: saved.beforeValue };
      }, { undo: true });
      await atomicJson(join(this.home, 'operations', `${requestId}.json`), { ...saved, status: 'undone', undoRevision: done.rev });
      return { requestId, filmRevision: done.rev, status: 'undone' };
    });
  }
}
