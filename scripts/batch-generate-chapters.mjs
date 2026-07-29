/**
 * 批量为 chinese-philosophy 课程的 7 个缺失章节生成 OpenMAIC 课堂
 *
 * 使用方式：
 *   node scripts/batch-generate-chapters.mjs
 *   node scripts/batch-generate-chapters.mjs --slug=philosophy-101   # 指定其他课程
 *   node scripts/batch-generate-chapters.mjs --dry-run               # 仅打印待生成章节，不触发生成
 *
 * 环境变量（从 Philochora .env / .env.local 加载）：
 *   DATABASE_URL              - PostgreSQL 连接字符串（必需）
 *   OPENMAIC_BASE_URL         - OpenMAIC 地址（默认 http://localhost:3010/openmaic）
 *   OPENMAIC_SERVICE_API_KEY  - OpenMAIC 服务间 API Key（必需）
 *
 * 流程：
 *   1. 查询 course_chapters 中 classroom_id 为 NULL 的章节
 *   2. 对每个章节，拼接课程 prompt + 章节信息，调用 OpenMAIC 生成 API
 *   3. 轮询等待生成完成
 *   4. 将新 classroomId 写回 course_chapters.classroom_id
 *   5. 写入 course_generation_logs 审计记录
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 依赖解析（pg 来自 Philochora 项目） ──
const PHILOCHORA_ROOT = process.env.PHILOCHORA_ROOT || "E:/hermes/workspace/Philochora";
const require = createRequire(join(PHILOCHORA_ROOT, "package.json"));
const pg = require("pg");

// ── 加载 Philochora 环境变量 ──
function loadEnv() {
  const envPaths = [
    join(PHILOCHORA_ROOT, ".env"),
    join(PHILOCHORA_ROOT, ".env.local"),
  ];
  for (const p of envPaths) {
    if (!existsSync(p)) continue;
    const content = readFileSync(p, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // 去除引号
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (val && !process.env[key]) process.env[key] = val;
    }
  }
}
loadEnv();

// ── CLI 参数 ──
const DRY_RUN = process.argv.includes("--dry-run");
const RUN_ALL = process.argv.includes("--all");
const slugArg = process.argv.find((a) => a.startsWith("--slug="));
const TARGET_SLUG = slugArg ? slugArg.slice("--slug=".length) : "chinese-philosophy";

// ── 断点续传 progress 文件 ──
const PROGRESS_FILE = join(__dirname, "batch-generate-progress.json");
function loadProgress() {
  try { if (existsSync(PROGRESS_FILE)) return JSON.parse(readFileSync(PROGRESS_FILE, "utf8")); } catch {}
  return { completed: {} };
}
function saveProgress(p) { writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2), "utf8"); }

// ── 环境变量 ──
const OPENMAIC_BASE = process.env.OPENMAIC_BASE_URL || "http://localhost:3010/openmaic";
const SERVICE_API_KEY = process.env.OPENMAIC_SERVICE_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!SERVICE_API_KEY) {
  console.error("❌ 缺少 OPENMAIC_SERVICE_API_KEY（请在 Philochora .env.local 中配置）");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("❌ 缺少 DATABASE_URL（请在 Philochora .env.local 中配置）");
  process.exit(1);
}

// ── 常量 ──
const POLL_INTERVAL_MS = 8000;
const CHAPTER_GAP_MS = 15000;
const MAX_POLL_TIME_MS = 45 * 60 * 1000;
const MAX_RETRIES = 3;

// 全部 19 门课程的 prompt（来自 generate-courses.mjs）
const COURSE_PROMPTS = {
  "philosophy-101": `哲学入门课程——AI驱动多Agent互动课堂，建立东西方哲学根基。覆盖：苏格拉底的诘问法、柏拉图的理念论与洞穴寓言、亚里士多德的中道与目的论、孔子的仁义礼智、老子的道法自然、康德的三大批判、黑格尔的辩证法、尼采的权力意志与永恒轮回。`,
  "socratic-workplace": `职场批判思维训练课程。用苏格拉底式提问解决真实职场困境：如何识别逻辑谬误（稻草人、滑坡、诉诸权威等）、如何优雅反驳、如何在会议中提出有力质疑、如何区分事实与观点。包含多个职场案例分析和角色扮演讨论。请引用《申辩篇》中苏格拉底的诘问实例。`,
  "existential-self-help": `存在主义哲学课程，帮助应对当代意义危机、焦虑与选择恐惧。涵盖：萨特的存在先于本质（《存在与虚无》）、加缪的荒诞哲学（《西西弗神话》）、海德格尔的向死而生（《存在与时间》）、克尔凯郭尔的焦虑概念（《恐惧与颤栗》）。包含思想实验和个人反思环节。`,
  "masterworks-reading": `哲学原著精读课程。逐句精读《理想国》第一卷（正义之辩）、《道德经》前十一章（道可道非常道）、《纯粹理性批判》导论（先天综合判断）。从通读到深读再到贯通，AI作为博学书友辅助解读。请逐段引用原文并给出白话翻译和哲学史背景。`,
  "debate-academy": `结构化辩论训练课程。从逻辑基本功到竞技辩论：论证结构分析（前提-推理-结论）、常见谬误识别（24种非形式谬误）、反驳技巧（归谬法、类比反驳）、立论策略。包含AI辩论教练指导、陪练对练和裁判评分环节。请引用亚里士多德《修辞学》和《工具论》。`,
  "little-philosophers": `儿童哲学启蒙课程（P4C方法论）。通过故事和对话培养批判思维与同理心：什么是公平？为什么要有规则？如果所有人都说谎会怎样？动物有感情吗？用孩子能理解的语言和场景展开哲学探究。语言要温暖、有趣、不说教。`,
  "writing-workshop": `哲学学术写作训练课程。从精读到独立论证文：如何提炼论点（thesis statement）、如何组织论证结构（图尔敏模型）、如何回应反例（steelman策略）、如何避免循环论证。包含五维批改和即时反馈。`,
  "philosophy-plus": `跨学科思维训练课程。用哲学工具分析科学、技术、艺术、商业问题：AI伦理的哲学基础（功利主义vs义务论）、量子力学的认识论挑战、建筑设计中的现象学（海德格尔的栖居）、商业决策中的伦理框架。包含多视角辩论和真实案例分析。`,
  "chinese-philosophy": `中国哲学系统课程。涵盖儒家（孔子仁学《论语》、孟子性善《孟子·告子上》、荀子性恶《荀子·性恶》）、道家（老子无为《道德经》、庄子逍遥《庄子·逍遥游》）、佛家（般若空性《心经》、禅宗公案《六祖坛经》）核心思想。包含与AI孔子论仁、与AI庄子逍遥游等互动环节。请大量引用原文并给出今译。`,
  "grad-exam-cram": `考研哲学备考课程。通过苏格拉底式追问加深理解：马克思主义哲学基本原理（唯物辩证法三大规律、认识论）、中国哲学史核心命题（天人关系、理气之辩、知行合一）、西方哲学史关键转折（笛卡尔怀疑、康德批判、黑格尔辩证）。包含智能出题和AI批改。`,
  "ethics-lab": `伦理学推理训练课程。通过思想实验探索道德直觉：电车难题（功利主义计算）、无知之幕（罗尔斯正义论）、器官移植困境（义务论绝对命令）、美德伦理的实践智慧（亚里士多德中道）。包含追问引擎、推理树可视化和道德坐标分析。请引用《尼各马可伦理学》《正义论》《道德形而上学基础》原文。`,
  "east-west-dialogue": `东西方哲学跨文化对话课程。让孔子和苏格拉底对话（仁vs美德）、让庄子和尼采辩论（逍遥vs超人）、让禅宗和存在主义相遇（空vs虚无）、让《易经》和赫拉克利特对照（阴阳vs逻各斯）。比较不同文明对同一问题的不同回答。请引用双方原典。`,
  "daily-philosophy": `生活哲学实践课程，21天建立个人精神操作系统。涵盖：斯多葛晨间仪式（消极想象与可控/不可控区分，引用马可·奥勒留《沉思录》）、伊壁鸠鲁快乐计算（欲望分类与减法生活）、道家无为（不内耗的行动哲学）、存在主义选择（在不确定中创造意义）、亚里士多德习惯论（德性作为日常练习）、禅宗正念（注意力作为哲学实践）。每章含3个可执行实践任务和反思日志环节。语言温暖、实操、不说教。`,
  "ai-ethics": `AI伦理与科技哲学课程，从电车难题到算法正义。涵盖：技术中立论的破产、自动驾驶电车难题（功利主义vs义务论）、算法偏见与分配正义（罗尔斯无知之幕）、数据隐私与数字权利、大模型幻觉与责任归属、推荐算法与信息茧房、AI意识与道德地位、技术异化与劳动哲学、AI治理与全球正义、构建你的AI伦理框架。包含AI辩论和真实案例分析工作坊。`,
  "philosophy-business": `哲学与商业决策课程，用2500年智慧做更好的商业决策。涵盖：利润之上的目的论、利益相关者vs股东至上、长期主义哲学、谈判中的逻辑与修辞、企业社会责任的哲学根基、创新与破坏性思维、组织正义与制度设计、领导力与德性伦理、数据驱动决策的伦理边界、构建你的商业哲学宣言。包含AI双顾问辩论和董事会伦理困境角色扮演。`,
  "aesthetics-philosophy": `美学与艺术哲学课程，从康德到AI艺术的审美判断力训练。涵盖：什么是美、康德的审美判断（无目的的合目的性）、尼采的悲剧美学（酒神与日神）、黑格尔的艺术终结论、中国美学（意境、气韵与留白）、杜威的艺术即经验、数字时代的美学（AI艺术是艺术吗？）、构建你的审美坐标系。包含AI哲学家审美对话和东西方美学对比。`,
  "political-philosophy": `政治哲学与公共议题课程，用哲学框架理解公共争议。涵盖：为什么需要政治哲学、社会契约论（霍布斯/洛克/卢梭）、罗尔斯正义论（无知之幕与差别原则）、自由至上主义（诺齐克）、社群主义批评（桑德尔）、自由与平等能否兼得、公民不服从与公共理性、全球正义、数字时代的权力与自由、实践分析真实公共政策争议。包含圆桌讨论和立场光谱测试。`,
  "philosophy-of-science": `科学哲学课程，从证伪主义到范式革命。涵盖：科学是什么（划界问题）、逻辑实证主义（维也纳学派）、波普尔的证伪主义、库恩的范式理论、费耶阿本德的"怎么都行"、科学实在论vs反实在论、科学解释的模型、科学中的价值与客观性、科学争议案例分析、科学素养与伪科学识别。包含AI科学哲学对话和伪科学识别训练测验。`,
  "philosophy-therapy": `哲学与心理治疗课程，从存在主义到意义疗法。涵盖：哲学与心理治疗的历史渊源、弗兰克尔的意义疗法（《活出生命的意义》）、亚隆的存在主义心理治疗（四大终极关怀）、斯多葛与认知行为疗法、克尔凯郭尔的焦虑概念、海德格尔的向死而生、正念与禅宗哲学、哲学咨询的基本方法、构建你的哲学疗愈工具箱。包含AI哲学咨询对话和存在主义反思练习。`,
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── OpenMAIC API ──
async function submitGeneration(prompt, retries = MAX_RETRIES) {
  const res = await fetch(`${OPENMAIC_BASE}/api/generate-classroom`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-openmaic-api-key": SERVICE_API_KEY,
    },
    body: JSON.stringify({
      requirement: prompt,
      enableWebSearch: false,
      enableImageGeneration: true,
      enableTTS: true,
      agentMode: "generate",
    }),
  });
  if (res.status === 429 && retries > 0) {
    console.log(`\n    429 限流，等待 60 秒后重试（剩余 ${retries} 次）...`);
    await sleep(60000);
    return submitGeneration(prompt, retries - 1);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`生成请求失败 ${res.status}: ${body.slice(0, 200)}`);
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
    if (!res.ok) throw new Error(`轮询失败 ${res.status}`);
    const json = await res.json();
    const data = json.data ?? json;
    const progress = data.totalScenes > 0 ? `${data.scenesGenerated}/${data.totalScenes} 场景` : "准备中";
    process.stdout.write(`\r    [${data.status}] ${progress} | ${data.progress || 0}%   `);
    if (data.status === "failed") throw new Error(`生成失败: ${data.error || "未知错误"}`);
    if (data.done || data.status === "succeeded") {
      console.log("\n    ✓ 生成完成!");
      return data;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("生成超时（超过 45 分钟）");
}

// ── 主流程 ──
async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  章节课堂批量生成${RUN_ALL ? "（全部课程）" : ""}`);
  console.log(`  目标: ${RUN_ALL ? "所有缺失章节的课程" : TARGET_SLUG}`);
  console.log(`  OpenMAIC: ${OPENMAIC_BASE}`);
  console.log(`  模式: ${DRY_RUN ? "DRY-RUN（仅预览）" : "正式生成"}`);
  console.log("═══════════════════════════════════════════════════════\n");

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  const progress = loadProgress();

  try {
    // 1. 检查 OpenMAIC 可达
    const health = await fetch(`${OPENMAIC_BASE}/api/health`, {
      headers: { "x-openmaic-api-key": SERVICE_API_KEY },
    });
    const h = await health.json();
    console.log(`OpenMAIC v${h.version} | TTS:${h.capabilities?.tts} | 图片:${h.capabilities?.imageGeneration}\n`);

    // 2. 确定目标课程列表
    let targetSlugs;
    if (RUN_ALL) {
      const rows = await client.query(
        `SELECT DISTINCT c.slug, c.sort_order, c.id FROM courses c
         JOIN course_chapters cc ON cc.course_id = c.id
         WHERE cc.classroom_id IS NULL OR cc.classroom_id = ''
         ORDER BY c.sort_order, c.id`
      );
      targetSlugs = rows.rows.map(r => r.slug);
      console.log(`发现 ${targetSlugs.length} 门课程有缺失章节: ${targetSlugs.join(", ")}\n`);
    } else {
      targetSlugs = [TARGET_SLUG];
    }

    // 3. 逐课程处理
    let globalOk = 0, globalFail = 0;
    for (const slug of targetSlugs) {
      const courseRow = await client.query(
        "SELECT id, slug, title, generation_prompt FROM courses WHERE slug = $1", [slug]
      );
      if (courseRow.rows.length === 0) {
        console.log(`[跳过] ${slug} 不存在于 DB`);
        continue;
      }
      const course = courseRow.rows[0];
      const basePrompt = COURSE_PROMPTS[slug] || course.generation_prompt || `${course.title}——AI驱动多Agent互动课堂`;

      const chapRows = await client.query(
        `SELECT id, chapter_number, title, description, slug
         FROM course_chapters
         WHERE course_id = $1 AND (classroom_id IS NULL OR classroom_id = '')
         ORDER BY chapter_number`,
        [course.id]
      );

      if (chapRows.rows.length === 0) {
        console.log(`[完成] ${slug} 所有章节均已有课堂`);
        continue;
      }

      console.log(`\n${"═".repeat(55)}`);
      console.log(`  ${slug} (${course.title}) — ${chapRows.rows.length} 章待生成`);
      console.log(`${"═".repeat(55)}`);

      if (DRY_RUN) {
        for (const ch of chapRows.rows) {
          console.log(`  第${ch.chapter_number}章: ${ch.title}`);
        }
        continue;
      }

      // 逐章生成
      for (let i = 0; i < chapRows.rows.length; i++) {
        const ch = chapRows.rows[i];
        const progressKey = `${slug}:${ch.chapter_number}`;

        // 断点续传：跳过已完成
        if (progress.completed[progressKey]) {
          console.log(`  [跳过] 第${ch.chapter_number}章 ${ch.title} (已完成: ${progress.completed[progressKey]})`);
          globalOk++;
          continue;
        }

        console.log(`\n  [${i + 1}/${chapRows.rows.length}] 第 ${ch.chapter_number} 章: ${ch.title}`);
        const chapterPrompt = buildChapterPrompt(basePrompt, ch);

        try {
          const { jobId } = await submitGeneration(chapterPrompt);
          console.log(`    JobId: ${jobId}`);

          const result = await pollUntilDone(jobId);
          const classroomId = result.result?.classroomId || result.result?.id;
          const totalScenes = result.totalScenes || result.result?.scenesCount || 0;
          if (!classroomId) throw new Error("未能获取 classroomId");

          await client.query("UPDATE course_chapters SET classroom_id = $1 WHERE id = $2", [classroomId, ch.id]);
          const promptHash = createHash("sha256").update(chapterPrompt).digest("hex").slice(0, 16);
          await client.query(
            `INSERT INTO course_generation_logs (course_slug, prompt_hash, prompt_text, rag_context_chars, model, openmaic_job_id, classroom_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [slug, promptHash, chapterPrompt, 0, "openmaic", jobId, classroomId]
          );

          console.log(`    → ${classroomId} (${totalScenes} 场景)`);
          progress.completed[progressKey] = classroomId;
          saveProgress(progress);
          globalOk++;

          if (i < chapRows.rows.length - 1) {
            console.log(`    等待 ${CHAPTER_GAP_MS / 1000}s...`);
            await sleep(CHAPTER_GAP_MS);
          }
        } catch (err) {
          console.error(`\n    ✗ 失败: ${err.message}`);
          globalFail++;
        }
      }
    }

    // 汇总
    console.log("\n\n═══════════════════════════════════════════════════════");
    console.log(`  总计: 成功 ${globalOk} | 失败 ${globalFail}`);
    if (DRY_RUN) console.log("  (DRY-RUN 模式，未实际生成)");
    console.log("═══════════════════════════════════════════════════════\n");
  } finally {
    await client.end();
  }
}

function buildChapterPrompt(basePrompt, chapter) {
  return `${basePrompt}

【当前章节：第 ${chapter.chapter_number} 章 — ${chapter.title}】
${chapter.description ?? ""}

请聚焦生成本章对应的课堂内容。要求：
- 围绕本章主题展开，不重复其他章节内容
- 保持多Agent互动教学模式（教师引导 + 学生提问 + AI哲学家对话）
- 包含本章相关的原典引用和思想实验
- 语言：中文教学，学术平实，专业术语附英文原名
- 适合具备哲学兴趣但无深厚背景的学习者`;
}

main().catch((err) => { console.error("致命错误:", err); process.exit(1); });
