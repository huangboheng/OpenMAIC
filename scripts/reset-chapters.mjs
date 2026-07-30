import { createRequire } from "module";
import { unlinkSync, existsSync } from "fs";
import { join } from "path";
const require = createRequire("E:/hermes/workspace/Philochora/package.json");
const pg = require("pg");
const c = new pg.Client({ connectionString: "postgresql://postgres:882ab5346d3d5a8a15aba2d723aade19@localhost:5999/philochora" });
await c.connect();

// Chapters to reset: all with classroom_id EXCEPT the 3 generated with RAG
const keepRag = ["w1SY4hVmVB", "ZNqGD201h2", "olRhdBLUtg"];

const rows = await c.query(
  "SELECT cc.id, cc.slug, cc.title, cc.classroom_id, c.slug as cs FROM course_chapters cc JOIN courses c ON cc.course_id=c.id WHERE cc.classroom_id IS NOT NULL AND cc.classroom_id != '' AND cc.classroom_id != ALL($1)",
  [keepRag]
);

console.log(`Resetting ${rows.rows.length} chapters...\n`);

const classroomsDir = "E:/hermes/workspace/openmaic/data/classrooms";
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

console.log(`\nDone: ${reset} chapters reset, ${deleted} files deleted.`);
console.log("Run: node scripts/batch-generate-chapters.mjs --all --workers=6");

await c.end();
