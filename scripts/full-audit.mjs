/**
 * 课程章节全面审计脚本
 * Usage: node scripts/full-audit.mjs
 * Auto-destroys after completion.
 */
import { createRequire } from "module";
import { readdirSync, existsSync, readFileSync, statSync } from "fs";
import path from "path";
import { getDatabaseUrl } from "./lib/db-url.mjs";

const require = createRequire("E:/hermes/workspace/Philochora/package.json");
const pg = require("pg");
const DB_URL = getDatabaseUrl("postgresql://postgres:882ab5346d3d5a8a15aba2d723aade19@localhost:5999/philochora");
const DATA_ROOT = "E:/hermes/workspace/openmaic/data";
const JOBS_DIR = path.join(DATA_ROOT, "classroom-jobs");
const CLASSROOMS_DIR = path.join(DATA_ROOT, "classrooms");
const PROGRESS_FILE = "E:/hermes/workspace/openmaic/scripts/batch-generate-progress.json";

const sep = "=".repeat(70);
const c = new pg.Client({ connectionString: DB_URL });
await c.connect();

console.log(sep);
console.log("  课程章节全面审计报告 — " + new Date().toLocaleString("zh-CN"));
console.log(sep);

// ========== 维度 1：完整性核查 ==========
console.log("\n[维度1] 完整性核查 — 19门课程章节生成状态");
console.log("-".repeat(70));

const ch = await c.query(
  "SELECT c.slug, c.title, c.sort_order, " +
  "COUNT(*) FILTER (WHERE cc.classroom_id IS NOT NULL AND cc.classroom_id != '') AS done, " +
  "COUNT(*) AS chapter_count " +
  "FROM course_chapters cc JOIN courses c ON cc.course_id=c.id " +
  "GROUP BY c.slug, c.sort_order, c.title ORDER BY c.sort_order"
);

let totalDone = 0, totalAll = 0;
const courseStats = [];
console.log("  课程名                        | 完成 | 总数 | 状态");
console.log("  ------------------------------|------|------|--------");
for (const r of ch.rows) {
  const done = parseInt(r.done), total = parseInt(r.chapter_count);
  totalDone += done; totalAll += total;
  const status = done === total ? "已完成" : done > 0 ? "进行中" : "未开始";
  const name = r.title.length > 28 ? r.title.slice(0, 27) + "…" : r.title;
  console.log(`  ${name.padEnd(28)} | ${String(done).padStart(4)} | ${String(total).padStart(4)} | ${status}`);
  courseStats.push({ slug: r.slug, title: r.title, done, total, status });
}
console.log(`\n  总计: ${totalDone}/${totalAll} (${Math.round(totalDone/totalAll*100)}%)`);
console.log(`  已完成课程: ${courseStats.filter(c=>c.status==="已完成").length}`);
console.log(`  进行中课程: ${courseStats.filter(c=>c.status==="进行中").length}`);
console.log(`  未开始课程: ${courseStats.filter(c=>c.status==="未开始").length}`);

// ========== 维度 2：课堂数据验证 ==========
console.log("\n[维度2] 课堂数据验证 — 课堂JSON文件完整性");
console.log("-".repeat(70));

// Get all classroom_ids from DB
const classroomIds = await c.query(
  "SELECT classroom_id FROM course_chapters WHERE classroom_id IS NOT NULL AND classroom_id != ''"
);
const ids = classroomIds.rows.map(r => r.classroom_id);
console.log(`  DB中有效 classroom_id: ${ids.length} 个`);

let missingFiles = [], invalidStructure = [], validCount = 0;
const jobFiles = readdirSync(JOBS_DIR).filter(f => f.endsWith(".json"));
console.log(`  classroom-jobs/ 文件数: ${jobFiles.length}`);

for (const id of ids) {
  const filePath = path.join(CLASSROOMS_DIR, id + ".json");
  if (!existsSync(filePath)) {
    missingFiles.push(id);
    continue;
  }
  try {
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    const hasId = !!data.id;
    const hasStage = !!data.stage;
    const hasScenes = Array.isArray(data.scenes) && data.scenes.length > 0;
    const hasActions = hasScenes && Array.isArray(data.scenes[0].actions) && data.scenes[0].actions.length > 0;
    if (!hasId || !hasStage || !hasScenes || !hasActions) {
      invalidStructure.push({ id, hasId, hasStage, hasScenes, hasActions });
    } else {
      validCount++;
    }
  } catch (e) {
    invalidStructure.push({ id, error: e.message });
  }
}

// Check job status for ALL job files (not just matching classroom_ids)
let jobCompleted = 0, jobFailed = 0, jobOther = 0;
const failedJobs = [];
for (const f of jobFiles) {
  try {
    const job = JSON.parse(readFileSync(path.join(JOBS_DIR, f), "utf8"));
    if (job.status === "completed") jobCompleted++;
    else if (job.status === "failed") { jobFailed++; failedJobs.push({ id: f, error: job.error || "unknown" }); }
    else jobOther++;
  } catch (e) { /* ignore */ }
}

console.log(`\n  课堂JSON文件验证:`);
console.log(`    结构完整: ${validCount}`);
console.log(`    文件缺失: ${missingFiles.length}${missingFiles.length > 0 ? " → " + missingFiles.slice(0, 5).join(", ") : ""}`);
console.log(`    结构不完整: ${invalidStructure.length}${invalidStructure.length > 0 ? " → " + invalidStructure.slice(0, 5).map(x => x.id).join(", ") : ""}`);
console.log(`\n  对应 Job 状态:`);
console.log(`    completed: ${jobCompleted}`);
console.log(`    failed: ${jobFailed}`);
console.log(`    other: ${jobOther}`);

// ========== 维度 3：TTS 音频验证 ==========
console.log("\n[维度3] TTS 音频验证 — 抽样检查");
console.log("-".repeat(70));

// Sample up to 10 completed classrooms
const sampleIds = ids.slice(0, 10);
let ttsIssues = [];
let ttsOk = 0;

for (const id of sampleIds) {
  const audioDir = path.join(CLASSROOMS_DIR, id, "audio");
  const classroomFile = path.join(CLASSROOMS_DIR, id + ".json");
  if (!existsSync(classroomFile)) continue;

  try {
    const data = JSON.parse(readFileSync(classroomFile, "utf8"));
    // Count audioUrl references
    const jsonStr = JSON.stringify(data);
    const audioRefs = (jsonStr.match(/"audioUrl":\s*"[^"]+"/g) || []);
    const expectedCount = audioRefs.length;

    let actualCount = 0, emptyCount = 0;
    if (existsSync(audioDir)) {
      const mp3Files = readdirSync(audioDir).filter(f => f.endsWith(".mp3"));
      actualCount = mp3Files.length;
      // Check for empty files
      for (const f of mp3Files) {
        const stat = statSync(path.join(audioDir, f));
        if (stat.size === 0) emptyCount++;
      }
    }

    if (actualCount === 0 && expectedCount > 0) {
      ttsIssues.push({ id, expected: expectedCount, actual: 0, empty: 0, issue: "无音频目录或文件" });
    } else if (emptyCount > 0) {
      ttsIssues.push({ id, expected: expectedCount, actual: actualCount, empty: emptyCount, issue: "有空文件" });
    } else {
      ttsOk++;
    }
  } catch (e) {
    ttsIssues.push({ id, issue: e.message });
  }
}

console.log(`  抽样 ${sampleIds.length} 个课堂:`);
console.log(`    音频正常: ${ttsOk}`);
console.log(`    存在问题: ${ttsIssues.length}`);
for (const issue of ttsIssues) {
  console.log(`      ${issue.id}: ${issue.issue} (预期${issue.expected || "?"}个, 实际${issue.actual || 0}个)`);
}

// ========== 维度 4：RAG 内容注入检查 ==========
console.log("\n[维度4] RAG 内容注入检查 — 抽样验证");
console.log("-".repeat(70));

// Get 5 completed chapters with their course info
const ragSample = await c.query(
  "SELECT cc.id, cc.classroom_id, c.title as course_title, c.slug as course_slug " +
  "FROM course_chapters cc JOIN courses c ON cc.course_id=c.id " +
  "WHERE cc.classroom_id IS NOT NULL AND cc.classroom_id != '' " +
  "ORDER BY RANDOM() LIMIT 5"
);

let ragOk = 0, ragPlaceholder = 0, ragEmpty = 0;

// Check overall classics status first
const classicsOverall = await c.query(
  "SELECT COUNT(*) AS total, " +
  "COUNT(*) FILTER (WHERE LENGTH(content_en) > 150) AS real_content, " +
  "COUNT(*) FILTER (WHERE content_en LIKE '%[Pending import]%') AS pending, " +
  "COUNT(*) FILTER (WHERE content_en LIKE '%[RAG Reference]%') AS rag_ref " +
  "FROM classics_paragraphs"
);
const co = classicsOverall.rows[0];

// Check each sampled course's associated classics
for (const row of ragSample.rows) {
  // Find books that might be associated with this course by checking generation input
  const classroomFile = path.join(CLASSROOMS_DIR, row.classroom_id + ".json");
  let hasClassicsRef = false;
  if (existsSync(classroomFile)) {
    try {
      const data = readFileSync(classroomFile, "utf8");
      // Check if classroom content references any classics terms
      hasClassicsRef = data.includes("典籍") || data.includes("原文") || data.includes("修辞学") || data.includes("苏格拉底") || data.includes("柏拉图") || data.includes("亚里士多德");
    } catch (e) { /* ignore */ }
  }

  if (hasClassicsRef) ragOk++;
  console.log(`  课程: ${row.course_title} (ch ${row.classroom_id})`);
  console.log(`    典籍引用痕迹: ${hasClassicsRef ? "有" : "未检测到"}`);
}

console.log(`\n  典籍库总体:`);
console.log(`    总段落: ${co.total}, 真实内容(>150字): ${co.real_content}, 占位符: ${co.pending}, RAG标记: ${co.rag_ref}`);
console.log(`    注入状态: 典籍库已有 ${parseInt(co.real_content).toLocaleString()} 段真实内容可供 RAG 注入`);

// ========== 维度 5：错误与异常汇总 ==========
console.log("\n[维度5] 错误与异常汇总");
console.log("-".repeat(70));

let statusCounts = { completed: 0, failed: 0, processing: 0, other: 0 };
let errorCategories = { EPERM: 0, timeout: 0, api_error: 0, other: 0 };
const errorDetails = [];

for (const f of jobFiles) {
  try {
    const job = JSON.parse(readFileSync(path.join(JOBS_DIR, f), "utf8"));
    if (job.status === "completed") statusCounts.completed++;
    else if (job.status === "failed") {
      statusCounts.failed++;
      const err = job.error || "";
      if (err.includes("EPERM")) errorCategories.EPERM++;
      else if (err.includes("timeout") || err.includes("ETIMEDOUT")) errorCategories.timeout++;
      else if (err.includes("API") || err.includes("500") || err.includes("502") || err.includes("503")) errorCategories.api_error++;
      else errorCategories.other++;
      if (job.status === "failed") errorDetails.push({ file: f, error: err.slice(0, 100) });
    }
    else if (job.status === "processing") statusCounts.processing++;
    else statusCounts.other++;
  } catch (e) { /* ignore */ }
}

// Check .tmp files
const tmpFiles = readdirSync(JOBS_DIR).filter(f => f.endsWith(".tmp"));

// Check progress file
let progressCount = 0;
if (existsSync(PROGRESS_FILE)) {
  const progress = JSON.parse(readFileSync(PROGRESS_FILE, "utf8"));
  progressCount = Object.keys(progress.completed || {}).length;
}

console.log(`  Job 文件统计 (共 ${jobFiles.length} 个):`);
console.log(`    completed: ${statusCounts.completed}`);
console.log(`    failed: ${statusCounts.failed}`);
console.log(`    processing: ${statusCounts.processing}`);
console.log(`    other: ${statusCounts.other}`);
console.log(`\n  失败原因分类:`);
console.log(`    EPERM (权限错误): ${errorCategories.EPERM}`);
console.log(`    API 超时: ${errorCategories.timeout}`);
console.log(`    API 错误: ${errorCategories.api_error}`);
console.log(`    其他: ${errorCategories.other}`);
console.log(`\n  .tmp 残留文件: ${tmpFiles.length}${tmpFiles.length > 0 ? " → " + tmpFiles.slice(0, 5).join(", ") : ""}`);
console.log(`  批次进度文件已完成条目: ${progressCount}`);

// Show some error samples
if (errorDetails.length > 0) {
  console.log(`\n  失败 Job 示例 (前5个):`);
  for (const e of errorDetails.slice(0, 5)) {
    console.log(`    ${e.file}: ${e.error}`);
  }
}

// ========== 维度 6：内容质量抽样 ==========
console.log("\n[维度6] 内容质量抽样 — 随机5个课堂");
console.log("-".repeat(70));

const qualitySample = await c.query(
  "SELECT cc.classroom_id, c.title as course_title, cc.sort_order as ch_num " +
  "FROM course_chapters cc JOIN courses c ON cc.course_id=c.id " +
  "WHERE cc.classroom_id IS NOT NULL AND cc.classroom_id != '' " +
  "ORDER BY RANDOM() LIMIT 5"
);

console.log("  课堂ID            | 课程              | 场景 | 动作 | 空白 | 乱码 | 重复");
console.log("  ------------------|-------------------|------|------|------|------|-----");

for (const row of qualitySample.rows) {
  const filePath = path.join(CLASSROOMS_DIR, row.classroom_id + ".json");
  if (!existsSync(filePath)) {
    console.log(`  ${row.classroom_id.padEnd(17)} | 文件缺失`);
    continue;
  }

  try {
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    const scenes = data.scenes || [];
    let totalActions = 0, blankCount = 0, garbageCount = 0, dupCount = 0;
    const allTexts = [];

    for (const scene of scenes) {
      const actions = scene.actions || [];
      totalActions += actions.length;
      for (const action of actions) {
        const content = (action.content || action.text || action.mentorScript || "").toString();
        if (content.trim().length === 0) blankCount++;
        // Check for garbled text (high ratio of non-CJK non-ASCII non-latin)
        const nonStandard = content.replace(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffefa-zA-Z0-9\s.,;:!?'"()\-\[\]{}\/\\@#$%^&*+=<>~`]/g, "");
        if (nonStandard.length > content.length * 0.3 && content.length > 50) garbageCount++;
        if (content.length > 100) allTexts.push(content.slice(0, 80));
      }
    }

    // Check for duplicates (adjacent identical)
    for (let i = 1; i < allTexts.length; i++) {
      if (allTexts[i] === allTexts[i - 1]) dupCount++;
    }

    const courseName = row.course_title.length > 17 ? row.course_title.slice(0, 16) + "…" : row.course_title;
    const blankMark = blankCount > 0 ? `${blankCount}!` : "OK";
    const garbageMark = garbageCount > 0 ? `${garbageCount}!` : "OK";
    const dupMark = dupCount > 0 ? `${dupCount}!` : "OK";

    console.log(`  ${row.classroom_id.padEnd(17)} | ${courseName.padEnd(17)} | ${String(scenes.length).padStart(4)} | ${String(totalActions).padStart(4)} | ${blankMark.padStart(4)} | ${garbageMark.padStart(4)} | ${dupMark.padStart(4)}`);
  } catch (e) {
    console.log(`  ${row.classroom_id.padEnd(17)} | 解析错误: ${e.message.slice(0, 30)}`);
  }
}

// ========== 汇总与修复建议 ==========
console.log("\n" + sep);
console.log("  修复建议 (按优先级排序)");
console.log(sep);

const issues = [];

if (missingFiles.length > 0) {
  issues.push({ priority: "P0", issue: `${missingFiles.length} 个课堂JSON文件缺失`, action: "重新生成缺失课堂或检查生成流程" });
}
if (errorCategories.EPERM > 0) {
  issues.push({ priority: "P0", issue: `${errorCategories.EPERM} 个EPERM权限错误`, action: "确认杀毒软件排除列表已包含 data/classroom-jobs/" });
}
if (tmpFiles.length > 0) {
  issues.push({ priority: "P0", issue: `${tmpFiles.length} 个.tmp残留文件`, action: "停止OpenMAIC后清理 .tmp 文件" });
}
if (statusCounts.failed > 0 && errorCategories.EPERM < statusCounts.failed) {
  issues.push({ priority: "P1", issue: `${statusCounts.failed - errorCategories.EPERM} 个非EPERM失败Job`, action: "检查API Key余额和网络连接，重试失败任务" });
}
if (ragPlaceholder > 0 || parseInt(co.pending) > 0) {
  issues.push({ priority: "P1", issue: `典籍库存在${co.pending}个占位符段落`, action: "重新运行 fetch-and-translate.mjs 补全典籍内容" });
}
if (ttsIssues.length > 0) {
  issues.push({ priority: "P1", issue: `${ttsIssues.length}/${sampleIds.length} 抽样课堂TTS音频异常`, action: "检查TTS生成日志，重新生成失败课堂的音频" });
}
const incompleteCourses = courseStats.filter(c => c.status !== "已完成");
if (incompleteCourses.length > 0) {
  issues.push({ priority: "P2", issue: `${incompleteCourses.length} 门课程尚未完成`, action: "继续运行 batch-generate-chapters.mjs --all --workers=6" });
}

for (const i of issues) {
  console.log(`  [${i.priority}] ${i.issue}`);
  console.log(`       → ${i.action}`);
}

if (issues.length === 0) {
  console.log("  无重大问题，所有检查通过！");
}

console.log("\n" + sep);
console.log("  审计完毕");
console.log(sep);

await c.end();
process.exit(0);
