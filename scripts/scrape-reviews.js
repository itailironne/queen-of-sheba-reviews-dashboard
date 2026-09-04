// Scrapes the Google-hosted reviews page for Queen of Sheba Eilat
// (google.com/travel/hotels/entity/CgoIytfkyoX724ETEAE/reviews) and writes the
// raw page text to scripts/.last-dump.txt for merge-and-build.js to parse.
//
// Why raw text and not DOM extraction: Google's class names are obfuscated and
// churn between deploys; page.innerText gives a stable, human-readable layout
// that lib/parse.js parses with anchored regexes (reviewer name line followed by
// "לפני X באתר Google/Tripadvisor"). See HANDOFF.md for the reverse-engineering
// notes (trusted-event requirements, pagination plateau, etc.)
//
// Usage: node scripts/scrape-reviews.js [outFile]

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const HOTEL_ENTITY_URL = 'https://www.google.com/travel/hotels/entity/CgoIytfkyoX724ETEAE/reviews?hl=he&gl=il';
const OUT_FILE = process.argv[2] || path.join(__dirname, '.last-dump.txt');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sortByNewest(page) {
  // Opening the sort <select>-like widget and choosing an option only works
  // with *trusted* input events (real mouse/keyboard via CDP) — plain
  // element.click() opens the menu (bubtled listener) but does not register a
  // selection. See HANDOFF.md.
  await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('span,div,button'));
    const el = all.find(e => e.textContent.trim() === 'המועילות ביותר');
    if (!el) return;
    let clickable = el;
    for (let i = 0; i < 5 && clickable; i++) {
      if (clickable.tagName === 'BUTTON' || clickable.getAttribute('role') === 'button' || clickable.hasAttribute('jsaction')) break;
      clickable = clickable.parentElement;
    }
    clickable && clickable.click();
  });
  await page.waitForTimeout(800);
  await page.keyboard.press('ArrowDown'); // "המועילות ביותר" -> "העדכניות ביותר"
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000);
}

async function expandTruncatedReviews(page) {
  for (let round = 0; round < 3; round++) {
    const boxes = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('span,a,div'));
      const els = all.filter(e => e.children.length === 0 && e.textContent.trim() === 'להמשך קריאה');
      return els.map(e => {
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }).filter(r => r.w > 0 && r.h > 0);
    });
    if (boxes.length === 0) break;
    for (const b of boxes) {
      try { await page.mouse.click(b.x + b.w / 2, b.y + b.h / 2); await page.waitForTimeout(150); } catch (e) {}
    }
    await page.waitForTimeout(300);
  }
}

async function scrapeReviews({ maxIterations = 60, timeBudgetMs = 240000, stopAfterStableIters = 10 } = {}) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'he-IL', viewport: { width: 1280, height: 2200 } });
  const page = await context.newPage();

  await page.goto(HOTEL_ENTITY_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  await sortByNewest(page);

  let lastLen = 0, stableCount = 0;
  const startTime = Date.now();

  for (let i = 0; i < maxIterations; i++) {
    if (Date.now() - startTime > timeBudgetMs) { console.log('[scrape] time budget exceeded, stopping'); break; }
    await expandTruncatedReviews(page);
    const text = await page.evaluate(() => document.body.innerText);

    if (text.length === lastLen) stableCount++; else stableCount = 0;
    lastLen = text.length;
    console.log(`[scrape] iter ${i}: textLen=${text.length} stable=${stableCount}`);

    if (stableCount >= stopAfterStableIters) { console.log('[scrape] plateaued, stopping'); break; }

    // Trusted wheel events — programmatic scrollBy does not trigger this
    // SPA's lazy-load of further review batches.
    await page.mouse.move(640, 1200);
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(400);
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(stableCount > 0 ? 3500 : 2000);
  }

  const finalText = await page.evaluate(() => document.body.innerText);
  await browser.close();
  return finalText;
}

if (require.main === module) {
  scrapeReviews().then(text => {
    fs.writeFileSync(OUT_FILE, text, 'utf8');
    console.log(`[scrape] wrote ${text.length} chars to ${OUT_FILE}`);
  }).catch(e => {
    console.error('[scrape] ERROR', e);
    process.exit(1);
  });
}

module.exports = { scrapeReviews, HOTEL_ENTITY_URL };
