import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const PROXY = 'http://127.0.0.1:7993';
const DOWNLOAD_DIR = 'E:/hermes/workspace/openmaic/data/book-downloads';
const STATE_FILE = join(DOWNLOAD_DIR, 'browser-state.json');
const RESULTS_FILE = join(DOWNLOAD_DIR, 'search-results.json');

const books = JSON.parse(readFileSync(RESULTS_FILE, 'utf8')).filter(b => b.found);

async function main() {
  mkdirSync(DOWNLOAD_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    proxy: { server: PROXY },
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized']
  });

  // Reuse saved session (cookies)
  const context = await browser.newContext({
    storageState: STATE_FILE,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    acceptDownloads: true
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();

  // Phase 0: Login
  console.log('=== Phase 0: Login ===');
  await page.goto('https://z-library.sk/login', { timeout: 20000, waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const pageTitle = await page.title();
  if (pageTitle.includes('验证') || pageTitle.includes('DiamWall')) {
    console.log('Verification needed first. Waiting 60s...');
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(5000);
      const t = await page.title();
      if (!t.includes('验证') && !t.includes('DiamWall')) break;
      console.log(`  [${(i+1)*5}s] waiting...`);
    }
    await page.goto('https://z-library.sk/login', { timeout: 20000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
  }

  // Fill login form
  try {
    const emailInput = await page.$('input[name="email"], input[type="email"], #email');
    const passInput = await page.$('input[name="password"], input[type="password"], #password');
    if (emailInput && passInput) {
      await emailInput.fill('huangboheng@live.com');
      await passInput.fill('2D3e43j7');
      await page.waitForTimeout(500);
      // Click login button
      const loginBtn = await page.$('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("登录")');
      if (loginBtn) await loginBtn.click();
      await page.waitForTimeout(5000);
      console.log(`Login result - URL: ${page.url()}, Title: ${await page.title()}`);
    } else {
      console.log('Login form not found, trying direct access...');
    }
  } catch (e) {
    console.log(`Login error: ${e.message.slice(0, 80)}`);
  }

  let downloaded = 0;

  for (const book of books) {
    console.log(`\n[${downloaded + 1}/${books.length}] ${book.zh} (${book.en})`);
    const bookUrl = `https://z-library.sk${book.href}`;

    try {
      await page.goto(bookUrl, { timeout: 20000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);

      const title = await page.title();
      if (title.includes('验证') || title.includes('DiamWall')) {
        console.log('  Re-verification needed! Waiting 30s for you to complete...');
        // Wait for user to verify again
        for (let i = 0; i < 6; i++) {
          await page.waitForTimeout(5000);
          const t = await page.title();
          if (!t.includes('验证') && !t.includes('DiamWall')) break;
        }
      }

      // Look for download button - Z-Library shows format+size like "PDF, 983 KB" or "EPUB, 1.2 MB"
      const selectors = [
        'a:has-text("PDF,")',
        'a:has-text("EPUB,")',
        'a:has-text("MOBI,")',
        'a:has-text("TXT,")',
        'a[href*="download"]',
        'a.btn:has(svg)',
      ];
      
      let downloadLink = null;
      for (const sel of selectors) {
        downloadLink = await page.$(sel);
        if (downloadLink) {
          const btnText = await downloadLink.textContent();
          console.log(`  Found via: ${sel} → "${btnText?.trim().slice(0, 30)}"`);
          break;
        }
      }

      if (!downloadLink) {
        // Screenshot for debugging
        await page.screenshot({ path: join(DOWNLOAD_DIR, `page-${book.author}.png`) });
        console.log('  No download button. Screenshot saved.');
        // Log all links on page
        const allLinks = await page.$$eval('a', els => els.map(e => ({ text: e.textContent?.trim().slice(0, 40), href: e.getAttribute('href') })).filter(l => l.href));
        console.log('  Page links:', JSON.stringify(allLinks.slice(0, 10)));
        continue;
      }

      // Force click to bypass overlay issues
      console.log('  Clicking download (force)...');
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 20000 }).catch(() => null),
        downloadLink.click({ force: true, timeout: 5000 }).catch(() => null)
      ]);

      if (download) {
        const suggestedName = download.suggestedFilename();
        const savePath = join(DOWNLOAD_DIR, suggestedName);
        await download.saveAs(savePath);
        console.log(`  Downloaded: ${suggestedName}`);
        downloaded++;
      } else {
        // Check if page navigated to download confirmation
        await page.waitForTimeout(5000);
        const newUrl = page.url();
        console.log(`  No download event. URL: ${newUrl}`);
        await page.screenshot({ path: join(DOWNLOAD_DIR, `after-click-${book.author}.png`) });
        
        // Try second-level download link
        const dl2 = await page.$('a[href*="download"]') || await page.$('a:has-text("Download")') || await page.$('a:has-text("Save")');
        if (dl2) {
          const [dl2Event] = await Promise.all([
            page.waitForEvent('download', { timeout: 20000 }).catch(() => null),
            dl2.click({ force: true, timeout: 5000 }).catch(() => null)
          ]);
          if (dl2Event) {
            const name = dl2Event.suggestedFilename();
            await dl2Event.saveAs(join(DOWNLOAD_DIR, name));
            console.log(`  Downloaded (2nd): ${name}`);
            downloaded++;
          }
        }
      }
    } catch (e) {
      console.log(`  Error: ${e.message.slice(0, 100)}`);
    }

    await page.waitForTimeout(3000); // Rate limit between downloads
  }

  console.log(`\n=== Done: ${downloaded}/${books.length} downloaded ===`);
  
  // Update browser state
  await context.storageState({ path: STATE_FILE });
  await browser.close();
  process.exit(0);
}

main();
