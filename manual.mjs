#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeRoot } from './runtime.mjs';
const skill = process.argv[2] === '--skill' ? process.argv[3] : null;
if (skill && !/^[a-z0-9-]+$/.test(skill)) throw new Error('Use a built-in skill name, for example motion-graphics.');
console.log(await readFile(skill ? join(runtimeRoot(), 'skills', skill, 'SKILL.md') : join(runtimeRoot(), 'MANUAL.md'), 'utf8'));
