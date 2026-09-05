const { chromium } = require('playwright');

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

  // click the "read all reviews" actionable link
  const clicked = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="review-score-read-all-actionable"]') ||
               document.querySelector('[data-testid="fr-read-all-reviews"]');
    if (el) { el.click(); return el.getAttribute('data-testid'); }
    return null;
  });
  console.log('clicked=', clicked);
  await page.waitForTimeout(3000);
  console.log('url after click=', page.url());

  let cardsCount = await page.evaluate(() => document.querySelectorAll('[data-testid="review-card"]').length);
  console.log('cardsCount=', cardsCount);
  let sorterPresent = await page.evaluate(() => !!document.querySelector('#reviewListSorters'));
  console.log('sorterPresent=', sorterPresent);

  if (cardsCount === 0) {
    await page.waitForTimeout(3000);
    cardsCount = await page.evaluate(() => document.querySelectorAll('[data-testid="review-card"]').length);
    console.log('cardsCount after extra wait=', cardsCount);
    sorterPresent = await page.evaluate(() => !!document.querySelector('#reviewListSorters'));
    console.log('sorterPresent after extra wait=', sorterPresent);
  }

  await page.screenshot({ path: 'C:/Users/Ayelet Lironne/queen-of-sheba-reviews-dashboard/logs/debug3.png', fullPage: false });

  await browser.close();
})().catch(e => { console.error('ERR', e); process.exit(1); });
