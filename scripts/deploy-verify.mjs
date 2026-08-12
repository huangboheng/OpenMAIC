#!/usr/bin/env node
/**
 * deploy-verify.mjs
 *
 * 部署前/后全量审计 — 单一入口校验磁盘完整性 + 数据库一致性 + 数据量核对。
 * 用法：node scripts/deploy-verify.mjs [--db] [--summary]
 *   --db       也检查 DB 一致性（需要 DATABASE_URL）
 *   --summary  只输出汇总结论，不打印明细
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = join(import.meta.dirname, '..');
const CLASSROOMS_DIR = join(ROOT, 'data', 'classrooms');
const VOICES = [
  'female-yujie',
  'female-shaonv',
  'male-qn-jingying',
  'Chinese__Mandarin__Gentleman',
];
const TEST_PATTERNS = [/test connectivity/i, /precheck/i];

const args = process.argv.slice(2);
const checkDb = args.includes('--db');
const summaryOnly = args.includes('--summary');

let errors = 0;
function fail(msg) { console.error('  [FAIL]', msg); errors++; }
function ok(msg) { if (!summaryOnly) console.log('  [OK]', msg); }

// ----- 1. 磁盘完整性 -----
if (!summaryOnly) console.log('\n[1] 磁盘文件审核 ...');
const jsonFiles = readdirSync(CLASSROOMS_DIR).filter((f) => f.endsWith('.json'));
let totalMissing = 0;
let completeCount = 0;
let incompleteCount = 0;
const incompleteList = [];

for (const file of jsonFiles) {
  const id = file.replace(/\.json$/, '');
  let data;
  try {
    data = JSON.parse(readFileSync(join(CLASSROOMS_DIR, file), 'utf-8'));
  } catch {
    fail(`${id} JSON 解析失败`);
    continue;
  }
  const name = data.stage?.name || '';
  const isTest = TEST_PATTERNS.some((re) => re.test(name));
  if (isTest) { ok(`${id}（测试课堂）已跳过`); continue; }

  const audioDir = join(CLASSROOMS_DIR, id, 'audio');
  let speeches = 0;
  let missing = 0;
  try {
    for (const scene of data.scenes || []) {
      for (const a of scene.actions || []) {
        if (a.type !== 'speech' || !a.text) continue;
        speeches++;
        for (const vf of VOICES) {
          const p = join(audioDir, `tts_s${scene.order}_${a.id}_${vf}.mp3`);
          if (!existsSync(p) || statSync(p).size < 1024) missing++;
        }
      }
    }
  } catch { missing = -1; }

  if (missing === 0) {
    completeCount++;
    ok(`${id}（${name}）: ${speeches} 条语音, 齐备`);
  } else {
    incompleteCount++;
    totalMissing += Math.max(0, missing);
    if (!summaryOnly) console.log(`  [WARN] ${id}（${name}）: 缺失 ${missing}`);
  }
}

const formalCount = completeCount + incompleteCount;
console.log(`\n  => 正式课堂 ${formalCount} 个, 完整 ${completeCount}, 有缺失 ${incompleteCount}, 总缺失 ${totalMissing}`);
if (incompleteCount > 0) fail(`有 ${incompleteCount} 个正式课堂不完整`);

// ----- 2. <1KB 损坏文件扫描 -----
if (!summaryOnly) console.log('\n[2] 损坏文件扫描 (<1KB) ...');
let corruptCount = 0;
const corruptFiles = [];
function scanDir(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { scanDir(p); continue; }
    if (entry.name.endsWith('.mp3') && statSync(p).size < 1024) {
      corruptFiles.push(p);
      corruptCount++;
    }
  }
}
scanDir(CLASSROOMS_DIR);
if (corruptCount > 0) {
  for (const f of corruptFiles.slice(0, 10))
    if (!summaryOnly) console.log(`  [CORRUPT] ${f}`);
  fail(`${corruptCount} 个 <1KB 损坏 mp3 文件`);
} else {
  ok('0 个损坏文件');
}

// ----- 3. 数据量统计 -----
if (!summaryOnly) console.log('\n[3] 数据量统计 ...');
let mp3Count = 0;
let mp3Size = 0;
function countMp3(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { countMp3(p); continue; }
    if (entry.name.endsWith('.mp3')) {
      mp3Count++;
      mp3Size += statSync(p).size;
    }
  }
}
countMp3(CLASSROOMS_DIR);
ok(`${mp3Count} 个 mp3, ${(mp3Size / (1024 ** 3)).toFixed(2)} GB`);

// ----- 4. DB 一致性（可选）-----
if (checkDb) {
  if (!summaryOnly) console.log('\n[4] 数据库一致性 ...');
  try {
    const env = readFileSync(join(ROOT, '.env.local'), 'utf-8');
    const m = env.match(/^DATABASE_URL=(.*)$/m);
    if (!m) { fail('DATABASE_URL 未配置'); process.exit(errors > 0 ? 1 : 0); }
    const { Client } = require('pg');
    const client = new Client({ connectionString: m[1].trim() });
    await client.connect();

    const { rows: [dbStages] } = await client.query('SELECT count(*)::int AS n FROM document_stages');
    const { rows: [dbScenes] } = await client.query('SELECT count(*)::int AS n FROM document_scenes');
    ok(`document_stages: ${dbStages.n} 行, document_scenes: ${dbScenes.n} 行`);

    // 抽样 3 个课堂字段级对比（加速审核）
    const sampleIds = ['sheSDcJQKd', 'tZEzYLpcB8', 'rC5vDeONq-'];
    for (const sid of sampleIds) {
      const diskFile = join(CLASSROOMS_DIR, `${sid}.json`);
      if (!existsSync(diskFile)) { console.log(`  [WARN] ${sid} 磁盘无 JSON，跳过`); continue; }
      const disk = JSON.parse(readFileSync(diskFile, 'utf-8'));
      const dAudio = {};
      for (const sc of disk.scenes || [])
        for (const ac of sc.actions || [])
          if (ac.type === 'speech') dAudio[ac.id] = ac.audioId || null;

      const { rows: dbRows } = await client.query('SELECT data FROM document_scenes WHERE stage_id=$1', [sid]);
      const bAudio = {};
      for (const r of dbRows)
        for (const ac of r.data.actions || [])
          if (ac.type === 'speech') bAudio[ac.id] = ac.audioId || null;

      const ids = new Set([...Object.keys(dAudio), ...Object.keys(bAudio)]);
      let same = 0, diff = 0;
      for (const aid of ids) {
        if (dAudio[aid] === bAudio[aid]) same++;
        else diff++;
      }
      if (diff > 0) fail(`${sid} audioId 不一致: ${diff}/${ids.size}`);
      else ok(`${sid}: ${same}/${ids.size} audioId 一致`);
    }
    await client.end();
  } catch (e) {
    fail(`DB 审计异常: ${e.message}`);
  }
}

// ----- 结论 -----
console.log(`\n========================================`);
if (errors === 0) {
  console.log('审计通过: 全部校验项通过');
  process.exit(0);
} else {
  console.log(`审计失败: ${errors} 个校验项未通过`);
  process.exit(1);
}
