#!/usr/bin/env tsx
/**
 * verify-classrooms.mts
 *
 * 全量校验 data/classrooms 下的存量课堂：
 *   - JSON / stage / scene 结构与应用写边界校验器（validateAppStage / validateAppScene）
 *   - 每个 speech action 的 4 个预设音色音频是否存在且 >= 1KB
 *   - 非音频课堂媒体引用是否落到 data/classrooms/<id>/(media|images)
 *   - 可选：与 PostgreSQL 文档库逐课堂比对 stage 集合与 scene 数（只读）
 *
 * 用法：
 *   pnpm verify:classrooms
 *   pnpm verify:classrooms -- --classroom=<id>
 *   pnpm verify:classrooms -- --json
 *   pnpm verify:classrooms -- --skip-db --skip-tts
 *   pnpm verify:classrooms -- --strict            # 音频/媒体缺失也视为失败
 *
 * 退出码：结构、校验器、DB 对齐错误 → 1；音频/媒体缺失默认只告警。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { DSL_VERSION } from '@openmaic/dsl';

import * as validatorsModule from '@/lib/document-store/validators';

type ValidatorsModule = typeof validatorsModule;
const validators =
  (validatorsModule as ValidatorsModule & { default?: ValidatorsModule }).default ??
  validatorsModule;
const { validateAppScene, validateAppStage } = validators;

const ROOT = path.resolve(import.meta.dirname, '..');
const CLASSROOMS_DIR = process.env.OPENMAIC_CLASSROOMS_DIR
  ? path.resolve(process.env.OPENMAIC_CLASSROOMS_DIR)
  : path.join(ROOT, 'data', 'classrooms');
const VOICES = [
  'female-yujie',
  'female-shaonv',
  'male-qn-jingying',
  'Chinese__Mandarin__Gentleman',
];

interface ActionLike {
  type?: unknown;
  id?: unknown;
  text?: unknown;
}

interface SceneLike {
  id?: unknown;
  order?: unknown;
  type?: unknown;
  actions?: unknown;
}

interface ClassroomResult {
  id: string;
  name: string;
  scenes: number;
  sceneTypes: string[];
  stageErrors: string[];
  sceneErrors: string[];
  ttsExpected: number;
  ttsMissing: number;
  mediaRefs: number;
  mediaMissing: string[];
}

interface DbReport {
  status: 'skipped' | 'ok' | 'failed';
  stageCount?: number;
  missingInDb?: string[];
  extraInDb?: string[];
  sceneCountMismatch?: { id: string; file: number; db: number }[];
  ownerBound?: number;
  missingOwner?: string[];
  dslVersions?: { version: string; count: number }[];
  conflictingTriggers?: string[];
  error?: string;
}

interface Summary {
  generatedAt: string;
  classroomsDir: string;
  classrooms: number;
  scenes: number;
  structureErrors: number;
  ttsComplete: number;
  ttsIncomplete: { id: string; name: string; missing: number }[];
  mediaMissing: number;
  db: DbReport;
  dbWarnings: number;
  warnings: number;
  strict: boolean;
  failures: number;
  results?: ClassroomResult[];
}

function parseArgs(argv: string[]) {
  const classroomArg = argv.find((arg) => arg.startsWith('--classroom='))?.split('=')[1];
  return {
    classroom: classroomArg,
    json: argv.includes('--json'),
    strict: argv.includes('--strict'),
    verbose: argv.includes('--verbose'),
    skipDb: argv.includes('--skip-db'),
    skipTts: argv.includes('--skip-tts'),
  };
}

function readDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = path.join(ROOT, '.env.local');
  if (!fs.existsSync(envPath)) return undefined;
  const match = fs.readFileSync(envPath, 'utf-8').match(/^DATABASE_URL=(.*)$/m);
  if (!match) return undefined;
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

function errorMessages(errors: { path: string; message: string }[] | undefined): string[] {
  return (errors ?? []).map((issue) => `${issue.path}: ${issue.message}`);
}

function checkAudio(
  classroomId: string,
  scenes: SceneLike[],
): { expected: number; missing: number } {
  const audioDir = path.join(CLASSROOMS_DIR, classroomId, 'audio');
  let expected = 0;
  let missing = 0;
  for (const scene of scenes) {
    const order = typeof scene.order === 'number' ? scene.order : 0;
    const actions = Array.isArray(scene.actions) ? (scene.actions as ActionLike[]) : [];
    for (const action of actions) {
      if (action.type !== 'speech' || typeof action.text !== 'string' || !action.text) continue;
      if (typeof action.id !== 'string' || !action.id) continue;
      for (const voice of VOICES) {
        expected += 1;
        const file = path.join(audioDir, `tts_s${order}_${action.id}_${voice}.mp3`);
        try {
          if (fs.statSync(file).size < 1024) missing += 1;
        } catch {
          missing += 1;
        }
      }
    }
  }
  return { expected, missing };
}

function checkMedia(classroomId: string, serialized: string): { refs: number; missing: string[] } {
  const refs = new Set<string>();
  for (const match of serialized.matchAll(/\/api\/classroom-media\/[^"'\\\s]+/g)) {
    if (!match[0].includes('/audio/')) refs.add(match[0]);
  }
  const missing: string[] = [];
  for (const ref of refs) {
    const withoutQuery = ref.split('?')[0].split('#')[0];
    const match = withoutQuery.match(/\/api\/classroom-media\/([^/]+)\/(.+)$/);
    if (!match) continue;
    const [, refId, relative] = match;
    const file = path.join(CLASSROOMS_DIR, decodeURIComponent(refId), decodeURIComponent(relative));
    if (!fs.existsSync(file)) missing.push(ref);
  }
  return { refs: refs.size, missing };
}

function psqlRows(databaseUrl: string, sql: string): string[][] {
  const url = new URL(databaseUrl);
  const env = { ...process.env };
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  const output = execFileSync(
    'psql',
    [
      '-h',
      url.hostname,
      '-p',
      url.port || '5432',
      '-U',
      decodeURIComponent(url.username),
      '-d',
      decodeURIComponent(url.pathname.slice(1)),
      '-t',
      '-A',
      '-F',
      '\t',
      '-c',
      sql,
    ],
    { encoding: 'utf-8', env, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split('\t'));
}

async function checkDatabase(
  results: ClassroomResult[],
  databaseUrl: string | undefined,
  skip: boolean,
): Promise<DbReport> {
  if (skip) return { status: 'skipped' };
  if (!databaseUrl) return { status: 'skipped', error: 'DATABASE_URL not found' };

  try {
    const stageRows = psqlRows(databaseUrl, 'SELECT id FROM document_stages ORDER BY id');
    const sceneRows = psqlRows(
      databaseUrl,
      'SELECT stage_id, COUNT(*)::int FROM document_scenes GROUP BY stage_id ORDER BY stage_id',
    );
    const dbIds = new Set(stageRows.map(([id]) => id));
    const fileIds = new Set(results.map((result) => result.id));
    const dbScenes = new Map(sceneRows.map(([stageId, count]) => [stageId, Number(count)]));
    const sceneCountMismatch = results
      .map((result) => ({
        id: result.id,
        file: result.scenes,
        db: dbScenes.get(result.id) ?? 0,
      }))
      .filter((row) => row.file !== row.db);

    const metaRows = psqlRows(databaseUrl, 'SELECT stage_id FROM stage_meta');
    const metaIds = new Set(metaRows.map(([stageId]) => stageId));
    const missingOwner = [...fileIds].filter((id) => !metaIds.has(id));
    const dslRows = psqlRows(
      databaseUrl,
      "SELECT COALESCE(data->>'dslVersion', '<unversioned>'), COUNT(*)::int FROM document_stages GROUP BY 1 ORDER BY 2 DESC",
    );
    const triggerRows = psqlRows(
      databaseUrl,
      "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = 'document_stages'::regclass AND tgname = 'trg_document_stages_updated_at'",
    );

    return {
      status: 'ok',
      stageCount: dbIds.size,
      missingInDb: [...fileIds].filter((id) => !dbIds.has(id)),
      extraInDb: [...dbIds].filter((id) => !fileIds.has(id)),
      sceneCountMismatch,
      ownerBound: fileIds.size - missingOwner.length,
      missingOwner,
      dslVersions: dslRows.map(([version, count]) => ({ version, count: Number(count) })),
      conflictingTriggers: triggerRows.map(([name]) => name),
    };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(CLASSROOMS_DIR)) {
    console.error(`Classrooms directory not found: ${CLASSROOMS_DIR}`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(CLASSROOMS_DIR)
    .filter((file) => file.endsWith('.json'))
    .filter((file) => !args.classroom || file === `${args.classroom}.json`)
    .sort();

  if (files.length === 0) {
    console.error(
      args.classroom ? `Classroom not found: ${args.classroom}` : 'No classrooms found',
    );
    process.exit(1);
  }

  const results: ClassroomResult[] = [];
  for (const file of files) {
    const id = file.replace(/\.json$/, '');
    const raw = fs.readFileSync(path.join(CLASSROOMS_DIR, file), 'utf-8');
    let parsed: { stage?: unknown; scenes?: unknown };
    try {
      parsed = JSON.parse(raw) as { stage?: unknown; scenes?: unknown };
    } catch (error) {
      results.push({
        id,
        name: '(JSON parse failed)',
        scenes: 0,
        sceneTypes: [],
        stageErrors: [error instanceof Error ? error.message : String(error)],
        sceneErrors: [],
        ttsExpected: 0,
        ttsMissing: 0,
        mediaRefs: 0,
        mediaMissing: [],
      });
      continue;
    }

    const scenes = Array.isArray(parsed.scenes) ? (parsed.scenes as SceneLike[]) : [];
    const stage = parsed.stage;
    const stageValidation = validateAppStage(stage as Parameters<typeof validateAppStage>[0]);
    const stageErrors = stageValidation.valid ? [] : errorMessages(stageValidation.errors);
    if (!stage) stageErrors.push('/: stage is missing');
    if (scenes.length === 0) stageErrors.push('/scenes: no scenes');

    const sceneErrors: string[] = [];
    for (const scene of scenes) {
      const validation = validateAppScene(scene as Parameters<typeof validateAppScene>[0]);
      if (!validation.valid) {
        const sceneId = typeof scene.id === 'string' ? scene.id : '(unknown)';
        sceneErrors.push(
          ...errorMessages(validation.errors).map((message) => `${sceneId}${message}`),
        );
      }
    }

    const stageName =
      stage && typeof stage === 'object' && 'name' in stage && typeof stage.name === 'string'
        ? stage.name
        : '';
    const audio = args.skipTts ? { expected: 0, missing: 0 } : checkAudio(id, scenes);
    const media = checkMedia(id, raw);

    results.push({
      id,
      name: stageName,
      scenes: scenes.length,
      sceneTypes: [...new Set(scenes.map((scene) => String(scene.type)))].sort(),
      stageErrors,
      sceneErrors,
      ttsExpected: audio.expected,
      ttsMissing: audio.missing,
      mediaRefs: media.refs,
      mediaMissing: media.missing,
    });
  }

  const dbReport = await checkDatabase(results, readDatabaseUrl(), args.skipDb || !!args.classroom);
  const structureErrors = results.reduce(
    (sum, result) => sum + result.stageErrors.length + result.sceneErrors.length,
    0,
  );
  const ttsIncomplete = results
    .filter((result) => result.ttsMissing > 0)
    .map((result) => ({ id: result.id, name: result.name, missing: result.ttsMissing }));
  const mediaMissing = results.reduce((sum, result) => sum + result.mediaMissing.length, 0);
  const dbFailures =
    dbReport.status === 'failed'
      ? 1
      : (dbReport.missingInDb?.length ?? 0) +
        (dbReport.extraInDb?.length ?? 0) +
        (dbReport.sceneCountMismatch?.length ?? 0);
  const dbWarnings =
    (dbReport.missingOwner?.length ?? 0) +
    (dbReport.dslVersions ?? [])
      .filter((row) => row.version !== DSL_VERSION)
      .reduce((sum, row) => sum + row.count, 0) +
    (dbReport.conflictingTriggers?.length ?? 0);
  const warnings = ttsIncomplete.length + mediaMissing + dbWarnings;
  const strictFailures = args.strict ? warnings : 0;
  const failures = structureErrors + dbFailures + strictFailures;

  const summary: Summary = {
    generatedAt: new Date().toISOString(),
    classroomsDir: CLASSROOMS_DIR,
    classrooms: results.length,
    scenes: results.reduce((sum, result) => sum + result.scenes, 0),
    structureErrors,
    ttsComplete: results.length - ttsIncomplete.length,
    ttsIncomplete,
    mediaMissing,
    db: dbReport,
    dbWarnings,
    warnings,
    strict: args.strict,
    failures,
    ...(args.verbose || args.classroom ? { results } : {}),
  };

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Classrooms: ${summary.classrooms}`);
    console.log(`Scenes: ${summary.scenes}`);
    console.log(`Structure errors: ${summary.structureErrors}`);
    console.log(`TTS complete: ${summary.ttsComplete}/${summary.classrooms}`);
    for (const item of ttsIncomplete) {
      console.log(`  missing audio: ${item.id} (${item.name}) - ${item.missing} files`);
    }
    console.log(`Missing media files: ${summary.mediaMissing}`);
    if (dbReport.status === 'ok') {
      console.log(
        `DB: ${dbReport.stageCount} stages, missingInDb=${dbReport.missingInDb?.length ?? 0}, extraInDb=${dbReport.extraInDb?.length ?? 0}, sceneMismatch=${dbReport.sceneCountMismatch?.length ?? 0}`,
      );
      for (const row of dbReport.sceneCountMismatch?.slice(0, 10) ?? []) {
        console.log(`  scene mismatch: ${row.id} file=${row.file} db=${row.db}`);
      }
      console.log(
        `DB ownership: ${dbReport.ownerBound ?? 0}/${summary.classrooms} bound` +
          (dbReport.missingOwner?.length
            ? ` (missing stage_meta: ${dbReport.missingOwner.length})`
            : ''),
      );
      console.log(
        `DSL versions: ${
          (dbReport.dslVersions ?? []).map((row) => `${row.version}:${row.count}`).join(', ') ||
          '(none)'
        } (expected ${DSL_VERSION})`,
      );
      if (dbReport.conflictingTriggers?.length) {
        console.log(`Conflicting triggers: ${dbReport.conflictingTriggers.join(', ')}`);
      }
    } else {
      console.log(`DB: ${dbReport.status}${dbReport.error ? ` (${dbReport.error})` : ''}`);
    }
    if (args.verbose || args.classroom) {
      for (const result of results) {
        const media = result.mediaMissing.length
          ? ` mediaMissing=${result.mediaMissing.length}`
          : '';
        console.log(
          `${result.id} (${result.name}): scenes=${result.scenes} ttsMissing=${result.ttsMissing}${media}`,
        );
        for (const error of [...result.stageErrors, ...result.sceneErrors].slice(0, 5)) {
          console.log(`  error: ${error}`);
        }
        for (const missing of result.mediaMissing.slice(0, 5)) {
          console.log(`  missing media: ${missing}`);
        }
      }
    }
    console.log(`Warnings: ${warnings}`);
    console.log(
      failures === 0
        ? warnings === 0
          ? 'RESULT: PASS'
          : `RESULT: PASS (${warnings} warnings)`
        : `RESULT: FAIL (${failures} failures)`,
    );
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
