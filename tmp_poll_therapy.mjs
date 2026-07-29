import { createRequire } from "module";
const require = createRequire("E:/hermes/workspace/Philochora/package.json");
const pg = require("pg");

const JOB_ID = "2sk0lp1VnQ";
const OPENMAIC_BASE = "http://localhost:3010/openmaic";
const API_KEY = "svc-key-philochora-openmaic-2026";
const DB_URL = "postgresql://postgres:882ab5346d3d5a8a15aba2d723aade19@localhost:5999/philochora";

async function main() {
  console.log(`Polling philosophy-therapy job ${JOB_ID}...`);
  const start = Date.now();
  while (Date.now() - start < 45 * 60 * 1000) {
    const r = await fetch(`${OPENMAIC_BASE}/api/generate-classroom/${JOB_ID}`, {
      headers: { "x-openmaic-api-key": API_KEY },
    });
    const json = await r.json();
    const data = json.data || json;
    process.stdout.write(`\r  [${data.status}] ${data.progress}% ${data.message}   `);
    if (data.done || data.status === "succeeded") {
      const classroomId = data.result?.classroomId || data.result?.id;
      console.log(`\nDone! classroomId: ${classroomId}`);
      // Update DB
      const c = new pg.Client({ connectionString: DB_URL });
      await c.connect();
      await c.query("UPDATE courses SET classroom_id=$1, content_status='generated' WHERE slug='philosophy-therapy'", [classroomId]);
      console.log("DB updated: philosophy-therapy.classroom_id =", classroomId);
      await c.end();
      return;
    }
    if (data.status === "failed") {
      console.log(`\nFAILED: ${data.error}`);
      return;
    }
    await new Promise(r => setTimeout(r, 10000));
  }
  console.log("\nTimeout after 45 min");
}
main().catch(e => console.error(e));
