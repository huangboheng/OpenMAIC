import { chromium } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'fs';

const PROXY = 'http://127.0.0.1:7993';
const DOWNLOAD_DIR = 'E:/hermes/workspace/openmaic/data/book-downloads';

// 12 books to search
const BOOKS = [
  { zh: "活出生命的意义", en: "Man's Search for Meaning", author: "Frankl" },
  { zh: "科学发现的逻辑", en: "The Logic of Scientific Discovery", author: "Popper" },
  { zh: "科学革命的结构", en: "The Structure of Scientific Revolutions", author: "Kuhn" },
  { zh: "西西弗神话", en: "The Myth of Sisyphus", author: "Camus" },
  { zh: "存在与虚无", en: "Being and Nothingness", author: "Sartre" },
  { zh: "存在主义是一种人道主义", en: "Existentialism is a Humanism", author: "Sartre" },
  { zh: "倦怠社会", en: "The Burnout Society", author: "Han" },
  { zh: "无政府、国家与乌托邦", en: "Anarchy State and Utopia", author: "Nozick" },
  { zh: "恐惧与颤栗", en: "Fear and Trembling", author: "Kierkegaard" },
  { zh: "1844年经济学哲学手稿", en: "Economic and Philosophic Manuscripts of 1844", author: "Marx" },
  { zh: "道德与立法原理导论", en: "Introduction to the Principles of Morals and Legislation", author: "Bentham" },
  { zh: "致美诺寇斯信", en: "Letter to Menoeceus", author: "Epicurus" },
];

async function main() {
  mkdirSync(DOWNLOAD_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    proxy: { server: PROXY },
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    acceptDownloads: true
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();

  // Phase 1: Navigate and wait for user to pass verification
  console.log('=== Phase 1: Opening z-library.sk ===');
  console.log('Please complete the browser verification in the opened window.');
  console.log('Waiting 90 seconds for you to pass verification...\n');

  await page.goto('https://z-library.sk/', { timeout: 30000, waitUntil: 'domcontentloaded' });

  // Wait for verification - check every 5 seconds if title changes from DiamWall
  let verified = false;
  for (let i = 0; i < 18; i++) { // 18 * 5s = 90s max
    await page.waitForTimeout(5000);
    const title = await page.title();
    if (!title.includes('验证') && !title.includes('DiamWall') && !title.includes('Checking')) {
      verified = true;
      console.log(`Verification passed! Title: ${title}`);
      break;
    }
    console.log(`  [${(i + 1) * 5}s] Still waiting... (title: ${title})`);
  }

  if (!verified) {
    console.log('ERROR: Verification not completed in 90 seconds. Aborting.');
    await browser.close();
    process.exit(1);
  }

  // Phase 2: Search for each book
  console.log('\n=== Phase 2: Searching books ===\n');
  const results = [];

  for (const book of BOOKS) {
    console.log(`Searching: ${book.en} (${book.zh})...`);
    try {
      const searchUrl = `https://z-library.sk/s/${encodeURIComponent(book.en)}`;
      await page.goto(searchUrl, { timeout: 20000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);

      const title = await page.title();
      if (title.includes('验证') || title.includes('DiamWall')) {
        console.log('  Re-verification needed! Waiting 30s...');
        await page.waitForTimeout(30000);
      }

      // Look for book links
      const bookLinks = await page.$$('a[href*="/book/"]');
      if (bookLinks.length > 0) {
        const firstLink = bookLinks[0];
        const text = await firstLink.textContent();
        const href = await firstLink.getAttribute('href');
        console.log(`  Found: ${text?.trim().slice(0, 60)} | ${href}`);
        results.push({ ...book, found: true, href, title: text?.trim() });
      } else {
        console.log('  No results found');
        results.push({ ...book, found: false });
      }
    } catch (e) {
      console.log(`  Error: ${e.message.slice(0, 80)}`);
      results.push({ ...book, found: false, error: e.message.slice(0, 100) });
    }
    await page.waitForTimeout(2000); // Rate limit
  }

  // Save results
  const resultFile = `${DOWNLOAD_DIR}/search-results.json`;
  writeFileSync(resultFile, JSON.stringify(results, null, 2));
  console.log(`\n=== Results saved to ${resultFile} ===`);
  console.log(`Found: ${results.filter(r => r.found).length}/${BOOKS.length}`);

  // Save browser state for future use
  const stateFile = `${DOWNLOAD_DIR}/browser-state.json`;
  await context.storageState({ path: stateFile });
  console.log(`Browser state saved to ${stateFile}`);

  await browser.close();
  process.exit(0);
}

main();
