import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function bridgeHome(env = process.env) {
  return env.OPENFILM_BRIDGE_HOME || join(env.LOCALAPPDATA || join(homedir(), '.local/share'), 'OpenFilm-Harness');
}
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function saved(home) {
  try {
    const data = JSON.parse(await readFile(join(home, 'runtime.json'), 'utf8'));
    const url = new URL(data.origin);
    if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || !alive(data.pid)) return null;
    const response = await fetch(`${url.origin}/health`, { headers: { authorization: `Bearer ${data.key}` }, signal: AbortSignal.timeout(1000) });
    const health = await response.json();
    return response.ok && health.product === 'openfilm-harness-bridge' && health.version === '0.2.0' ? data : null;
  } catch { return null; }
}
export async function ensureWorker({ home = bridgeHome(), env = process.env } = {}) {
  const ready = await saved(home); if (ready) return ready;
  await mkdir(home, { recursive: true, mode: 0o700 });
  const lock = join(home, 'launch.lock');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const active = await saved(home); if (active) return active;
    try { await mkdir(lock); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let holder;
      try { holder = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')); } catch {}
      // Recover a crash between mkdir and writing the launch owner's PID.
      let orphaned = false;
      if (!holder) {
        try { orphaned = Date.now() - (await stat(lock)).mtimeMs > 5000; } catch {}
      }
      if ((holder && !alive(holder.pid)) || orphaned) await rm(lock, { recursive: true, force: true });
      await wait(150); continue;
    }
    try {
      await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
      const again = await saved(home); if (again) return again;
      const log = await open(join(home, 'worker.log'), 'a', 0o600);
      try {
        const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url))], {
          env: { ...env, OPENFILM_BRIDGE_HOME: home }, stdio: ['ignore', log.fd, log.fd], detached: true, windowsHide: true,
        });
        let failed;
        child.on('error', (error) => { failed = error; }); child.unref();
        while (Date.now() < deadline) {
          if (failed) throw failed;
          const running = await saved(home); if (running) return running;
          if (child.exitCode !== null) throw new Error('Editor bridge failed to start. Inspect worker.log in its private data folder.');
          await wait(150);
        }
      } finally { await log.close(); }
    } finally { await rm(lock, { recursive: true, force: true }); }
  }
  throw new Error('Editor bridge startup timed out. Inspect worker.log in its private data folder.');
}
export async function bridgeRequest(route, data, { start = true, home = bridgeHome() } = {}) {
  const runtime = start ? await ensureWorker({ home }) : await saved(home);
  if (!runtime) throw new Error('The Harness editor bridge is not running.');
  const response = await fetch(`${runtime.origin}${route}`, { method: 'POST',
    headers: { authorization: `Bearer ${runtime.key}`, 'content-type': 'application/json' },
    body: JSON.stringify(data), signal: AbortSignal.timeout(30_000) });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result;
}
