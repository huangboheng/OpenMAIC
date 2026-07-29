#!/usr/bin/env node
// scripts/check-duplicate-roots.mjs
//
// Guard against Next.js' "Both middleware file and proxy file are detected"
// startup crash. Next 16 only allows one of `middleware.ts` or `proxy.ts`
// at the project root (and at the `app/` and `src/` roots); if both exist
// dev mode throws an unhandledRejection that PM2 keeps relaunching, which
// in turn can trigger Windows STATUS_DLL_INIT_FAILED (0xC0000142) dialogs
// when too many node processes are spawned in parallel.
//
// Usage:  node scripts/check-duplicate-roots.mjs
// Exit 0: only one of middleware.ts / proxy.ts exists per root.
// Exit 1: conflict found; prints the offending paths and refuses to proceed.

import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const searchRoots = [
  projectRoot,
  join(projectRoot, 'app'),
  join(projectRoot, 'src'),
].filter((dir) => existsSync(dir));

const names = ['middleware.ts', 'middleware.js', 'proxy.ts', 'proxy.js'];

const conflicts = [];
for (const dir of searchRoots) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    continue;
  }
  const present = new Set(entries.filter((n) => names.includes(n)));
  const hasMiddleware = [...present].some((n) => n.startsWith('middleware'));
  const hasProxy = [...present].some((n) => n.startsWith('proxy'));
  if (hasMiddleware && hasProxy) {
    conflicts.push(dir);
  }
}

if (conflicts.length === 0) {
  console.log('[check-duplicate-roots] OK — no middleware/proxy conflict.');
  process.exit(0);
}

console.error('[check-duplicate-roots] FAILED — Next.js 16 refuses to start when');
console.error('both `middleware.*` and `proxy.*` coexist at the same directory level.');
console.error('Remove one of the following to restore dev startup:');
for (const dir of conflicts) {
  console.error(`  - ${dir}`);
  for (const n of names) {
    const p = join(dir, n);
    if (existsSync(p)) console.error(`      • ${p}`);
  }
}
process.exit(1);
