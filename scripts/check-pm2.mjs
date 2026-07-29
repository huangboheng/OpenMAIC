#!/usr/bin/env node
// scripts/check-pm2.mjs
//
// Smoke-test that PM2-managed dev processes are healthy. Expects to read the
// JSON list from stdin (`pm2 jlist --no-color | node scripts/check-pm2.mjs`).
//
// Exit 0: every required app is in `status: "online"`.
// Exit 1: at least one required app is missing or not online; prints the
//         offending name so the user can `pm2 logs <name>` for details.

import { createInterface } from 'node:readline';

const REQUIRED = new Set(['philochora', 'openmaic']);

/** @type {Array<{name:string,pm2_env:{status?:string}}>} */
let json = [];
try {
  let raw = '';
  const rl = createInterface({ input: process.stdin });
  for await (const chunk of rl) raw += chunk + '\n';
  json = JSON.parse(raw);
} catch (err) {
  console.error('[check-pm2] failed to parse `pm2 jlist` JSON:', err.message);
  process.exit(2);
}

const online = new Set(
  json.filter((p) => p.pm2_env?.status === 'online').map((p) => p.name)
);

const missing = [...REQUIRED].filter((n) => !online.has(n));

if (missing.length === 0) {
  console.log(`[check-pm2] OK — online: ${[...REQUIRED].join(', ')}`);
  process.exit(0);
}

console.error('[check-pm2] FAILED — required apps not online:');
for (const name of missing) {
  const proc = json.find((p) => p.name === name);
  if (proc) {
    console.error(
      `  - ${name}: status=${proc.pm2_env?.status ?? '?'} ` +
        `restarts=${proc.pm2_env?.restart_time ?? '?'} ` +
        `exit_code=${proc.pm2_env?.exit_code ?? '?'}`
    );
  } else {
    console.error(`  - ${name}: not registered in pm2`);
  }
}
process.exit(1);
