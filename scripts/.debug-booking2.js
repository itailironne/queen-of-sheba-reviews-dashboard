const { chromium } = require('playwright');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'he-IL',
    viewport: { width: 1280, height: 2000 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  await page.goto('https://www.booking.com/hotel/il/eilat-queen-of-sheba.html?lang=he-il', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);

  const scoreEl = await page.evaluate(() => !!document.querySelector('[data-testid="review-score-component"]'));
  console.log('scoreEl present=', scoreEl);

  const tabCandidates = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a,button,div[role="tab"]'))
      .filter(e => /חוות דעת/.test(e.textContent) && e.textContent.length < 30)
      .map(e => ({ tag: e.tagName, text: e.textContent.trim(), testid: e.getAttribute('data-testid') }));
  });
  console.log('tabCandidates=', JSON.stringify(tabCandidates));

  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('a,button,div[role="tab"]'))
      .find(e => /חוות דעת/.test(e.textContent) && e.textContent.length < 30);
    if (el) el.click();
  });
  await page.waitForTimeout(3000);
  console.log('url after tab click=', page.url());

  const cardsCount1 = await page.evaluate(() => document.querySelectorAll('[data-testid="review-card"]').length);
  console.log('cardsCount after click+3s=', cardsCount1);

  // try scrolling into view / waiting longer
  await page.waitForTimeout(3000);
  const cardsCount2 = await page.evaluate(() => document.querySelectorAll('[data-testid="review-card"]').length);
  console.log('cardsCount after extra 3s=', cardsCount2);

  const sorterPresent = await page.evaluate(() => !!document.querySelector('#reviewListSorters'));
  console.log('sorterPresent=', sorterPresent);

  // dump any data-testid attributes containing "review"
  const testids = await page.evaluate(() => {
    const set = new Set();
    document.querySelectorAll('[data-testid]').forEach(e => {
      const v = e.getAttribute('data-testid');
      if (v && v.toLowerCase().includes('review')) set.add(v);
    });
    return Array.from(set);
  });
  console.log('review-related testids=', JSON.stringify(testids));

  await page.screenshot({ path: 'C:/Users/Ayelet Lironne/queen-of-sheba-reviews-dashboard/logs/debug2.png', fullPage: false });

  await browser.close();
})().catch(e => { console.error('ERR', e); process.exit(1); });
