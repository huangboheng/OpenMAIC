#!/usr/bin/env node
/**
 * verify-tts-completeness.mjs
 *
 * 独立口径核验课堂预生成音色音频的完整性（与 backfill-missing-tts.mjs 的
 * 判定逻辑相互独立，用于交叉验证）：
 *   理论文件数 = 课堂 JSON 中 speech action 数 × 4 种预设音色
 *   实际文件数 = data/classrooms/<id>/audio/ 下与规范命名匹配且 ≥1KB 的 mp3
 *
 * 用法：
 *   node scripts/verify-tts-completeness.mjs              # 全量核验
 *   node scripts/verify-tts-completeness.mjs --summary    # 只输出汇总
 *   node scripts/verify-tts-completeness.mjs --classroom=xx
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..');
const DIR = join(ROOT, 'data', 'classrooms');
const VOICES = ['female-yujie', 'female-shaonv', 'male-qn-jingying', 'Chinese__Mandarin__Gentleman'];

const args = process.argv.slice(2);
const summaryOnly = args.includes('--summary');
const onlyClassroom = args.find((a) => a.startsWith('--classroom='))?.split('=')[1];

const rows = [];
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
  const id = f.replace(/\.json$/, '');
  if (onlyClassroom && id !== onlyClassroom) continue;
  let data;
  try {
    data = JSON.parse(readFileSync(join(DIR, f), 'utf-8'));
  } catch {
    rows.push({ id, name: '(JSON 解析失败)', speeches: 0, exact: 0, missing: -1 });
    continue;
  }
  const name = data.stage?.name || '';
  const audioDir = join(DIR, id, 'audio');
  let speeches = 0;
  let missing = 0;
  for (const scene of data.scenes || []) {
    for (const a of scene.actions || []) {
      if (a.type !== 'speech' || !a.text) continue;
      speeches += 1;
      for (const vf of VOICES) {
        const p = join(audioDir, `tts_s${scene.order}_${a.id}_${vf}.mp3`);
        if (!existsSync(p) || statSync(p).size < 1024) missing += 1;
      }
    }
  }
  rows.push({ id, name, speeches, missing });
}

const incomplete = rows.filter((r) => r.missing > 0).sort((a, b) => b.missing - a.missing);
const totalMissing = incomplete.reduce((s, r) => s + r.missing, 0);
const complete = rows.length - incomplete.length;

console.log(
  `核验结果: ${rows.length} 个课堂, ${complete} 个完整, ${incomplete.length} 个有缺失, 总缺失 ${totalMissing}`,
);
if (!summaryOnly) {
  for (const r of incomplete) {
    console.log(`  ${r.id}（${r.name}）: ${r.speeches} 条语音, 缺失 ${r.missing}`);
  }
}
if (incomplete.length === 0) {
  console.log('全部课堂四音色音频齐备 ✓');
}
process.exit(incomplete.length === 0 ? 0 : 1);
