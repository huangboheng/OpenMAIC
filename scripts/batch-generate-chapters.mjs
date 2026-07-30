/**
 * 批量章节课堂生成（支持并行 worker）
 *
 * 使用方式：
 *   node scripts/batch-generate-chapters.mjs --all              # 串行（默认1 worker）
 *   node scripts/batch-generate-chapters.mjs --all --workers=3  # 3 workers 并行
 *   node scripts/batch-generate-chapters.mjs --slug=xxx         # 单课程
 *   node scripts/batch-generate-chapters.mjs --all --dry-run    # 预览
 *
 * Master-Worker 架构：
 *   Master 查询 DB 获取所有缺失章节 → round-robin 分配到 N 个 bucket
 *   → spawn N 个子进程各自处理 → 汇总结果
 *
 * 共享进度文件：batch-generate-progress.json（原子写入，防重复生成）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { createRequire } from "module";
import { spawn } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 依赖解析 ──
const PHILOCHORA_ROOT = process.env.PHILOCHORA_ROOT || "E:/hermes/workspace/Philochora";
const require = createRequire(join(PHILOCHORA_ROOT, "package.json"));
const pg = require("pg");

// ── RAG 语料注入（防幻觉 Phase 2）──
const RAG_MODULE_URL = "file:///" + join(PHILOCHORA_ROOT, "scripts/lib/rag-context.mjs").replace(/\\/g, "/");
let fetchRagContext = null;
try {
  const ragMod = await import(RAG_MODULE_URL);
  fetchRagContext = ragMod.fetchRagContext;
  console.log("[RAG] 典籍语料注入模块已加载");
} catch (e) {
  console.log(`[RAG] 模块加载失败 (${e.message})，将跳过语料注入`);
}

// ── RAG 注入辅助函数 ──
async function injectRagContext(prompt) {
  if (!fetchRagContext) return prompt;
  try {
    const ctx = await fetchRagContext(prompt, DATABASE_URL);
    if (ctx) {
      console.log(`    [RAG] 注入 ${ctx.length} 字符受控语料`);
      return `${prompt}\n\n${ctx}`;
    }
  } catch (e) {
    console.log(`    [RAG] 检索失败: ${e.message}`);
  }
  return prompt;
}

// ── 加载环境变量 ──
function loadEnv() {
  for (const p of [join(PHILOCHORA_ROOT, ".env"), join(PHILOCHORA_ROOT, ".env.local")]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 1) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (val && !process.env[key]) process.env[key] = val;
    }
  }
}
loadEnv();

// ── CLI 参数 ──
const DRY_RUN = process.argv.includes("--dry-run");
const RUN_ALL = process.argv.includes("--all");
const NO_RAG = process.argv.includes("--no-rag");
const slugArg = process.argv.find((a) => a.startsWith("--slug="));
const TARGET_SLUG = slugArg ? slugArg.slice("--slug=".length) : "chinese-philosophy";
const workersArg = process.argv.find((a) => a.startsWith("--workers="));
const NUM_WORKERS = parseInt(workersArg ? workersArg.slice("--workers=".length) : "0", 10) || 0;
const workerIdArg = process.argv.find((a) => a.startsWith("--worker="));
const WORKER_ID = workerIdArg ? parseInt(workerIdArg.slice("--worker=".length), 10) : -1;

// ── 环境变量 ──
const OPENMAIC_BASE = process.env.OPENMAIC_BASE_URL || "http://localhost:3010/openmaic";
const SERVICE_API_KEY = process.env.OPENMAIC_SERVICE_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
if (!SERVICE_API_KEY) { console.error("Missing OPENMAIC_SERVICE_API_KEY"); process.exit(1); }
if (!DATABASE_URL) { console.error("Missing DATABASE_URL"); process.exit(1); }

// ── 常量 ──
const POLL_INTERVAL_MS = 8000;
const CHAPTER_GAP_MS = 15000;
const MAX_POLL_TIME_MS = 45 * 60 * 1000;
const MAX_RETRIES = 3;
const STOP_HOUR = parseInt(process.env.STOP_HOUR || "9", 10);

// ── 进度文件 ──
const PROGRESS_FILE = join(__dirname, "batch-generate-progress.json");

function ensureDir(filePath) {
  const d = dirname(filePath);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function loadProgress() {
  try { if (existsSync(PROGRESS_FILE)) return JSON.parse(readFileSync(PROGRESS_FILE, "utf8")); } catch {}
  return { completed: {} };
}

function saveProgress(p) {
  ensureDir(PROGRESS_FILE);
  const tmp = PROGRESS_FILE + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify(p, null, 2), "utf8");
  renameSync(tmp, PROGRESS_FILE);
}

// ── 高峰控制 ──
function shouldStop() {
  const hour = new Date().getHours();
  return hour >= STOP_HOUR && hour < 18;
}

// ── 课程 prompts ──
const COURSE_PROMPTS = {
  "philosophy-101": "哲学入门课程。AI驱动多Agent互动课堂，建立东西方哲学根基。覆盖苏格拉底、柏拉图、亚里士多德、孔子、老子、康德、黑格尔、尼采。",
  "socratic-workplace": "职场批判思维训练课程。用苏格拉底式提问解决真实职场困境：识别逻辑谬误、优雅反驳、有力质疑、区分事实与观点。包含案例分析和角色扮演。",
  "existential-self-help": "存在主义哲学课程，帮助应对意义危机、焦虑与选择恐惧。涵盖萨特、加缪、海德格尔、克尔凯郭尔。包含思想实验和个人反思。",
  "masterworks-reading": "哲学原著精读课程。逐句精读《理想国》《道德经》《纯粹理性批判》。AI作为博学书友辅助解读。请逐段引用原文并给出白话翻译和哲学史背景。",
  "debate-academy": "结构化辩论训练课程。从逻辑基本功到竞技辩论：论证结构分析、谬误识别、反驳技巧、立论策略。包含AI辩论教练指导和裁判评分。",
  "little-philosophers": "儿童哲学启蒙课程（P4C方法论）。通过故事和对话培养批判思维与同理心。语言温暖、有趣、不说教。",
  "writing-workshop": "哲学学术写作训练课程。从精读到独立论证文：提炼论点、组织论证结构、回应反例、避免循环论证。包含五维批改和即时反馈。",
  "philosophy-plus": "跨学科思维训练课程。用哲学工具分析科学、技术、艺术、商业问题。包含多视角辩论和真实案例分析。",
  "chinese-philosophy": "中国哲学系统课程。涵盖儒家（孔子、孟子、荀子）、道家（老子、庄子）、佛家（禅宗）核心思想。包含与AI孔子论仁、与AI庄子逍遥游等互动环节。请大量引用原文并给出今译。",
  "grad-exam-cram": "考研哲学备考课程。通过苏格拉底式追问加深理解马哲基本原理、中国哲学史、西方哲学史。包含智能出题和AI批改。",
  "ethics-lab": "伦理学推理训练课程。通过思想实验探索道德直觉：电车难题、无知之幕、义务论、美德伦理。包含追问引擎和推理树可视化。",
  "east-west-dialogue": "东西方哲学跨文化对话课程。孔子和苏格拉底对话、庄子和尼采辩论、禅宗和存在主义相遇。比较不同文明对同一问题的回答。请引用双方原典。",
  "daily-philosophy": "生活哲学实践课程，21天建立个人精神操作系统。涵盖斯多葛晨间仪式、伊壁鸠鲁快乐计算、道家无为、存在主义选择、亚里士多德习惯论、禅宗正念。每章含实践任务和反思日志。语言温暖、实操。",
  "ai-ethics": "AI伦理与科技哲学课程，从电车难题到算法正义。涵盖技术中立论、自动驾驶伦理、算法偏见、数据隐私、大模型责任、AI意识、技术异化、AI治理。包含AI辩论和案例分析工作坊。",
  "philosophy-business": "哲学与商业决策课程，用2500年智慧做商业决策。涵盖目的论、利益相关者、长期主义、谈判修辞、企业社会责任、创新思维、组织正义、领导力德性。包含AI双顾问辩论。",
  "aesthetics-philosophy": "美学与艺术哲学课程，从康德到AI艺术的审美判断力训练。涵盖美是什么、康德审美判断、尼采悲剧美学、中国美学、数字时代美学。包含AI哲学家审美对话。",
  "political-philosophy": "政治哲学与公共议题课程。涵盖社会契约论、罗尔斯正义论、自由至上主义、社群主义、公民不服从、全球正义、数字权力。包含圆桌讨论和立场光谱测试。",
  "philosophy-of-science": "科学哲学课程，从证伪主义到范式革命。涵盖科学划界、逻辑实证主义、波普尔证伪、库恩范式、科学实在论、科学争议案例。包含伪科学识别训练。",
  "philosophy-therapy": "哲学与心理治疗课程，从存在主义到意义疗法。涵盖弗兰克尔意义疗法、亚隆存在主义治疗、斯多葛与CBT、克尔凯郭尔焦虑、正念禅宗、哲学咨询。包含AI哲学咨询对话。",
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── OpenMAIC API ──
async function submitGeneration(prompt, retries = MAX_RETRIES) {
  const res = await fetch(`${OPENMAIC_BASE}/api/generate-classroom`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-openmaic-api-key": SERVICE_API_KEY },
    body: JSON.stringify({ requirement: prompt, enableWebSearch: false, enableImageGeneration: true, enableTTS: true, agentMode: "generate" }),
  });
  if (res.status === 429 && retries > 0) {
    console.log(`\n    429 limit, retry in 60s (${retries} left)...`);
    await sleep(60000);
    return submitGeneration(prompt, retries - 1);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Generation failed ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.data ?? json;
}

async function pollUntilDone(jobId) {
  const start = Date.now();
  while (Date.now() - start < MAX_POLL_TIME_MS) {
    const res = await fetch(`${OPENMAIC_BASE}/api/generate-classroom/${jobId}`, {
      headers: { "x-openmaic-api-key": SERVICE_API_KEY },
    });
    if (res.status === 429) { await sleep(15000); continue; }
    if (!res.ok) throw new Error(`Poll failed ${res.status}`);
    const json = await res.json();
    const data = json.data ?? json;
    const pgLabel = data.totalScenes > 0 ? `${data.scenesGenerated}/${data.totalScenes} scenes` : "preparing";
    process.stdout.write(`\r    [${data.status}] ${pgLabel} | ${data.progress || 0}%   `);
    if (data.status === "failed") throw new Error(`Generation failed: ${data.error || "unknown"}`);
    if (data.done || data.status === "succeeded") {
      console.log("\n    OK");
      return data;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("Generation timeout (45 min)");
}

function buildChapterPrompt(basePrompt, chapter) {
  return `${basePrompt}

Chapter ${chapter.chapter_number}: ${chapter.title}
${chapter.description ?? ""}

Generate focused classroom content for this chapter. Requirements:
- Stay focused on this chapter topic, do not repeat other chapters
- Multi-Agent interactive teaching (teacher + students + AI philosopher dialogue)
- Include relevant original text citations and thought experiments
- Language: Chinese instruction, academic but accessible`;
}

// ═══════════════════════════════════════════════════════════
// Worker mode
// ═══════════════════════════════════════════════════════════

async function runWorker(tasksFile) {
  const tasks = JSON.parse(readFileSync(tasksFile, "utf8"));
  console.log(`[Worker ${WORKER_ID}] ${tasks.length} chapters assigned\n`);

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    let ok = 0, fail = 0;
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];

      if (shouldStop()) {
        console.log(`\n[Worker ${WORKER_ID}] Peak hour ${STOP_HOUR}:00, stopping. Done ${ok}/${i}.`);
        break;
      }

      const progress = loadProgress();
      const progressKey = `${t.slug}:${t.chapter_number}`;
      if (progress.completed[progressKey]) {
        console.log(`[Worker ${WORKER_ID}] [skip] ${t.slug} ch${t.chapter_number} (done: ${progress.completed[progressKey]})`);
        ok++;
        continue;
      }

      const courseRow = await client.query("SELECT id, title, generation_prompt FROM courses WHERE slug=$1", [t.slug]);
      if (courseRow.rows.length === 0) { fail++; continue; }
      const course = courseRow.rows[0];
      const basePrompt = COURSE_PROMPTS[t.slug] || course.generation_prompt || `${course.title} - AI classroom`;
      let chapterPrompt = buildChapterPrompt(basePrompt, t);

      // RAG 语料注入
      if (!NO_RAG) chapterPrompt = await injectRagContext(chapterPrompt);

      console.log(`\n[Worker ${WORKER_ID}] [${i + 1}/${tasks.length}] ${t.slug} ch${t.chapter_number}: ${t.title}`);

      try {
        const { jobId } = await submitGeneration(chapterPrompt);
        console.log(`    JobId: ${jobId}`);
        const result = await pollUntilDone(jobId);
        const classroomId = result.result?.classroomId || result.result?.id;
        const totalScenes = result.totalScenes || result.result?.scenesCount || 0;
        if (!classroomId) throw new Error("No classroomId");

        await client.query("UPDATE course_chapters SET classroom_id=$1 WHERE id=$2", [classroomId, t.id]);
        const promptHash = createHash("sha256").update(chapterPrompt).digest("hex").slice(0, 16);
        await client.query(
          "INSERT INTO course_generation_logs (course_slug, prompt_hash, prompt_text, rag_context_chars, model, openmaic_job_id, classroom_id) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [t.slug, promptHash, chapterPrompt, 0, "openmaic", jobId, classroomId]
        );

        console.log(`    -> ${classroomId} (${totalScenes} scenes)`);

        const p = loadProgress();
        p.completed[progressKey] = classroomId;
        saveProgress(p);
        ok++;

        if (i < tasks.length - 1) await sleep(CHAPTER_GAP_MS);
      } catch (err) {
        console.error(`\n[Worker ${WORKER_ID}] FAIL: ${err.message}`);
        fail++;
      }
    }
    return { ok, fail };
  } finally {
    await client.end();
  }
}

// ═══════════════════════════════════════════════════════════
// Master mode
// ═══════════════════════════════════════════════════════════

async function runMaster() {
  console.log("=".repeat(60));
  console.log(`  Chapter generation (all courses)`);
  console.log(`  Workers: ${NUM_WORKERS} | OpenMAIC: ${OPENMAIC_BASE}`);
  console.log(`  Mode: ${DRY_RUN ? "DRY-RUN" : "LIVE"} | Peak stop: ${STOP_HOUR}:00-18:00`);
  console.log("=".repeat(60) + "\n");

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    const health = await fetch(`${OPENMAIC_BASE}/api/health`, {
      headers: { "x-openmaic-api-key": SERVICE_API_KEY },
    });
    const h = await health.json();
    console.log(`OpenMAIC v${h.version} | TTS:${h.capabilities?.tts} | IMG:${h.capabilities?.imageGeneration}\n`);

    const targetSlugs = (await client.query(
      "SELECT DISTINCT c.slug, c.sort_order, c.id FROM courses c JOIN course_chapters cc ON cc.course_id=c.id WHERE cc.classroom_id IS NULL OR cc.classroom_id='' ORDER BY c.sort_order, c.id"
    )).rows.map(r => r.slug);

    console.log(`Courses with missing chapters: ${targetSlugs.length}\n`);

    const allTasks = [];
    for (const slug of targetSlugs) {
      const courseRow = await client.query("SELECT id, title FROM courses WHERE slug=$1", [slug]);
      if (courseRow.rows.length === 0) continue;
      const course = courseRow.rows[0];
      const chaps = await client.query(
        "SELECT id, chapter_number, title, description FROM course_chapters WHERE course_id=$1 AND (classroom_id IS NULL OR classroom_id='') ORDER BY chapter_number",
        [course.id]
      );
      for (const ch of chaps.rows) {
        allTasks.push({ slug, course_title: course.title, id: ch.id, chapter_number: ch.chapter_number, title: ch.title, description: ch.description });
      }
    }

    console.log(`Total chapters: ${allTasks.length}\n`);

    if (DRY_RUN) {
      let cur = "";
      for (const t of allTasks) {
        if (t.slug !== cur) { cur = t.slug; console.log(`  ${t.slug} (${t.course_title}):`); }
        console.log(`    ch${t.chapter_number}: ${t.title}`);
      }
      console.log(`\n[DRY-RUN] ${NUM_WORKERS} workers ready.`);
      return;
    }

    // Round-robin assign
    const buckets = Array.from({ length: NUM_WORKERS }, () => []);
    allTasks.forEach((t, i) => buckets[i % NUM_WORKERS].push(t));
    console.log("Assignment:");
    buckets.forEach((b, i) => console.log(`  Worker ${i}: ${b.length} chapters`));
    console.log("");

    // Write task files
    const taskFiles = [];
    for (let i = 0; i < NUM_WORKERS; i++) {
      const tf = PROGRESS_FILE + `.tasks.worker-${i}.json`;
      ensureDir(tf);
      writeFileSync(tf, JSON.stringify(buckets[i], null, 2), "utf8");
      taskFiles.push(tf);
    }

    const scriptPath = fileURLToPath(import.meta.url);
    const children = [];
    for (let i = 0; i < NUM_WORKERS; i++) {
      const child = spawn("node", [scriptPath, `--worker=${i}`, `--task-file=${taskFiles[i]}`], {
        stdio: "inherit",
        env: { ...process.env },
      });
      children.push(child);
      console.log(`Worker ${i} started (PID ${child.pid})`);
    }

    const exitCodes = await Promise.all(children.map(c => new Promise(resolve => c.on("close", resolve))));
    console.log(`\nAll workers done: ${exitCodes.join(", ")}`);

    for (const tf of taskFiles) { try { unlinkSync(tf); } catch {} }
  } finally {
    await client.end();
  }
}

// ═══════════════════════════════════════════════════════════
// Serial mode (backward compatible)
// ═══════════════════════════════════════════════════════════

async function runSerial() {
  console.log("=".repeat(60));
  console.log(`  Chapter generation${RUN_ALL ? " (all courses)" : ""}`);
  console.log(`  Target: ${RUN_ALL ? "all missing" : TARGET_SLUG}`);
  console.log(`  OpenMAIC: ${OPENMAIC_BASE} | Mode: ${DRY_RUN ? "DRY-RUN" : "LIVE"}`);
  console.log(`  Peak stop: ${STOP_HOUR}:00-18:00`);
  console.log("=".repeat(60) + "\n");

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  const progress = loadProgress();

  try {
    const health = await fetch(`${OPENMAIC_BASE}/api/health`, { headers: { "x-openmaic-api-key": SERVICE_API_KEY } });
    const h = await health.json();
    console.log(`OpenMAIC v${h.version} | TTS:${h.capabilities?.tts} | IMG:${h.capabilities?.imageGeneration}\n`);

    let targetSlugs;
    if (RUN_ALL) {
      targetSlugs = (await client.query(
        "SELECT DISTINCT c.slug, c.sort_order, c.id FROM courses c JOIN course_chapters cc ON cc.course_id=c.id WHERE cc.classroom_id IS NULL OR cc.classroom_id='' ORDER BY c.sort_order, c.id"
      )).rows.map(r => r.slug);
      if (targetSlugs.length > 0) console.log(`${targetSlugs.length} courses with missing chapters: ${targetSlugs.join(", ")}\n`);
    } else {
      targetSlugs = [TARGET_SLUG];
    }

    let globalOk = 0, globalFail = 0;
    for (const slug of targetSlugs) {
      const courseRow = await client.query("SELECT id, title, generation_prompt FROM courses WHERE slug=$1", [slug]);
      if (courseRow.rows.length === 0) { console.log(`[skip] ${slug} not in DB`); continue; }
      const course = courseRow.rows[0];
      const basePrompt = COURSE_PROMPTS[slug] || course.generation_prompt || `${course.title} - AI classroom`;

      const chapRows = await client.query(
        "SELECT id, chapter_number, title, description FROM course_chapters WHERE course_id=$1 AND (classroom_id IS NULL OR classroom_id='') ORDER BY chapter_number",
        [course.id]
      );
      if (chapRows.rows.length === 0) { console.log(`[done] ${slug}`); continue; }

      console.log(`\n${"=".repeat(50)}`);
      console.log(`  ${slug} (${course.title}) - ${chapRows.rows.length} chapters`);
      console.log(`${"=".repeat(50)}`);

      if (DRY_RUN) {
        for (const ch of chapRows.rows) console.log(`  ch${ch.chapter_number}: ${ch.title}`);
        continue;
      }

      for (let i = 0; i < chapRows.rows.length; i++) {
        const ch = chapRows.rows[i];
        const progressKey = `${slug}:${ch.chapter_number}`;
        if (progress.completed[progressKey]) { console.log(`  [skip] ch${ch.chapter_number} ${ch.title} (done: ${progress.completed[progressKey]})`); globalOk++; continue; }

        if (shouldStop()) {
          console.log(`\nPeak hour ${STOP_HOUR}:00, stopping. Done ${globalOk}, ${globalFail} failed. Resume: --all`);
          return;
        }

        console.log(`\n  [${i + 1}/${chapRows.rows.length}] ch${ch.chapter_number}: ${ch.title}`);
        let chapterPrompt = buildChapterPrompt(basePrompt, ch);

        // RAG 语料注入
        if (!NO_RAG) chapterPrompt = await injectRagContext(chapterPrompt);

        try {
          const { jobId } = await submitGeneration(chapterPrompt);
          console.log(`    JobId: ${jobId}`);
          const result = await pollUntilDone(jobId);
          const classroomId = result.result?.classroomId || result.result?.id;
          const totalScenes = result.totalScenes || result.result?.scenesCount || 0;
          if (!classroomId) throw new Error("No classroomId");

          await client.query("UPDATE course_chapters SET classroom_id=$1 WHERE id=$2", [classroomId, ch.id]);
          const promptHash = createHash("sha256").update(chapterPrompt).digest("hex").slice(0, 16);
          await client.query(
            "INSERT INTO course_generation_logs (course_slug, prompt_hash, prompt_text, rag_context_chars, model, openmaic_job_id, classroom_id) VALUES ($1,$2,$3,$4,$5,$6,$7)",
            [slug, promptHash, chapterPrompt, 0, "openmaic", jobId, classroomId]
          );

          console.log(`    -> ${classroomId} (${totalScenes} scenes)`);
          progress.completed[progressKey] = classroomId;
          saveProgress(progress);
          globalOk++;

          if (i < chapRows.rows.length - 1) { console.log(`    wait ${CHAPTER_GAP_MS / 1000}s...`); await sleep(CHAPTER_GAP_MS); }
        } catch (err) {
          console.error(`\n    FAIL: ${err.message}`);
          globalFail++;
        }
      }
    }

    console.log("\n\n" + "=".repeat(60));
    console.log(`  Total: ok ${globalOk} | fail ${globalFail}`);
    if (DRY_RUN) console.log("  (DRY-RUN)");
    console.log("=".repeat(60) + "\n");
  } finally {
    await client.end();
  }
}

// ═══════════════════════════════════════════════════════════
// Entry
// ═══════════════════════════════════════════════════════════

const taskFileArg = process.argv.find((a) => a.startsWith("--task-file="));
if (WORKER_ID >= 0 && taskFileArg) {
  const taskFile = taskFileArg.slice("--task-file=".length);
  runWorker(taskFile).then(({ ok, fail }) => {
    console.log(`\n[Worker ${WORKER_ID}] Done: ok ${ok} | fail ${fail}`);
    process.exit(fail > 0 ? 1 : 0);
  }).catch((err) => { console.error(`[Worker ${WORKER_ID}] Fatal:`, err); process.exit(1); });
} else if (RUN_ALL && NUM_WORKERS > 1) {
  runMaster().then(() => console.log("\nAll workers completed.")).catch((err) => { console.error("Master fatal:", err); process.exit(1); });
} else {
  runSerial().catch((err) => { console.error("Fatal:", err); process.exit(1); });
}
