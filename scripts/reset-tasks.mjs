import { createRequire } from "module";
const require = createRequire("E:/hermes/workspace/Philochora/package.json");
const pg = require("pg");
const c = new pg.Client("postgresql://postgres:882ab5346d3d5a8a15aba2d723aade19@localhost:5999/philochora");
await c.connect();
const res = await c.query("UPDATE translation_tasks SET status='pending' WHERE status='in_progress'");
console.log("Reset in_progress → pending:", res.rowCount, "rows");
await c.end();
process.exit(0);
