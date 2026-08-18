/**
 * Translation worker - translates pending paragraphs EN→ZH using DeepSeek API
 * Usage: node scripts/run-translation.mjs [--batch=12] [--max=100]
 */
import { createRequire } from "module";
import { join } from "path";
import { readFileSync } from "fs";
import { getDatabaseUrl } from "./lib/db-url.mjs";

const PHILOCHORA_ROOT = "E:/hermes/workspace/Philochora";
const require = createRequire(join(PHILOCHORA_ROOT, "package.json"));
const pg = require("pg");

// Load env from OpenMAIC (has valid DeepSeek key)
function loadEnv() {
  for (const p of ["E:/hermes/workspace/openmaic/.env.local", join(PHILOCHORA_ROOT, ".env")]) {
    try {
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
    } catch {}
  }
}
loadEnv();

const DB_URL = getDatabaseUrl("postgresql://postgres:882ab5346d3d5a8a15aba2d723aade19@localhost:5999/philochora");
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

// 从环境变量读取 DEEPSEEK_API_KEY（逗号分隔多把用于 rotation）
// 密钥只能存在 .env* 中，绝不能在代码里 hardcode（BR-150 阶段 5 根因修复）
const API_KEYS = (process.env.DEEPSEEK_API_KEY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (API_KEYS.length === 0) {
  console.error("[run-translation] FATAL: DEEPSEEK_API_KEY 未配置或为空。");
  console.error("请在 .env.local / .env.vps.local / .env.secrets 中设置 DEEPSEEK_API_KEY=<key1>[,<key2>,...]");
  process.exit(1);
}

const BATCH_SIZE = parseInt(process.argv.find(a => a.startsWith("--batch="))?.slice(8) || "12");
const MAX_TASKS = parseInt(process.argv.find(a => a.startsWith("--max="))?.slice(6) || "5000");
const NUM_WORKERS = parseInt(process.argv.find(a => a.startsWith("--workers="))?.slice(10) || "3");

const SYSTEM_PROMPT = `You are a professional philosophy translator. Translate the following English philosophy text paragraphs into Chinese.

Rules:
1. Maintain academic rigor and philosophical precision
2. Use established Chinese philosophical terminology (e.g., "存在先于本质", "范式转换", "意义疗法")
3. Keep proper nouns in original with Chinese translation on first occurrence
4. Preserve paragraph structure - translate each paragraph independently
5. Output as JSON array of translated strings, same order as input
6. Do NOT add explanations, notes, or commentary
7. Temperature: formal academic Chinese, readable but precise`;

// Key rotation counter
let keyIndex = 0;
function getNextKey() {
  const key = API_KEYS[keyIndex % API_KEYS.length];
  keyIndex++;
  return key;
}

async function translateBatch(texts) {
  const userPrompt = `Translate these ${texts.length} paragraphs into Chinese. Return a JSON array of ${texts.length} translated strings.\n\n${JSON.stringify(texts)}`;
  const apiKey = getNextKey();

  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.3,
      max_tokens: 16384
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "";

  // Parse JSON response (with fallback)
  let translations;
  try {
    // Try direct JSON parse
    translations = JSON.parse(content);
  } catch {
    // Try extracting JSON array from markdown code block
    const match = content.match(/\[[\s\S]*\]/);
    if (match) {
      translations = JSON.parse(match[0]);
    } else {
      throw new Error("Cannot parse translation response");
    }
  }

  if (!Array.isArray(translations)) throw new Error("Response is not an array");
  return translations;
}

async function worker(workerId, maxPerWorker) {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  let done = 0, failed = 0;

  while (done < maxPerWorker) {
    // Step 1: Lock and claim tasks (short transaction)
    await client.query('BEGIN');
    const tasks = await client.query(`
      SELECT tt.id, tt.paragraph_id, cp.content_en
      FROM translation_tasks tt
      JOIN classics_paragraphs cp ON cp.id = tt.paragraph_id
      WHERE tt.status = 'pending'
      ORDER BY tt.book_id, tt.paragraph_id
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    `, [BATCH_SIZE]);

    if (tasks.rows.length === 0) {
      await client.query('ROLLBACK');
      break;
    }

    const texts = tasks.rows.map(r => r.content_en);
    const taskIds = tasks.rows.map(r => r.id);
    const paraIds = tasks.rows.map(r => r.paragraph_id);

    await client.query(`UPDATE translation_tasks SET status = 'in_progress' WHERE id = ANY($1)`, [taskIds]);
    await client.query('COMMIT'); // Release lock immediately

    // Step 2: Call API (outside transaction)
    try {
      const translations = await translateBatch(texts);

      // Step 3: Update results (new short transaction)
      for (let i = 0; i < Math.min(translations.length, paraIds.length); i++) {
        const zh = translations[i];
        if (!zh || zh.length < 3 || zh.replace(/[^\x00-\x7F]/g, "").length / zh.length > 0.5) {
          await client.query(`UPDATE translation_tasks SET status = 'failed' WHERE id = $1`, [taskIds[i]]);
          failed++;
          continue;
        }
        await client.query(`UPDATE classics_paragraphs SET content_zh = $1 WHERE id = $2`, [zh, paraIds[i]]);
        await client.query(`UPDATE translation_tasks SET status = 'done' WHERE id = $1`, [taskIds[i]]);
        done++;
      }
      for (let i = translations.length; i < taskIds.length; i++) {
        await client.query(`UPDATE translation_tasks SET status = 'pending' WHERE id = $1`, [taskIds[i]]);
      }
      console.log(`  [W${workerId}] ${done} done`);
    } catch (e) {
      // Reset to pending for retry
      await client.query(`UPDATE translation_tasks SET status = 'pending' WHERE id = ANY($1)`, [taskIds]);
      failed += taskIds.length;
      console.log(`  [W${workerId}] ERROR: ${e.message.slice(0, 80)}`);
      if (e.message.includes("429")) await new Promise(r => setTimeout(r, 30000));
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  await client.end();
  return { done, failed };
}

async function main() {
  if (API_KEYS.length === 0) {
    console.error("ERROR: No API keys available");
    process.exit(1);
  }

  console.log("============================================================");
  console.log("  Translation Worker (EN→ZH)");
  console.log(`  Workers: ${NUM_WORKERS} | Keys: ${API_KEYS.length} | Batch: ${BATCH_SIZE}`);
  console.log("============================================================\n");

  const maxPerWorker = Math.ceil(MAX_TASKS / NUM_WORKERS);
  const results = await Promise.all(
    Array.from({ length: NUM_WORKERS }, (_, i) => worker(i, maxPerWorker))
  );

  const totalDone = results.reduce((s, r) => s + r.done, 0);
  const totalFailed = results.reduce((s, r) => s + r.failed, 0);

  console.log(`\n============================================================`);
  console.log(`  Done: ${totalDone} translated, ${totalFailed} failed`);
  console.log(`============================================================`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
