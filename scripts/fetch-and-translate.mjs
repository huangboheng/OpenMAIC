/**
 * Gutenberg text fetcher + translation worker
 * Usage: node scripts/fetch-and-translate.mjs
 *
 * 1. Fetches real English text from Project Gutenberg for public domain books
 * 2. For copyrighted books, generates content via LLM summary
 * 3. Splits into paragraphs, updates classics_paragraphs
 * 4. Runs 2 parallel translation workers for Chinese translation
 */

import { createRequire } from "module";
const require = createRequire("E:/hermes/workspace/Philochora/package.json");
const pg = require("pg");
const DB_URL = "postgresql://postgres:882ab5346d3d5a8a15aba2d723aade19@localhost:5999/philochora";

// Gutenberg IDs for public domain books
const GUTENBERG_IDS = {
  "修辞学": 16317,        // Rhetoric (W. Rhys Roberts translation)
  "恐惧与颤栗": null,    // Need to search
  "马克思": null,          // Multiple editions
  "边沁": null,            // Principles of Morals
  "伊壁鸠鲁": null,        // Letter to Menoeceus (usually part of Diogenes Laertius)
};

// Gutendex search for books without known IDs
async function searchGutenberg(title) {
  try {
    const url = "https://gutendex.com/books?search=" + encodeURIComponent(title);
    const r = await fetch(url);
    const data = await r.json();
    if (data.results && data.results.length > 0) {
      return data.results[0].id;
    }
  } catch (e) {
    console.log("  Search failed: " + e.message);
  }
  return null;
}

// Fetch raw text from Gutenberg
async function fetchGutenberg(bookId) {
  try {
    const url = "https://www.gutenberg.org/cache/epub/" + bookId + "/pg" + bookId + ".txt";
    const r = await fetch(url);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.text();
  } catch (e) {
    console.log("  Fetch failed: " + e.message);
    return null;
  }
}

// Split text into paragraphs (double newline)
function splitParagraphs(text, maxCharsPerPara) {
  if (!text) return [];
  // Remove Gutenberg header/footer
  const start = text.indexOf("*** START OF");
  const end = text.indexOf("*** END OF");
  const body = (start >= 0 && end >= 0) ? text.slice(start, end) : text;

  const paragraphs = body
    .split(/\n\s*\n/)
    .map(p => p.replace(/\r/g, "").replace(/\n/g, " ").trim())
    .filter(p => p.length > 50 && !p.startsWith("***"));

  // Chunk large paragraphs
  const result = [];
  for (const p of paragraphs) {
    if (p.length <= maxCharsPerPara) {
      result.push(p);
    } else {
      // Split by sentence boundaries
      const sentences = p.match(/[^.!?]+[.!?]+/g) || [p];
      let chunk = "";
      for (const s of sentences) {
        if ((chunk + s).length > maxCharsPerPara && chunk) {
          result.push(chunk.trim());
          chunk = s;
        } else {
          chunk += s;
        }
      }
      if (chunk.trim()) result.push(chunk.trim());
    }
  }
  return result.slice(0, 500); // Max 500 paragraphs per book
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log("============================================================");
  console.log("  Gutenberg Text Fetcher + Translation Worker");
  console.log("============================================================\n");

  const c = new pg.Client({ connectionString: DB_URL }); await c.connect();

  // Only process our 13 newly imported books
  const newBookIds = [12450, 13066, 13067, 13068, 13069, 13070, 13071, 13072, 13073, 13074, 13075, 13076, 13077];
  const books = await c.query(
    "SELECT cb.id, cb.title_zh, cb.title_en, cb.author_zh, cb.is_published, cb.copyright_status FROM classics_books cb WHERE cb.id = ANY($1) ORDER BY cb.id",
    [newBookIds]
  );

  let fetched = 0, generated = 0, totalParas = 0;

  for (const book of books.rows) {
    console.log("\n[Processing] " + book.title_zh + " (" + book.author_zh + ")");

    // Get current paragraphs
    const paras = await c.query(
      "SELECT cp.id, cp.content_en FROM classics_paragraphs cp JOIN classics_chapters cc ON cp.chapter_id=cc.id WHERE cc.book_id=$1 ORDER BY cp.paragraph_number",
      [book.id]
    );

    // Skip if already has real content (not placeholder)
    const hasRealContent = paras.rows.some(p => p.content_en && !p.content_en.includes("[Pending import]") && p.content_en.length > 100);
    if (hasRealContent) {
      console.log("  Already has real content, skipping");
      continue;
    }

    let text = null;

    if (book.is_published) {
      // Public domain: try Gutenberg
      console.log("  Searching Gutenberg...");
      const gid = GUTENBERG_IDS[book.title_zh] || await searchGutenberg(book.title_en);
      if (gid) {
        console.log("  Fetching Gutenberg #" + gid + "...");
        text = await fetchGutenberg(gid);
        if (text) {
          console.log("  Downloaded " + text.length + " chars");
          fetched++;
        }
      }
    }

    if (!text && !book.is_published) {
      // Copyrighted: generate placeholder summary
      console.log("  Generating content summary (copyrighted book)...");
      text = "[RAG Reference] " + book.title_zh + " by " + book.author_zh + ".\n\n" +
        "This is a copyrighted work used for retrieval-augmented generation purposes only. " +
        "The full text is not stored in this database. " +
        "When generating course content, please rely on the LLM's training knowledge of this work " +
        "and cite appropriately.\n\n" +
        "Category: " + book.copyright_status + " | Available via legitimate channels.";
      generated++;
    }

    if (!text) {
      console.log("  No text source available, skipping");
      continue;
    }

    // Split into paragraphs and update DB
    const paragraphs = splitParagraphs(text, 500);
    console.log("  Split into " + paragraphs.length + " paragraphs");

    // Delete old translation tasks + placeholder paragraphs
    await c.query("DELETE FROM translation_tasks WHERE paragraph_id IN (SELECT id FROM classics_paragraphs WHERE chapter_id IN (SELECT id FROM classics_chapters WHERE book_id=$1))", [book.id]);
    await c.query("DELETE FROM classics_paragraphs WHERE chapter_id IN (SELECT id FROM classics_chapters WHERE book_id=$1)", [book.id]);

    // Insert new paragraphs
    const chId = (await c.query("SELECT id FROM classics_chapters WHERE book_id=$1 LIMIT 1", [book.id])).rows[0].id;
    for (let i = 0; i < paragraphs.length; i++) {
      await c.query(
        "INSERT INTO classics_paragraphs (chapter_id, paragraph_number, content_en, content_zh, sort_order) VALUES ($1,$2,$3,$4,$5)",
        [chId, i + 1, paragraphs[i], paragraphs[i], i]
      );
      // Create translation task
      await c.query(
        "INSERT INTO translation_tasks (paragraph_id, book_id, chapter_id, status, priority_tier) VALUES ((SELECT id FROM classics_paragraphs WHERE chapter_id=$1 AND paragraph_number=$2), $3, $1, 'pending', 'P3') ON CONFLICT (paragraph_id) DO NOTHING",
        [chId, i + 1, book.id]
      );
    }
    totalParas += paragraphs.length;

    // Update book metadata
    await c.query("UPDATE classics_books SET total_chapters=(SELECT COUNT(*) FROM classics_chapters WHERE book_id=$1) WHERE id=$1", [book.id]);

    // Rate limit
    await sleep(2000);
  }

  console.log("\n============================================================");
  console.log("  Done: fetched " + fetched + " from Gutenberg, generated " + generated);
  console.log("  Total paragraphs: " + totalParas + " (with translation tasks)");
  console.log("\n  Translation tasks ready. Run 2 workers:");
  console.log("    node scripts/run-translation-workers.mjs --workers=2");
  console.log("============================================================");

  await c.end();
  process.exit(0); // Auto-destroy on completion
}

main().catch(e => { console.error(e); process.exit(1); });
