// Scrapes Booking.com's review list for Queen of Sheba Eilat, sorted newest
// first, paginating back until a date cutoff. Unlike Google (see
// scrape-reviews.js / HANDOFF.md), Booking's review DOM is clean and stable
// (data-testid="review-card" with well-labeled children) and paginates with
// real page numbers rather than a hard-capped infinite-scroll — no
// trusted-input-event tricks were needed here, plain .click()/.selectOption()
// work. This means, unlike Google, we can realistically backfill real months
// of history in a single run, not just build it up one day at a time.
//
// Usage: node scripts/scrape-booking-reviews.js [outFile] [--days=100] [--max-pages=40]

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const HOTEL_URL = 'https://www.booking.com/hotel/il/eilat-queen-of-sheba.html?lang=he-il';

const HEBREW_MONTHS = {
  'ינואר': 1, 'פברואר': 2, 'מרץ': 3, 'אפריל': 4, 'מאי': 5, 'יוני': 6,
  'יולי': 7, 'אוגוסט': 8, 'ספטמבר': 9, 'אוקטובר': 10, 'נובמבר': 11, 'דצמבר': 12,
};

function parseHebrewDate(text) {
  // "נכתבה ב-3 בספטמבר 2026" -> "2026-09-03"
  const m = text.match(/(\d{1,2})\s+ב(\S+)\s+(\d{4})/);
  if (!m) return null;
  const day = parseInt(m[1]);
  const month = HEBREW_MONTHS[m[2]];
  const year = parseInt(m[3]);
  if (!month) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseScore(text) {
  // Booking renders the score twice in the same node (a11y + visible), e.g.
  // "קיבל ציון 7.07.0" or "קיבל ציון 1010" — exact duplication, so split the
  // numeric remainder exactly in half rather than regex (which would
  // misparse "1010" as 1010 instead of 10).
  const raw = text.replace(/^קיבל ציון\s*/, '').trim();
  const half = raw.length / 2;
  if (Number.isInteger(half)) {
    const v = parseFloat(raw.slice(0, half));
    if (!isNaN(v)) return v;
  }
  const m = raw.match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractCardsScript() {
  const q = (root, sel) => root.querySelector(`[data-testid="${sel}"]`);
  return Array.from(document.querySelectorAll('[data-testid="review-card"]')).map(card => ({
    reviewer: (q(card, 'review-avatar')?.textContent || '').trim(),
    dateRaw: (q(card, 'review-date')?.textContent || '').trim(),
    title: (q(card, 'review-title')?.textContent || '').trim(),
    scoreRaw: (q(card, 'review-score')?.textContent || '').trim(),
    positive: (q(card, 'review-positive-text')?.textContent || '').trim(),
    negative: (q(card, 'review-negative-text')?.textContent || '').trim(),
    roomName: (q(card, 'review-room-name')?.textContent || '').trim(),
    nights: (q(card, 'review-num-nights')?.textContent || '').trim().replace(/[·\s]+$/, ''),
    stayDate: (q(card, 'review-stay-date')?.textContent || '').trim(),
    travelerType: (q(card, 'review-traveler-type')?.textContent || '').trim(),
    hasOwnerReply: !!q(card, 'review-partner-reply'),
  }));
}

async function scrapeBookingReviews({ maxDays = 100, maxPages = 40 } = {}) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'he-IL',
    viewport: { width: 1280, height: 2000 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  await page.goto(HOTEL_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2000);

  const meta = await page.evaluate(() => {
    const scoreEl = document.querySelector('[data-testid="review-score-component"]');
    const t = scoreEl ? scoreEl.textContent : '';
    const scoreM = t.match(/(\d+(?:[.,]\d+)?)/);
    const countM = t.match(/([\d,]+)\s*חוות דעת/);
    return {
      overallScore: scoreM ? parseFloat(scoreM[1].replace(',', '.')) : null,
      totalReviews: countM ? parseInt(countM[1].replace(/,/g, '')) : null,
    };
  });
  console.log('[booking] site-wide meta:', JSON.stringify(meta));

  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('a,button,div[role="tab"]'))
      .find(e => /חוות דעת/.test(e.textContent) && e.textContent.length < 30);
    if (el) el.click();
  });
  await page.waitForTimeout(2500);
  await page.selectOption('#reviewListSorters', 'NEWEST_FIRST').catch(() => {});
  await page.waitForTimeout(2500);

  const cutoffDate = new Date();
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - maxDays);
  const cutoffISO = cutoffDate.toISOString().slice(0, 10);

  const all = [];
  let pageNum = 1;
  while (pageNum <= maxPages) {
    const cards = await page.evaluate(extractCardsScript);
    console.log(`[booking] page ${pageNum}: ${cards.length} cards`);
    if (cards.length === 0) break;
    all.push(...cards);

    const oldestOnPage = cards.map(c => parseHebrewDate(c.dateRaw)).filter(Boolean).sort()[0];
    if (oldestOnPage && oldestOnPage < cutoffISO) {
      console.log(`[booking] reached cutoff (${cutoffISO}) at page ${pageNum}, stopping`);
      break;
    }

    const nextPage = pageNum + 1;
    const clicked = await page.evaluate((n) => {
      const btn = document.querySelector(`button[aria-label="עמוד ${n}"]`);
      if (btn) { btn.click(); return true; }
      return false;
    }, nextPage);
    if (!clicked) {
      console.log(`[booking] no page ${nextPage} button found, stopping (reached last page)`);
      break;
    }
    pageNum = nextPage;
    await sleep(1800 + Math.random() * 900); // be a reasonable citizen between page loads
  }

  await browser.close();
  const cards = all.map(c => ({ ...c, date: parseHebrewDate(c.dateRaw), score: parseScore(c.scoreRaw) }));
  return { meta, cards };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const outFile = args.find(a => !a.startsWith('--')) || path.join(__dirname, '.last-booking-dump.json');
  const daysArg = args.find(a => a.startsWith('--days='));
  const maxPagesArg = args.find(a => a.startsWith('--max-pages='));
  const maxDays = daysArg ? parseInt(daysArg.split('=')[1]) : 100;
  const maxPages = maxPagesArg ? parseInt(maxPagesArg.split('=')[1]) : 40;

  scrapeBookingReviews({ maxDays, maxPages }).then(result => {
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
    console.log(`[booking] wrote ${result.cards.length} raw cards + meta to ${outFile}`);
  }).catch(e => {
    console.error('[booking] ERROR', e);
    process.exit(1);
  });
}

module.exports = { scrapeBookingReviews, parseHebrewDate, parseScore, HOTEL_URL };
