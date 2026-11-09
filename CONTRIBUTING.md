# Contributing

Install the pinned dependencies with `npm ci --ignore-scripts` and install the matching Chromium with `node node_modules/playwright-core/cli.js install chromium`. Run `npm run check` and `npm test` before submitting a change.

Use synthetic films in new temporary directories for tests. Do not commit real footage, host settings, private project paths, launch URLs, credentials, `.film/chat`, worker state or generated validation files.

For bug reports, include the OS, Node version, host version, adapter used, plugin version, expected behavior and a minimal synthetic reproduction. Redact private paths and launch URLs from logs.

Keep timeline edits within the bridge's revision and locked-track guards. Changes to runtime internals should keep the OpenFilm dependency pinned and rerun both browser integration tests and fresh-package validation.

State the actual verification scope for new host adapters. A descriptor or protocol client named after a host is not native-host acceptance.

Contributions are made under the repository's MIT license. Preserve upstream and third-party notices.
