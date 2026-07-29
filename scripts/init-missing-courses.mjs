/**
 * 初始化 7 门缺失课程到 Philochora DB
 *
 * 功能：
 *   1. INSERT 7 门课程到 courses 表（含 metadata + classroom_id 绑定）
 *   2. 为每门课程 INSERT 章节到 course_chapters 表
 *   3. 触发 philosophy-therapy 课程级课堂重新生成（文件缺失）
 *   4. 写入 course_generation_logs 审计
 *
 * 使用方式：
 *   node scripts/init-missing-courses.mjs
 *   node scripts/init-missing-courses.mjs --dry-run   # 仅打印 SQL，不执行
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { createRequire } from "module";
import { createHash } from "crypto";

// ── 依赖 ──
const PHILOCHORA_ROOT = process.env.PHILOCHORA_ROOT || "E:/hermes/workspace/Philochora";
const require = createRequire(join(PHILOCHORA_ROOT, "package.json"));
const pg = require("pg");

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

const DRY_RUN = process.argv.includes("--dry-run");
const DATABASE_URL = process.env.DATABASE_URL;
const OPENMAIC_BASE = process.env.OPENMAIC_BASE_URL || "http://localhost:3010/openmaic";
const SERVICE_API_KEY = process.env.OPENMAIC_SERVICE_API_KEY;

if (!DATABASE_URL) { console.error("❌ 缺少 DATABASE_URL"); process.exit(1); }

// ── 7 门课程定义 ──
const COURSES = [
  {
    slug: "daily-philosophy", title: "哲学即生活", subtitle: "21天精神操作系统",
    tagline: "每天15分钟，用斯多葛/道家/伊壁鸠鲁的智慧重建内心秩序",
    icon: "sunrise", color: "#f59e0b", sortOrder: 13, classroomId: "IDcmgShOJj",
    capabilities: ["chat"],
    chapters: [
      { slug: "stoic-morning", title: "斯多葛晨间仪式", desc: "消极想象与可控/不可控区分，引用马可·奥勒留《沉思录》" },
      { slug: "epicurus-joy", title: "伊壁鸠鲁快乐计算", desc: "欲望分类与减法生活，引用《致美诺寇斯信》" },
      { slug: "daoist-wuwei", title: "道家无为", desc: "不内耗的行动哲学，引用《道德经》第三十七章、《庄子·逍遥游》" },
      { slug: "existential-choice", title: "存在主义选择", desc: "在不确定中创造意义，引用萨特《存在主义是一种人道主义》" },
      { slug: "aristotle-habit", title: "亚里士多德习惯论", desc: "德性作为日常练习，引用《尼各马可伦理学》第二卷" },
      { slug: "zen-mindfulness", title: "禅宗正念", desc: "注意力作为哲学实践，引用《六祖坛经》" },
    ],
  },
  {
    slug: "ai-ethics", title: "AI时代的哲学罗盘", subtitle: "从电车难题到算法正义",
    tagline: "与AI功利主义者和AI康德面对面辩论，找到你的技术伦理坐标",
    icon: "cpu", color: "#0ea5e9", sortOrder: 14, classroomId: "R8ewSQC9sY",
    capabilities: ["debate", "chat"],
    chapters: [
      { slug: "tech-neutrality", title: "技术中立论的破产", desc: "导论：技术不是中性的，它内嵌价值选择" },
      { slug: "self-driving-trolley", title: "自动驾驶电车难题", desc: "功利主义vs义务论，引用边沁《道德与立法原理》、康德《道德形而上学基础》" },
      { slug: "algorithm-bias", title: "算法偏见与分配正义", desc: "罗尔斯无知之幕，引用《正义论》" },
      { slug: "data-privacy", title: "数据隐私与数字权利", desc: "洛克财产权vs公共品" },
      { slug: "llm-hallucination", title: "大模型幻觉与责任归属", desc: "因果链与道德主体" },
      { slug: "filter-bubble", title: "推荐算法与信息茧房", desc: "自由意志与操纵" },
      { slug: "ai-consciousness", title: "AI意识与道德地位", desc: "心灵哲学视角" },
      { slug: "tech-alienation", title: "技术异化与劳动哲学", desc: "马克思《1844年经济学哲学手稿》vs韩炳哲《倦怠社会》" },
      { slug: "ai-governance", title: "AI治理与全球正义", desc: "全球视野下的AI治理框架" },
      { slug: "your-ethics-framework", title: "构建你的AI伦理框架", desc: "综合实践：建立个人伦理决策矩阵" },
    ],
  },
  {
    slug: "philosophy-business", title: "哲学CEO", subtitle: "用2500年智慧做商业决策",
    tagline: "让AI康德和AI边沁同时做你的商业顾问",
    icon: "briefcase", color: "#14b8a6", sortOrder: 15, classroomId: "FImNqtEVUa",
    capabilities: ["debate", "chat"],
    chapters: [
      { slug: "purpose-beyond-profit", title: "利润之上的目的论", desc: "亚里士多德《尼各马可伦理学》目的论" },
      { slug: "stakeholder-vs-shareholder", title: "利益相关者vs股东至上", desc: "弗里曼vs弗里德曼" },
      { slug: "long-termism", title: "长期主义哲学", desc: "亚里士多德目的论vs短期功利" },
      { slug: "negotiation-rhetoric", title: "谈判中的逻辑与修辞", desc: "亚里士多德《修辞学》" },
      { slug: "csr-philosophy", title: "企业社会责任的哲学根基", desc: "康德'人是目的'《道德形而上学基础》" },
      { slug: "innovation-nietzsche", title: "创新与破坏性思维", desc: "尼采重估一切价值" },
      { slug: "org-justice", title: "组织正义与制度设计", desc: "罗尔斯/诺齐克" },
      { slug: "leadership-virtue", title: "领导力与德性伦理", desc: "德性伦理在管理中的应用" },
      { slug: "data-ethics-boundary", title: "数据驱动决策的伦理边界", desc: "数据主义的哲学反思" },
      { slug: "business-manifesto", title: "构建你的商业哲学宣言", desc: "综合实践：撰写个人商业哲学" },
    ],
  },
  {
    slug: "aesthetics-philosophy", title: "看见美", subtitle: "从康德到AI艺术的审美判断力训练",
    tagline: "与AI尼采讨论悲剧之美，让AI康德评判你的审美直觉",
    icon: "palette", color: "#8b5cf6", sortOrder: 16, classroomId: "m4WiuBDAqz",
    capabilities: ["debate", "chat"],
    chapters: [
      { slug: "what-is-beauty", title: "什么是美", desc: "柏拉图美的理念到当代" },
      { slug: "kant-aesthetic", title: "康德的审美判断", desc: "无目的的合目的性，引用《判断力批判》" },
      { slug: "nietzsche-tragedy", title: "尼采的悲剧美学", desc: "酒神与日神，引用《悲剧的诞生》" },
      { slug: "hegel-art-end", title: "黑格尔的艺术终结论", desc: "艺术是否已死？" },
      { slug: "chinese-aesthetics", title: "中国美学", desc: "意境、气韵与留白，引用《文心雕龙》、宗白华《美学散步》" },
      { slug: "dewey-art-experience", title: "杜威的艺术即经验", desc: "引用《艺术即经验》" },
      { slug: "digital-aesthetics", title: "数字时代的美学", desc: "AI艺术是艺术吗？算法审美与人类创造力" },
      { slug: "your-aesthetic-compass", title: "构建你的审美坐标系", desc: "综合实践：建立个人审美判断框架" },
    ],
  },
  {
    slug: "political-philosophy", title: "正义的尺度", subtitle: "用哲学框架理解公共争议",
    tagline: "让AI罗尔斯和AI诺齐克在你面前辩论贫富差距",
    icon: "landmark", color: "#eab308", sortOrder: 17, classroomId: "oQFStbnLlQ",
    capabilities: ["debate", "chat"],
    chapters: [
      { slug: "why-political-philosophy", title: "为什么需要政治哲学", desc: "从'我觉得不公平'到系统分析" },
      { slug: "social-contract", title: "社会契约论", desc: "霍布斯/洛克/卢梭，引用《利维坦》《政府论》《社会契约论》" },
      { slug: "rawls-justice", title: "罗尔斯正义论", desc: "无知之幕与差别原则，引用《正义论》" },
      { slug: "libertarianism", title: "自由至上主义", desc: "诺齐克的最小国家，引用《无政府、国家与乌托邦》" },
      { slug: "communitarianism", title: "社群主义批评", desc: "桑德尔与麦金太尔" },
      { slug: "liberty-equality", title: "自由与平等能否兼得", desc: "核心张力分析" },
      { slug: "civil-disobedience", title: "公民不服从与公共理性", desc: "从梭罗到罗尔斯" },
      { slug: "global-justice", title: "全球正义", desc: "世界主义 vs 国家主义" },
      { slug: "digital-power", title: "数字时代的权力与自由", desc: "福柯/韩炳哲" },
      { slug: "policy-practice", title: "实践：分析真实公共政策争议", desc: "综合实践：结构化政策分析" },
    ],
  },
  {
    slug: "philosophy-of-science", title: "科学的边界", subtitle: "从证伪主义到范式革命",
    tagline: "科学为什么可信？科学的边界又在哪里？",
    icon: "flask-conical", color: "#10b981", sortOrder: 18, classroomId: "4b8tbcW5gC",
    capabilities: ["debate", "quiz", "chat"],
    chapters: [
      { slug: "what-is-science", title: "科学是什么", desc: "科学与非科学的划界问题" },
      { slug: "logical-positivism", title: "逻辑实证主义", desc: "维也纳学派与可证实性原则" },
      { slug: "popper-falsification", title: "波普尔的证伪主义", desc: "引用《科学发现的逻辑》" },
      { slug: "kuhn-paradigm", title: "库恩的范式理论", desc: "引用《科学革命的结构》" },
      { slug: "feyerabend-anything", title: "费耶阿本德的'怎么都行'", desc: "认识论无政府主义" },
      { slug: "realism-vs-anti", title: "科学实在论vs反实在论", desc: "科学理论是否描述真实？" },
      { slug: "explanation-models", title: "科学解释的模型", desc: "DN模型与因果模型" },
      { slug: "values-objectivity", title: "科学中的价值与客观性", desc: "价值负载与科学诚信" },
      { slug: "controversy-cases", title: "科学争议案例分析", desc: "气候变化/转基因/AI风险" },
      { slug: "pseudoscience-literacy", title: "科学素养与伪科学识别", desc: "综合实践：伪科学识别训练" },
    ],
  },
  {
    slug: "philosophy-therapy", title: "哲学疗愈室", subtitle: "从存在主义到意义疗法",
    tagline: "理解心理治疗背后的哲学预设，掌握哲学咨询的基本方法",
    icon: "heart-pulse", color: "#f43f5e", sortOrder: 19, classroomId: null, // 需重新生成
    capabilities: ["chat"],
    chapters: [
      { slug: "history-philosophy-therapy", title: "哲学与心理治疗的历史渊源", desc: "从古希腊到当代" },
      { slug: "frankl-logotherapy", title: "弗兰克尔的意义疗法", desc: "引用《活出生命的意义》" },
      { slug: "yalom-existential", title: "亚隆的存在主义心理治疗", desc: "死亡/自由/孤独/无意义四大终极关怀" },
      { slug: "stoic-cbt", title: "斯多葛与认知行为疗法", desc: "Epictetus与CBT的哲学根源，引用《手册》" },
      { slug: "kierkegaard-anxiety", title: "克尔凯郭尔的焦虑概念", desc: "引用《恐惧与颤栗》" },
      { slug: "heidegger-death", title: "海德格尔的向死而生", desc: "与心理治疗的关联" },
      { slug: "mindfulness-zen", title: "正念与禅宗哲学", desc: "东方智慧与西方心理治疗的交汇" },
      { slug: "philosophical-counseling", title: "哲学咨询的基本方法", desc: "苏格拉底式对话在咨询中的应用" },
      { slug: "your-toolkit", title: "构建你的哲学疗愈工具箱", desc: "综合实践：建立个人哲学疗愈方案" },
    ],
  },
];

// ── 主流程 ──
async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  初始化 7 门缺失课程到 Philochora DB");
  console.log(`  模式: ${DRY_RUN ? "DRY-RUN（仅预览）" : "正式执行"}`);
  console.log("═══════════════════════════════════════════════════════\n");

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    for (const course of COURSES) {
      // 检查是否已存在
      const existing = await client.query("SELECT id FROM courses WHERE slug = $1", [course.slug]);
      if (existing.rows.length > 0) {
        console.log(`[跳过] ${course.slug} 已存在 (id=${existing.rows[0].id})`);
        continue;
      }

      console.log(`\n[INSERT] ${course.slug} | ${course.title}`);

      if (DRY_RUN) {
        console.log(`  classroom_id: ${course.classroomId || "NULL (待生成)"}`);
        console.log(`  章节数: ${course.chapters.length}`);
        course.chapters.forEach((ch, i) => console.log(`    ${i + 1}. ${ch.title}`));
        continue;
      }

      // INSERT 课程
      const insertResult = await client.query(
        `INSERT INTO courses (slug, title, subtitle, tagline, icon, color, sort_order, price,
          total_chapters, classroom_id, content_status, status, capabilities, generation_prompt)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 2499, $8, $9, $10, 'published', $11, $12)
         RETURNING id`,
        [
          course.slug, course.title, course.subtitle, course.tagline,
          course.icon, course.color, course.sortOrder,
          course.chapters.length, course.classroomId,
          course.classroomId ? "generated" : "pending",
          course.capabilities,
          course.chapters.map((ch, i) => `${i + 1}. ${ch.title}`).join("\n"),
        ]
      );
      const courseId = insertResult.rows[0].id;
      console.log(`  → id=${courseId}, classroom_id=${course.classroomId || "NULL"}`);

      // INSERT 章节
      for (let i = 0; i < course.chapters.length; i++) {
        const ch = course.chapters[i];
        await client.query(
          `INSERT INTO course_chapters (course_id, slug, title, description, chapter_number, sort_order)
           VALUES ($1, $2, $3, $4, $5, $5)`,
          [courseId, ch.slug, ch.title, ch.desc, i + 1]
        );
      }
      console.log(`  → ${course.chapters.length} 个章节已创建`);

      // 写入生成日志（对已有课堂的 6 门课程）
      if (course.classroomId) {
        const promptText = `${course.title} — 课程级课堂（由 generate-courses.mjs 生成）`;
        const promptHash = createHash("sha256").update(promptText).digest("hex").slice(0, 16);
        await client.query(
          `INSERT INTO course_generation_logs (course_slug, prompt_hash, prompt_text, rag_context_chars, model, classroom_id)
           VALUES ($1, $2, $3, 0, 'openmaic', $4)`,
          [course.slug, promptHash, promptText, course.classroomId]
        );
      }
    }

    if (!DRY_RUN) {
      console.log("\n\n═══════════════════════════════════════════════════════");
      console.log("  完成! 7 门课程已初始化。");
      console.log("  philosophy-therapy 的课程级课堂需重新生成：");
      console.log(`    node scripts/batch-generate-chapters.mjs --slug=philosophy-therapy --course-level`);
      console.log("═══════════════════════════════════════════════════════");
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => { console.error("致命错误:", err); process.exit(1); });
