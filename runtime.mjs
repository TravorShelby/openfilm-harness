import { createRequire } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export function runtimeRoot(env = process.env) {
  if (env.OPENFILM_RUNTIME_ROOT) {
    if (!isAbsolute(env.OPENFILM_RUNTIME_ROOT)) throw new Error('OPENFILM_RUNTIME_ROOT must be absolute.');
    return realpathSync(env.OPENFILM_RUNTIME_ROOT);
  }
  try { return dirname(createRequire(import.meta.url).resolve('openfilm/package.json')); } catch {}
  const local = resolve(HERE, '../../.local/node_modules/openfilm');
  if (existsSync(join(local, 'package.json'))) return local;
  throw new Error('OpenFilm runtime is missing. Run npm ci in the plugin folder.');
}

export async function loadRuntime(env) {
  const root = runtimeRoot(env);
  const load = (path) => import(pathToFileURL(join(root, path)).href);
  const [studio, projects, film, ops, doc] = await Promise.all([
    load('studio/server/server.mjs'), load('studio/server/projects.mjs'),
    load('studio/server/film.mjs'), load('studio/server/ops.mjs'), load('src/film-doc.mjs'),
  ]);
  return { root, ...studio, ...projects, ...film, ...ops, ...doc };
}
