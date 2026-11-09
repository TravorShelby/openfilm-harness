# Validation scope

## Public-source preparation — 2026-11-09

- Installed the lockfile into the standalone public checkout with `npm ci --ignore-scripts`; syntax checks and all eight existing tests passed on Windows with Node 24.14.0.
- Packed bundled dependencies and extracted into a fresh directory. `verify-release.mjs` confirmed ten tools, actual Studio selection/reference handoff, official look, official render and full FFmpeg decode.
- The new export was a two-second, 640×360, 30 fps H.264 synthetic film without audio. The editor screenshot and twelve-frame contact sheet were visually inspected.
- Source and archive inventories were checked for machine-specific configuration, private project artifacts and credentials. Generated evidence stays in ignored local directories; the public editor screenshot contains only the synthetic project.
- Public preparation adds documentation, attribution, package metadata and a CI workflow; bridge runtime behavior is unchanged from the local 0.2.0 baseline. CI results are visible on GitHub once the workflow runs.

## Local baseline — 2026-11-06

The original Windows development acceptance used OpenFilm 0.2.7 and isolated synthetic projects:

- Eight automated tests passed, including actual Chromium and Studio, two stdio MCP clients, session/reference isolation, selection/playhead commands, timeline edits, undo, conflicts, locked tracks and origin checks.
- Codex native plugin discovery, installation and path expansion were verified. A subsequent real Codex conversation discovered all ten tools, opened the synthetic project in its browser panel and read `online=true` context.
- A bundled-dependency archive was extracted into an independent directory and exercised without the development checkout's runtime fallback.
- The official look check sampled twelve timestamps twice in different orders with matching results.
- The official renderer exported a two-second 640×360, 30 fps, H.264 synthetic film. ffprobe and a full FFmpeg decode passed. This fixture had no audio track.

These are recorded acceptance results, not a claim that every host, video or platform was tested. Machine-specific settings, paths, launch URLs and original private validation artifacts are excluded from this repository.

## Reproduce

```sh
npm ci --ignore-scripts
node node_modules/playwright-core/cli.js install chromium
npm run check
npm test
```

For fresh-package acceptance, create `dist`, run `npm run pack:local`, extract the archive elsewhere, and run this from its `package` directory:

```sh
node verify-release.mjs --out <new-absolute-output-directory>
```

The script creates its own synthetic film and requires Chromium plus FFmpeg/ffprobe. It checks ten-tool discovery, real editor connection, selected-clip/reference handoff, official look, official render and full video decode. Its output directory must not already exist. Generated evidence stays local and is ignored by Git.

## Limits

- MCP clients named Codex/Claude demonstrate protocol interoperability, not acceptance of both native apps.
- Native Claude Code, Gemini, Cursor, OpenCode and DSH loading is unverified. macOS and Linux native-host behavior has not been manually accepted.
- Timeline revision/undo covers `film.html`; it does not cover all source and media files.
- References and editor state expire on worker restart. Supplied conversation bindings and edit receipts persist locally.
- A command receipt proves delivery; frame and audiovisual quality need separate inspection.
- The release does not install Chromium, FFmpeg, model accounts or media-generation credits, and is not a listing in an official public plugin marketplace.
