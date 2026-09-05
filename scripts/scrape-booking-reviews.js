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

  // Booking does a client-side navigation shortly after load, which destroys the
  // execution context mid-evaluate ("Execution context was destroyed"). These
  // figures are supporting detail, not the point of the run, so retry briefly
  // and carry on without them rather than failing the whole scrape.
  async function evalWithRetry(fn, label, tries = 3) {
    for (let i = 0; i < tries; i++) {
      try { return await page.evaluate(fn); }
      catch (e) {
        if (i === tries - 1) { console.log(`[booking] ${label} unavailable: ${e.message.split('\n')[0]}`); return null; }
        await sleep(1500);
      }
    }
  }

  const meta = (await evalWithRetry(() => {
    const scoreEl = document.querySelector('[data-testid="review-score-component"]');
    const t = scoreEl ? scoreEl.textContent : '';
    const scoreM = t.match(/(\d+(?:[.,]\d+)?)/);
    const countM = t.match(/([\d,]+)\s*חוות דעת/);
    return {
      overallScore: scoreM ? parseFloat(scoreM[1].replace(',', '.')) : null,
      totalReviews: countM ? parseInt(countM[1].replace(/,/g, '')) : null,
    };
  }, 'site-wide meta')) || { overallScore: null, totalReviews: null };
  console.log('[booking] site-wide meta:', JSON.stringify(meta));

  // Opening the reviews panel needs a REAL (trusted) click. A synthetic
  // element.click() from page.evaluate used to work and silently stopped:
  // the 2026-09-05 unattended run left the page on the Overview tab and
  // reported zero reviews as if that were a normal, empty day. Layered
  // fallbacks because Booking rotates these handles.
  const openers = [
    () => page.locator('[data-testid="read-all-actionable"]').first().click({ timeout: 8000 }),
    () => page.locator('a:has-text("חוות דעת"), button:has-text("חוות דעת")').first().click({ timeout: 8000 }),
    () => page.locator('[data-testid="Property-Header-Nav-Tab-Trigger-reviews"]').first().click({ timeout: 8000 }),
  ];
  let opened = false;
  for (const open of openers) {
    try {
      await open();
      await page.waitForSelector('[data-testid="review-card"]', { timeout: 12000 });
      opened = true;
      break;
    } catch (e) { /* try the next handle */ }
  }
  if (!opened) {
    await page.screenshot({ path: path.join(__dirname, '..', 'logs', 'booking-no-cards.png') }).catch(() => {});
    await browser.close();
    throw new Error('Booking: could not open the reviews panel — no review cards appeared (screenshot: logs/booking-no-cards.png)');
  }

  await page.selectOption('#reviewListSorters', 'NEWEST_FIRST').catch(() => {});
  // Give the re-sorted list a moment, then confirm cards are still present.
  await page.waitForTimeout(1500);
  await page.waitForSelector('[data-testid="review-card"]', { timeout: 20000 });

  // Booking publishes per-category scores (cleanliness, staff, facilities,
  // comfort, location, value, wifi) but only inside the reviews panel, and only
  // as property-wide averages — there is no per-review breakdown. Captured into
  // the daily snapshot so the dashboard can show every category, not just the
  // three Google exposes per review.
  // Each subscore node reads "צוות, 8.9, דירוג ממוצע מ-1 עד 10צוות" — the label,
  // the score, then a screen-reader sentence with the label repeated. Take the
  // first comma-separated field as the name and the second as the score.
  meta.categories = (await evalWithRetry(() => {
    const out = {};
    document.querySelectorAll('[data-testid="review-subscore"]').forEach(el => {
      const parts = el.textContent.replace(/\s+/g, ' ').trim().split(',');
      if (parts.length < 2) return;
      const name = parts[0].trim();
      const score = parseFloat(parts[1].replace(',', '.').trim());
      if (name && !isNaN(score)) out[name] = score;
    });
    return out;
  }, 'category scores')) || {};

  // The overall score also lives in the reviews panel header; read it here as a
  // fallback for when the pre-navigation capture above came back empty.
  if (meta.overallScore == null) {
    const fallback = await evalWithRetry(() => {
      const el = document.querySelector('[data-testid="reviews-tab-score-header"], [data-testid="review-score-component"]');
      const m = el && el.textContent.match(/(\d+(?:[.,]\d)?)/);
      const c = el && el.textContent.match(/([\d,]+)\s*חוות דעת/);
      return m ? { overallScore: parseFloat(m[1].replace(',', '.')), totalReviews: c ? parseInt(c[1].replace(/,/g, '')) : null } : null;
    }, 'overall score (panel)');
    if (fallback) Object.assign(meta, fallback);
  }
  console.log('[booking] category scores:', JSON.stringify(meta.categories));

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
    // wait for the next page's cards rather than assuming the sleep covered it
    await page.waitForSelector('[data-testid="review-card"]', { timeout: 20000 }).catch(() => {});
  }

  if (all.length === 0) {
    await browser.close();
    throw new Error('Booking: finished with zero review cards — treat as a failed run, not an empty one');
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
