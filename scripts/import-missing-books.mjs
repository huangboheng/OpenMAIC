import { createRequire } from "module";
const require = createRequire("E:/hermes/workspace/Philochora/package.json");
const pg = require("pg");
const DB_URL = "postgresql://postgres:882ab5346d3d5a8a15aba2d723aade19@localhost:5999/philochora";

const BOOKS = [
  { zh: "修辞学", en: "Rhetoric", auZ: "亚里士多德", auE: "Aristotle", era: "ancient-greek", cat: "western-philosophy", pub: true, cp: "public_domain" },
  { zh: "恐惧与颤栗", en: "Fear and Trembling", auZ: "克尔凯郭尔", auE: "Soren Kierkegaard", era: "19th-century", cat: "western-philosophy", pub: true, cp: "public_domain" },
  { zh: "1844年经济学哲学手稿", en: "Economic and Philosophic Manuscripts of 1844", auZ: "马克思", auE: "Karl Marx", era: "19th-century", cat: "western-philosophy", pub: true, cp: "public_domain" },
  { zh: "道德与立法原理导论", en: "Introduction to the Principles of Morals and Legislation", auZ: "边沁", auE: "Jeremy Bentham", era: "enlightenment", cat: "western-philosophy", pub: true, cp: "public_domain" },
  { zh: "致美诺寇斯信", en: "Letter to Menoeceus", auZ: "伊壁鸠鲁", auE: "Epicurus", era: "ancient-greek", cat: "western-philosophy", pub: true, cp: "public_domain" },
  { zh: "活出生命的意义", en: "Man's Search for Meaning", auZ: "弗兰克尔", auE: "Viktor Frankl", era: "20th-century", cat: "psychology-philosophy", pub: false, cp: "fair_use" },
  { zh: "科学发现的逻辑", en: "The Logic of Scientific Discovery", auZ: "波普尔", auE: "Karl Popper", era: "20th-century", cat: "philosophy-of-science", pub: false, cp: "fair_use" },
  { zh: "科学革命的结构", en: "The Structure of Scientific Revolutions", auZ: "库恩", auE: "Thomas Kuhn", era: "20th-century", cat: "philosophy-of-science", pub: false, cp: "fair_use" },
  { zh: "西西弗神话", en: "The Myth of Sisyphus", auZ: "加缪", auE: "Albert Camus", era: "20th-century", cat: "existentialism", pub: false, cp: "fair_use" },
  { zh: "存在与虚无", en: "Being and Nothingness", auZ: "萨特", auE: "Jean-Paul Sartre", era: "20th-century", cat: "existentialism", pub: false, cp: "fair_use" },
  { zh: "存在主义是一种人道主义", en: "Existentialism is a Humanism", auZ: "萨特", auE: "Jean-Paul Sartre", era: "20th-century", cat: "existentialism", pub: false, cp: "fair_use" },
  { zh: "倦怠社会", en: "The Burnout Society", auZ: "韩炳哲", auE: "Byung-Chul Han", era: "21st-century", cat: "contemporary-philosophy", pub: false, cp: "fair_use" },
  { zh: "无政府、国家与乌托邦", en: "Anarchy, State, and Utopia", auZ: "诺齐克", auE: "Robert Nozick", era: "20th-century", cat: "political-philosophy", pub: false, cp: "fair_use" },
];

async function main() {
  console.log("Importing " + BOOKS.length + " books (" + BOOKS.filter(b => b.pub).length + " public, " + BOOKS.filter(b => !b.pub).length + " RAG-only)...\n");
  const c = new pg.Client({ connectionString: DB_URL }); await c.connect();
  let imported = 0, skipped = 0, paras = 0;
  const newIds = [];

  for (const b of BOOKS) {
    const ex = await c.query("SELECT id FROM classics_books WHERE title_zh ILIKE $1 OR title_en ILIKE $2", ["%" + b.zh + "%", "%" + b.en + "%"]);
    if (ex.rows.length > 0) { console.log("[skip] " + b.zh + " (id=" + ex.rows[0].id + ")"); skipped++; continue; }

    console.log("[import] " + b.zh + " | " + b.auZ);
    const slug = b.en.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const r = await c.query(
      "INSERT INTO classics_books (title_zh,title_en,title_original,author_zh,author_en,era,category,is_published,copyright_status,slug,language,total_chapters) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'en',0) RETURNING id",
      [b.zh, b.en, b.en, b.auZ, b.auE, b.era, b.cat, b.pub, b.cp, slug]
    );
    const bid = r.rows[0].id; newIds.push(bid);
    const ch = await c.query("INSERT INTO classics_chapters (book_id,chapter_number,title_zh,title_en,sort_order) VALUES ($1,1,$2,$3,0) RETURNING id", [bid, "Full Text", "Full Text"]);
    const cid = ch.rows[0].id;

    const txt = "[Pending import] " + b.zh + " (" + b.auZ + "). Full text to be fetched from Project Gutenberg.";
    const chunks = [txt, "(" + b.cat + " | " + b.era + ")", "Source: Project Gutenberg / public domain"];
    for (let i = 0; i < chunks.length; i++) {
      await c.query("INSERT INTO classics_paragraphs (chapter_id,paragraph_number,content_en,content_zh,sort_order) VALUES ($1,$2,$3,$4,$5)", [cid, i + 1, chunks[i], chunks[i], i]);
      await c.query("INSERT INTO translation_tasks (paragraph_id,book_id,chapter_id,status,priority_tier) VALUES ((SELECT id FROM classics_paragraphs WHERE chapter_id=$1 AND paragraph_number=$2),$3,$1,'pending','P3')", [cid, i + 1, bid]);
    }
    paras += chunks.length; imported++;
  }

  if (newIds.length > 0) await c.query("UPDATE classics_books SET total_chapters=1 WHERE id=ANY($1)", [newIds]);
  console.log("\nDone: imported " + imported + ", skipped " + skipped + ", " + paras + " paras + translation tasks");
  console.log("New IDs: " + newIds.join(", "));
  await c.end();
}
main().catch(e => { console.error(e); process.exit(1); });
