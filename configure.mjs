#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Print exact local config; never rewrite a host's existing configuration. */
export function configFor(host, root = dirname(fileURLToPath(import.meta.url)), node = process.execPath) {
  const command = { command: node, args: [join(root, 'server.mjs')], env: { OPENFILM_HARNESS: host } };
  switch (host) {
    case 'codex':
      return `[mcp_servers.openfilm-editor]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(command.args[0])}]\nstartup_timeout_sec = 30\ntool_timeout_sec = 1800\n\n[mcp_servers.openfilm-editor.env]\nOPENFILM_HARNESS = "codex"\n`;
    case 'opencode':
      return JSON.stringify({ mcp: { 'openfilm-editor': { type: 'local', command: [node, ...command.args], environment: command.env, enabled: true } } }, null, 2);
    case 'gemini':
    case 'claude-code':
    case 'cursor':
    case 'dsh':
    case 'generic':
      return JSON.stringify({ mcpServers: { 'openfilm-editor': command } }, null, 2);
    default: throw new Error('Choose codex, claude-code, cursor, opencode, gemini, dsh or generic.');
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(configFor(process.argv[2] || 'generic'));
