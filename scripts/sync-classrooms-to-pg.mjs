/**
 * sync-classrooms-to-pg.mjs
 *
 * 将 data/classrooms/*.json 中的课堂数据同步到 PostgreSQL 数据库。
 * 使用与 PgDocumentStore.saveDocument() 相同的 UPSERT + 删除孤儿 scene 逻辑。
 *
 * 用法：node scripts/sync-classrooms-to-pg.mjs
 * 环境变量：DATABASE_URL（默认读取 .env.local 中的配置）
 */

import { createRequire } from 'module';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const require = createRequire(import.meta.url);
const pg = require('pg');

// --- 配置 ---
const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres:882ab5346d3d5a8a15aba2d723aade19@localhost:5999/philochora';
const DSL_VERSION = '0.1.0';
const DSL_VERSION_KEY = 'dslVersion';
const CLASSROOMS_DIR = join(import.meta.dirname, '..', 'data', 'classrooms');

// --- Schema SQL（与 @openmaic/storage 中的 ensureSchema / ensureDocumentSchema 一致）---
const RUNTIME_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS runtime_sessions (
    id TEXT PRIMARY KEY,
    stage_id TEXT NOT NULL,
    learner_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    data JSONB NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS runtime_sessions_stage_learner_idx
    ON runtime_sessions (stage_id, learner_key)`,
  `CREATE INDEX IF NOT EXISTS runtime_sessions_learner_idx
    ON runtime_sessions (learner_key)`,
  `CREATE TABLE IF NOT EXISTS runtime_records (
    id TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES runtime_sessions(id) ON DELETE CASCADE,
    seq BIGINT NOT NULL CHECK (seq >= 0),
    scene_id TEXT,
    created_at TEXT NOT NULL,
    data JSONB NOT NULL,
    CONSTRAINT runtime_records_session_seq_unique UNIQUE (session_id, seq)
  )`,
  `CREATE INDEX IF NOT EXISTS runtime_records_session_scene_idx
    ON runtime_records (session_id, scene_id)`,
];

const DOCUMENT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS document_stages (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    interactive_mode BOOLEAN,
    task_engine_mode BOOLEAN,
    created_at DOUBLE PRECISION NOT NULL,
    updated_at DOUBLE PRECISION NOT NULL,
    data JSONB NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS document_scenes (
    stage_id TEXT NOT NULL REFERENCES document_stages(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    scene_order DOUBLE PRECISION NOT NULL,
    data JSONB NOT NULL,
    PRIMARY KEY (stage_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS document_scenes_stage_order_idx
    ON document_scenes (stage_id, scene_order, id)`,
  `CREATE TABLE IF NOT EXISTS document_outlines (
    stage_id TEXT PRIMARY KEY REFERENCES document_stages(id) ON DELETE CASCADE,
    data JSONB NOT NULL
  )`,
];

// --- 主逻辑 ---
async function main() {
  console.log('=== OpenMAIC 课堂数据同步到 PostgreSQL ===\n');
  console.log(`数据库: ${DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`数据目录: ${CLASSROOMS_DIR}\n`);

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  console.log('[OK] 数据库连接成功\n');

  // 1. 建表
  console.log('[1/3] 创建表结构...');
  for (const sql of [...RUNTIME_SCHEMA, ...DOCUMENT_SCHEMA]) {
    await client.query(sql);
  }
  console.log('  runtime_sessions, runtime_records, document_stages, document_scenes, document_outlines ✓\n');

  // 2. 读取 JSON 文件
  console.log('[2/3] 读取课堂 JSON 文件...');
  const files = readdirSync(CLASSROOMS_DIR).filter((f) => f.endsWith('.json'));
  console.log(`  发现 ${files.length} 个文件\n`);

  // 3. 同步
  console.log('[3/3] 同步数据...');
  let success = 0;
  let skipped = 0;
  let failed = 0;
  const errors = [];

  for (const file of files) {
    const filePath = join(CLASSROOMS_DIR, file);
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const classroom = JSON.parse(raw);

      const stage = classroom.stage;
      const scenes = classroom.scenes || [];

      if (!stage || !stage.id) {
        skipped++;
        continue;
      }

      const stageId = stage.id;

      // 构造 stageRow（带 DSL 版本戳）
      const stageRow = { ...stage, [DSL_VERSION_KEY]: DSL_VERSION };

      // UPSERT document_stages
      await client.query(
        `INSERT INTO document_stages
           (id, name, description, interactive_mode, task_engine_mode, created_at, updated_at, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (id) DO UPDATE
           SET name = EXCLUDED.name,
               description = EXCLUDED.description,
               interactive_mode = EXCLUDED.interactive_mode,
               task_engine_mode = EXCLUDED.task_engine_mode,
               created_at = EXCLUDED.created_at,
               updated_at = EXCLUDED.updated_at,
               data = EXCLUDED.data`,
        [
          stageId,
          stage.name || stageId,
          stage.description ?? null,
          stage.interactiveMode ?? (stage.style === 'interactive' ? true : null),
          stage.taskEngineMode ?? null,
          stage.createdAt ?? Date.now(),
          stage.updatedAt ?? Date.now(),
          JSON.stringify(stageRow),
        ],
      );

      // UPSERT 每个 scene
      const incomingIds = new Set();
      for (const scene of scenes) {
        if (!scene.id) continue;
        incomingIds.add(scene.id);
        await client.query(
          `INSERT INTO document_scenes (stage_id, id, scene_order, data)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (stage_id, id) DO UPDATE
             SET scene_order = EXCLUDED.scene_order,
                 data = EXCLUDED.data`,
          [stageId, scene.id, scene.order ?? 0, JSON.stringify(scene)],
        );
      }

      // 删除不再存在的 scene
      if (incomingIds.size > 0) {
        await client.query(
          `DELETE FROM document_scenes
            WHERE stage_id = $1
              AND id != ALL($2::text[])`,
          [stageId, [...incomingIds]],
        );
      }

      success++;
      if (success % 20 === 0) {
        console.log(`  进度: ${success}/${files.length} ...`);
      }
    } catch (err) {
      failed++;
      errors.push({ file, error: err.message });
    }
  }

  // 统计
  console.log('\n=== 同步完成 ===');
  console.log(`  成功: ${success}`);
  console.log(`  跳过: ${skipped}`);
  console.log(`  失败: ${failed}`);

  if (errors.length > 0) {
    console.log('\n失败详情:');
    for (const { file, error } of errors.slice(0, 10)) {
      console.log(`  ${file}: ${error}`);
    }
    if (errors.length > 10) {
      console.log(`  ... 还有 ${errors.length - 10} 个错误`);
    }
  }

  // 验证
  const stageCount = await client.query('SELECT COUNT(*)::int AS count FROM document_stages');
  const sceneCount = await client.query('SELECT COUNT(*)::int AS count FROM document_scenes');
  console.log(`\n数据库当前状态:`);
  console.log(`  document_stages: ${stageCount.rows[0].count} 行`);
  console.log(`  document_scenes: ${sceneCount.rows[0].count} 行`);

  await client.end();
  console.log('\n[DONE] 连接已关闭');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
