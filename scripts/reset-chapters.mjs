import { createRequire } from "module";
import { unlinkSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { getDatabaseUrl } from "./lib/db-url.mjs";
const require = createRequire("E:/hermes/workspace/Philochora/package.json");
const pg = require("pg");
const c = new pg.Client({ connectionString: getDatabaseUrl("postgresql://postgres:882ab5346d3d5a8a15aba2d723aade19@localhost:5999/philochora") });
await c.connect();

// Reset ALL chapters with classroom_id (full regeneration with v4-pro)
const rows = await c.query(
  "SELECT cc.id, cc.slug, cc.title, cc.classroom_id, c.slug as cs FROM course_chapters cc JOIN courses c ON cc.course_id=c.id WHERE cc.classroom_id IS NOT NULL AND cc.classroom_id != ''"
);

console.log(`Resetting ${rows.rows.length} chapters...\n`);

const classroomsDir = "E:/hermes/workspace/openmaic/data/classrooms";
const jobsDir = "E:/hermes/workspace/openmaic/data/classroom-jobs";
let reset = 0, deleted = 0;

for (const r of rows.rows) {
  // 1. Reset DB
  await c.query("UPDATE course_chapters SET classroom_id=NULL WHERE id=$1", [r.id]);
  console.log(`  DB reset: ${r.cs} ch ${r.title} (was ${r.classroom_id})`);
  reset++;

  // 2. Delete classroom file
  const filePath = join(classroomsDir, r.classroom_id + ".json");
  if (existsSync(filePath)) {
    unlinkSync(filePath);
    console.log(`  File deleted: ${r.classroom_id}.json`);
    deleted++;
  }
}

// 3. Clean up classroom-jobs directory (historical job files)
let jobsCleaned = 0;
if (existsSync(jobsDir)) {
  const jobFiles = readdirSync(jobsDir).filter(f => f.endsWith(".json"));
  for (const f of jobFiles) {
    try { unlinkSync(join(jobsDir, f)); jobsCleaned++; } catch {}
  }
}

console.log(`\nDone: ${reset} chapters reset, ${deleted} classroom files deleted, ${jobsCleaned} job files cleaned.`);
console.log("Run: node scripts/batch-generate-chapters.mjs --all --workers=10");

await c.end();
