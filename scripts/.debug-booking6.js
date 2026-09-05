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

  console.log('waiting for nav tab trigger to mount...');
  const navTab = page.locator('[data-testid="Property-Header-Nav-Tab-Trigger-reviews"]');
  await navTab.waitFor({ state: 'attached', timeout: 20000 });
  console.log('nav tab attached');
  await navTab.scrollIntoViewIfNeeded();
  await navTab.click({ timeout: 10000 });
  console.log('clicked nav tab (real playwright click)');

  console.log('waiting for sorter select to appear...');
  await page.locator('#reviewListSorters').waitFor({ state: 'attached', timeout: 20000 });
  console.log('sorter attached');

  await page.selectOption('#reviewListSorters', 'NEWEST_FIRST');
  console.log('selected NEWEST_FIRST');
  await page.waitForTimeout(2500);

  const cardsCount = await page.evaluate(() => document.querySelectorAll('[data-testid="review-card"]').length);
  console.log('cardsCount=', cardsCount);

  await page.screenshot({ path: 'C:/Users/Ayelet Lironne/queen-of-sheba-reviews-dashboard/logs/debug6.png', fullPage: false });
  await browser.close();
})().catch(async (e) => { console.error('ERR', e); process.exit(1); });
