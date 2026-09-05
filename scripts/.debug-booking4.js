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

  try {
    await page.click('[data-testid="Property-Header-Nav-Tab-Trigger-reviews"]', { timeout: 5000 });
    console.log('real playwright click on nav-tab-trigger-reviews succeeded');
  } catch (e) {
    console.log('real click failed:', e.message.slice(0,200));
  }
  await page.waitForTimeout(3000);
  console.log('url after real click=', page.url());

  let cardsCount = await page.evaluate(() => document.querySelectorAll('[data-testid="review-card"]').length);
  console.log('cardsCount=', cardsCount);
  let sorterPresent = await page.evaluate(() => !!document.querySelector('#reviewListSorters'));
  console.log('sorterPresent=', sorterPresent);

  await page.screenshot({ path: 'C:/Users/Ayelet Lironne/queen-of-sheba-reviews-dashboard/logs/debug4.png', fullPage: false });

  await browser.close();
})().catch(e => { console.error('ERR', e); process.exit(1); });
